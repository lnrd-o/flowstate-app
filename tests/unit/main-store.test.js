import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSettings, defaultSettings } from '../../src/main/settings.js';
import { createProjects } from '../../src/main/projects.js';
import { CH } from '../../src/shared/ipc.js';
import { isAllowedExternal } from '../../src/main/security.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fs-test-'));

test('settings defaults and locale', () => {
  assert.equal(defaultSettings('es-AR').language, 'es');
  assert.equal(defaultSettings('en-US').language, 'en');
  const d = tmp();
  const s = createSettings({ dir: d, locale: 'es-ES' });
  assert.deepEqual(s.get(), {
    language: 'es', languageAuto: true, theme: 'dark', codeTheme: 'github-dark', claudePath: null, agyPath: null, opencodePath: null,
    lastProjectId: null, autoLaunch: false, walkthroughDone: false, developerMode: true, notifications: true, acceptedModels: [], acceptAllPayg: false, autoUpdate: true, deepseekEnabled: false,
    agentsEnabled: { claude: true, agy: true, opencode: true, deepseek: false },
  });
});

test('settings set persists atomically and validates', () => {
  const d = tmp();
  const s = createSettings({ dir: d });
  s.set({ theme: 'light', autoLaunch: true });
  assert.equal(createSettings({ dir: d }).get().theme, 'light');
  assert.ok(!fs.readdirSync(d).some((f) => f.endsWith('.tmp')));
  assert.throws(() => s.set({ theme: 'neon' }));
  assert.throws(() => s.set({ bogus: 1 }));
  assert.throws(() => s.set({ claudePath: 'relative\\claude.exe' }));
});

test('projects registry: add/update/remove, real path, never deletes files', () => {
  const d = tmp();
  const target = path.join(d, 'newproj', 'sub');
  const p = createProjects({ dir: d });
  const a = p.add({ path: target, agent: 'agy', mode: 'plan' });
  assert.ok(fs.existsSync(target));
  assert.equal(a.path, fs.realpathSync.native(target));
  assert.equal(a.name, 'sub');
  assert.equal(a.sessionId, null);
  assert.match(a.id, /^[0-9a-f-]{36}$/);
  assert.equal(p.add({ path: target }).id, a.id); // dedupe
  const u = p.update(a.id, { sessionId: 'abc', autoCommit: true, path: 'C:\\evil' });
  assert.equal(u.sessionId, 'abc');
  assert.equal(u.path, a.path); // path not patchable
  assert.throws(() => p.update(a.id, { mode: 'nope' }));
  assert.throws(() => p.add({ path: 'relative/dir' }));
  assert.equal(createProjects({ dir: d }).list().length, 1); // persisted
  p.remove(a.id);
  assert.equal(p.list().length, 0);
  assert.ok(fs.existsSync(target));
});

test('preload channels mirror shared CH', () => {
  const src = fs.readFileSync(new URL('../../src/main/preload.cjs', import.meta.url), 'utf8');
  for (const v of Object.values(CH)) assert.ok(src.includes(`'${v}'`), v);
});

test('external URL allow-list', () => {
  assert.ok(isAllowedExternal('https://docs.anthropic.com/x'));
  assert.ok(!isAllowedExternal('http://github.com'));
  assert.ok(!isAllowedExternal('https://evilgithub.com'));
  assert.ok(!isAllowedExternal('file:///c:/x'));
  assert.ok(!isAllowedExternal('javascript:alert(1)'));
});

test('language follows the system by default; an explicit choice turns automatic off; existing files keep their language', () => {
  const d = tmp();
  const s = createSettings({ dir: d, locale: 'es-MX' });
  assert.deepEqual([s.get().language, s.get().languageAuto], ['es', true]);
  assert.equal(s.set({ language: 'es' }).languageAuto, true); // same language: still automatic (setup wizard confirms the detected one)
  const en = s.set({ language: 'en' });
  assert.deepEqual([en.language, en.languageAuto], ['en', false]);
  // next start on an English system: the explicit choice stays
  assert.equal(createSettings({ dir: d, locale: 'en-US' }).get().language, 'en');
  const back = createSettings({ dir: d, locale: 'es-ES' }).set({ languageAuto: true });
  assert.deepEqual([back.language, back.languageAuto], ['es', true]);
  // an old settings.json (no languageAuto) keeps the language the user already had
  const d2 = tmp();
  fs.writeFileSync(path.join(d2, 'settings.json'), JSON.stringify({ language: 'en' }));
  const old = createSettings({ dir: d2, locale: 'es-ES' }).get();
  assert.deepEqual([old.language, old.languageAuto], ['en', false]);
  // automatic re-detects at every start
  const d3 = tmp();
  createSettings({ dir: d3, locale: 'en-US' }).set({ theme: 'light' });
  assert.equal(createSettings({ dir: d3, locale: 'es-ES' }).get().language, 'es');
});
