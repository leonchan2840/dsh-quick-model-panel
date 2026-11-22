'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { panelLayout, primaryGeometry, sameLayout, containsEvent, stopComposerEvent, remoteBlocked } = require('../src/view.cjs');

// 只测生产中实际调用的几何/事件辅助函数，不伪造 React hooks、DOM 或页面。
test('bottom anchor uses a stable top budget, never content-dependent bottom', () => {
  const viewport = { width: 1200, height: 900 };
  const anchor = { left: 800, top: 800, bottom: 830 };
  const result = panelLayout(viewport, anchor);
  assert.deepEqual(result, { width: 340, left: 504, side: 'right', top: 232, height: 560 });
  assert.equal('bottom' in result, false);
  // 收藏数量、loading 和展开层数不是几何输入；同一触发器不移动。
  for (const favorites of [[], ['a'], ['a', 'b', 'c', 'd', 'e']]) {
    assert.deepEqual(panelLayout(viewport, { ...anchor, favorites, pending: true }), result);
  }
});
test('primary follows natural content height independently of the secondary 560px budget', () => {
  const search = { ...panelLayout({ width: 1200, height: 900 }, { left: 800, top: 800, bottom: 830 }),
    above: true, viewportHeight: 900, anchorTop: 800, anchorBottom: 830 };
  assert.deepEqual(primaryGeometry(search, 250), { top: 542, maxHeight: 884 });
  // 七个收藏加完整设置区即使超过560px，也不再被旧目录预算或首次测量截断。
  assert.deepEqual(primaryGeometry(search, 650), { top: 142, maxHeight: 884 });
  assert.equal(search.top, 232);
  assert.equal(search.height, 560);
  assert.deepEqual(primaryGeometry({ ...search, height: 200, top: 592 }, 650), { top: 142, maxHeight: 884 });
  assert.deepEqual(primaryGeometry(null, null), {});
});
test('content can grow after opening, keeping its top until the viewport edge requires adjustment', () => {
  const position = { above: true, viewportHeight: 900, anchorTop: 800, anchorBottom: 830 };
  assert.deepEqual(primaryGeometry(position, 300, 400), { top: 400, maxHeight: 884 });
  assert.deepEqual(primaryGeometry(position, 650, 400), { top: 242, maxHeight: 884 });
  assert.deepEqual(primaryGeometry({ ...position, viewportHeight: 600 }, 700, 400), { top: 8, maxHeight: 584 });
});
test('top anchors and very short windows preserve the physical viewport boundary', () => {
  const position = { above: false, viewportHeight: 600, anchorTop: 20, anchorBottom: 50 };
  assert.deepEqual(primaryGeometry(position, 400), { top: 58, maxHeight: 584 });
  assert.deepEqual(primaryGeometry(position, 650), { top: 8, maxHeight: 584 });
  assert.deepEqual(primaryGeometry({ ...position, viewportHeight: 300 }, 650), { top: 8, maxHeight: 284 });
});
test('top anchor remains below trigger with a viewport-limited search height', () => {
  assert.deepEqual(panelLayout({ width: 900, height: 600 }, { left: 40, top: 20, bottom: 50 }),
    { width: 340, left: 40, side: 'right', top: 58, height: 534 });
});
test('desktop boundary and narrow inside panel stay on-screen', () => {
  const a = { left: 500, top: 400, bottom: 430 };
  const desktop = panelLayout({ width: 704, height: 700 }, a);
  assert.equal(desktop.side, 'right');
  assert.equal(desktop.left + desktop.width * 2 + 8, 696);
  const narrow = panelLayout({ width: 320, height: 600 }, a);
  assert.equal(narrow.side, 'inside');
  assert.equal(narrow.width, 304);
  assert.equal(narrow.left, 8);
  assert.ok(narrow.top >= 8 && narrow.top + narrow.height <= 592);
});
test('unchanged measurements can preserve React state identity', () => {
  const previous = panelLayout({ width: 1200, height: 900 }, { left: 800, top: 800, bottom: 830 });
  assert.equal(sameLayout(previous, { ...previous }), true);
  assert.equal(sameLayout(previous, { ...previous, top: previous.top - 1 }), false);
  assert.equal(sameLayout(previous, { ...previous, height: 300 }), false);
  assert.equal(sameLayout(null, previous), false);
});

test('native composedPath recognizes either independent portal layer', () => {
  const trigger = new EventTarget(), primary = new EventTarget(), secondary = new EventTarget();
  const roots = [trigger, primary, secondary];
  for (const target of roots) {
    target.addEventListener('pointerdown', event => {
      assert.equal(containsEvent(event, roots), true);
      // React SyntheticEvent 包装仍读取实际 nativeEvent.composedPath。
      assert.equal(containsEvent({ nativeEvent: event, target: event.target }, roots), true);
    });
    target.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
  }
  const outside = new EventTarget();
  outside.addEventListener('pointerdown', event => assert.equal(containsEvent(event, roots), false));
  outside.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
});
test('null refs and detached event have no inside hit', () => {
  assert.equal(containsEvent(new Event('pointerdown'), [null, null, null]), false);
});
test('pointer/mouse/click isolation stops native bubbling without cancelling focus defaults', () => {
  for (const type of ['pointerdown', 'mousedown', 'click']) {
    const target = new EventTarget();
    let received = 0;
    target.addEventListener(type, event => {
      stopComposerEvent(event);
      received++;
      assert.equal(event.cancelBubble, true);
      assert.equal(event.defaultPrevented, false);
    });
    const event = new Event(type, { bubbles: true, cancelable: true });
    assert.equal(target.dispatchEvent(event), true);
    assert.equal(received, 1);
  }
});
test('native same-target handlers are preserved, unlike stopImmediatePropagation', () => {
  const target = new EventTarget();
  let delivered = 0;
  target.addEventListener('click', stopComposerEvent);
  target.addEventListener('click', () => delivered++);
  target.dispatchEvent(new Event('click', { bubbles: true }));
  assert.equal(delivered, 1);
});
test('remote operation gating separates actual lock, host pending and local in-flight', () => {
  assert.equal(remoteBlocked(false, false, false), false);
  for (const flags of [[true, false, false], [false, true, false], [false, false, true]]) {
    assert.equal(remoteBlocked(...flags), true);
  }
  assert.equal(remoteBlocked(undefined, undefined, false), false);
});
