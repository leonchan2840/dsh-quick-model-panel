'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { groupChannels, favoriteDrop } = require('../src/view.cjs');
const { MAX_FAVORITES, normalizeModels, createFavorites } = require('../src/logic.cjs');
const { sharedFavorites } = require('../src/host-view.cjs');

// 只测试实际生产函数，不渲染替代页面或模拟 React/DOM。
test('channels retain API identity and native order even with identical channel/model names', () => {
  const models = normalizeModels([
    { id: 'route-a', name: 'Gateway', models: [{ id: 'same', name: 'GPT' }, { id: 'two' }] },
    { id: 'route-b', name: 'Gateway', models: [{ id: 'same', name: 'GPT' }] },
  ]);
  const groups = groupChannels(models);
  assert.deepEqual(groups.map(g => [g.id, g.name, g.models.length]), [['route-a', 'Gateway', 2], ['route-b', 'Gateway', 1]]);
  assert.strictEqual(groups[0].models[0], models[0]);
  assert.strictEqual(groups[1].models[0], models[2]);
});
test('filtered matches still retain separate channel headers without empty sections', () => {
  const models = [{ provider: 'a', id: 'x' }, { provider: 'b', id: 'y' }, { provider: 'a', id: 'z' }];
  assert.deepEqual(groupChannels(models).map(g => [g.id, g.models.map(m => m.id)]), [['a', ['x', 'z']], ['b', ['y']]]);
  assert.equal(groupChannels(models.filter(m => m.id === 'y'))[0].name, 'b');
  assert.deepEqual(groupChannels([]), []);
});
test('drop insertion resolves the upper/lower half, gaps, top and bottom without reordering live rows', () => {
  const rows = [{ key: 'a', top: 10, bottom: 60 }, { key: 'b', top: 64, bottom: 114 }, { key: 'c', top: 118, bottom: 168 }];
  for (const [y, key, edge] of [[0,'a','before'],[34,'a','before'],[35,'a','after'],[62,'b','before'],[90,'b','after'],[200,'c','after']]) {
    assert.deepEqual(favoriteDrop(y, rows), { key, edge });
  }
  assert.deepEqual(rows.map(r => r.key), ['a','b','c']);
  assert.equal(favoriteDrop(1, []), null);
});
test('shared store publishes reordered seven favorites, persists order and suppresses unchanged notifications', () => {
  const data = new Map(), storage = { getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v) };
  const store = sharedFavorites(storage, createFavorites);
  const pairs = Array.from({ length: MAX_FAVORITES }, (_, i) => ({provider:'a',id:String(i)}));
  assert.equal(MAX_FAVORITES, 7);
  pairs.forEach(p => assert.equal(store.toggle(p).ok, true));
  let notices = 0; store.subscribe(() => notices++);
  assert.equal(store.move(pairs[6], pairs[0], 'before').ok, true);
  const expected = [pairs[6], ...pairs.slice(0,6)];
  assert.deepEqual(store.getSnapshot(), expected);
  assert.deepEqual(sharedFavorites(storage,createFavorites).getSnapshot(), expected);
  assert.equal(notices, 1);
  const snapshot = store.getSnapshot();
  assert.equal(store.move(pairs[6], pairs[0], 'before').status, 'unchanged');
  assert.strictEqual(store.getSnapshot(), snapshot);
  assert.equal(notices, 1);
});
test('failed reorder preserves the shared visible snapshot and does not notify', () => {
  const data = new Map(); let fail = false;
  const storage = {getItem:k=>data.get(k)??null,setItem:(k,v)=>{if(fail)throw Error('quota'); data.set(k,v);}};
  const store = sharedFavorites(storage,createFavorites), a={provider:'p',id:'a'}, b={provider:'p',id:'b'};
  store.toggle(a);store.toggle(b);
  let notices=0;store.subscribe(()=>notices++);const snapshot=store.getSnapshot();fail=true;
  assert.equal(store.move(b,a).ok,false);assert.strictEqual(store.getSnapshot(),snapshot);assert.equal(notices,0);
});
