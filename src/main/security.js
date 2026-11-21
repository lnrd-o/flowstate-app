import { isAllowedLoginUrl } from './auth-check.js';

// CSP note: xterm.js (sign-in terminal) needs no eval and only inline styles, which style-src already allows.
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src http://127.0.0.1:*",
].join('; ');

export const EXTERNAL_ALLOW = ['claude.ai', 'anthropic.com', 'github.com', 'nodejs.org', 'git-scm.com', 'python.org', 'google.com'];

/** True only for https URLs whose host is (a subdomain of) an allow-listed domain. */
export function isAllowedExternal(url, allow = EXTERNAL_ALLOW) {
  if (isAllowedLoginUrl(url)) return true; // sign-in hosts (https only)
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  return allow.some((d) => h === d || h.endsWith(`.${d}`));
}

/** CSP is applied to the app UI only; framed dashboards (Streamlit on 127.0.0.1) keep their own headers. */
export function shouldApplyCsp(url) {
  return typeof url === 'string' && url.startsWith('file://');
}

export function isInternalUrl(url) {
  return typeof url === 'string' && url.startsWith('file://');
}
