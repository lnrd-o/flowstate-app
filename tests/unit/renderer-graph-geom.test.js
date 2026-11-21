import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NODE_W, NODE_H, edgeGeometry, pathBetween, boundsOf, fitTransform, zoomAt, screenToGraph, truncate, hitNode, clampScale,
} from '../../src/renderer/lib/graph-geom.js';

test('edgeGeometry starts at the right port and ends at the left port', () => {
  const g = edgeGeometry({ x: 0, y: 0 }, { x: 300, y: 100 });
  assert.deepEqual(g.start, { x: NODE_W, y: NODE_H / 2 });
  assert.deepEqual(g.end, { x: 300, y: 100 + NODE_H / 2 });
  assert.match(g.d, /^M[\d. -]+ C[\d. -]+$/);
  assert.ok(g.mid.x > g.start.x && g.mid.x < g.end.x);
});

test('pathBetween midpoint is the bezier t=0.5 point', () => {
  const g = pathBetween({ x: 0, y: 0 }, { x: 200, y: 0 });
  assert.equal(g.mid.x, 100);
  assert.equal(g.mid.y, 0);
});

test('backward edges still produce a finite path', () => {
  const g = edgeGeometry({ x: 500, y: 0 }, { x: 0, y: 0 });
  assert.ok(/NaN|undefined/.test(g.d) === false);
});

test('boundsOf includes node size and handles empty', () => {
  assert.equal(boundsOf({}), null);
  assert.deepEqual(boundsOf({ a: { x: 0, y: 0 }, b: { x: 100, y: 50 } }), { minX: 0, minY: 0, maxX: 100 + NODE_W, maxY: 50 + NODE_H });
});

test('fitTransform fits and centers, never zooms past max', () => {
  const b = { minX: 0, minY: 0, maxX: 1000, maxY: 400 };
  const tr = fitTransform(b, { w: 500, h: 400 }, { padding: 0 });
  assert.equal(tr.k, 0.5);
  assert.equal(tr.x, 0);
  assert.equal(tr.y, 100);
  const wide = fitTransform({ minX: 0, minY: 0, maxX: 4000, maxY: 100 }, { w: 800, h: 400 }, { padding: 20, min: 0.5 });
  assert.equal(wide.k, 0.5);
  assert.equal(wide.x, 20, 'overflowing content is left-aligned');
  const small = fitTransform({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, { w: 2000, h: 2000 });
  assert.equal(small.k, 1.1);
  assert.deepEqual(fitTransform(null, { w: 10, h: 10 }), { x: 32, y: 32, k: 1 });
});

test('zoomAt keeps the anchor fixed and clamps', () => {
  const tr = { x: 10, y: 20, k: 1 };
  const z = zoomAt(tr, 2, { x: 110, y: 120 });
  assert.equal(z.k, 2);
  const before = screenToGraph(tr, { x: 110, y: 120 });
  const after = screenToGraph(z, { x: 110, y: 120 });
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
  assert.equal(zoomAt(tr, 100, { x: 0, y: 0 }).k, 2);
  assert.equal(clampScale(0.01), 0.25);
});

test('truncate and hitNode', () => {
  assert.equal(truncate('short', 10), 'short');
  assert.equal(truncate('a long title here', 8), 'a long\u2026');
  assert.equal(truncate('  multi\n line ', 20), 'multi line');
  const pos = { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } };
  assert.equal(hitNode(pos, { x: 120, y: 10 }), 'b');
  assert.equal(hitNode(pos, { x: 5000, y: 10 }), null);
});
