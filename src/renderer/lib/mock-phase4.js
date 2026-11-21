// Phase 4 part of the browser mock: in-app sign-in (login.*) and the window API (window.*).
// Hash flags: #mac #linux (platform), #overlay (pretend a native window-controls overlay exists), #fullscreen,
// #needlogin (both agents signed out), #claudeout, #agyout, #noterm (agy PTY unavailable), #badcode (claude rejects codes).

const has = (re) => typeof location !== 'undefined' && re.test(location.hash);

export function mockPlatform() {
  return has(/#mac\b/) ? 'darwin' : has(/#linux\b/) ? 'linux' : 'win32';
}

export function createPhase4({ onSignedChange } = {}) {
  const loginSubs = new Set();
  const windowSubs = new Set();
  const signed = {
    claude: !(has(/#needlogin|#claudeout|#nologin/)),
    agy: !has(/#needlogin|#agyout/),
  };
  const sessions = {}; // agent -> { timers: [], enters: 0 }
  let win = { maximized: false, fullscreen: has(/#fullscreen/) };

  const emitLogin = (ev) => loginSubs.forEach((cb) => cb(ev));
  const setSigned = (agent, v) => {
    if (signed[agent] === v) return;
    signed[agent] = v;
    if (onSignedChange) onSignedChange(agent, v);
  };
  const later = (agent, ms, fn) => {
    const s = sessions[agent];
    if (!s) return;
    s.timers.push(setTimeout(() => { if (sessions[agent] === s) fn(); }, ms));
  };
  const end = (agent) => {
    const s = sessions[agent];
    if (s) s.timers.forEach(clearTimeout);
    delete sessions[agent];
  };

  const AGY_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=mock&response_type=code&scope=openid';
  const MENU = [
    '\x1b[1mAGY\x1b[0m  sign in required\r\n\r\n',
    '  \x1b[36m>\x1b[0m \x1b[1mLog in with Google\x1b[0m\r\n',
    '    Log in with Gemini Enterprise\r\n\r\n',
    '\x1b[2mUse the arrow keys to choose, Enter to confirm.\x1b[0m\r\n',
  ];

  const login = {
    start: async (agent, opts = {}) => {
      end(agent);
      sessions[agent] = { timers: [], enters: 0, opts };
      if (agent === 'claude') {
        later(agent, 400, () => emitLogin({ agent, kind: 'url', url: 'https://claude.ai/oauth/authorize?code=true&client_id=mock-client&redirect_uri=urn%3Aietf%3Awg%3Aoauth%3A2.0%3Aoob&scope=user%3Ainference' }));
        later(agent, 700, () => emitLogin({ agent, kind: 'prompt', text: 'Paste code here if prompted >' }));
        return { ok: true, mode: 'pipe' };
      }
      if (has(/#noterm/)) { end(agent); return { ok: false, mode: 'pty', error: 'terminal-unavailable' }; }
      MENU.forEach((line, i) => later(agent, 150 + i * 90, () => emitLogin({ agent, kind: 'data', data: line })));
      return { ok: true, mode: 'pty' };
    },
    input: async (agent, data) => {
      const s = sessions[agent];
      if (!s) return;
      if (agent === 'claude') {
        const code = String(data).trim();
        if (code.length < 4 || has(/#badcode/)) {
          later(agent, 300, () => { emitLogin({ agent, kind: 'error', text: 'Invalid code. Please try again.' }); end(agent); });
          return;
        }
        later(agent, 600, () => { setSigned('claude', true); emitLogin({ agent, kind: 'done', ok: true, loggedIn: true }); end(agent); });
        return;
      }
      // agy: echo typed text; two Enter presses = choose provider, then confirm in the (fake) browser flow.
      const str = String(data);
      if (str.includes('\r')) {
        s.enters += 1;
        if (s.enters === 1) {
          emitLogin({ agent, kind: 'data', data: '\r\nOpening your browser to sign in...\r\nIf it does not open, visit:\r\n\x1b[4;34m' + AGY_URL + '\x1b[0m\r\n\r\nPress Enter once you finished in the browser.\r\n' });
          emitLogin({ agent, kind: 'url', url: AGY_URL });
        } else if (s.enters >= 2) {
          emitLogin({ agent, kind: 'data', data: '\r\n\x1b[32mSigned in.\x1b[0m\r\n' });
          later(agent, 600, () => { setSigned('agy', true); emitLogin({ agent, kind: 'done', ok: true, loggedIn: true }); end(agent); });
        }
      } else if (/^[\x20-\x7e]+$/.test(str)) {
        emitLogin({ agent, kind: 'data', data: str });
      }
    },
    resize: async () => {},
    cancel: async (agent) => { end(agent); },
    status: async () => ({ claude: { loggedIn: signed.claude, authMethod: signed.claude ? 'claude.ai' : undefined, email: signed.claude ? 'leo@example.com' : undefined }, agy: { loggedIn: signed.agy } }),
    logout: async (agent) => {
      if (agent === 'agy') return { ok: false, error: 'use-terminal' };
      setSigned(agent, false);
      emitLogin({ agent, kind: 'status', loggedIn: false });
      return { ok: true };
    },
  };

  const windowApi = {
    info: async () => ({ platform: mockPlatform(), maximized: win.maximized, overlay: has(/#overlay/), controlsInset: { left: 80, right: 140 }, fullscreen: win.fullscreen }),
    setTheme: async (theme) => { if (typeof window !== 'undefined') window.__lastWindowTheme = theme; },
    action: async (what) => {
      if (what === 'toggle-maximize') {
        win = { ...win, maximized: !win.maximized };
        windowSubs.forEach((cb) => cb({ maximized: win.maximized, fullscreen: win.fullscreen }));
      } else if (typeof console !== 'undefined') console.info('[mock] window action:', what);
    },
  };

  return {
    api: { login, window: windowApi, platform: mockPlatform() },
    subscribe: {
      onLogin: (cb) => { loginSubs.add(cb); return () => loginSubs.delete(cb); },
      onWindow: (cb) => { windowSubs.add(cb); return () => windowSubs.delete(cb); },
    },
    signed: () => ({ ...signed }),
    setSigned,
  };
}
