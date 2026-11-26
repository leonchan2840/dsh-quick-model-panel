'use strict';

// 双栏优先贴近入口；窗口虽够宽但会把主层挪远时，改用同位二级层。
function horizontalLayout(viewport, anchor, expanded) {
  const width = Math.max(1, Math.min(340, viewport - 16));
  const twoColumns = viewport >= 16 + width + 8 + 340;
  const twoColumnLeft = Math.max(8, Math.min(anchor, viewport - width - 8 - 340 - 8));
  // 仅因理论上放得下，不应将入口右侧的主面板硬挪走超过一整栏。
  const side = expanded && twoColumns && anchor - twoColumnLeft <= width ? 'right' : 'inside';
  return { width, side, left: side === 'right' ? twoColumnLeft : Math.max(8, Math.min(anchor, viewport - width - 8)) };
}

// 打开前预留双栏宽；右侧完整目录保留独立视口预算，不随主层收藏内容变化。
// 主层的自然高度和屏幕边缘定位另由 primaryGeometry 处理。
function panelLayout(viewport, anchor) {
  const { width, left, side } = horizontalLayout(viewport.width, anchor.left, true);
  const above = anchor.top >= Math.min(360, viewport.height * 0.55);
  const available = Math.max(1, above ? anchor.top - 16 : viewport.height - anchor.bottom - 16);
  const height = Math.min(560, available);
  const top = above ? Math.max(8, anchor.top - 8 - height) : anchor.bottom + 8;
  return { width, left, side, top, height };
}
// 主层不使用右侧目录的 560px 预算，也不锁住首次高度。只受实际窗口边缘约束。
function primaryGeometry(position, contentHeight, preferredTop = null) {
  if (!position) return {};
  const maxHeight = Math.max(1, position.viewportHeight - 16);
  const height = Math.min(maxHeight, contentHeight ?? maxHeight);
  const anchorTop = position.above ? position.anchorTop - height - 8 : position.anchorBottom + 8;
  return { top: Math.max(8, Math.min(preferredTop ?? anchorTop, position.viewportHeight - height - 8)), maxHeight };
}
function sameLayout(a, b) {
  return !!a && Object.keys(b).every((key) => a[key] === b[key]);
}
function containsEvent(event, roots) {
  const native = event.nativeEvent || event;
  const path = typeof native.composedPath === 'function' ? native.composedPath() : [];
  return roots.some((root) => root && (path.includes(root) ||
    (event.target && typeof event.target.nodeType === 'number' && typeof root.contains === 'function' && root.contains(event.target))));
}
// 只隔离鼠标/指针的冒泡，不 preventDefault：按钮、输入、range 与键盘保持原生行为。
function stopComposerEvent(event) { event.stopPropagation(); }
function remoteBlocked(locked, pending, busy) { return !!(locked || pending || busy); }
// 同名原生 radio 组只有选中的一项进入 Tab 顺序；聚焦陷阱不可把其余项当作末尾。
function tabStops(elements) {
  const chosen = new Map();
  for (const el of elements) if (el.type === 'radio' && el.name && (el.checked || !chosen.has(el.name))) chosen.set(el.name, el);
  return elements.filter(el => el.type !== 'radio' || !el.name || chosen.get(el.name) === el);
}
// 请求仍会由宿主正常完成，但旧请求不能关闭后来重新打开的搜索层。
function shouldCloseSearch(requestEpoch, currentEpoch, panelOpen, searchOpen) {
  return requestEpoch === currentEpoch && !!panelOpen && !!searchOpen;
}

// 保留渠道原始顺序与准确 ID；同名渠道不能合并，搜索结果也仍按渠道呈现。
function groupChannels(models) {
  const groups = new Map();
  for (const model of models) {
    if (!groups.has(model.provider)) groups.set(model.provider, { id: model.provider, name: model.providerName || model.provider, models: [] });
    groups.get(model.provider).models.push(model);
  }
  return [...groups.values()];
}
// 行副标题与替换候选共享渠道说明；同名渠道仍显示准确 ID，避免替换错收藏。
function providerLabel(model) {
  return model.providerName && model.providerName !== model.provider
    ? model.providerName + ' · ' + model.provider : model.provider;
}
// 入口摘要只读宿主已生效的档位；不能用滑块 preview，把尚未提交/失败的调整显示成已生效。
function triggerSummary(modelName, levels, effortIndex, emptyLabel, savedEffort) {
  const hasModel = typeof modelName === 'string' && modelName.length > 0;
  const model = hasModel ? modelName : emptyLabel;
  // 目录更新可能移除历史档位。显示当前值时保留它的 ID，不能拿“切模型时回退”冒充已生效默认档。
  const saved = hasModel && levels.length > 0 && typeof savedEffort === 'string' && savedEffort.trim() ? savedEffort : undefined;
  const level = saved !== undefined ? levels.find(item => item.id === saved)
    : hasModel && Number.isInteger(effortIndex) && effortIndex >= 0 ? levels[effortIndex] : undefined;
  const effort = typeof level?.label === 'string' ? level.label : saved ?? '';
  return { model, effort, text: effort ? model + ' · ' + effort : model };
}
function favoriteDrop(y, rows) {
  if (!rows.length) return null;
  const row = rows.find(r => y < r.bottom) || rows[rows.length - 1];
  return { key: row.key, edge: y < (row.top + row.bottom) / 2 ? 'before' : 'after' };
}

