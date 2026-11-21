import { AgentAdapter } from './base.js';
import { NORMALIZERS } from '../../shared/events.js';

/** Never leave agy in always-proceed: default/acceptEdits -> accept-edits, plan -> plan. */
export function agyModeFor(mode) {
  return mode === 'plan' ? 'plan' : 'accept-edits';
}

export class AgyAdapter extends AgentAdapter {
  constructor() { super('agy', NORMALIZERS.agy); }

  buildArgs(project, text) {
    return [
      '--output-format', 'stream-json',
      ...(project.sessionId ? ['--conversation', project.sessionId] : []),
      '--mode', agyModeFor(project.mode),
      `-p=${text}`, // the value MUST be attached with '='
    ];
  }

  // Verified on agy 1.5.14: init always reports permission_mode 'always-proceed' in print mode, but we always
  // pass --mode and `--mode plan` really blocked a file write (it wrote a plan instead). So that label is not
  // a trustworthy signal and no warning is raised. See docs/spikes.md.
  augment(ev) {
    return ev;
  }
}
