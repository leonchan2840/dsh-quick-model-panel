'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_FAVORITES, normalizeModels, levelsFor, selectionFor, createFavorites } = require('../src/logic.cjs');
const KEY = 'test-favorites';
const pair = (id, provider = 'p') => ({ provider, id });
function storage(initial) {
  const data = new Map(initial === undefined ? [] : [[KEY, initial]]);
  return { getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, value), data };
}
function model(reasoning) {
  return normalizeModels([{ id: 'p', name: 'Provider', models: [{ id: 'm', name: 'Model', reasoning }] }])[0];
}
const reasoning = { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'low' };

test('native catalog flattens, preserves order and raw identity', () => {
  const raw = { id: 'm', name: '模型', reasoning };
  const result = normalizeModels([{ id: 'p', name: '提供商', models: [raw] }]);
  assert.deepEqual(result, [{ provider: 'p', id: 'm', name: '模型', providerName: '提供商', raw }]);
  assert.equal(result[0].raw, raw);
});
test('normalization skips malformed entries, deduplicates exact pairs only', () => {
  assert.deepEqual(normalizeModels(null), []);
  const result = normalizeModels([null, {}, { id: 'bad', models: null },
    { id: 'p', models: [null, {}, { id: ' ' }, { id: 'm' }, { id: 'm' }] },
    { id: 'q', models: [{ id: 'm' }] }]);
  assert.deepEqual(result.map(x => [x.provider, x.id, x.name, x.providerName]),
    [['p', 'm', 'm', 'p'], ['q', 'm', 'm', 'q']]);
});
test('pair encoding does not collide on separator-like IDs', () => {
  assert.equal(normalizeModels([{ id: 'a/b', models: [{ id: 'c' }] }, { id: 'a', models: [{ id: 'b/c' }] }]).length, 2);
});
test('levels use exact native efforts names and opaque IDs, without inventing enums', () => {
  assert.deepEqual(levelsFor(model(reasoning)), [{ id: 'low', label: '低' }, { id: 'high', label: '高' }]);
  assert.deepEqual(levelsFor(model({ efforts: ['low', 'high'] })), []);
  assert.deepEqual(levelsFor(model({ levels: ['low'], labels: { low: '低' } })), []);
});
test('levels reject malformed entries and duplicate IDs, retain native order', () => {
  assert.deepEqual(levelsFor(model({ efforts: [null, {}, { id: 'x' }, { id: 'x', name: 'duplicate' }, { id: 'y', name: '' }] })),
    [{ id: 'x', label: 'x' }, { id: 'y', label: 'y' }]);
  for (const value of [null, {}, model(undefined), model({ efforts: null })]) assert.deepEqual(levelsFor(value), []);
});
test('selection retains supported current effort over target default', () => {
  assert.deepEqual(selectionFor(model(reasoning), 'high'), { provider: 'p', model: 'm', reasoningEffort: 'high' });
});
test('selection uses target default when previous effort is unsupported or unset', () => {
  for (const value of ['other', undefined, null]) {
    assert.deepEqual(selectionFor(model(reasoning), value), { provider: 'p', model: 'm', reasoningEffort: 'low' });
  }
});
test('absence of explicit default preserves provider default, never first effort', () => {
  for (const r of [undefined, { efforts: reasoning.efforts }, { efforts: [] },
    { efforts: reasoning.efforts, defaultEffort: 'stale' }]) {
    const selected = selectionFor(model(r), 'other');
    assert.deepEqual(selected, { provider: 'p', model: 'm' });
    assert.equal(Object.hasOwn(selected, 'reasoningEffort'), false);
  }
  assert.equal(selectionFor(model({ efforts: reasoning.efforts }), 'high').reasoningEffort, 'high');
});
test('selection rejects invalid model identity', () => {
  for (const value of [null, {}, { provider: ' ', id: 'm' }]) assert.throws(() => selectionFor(value), TypeError);
});
test('seed waits for first valid model and survives new sessions', () => {
  const store = storage(), favorites = createFavorites(store, KEY);
  assert.equal(favorites.seed(null).status, 'invalid-model');
  assert.equal(store.data.size, 0);
  assert.equal(favorites.seed(pair('m')).status, 'seeded');
  const next = createFavorites(store, KEY);
  assert.equal(next.seed(pair('other')).status, 'already-seeded');
  assert.deepEqual(next.read(), [pair('m')]);
});
test('deliberately empty favorites never reseed after remount', () => {
  const store = storage(), a = createFavorites(store, KEY);
  a.seed(pair('m')); a.toggle(pair('m'));
  const b = createFavorites(store, KEY);
  assert.deepEqual(b.read(), []);
  assert.equal(b.seed(pair('other')).status, 'already-seeded');
});
test('manual toggle before seed also consumes seed opportunity', () => {
  const favorites = createFavorites(storage(), KEY);
  favorites.toggle(pair('m'));
  assert.equal(favorites.seed(pair('other')).status, 'already-seeded');
});
test('v1 five-favorite upgrade retains the default key, envelope, and original order', () => {
  assert.equal(MAX_FAVORITES, 7);
  const key = 'dsh-quick-model-panel.favorites.v1';
  const oldPairs = [pair('z'), pair('m', 'q'), pair('a'), pair('m', 'p'), pair('offline')];
  const raw = JSON.stringify({ version: 1, seeded: true, pairs: oldPairs });
  const store = storage(); store.data.set(key, raw);
  const favorites = createFavorites(store);
  assert.deepEqual(favorites.read(), oldPairs);
  assert.equal(favorites.seed(pair('ignored')).status, 'already-seeded');
  assert.equal(store.data.get(key), raw);
  assert.equal(favorites.toggle(pair('six')).status, 'added');
  assert.deepEqual(favorites.toggle(pair('seven')),
    { ok: true, status: 'added', pairs: [...oldPairs, pair('six'), pair('seven')], persisted: true });
  const expected = [...oldPairs, pair('six'), pair('seven')];
  assert.deepEqual(createFavorites(store).read(), expected);
  assert.deepEqual(JSON.parse(store.data.get(key)), { version: 1, seeded: true, pairs: expected });
  assert.deepEqual([...store.data.keys()], [key]);
});
test('eighth favorite cannot automatically evict; exact explicit replacement preserves position', () => {
  const store = storage(), favorites = createFavorites(store, KEY);
  for (let i = 0; i < MAX_FAVORITES; i++) assert.equal(favorites.toggle(pair(String(i))).status, 'added');
  const before = favorites.read(), raw = store.data.get(KEY);
  assert.deepEqual(favorites.toggle(pair('eight')),
    { ok: false, status: 'full', pairs: before, persisted: false });
  assert.deepEqual(favorites.read(), before);
  assert.equal(store.data.get(KEY), raw);
  const expected = before.map((p, i) => i === 2 ? pair('eight') : p);
  assert.deepEqual(favorites.toggle(pair('eight'), pair('2')),
    { ok: true, status: 'replaced', pairs: expected, persisted: true });
  assert.deepEqual(createFavorites(store, KEY).read(), expected);
});
test('same model ID in different providers is independent', () => {
  const favorites = createFavorites(storage(), KEY);
  favorites.toggle(pair('m', 'p')); favorites.toggle(pair('m', 'q'));
  favorites.toggle(pair('m', 'p'));
  assert.deepEqual(favorites.read(), [pair('m', 'q')]);
});
test('stale replacement is rejected after another session changes storage', () => {
  const store = storage(), a = createFavorites(store, KEY), b = createFavorites(store, KEY);
  for (let i = 0; i < MAX_FAVORITES; i++) a.toggle(pair(String(i)));
  b.toggle(pair('2'));
  assert.equal(a.toggle(pair('eight'), pair('2')).status, 'stale-replacement');
  assert.equal(a.toggle(pair('eight'), pair('1', 'wrong-provider')).status, 'stale-replacement');
  assert.deepEqual(a.read(), [pair('0'), pair('1'), pair('3'), pair('4'), pair('5'), pair('6')]);
});
test('explicit stale replacement never removes a target newly favorited by another session', () => {
  const store = storage(), a = createFavorites(store, KEY), b = createFavorites(store, KEY);
  for (let i = 0; i < MAX_FAVORITES; i++) a.toggle(pair(String(i)));
  b.toggle(pair('eight'), pair('2'));
  const before = b.read(), storedBefore = store.data.get(KEY);
  assert.deepEqual(a.toggle(pair('eight'), pair('1')),
    { ok: false, status: 'stale-replacement', pairs: before, persisted: false });
  assert.equal(store.data.get(KEY), storedBefore);
  assert.equal(a.toggle(pair('eight'), pair('2')).status, 'stale-replacement');
  assert.deepEqual(a.read(), before);
  // 无替换参数仍是明确的普通取消收藏。
  assert.equal(a.toggle(pair('eight')).status, 'removed');
});
test('different instances re-read storage rather than clobbering previous changes', () => {
  const store = storage(), a = createFavorites(store, KEY), b = createFavorites(store, KEY);
  a.toggle(pair('a')); b.toggle(pair('b')); a.toggle(pair('c'));
  assert.deepEqual(b.read(), [pair('a'), pair('b'), pair('c')]);
});
test('read and mutation results are detached snapshots', () => {
  const a = createFavorites(storage(), KEY);
  const result = a.seed(pair('m')); result.pairs[0].id = 'changed';
  const read = a.read(); read[0].provider = 'changed'; read.push(pair('x'));
  assert.deepEqual(a.read(), [pair('m')]);
});
test('move supports before/after in both directions, including head and tail', () => {
  const cases = [
    ['e', 'a', 'before', ['e', 'a', 'b', 'c', 'd']],
    ['a', 'e', 'after', ['b', 'c', 'd', 'e', 'a']],
    ['d', 'b', 'before', ['a', 'd', 'b', 'c', 'e']],
    ['d', 'b', 'after', ['a', 'b', 'd', 'c', 'e']],
    ['b', 'd', 'before', ['a', 'c', 'b', 'd', 'e']],
    ['b', 'd', 'after', ['a', 'c', 'd', 'b', 'e']],
    ['e', 'c', undefined, ['a', 'b', 'e', 'c', 'd']],
  ];
  for (const [source, target, edge, ids] of cases) {
    const store = storage(JSON.stringify({ version: 1, seeded: true, pairs: ['a', 'b', 'c', 'd', 'e'].map(id => pair(id)) }));
    const favorites = createFavorites(store, KEY), expected = ids.map(id => pair(id));
    assert.deepEqual(favorites.move(pair(source), pair(target), edge),
      { ok: true, status: 'moved', pairs: expected, persisted: true });
    assert.deepEqual(createFavorites(store, KEY).read(), expected);
    assert.deepEqual(JSON.parse(store.data.get(KEY)), { version: 1, seeded: true, pairs: expected });
  }
});
test('move resolves source and target by exact provider/id, including offline models', () => {
  const before = [pair('same', 'p'), pair('offline'), pair('same', 'q'), pair('tail')];
  const favorites = createFavorites(storage(JSON.stringify({ version: 1, seeded: true, pairs: before })), KEY);
  assert.deepEqual(favorites.move(pair('same', 'q'), pair('same', 'p')).pairs,
    [pair('same', 'q'), pair('same', 'p'), pair('offline'), pair('tail')]);
  assert.deepEqual(favorites.move(pair('same', 'p'), pair('same', 'q')).pairs,
    [pair('same', 'p'), pair('same', 'q'), pair('offline'), pair('tail')]);
  assert.equal(favorites.move(pair('same', 'unknown'), pair('same', 'p')).status, 'stale-order');
  assert.equal(favorites.move(pair('same', 'p'), pair('same', 'unknown')).status, 'stale-order');
});
test('moving self or an already adjacent item is unchanged and never writes', () => {
  const before = [pair('a'), pair('b'), pair('c')];
  const store = storage(JSON.stringify({ version: 1, seeded: true, pairs: before }));
  const favorites = createFavorites(store, KEY);
  let writes = 0; store.setItem = () => { writes++; throw Error('must not write'); };
  for (const [source, target, edge] of [
    ['a', 'a', 'before'], ['b', 'b', 'after'], ['a', 'b', 'before'], ['c', 'b', 'after'],
  ]) {
    assert.deepEqual(favorites.move(pair(source), pair(target), edge),
      { ok: true, status: 'unchanged', pairs: before, persisted: false });
  }
  assert.equal(writes, 0);
});
test('move rejects missing source/target, invalid pairs and invalid edges without writing', () => {
  const before = [pair('a'), pair('b')];
  const store = storage(JSON.stringify({ version: 1, seeded: true, pairs: before }));
  const favorites = createFavorites(store, KEY);
  let writes = 0; store.setItem = () => { writes++; };
  for (const [source, target, edge, status] of [
    [pair('gone'), pair('b'), 'before', 'stale-order'],
    [pair('a'), pair('gone'), 'after', 'stale-order'],
    [pair('gone'), pair('gone'), 'before', 'stale-order'],
    [null, pair('b'), 'before', 'invalid-model'],
    [pair('a'), { provider: 'p', id: '' }, 'before', 'invalid-model'],
    [pair('a'), pair('b'), 'sideways', 'invalid-edge'],
  ]) {
    assert.deepEqual(favorites.move(source, target, edge), { ok: false, status, pairs: before, persisted: false });
  }
  assert.equal(writes, 0);
});
test('move preserves additions and deletions completed by another instance before this move', () => {
  const before = [pair('a'), pair('b'), pair('c'), pair('d')];
  const store = storage(JSON.stringify({ version: 1, seeded: true, pairs: before }));
  const a = createFavorites(store, KEY), b = createFavorites(store, KEY);
  assert.deepEqual(a.read(), before);
  b.toggle(pair('new')); b.toggle(pair('b'));
  const expected = [pair('d'), pair('a'), pair('c'), pair('new')];
  assert.deepEqual(a.move(pair('d'), pair('a')),
    { ok: true, status: 'moved', pairs: expected, persisted: true });
  assert.deepEqual(b.read(), expected);
});
test('move uses current order after another instance reorders', () => {
  const before = [pair('a'), pair('b'), pair('c'), pair('d')];
  const store = storage(JSON.stringify({ version: 1, seeded: true, pairs: before }));
  const a = createFavorites(store, KEY), b = createFavorites(store, KEY);
  a.read(); b.move(pair('d'), pair('a'));
  assert.deepEqual(a.move(pair('c'), pair('b')).pairs, [pair('d'), pair('a'), pair('c'), pair('b')]);
});
test('source/target deletion completed before the move rejects stale drag without restoring pairs', () => {
  for (const deleted of ['a', 'c']) {
    const before = [pair('a'), pair('b'), pair('c')];
    const store = storage(JSON.stringify({ version: 1, seeded: true, pairs: before }));
    const a = createFavorites(store, KEY), b = createFavorites(store, KEY);
    a.read(); b.toggle(pair(deleted));
    const expected = b.read(), raw = store.data.get(KEY);
    let writes = 0; store.setItem = () => { writes++; };
    assert.deepEqual(a.move(pair('a'), pair('c'), 'after'),
      { ok: false, status: 'stale-order', pairs: expected, persisted: false });
    assert.equal(store.data.get(KEY), raw);
    assert.equal(writes, 0);
  }
});
test('move read/write failures return storage-error and preserve latest real state', () => {
  const before = [pair('a'), pair('b')];
  const store = storage(JSON.stringify({ version: 1, seeded: true, pairs: before }));
  const favorites = createFavorites(store, KEY), originalGet = store.getItem;
  favorites.read();
  store.getItem = () => { throw Error('denied'); };
  for (const target of ['a', 'b']) {
    assert.deepEqual(favorites.move(pair('a'), pair(target)),
      { ok: false, status: 'storage-error', pairs: before, persisted: false });
  }
  store.getItem = originalGet;
  createFavorites(store, KEY).toggle(pair('concurrent'));
  const latest = [...before, pair('concurrent')], raw = store.data.get(KEY);
  store.setItem = () => { throw Error('quota'); };
  assert.deepEqual(favorites.move(pair('b'), pair('a')),
    { ok: false, status: 'storage-error', pairs: latest, persisted: false });
  assert.equal(store.data.get(KEY), raw);
  assert.deepEqual(favorites.read(), latest);
  assert.equal(createFavorites(undefined).move(pair('a'), pair('a')).status, 'storage-error');
});
test('move never succeeds or overwrites corrupt, unsupported or absent stored state', () => {
  for (const raw of [undefined, '{', JSON.stringify({ version: 2, pairs: [pair('a')] })]) {
    const store = storage(raw), favorites = createFavorites(store, KEY);
    let writes = 0; store.setItem = () => { writes++; };
    assert.deepEqual(favorites.move(pair('a'), pair('a')),
      { ok: false, status: 'stale-order', pairs: [], persisted: false });
    assert.equal(writes, 0);
    assert.equal(store.data.get(KEY), raw);
  }
});
test('move results are detached snapshots even without storage re-reading', () => {
  const before = [pair('a'), pair('b')];
  const store = storage(JSON.stringify({ version: 1, seeded: true, pairs: before }));
  const favorites = createFavorites(store, KEY), result = favorites.move(pair('b'), pair('a'));
  result.pairs[0].id = 'changed'; result.pairs.push(pair('extra'));
  store.getItem = () => { throw Error('denied'); };
  assert.deepEqual(favorites.read(), [pair('b'), pair('a')]);
});
test('corrupt and unknown stored states suppress seed without automatic overwrite', () => {
  for (const raw of ['', '{', 'null', '[]', '{}', '{"version":2,"pairs":[]}',
    JSON.stringify({ version: 1, pairs: Array.from({ length: MAX_FAVORITES + 1 }, (_, i) => pair(String(i))) })]) {
    const store = storage(raw), a = createFavorites(store, KEY);
    assert.deepEqual(a.read(), []);
    assert.equal(a.seed(pair('m')).status, 'already-seeded');
    assert.equal(store.data.get(KEY), raw);
    assert.equal(a.toggle(pair('repair')).status, 'added');
  }
});
test('stored pair validation removes duplicates and invalid rows but no catalog pruning', () => {
  const store = storage(JSON.stringify({ version: 1, pairs: [pair('offline'), pair('offline'), null, { provider: 'p', id: '' }] }));
  assert.deepEqual(createFavorites(store, KEY).read(), [pair('offline')]);
});
test('read failures never permit mutation over unknown state', () => {
  let fail = false;
  const store = storage(), originalGet = store.getItem;
  store.getItem = key => { if (fail) throw Error('denied'); return originalGet(key); };
  const a = createFavorites(store, KEY); a.seed(pair('safe')); fail = true;
  assert.deepEqual(a.read(), [pair('safe')]);
  assert.equal(a.toggle(pair('new')).status, 'storage-error');
  assert.equal(a.seed(pair('new')).status, 'storage-error');
  fail = false; assert.deepEqual(a.read(), [pair('safe')]);
});
test('failed writes report error without success or fictional in-memory state', () => {
  const store = storage(), originalSet = store.setItem;
  store.setItem = () => { throw Error('quota'); };
  const a = createFavorites(store, KEY);
  assert.deepEqual(a.seed(pair('m')), { ok: false, status: 'storage-error', pairs: [], persisted: false });
  store.setItem = originalSet;
  assert.equal(a.seed(pair('m')).status, 'seeded');
  store.setItem = () => { throw Error('quota'); };
  assert.equal(a.toggle(pair('m')).ok, false);
  assert.deepEqual(a.read(), [pair('m')]);
});
test('unavailable storage is handled; invalid model does not write; custom/default keys isolated', () => {
  const a = createFavorites(undefined);
  assert.deepEqual(a.read(), []);
  assert.equal(a.seed(pair('m')).status, 'storage-error');
  const store = storage(), b = createFavorites(store, KEY);
  assert.equal(b.toggle(null).status, 'invalid-model');
  assert.equal(store.data.size, 0);
  createFavorites(store).seed(pair('default'));
  assert.deepEqual(b.read(), []);
  assert.throws(() => createFavorites(store, ''), TypeError);
});
