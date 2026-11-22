// REAL image check (costs a few cents of model use): sends a 64x64 solid red PNG through attachments:save + agent:send.
//   claude: base64 image block before the text block (model: haiku)    agy: '[Image attached: <abs path>]' line in the prompt
// Run: node tests/e2e/images.mjs [claude|agy|both]   (isolated profile, port 9601; not part of `npm run e2e`)
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { launch, makeChecker, sleep } from './lib.mjs';

function redPng(w, h) {
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [255, 0, 0]).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

const which = process.argv[2] ?? 'both';
const { check, done } = makeChecker();
const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'flowstate-img-')));
const proj = join(base, 'img project');
mkdirSync(proj);
const J = JSON.stringify;
let app = null;
try {
  app = await launch({ profile: join(base, 'profile'), port: 9601 });
  await app.ev('try { await window.flowstate.app.ready(); } catch {} return 1');
  for (const agent of which === 'both' ? ['claude', 'agy'] : [which]) {
    const p = await app.call(`window.flowstate.projects.add({name:${J(`img-${agent}`)}, path:${J(join(proj, agent))}, agent:${J(agent)}, mode:'plan'})`);
    if (agent === 'claude') await app.call(`window.flowstate.projects.update(${J(p.id)}, {model:'haiku'})`);
    const a = await app.call(`window.flowstate.attachments.save(${J(p.id)}, {name:'red.png', mime:'image/png', dataBase64:${J(redPng(64, 64).toString('base64'))}})`);
    check(`${agent}: attachment saved (64x64 png)`, a.rel.startsWith('.flowstate/attachments/') && a.width === 64 && a.height === 64, J(a));
    const out = await app.call(`(async () => {
      const api = window.flowstate; const evs = []; const off = api.onAgentEvent((e) => { if (e.projectId === ${J(p.id)}) evs.push(e.event); });
      await api.agent.send({ projectId: ${J(p.id)}, text: 'What colour is this image? One word.', images: [{ rel: ${J(a.rel)} }] });
      const t0 = Date.now();
      while (Date.now() - t0 < 180000 && !evs.some((e) => e.type === 'result' || e.type === 'error')) await new Promise((r) => setTimeout(r, 500));
      off();
      const hist = await api.history.get(${J(p.id)});
      const streamed = evs.filter((e) => e.type === 'text' || e.type === 'text-delta').map((e) => e.text).join(''); const fin = evs.find((e) => e.type === 'result');
      return { text: streamed || fin?.text || '', result: evs.find((e) => e.type === 'result') ?? null, error: evs.find((e) => e.type === 'error') ?? null,
        tools: evs.filter((e) => e.type === 'tool-use').map((e) => e.name), userImages: hist.find((h) => h.t === 'user')?.images ?? null };
    })()`);
    console.log(`INFO  ${agent} answered: ${J(out.text)}  tools: ${J(out.tools)}  ok: ${out.result?.ok}  error: ${out.error?.message ?? '-'}`);
    check(`${agent}: turn finished`, !!out.result && out.result.ok === true, J(out.error));
    check(`${agent}: history user record keeps images:[rel]`, Array.isArray(out.userImages) && out.userImages[0] === a.rel, J(out.userImages));
    check(`${agent}: the model identified the colour red`, /red/i.test(out.text), out.text);
    await sleep(500);
  }
} catch (e) {
  check('images run completed', false, e.stack || e.message);
} finally {
  try { await app?.shutdown(); } catch { /* ignore */ }
  await sleep(800);
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.exit(done());
