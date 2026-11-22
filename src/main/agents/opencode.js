import { AgentAdapter } from './base.js';
import { createOpencodeNormalizer, NORMALIZERS } from '../../shared/events.js';

/** plan -> opencode's read-only `plan` agent; everything else -> the default `build` agent (`opencode run` has no permission-mode flag). */
export const opencodeAgentFor = (mode) => (mode === 'plan' ? 'plan' : null);

// UNVERIFIED against a real opencode (not installed): flags follow its documented CLI (`opencode run [message..] --format json
// --session <id> --model provider/model --agent <name>`). See docs/spikes.md.
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
    self.normalize = createOpencodeNormalizer();
    return AgentAdapter.prototype.run.call(self, opts);
  }
}
