// Prompt template store: bundled prompts/default/*.md plus user templates in <userData>/prompts/*.md.
// Format: markdown with a frontmatter block between two '---' lines (see parseTemplate / serializeTemplate).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const TYPES = ['text', 'textarea', 'select'];
const LIM = { name: 80, desc: 300, tag: 30, tags: 10, body: 20000, vars: 12, label: 80, def: 500, opt: 60, opts: 20, file: 64 * 1024 };

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DIR = path.join(here, '..', '..', 'prompts', 'default');

const oneLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();

/** Parse a template markdown file. Throws on malformed frontmatter. */
export function parseTemplate(text, source = 'default') {
  const src = String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  if (!m) throw new Error('missing frontmatter');
  const meta = {};
  const vars = [];
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i < 0) throw new Error(`bad frontmatter line: ${line.slice(0, 40)}`);
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k === 'var') {
      const p = v.split('|').map((x) => x.trim());
      if (p.length < 3) throw new Error(`bad var line: ${v.slice(0, 40)}`);
      const [key, type, label_en, label_es = label_en, def = '', opts = '', req = ''] = p;
      const o = { key, type, label: { en: label_en, es: label_es || label_en } };
      if (def) o.default = def;
      if (opts) o.options = opts.split(';').map((x) => x.trim()).filter(Boolean);
      if (/^(required|true|yes|1)$/i.test(req)) o.required = true;
      vars.push(o);
    } else meta[k] = v;
  }
  const t = {
    id: meta.id,
    source,
    name: { en: meta.name_en ?? meta.name ?? '', es: meta.name_es ?? meta.name_en ?? '' },
    description: { en: meta.description_en ?? meta.description ?? '', es: meta.description_es ?? meta.description_en ?? '' },
    tags: (meta.tags ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    body: m[2].replace(/^\n+/, '').replace(/\s+$/, ''),
    vars,
  };
  return t;
}

/** Inverse of parseTemplate. */
export function serializeTemplate(t) {
  const lines = ['---', `id: ${t.id}`,
    `name_en: ${oneLine(t.name.en)}`, `name_es: ${oneLine(t.name.es)}`,
    `description_en: ${oneLine(t.description.en)}`, `description_es: ${oneLine(t.description.es)}`,
    `tags: ${t.tags.map(oneLine).join(', ')}`];
  for (const v of t.vars) {
    lines.push(`var: ${[v.key, v.type, oneLine(v.label.en), oneLine(v.label.es), oneLine(v.default ?? ''),
      (v.options ?? []).map(oneLine).join(';'), v.required ? 'required' : ''].join(' | ').replace(/ +$/, '')}`);
  }
  lines.push('---', '', t.body.replace(/\s+$/, ''), '');
  return lines.join('\n');
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function str(v, max, what, { allowEmpty = false } = {}) {
  if (typeof v !== 'string' || (!allowEmpty && !v.trim())) throw new TypeError(`${what} must be a non-empty string`);
  if (v.length > max) throw new TypeError(`${what} too long (max ${max})`);
  if (/[\r\n]/.test(v) && max < LIM.body) throw new TypeError(`${what} must be a single line`);
  return v;
}

/** Validate and normalise a user-supplied template. Throws TypeError with a clear message. */
export function validateTemplate(t) {
  if (!isObj(t)) throw new TypeError('template required');
  if (typeof t.id !== 'string' || !ID_RE.test(t.id)) throw new TypeError('invalid id (a-z, 0-9, dash; max 64)');
  if (!isObj(t.name) || !isObj(t.description)) throw new TypeError('name and description must be {en, es}');
  const out = {
    id: t.id, source: 'user',
    name: { en: str(t.name.en, LIM.name, 'name.en'), es: str(t.name.es ?? t.name.en, LIM.name, 'name.es') },
    description: {
      en: str(t.description.en ?? '', LIM.desc, 'description.en', { allowEmpty: true }),
      es: str(t.description.es ?? t.description.en ?? '', LIM.desc, 'description.es', { allowEmpty: true }),
    },
    tags: [], body: str(t.body, LIM.body, 'body'), vars: [],
  };
  if (t.tags !== undefined) {
    if (!Array.isArray(t.tags) || t.tags.length > LIM.tags) throw new TypeError('invalid tags');
    out.tags = t.tags.map((x) => str(x, LIM.tag, 'tag').replace(/,/g, ' ').trim());
  }
  if (t.vars !== undefined) {
    if (!Array.isArray(t.vars) || t.vars.length > LIM.vars) throw new TypeError('invalid vars');
    const seen = new Set();
    for (const v of t.vars) {
      if (!isObj(v) || typeof v.key !== 'string' || !KEY_RE.test(v.key)) throw new TypeError('invalid var key');
      if (seen.has(v.key)) throw new TypeError(`duplicate var ${v.key}`);
      seen.add(v.key);
      if (!TYPES.includes(v.type)) throw new TypeError(`invalid var type for ${v.key}`);
      const lab = isObj(v.label) ? v.label : { en: v.key, es: v.key };
      const nv = { key: v.key, type: v.type, label: { en: str(lab.en, LIM.label, 'label.en'), es: str(lab.es ?? lab.en, LIM.label, 'label.es') } };
      const noPipe = (s, w) => { if (/[|;]/.test(s) && w === 'opt') throw new TypeError('options may not contain | or ;'); if (s.includes('|')) throw new TypeError(`${w} may not contain |`); return s; };
      noPipe(nv.label.en, 'label'); noPipe(nv.label.es, 'label');
      if (v.default !== undefined && v.default !== '') nv.default = noPipe(str(v.default, LIM.def, 'default'), 'default');
      if (v.type === 'select') {
        if (!Array.isArray(v.options) || !v.options.length || v.options.length > LIM.opts) throw new TypeError(`select ${v.key} needs options`);
        nv.options = v.options.map((o) => noPipe(str(o, LIM.opt, 'option'), 'opt'));
      }
      if (v.required) nv.required = true;
      out.vars.push(nv);
    }
  }
  return out;
}

/** Replace {{key}} placeholders. Missing keys are left untouched. */
export function fillTemplate(body, values) {
  return body.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (all, k) => (k in values ? String(values[k]) : all));
}

