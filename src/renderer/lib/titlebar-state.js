// Pure helpers for the custom title bar.

export const DEFAULT_INSETS = Object.freeze({ left: 80, right: 140 });
export const TITLEBAR_HEIGHT = 40;

/**
 * Space the bar must keep free for the native window controls.
 * win32/linux: controls sit on the right (only when the native overlay exists; otherwise the bar draws its own buttons).
 * darwin: traffic lights sit on the left. Fullscreen hides the controls, so nothing is reserved.
 * @param {{platform:string, overlay:boolean, fullscreen:boolean, controlsInset?:{left?:number,right?:number}}} info
 * @returns {{left:number, right:number}}
 */
export function computeInsets(info) {
  const i = info || {};
  if (i.fullscreen) return { left: 0, right: 0 };
  const ci = i.controlsInset || {};
  const num = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);
  if (i.platform === 'darwin') return { left: num(ci.left, DEFAULT_INSETS.left), right: 0 };
  if (i.overlay === false) return { left: 0, right: 0 };
  return { left: 0, right: num(ci.right, DEFAULT_INSETS.right) };
}

/** Whether the bar must render its own minimize/maximize/close buttons (no native overlay, not on macOS traffic lights). */
export function needsOwnControls(info) {
  const i = info || {};
  return !i.fullscreen && i.platform !== 'darwin' && i.overlay === false;
}

/** Normalise a platform string to one of the three supported values. */
export function normalizePlatform(p) {
  return p === 'darwin' || p === 'linux' ? p : 'win32';
}

/**
 * Chips for the right side of the bar. Pure: takes plain values, returns descriptors
 * [{ id, tone:'green'|'amber'|'red'|'muted', key, vars? }] (i18n keys resolved by the component).
 */
export function statusChips({ health, remote, signedIn, project }) {
  const out = [];
  const vpn = !!(health && health.vpn && health.vpn.active);
  if (vpn) out.push({ id: 'vpn', tone: 'red', key: 'health.vpnActive' });
  if (remote && remote.running) out.push({ id: 'remote', tone: 'green', key: 'titlebar.remoteOn' });
  if (health) {
    const online = !vpn && !!health.anthropicReachable;
    out.push({ id: 'conn', tone: online ? 'green' : 'red', key: online ? 'nav.connected' : 'nav.offline' });
  }
  const agent = project && project.agent;
  if (agent && signedIn && signedIn[agent] === false) out.push({ id: 'signin', tone: 'amber', key: 'titlebar.signedOut', vars: { agent }, action: 'signin' });
  return out;
}
