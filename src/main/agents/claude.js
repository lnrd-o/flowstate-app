import { AgentAdapter } from './base.js';
import { NORMALIZERS } from '../../shared/events.js';

const MODES = new Set(['default', 'acceptEdits', 'plan']);

export class ClaudeAdapter extends AgentAdapter {
  constructor() {
    super('claude', NORMALIZERS.claude);
    this.closeStdinOnResult = true;
  }

  buildArgs(project) {
    const mode = MODES.has(project.mode) ? project.mode : 'default';
    return [
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--input-format', 'stream-json',
      ...(project.sessionId ? ['--resume', project.sessionId] : []),
      '--permission-mode', mode,
    ];
  }

  stdinPayload(text) {
    return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;
  }
}