/**
 * Body for a Claude Code slash command (.claude/commands/<id>.md): the FIRST variable becomes `$ARGUMENTS`
 * (what the user types after /<id>); every other variable becomes an upper-case <KEY> hint the user can edit.
 */
export function commandBody(t) {
  const map = {};
  t.vars.forEach((v, i) => { map[v.key] = i === 0 ? '$ARGUMENTS' : `<${v.key.toUpperCase()}>`; });
  return fillTemplate(t.body, map);
}

export function createPrompts({ userDir, defaultDir = DEFAULT_DIR, fsx = fs } = {}) {
  const dir = path.join(userDir, 'prompts');

  function loadDir(d, source) {
    let names = [];
    try { names = fsx.readdirSync(d); } catch { return []; }
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.md')) continue;
      try {
        const t = parseTemplate(fsx.readFileSync(path.join(d, n), 'utf8'), source);
        if (typeof t.id === 'string' && ID_RE.test(t.id) && t.id === n.slice(0, -3)) out.push(t);
      } catch { /* skip malformed */ }
    }
    return out;
  }

  const list = () => {
    const map = new Map();
    for (const t of loadDir(defaultDir, 'default')) map.set(t.id, t);
    for (const t of loadDir(dir, 'user')) map.set(t.id, t);
    return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
  };

  return {
    list,
    save(t) {
      const v = validateTemplate(t);
      const text = serializeTemplate(v);
      if (Buffer.byteLength(text) > LIM.file) throw new TypeError('template too large');
      fsx.mkdirSync(dir, { recursive: true });
      fsx.writeFileSync(path.join(dir, `${v.id}.md`), text, 'utf8');
      return v;
    },
    delete(id) {
      if (typeof id !== 'string' || !ID_RE.test(id)) throw new TypeError('invalid id');
      const f = path.join(dir, `${id}.md`);
      if (!fsx.existsSync(f)) throw new Error('Only user templates can be deleted');
      fsx.unlinkSync(f);
    },
    /** Writes <project>/.claude/commands/<id>.md. An existing file is copied to <id>.md.bak first. */
    export(project, id) {
      if (typeof id !== 'string' || !ID_RE.test(id)) throw new TypeError('invalid id');
      const t = list().find((x) => x.id === id);
      if (!t) throw new Error('Unknown template');
      const cmdDir = path.join(project.path, '.claude', 'commands');
      fsx.mkdirSync(cmdDir, { recursive: true });
      const file = path.join(cmdDir, `${id}.md`);
      if (fsx.existsSync(file)) fsx.copyFileSync(file, `${file}.bak`);
      const desc = oneLine(t.description.en || t.name.en);
      fsx.writeFileSync(file, `---\ndescription: ${desc}\n---\n\n${commandBody(t)}\n`, 'utf8');
      return { path: path.posix.join('.claude', 'commands', `${id}.md`) };
    },
  };
}
