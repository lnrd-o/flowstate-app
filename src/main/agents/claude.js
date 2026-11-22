import { AgentAdapter } from './base.js';
import { NORMALIZERS } from '../../shared/events.js';
import { allowArgs } from '../permissions.js';
import { modelArgs } from './model-spec.js';
import { routeOf } from './routes.js';

const MODES = new Set(['default', 'acceptEdits', 'plan']);
/** FlowState mode -> claude --permission-mode ('auto' = accept everything = bypassPermissions). */
export function claudeModeFor(mode) {
  if (mode === 'auto') return 'bypassPermissions';
  return MODES.has(mode) ? mode : 'default';
}

export class ClaudeAdapter extends AgentAdapter {
  constructor() {
    super('claude', NORMALIZERS.claude);
    this.closeStdinOnResult = true;
  }

  buildArgs(project) {
    const mode = claudeModeFor(project.mode);
    return [
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--input-format', 'stream-json',
      ...(project.sessionId ? ['--resume', project.sessionId] : []),
      ...modelArgs(routeOf(project) === 'deepseek' ? { ...project, effort: null } : project), // --effort is Anthropic-only
      '--permission-mode', mode,
      ...allowArgs(project.allow), // per-turn narrow rules (see permissions.js); empty unless the user pressed "Allow this once"
    ];
  }

  /** images: [{mime, dataBase64}] -> base64 image blocks BEFORE the text block. */
  stdinPayload(text, images = []) {
    const blocks = [];
    for (const i of images) {
      if (i?.dataBase64 && i.mime) blocks.push({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.dataBase64 } });
    }
    blocks.push({ type: 'text', text });
    return `${JSON.stringify({ type: 'user', message: { role: 'user', content: blocks } })}\n`;
  }
}
