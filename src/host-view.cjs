'use strict';

const NS = 'quick-model-panel';
const SEAT = 'conversation.input.model';
const same = (selection, model) => !!selection && !!model && selection.provider === model.provider && selection.model === model.id;

// 未声明默认档时，“提供方默认”表示省略参数，不等同于最低档。
function effortState(model, selection, resolveEffort, defaultLabel) {
  const { levels: real, fallback, effective } = resolveEffort(model, selection?.reasoningEffort);
  if (!real.length) return { levels: [], index: -1, effective: undefined };
  const levels = fallback === undefined ? [{ id: null, label: defaultLabel }, ...real] : real;
  return { levels, index: levels.findIndex(e => e.id === (effective ?? null)), effective };
}

// 同一页面的 storage 事件不会回发给写入者，因此同时通知本窗口的订阅方。
function sharedFavorites(storage, createFavorites) {
  const favorites = createFavorites(storage), listeners = new Set();
  let cached = favorites.read();
  const publish = next => {
    if (next.length === cached.length && next.every((p, i) => p.provider === cached[i].provider && p.id === cached[i].id)) return;
    cached = next; for (const notify of listeners) notify();
  };
  const refresh = () => publish(favorites.read());
  // 本次操作已返回实际持久化的星标；不要为每次点击同步重读 localStorage。
  const mutate = (key, ...args) => { const result = favorites[key](...args); publish(result.pairs); return result; };
  return { getSnapshot: () => cached, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    seed: pair => mutate('seed', pair), toggle: (model, replace) => mutate('toggle', model, replace),
    move: (source, target, edge) => mutate('move', source, target, edge), refresh };
}

// 历史投影尚不完整时不执行关闭，已有请求的会话则必须先由用户确认。
function teamDecision(mode, history, to, confirmed) {
  if (typeof mode?.enabled !== 'boolean' || history?.lastUsed === undefined || typeof to !== 'boolean') return 'blocked';
  if (mode.enabled === to) return 'unchanged';
  return !to && history.lastUsed !== null && !confirmed ? 'confirm' : 'write';
}

