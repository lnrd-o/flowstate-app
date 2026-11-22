import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph, groupByDay } from '../../src/renderer/lib/version-graph.js';

test('linear history uses one lane', () => {
  const rows = layoutGraph([{ sha: 'c', parents: ['b'] }, { sha: 'b', parents: ['a'] }, { sha: 'a', parents: [] }]);
  assert.deepEqual(rows.map((r) => r.col), [0, 0, 0]);
  assert.deepEqual(rows[0].outgoing, [0]);
  assert.deepEqual(rows[2].outgoing, []);
  assert.ok(rows.every((r) => r.cols === 1));
});

test('branch + merge opens a second lane and closes it', () => {
  // m merges x (side branch) into b; a is the root
  const rows = layoutGraph([
    { sha: 'm', parents: ['b', 'x'] }, { sha: 'x', parents: ['a'] }, { sha: 'b', parents: ['a'] }, { sha: 'a', parents: [] },
  ]);
  assert.deepEqual(rows[0].outgoing, [0, 1]);
  assert.equal(rows[1].col, 1);
  assert.deepEqual(rows[1].through, [0]);
  assert.equal(rows[2].col, 0);
  assert.deepEqual(rows[2].through, [1]);
  assert.deepEqual(rows[2].outgoing, [1]); // b joins the side lane towards the root
  assert.deepEqual(rows[3].incoming, [1]);
  assert.equal(rows[3].col, 1);
});

test('groupByDay keeps order and splits days', () => {
  const d1 = new Date(2025, 0, 2, 10).getTime(); const d2 = new Date(2025, 0, 2, 8).getTime(); const d3 = new Date(2025, 0, 1, 23).getTime();
  const g = groupByDay([{ time: d1 }, { time: d2 }, { time: d3 }]);
  assert.deepEqual(g.map((x) => x.items.length), [2, 1]);
  assert.deepEqual(g[1].items[0].index, 2);
});
