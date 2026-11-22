import { AgentAdapter } from './base.js';
import { NORMALIZERS } from '../../shared/events.js';
import { modelArgs } from './model-spec.js';

/** default/acceptEdits -> accept-edits, plan -> plan, auto (explicit "Auto-accept everything") -> auto. */
export function agyModeFor(mode) {
  if (mode === 'auto') return 'auto';
  return mode === 'plan' ? 'plan' : 'accept-edits';
}

export class AgyAdapter extends AgentAdapter {
  constructor() { super('agy', NORMALIZERS.agy); }

  buildArgs(project, text) {
    return [
      '--output-format', 'stream-json',
      ...(project.sessionId ? ['--conversation', project.sessionId] : []),
      ...modelArgs(project),
      '--mode', agyModeFor(project.mode),
      `-p=${text}`, // the value MUST be attached with '='
    ];
  }

  /** agy reads image files itself: one '[Image attached: <absolute path>]' line per image appended to the prompt. */
  prepareText(text, images = []) {
    const lines = images.filter((i) => i?.abs).map((i) => `[Image attached: ${i.abs}]`);
    return lines.length ? `${text}\n\n${lines.join('\n')}` : text;
  }

  // Verified on agy 1.5.14: init always reports permission_mode 'always-proceed' in print mode, but we always
  // pass --mode and `--mode plan` really blocked a file write (it wrote a plan instead). So that label is not
  // a trustworthy signal and no warning is raised. See docs/spikes.md.
  augment(ev) {
    return ev;
  }
}
