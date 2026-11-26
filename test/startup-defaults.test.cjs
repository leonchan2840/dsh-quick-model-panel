'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isFreshConversation, createDefaultApplier } = require('../src/startup-defaults.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ next = null, currentEffort, efforts = ['low', 'high', 'max'], teamEnabled = false } = {}) {
  const calls = [], session = { header: { isSeeded: false } };
  let seq = 0, wire = { next }, selection = { provider: 'provider', model: 'model', reasoningEffort: currentEffort };
  let team = teamEnabled, savedTeam, boundary = { lastTurn: 0, openTurnStartSeq: null };
  let prefTeam = 'inherit', prefEffort = '', busy = false;
  const emit = (type, data) => { const event = { type, data, seq: ++seq }; applier.onEvent(session, event); };
  const agent = { session, model: {
    current: () => selection,
    select: value => { calls.push(['select', value]); selection = value; wire = { next: value }; emit('model/selection', value); },
  }, runMaintenance: job => {
    if (busy) throw new Error('agent already has active work');
    busy = true;
    return Promise.resolve().then(() => job({ aborted: false })).finally(() => { busy = false; });
  }, whenIdle: () => new Promise(resolve => { const wait = () => busy ? setImmediate(wait) : resolve(); wait(); }) };
  const ctx = {
    sessionProjections: { snapshot: () => ({ values: { modelSelection: wire } }), stateOf: () => ({ enabled: savedTeam }) },
    agentTeams: { isEnabled: () => team, setEnabled: async (_agent, enabled) => {
      if (team !== enabled) { team = savedTeam = enabled; calls.push(['team', enabled]); emit('team/mode', { enabled }); }
      await ctx.sessions.flush(session);
    } },
    llm: { resolveModelInfo: async () => ({ reasoning: { efforts: efforts.map(id => ({ id, name: id })), defaultEffort: 'low' } }) },
    sessions: { flush: async () => { calls.push(['flush']); } },
    agents: { list: () => [agent], turnBoundaryOf: () => boundary },
    logger: { warn: error => { throw error; } },
  };
  const applier = createDefaultApplier(ctx, { newSessionTeam: { get: () => prefTeam }, defaultEffort: { get: () => prefEffort } });
  const saved = async () => { applier.onSaved([['newSessionTeam'], ['defaultEffort']]); await tick(); await tick(); };
  return { ctx, agent, calls, saved, start: () => applier.onCreated({ agent, source: 'startup' }),
    preferences: (t, e) => { prefTeam = t; prefEffort = e; },
    startTurn: () => { boundary = { lastTurn: 1, openTurnStartSeq: null }; },
    explicitTeam: value => { team = savedTeam = value; emit('team/mode', { enabled: value }); },
    explicitModel: value => { agent.model.select(value); },
    team: () => team,
  };
}

test('only a fresh root startup gets defaults', () => {
  const { agent } = fixture();
  assert.equal(isFreshConversation({ agent, source: 'startup' }), true);
  assert.equal(isFreshConversation({ agent, source: 'resume' }), false);
  assert.equal(isFreshConversation({ agent, source: 'startup', signal: { aborted: true } }), false);
  agent.session.header.isSeeded = true;
  assert.equal(isFreshConversation({ agent, source: 'startup' }), false);
  agent.session.header.isSeeded = false;
  agent.session.header.origin = 'subagent';
  assert.equal(isFreshConversation({ agent, source: 'startup' }), false);
});

test('new root applies team and supported effort before first request', async () => {
  const d = fixture(); d.preferences('on', 'high'); await d.start();
  assert.deepEqual(d.calls, [['team', true], ['flush'], ['select', { provider: 'provider', model: 'model', reasoningEffort: 'high' }], ['flush']]);
});

test('unavailable effort uses advertised model default, not old effort', async () => {
  const d = fixture({ currentEffort: 'old' }); d.preferences('inherit', 'unsupported'); await d.start();
  assert.equal(d.agent.model.current().reasoningEffort, 'low');
});

test('explicit model and equal inherited effort do not append', async () => {
  const d = fixture({ next: { provider: 'provider', model: 'model' } }); d.preferences('inherit', 'high'); await d.start();
  assert.deepEqual(d.calls, []);
  const same = fixture({ currentEffort: 'high' }); same.preferences('off', 'high'); await same.start();
  assert.deepEqual(same.calls, []);
});

test('catalog failure and missing projection preserve native model', async () => {
  const missing = fixture(); missing.ctx.sessionProjections.snapshot = () => ({ values: {} });
  missing.preferences('inherit', 'high'); await missing.start(); assert.deepEqual(missing.calls, []);
  const rejected = fixture(); rejected.ctx.llm.resolveModelInfo = async () => { throw new Error('offline'); };
  rejected.preferences('inherit', 'high'); await rejected.start(); assert.deepEqual(rejected.calls, []);
});

