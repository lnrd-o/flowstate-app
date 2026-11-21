export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
].join('; ');

export const EXTERNAL_ALLOW = ['claude.ai', 'anthropic.com', 'github.com', 'nodejs.org', 'git-scm.com', 'python.org', 'google.com'];

/** True only for https URLs whose host is (a subdomain of) an allow-listed domain. */
export function isAllowedExternal(url, allow = EXTERNAL_ALLOW) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  return allow.some((d) => h === d || h.endsWith(`.${d}`));
}

export function isInternalUrl(url) {
  return typeof url === 'string' && url.startsWith('file://');
}
