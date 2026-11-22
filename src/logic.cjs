'use strict';

const FAVORITES_KEY = 'dsh-quick-model-panel.favorites.v1';
const MAX_FAVORITES = 7;
const text = value => typeof value === 'string' && value.trim().length > 0;
const pairOf = value => value && text(value.provider) && text(value.id)
  ? { provider: value.provider, id: value.id } : null;
const equal = (a, b) => a.provider === b.provider && a.id === b.id;
const copyPairs = pairs => pairs.map(pair => ({ ...pair }));

/** Native ModelProviderGroup[] -> flat records; raw retains exact catalog metadata. */
function normalizeModels(groups) {
  const result = [];
  const seen = new Set();
  for (const group of Array.isArray(groups) ? groups : []) {
    if (!group || !text(group.id) || !Array.isArray(group.models)) continue;
    for (const raw of group.models) {
      if (!raw || !text(raw.id)) continue;
      // 二元组编码避免同名跨 provider、分隔符碰撞导致模型被误合并。
      const key = JSON.stringify([group.id, raw.id]);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ provider: group.id, id: raw.id,
        name: text(raw.name) ? raw.name : raw.id,
        providerName: text(group.name) ? group.name : group.id, raw });
    }
  }
  return result;
}

/** Host supplies localized names; native efforts are {id,name} objects, not string enums. */
function levelsFor(model) {
  const efforts = model?.raw?.reasoning?.efforts;
  const result = [];
  const seen = new Set();
  for (const effort of Array.isArray(efforts) ? efforts : []) {
    if (!effort || !text(effort.id) || seen.has(effort.id)) continue;
    seen.add(effort.id);
    result.push({ id: effort.id, label: text(effort.name) ? effort.name : effort.id });
  }
  return result;
}

// 显示当前档与切换模型共用同一规则，避免滑块显示和提交参数分别维护而漂移。
function resolveEffort(model, currentEffort) {
  const levels = levelsFor(model);
  const supports = id => levels.some(level => level.id === id);
  const advertised = model?.raw?.reasoning?.defaultEffort;
  const fallback = supports(advertised) ? advertised : undefined;
  return { levels, fallback, effective: supports(currentEffort) ? currentEffort : fallback };
}

function selectionFor(model, currentEffort) {
  const pair = pairOf(model);
  if (!pair) throw new TypeError('A model requires non-empty provider and id');
  const { effective } = resolveEffort(model, currentEffort);
  // 无显式默认档时留给 provider；不能将列表第一档伪造为默认档。
  return { provider: pair.provider, model: pair.id,
    ...(effective === undefined ? {} : { reasoningEffort: effective }) };
}

/**
 * storage: localStorage-compatible getItem/setItem. No global localStorage access.
 * read(): detached pairs. Mutations: {ok,status,pairs,persisted}.
 * Stored envelope: {version:1,seeded:true,pairs:[{provider,id}]}.
 * status: seeded/already-seeded/added/removed/replaced/full/stale-replacement/
 *         moved/unchanged/stale-order/invalid-model/invalid-edge/storage-error.
 * No implicit eviction; move(sourcePair, targetPair, edge='before') uses exact pairs.
 */
function createFavorites(storage, key = FAVORITES_KEY) {
  if (!text(key)) throw new TypeError('A non-empty storage key is required');
  let last = { seeded: false, pairs: [] };
  function load() {
    let raw;
    try { raw = storage.getItem(key); }
    catch { return { ...last, failed: true }; }
    if (raw === null) {
      last = { seeded: false, pairs: [] };
      return last;
    }
    // 已存在但损坏的状态也视为初始化过，防止空收藏被偷偷补回。
    let state = { seeded: true, pairs: [] };
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1 && Array.isArray(parsed.pairs) && parsed.pairs.length <= MAX_FAVORITES) {
        const pairs = [];
        for (const candidate of parsed.pairs) {
          const pair = pairOf(candidate);
          if (pair && !pairs.some(p => equal(p, pair))) pairs.push(pair);
        }
        state = { seeded: true, pairs };
      }
    } catch { /* 损坏内容不自动覆盖；下次显式收藏操作才修复。 */ }
    last = state;
    return state;
  }
  function result(ok, status, state, persisted = false) {
    return { ok, status, pairs: copyPairs(state.pairs), persisted };
  }
  function save(pairs, status, before) {
    const state = { seeded: true, pairs };
    try { storage.setItem(key, JSON.stringify({ version: 1, ...state })); }
    catch { return result(false, 'storage-error', before); }
    last = state;
    return result(true, status, state, true);
  }
  return {
    read() { return copyPairs(load().pairs); },
    seed(currentPair) {
      const state = load();
      if (state.failed) return result(false, 'storage-error', state);
      if (state.seeded) return result(true, 'already-seeded', state);
      const pair = pairOf(currentPair);
      // 当前模型尚未加载时不消耗唯一 seed 机会。
      if (!pair) return result(false, 'invalid-model', state);
      return save([pair], 'seeded', state);
    },
    toggle(model, replacePair) {
      // 每次从 storage 重读，避免另一个会话变更后用闭包旧快照覆盖。
      const state = load();
      if (state.failed) return result(false, 'storage-error', state);
      const pair = pairOf(model);
      if (!pair) return result(false, 'invalid-model', state);
      const index = state.pairs.findIndex(p => equal(p, pair));
      if (replacePair !== undefined) {
        // 显式替换不是普通 toggle：另一会话已收藏新目标时，旧弹窗不能把它反向删除。
        if (index !== -1) return result(false, 'stale-replacement', state);
        const replacement = pairOf(replacePair);
        const target = replacement ? state.pairs.findIndex(p => equal(p, replacement)) : -1;
        // 替换弹窗打开后另一会话可能已删除目标；不能退化为按位置或任意淘汰。
        if (target === -1) return result(false, 'stale-replacement', state);
        return save(state.pairs.map((p, i) => i === target ? pair : p), 'replaced', state);
      }
      if (index !== -1) return save(state.pairs.filter((_, i) => i !== index), 'removed', state);
      if (state.pairs.length >= MAX_FAVORITES) return result(false, 'full', state);
      return save([...state.pairs, pair], 'added', state);
    },
    move(sourcePair, targetPair, edge = 'before') {
      // 拖动期间其他会话可能增删收藏：只移动最新状态中的精确二元组，不保存旧列表。
      const state = load();
      if (state.failed) return result(false, 'storage-error', state);
      const source = pairOf(sourcePair), target = pairOf(targetPair);
      if (!source || !target) return result(false, 'invalid-model', state);
      if (edge !== 'before' && edge !== 'after') return result(false, 'invalid-edge', state);
      const sourceIndex = state.pairs.findIndex(p => equal(p, source));
      const targetIndex = state.pairs.findIndex(p => equal(p, target));
      if (sourceIndex === -1 || targetIndex === -1) return result(false, 'stale-order', state);
      if (sourceIndex === targetIndex) return result(true, 'unchanged', state);
      const pairs = state.pairs.filter((_, i) => i !== sourceIndex);
      // 移除源后重新定位目标，避免向下拖动时插入位置偏移一项。
      const insertion = pairs.findIndex(p => equal(p, target)) + (edge === 'after' ? 1 : 0);
      pairs.splice(insertion, 0, state.pairs[sourceIndex]);
      if (pairs.every((pair, i) => equal(pair, state.pairs[i]))) return result(true, 'unchanged', state);
      return save(pairs, 'moved', state);
    },
  };
}

module.exports = { FAVORITES_KEY, MAX_FAVORITES, normalizeModels, levelsFor, resolveEffort, selectionFor, createFavorites };
