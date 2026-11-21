import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeAuthStatus, isAgyLoggedInOutput, extractFirstUrl, stripAnsi, isAllowedLoginUrl } from '../../src/main/auth-check.js';

test('claude auth status parsing (real shapes)', () => {
  assert.deepEqual(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'), { loggedIn: true, authMethod: 'claude.ai' });
  assert.deepEqual(parseClaudeAuthStatus('{\n  "loggedIn": false,\n  "authMethod": "none"\n}'), { loggedIn: false });
  assert.deepEqual(parseClaudeAuthStatus('not json'), { loggedIn: false });
  assert.deepEqual(parseClaudeAuthStatus(''), { loggedIn: false });
});

test('agy models output decides login state (real shapes)', () => {
  const signedIn = 'Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n';
  assert.equal(isAgyLoggedInOutput(signedIn), true);
  assert.equal(isAgyLoggedInOutput('Please sign in to view available models. Launch the CLI without arguments'), false);
  assert.equal(isAgyLoggedInOutput(''), null);
  assert.equal(isAgyLoggedInOutput('Fetching available models...\n'), null); // network hiccup: inconclusive
});

test('URL extraction ignores ANSI and trims punctuation', () => {
  const claude = 'Opening browser to sign in…\nIf the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz\nPaste code here if prompted > ';
  assert.equal(extractFirstUrl(claude), 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz');
  assert.equal(extractFirstUrl('\x1b[32mOpen this link in a browser to log in with Google:\x1b[0m \x1b[4mhttps://accounts.google.com/o/oauth2/v2/auth?x=1\x1b[0m.'), 'https://accounts.google.com/o/oauth2/v2/auth?x=1');
  assert.equal(extractFirstUrl('no links here'), null);
  assert.equal(stripAnsi('\x1b]0;title\x07\x1b[1mbold\x1b[0m'), 'bold');
});

test('login URL allow-list: https + known hosts only', () => {
  assert.equal(isAllowedLoginUrl('https://claude.com/cai/oauth/authorize?x=1'), true);
  assert.equal(isAllowedLoginUrl('https://accounts.google.com/o/oauth2/v2/auth'), true);
  assert.equal(isAllowedLoginUrl('https://console.anthropic.com/oauth'), true);
  assert.equal(isAllowedLoginUrl('http://claude.com/x'), false);
  assert.equal(isAllowedLoginUrl('https://claude.com.evil.example/x'), false);
  assert.equal(isAllowedLoginUrl('https://evilgoogle.com/x'), false);
  assert.equal(isAllowedLoginUrl('https://user:pw@claude.com/x'), false);
  assert.equal(isAllowedLoginUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedLoginUrl('not a url'), false);
});
