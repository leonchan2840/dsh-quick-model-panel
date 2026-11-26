'use strict';
const { selectionFor } = require('./logic.cjs');

function isFreshConversation({ agent, source, signal }) {
  const header = agent?.session?.header;
  // 分叉有种子历史，不是普通新会话；恢复、清空和压缩也不能重新套偏好。
  return source === 'startup' && !!header && !header.isSeeded && header.origin !== 'subagent' && !signal?.aborted;
}

function isBlankRoot(ctx, agent) {
  const header = agent?.session?.header;
  if (!header || header.isSeeded || header.origin === 'subagent') return false;
  const boundary = ctx.agents.turnBoundaryOf(agent.session);
  return boundary.lastTurn === 0 && boundary.openTurnStartSeq === null;
}

// 事件 seq 而非当前值表示所有权：用户手动 A→B→A 也必须保留其最后一次选择。
function createDefaultApplier(ctx, config) {
  const ownership = new WeakMap(), lastEvents = new WeakMap(), working = new WeakMap(), idleWait = new WeakMap();
  let revision = 0;
  const values = () => ({ team: config.newSessionTeam.get(), effort: config.defaultEffort.get() });
  function onEvent(session, event) {
    const field = event.type === 'team/mode' ? 'team' : event.type === 'model/selection' ? 'model' : null;
    if (field) lastEvents.set(session, { ...lastEvents.get(session), [field]: event.seq });
  }
  const owns = (session, owned, field) => owned?.[field] !== undefined &&
    lastEvents.get(session)?.[field] === owned[field];
  async function apply({ agent, signal }, { team, effort }, draft = false) {
    const { session } = agent;
    const selectionState = () => ctx.sessionProjections.snapshot(session, ['modelSelection']).values.modelSelection;
    if (signal?.aborted || (draft && !isBlankRoot(ctx, agent))) return;
    // 先补齐上次已追加却未确认落盘的事件；切成“跟随系统”也不应遗留未持久化记录。
    const pending = ownership.get(agent);
    if (draft && ((pending?.teamNeedsFlush && owns(session, pending, 'team')) ||
      (pending?.modelNeedsFlush && owns(session, pending, 'model')))) {
      await ctx.sessions.flush(session);
      ownership.set(agent, { ...pending, teamNeedsFlush: false, modelNeedsFlush: false });
    }
    const teamState = draft ? ctx.sessionProjections.stateOf(session, 'agentTeam') : undefined;
    if (team === 'on' || team === 'off') {
      const enabled = team === 'on';
      const actual = ctx.agentTeams.isEnabled(agent);
      const mayChange = !draft || (teamState && (teamState.enabled === undefined || owns(session, ownership.get(agent), 'team')));
      if (mayChange && actual !== enabled) {
        // setEnabled 在首次 await flush 前同步追加事件；即使 flush 失败，下一次刷新也能重试持久化而不覆写手选。
        const write = ctx.agentTeams.setEnabled(agent, enabled, signal);
        const seq = lastEvents.get(session)?.team;
        if (seq !== undefined) ownership.set(agent, { ...ownership.get(agent), team: seq, teamNeedsFlush: true });
        await write;
        if (ownership.get(agent)?.team === seq) ownership.set(agent, { ...ownership.get(agent), teamNeedsFlush: false });
      }
    }
    if (!effort || signal?.aborted || (draft && !isBlankRoot(ctx, agent))) return;
    const projected = selectionState()?.next;
    if (!(projected === null || (draft && projected && owns(session, ownership.get(agent), 'model')))) return;
    const initial = agent.model.current();
    if (!initial) return;
    let raw;
    try {
      raw = await ctx.llm.resolveModelInfo(initial.provider, initial.model, signal);
    } catch {
      // 目录暂不可用时没有可靠的档位清单；保留 DSH 原生选择，不阻止创建。
      return;
    }
    if (!raw || signal?.aborted || (draft && !isBlankRoot(ctx, agent))) return;
    const latest = selectionState()?.next;
    if (!(latest === null || (draft && latest && owns(session, ownership.get(agent), 'model')))) return;
    const current = agent.model.current();
    if (current?.provider !== initial.provider || current?.model !== initial.model) return;
    const next = selectionFor({ provider: current.provider, id: current.model, raw }, effort);
    if (current.reasoningEffort === next.reasoningEffort) return;
    // 只记新会话的深度，不走会更新 profile 默认模型的远程选择入口。
    agent.model.select(next);
    const seq = lastEvents.get(session)?.model;
    if (seq !== undefined) ownership.set(agent, { ...ownership.get(agent), model: seq, modelNeedsFlush: true });
    await ctx.sessions.flush(session);
    if (ownership.get(agent)?.model === seq) ownership.set(agent, { ...ownership.get(agent), modelNeedsFlush: false });
  }
  function scheduleIdle(agent) {
    if (idleWait.has(agent)) return;
    const task = agent.whenIdle().then(() => {
      idleWait.delete(agent);
      if (isBlankRoot(ctx, agent)) refresh(agent);
    }).catch(() => { idleWait.delete(agent); ctx.logger.warn('quick model panel: applying new-session defaults failed'); });
    idleWait.set(agent, task);
  }
  function refresh(agent) {
    const prior = working.get(agent);
    if (prior) { prior.dirty = true; return; }
    const job = { dirty: false };
    working.set(agent, job);
    function run() {
      try {
        const task = agent.runMaintenance(signal => apply({ agent, signal }, values(), true));
        void Promise.resolve(task).catch(() => ctx.logger.warn('quick model panel: applying new-session defaults failed')).finally(() => {
          // 连续保存两个字段时，最后一次偏好也必须应用到同一草稿。
          if (job.dirty && isBlankRoot(ctx, agent)) { job.dirty = false; run(); }
          else working.delete(agent);
        });
      } catch {
        // 创建事件本身也占用 maintenance；待它结束后一次性刷新最新偏好，不轮询。
        working.delete(agent);
        scheduleIdle(agent);
      }
    }
    run();
  }
  return {
    onEvent,
    onCreated: async event => {
      if (!isFreshConversation(event)) return;
      const startedAt = revision;
      try { await apply(event, values()); }
      catch {
        // 默认配置写入失败不能让宿主回滚用户的新会话；若仍为空白，后台补偿一次即可。
        ctx.logger.warn('quick model panel: applying new-session defaults failed');
        scheduleIdle(event.agent);
      }
      finally { if (revision !== startedAt) scheduleIdle(event.agent); }
    },
    onSaved: paths => {
      if (!paths.some(path => path[0] === 'newSessionTeam' || path[0] === 'defaultEffort')) return;
      revision++;
      // DSH 的“新建会话”可能复用之前创建但尚未开始的空白草稿；配置保存后同步更新这些草稿。
      for (const agent of ctx.agents.list()) if (isBlankRoot(ctx, agent)) refresh(agent);
    },
  };
}

module.exports = { isFreshConversation, isBlankRoot, createDefaultApplier };
