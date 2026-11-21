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

  augment(ev) {
    if (ev.type === 'session' && ev.permissionMode === 'always-proceed') {
      return { ...ev, warning: 'always-proceed' };
    }
    return ev;
  }
}
