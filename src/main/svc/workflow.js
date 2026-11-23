// "Work easier" helpers (main side):
//  - desktop notifications when a turn finishes / needs approval and the window is not focused (click -> focus + select project)
//  - spreadsheet before/after compare (xlsx/xlsm/csv/tsv) between the previous and the current version of a file
//  - one-click PDF export of a rendered answer into the project's outputs folder
//  - global "quick ask" shortcut (Ctrl/Cmd+Shift+Space): focus FlowState and open the quick-ask bar
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { CH } from '../../shared/ipc.js';
import { resolveInside } from '../files.js';
import { parseXlsx, parseCsv } from '../files-preview.js';
import { detectLayout } from '../../shared/layout.js';

export const QUICK_ASK_ACCELERATOR = 'CommandOrControl+Shift+Space';
const SHEET_CAPS = Object.freeze({ entries: 5000, entryBytes: 64 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, rows: 2000, cols: 60, sheets: 30, sharedStrings: 200000, cell: 500 });
const MAX_CHANGES = 2000;

/** Run git and return stdout as a Buffer (null on failure). */
function gitBuf(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'buffer', maxBuffer: 128 * 1024 * 1024, windowsHide: true, timeout: 20000 }, (err, out) => resolve(err ? null : out));
  });
}

const colName = (i) => { let s = ''; let n = i + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

/** Parse a spreadsheet buffer into [{name, rows}] (xlsx/xlsm via the preview parser, csv/tsv as one sheet). */
export function readSheets(buf, rel) {
  const ext = path.extname(rel).toLowerCase();
  if (ext === '.csv' || ext === '.tsv') {
    const r = parseCsv(buf.toString('utf8').replace(/^﻿/, ''), { delimiter: ext === '.tsv' ? '\t' : undefined, maxRows: SHEET_CAPS.rows, maxCols: SHEET_CAPS.cols });
    return [{ name: path.basename(rel), rows: r.rows }];
  }
  const r = parseXlsx(buf, SHEET_CAPS);
  return r.sheets.map((s) => ({ name: s.name, rows: s.rows.map((row) => row.map((c) => (c && typeof c === 'object' ? String(c.v ?? c.text ?? '') : String(c ?? '')))) }));
}

/** Pure: cell-level differences between two parsed workbooks. */
export function diffSheets(before, after) {
  const names = [...new Set([...before.map((s) => s.name), ...after.map((s) => s.name)])];
  return names.map((name) => {
    const a = before.find((s) => s.name === name);
    const b = after.find((s) => s.name === name);
    const out = { name, status: !a ? 'added' : !b ? 'removed' : 'same', changes: [], beforeRows: a ? a.rows.length : 0, afterRows: b ? b.rows.length : 0, truncated: false };
    if (!a || !b) return out;
    const rows = Math.max(a.rows.length, b.rows.length);
    for (let r = 0; r < rows; r++) {
      const ra = a.rows[r] || []; const rb = b.rows[r] || [];
      const cols = Math.max(ra.length, rb.length);
      for (let c = 0; c < cols; c++) {
        const va = ra[c] ?? ''; const vb = rb[c] ?? '';
        if (va === vb) continue;
        if (out.changes.length >= MAX_CHANGES) { out.truncated = true; break; }
        out.changes.push({ cell: `${colName(c)}${r + 1}`, r, c, before: va, after: vb, kind: va === '' ? 'added' : vb === '' ? 'removed' : 'changed' });
      }
      if (out.truncated) break;
    }
    if (out.changes.length) out.status = 'changed';
    return out;
  });
}

export function create({ projects, getWindow = () => null, push = () => {}, electron, settings, fsx = fs }) {
  const { Notification, BrowserWindow, globalShortcut, shell } = electron ?? {};
  const need = (id) => { const p = projects.get(id); if (!p) throw new Error('Unknown project'); return p; };
  const lastNotified = new Map();

  function focusWindow() {
    const w = getWindow();
    if (!w) return;
    if (w.isMinimized?.()) w.restore();
    w.show?.(); w.focus?.();
  }

  // ---------- notifications ----------
  function notify(projectId, key, vars) {
    try {
      if (settings?.get?.().notifications === false) return;
      if (!Notification?.isSupported?.()) return;
      const w = getWindow();
      if (w && w.isFocused?.() && !w.isMinimized?.()) return; // the user is looking at the app already
      const now = Date.now();
      if (now - (lastNotified.get(projectId + key) || 0) < 3000) return;
      lastNotified.set(projectId + key, now);
      const p = projects.get(projectId);
      const es = settings?.get?.().language === 'es';
      const T = {
        done: es ? ['Listo', 'FlowState terminó en %s.'] : ['Done', 'FlowState finished in %s.'],
        failed: es ? ['Algo falló', 'El turno en %s terminó con un error.'] : ['Something went wrong', 'The turn in %s ended with an error.'],
        approval: es ? ['Necesita tu aprobación', '%s espera que permitas una acción.'] : ['Needs your approval', '%s is waiting for you to allow an action.'],
        scheduled: es ? ['Tarea programada', '%s'] : ['Scheduled task', '%s'],
      }[key];
      if (!T) return;
      const n = new Notification({ title: `${T[0]} - ${p?.name ?? 'FlowState'}`, body: T[1].replace('%s', vars?.text ?? p?.name ?? ''), silent: false });
      n.on('click', () => { focusWindow(); push(CH.evWorkflow, { kind: 'open-project', projectId }); });
      n.show();
    } catch { /* notifications are best effort */ }
  }

  // ---------- quick ask (global shortcut) ----------
  let registered = false;
  function registerShortcut() {
    try {
      if (!globalShortcut || registered) return;
      registered = globalShortcut.register(QUICK_ASK_ACCELERATOR, () => { focusWindow(); push(CH.evWorkflow, { kind: 'quick-ask' }); });
    } catch { registered = false; }
  }
  setTimeout(registerShortcut, 1500).unref?.();

  return {
    notify,
    onAgentEvent(projectId, ev) {
      if (!ev) return;
      if (ev.type === 'result') notify(projectId, ev.ok === false && !ev.stopped ? 'failed' : 'done');
      else if (ev.type === 'error' && ev.kind !== 'parse') notify(projectId, 'failed');
      else if (ev.type === 'permission-denied') notify(projectId, 'approval');
    },

    /** Before/after compare of a spreadsheet. Uncommitted edits: HEAD vs working file; otherwise HEAD~1 vs HEAD (the last turn's commit). */
    async compareSheet(projectId, rel) {
      const p = need(projectId);
      const { abs, rel: clean } = resolveInside(p.path, rel, fsx);
      if (!/\.(xlsx|xlsm|csv|tsv)$/i.test(clean)) return { ok: false, reason: 'unsupported' };
      const working = fsx.existsSync(abs) ? fsx.readFileSync(abs) : null;
      const head = await gitBuf(p.path, ['show', `HEAD:${clean}`]);
      let before = head; let after = working; let from = 'HEAD'; let to = 'working';
      if (head && working && head.equals(working)) {
        before = await gitBuf(p.path, ['show', `HEAD~1:${clean}`]); after = head; from = 'HEAD~1'; to = 'HEAD';
      }
      if (!before && !after) return { ok: false, reason: 'no-history' };
      try {
        const sheets = diffSheets(before ? readSheets(before, clean) : [], after ? readSheets(after, clean) : []);
        return { ok: true, path: clean, from: before ? from : null, to, sheets, created: !before, deleted: !after };
      } catch (e) { return { ok: false, reason: 'unreadable', message: String(e?.message ?? e) }; }
    },

    /** Print sanitized HTML (rendered by the renderer) to <outputs>/<name>.pdf. -> {ok, rel} */
    async exportPdf(projectId, { html, title }) {
      const p = need(projectId);
      if (typeof html !== 'string' || html.length > 5 * 1024 * 1024) throw new TypeError('invalid html');
      const lay = detectLayout((n) => { try { return fsx.statSync(path.join(p.path, n)).isDirectory(); } catch { return false; } }, settings?.get?.().language === 'es' ? 'es' : 'en');
      const outDir = path.join(p.path, lay.outputs);
      fsx.mkdirSync(outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
      const base = String(title || 'report').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'report';
      const file = path.join(outDir, `${base}_${stamp}.pdf`);
      const page = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${String(title || '').replace(/[<>&]/g, '')}</title><style>
        body{font:12pt/1.5 "Segoe UI",Arial,sans-serif;color:#111;margin:28px 36px}h1,h2,h3{line-height:1.25}pre,code{font-family:Consolas,monospace;font-size:10pt}
        pre{background:#f4f4f4;padding:10px;border-radius:6px;white-space:pre-wrap}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}img{max-width:100%}
        .meta{color:#666;font-size:9pt;margin-bottom:18px}</style></head><body><div class="meta">${String(p.name).replace(/[<>&]/g, '')} - ${new Date().toLocaleString()}</div>${html}</body></html>`;
      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
      try {
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
        const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } });
        fsx.writeFileSync(file, pdf);
      } finally { win.destroy(); }
      const rel = path.relative(p.path, file).split(path.sep).join('/');
      try { shell?.showItemInFolder?.(file); } catch { /* ignore */ }
      return { ok: true, rel };
    },

    dispose() { try { if (registered) globalShortcut.unregister(QUICK_ASK_ACCELERATOR); } catch { /* ignore */ } },
  };
}
