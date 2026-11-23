import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prerequisitesSatisfied } from '../../src/renderer/components/walkthrough.js';
import { sendBlockReason } from '../../src/renderer/components/composer.js';
import { computeBanners } from '../../src/renderer/components/banners.js';
import { _setDictionaries } from '../../src/renderer/lib/i18n.js';

_setDictionaries({}, {});

const health = (c, a) => ({
  claude: { found: true, loggedIn: c }, agy: { found: true, loggedIn: a }, git: { found: true }, vpn: { active: false }, anthropicReachable: true,
});

test('prerequisites are satisfied only when the chosen agent is signed in', () => {
  assert.equal(prerequisitesSatisfied({ claude: true, agy: false }, 'claude'), true);
  assert.equal(prerequisitesSatisfied({ claude: true, agy: false }, 'agy'), false);
  assert.equal(prerequisitesSatisfied({ claude: null, agy: null }, 'claude'), false);
  assert.equal(prerequisitesSatisfied(undefined, 'claude'), false);
});

test('composer is blocked (with a sign-in action) when the active agent is signed out', () => {
  const claude = { agent: 'claude' };
  const agy = { agent: 'agy' };
  assert.deepEqual(sendBlockReason(claude, health(true, true), { claude: false, agy: true }), { key: 'composer.disabledLogin', signIn: true });
  assert.deepEqual(sendBlockReason(agy, health(true, true), { claude: true, agy: false }), { key: 'composer.disabledLoginAgy', signIn: true });
  assert.equal(sendBlockReason(agy, health(true, true), { claude: false, agy: true }), null);
  // store flag wins over a stale health snapshot, health is the fallback
  assert.equal(sendBlockReason(claude, health(false, true), { claude: true, agy: true }), null);
  assert.equal(sendBlockReason(claude, health(false, true), { claude: null, agy: null }).signIn, true);
  assert.equal(sendBlockReason(agy, health(true, null), { claude: true, agy: null }), null);
});

test('banners: signed-out banner for the active agent only', () => {
  const ids = (p, h, s) => computeBanners(p, h, null, s).map((b) => b.id);
  assert.ok(ids({ agent: 'claude', mode: 'plan' }, health(true, true), { claude: false, agy: true }).includes('claude-login'));
  assert.ok(ids({ agent: 'agy', mode: 'plan' }, health(true, true), { claude: true, agy: false }).includes('agy-login'));
  assert.ok(!ids({ agent: 'agy', mode: 'plan' }, health(false, true), { claude: false, agy: true }).includes('claude-login'));
  const b = computeBanners({ agent: 'agy', mode: 'plan' }, health(true, true), null, { claude: true, agy: false }).find((x) => x.id === 'agy-login');
  assert.deepEqual(b.actions, ['signin', 'recheck']);
});

test('VPN banner can be dismissed (and comes back when reachability changes)', async () => {
  const { computeBanners } = await import('../../src/renderer/components/banners.js');
  const hl = (reachable) => ({ vpn: { active: true, adapters: ['TAP'] }, anthropicReachable: reachable, claude: { found: true, loggedIn: true }, agy: { found: true, loggedIn: true } });
  const down = computeBanners({ agent: 'claude', mode: 'default' }, hl(false), null, { claude: true, agy: true }).find((b) => b.id.startsWith('vpn'));
  assert.ok(down.actions.includes('dismiss') && down.actions.includes('recheck'));
  const up = computeBanners({ agent: 'claude', mode: 'default' }, hl(true), null, { claude: true, agy: true }).find((b) => b.id.startsWith('vpn'));
  assert.notEqual(down.id, up.id); // a changed state shows the banner again even after a dismiss
});
