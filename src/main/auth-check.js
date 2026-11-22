// Pure parsers that decide whether each CLI is signed in (no I/O; callers run the commands).
//  claude: `claude auth status` prints JSON like {"loggedIn":true,"authMethod":"claude.ai",...}
//  agy:    `agy models` prints a model list when signed in and "Please sign in to view available models..." when not.

/** @returns {{loggedIn:boolean, authMethod?:string, email?:string}} loggedIn is false for anything unparseable. */
export function parseClaudeAuthStatus(text) {
  try {
    const j = JSON.parse(String(text).trim());
    const out = { loggedIn: j.loggedIn === true };
    if (typeof j.authMethod === 'string' && j.authMethod !== 'none') out.authMethod = j.authMethod;
    if (typeof j.email === 'string') out.email = j.email;
    return out;
  } catch {
    return { loggedIn: false };
  }
}

/**
 * agy is signed in when `agy models` produced at least one model line and did not ask to sign in.
 * @param {string} text combined stdout+stderr
 * @returns {boolean|null} null when the output is empty/inconclusive (e.g. network error) so callers can keep the previous value
 */
export function isAgyLoggedInOutput(text) {
  const t = String(text ?? '');
  if (/sign in|log ?in to|not (?:logged|signed) in|unauthenticated/i.test(t)) return false;
  const lines = t.split(/\r?\n/).filter((l) => /^[a-z0-9][\w.-]*\t/i.test(l.trim()));
  if (lines.length) return true;
  return null;
}

/**
 * opencode: `opencode auth list` prints "N credentials" (plus provider lines) and, from env, "N environment variables".
 * @returns {boolean|null} true when at least one credential/env key is configured; null when inconclusive
 */
export function isOpencodeLoggedInOutput(text) {
  const t = stripAnsi(String(text ?? ''));
  const nums = [...t.matchAll(/(\d+)\s+(?:credentials?|environment variables?)/gi)].map((m) => Number(m[1]));
  if (nums.length) return nums.some((n) => n > 0);
  return null;
}

/** First https URL in (ANSI-stripped) text, trailing punctuation trimmed; null if none. */
export function extractFirstUrl(text) {
  const m = /https:\/\/[^\s"'<>\x1b\x00-\x1f]+/.exec(stripAnsi(String(text ?? '')));
  return m ? m[0].replace(/[).,;:!?\]}]+$/, '') : null;
}

export function stripAnsi(s) {
  // CSI sequences, OSC sequences (BEL or ST terminated), and other 2-char escapes
  return String(s).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[@-Z\\-_]/g, '');
}

const ALLOWED_LOGIN_HOSTS = [
  /^claude\.com$/, /^claude\.ai$/, /(^|\.)anthropic\.com$/, /^platform\.claude\.com$/, /^console\.anthropic\.com$/,
  /^accounts\.google\.com$/, /(^|\.)google\.com$/, /(^|\.)googleapis\.com$/,
];

/** True when `url` is https and its host is one of the sign-in hosts we are willing to open automatically. */
export function isAllowedLoginUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && ALLOWED_LOGIN_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}
