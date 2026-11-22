'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FAVORITES_KEY, normalizeModels, resolveEffort, selectionFor, createFavorites } = require('../src/logic.cjs');
const { effortState, sharedFavorites } = require('../src/host-view.cjs');
const { providerLabel, shouldCloseSearch } = require('../src/view.cjs');

// 直接运行实际生产规则；不模拟 React、DOM 或宿主服务。
test('shared effort resolver keeps display and selected parameter consistent across metadata cases', () => {
  for (const ids of [[], ['low'], ['low', 'high'], ['a\u0000b', 'c']]) {
    for (const fallback of [undefined, 'low', 'high', 'unknown']) {
      const model = { provider: 'p', id: 'm', raw: { reasoning: { efforts: ids.map(id => ({ id, name: id })), defaultEffort: fallback } } };
      for (const explicit of [undefined, null, 'low', 'high', 'unknown', 'a\u0000b']) {
        const resolved = resolveEffort(model, explicit);
        const displayed = effortState(model, { reasoningEffort: explicit }, resolveEffort, '默认');
        const selected = selectionFor(model, explicit);
        assert.equal(displayed.effective, resolved.effective);
        assert.equal(selected.reasoningEffort, resolved.effective);
        assert.equal(Object.hasOwn(selected, 'reasoningEffort'), resolved.effective !== undefined);
        if (displayed.index >= 0) assert.equal(displayed.levels[displayed.index].id, resolved.effective ?? null);
      }
    }
  }
});
test('shared favorites use the exported legacy storage key without migration', () => {
  assert.equal(FAVORITES_KEY, 'dsh-quick-model-panel.favorites.v1');
  const data = new Map(), keys = [];
  const store = sharedFavorites({ getItem: key => { keys.push(key); return data.get(key) ?? null; }, setItem: (key, value) => { keys.push(key); data.set(key, value); } }, createFavorites);
  store.seed({ provider: 'p', id: 'm' }); store.refresh();
  assert.ok(keys.length > 1); assert.ok(keys.every(key => key === FAVORITES_KEY));
});
test('channel subtitles and replacement labels retain exact route identities', () => {
  assert.equal(providerLabel({ provider: 'a', providerName: 'Gateway' }), 'Gateway · a');
  assert.equal(providerLabel({ provider: 'b', providerName: 'Gateway' }), 'Gateway · b');
  assert.equal(providerLabel({ provider: 'a', providerName: 'a' }), 'a');
  assert.equal(providerLabel({ provider: 'offline' }), 'offline');
});
test('old model response cannot close a newly opened search, while its own search can close', () => {
  let epoch = 0;
  const request = ++epoch; // 首次展开并发起选择。
  assert.equal(shouldCloseSearch(request, epoch, true, true), true);
  ++epoch; // 关闭。
  assert.equal(shouldCloseSearch(request, epoch, true, false), false);
  ++epoch; // 同组件重新展开；旧请求此时才返回。
  assert.equal(shouldCloseSearch(request, epoch, true, true), false);
  assert.equal(shouldCloseSearch(epoch, epoch, false, true), false);
  assert.equal(shouldCloseSearch(epoch, epoch, true, true), true);
});
test('untrusted-looking model identifiers remain plain pair data, never prototype keys', () => {
  const models = normalizeModels([{ id: '__proto__', models: [{ id: '<img src=x onerror=alert(1)>', name: '<b>name</b>' }] }]);
  const data = new Map(), storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const store = createFavorites(storage);
  assert.equal(store.toggle(models[0]).ok, true);
  const saved = JSON.parse(data.get(FAVORITES_KEY));
  assert.deepEqual(saved.pairs, [{ provider: '__proto__', id: models[0].id }]);
  assert.equal(Object.hasOwn(saved.pairs[0], 'raw'), false);
  assert.equal(Object.hasOwn(saved.pairs[0], 'name'), false);
  assert.equal(Object.getPrototypeOf(saved.pairs[0]), Object.prototype);
  assert.equal({}.polluted, undefined);
});
test('documents last-writer-wins when two windows truly overlap localStorage read/modify/write', () => {
  const data = new Map(); let interleave;
  const storage = { getItem: key => {
    const observed = data.get(key) ?? null;
    const action = interleave; interleave = undefined;
    if (action) action();
    return observed;
  }, setItem: (key, value) => data.set(key, value) };
  const a = createFavorites(storage), b = createFavorites(storage);
  const first = { provider: 'p', id: 'first' }, last = { provider: 'p', id: 'last' };
  a.toggle(first); a.toggle(last);
  // A已读到旧值、尚未保存时，B完成删除；记录真实边界，不假称这是事务存储。
  interleave = () => assert.equal(b.toggle(last).persisted, true);
  assert.equal(a.move(last, first).persisted, true);
  assert.deepEqual(a.read(), [last, first]);
});
