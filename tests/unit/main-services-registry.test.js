import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServices, fanoutAgentEvent, disposeServices, SERVICE_NAMES } from '../../src/main/services.js';

const quiet = () => { const logs = []; return { logs, error: (...a) => logs.push(a.join(' ')) }; };

test('loads services that exist, skips missing ones silently, and passes deps + live registry', async () => {
  const log = quiet();
  const seen = {};
  const importer = async (n) => {
    if (n === 'usage') return { create: (deps) => { seen.usageDeps = deps; return { get: () => 1 }; } };
    if (n === 'models') return { create: async () => ({ list: () => [] }) };
    const e = new Error(`Cannot find module '/app/src/main/svc/${n}.js'`); e.code = 'ERR_MODULE_NOT_FOUND'; throw e;
  };
  const deps = { dir: '/tmp/x', services: {} };
  const s = await createServices(deps, { importer, log });
  assert.deepEqual(Object.keys(s).sort(), ['models', 'usage']);
  assert.equal(log.logs.length, 0, 'missing service files are silent');
  assert.equal(seen.usageDeps.dir, '/tmp/x');
  assert.equal(seen.usageDeps.services, s, 'services receive the live registry');
});

test('real load errors and bad modules are logged, never thrown', async () => {
  const log = quiet();
  const importer = async (n) => {
    if (n === 'usage') { const e = new Error("Cannot find module 'left-pad' imported from /app/src/main/svc/usage.js"); e.code = 'ERR_MODULE_NOT_FOUND'; throw e; } // dependency missing INSIDE the file
    if (n === 'models') throw new SyntaxError('Unexpected token');
    if (n === 'tasks') return {}; // no create()
    if (n === 'store') return { create: () => { throw new Error('boom'); } };
    if (n === 'menu') return { create: () => ({ ok: true }) };
    const e = new Error(`Cannot find module '/x/svc/${n}.js'`); e.code = 'ERR_MODULE_NOT_FOUND'; throw e;
  };
  const s = await createServices({ services: {} }, { importer, log });
  assert.deepEqual(Object.keys(s), ['menu']);
  const text = log.logs.join('\n');
  for (const n of ['usage', 'models', 'tasks', 'store']) assert.match(text, new RegExp(n), n);
});

test('fanout reaches every listener even if one throws; dispose too', () => {
  const calls = [];
  const services = {
    a: { onAgentEvent: (p, e) => { calls.push(['a', p, e.type]); throw new Error('x'); }, dispose: () => { calls.push(['a-dispose']); throw new Error('y'); } },
    b: { onAgentEvent: (p, e) => calls.push(['b', p, e.type]), dispose: () => calls.push(['b-dispose']) },
    c: {},
  };
  fanoutAgentEvent(services, 'p1', { type: 'text' });
  disposeServices(services);
  assert.deepEqual(calls, [['a', 'p1', 'text'], ['b', 'p1', 'text'], ['a-dispose'], ['b-dispose']]);
});

test('service name list covers the contract', () => {
  for (const n of ['store', 'ui', 'usage', 'models', 'deepseek', 'attachments', 'tasks', 'menu', 'boot']) assert.ok(SERVICE_NAMES.includes(n), n);
});
