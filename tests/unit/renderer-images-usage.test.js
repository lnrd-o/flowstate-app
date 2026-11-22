import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { _setDictionaries, setLanguage, t } from '../../src/renderer/lib/i18n.js';
import {
  validateImage, validateBatch, suggestionChips, parseDataUrl, base64Bytes, extFromMime, pastedName, sizeText, createThumbCache,
  MAX_IMAGE_BYTES, MAX_IMAGES,
} from '../../src/renderer/lib/images.js';
import {
  percent, windowTone, durationText, countdownText, resetClock, resetLine, worstWindow, chipModel, isLimitActive, limitCardModel,
  limitBanner, otherAgent, compactNumber, costText, windowLabel,
} from '../../src/renderer/lib/usage.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/renderer/i18n');
const load = (n) => JSON.parse(readFileSync(path.join(dir, n + '.json'), 'utf8'));
before(() => _setDictionaries(load('en'), load('es')));

test('validateImage: type, size, empty and count', () => {
  assert.deepEqual(validateImage({ type: 'image/png', size: 1000, name: 'a.png' }, 0), { ok: true });
  assert.equal(validateImage({ type: 'application/pdf', size: 10, name: 'a.pdf' }, 0).key, 'images.err.type');
  assert.equal(validateImage({ type: 'image/svg+xml', size: 10, name: 'a.svg' }, 0).key, 'images.err.type');
  assert.equal(validateImage({ type: 'image/png', size: MAX_IMAGE_BYTES + 1, name: 'big.png' }, 0).key, 'images.err.size');
  assert.equal(validateImage({ type: 'image/png', size: MAX_IMAGE_BYTES, name: 'ok.png' }, 0).ok, true);
  assert.equal(validateImage({ type: 'image/webp', size: 0, name: 'e.webp' }, 0).key, 'images.err.empty');
  assert.equal(validateImage({ type: 'image/gif', size: 5, name: 'g.gif' }, MAX_IMAGES).key, 'images.err.count');
  assert.equal(validateImage(null, 0).ok, false);
});

test('validateBatch keeps the first images up to the limit and reports the rest', () => {
  const f = (n, type = 'image/png', size = 100) => ({ name: n, type, size });
  const r = validateBatch([f('1'), f('2'), f('x', 'text/plain'), f('3'), f('4')], 3);
  assert.deepEqual(r.accepted.map((x) => x.name), ['1', '2']);
  assert.deepEqual(r.errors.map((e) => e.key), ['images.err.type', 'images.err.count', 'images.err.count']);
});

test('suggestion chips follow the language and the context', async () => {
  const en = suggestionChips({ imageCount: 1 }, t);
  assert.equal(en.length, 5);
  assert.equal(en[0].text, 'Describe this image');
  assert.ok(en.some((c) => c.text === 'Recreate this UI in HTML and CSS'));
  assert.ok(en.some((c) => c.text === 'Find the bug shown here'));
  assert.ok(en.some((c) => c.text === 'Extract the text'));
  assert.ok(en.some((c) => c.text === 'Suggest design improvements'));
  await setLanguage('es');
  const es = suggestionChips({ imageCount: 2 }, t);
  assert.equal(es.length, 5);
  assert.notEqual(es[0].text, en[0].text);
  assert.equal(suggestionChips({ imageCount: 0, chatEmpty: true }, t).length, 3);
  assert.equal(suggestionChips({ imageCount: 0, chatEmpty: false }, t).length, 0);
  await setLanguage('en');
});

test('data URL / base64 helpers', () => {
  assert.deepEqual(parseDataUrl('data:image/png;base64,AAAA'), { mime: 'image/png', base64: 'AAAA' });
  assert.equal(parseDataUrl('data:text/plain,hi'), null);
  assert.equal(parseDataUrl('javascript:alert(1)'), null);
  assert.equal(base64Bytes('AAAA'), 3);
  assert.equal(base64Bytes('AAA='), 2);
  assert.equal(extFromMime('image/jpeg'), 'jpg');
  assert.match(pastedName('image/png', 2, new Date(2026, 0, 5, 3, 4, 5)), /^pasted-20260105-030405-2\.png$/);
  assert.equal(sizeText(512), '512 B');
  assert.equal(sizeText(1536), '1.5 KB');
  assert.equal(sizeText(3 * 1048576), '3.0 MB');
});

test('thumb cache memoises reads and drops failures', async () => {
  let calls = 0;
  const api = { attachments: { read: async (pid, rel) => { calls++; return rel === 'bad' ? null : { dataUrl: 'data:image/png;base64,AA' }; } } };
  const c = createThumbCache(api);
  assert.equal(await c.get('p', 'a'), 'data:image/png;base64,AA');
  await c.get('p', 'a');
  assert.equal(calls, 1);
  assert.equal(await c.get('p', 'bad'), null);
  await c.get('p', 'bad');
  assert.equal(calls, 3);
});