function createPlugin(React, createPortal, { createView, normalizeModels, resolveEffort, selectionFor, effortOptions, createFavorites, MAX_FAVORITES, FAVORITES_KEY }, dictionaries, css) {
  const h = React.createElement, { useId, useState, useRef, useEffect, useMemo, useSyncExternalStore } = React;
  const View = createView(React, createPortal);
  function SettingsControl({ form, options, t }) {
    const id = useId();
    const [saving, setSaving] = useState(false), [failed, setFailed] = useState(false);
    const active = useRef(false), draftRef = useRef(0), editing = useRef(false), returnFocus = useRef(null);
    // 保存中会暂时禁用输入；先把焦点交给可聚焦的设置层，避免浏览器把它丢到页面 body。
    useEffect(() => {
      if (saving || !returnFocus.current) return;
      const { scope, input } = returnFocus.current;
      returnFocus.current = null;
      if (!scope.isConnected || scope.ownerDocument.activeElement !== scope) return;
      // 保存失败会把单选框恢复为旧值；不可把焦点放回已不在原生 Tab 顺序中的未选项。
      const target = input.type === 'radio' && !input.checked
        ? [...scope.querySelectorAll('input[type="radio"]')].find(el => el.name === input.name && el.checked && !el.disabled)
        : input;
      if (target?.isConnected && !target.disabled) target.focus({ preventScroll: true });
    }, [saving]);
    const watch = useMemo(() => ({ subscribe: fn => form.subscribe(fn), snapshot: () => form.getSnapshot() }), [form]);
    const { status, value, writable } = useSyncExternalStore(watch.subscribe, watch.snapshot);
    const enabled = status === 'ready' && writable;
    const savedEffort = value?.defaultEffort ?? '';
    // 复用当前深度的 range 与刻度样式，但这里提交的是未来会话的配置，不改当前会话。
    const inheritLabel = t('host.inherit');
    const levels = useMemo(() => [{ id: '', label: inheritLabel },
      ...(savedEffort && !options.some(level => level.id === savedEffort) ? [{ id: savedEffort, label: savedEffort }] : []), ...options], [options, savedEffort, inheritLabel]);
    const savedIndex = Math.max(0, levels.findIndex(level => level.id === savedEffort));
    const [preview, setPreview] = useState(savedIndex);
    useEffect(() => { editing.current = false; draftRef.current = savedIndex; setPreview(savedIndex); }, [savedIndex, levels]);
    const index = Math.max(0, Math.min(levels.length - 1, preview));
    async function save(field, next) {
      if (!enabled || active.current) return false;
      active.current = true;
      const input = typeof document !== 'undefined' ? document.activeElement : null;
      const scope = input?.closest?.('.dsh-qmp-settings-panel');
      if (scope && (input?.type === 'radio' || input?.type === 'range')) {
        returnFocus.current = { scope, input };
        scope.focus({ preventScroll: true });
      }
      setSaving(true); setFailed(false);
      try { const ok = await form.set(field, next); setFailed(!ok); return ok; }
      catch { setFailed(true); return false; }
      finally { active.current = false; setSaving(false); }
    }
    function commit() {
      if (!editing.current) return;
      editing.current = false;
      const next = levels[draftRef.current];
      if (!enabled || active.current || !next || next.id === savedEffort) { setPreview(savedIndex); return; }
      // 只让表单权威快照驱动成功态；目录变化时旧异步回调不能用旧索引重绘刻度。
      void save('defaultEffort', next.id).then(ok => { if (!ok && !editing.current) setPreview(savedIndex); });
    }
    return h('div', { className: 'dsh-qmp-settings-fields' },
      h('section', { className: 'dsh-qmp-settings-section' },
        h('h3', { id: id + '-team' }, t('host.settingsTeam')),
        h('div', { className: 'dsh-qmp-radio-group', role: 'radiogroup', 'aria-labelledby': id + '-team' },
          [['on', t('host.on')], ['off', t('host.off')], ['inherit', t('host.inherit')]].map(([option, label]) =>
            h('label', { className: 'dsh-qmp-radio-option', key: option },
              h('input', { type: 'radio', name: id + '-team', value: option,
                checked: (value?.newSessionTeam ?? 'inherit') === option, disabled: !enabled || saving,
                onChange: () => { if (!active.current) void save('newSessionTeam', option); } }), h('span', null, label))))),
      h('section', { className: 'dsh-qmp-settings-section' },
        h('div', { className: 'dsh-qmp-section-heading' },
          h('label', { id: id + '-effort', htmlFor: id + '-range' }, t('host.settingsEffort')),
          h('output', { className: 'dsh-qmp-effort-value', htmlFor: id + '-range' }, levels[index].label)),
        h('input', { id: id + '-range', className: 'dsh-qmp-range', type: 'range', min: 0, max: levels.length - 1,
          step: 1, value: index, disabled: !enabled || saving || levels.length < 2,
          'aria-valuetext': levels[index].label, onChange: e => {
            if (active.current) return;
            editing.current = true; draftRef.current = Number(e.target.value); setPreview(draftRef.current);
          }, onPointerDown: e => e.currentTarget.setPointerCapture?.(e.pointerId),
          onPointerUp: commit, onPointerCancel: () => { editing.current = false; setPreview(savedIndex); },
          onBlur: commit, onKeyUp: e => { if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(e.key)) commit(); } }),
        h('div', { className: 'dsh-qmp-range-labels', 'aria-hidden': true }, levels.map((level, i) =>
          h('span', { key: level.id, className: i === index ? 'is-active' : '' }, level.label)))),
      h('p', { className: 'dsh-qmp-settings-help' }, t('host.settingsHelp')),
      failed ? h('p', { className: 'dsh-qmp-settings-feedback', role: 'alert' }, t('host.failed')) :
        h('p', { className: 'dsh-qmp-settings-feedback', role: 'status' }, saving ? t('qmp.saving') : status === 'loading' ? t('qmp.loading') : !enabled ? t('host.settingsUnavailable') : ''));
  }
  function TeamControl({ mode, locked, pending, t, change }) {
    const [confirm, setConfirm] = useState(false);
    useEffect(() => { if (!mode.enabled) setConfirm(false); }, [mode.enabled]);
    async function act(to, confirmed) {
      if (locked || pending) return;
      const decision = await change(to, confirmed);
      if (decision === 'confirm') setConfirm(true);
      else if (decision === 'ok' || decision === 'unchanged') setConfirm(false);
    }
    return h(React.Fragment, null,
      h('button', { type: 'button', className: 'dsh-qmp-team-toggle', role: 'switch', 'aria-checked': mode.enabled,
        'aria-label': t('host.team'), disabled: locked, 'aria-disabled': locked || pending || confirm,
        onClick: () => { if (!confirm) void act(!mode.enabled, false); } },
        h('span', { className: 'dsh-qmp-team-label' }, t('host.team')),
        h('span', { className: 'dsh-qmp-switch-track', 'aria-hidden': true }, h('span', { className: 'dsh-qmp-switch-thumb' }))),
      confirm && mode.enabled ? h('div', { className: 'dsh-qmp-team-confirm', role: 'group', 'aria-label': t('host.confirmTitle') },
        h('p', null, t('host.confirmBody')),
        h('button', { type: 'button', disabled: locked, 'aria-disabled': locked || pending, onClick: () => { if (!pending) setConfirm(false); } }, t('host.cancel')),
        h('button', { type: 'button', disabled: locked, 'aria-disabled': locked || pending, onClick: () => void act(false, true) }, t('host.confirmTitle'))) : null);
  }
  function Seat(props) {
    const child = props.useSession(s => s.subagent !== null);
    const listedChild = props.useSessions(s => s.byId[props.sessionId]?.origin === 'subagent');
    return child || listedChild || !props.isRoot() ? null : h(Root, { ...props, key: props.sessionId });
  }
  function Root({ dir, isRoot, setTeam, favStore, settingsForm, t, useProjection, locked }) {
    const connection = useMemo(() => ({ subscribe: fn => dir.store.subscribe(fn), snapshot: () => dir.store.getSnapshot() }), [dir]);
    const state = useSyncExternalStore(connection.subscribe, connection.snapshot);
    const mode = useProjection('agentTeam'), history = useProjection('modelSelection');
    const favs = useSyncExternalStore(favStore.subscribe, favStore.getSnapshot);
    const [pending, setPending] = useState(false), [error, setError] = useState('');
    const gate = useRef(false), alive = useRef(false), opened = useRef(false), initialized = useRef(false);
    const current = state.current;
    const models = useMemo(() => normalizeModels(state.groups), [state.groups]);
    const selected = useMemo(() => models.find(m => same(current, m)), [models, current?.model, current?.provider]);
    const defaultLabel = t('host.default');
    const effort = useMemo(() => effortState(selected, current, resolveEffort, defaultLabel), [selected, current?.reasoningEffort, defaultLabel]);
    // 短暂写入不是会话被锁。将两者合并会让整个浮层反复变灰、显示锁定提示，还会吞掉本地星标点击。
    const remotePending = state.pending != null || pending;
    const latest = useRef(null);
    latest.current = { locked, mode, history };
    function reload() {
      if (!isRoot()) return;
      setError(''); void dir.load().catch(() => { if (alive.current) setError(t('qmp.operationFailed')); });
    }
    useEffect(() => { alive.current = true; reload(); return () => { alive.current = false; }; }, [dir]);
    function initialize(selection) {
      if (!opened.current || initialized.current || !selection) return;
      const result = favStore.seed({ provider: selection.provider, id: selection.model });
      if (result.ok) initialized.current = true; else setError(t('host.storage'));
    }
    function onOpen() {
      opened.current = true; favStore.refresh(); initialize(dir.store.getSnapshot().current);
    }
    // 只有首次展开早于目录加载时才需补初始化；平常切模型不再触碰星标存储。
    useEffect(() => { initialize(current); }, [current?.provider, current?.model]);
    // 切换页面/会话后，旧控件不得写入；拒绝连点，不把控件预先涂成已生效。
    async function write(action) {
      if (!alive.current || !isRoot() || latest.current.locked || dir.store.getSnapshot().pending || gate.current) return false;
      gate.current = true; setPending(true); setError('');
      try {
        const res = await action();
        if (!res?.ok) throw new Error('operation failed');
        return true;
      } catch { if (alive.current) setError(t('qmp.operationFailed')); return false; }
      finally { gate.current = false; if (alive.current) setPending(false); }
    }
    function onSelect(model) {
      const now = dir.store.getSnapshot(), catalog = now.groups === state.groups ? models : normalizeModels(now.groups);
      const exact = catalog.find(m => m.provider === model.provider && m.id === model.id);
      if (!exact) return false;
      if (same(now.current, exact)) return true;
      // 官方切模型不继承旧档；仅在用户明确设置了跨模型默认档时尝试匹配目标模型。
      const preferred = settingsForm.getSnapshot().status === 'ready' ? settingsForm.getSnapshot().value?.defaultEffort : undefined;
      return write(() => dir.select(selectionFor(exact, preferred)));
    }
    function onEffort(index) {
      const level = effort.levels[index], now = dir.store.getSnapshot();
      if (!level || !same(now.current, selected) || now.groups !== state.groups || now.current.reasoningEffort !== current.reasoningEffort) return false;
      return write(() => dir.select({ provider: current.provider, model: current.model, ...(level.id === null ? {} : { reasoningEffort: level.id }) }));
    }
    function mutateFavorites(action) {
      const res = action();
      setError(res.ok ? '' : t(res.status === 'storage-error' ? 'host.storage' : 'host.stale'));
      return res;
    }
    function onStar(model, replace) {
      const res = mutateFavorites(() => favStore.toggle(model, replace));
      if (!res.ok) throw new Error(res.status);
      return true;
    }
    function onMove(source, target, edge) {
      return mutateFavorites(() => favStore.move(source, target, edge)).ok;
    }
    async function changeTeam(to, confirmed) {
      const { mode: m, history: hist } = latest.current, decision = teamDecision(m, hist, to, confirmed);
      if (locked || remotePending || !isRoot()) return 'blocked';
      if (decision !== 'write') return decision;
      return await write(() => setTeam(to)) ? 'ok' : 'failed';
    }
    const teamNode = mode && typeof mode.enabled === 'boolean' ? h(TeamControl, { mode, t,
      locked: !!locked || history?.lastUsed === undefined, pending: remotePending, change: changeTeam }) : null;
    // 提供方错误可能包含私有 URL 或鉴权字段；面板只显示固定文案，不回显异常原文。
    const failures = state.failures?.length ? t('qmp.operationFailed') : '';
    const options = useMemo(() => effortOptions(models), [models]);
    const settingsNode = h(SettingsControl, { form: settingsForm, options, t });
    return h(View, { t, modelName: selected?.name || current?.model, models, current, favs, levels: effort.levels,
      effortIndex: effort.index, maxFavorites: MAX_FAVORITES, onOpen, onStar, onMove, onSelect, onEffort, teamNode, settingsNode,
      locked: !!locked, pending: remotePending, error: error || (state.error ? t('host.failed') : '') || failures, reload, loading: state.status === 'loading' });
  }
  return { inject: ['slots', 'locale', 'sessions', 'modelDirectories', 'configForms', 'remote', 'remote.agentTeams'], apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, dictionaries), 'quick-model-panel: locale');
    const favStore = sharedFavorites({ getItem: k => window.localStorage.getItem(k), setItem: (k,v) => window.localStorage.setItem(k,v) }, createFavorites);
    const form = ctx.configForms.get(NS);
    const settingsForm = { subscribe: fn => form.subscribe(fn), getSnapshot: () => form.getSnapshot(), set: (field, value) => form.set(field, value) };
    ctx.effect(() => {
      const listener = e => { if (e.key === FAVORITES_KEY || e.key === null) favStore.refresh(); };
      window.addEventListener('storage', listener); return () => window.removeEventListener('storage', listener);
    }, 'quick-model-panel: browser favorites');
    function StyledSeat(props) { return h(React.Fragment, null, h('style', null, css), h(Seat, props)); }
    ctx.slots.inject(SEAT, () => ctx.slots.register({ name: SEAT, locale: NS, priority: -100,
      inject: sid => ({ dir: ctx.modelDirectories.directoryFor(sid), isRoot: () => ctx.sessions.subagentAddress(sid) === undefined,
        setTeam: enabled => ctx.remote.agentTeams.setEnabled(sid, enabled), favStore, settingsForm }) }, StyledSeat));
  } };
}
module.exports = { createPlugin, effortState, sharedFavorites, teamDecision };
