import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cssColorToHex, cssColorToHexOr } from '../../src/renderer/lib/colors.js';
import { computeInsets, needsOwnControls, normalizePlatform, statusChips } from '../../src/renderer/lib/titlebar-state.js';

test('css colours convert to #rrggbb', () => {
  assert.equal(cssColorToHex('#1b1b1f'), '#1b1b1f');
  assert.equal(cssColorToHex('#FFF'), '#ffffff');
  assert.equal(cssColorToHex('#abcd'), '#aabbcc');
  assert.equal(cssColorToHex('#11223344'), '#112233');
  assert.equal(cssColorToHex('rgb(27, 27, 31)'), '#1b1b1f');
  assert.equal(cssColorToHex('rgb(27 27 31 / 0.5)'), '#1b1b1f');
  assert.equal(cssColorToHex('rgba(255,0,128,0.2)'), '#ff0080');
  assert.equal(cssColorToHex('rgb(100%, 0%, 50%)'), '#ff0080');
  assert.equal(cssColorToHex('rgb(300, -4, 1.4)'), '#ff0001');
  assert.equal(cssColorToHex('  RGB(1,2,3) '), '#010203');
});

test('unparseable colours give null / the fallback', () => {
  assert.equal(cssColorToHex(''), null);
  assert.equal(cssColorToHex(null), null);
  assert.equal(cssColorToHex('red'), null);
  assert.equal(cssColorToHex('#12'), null);
  assert.equal(cssColorToHex('rgb(1,2)'), null);
  assert.equal(cssColorToHexOr('nope', '#000000'), '#000000');
  assert.equal(cssColorToHexOr('#fff', '#000000'), '#ffffff');
});

test('insets per platform', () => {
  const ci = { left: 80, right: 140 };
  assert.deepEqual(computeInsets({ platform: 'win32', overlay: true, fullscreen: false, controlsInset: ci }), { left: 0, right: 140 });
  assert.deepEqual(computeInsets({ platform: 'linux', overlay: true, fullscreen: false, controlsInset: { left: 0, right: 120 } }), { left: 0, right: 120 });
  assert.deepEqual(computeInsets({ platform: 'darwin', overlay: false, fullscreen: false, controlsInset: ci }), { left: 80, right: 0 });
  assert.deepEqual(computeInsets({ platform: 'win32', overlay: false, fullscreen: false, controlsInset: ci }), { left: 0, right: 0 });
});

test('insets: fullscreen hides the reserved space; missing data falls back to defaults', () => {
  assert.deepEqual(computeInsets({ platform: 'win32', overlay: true, fullscreen: true, controlsInset: { right: 140 } }), { left: 0, right: 0 });
  assert.deepEqual(computeInsets({ platform: 'darwin', fullscreen: true }), { left: 0, right: 0 });
  assert.deepEqual(computeInsets({ platform: 'win32', overlay: true }), { left: 0, right: 140 });
  assert.deepEqual(computeInsets({ platform: 'darwin' }), { left: 80, right: 0 });
  assert.deepEqual(computeInsets({ platform: 'win32', overlay: true, controlsInset: { right: -5 } }), { left: 0, right: 140 });
  assert.deepEqual(computeInsets(undefined), { left: 0, right: 140 });
});

test('own window buttons only without a native overlay', () => {
  assert.equal(needsOwnControls({ platform: 'win32', overlay: false, fullscreen: false }), true);
  assert.equal(needsOwnControls({ platform: 'win32', overlay: true, fullscreen: false }), false);
  assert.equal(needsOwnControls({ platform: 'darwin', overlay: false, fullscreen: false }), false);
  assert.equal(needsOwnControls({ platform: 'linux', overlay: false, fullscreen: true }), false);
});

test('platform normalisation', () => {
  assert.equal(normalizePlatform('darwin'), 'darwin');
  assert.equal(normalizePlatform('linux'), 'linux');
  assert.equal(normalizePlatform('freebsd'), 'win32');
  assert.equal(normalizePlatform(undefined), 'win32');
});

test('status chips', () => {
  const health = { vpn: { active: false }, anthropicReachable: true };
  assert.deepEqual(statusChips({ health, remote: null, signedIn: { claude: true, agy: true }, project: { agent: 'claude' } }).map((c) => c.id), ['conn']);
  const all = statusChips({ health: { vpn: { active: true }, anthropicReachable: true }, remote: { running: true }, signedIn: { claude: false, agy: null }, project: { agent: 'claude' } });
  assert.deepEqual(all.map((c) => c.id), ['vpn', 'remote', 'conn', 'signin']);
  assert.equal(all.find((c) => c.id === 'conn').tone, 'red');
  assert.equal(all.find((c) => c.id === 'signin').vars.agent, 'claude');
  assert.deepEqual(statusChips({ health: null, remote: null, signedIn: {}, project: null }), []);
});