test('saving preferences updates reusable blank draft', async () => {
  const d = fixture(); d.preferences('on', 'max'); await d.saved();
  assert.equal(d.team(), true); assert.equal(d.agent.model.current().reasoningEffort, 'max');
});

test('latest defaults update owned untouched draft; started sessions stay unchanged', async () => {
  const d = fixture(); d.preferences('on', 'high'); await d.saved();
  d.preferences('off', 'max'); await d.saved();
  assert.equal(d.team(), false); assert.equal(d.agent.model.current().reasoningEffort, 'max');
  const before = d.calls.length; d.startTurn(); d.preferences('on', 'low'); await d.saved();
  assert.equal(d.calls.length, before);
});

test('manual blank choices remain protected even after returning to same values', async () => {
  const d = fixture(); d.preferences('on', 'high'); await d.saved();
  d.explicitTeam(false); d.explicitTeam(true);
  d.explicitModel({ provider: 'provider', model: 'model', reasoningEffort: 'low' });
  d.explicitModel({ provider: 'provider', model: 'model', reasoningEffort: 'high' });
  const before = d.calls.length; d.preferences('off', 'max'); await d.saved();
  assert.equal(d.calls.length, before); assert.equal(d.team(), true);
  assert.equal(d.agent.model.current().reasoningEffort, 'high');
});

test('consecutive saves while metadata pending apply final value', async () => {
  const d = fixture(); let release;
  const hold = new Promise(resolve => { release = resolve; });
  d.ctx.llm.resolveModelInfo = async () => { await hold; return { reasoning: { efforts: ['low','high','max'].map(id => ({ id, name: id })) } }; };
  d.preferences('on', 'high'); await d.saved();
  d.preferences('on', 'max'); void d.saved(); release(); await tick(); await tick(); await tick();
  assert.equal(d.agent.model.current().reasoningEffort, 'max');
});

test('save during creation waits until agent is idle and applies current preference', async () => {
  const d = fixture(); let release;
  const hold = new Promise(resolve => { release = resolve; });
  d.ctx.llm.resolveModelInfo = async () => { await hold; return { reasoning: { efforts: ['low','high','max'].map(id => ({ id, name: id })) } }; };
  d.preferences('on', 'high');
  const created = d.agent.runMaintenance(() => d.start());
  await tick(); d.preferences('off', 'max'); void d.saved();
  release(); await created; await tick(); await tick(); await tick();
  assert.equal(d.team(), false); assert.equal(d.agent.model.current().reasoningEffort, 'max');
});

test('team flush failure retries only durability, never duplicate journal event', async () => {
  const d = fixture(); const flush = d.ctx.sessions.flush; let first = true;
  d.ctx.sessions.flush = async session => { if (first) { first = false; throw new Error('offline'); } await flush(session); };
  d.ctx.logger.warn = () => {};
  d.preferences('on', ''); await d.saved();
  assert.equal(d.team(), true);
  d.preferences('on', ''); await d.saved();
  assert.equal(d.calls.filter(call => call[0] === 'team').length, 1);
  assert.equal(d.calls.filter(call => call[0] === 'flush').length, 1);
});

test('model flush failure retries durability without appending duplicate selection', async () => {
  const d = fixture(); const flush = d.ctx.sessions.flush; let first = true;
  d.ctx.sessions.flush = async session => { if (first) { first = false; throw new Error('offline'); } await flush(session); };
  d.ctx.logger.warn = () => {};
  d.preferences('inherit', 'high'); await d.saved();
  d.preferences('inherit', 'high'); await d.saved();
  assert.equal(d.calls.filter(call => call[0] === 'select').length, 1);
  assert.equal(d.calls.filter(call => call[0] === 'flush').length, 1);
});

test('transient startup persistence error never rejects new session creation', async () => {
  const d = fixture(); let first = true;
  d.ctx.sessions.flush = async () => { if (first) { first = false; throw new Error('offline'); } d.calls.push(['flush']); };
  d.ctx.logger.warn = () => {};
  d.preferences('on', 'high');
  const created = d.agent.runMaintenance(() => d.start());
  await assert.doesNotReject(created);
  await tick(); await tick(); await tick();
  assert.equal(d.team(), true);
  assert.equal(d.agent.model.current().reasoningEffort, 'high');
});

test('seeded and started drafts never receive defaults', async () => {
  const d = fixture(); d.preferences('on', 'max'); d.agent.session.header.isSeeded = true; await d.saved();
  d.agent.session.header.isSeeded = false; d.startTurn(); await d.saved(); assert.deepEqual(d.calls, []);
});
