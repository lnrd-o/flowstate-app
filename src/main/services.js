// Pluggable Phase 7 services. Each service lives in src/main/svc/<name>.js and exports
//   export function create(deps) -> service object   (sync or async)
// `deps` is everything the rest of main already built (see main.js) plus `services` (the live registry, so a service may use
// another one lazily at call time - never at create time) and a `push(channel, payload)` helper to the renderer.
//
// Optional service hooks (all optional, called by main.js):
//   service.onAgentEvent(projectId, event, meta?)   every normalised agent event (usage, tasks and the project store listen);
//                                            meta = {agent} = the agent that produced the turn (per-turn methodology overrides included)
//   service.dispose()                        on app quit
// A service that fails to load or create is logged and skipped: the IPC layer then answers 'service not available: <name>'.

export const SERVICE_NAMES = Object.freeze(['store', 'ui', 'usage', 'models', 'deepseek', 'attachments', 'tasks', 'menu', 'imports', 'boot', 'preview', 'versions']);

export async function createServices(deps, { names = SERVICE_NAMES, importer = (n) => import(`./svc/${n}.js`), log = console } = {}) {
  const services = deps.services ?? {};
  for (const name of names) {
    let mod;
    try {
      mod = await importer(name);
    } catch (e) {
      // A service file that does not exist yet is normal while features are being built (stay silent);
      // anything else (syntax error, missing import inside the file ...) is a real problem worth logging.
      // Node words it "Cannot find module '<path>/svc/<name>.js' imported from ..." for the file itself, but
      // "Cannot find module '<dependency>' imported from <path>/svc/<name>.js" for a dependency INSIDE it.
      const missingSelf = e?.code === 'ERR_MODULE_NOT_FOUND' && new RegExp(`^Cannot find module '[^']*svc[\\\\/]${name}\\.js'`).test(String(e.message));
      if (!missingSelf) log.error?.(`[services] ${name} failed to load:`, e?.message ?? e);
      continue;
    }
    if (typeof mod?.create !== 'function') { log.error?.(`[services] ${name}: no create() export`); continue; }
    try {
      services[name] = await mod.create({ ...deps, services });
    } catch (e) {
      log.error?.(`[services] ${name} failed to start:`, e?.message ?? e);
    }
  }
  return services;
}

/** Fan an agent event out to every service that listens (errors in one never affect the others). */
export function fanoutAgentEvent(services, projectId, event, meta) {
  for (const s of Object.values(services)) {
    try { s?.onAgentEvent?.(projectId, event, meta); } catch { /* a listener must never break the agent stream */ }
  }
}

export function disposeServices(services) {
  for (const s of Object.values(services)) {
    try { s?.dispose?.(); } catch { /* best effort on quit */ }
  }
}
