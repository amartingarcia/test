import { test } from 'node:test';
import assert from 'node:assert/strict';

import { layoutLanes } from '../viewer/lanes-layout.mjs';

const config = (over = {}) => ({
  sizeOf: () => ({ w: 100, h: 40 }),
  axisOf: () => 'column',
  orderOf: () => 0,
  gap: 20,
  pad: 10,
  padTop: 30,
  ...over,
});

test('roots are laid out left to right in order, centered vertically on the tallest', () => {
  const nodes = [
    { id: 'b', parent: null, kind: 'x' },
    { id: 'a', parent: null, kind: 'x' },
  ];
  const { boxes } = layoutLanes(nodes, config({ orderOf: (n) => (n.id === 'a' ? 0 : 1) }));
  assert.deepEqual(boxes.a, { x: 0, y: 0, w: 100, h: 40 });
  assert.deepEqual(boxes.b, { x: 120, y: 0, w: 100, h: 40 });
});

test('equal order falls back to id, so the layout is deterministic', () => {
  const nodes = [{ id: 'z', parent: null, kind: 'x' }, { id: 'a', parent: null, kind: 'x' }];
  const { boxes } = layoutLanes(nodes, config());
  assert.ok(boxes.a.x < boxes.z.x);
});

test('a container encloses its children with padding and a taller top for its label', () => {
  const nodes = [
    { id: 'c', parent: null, kind: 'box' },
    { id: 'k1', parent: 'c', kind: 'x' },
    { id: 'k2', parent: 'c', kind: 'x' },
  ];
  const { boxes } = layoutLanes(nodes, config()); // column axis
  // children stacked: 40 + 20 + 40 = 100 high; +30 top +10 bottom = 140; width 100 + 2*10
  assert.deepEqual(boxes.c, { x: 0, y: 0, w: 120, h: 140 });
  assert.deepEqual(boxes.k1, { x: 10, y: 30, w: 100, h: 40 });
  assert.deepEqual(boxes.k2, { x: 10, y: 90, w: 100, h: 40 });
});

test('axisOf(kind) = row lays a container out left to right', () => {
  const nodes = [
    { id: 'c', parent: null, kind: 'row-box' },
    { id: 'k1', parent: 'c', kind: 'x' },
    { id: 'k2', parent: 'c', kind: 'x' },
  ];
  const { boxes } = layoutLanes(nodes, config({ axisOf: (k) => (k === 'row-box' ? 'row' : 'column') }));
  assert.equal(boxes.k2.x - boxes.k1.x, 120);
  assert.equal(boxes.k1.y, boxes.k2.y);
  assert.deepEqual([boxes.c.w, boxes.c.h], [100 + 20 + 100 + 20, 40 + 30 + 10]);
});

test('nested containers grow to fit, and smaller siblings are centered on the cross axis', () => {
  const nodes = [
    { id: 'vpc', parent: null, kind: 'row-box' },
    { id: 'big', parent: 'vpc', kind: 'col-box' },
    { id: 'b1', parent: 'big', kind: 'x' },
    { id: 'b2', parent: 'big', kind: 'x' },
    { id: 'small', parent: 'vpc', kind: 'x' },
  ];
  const { boxes } = layoutLanes(nodes, config({
    axisOf: (k) => (k === 'row-box' ? 'row' : 'column'),
    orderOf: (n) => (n.id === 'big' ? 0 : 1),
  }));
  const bigCenterY = boxes.big.y + boxes.big.h / 2;
  const smallCenterY = boxes.small.y + boxes.small.h / 2;
  assert.equal(bigCenterY, smallCenterY);
  assert.ok(boxes.vpc.w >= boxes.big.w + boxes.small.w);
  // children are inside their parents
  for (const [child, parent] of [['big', 'vpc'], ['small', 'vpc'], ['b1', 'big'], ['b2', 'big']]) {
    assert.ok(boxes[child].x >= boxes[parent].x && boxes[child].y >= boxes[parent].y, `${child} inside ${parent}`);
    assert.ok(boxes[child].x + boxes[child].w <= boxes[parent].x + boxes[parent].w, `${child} right edge`);
    assert.ok(boxes[child].y + boxes[child].h <= boxes[parent].y + boxes[parent].h, `${child} bottom edge`);
  }
});

test('a node whose parent is not in the list is treated as a root', () => {
  const { boxes } = layoutLanes([{ id: 'a', parent: 'ghost', kind: 'x' }], config());
  assert.deepEqual(boxes.a, { x: 0, y: 0, w: 100, h: 40 });
});

test('returns the center of every box, for use as Cytoscape positions', () => {
  const { centers } = layoutLanes([{ id: 'a', parent: null, kind: 'x' }], config());
  assert.deepEqual(centers.a, { x: 50, y: 20 });
});

test('wrap: crowded containers wrap onto several lines, off by default', () => {
  const nodes = [{ id: 'p', parent: null, kind: 'box' }, ...Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, parent: 'p', kind: 'leaf' }))];
  const cfg = { sizeOf: () => ({ w: 100, h: 50 }), axisOf: () => 'row', orderOf: () => 0, gap: 10, pad: 10, padTop: 20 };
  const flat = layoutLanes(nodes, cfg).boxes;
  assert.equal(flat.p.h, 50 + 20 + 10); // single line
  const wrapped = layoutLanes(nodes, { ...cfg, wrap: { min: 5, aspect: 1.6 } }).boxes;
  assert.ok(wrapped.p.h > flat.p.h, 'taller after wrapping');
  assert.ok(wrapped.p.w < flat.p.w, 'narrower after wrapping');
  // children stay inside the container and keep their order (reading order)
  for (let i = 0; i < 8; i++) {
    const c = wrapped[`c${i}`];
    assert.ok(c.x >= wrapped.p.x && c.x + c.w <= wrapped.p.x + wrapped.p.w);
    assert.ok(c.y >= wrapped.p.y && c.y + c.h <= wrapped.p.y + wrapped.p.h);
  }
  assert.ok(wrapped.c4.y > wrapped.c0.y || wrapped.c4.x > wrapped.c0.x);
});

test('wrap does not trigger below the minimum child count', () => {
  const nodes = [{ id: 'p', parent: null, kind: 'box' }, ...Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, parent: 'p', kind: 'leaf' }))];
  const cfg = { sizeOf: () => ({ w: 100, h: 50 }), axisOf: () => 'row', orderOf: () => 0, gap: 10, pad: 10, padTop: 20 };
  assert.deepEqual(layoutLanes(nodes, { ...cfg, wrap: { min: 5, aspect: 1.6 } }).boxes, layoutLanes(nodes, cfg).boxes);
});

test('rootWrap folds a long row of top-level boxes into lines (off by default)', () => {
  const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, parent: null, kind: 'x' }));
  const base = { sizeOf: () => ({ w: 100, h: 60 }), axisOf: () => 'column', orderOf: () => 0, gap: 20, pad: 10, padTop: 20 };
  const width = (cfg) => { const { boxes } = layoutLanes(nodes, cfg); return Math.max(...Object.values(boxes).map((b) => b.x + b.w)); };
  const flat = layoutLanes(nodes, base).boxes;
  assert.equal(new Set(Object.values(flat).map((b) => b.y)).size, 1, 'one line by default');
  const wrapped = layoutLanes(nodes, { ...base, rootWrap: { min: 4, aspect: 1.6 } }).boxes;
  assert.ok(new Set(Object.values(wrapped).map((b) => b.y)).size > 1, 'several lines');
  assert.ok(width({ ...base, rootWrap: { min: 4, aspect: 1.6 } }) < width(base));
});
