// Pure helpers for the DeepSeek settings / usage UI. The API key never reaches the renderer; nothing here ever sees it.

/** Error code from deepseek.setKey / deepseek.status -> { key, vars } (i18n key under deepseek.err.*). */
export function deepseekError(code) {
  const c = String(code || '');
  if (c === 'invalid-key' || c === 'encryption-unavailable' || c === 'offline') return { key: 'deepseek.err.' + c, vars: {} };
  const m = /^http[-_ ]?(\d{3})$/i.exec(c);
  if (m) return { key: 'deepseek.err.http', vars: { code: m[1] } };
  return { key: 'deepseek.err.generic', vars: {} };
}

/** "12.45 USD" from a Balance, or '-' . */
export function balanceText(balance) {
  if (!balance || typeof balance !== 'object') return '-';
  return String(balance.total ?? '-') + (balance.currency ? ' ' + balance.currency : '');
}

/** Trim and validate a key before sending it: returns the key or null when it is clearly not a key. */
export function cleanKey(raw) {
  const k = String(raw || '').trim();
  return k.length >= 8 && !/\s/.test(k) ? k : null;
}