/** Host owns persistence, locale lookup, CSS injection and key={sessionId}. */
function createView(React, createPortal) {
  const { createElement: h, useState, useRef, useEffect, useLayoutEffect, useId, useMemo } = React;
  const pairKey = (m) => JSON.stringify([m.provider, m.id]);
  const same = (a, b) => !!a && !!b && a.provider === b.provider && a.id === b.id;
  const focusable = 'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]';

  return function QuickPanel(props) {
    const { modelName, models = [], current, favs = [], onStar, onSelect, levels = [], effortIndex,
      onEffort, onMove, maxFavorites, teamNode, settingsNode, locked, pending, loading, error, reload, t, onOpen } = props;
    const [open, setOpen] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [channel, setChannel] = useState('');
    const [drag, setDrag] = useState(null);
    const [orderNotice, setOrderNotice] = useState('');
    const dragRef = useRef(null), dragFrame = useRef(null);
    const [replacement, setReplacement] = useState(null);
    const [preview, setPreview] = useState(effortIndex);
    const [busy, setBusy] = useState(false);
    const [localError, setLocalError] = useState('');
    const [position, setPosition] = useState(null);
    const [primaryHeight, setPrimaryHeight] = useState(null);
    const primaryTopRef = useRef(null);
    const rootRef = useRef(null), triggerRef = useRef(null), panelRef = useRef(null);
    const searchRef = useRef(null), searchButtonRef = useRef(null), inputRef = useRef(null);
    const settingsRef = useRef(null), settingsButtonRef = useRef(null);
    const mounted = useRef(false), inFlight = useRef(false), previewRef = useRef(effortIndex);
    const editing = useRef(false), openRef = useRef(false), searchOpenRef = useRef(false), settingsOpenRef = useRef(false), searchEpoch = useRef(0);
    const latest = useRef(props); latest.current = props;
    // 档位 ID 属于提供方，不假定其不含分隔符；二义签名会漏掉目录变更。
    const levelSignature = JSON.stringify(levels.map((level) => level.id));
    const roots = () => [rootRef.current, panelRef.current, searchRef.current, settingsRef.current];
    const isolation = { onPointerDown: stopComposerEvent, onMouseDown: stopComposerEvent, onClick: stopComposerEvent,
      'data-composer-overlay': true };
    const uid = useId();
    const panelId = uid + '-panel', searchId = uid + '-search', settingsId = uid + '-settings', effortId = uid + '-effort';
    const translate = (key) => t('qmp.' + key);
    const favoritePairs = favs.filter((m, i, all) => all.findIndex((x) => same(x, m)) === i).slice(0, maxFavorites);
    const favoriteModels = favoritePairs.map((pair) => models.find((m) => same(m, pair)) || { ...pair, name: pair.id, missing: true });
    const disabled = remoteBlocked(locked, pending, busy);
    const validEffort = levels.length > 0 && Number.isInteger(effortIndex) && effortIndex >= 0 && effortIndex < levels.length;
    const trigger = triggerSummary(modelName, levels, effortIndex, translate('chooseModel'), current?.reasoningEffort);
    const safePreview = Number.isInteger(preview) ? Math.max(0, Math.min(levels.length - 1, preview)) : 0;
    const normalizedQuery = useMemo(() => query.trim().toLocaleLowerCase(), [query]);
    const channels = useMemo(() => groupChannels(models), [models]);
    const filtered = useMemo(() => searchOpen ? models.filter((m) =>
      (!channel || channel === m.provider) && [m.name, m.id, m.provider, m.providerName].join(' ').toLocaleLowerCase().includes(normalizedQuery)) : [],
    [models, normalizedQuery, searchOpen, channel]);
    const groups = useMemo(() => groupChannels(filtered), [filtered]);
    useEffect(() => { if (channel && !channels.some(g => g.id === channel)) setChannel(''); }, [channels, channel]);

    // 取消、松手和卸载共用资源回收；卸载路径不再调用 setState。
    function clearDrag() {
      const state = dragRef.current;
      if (dragFrame.current !== null) state?.win.cancelAnimationFrame(dragFrame.current);
      dragFrame.current = null; dragRef.current = null;
      if (state?.handle.hasPointerCapture?.(state.pointerId)) state.handle.releasePointerCapture(state.pointerId);
    }
    function cancelDrag() { clearDrag(); setDrag(null); }
    function moveFavorite(source, target, edge) {
      try {
        const ok = latest.current.onMove(source, target, edge);
        setLocalError(ok ? '' : translate('operationFailed'));
        if (ok) setOrderNotice(translate('orderSaved') + ': ' + (source.name || source.id));
      } catch (_) { setLocalError(translate('operationFailed')); }
    }
    function dragTarget(state, scroll) {
      const panel = panelRef.current, scroller = panel?.querySelector('.dsh-qmp-favorites');
      if (!panel || !scroller) return null;
      // 小窗只收藏区滚动；拖动落点与自动滚动边界也必须跟随收藏区，而不是底部设置。
      const bounds = scroller.getBoundingClientRect();
      if (state.x < bounds.left || state.x > bounds.right || state.y < bounds.top || state.y > bounds.bottom) return null;
      if (scroll) {
        if (state.y < bounds.top + 32) scroller.scrollTop -= 8;
        else if (state.y > bounds.bottom - 32) scroller.scrollTop += 8;
      }
      const rows = Array.from(panel.querySelectorAll('[data-favorite-key]')).map(el => {
        const r = el.getBoundingClientRect();
        return { key: el.dataset.favoriteKey, top: r.top, bottom: r.bottom };
      });
      return favoriteDrop(state.y, rows);
    }
    function tickDrag() {
      dragFrame.current = null;
      const state = dragRef.current;
      if (!state || !state.started) return;
      if (!state.handle.isConnected || !latest.current.favs.some(m => same(m, state.model))) { cancelDrag(); return; }
      const target = dragTarget(state, true);
      state.target = target;
      const next = { source: pairKey(state.model), target: target?.key, edge: target?.edge };
      setDrag(previous => sameLayout(previous, next) ? previous : next);
      dragFrame.current = state.win.requestAnimationFrame(tickDrag);
    }
    function startDrag(event, model) {
      if (event.button !== 0 || !onMove || favoritePairs.length < 2) return;
      event.preventDefault(); event.stopPropagation();
      cancelDrag();
      const handle = event.currentTarget;
      handle.focus({ preventScroll: true });
      handle.setPointerCapture(event.pointerId);
      dragRef.current = { model, pointerId: event.pointerId, handle, win: handle.ownerDocument.defaultView,
        x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, started: false };
      setOrderNotice('');
    }
    function updateDrag(event) {
      const state = dragRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      state.x = event.clientX; state.y = event.clientY;
      if (!state.started && Math.hypot(state.x - state.startX, state.y - state.startY) >= 5) state.started = true;
      if (state.started && dragFrame.current === null) dragFrame.current = state.win.requestAnimationFrame(tickDrag);
    }
    function finishDrag(event) {
      const state = dragRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      state.x = event.clientX; state.y = event.clientY;
      const target = state.started ? dragTarget(state, false) : null;
      cancelDrag();
      if (target && target.key !== pairKey(state.model)) {
        const pair = latest.current.favs.find(m => pairKey(m) === target.key);
        if (pair) moveFavorite(state.model, pair, target.edge);
      }
    }
    function keyboardMove(event, model) {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      // 指针排序尚未提交时，方向键不能绕过松手/Esc 规则提前写入。
      if (dragRef.current) return;
      const index = favoriteModels.findIndex(m => same(m, model));
      const destination = event.key === 'Home' ? 0 : event.key === 'End' ? favoriteModels.length - 1 :
        index + (event.key === 'ArrowUp' ? -1 : 1);
      const target = favoriteModels[destination];
      if (target && index !== destination) moveFavorite(model, target, destination < index ? 'before' : 'after');
    }
    // 其他窗口取消正在拖动的收藏时，旧手柄可能收不到 lostpointercapture。
    useEffect(() => {
      const state = dragRef.current;
      if (state && (!state.handle.isConnected || !favs.some(m => same(m, state.model)))) cancelDrag();
    }, [favs]);
    // 指针捕获只发生于独立手柄；跨会话卸载和取消都不得落盘。
    useEffect(() => clearDrag, []);

    function closeSearch(restore) {
      searchEpoch.current++;
      searchOpenRef.current = false;
      setSearchOpen(false); setReplacement(null);
      if (restore && searchButtonRef.current) searchButtonRef.current.focus({ preventScroll: true });
    }
    function closeSettings(restore) {
      settingsOpenRef.current = false; setSettingsOpen(false);
      if (restore) settingsButtonRef.current?.focus({ preventScroll: true });
    }
    function closePanel(restore) {
      openRef.current = false;
      cancelDrag(); setOpen(false); setPosition(null); closeSearch(false); closeSettings(false); setQuery(''); setChannel('');
      editing.current = false; previewRef.current = effortIndex; setPreview(effortIndex);
      if (restore && triggerRef.current) triggerRef.current.focus({ preventScroll: true });
    }
    function showSearch() {
      searchEpoch.current++;
      closeSettings(false); cancelDrag(); searchOpenRef.current = true; setSearchOpen(true); setReplacement(null);
    }
    function showSettings() {
      closeSearch(false); cancelDrag(); settingsOpenRef.current = true; setSettingsOpen(true);
    }
    // 父级以 sessionId 为 key 重挂载；异步完成后不可更新已卸载会话或重开浮层。
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    useLayoutEffect(() => {
      // 宿主切换模型或档位后同帧丢弃旧草稿，避免旧滑块闪现或跨模型提交。
      editing.current = false; previewRef.current = effortIndex; setPreview(effortIndex);
    }, [effortIndex, current && current.provider, current && current.model, levelSignature]);
    useLayoutEffect(() => {
      if (!open) return undefined;
      const doc = rootRef.current.ownerDocument;
      const win = doc.defaultView;
      let frame = null;
      const layout = () => {
        frame = null;
        const anchor = triggerRef.current.getBoundingClientRect();
        const next = { ...panelLayout({ width: win.innerWidth, height: win.innerHeight }, anchor),
          above: anchor.top >= Math.min(360, win.innerHeight * 0.55),
          viewportHeight: win.innerHeight, anchorTop: anchor.top, anchorBottom: anchor.bottom };
        primaryTopRef.current = null;
        setPosition((previous) => sameLayout(previous, next) ? previous : next);
      };
      const schedule = (event) => {
        // capture scroll 会收到 results/primary 自己的滚动，它们并不移动触发器。
        if (event && containsEvent(event, roots())) return;
        if (frame === null) frame = win.requestAnimationFrame(layout);
      };
      layout();
      const outside = (event) => {
        if (!containsEvent(event, roots())) closePanel(false);
      };
      const escape = (event) => {
        if (event.key !== 'Escape' || !containsEvent(event, roots())) return;
        event.preventDefault(); event.stopPropagation();
        if (dragRef.current) cancelDrag(); else if (searchOpenRef.current) closeSearch(true); else if (settingsOpenRef.current) closeSettings(true); else closePanel(true);
      };
      doc.addEventListener('pointerdown', outside, true);
      doc.addEventListener('keydown', escape, true);
      win.addEventListener('resize', schedule);
      win.addEventListener('scroll', schedule, true);
      return () => {
        doc.removeEventListener('pointerdown', outside, true);
        doc.removeEventListener('keydown', escape, true);
        win.removeEventListener('resize', schedule);
        win.removeEventListener('scroll', schedule, true);
        if (frame !== null) win.cancelAnimationFrame(frame);
      };
    }, [open]);
    useLayoutEffect(() => {
      if (!open) { setPrimaryHeight(null); primaryTopRef.current = null; return; }
      if (!position || !panelRef.current) return;
      const panel = panelRef.current, win = panel.ownerDocument.defaultView;
      const measure = () => {
        const height = panel.getBoundingClientRect().height;
        // 内容增长可展开，但保留初次 top，除非会越过窗口底部，避免每点星标都重新锚定。
        if (primaryTopRef.current === null) primaryTopRef.current = primaryGeometry(position, height).top;
        setPrimaryHeight(previous => previous === height ? previous : height);
      };
      measure();
      const observer = new win.ResizeObserver(measure);
      observer.observe(panel);
      return () => observer.disconnect();
    }, [open, position]);
    const primary = primaryGeometry(position, primaryHeight, primaryTopRef.current);
    const panelReady = !!position && primaryHeight !== null;
    const replaceFirst = useRef(null), replaceTrigger = useRef(null), previousSide = useRef('');
    useEffect(() => {
      // 等首次测量解除隐藏再交接焦点；普通内容增高不能再次抢走当前控件焦点。
      if (!open || !panelReady) { previousSide.current = ''; return; }
      const side = searchOpen ? 'search' : settingsOpen ? 'settings' : '';
      if (side === 'search') inputRef.current?.focus({ preventScroll: true });
      else if (side === 'settings') settingsRef.current?.focus({ preventScroll: true });
      else if (previousSide.current === 'search') searchButtonRef.current?.focus({ preventScroll: true });
      else if (previousSide.current === 'settings') settingsButtonRef.current?.focus({ preventScroll: true });
      else panelRef.current?.focus({ preventScroll: true });
      previousSide.current = side;
    }, [open, searchOpen, settingsOpen, panelReady]);
    useEffect(() => { if (replacement) replaceFirst.current?.focus({ preventScroll: true }); }, [replacement]);
    function leaveReplacement() {
      setReplacement(null);
      if (replaceTrigger.current?.isConnected) replaceTrigger.current.focus({ preventScroll: true });
    }

    async function run(action, success) {
      if (remoteBlocked(latest.current.locked, latest.current.pending, inFlight.current)) return;
      inFlight.current = true; setBusy(true); setLocalError('');
      try {
        const ok = await action();
        if (mounted.current) {
          if (ok === true) { if (success) success(); }
          else setLocalError(translate('operationFailed'));
        }
        return ok === true;
      } catch (_) {
        if (mounted.current) setLocalError(translate('operationFailed'));
        return false;
      } finally {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    }
    function select(model, fromSearch) {
      const requestEpoch = searchEpoch.current;
      run(() => onSelect(model), () => {
        // 只关闭发起选择的那一次搜索；等待期间关闭重开不应被旧完成回调打断。
        if (fromSearch && shouldCloseSearch(requestEpoch, searchEpoch.current, openRef.current, searchOpenRef.current)) closeSearch(true);
      });
    }
    const removedFavoriteFocus = useRef(null);
    useLayoutEffect(() => {
      const active = removedFavoriteFocus.current;
      if (!active) return;
      removedFavoriteFocus.current = null;
      // 只修复被取消收藏卸载的主层行，右侧星标及失败操作不抢焦点。
      if (!active.isConnected) searchButtonRef.current?.focus({ preventScroll: true });
    }, [favs]);
    function star(model, replacePair, origin) {
      // 收藏是本地设置，不与模型/团队远端 pending 或会话锁互锁。
      setLocalError('');
      if (!favoritePairs.some((f) => same(f, model)) && favoritePairs.length >= maxFavorites && !replacePair) {
        replaceTrigger.current = panelRef.current?.ownerDocument.activeElement;
        setReplacement(model); return;
      }
      if (origin && !origin.nested && favoritePairs.some((f) => same(f, model))) {
        const active = origin.row?.ownerDocument.activeElement;
        if (active && origin.row.contains(active)) removedFavoriteFocus.current = active;
      }
      try {
        const result = onStar(model, replacePair);
        if (result === false) removedFavoriteFocus.current = null;
        if (replacement && result !== false) leaveReplacement();
      }
      catch (_) { removedFavoriteFocus.current = null; setLocalError(translate('operationFailed')); }
    }
    function setDraft(value) {
      if (disabled) return;
      editing.current = true;
      previewRef.current = Number(value); setPreview(Number(value));
    }
    function cancelDraft() {
      editing.current = false; previewRef.current = effortIndex; setPreview(effortIndex);
    }
    function commitDraft() {
      if (!editing.current) return;
      const index = previewRef.current;
      editing.current = false;
      if (!validEffort || disabled || index === effortIndex) { cancelDraft(); return; }
      run(() => onEffort(index)).then((ok) => {
        if (mounted.current && !ok) {
          previewRef.current = latest.current.effortIndex; setPreview(latest.current.effortIndex);
        }
      });
    }
    function trapTab(event) {
      if (!openRef.current || event.key !== 'Tab') return;
      const scope = searchOpenRef.current ? searchRef.current : settingsOpenRef.current ? settingsRef.current : panelRef.current;
      if (!scope) return;
      const nodes = tabStops(Array.from(scope.querySelectorAll(focusable)).filter((el) => el.getClientRects().length));
      if (!nodes.length) { event.preventDefault(); scope.focus({ preventScroll: true }); return; }
      const first = nodes[0], last = nodes[nodes.length - 1], active = scope.ownerDocument.activeElement;
      if (event.shiftKey && (active === first || !nodes.includes(active))) { event.preventDefault(); last.focus({ preventScroll: true }); }
      else if (!event.shiftKey && (active === last || !nodes.includes(active))) { event.preventDefault(); first.focus({ preventScroll: true }); }
    }
    function row(model, nested) {
      const starred = favoritePairs.some((f) => same(f, model));
      const selected = current && current.provider === model.provider && current.model === model.id;
      return h('div', { className: 'dsh-qmp-row' + (selected ? ' is-current' : '') +
          (!nested && drag?.source === pairKey(model) ? ' is-dragging' : '') +
          (!nested && drag?.target === pairKey(model) && drag.source !== drag.target ? ' drop-' + drag.edge : ''),
          key: pairKey(model), 'data-favorite-key': nested ? undefined : pairKey(model) },
        !nested ? h('button', { type: 'button', className: 'dsh-qmp-drag',
          title: translate('reorderHint'), 'aria-label': translate('reorder') + ': ' + (model.name || model.id),
          'aria-describedby': uid + '-sort-help', onPointerDown: e => startDrag(e, model),
          onPointerMove: updateDrag, onPointerUp: finishDrag, onPointerCancel: cancelDrag, onLostPointerCapture: cancelDrag,
          onClick: e => { e.preventDefault(); e.stopPropagation(); }, onKeyDown: e => keyboardMove(e, model) },
          h('svg', { width: 14, height: 20, viewBox: '0 0 14 20', fill: 'currentColor', 'aria-hidden': true },
            ...[5, 10, 15].flatMap(y => [4, 10].map(x => h('circle', { key: x + '-' + y, cx: x, cy: y, r: 1.3 }))))) : null,
        h('button', { type: 'button', className: 'dsh-qmp-model', disabled: !!model.missing,
          'aria-disabled': disabled || !!model.missing,
          'aria-pressed': !!selected, onClick: () => { if (!disabled && !model.missing) select(model, nested); }, title: model.provider + ' / ' + model.id },
        h('span', { className: 'dsh-qmp-model-name' }, model.name || model.id),
        h('span', { className: 'dsh-qmp-provider' }, providerLabel(model),
          model.missing ? ' · ' + translate('unavailable') : ''),
        selected ? h('span', { className: 'dsh-qmp-check', 'aria-hidden': true }, '✓') : null),
        h('button', { type: 'button', className: 'dsh-qmp-star',
          'aria-label': translate(starred ? 'unstar' : 'star') + ': ' + (model.name || model.id),
          'aria-pressed': starred, title: translate(starred ? 'unstar' : 'star'),
          onClick: (event) => star(model, undefined, { nested, row: event.currentTarget.parentElement }) },
          h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', 'aria-hidden': true, focusable: false,
            fill: starred ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: 1.65, strokeLinejoin: 'round' },
            h('path', { d: 'm12 2.8 2.8 5.75 6.35.93-4.59 4.47 1.08 6.31L12 17.28l-5.64 2.98 1.08-6.31-4.59-4.47 6.35-.93Z' }))));
    }
    const failure = error || localError;
    function errorNotice() {
      // 错误只出现在当前操作的那一层。正常时不生成隐藏的重试按钮，也不占用面板底部。
      return !failure ? null : h('div', { className: 'dsh-qmp-error', role: 'alert' },
        h('span', { title: failure }, failure), h('button', { type: 'button', className: 'dsh-qmp-text-button',
          disabled: busy || pending, onClick: () => { setLocalError(''); reload(); } }, translate('reload')));
    }
    function overlay(node) {
      // 使用宿主可选 portal 避免被输入区 overflow 裁切，不引入另一份 React。
      return createPortal && rootRef.current ? createPortal(h('div', { ...isolation, className: 'dsh-qmp dsh-qmp-portal' }, node), rootRef.current.ownerDocument.body) : node;
    }
    // 焦点变化不等于离开浮层：宿主刷新/禁用控件也会 blur。只由外部指针、
    // Escape 和明确关闭按钮关闭；保留键盘 Tab trap 与 range 自身的 blur 提交。
    return h('div', { ...isolation, className: 'dsh-qmp', ref: rootRef, onKeyDown: trapTab },
      h('button', { type: 'button', className: 'dsh-qmp-trigger', ref: triggerRef,
        'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-controls': open ? panelId : undefined,
        title: trigger.text, 'aria-label': translate('title') + ': ' + trigger.text, onClick: () => {
          if (open) closePanel(true); else {
            openRef.current = true; setOpen(true);
            if (onOpen) onOpen();
          }
        } }, h('span', { className: 'dsh-qmp-trigger-label' }, trigger.model),
        trigger.effort ? h('span', { className: 'dsh-qmp-trigger-effort' }, '· ' + trigger.effort) : null,
        h('span', { className: 'dsh-qmp-trigger-chevron', 'aria-hidden': true }, open ? '▴' : '▾')),
      open ? overlay(h('section', { ...isolation, id: panelId, ref: panelRef,
        style: position ? { position: 'fixed', width: position.width, left: position.left, ...primary,
          visibility: primaryHeight === null ? 'hidden' : undefined } : { visibility: 'hidden' }, className: 'dsh-qmp-panel',
        role: 'dialog', 'aria-label': translate('title'), tabIndex: -1, 'aria-busy': !!(busy || pending || loading) },
        h('div', { className: 'dsh-qmp-primary' },
          h('header', { className: 'dsh-qmp-header' }, h('strong', null, translate('title')),
            h('span', { className: 'dsh-qmp-status' + (!locked && !loading && (busy || pending) ? ' is-saving' : ''), role: 'status' },
              locked ? translate('locked') : loading ? translate('loading') : (busy || pending) ? translate('saving') : ''),
            settingsNode ? h('button', { type: 'button', className: 'dsh-qmp-icon', ref: settingsButtonRef,
              'aria-label': t('host.settings'), title: t('host.settings'), 'aria-expanded': settingsOpen,
              'aria-controls': settingsOpen ? settingsId : undefined,
              onClick: () => settingsOpen ? closeSettings(true) : showSettings() },
              h('svg', { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
                strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
                h('path', { d: 'M9.8 3.2h4.4l.5 2.2c.6.2 1.1.5 1.6.9l2.1-.8 2.2 3.8-1.6 1.5c.1.8.1 1.6 0 2.4l1.6 1.5-2.2 3.8-2.1-.8c-.5.4-1 .7-1.6.9l-.5 2.2H9.8l-.5-2.2c-.6-.2-1.1-.5-1.6-.9l-2.1.8-2.2-3.8L5 13.2a9 9 0 0 1 0-2.4L3.4 9.3l2.2-3.8 2.1.8c.5-.4 1-.7 1.6-.9l.5-2.2Z' }),
                h('circle', { cx: 12, cy: 12, r: 2.7 }))) : null,
            h('button', { type: 'button', className: 'dsh-qmp-icon', 'aria-label': translate('close'), onClick: () => closePanel(true) }, '×')),
          !searchOpen && errorNotice(),
          h('div', { className: 'dsh-qmp-section-heading' }, h('span', null, translate('favorites')),
            h('span', { className: 'dsh-qmp-count' }, favoritePairs.length + '/' + maxFavorites),
            h('button', { type: 'button', className: 'dsh-qmp-text-button', ref: searchButtonRef,
              'aria-expanded': searchOpen, 'aria-controls': searchOpen ? searchId : undefined,
              onClick: () => searchOpen ? closeSearch(true) : showSearch() }, translate('allModels') + ' ›')),
          h('span', { id: uid + '-sort-help', className: 'dsh-qmp-sr-only' }, translate('reorderHint')),
          h('span', { className: 'dsh-qmp-sr-only', role: 'status' }, orderNotice),
          h('div', { className: 'dsh-qmp-favorites' }, favoriteModels.length ? favoriteModels.map((m) => row(m, false)) :
            h('p', { className: 'dsh-qmp-hint' }, translate('emptyFavorites'))),
          h('section', { className: 'dsh-qmp-effort', 'aria-labelledby': effortId },
            h('div', { className: 'dsh-qmp-section-heading' }, h('label', { id: effortId, htmlFor: effortId + '-range' }, translate('effort')),
              h('output', { htmlFor: effortId + '-range', className: 'dsh-qmp-effort-value' }, validEffort ? levels[safePreview].label : translate('noEffort'))),
            validEffort ? h(React.Fragment, null,
              h('input', { id: effortId + '-range', className: 'dsh-qmp-range', type: 'range', min: 0,
                max: levels.length - 1, step: 1, value: safePreview, disabled: levels.length < 2, 'aria-disabled': disabled || levels.length < 2,
                'aria-valuetext': levels[safePreview].label, onChange: (e) => setDraft(e.target.value),
                onPointerDown: (e) => { if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId); },
                onPointerUp: commitDraft, onPointerCancel: cancelDraft, onBlur: commitDraft,
                onKeyUp: (e) => { if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(e.key)) commitDraft(); } }),
              h('div', { className: 'dsh-qmp-range-labels', 'aria-hidden': true }, levels.map((level, index) =>
                h('span', { key: level.id, className: index === safePreview ? 'is-active' : '' }, level.label)))) : null),
          teamNode ? h('div', { className: 'dsh-qmp-team' }, teamNode) : null),
        settingsOpen && settingsNode ? h('section', { ...isolation, id: settingsId, ref: settingsRef, tabIndex: -1,
          style: position ? { position: 'fixed', top: primary.top,
            maxHeight: Math.max(1, position.viewportHeight - primary.top - 8),
            left: position.side === 'right' ? position.left + position.width + 8 : position.left,
            width: position.width } : { visibility: 'hidden' },
          className: 'dsh-qmp-settings-panel', role: 'dialog', 'aria-label': t('host.settings') },
          h('header', { className: 'dsh-qmp-header' }, h('strong', null, t('host.settings')),
            h('button', { type: 'button', className: 'dsh-qmp-icon', 'aria-label': translate('back'), onClick: () => closeSettings(true) }, '×')),
          settingsNode) : null,
        searchOpen ? h('section', { ...isolation, id: searchId, ref: searchRef, tabIndex: -1,
          style: position ? { position: 'fixed', top: position.top, height: position.height, maxHeight: position.height,
            left: position.side === 'right' ? position.left + position.width + 8 : position.left,
            width: position.width } : { visibility: 'hidden' },
          className: 'dsh-qmp-search dsh-qmp-search-' + (position?.side || 'inside'), role: 'dialog', 'aria-label': translate('allModels') },
          h('header', { className: 'dsh-qmp-header' }, h('strong', null, translate('allModels')),
            h('button', { type: 'button', className: 'dsh-qmp-icon', 'aria-label': translate('back'), onClick: () => closeSearch(true) }, '×')),
          h('div', { className: 'dsh-qmp-query-wrap' }, h('input', { ref: inputRef, type: 'search', className: 'dsh-qmp-query', value: query,
            placeholder: translate('search'), 'aria-label': translate('search'), onChange: (e) => setQuery(e.target.value) })),
          h('label', { className: 'dsh-qmp-channel-filter' }, h('span', null, translate('channel')),
            h('select', { value: channel, onChange: e => setChannel(e.target.value), 'aria-label': translate('channel') },
              h('option', { value: '' }, translate('allChannels') + ' (' + channels.length + ')'),
              channels.map(g => h('option', { key: g.id, value: g.id }, g.name + (g.name !== g.id ? ' · ' + g.id : '') + ' (' + g.models.length + ')')))),
          errorNotice(),
          replacement ? h('div', { className: 'dsh-qmp-replace', role: 'group', 'aria-label': translate('replaceFavorite') },
            h('p', null, translate('replaceFavorite') + ': ' + (replacement.name || replacement.id)),
            favoriteModels.map((m, i) => h('button', { type: 'button', className: 'dsh-qmp-replace-option', key: pairKey(m), ref: i === 0 ? replaceFirst : undefined,
              title: m.provider + ' / ' + m.id,
              onClick: () => star(replacement, { provider: m.provider, id: m.id }) }, translate('replace') + ' ' + (m.name || m.id) + ' · ' +
                providerLabel(m))),
            h('button', { type: 'button', className: 'dsh-qmp-text-button', onClick: leaveReplacement }, translate('cancel'))) : null,
          h('div', { className: 'dsh-qmp-results' }, groups.length ? groups.map(g => h('section', { className: 'dsh-qmp-channel', key: g.id, 'aria-label': g.name + ' · ' + g.id },
              h('header', { className: 'dsh-qmp-channel-heading' },
                h('span', { className: 'dsh-qmp-channel-badge', 'aria-hidden': true }, 'API'),
                h('div', { className: 'dsh-qmp-channel-name' }, h('strong', { title: g.name }, g.name),
                  g.name !== g.id ? h('span', { title: g.id }, g.id) : null),
                h('span', { className: 'dsh-qmp-channel-count', title: translate('modelCount') }, g.models.length)),
              g.models.map(m => row(m, true)))) : h('p', { className: 'dsh-qmp-hint' }, translate('noModels')))) : null)) : null);
  };
}

module.exports = { triggerSummary, providerLabel, shouldCloseSearch, groupChannels, favoriteDrop, createView, horizontalLayout, panelLayout, primaryGeometry, sameLayout, containsEvent, stopComposerEvent, remoteBlocked, tabStops };
