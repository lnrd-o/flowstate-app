import { AgentAdapter } from './base.js';
import { createOpencodeNormalizer, NORMALIZERS } from '../../shared/events.js';

/** plan -> opencode's read-only `plan` agent; everything else -> the default `build` agent (`opencode run` has no permission-mode flag). */
export const opencodeAgentFor = (mode) => (mode === 'plan' ? 'plan' : null);

// Verified on opencode 2.2.0 (desktop app's bundled opencode-cli.exe): `opencode run --format json [--session <id>] [--model provider/model]
// [--agent plan] [--auto] -- <message>`. Tools run without prompting in `run`; --auto also approves anything not explicitly denied.
// See docs/spikes.md.
export class OpencodeAdapter extends AgentAdapter {
  constructor() { super('opencode', NORMALIZERS.opencode); }

  buildArgs(project, text) {
    const agent = opencodeAgentFor(project.mode);
    const model = typeof project.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(project.model) && project.model !== 'default' ? project.model : null;
    return [
      'run', '--format', 'json',
      ...(project.sessionId ? ['--session', project.sessionId] : []),
      ...(model ? ['--model', model] : []),
      ...(agent ? ['--agent', agent] : []),
      ...(project.mode === 'auto' ? ['--auto'] : []),
      '--', text,
    ];
  }

  prepareText(text, images = []) {
    const lines = images.filter((i) => i?.abs).map((i) => `[Image attached: ${i.abs}]`);
    return lines.length ? `${text}\n\n${lines.join('\n')}` : text;
  }

  /** Fresh stateful normalizer per turn (usage sums, accumulated text). */
  run(opts) {
    const self = Object.create(this);
    const norm = createOpencodeNormalizer();
    self.normalize = norm;
    const h = AgentAdapter.prototype.run.call(self, opts);
    // opencode may exit cleanly without a final step_finish: close the turn with a result so the UI and auto-commit see it end.
    const done = h.done.then((r) => {
      if (r.resultSeen || r.stopped || r.code !== 0) return r;
      const ev = norm.finish();
      if (!ev) return r;
      try { opts.emit(ev); } catch { /* ignore */ }
      return { ...r, resultSeen: true, ok: true };
    });
    return { ...h, done };
  }
}