test('percent, tone, worst window and chip', () => {
  assert.equal(percent(0.154), 15);
  assert.equal(percent(2), 100);
  assert.equal(percent(NaN), 0);
  assert.equal(windowTone({ utilization: 0.5, status: 'allowed' }), 'ok');
  assert.equal(windowTone({ utilization: 0.82, status: 'allowed' }), 'amber');
  assert.equal(windowTone({ utilization: 0.4, status: 'allowed_warning' }), 'amber');
  assert.equal(windowTone({ utilization: 0.4, status: 'rejected' }), 'red');
  assert.equal(windowTone({ utilization: 1, status: 'allowed' }), 'red');
  const windows = { five_hour: { utilization: 0.15, status: 'allowed', resetsAt: 1 }, seven_day: { utilization: 0.38, status: 'allowed', resetsAt: 2 } };
  assert.equal(worstWindow(windows).kind, 'seven_day');
  assert.equal(worstWindow({ five_hour: { utilization: 0.2, status: 'rejected' }, seven_day: { utilization: 0.9, status: 'allowed' } }).kind, 'five_hour');
  assert.equal(worstWindow({ five_hour: null, seven_day: null }), null);
  assert.deepEqual(chipModel({ claude: { windows: { five_hour: windows.five_hour, seven_day: null } } }), { label: '5h 15%', tone: 'ok', kind: 'five_hour', window: windows.five_hour });
  assert.equal(chipModel({ claude: { windows: { five_hour: { utilization: 0.95, status: 'allowed_warning' } } } }).tone, 'amber');
  assert.equal(chipModel(null), null);
});

test('durations and countdown text (English)', () => {
  assert.equal(durationText(2 * 3600000 + 14 * 60000), '2 h 14 min');
  assert.equal(durationText(2 * 3600000), '2 h');
  assert.equal(durationText(45 * 60000), '45 min');
  assert.equal(durationText(0), '1 min');
  assert.equal(durationText(26 * 3600000 + 5 * 60000), '1 d 2 h');
  const now = 1_000_000;
  assert.equal(countdownText(now + 2 * 3600000 + 14 * 60000, now), 'in 2 h 14 min');
  assert.equal(countdownText(now - 5, now), t('usage.nowReset'));
  assert.equal(countdownText(undefined, now), '');
});

test('countdown, reset line and labels in Spanish', async () => {
  await setLanguage('es');
  const now = new Date(2026, 5, 1, 13, 0).getTime();
  assert.equal(countdownText(now + 134 * 60000, now), 'en 2 h 14 min');
  const line = resetLine(now + 134 * 60000, now, 'es');
  assert.match(line, /^Se restablece en 2 h 14 min - /);
  assert.equal(windowLabel('seven_day'), 'Semana (ventana de 7 d\u00edas)');
  assert.equal(limitCardModel({ kind: 'five_hour', status: 'rejected' }, 'claude', now).title, 'L\u00edmite de 5 horas alcanzado');
  await setLanguage('en');
});

test('reset clock shows the weekday only when it is not today', () => {
  const now = new Date(2026, 5, 1, 13, 0).getTime();
  const same = resetClock(new Date(2026, 5, 1, 15, 30).getTime(), now, 'en');
  assert.match(same, /3:30\s?PM/);
  assert.doesNotMatch(same, /Mon|Tue/);
  const later = resetClock(new Date(2026, 5, 3, 15, 30).getTime(), now, 'en');
  assert.match(later, /Wed/);
  assert.match(resetLine(new Date(2026, 5, 1, 15, 30).getTime(), now, 'en'), /^Resets in 2 h 30 min - 3:30\s?PM$/);
});

test('limit activity, card model and banner', () => {
  const now = 10_000_000;
  assert.equal(isLimitActive({ status: 'rejected', resetsAt: now + 1 }, now), true);
  assert.equal(isLimitActive({ status: 'rejected', resetsAt: now - 1 }, now), false);
  assert.equal(isLimitActive({ status: 'warning', resetsAt: now + 1000 }, now), false);
  assert.equal(isLimitActive({ status: 'rejected', at: now - 60000 }, now), true);
  assert.equal(isLimitActive({ status: 'rejected', at: now - 31 * 60000 }, now), false);
  assert.equal(isLimitActive(null, now), false);
  const card = limitCardModel({ kind: 'five_hour', status: 'rejected', resetsAt: now + 5000, message: "You've hit your limit - resets 3pm", agent: 'claude' }, 'claude', now);
  assert.equal(card.title, '5-hour limit reached');
  assert.equal(card.message, "You've hit your limit - resets 3pm");
  assert.equal(card.switchTo, 'agy');
  assert.equal(card.active, true);
  assert.equal(limitCardModel({ kind: 'seven_day', status: 'rejected' }, 'claude', now).title, 'Weekly limit reached');
  assert.equal(limitCardModel({ kind: 'quota', status: 'rejected' }, 'agy', now).title, 'Quota reached');
  assert.equal(limitCardModel({ kind: 'unknown', status: 'rejected' }, 'agy', now).kind, 'quota');
  const warn = limitCardModel({ kind: 'five_hour', status: 'warning', utilization: 0.9 }, 'claude', now);
  assert.equal(warn.severity, 'warning');
  assert.equal(warn.warnText, 'You have used 90% of your 5-hour window');
  assert.equal(limitCardModel({ status: 'rejected' }, 'claude', now).message, null);
  const usage = { claude: { lastLimit: { kind: 'five_hour', status: 'rejected', resetsAt: now + 1000, at: now } }, agy: { lastLimit: null } };
  assert.equal(limitBanner({ agent: 'claude' }, usage, now).kind, 'five_hour');
  assert.equal(limitBanner({ agent: 'agy' }, usage, now), null);
  assert.equal(limitBanner({ agent: 'claude' }, usage, now + 2000), null);
  assert.equal(otherAgent('claude'), 'agy');
  assert.equal(otherAgent('agy'), 'claude');
});

test('number helpers', () => {
  assert.equal(compactNumber(950), '950');
  assert.equal(compactNumber(12345), '12k');
  assert.equal(compactNumber(2_500_000), '2.5M');
  assert.equal(costText(0.0123), '$0.012');
  assert.equal(costText(3.456), '$3.46');
});
