import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STEPS, stepsFor, folderName } from '../../src/renderer/components/walkthrough.js';

test('walkthrough has a Starting point step after agent and before git', () => {
  assert.deepEqual(STEPS, ['welcome', 'prerequisites', 'folder', 'agent', 'start', 'git', 'done']);
  assert.deepEqual(stepsFor(''), STEPS);
});

test('choosing a methodology inserts the variables step after start', () => {
  const s = stepsFor('data-dashboard');
  assert.equal(s[s.indexOf('start') + 1], 'variables');
  assert.equal(s.indexOf('variables') < s.indexOf('git'), true);
  assert.equal(s.length, STEPS.length + 1);
});

test('folderName handles windows and posix paths', () => {
  assert.equal(folderName('C:\\Users\\x\\My Project\\'), 'My Project');
  assert.equal(folderName('/home/x/proj'), 'proj');
});
