// Project title -> safe folder name, one rule used by main and renderer.
//   "Análisis de ventas 2026"  ->  "Analisis_De_Ventas_2026"
// Rules: accents/diacritics removed (n-tilde -> n), every run of characters that is not A-Z a-z 0-9 becomes a word break,
// each word gets a capital first letter (the rest is kept as typed, so "CSV" stays "CSV"), words are joined with '_',
// max 60 chars (cut at a word boundary when possible), no trailing '_', never a Windows reserved device name
// (CON, PRN, AUX, NUL, COM1-9, LPT1-9) and never empty.

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export const MAX_FOLDER_NAME = 60;

export function folderNameFromTitle(title, lang = 'en', max = MAX_FOLDER_NAME) {
  const ascii = String(title ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const words = ascii.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  let name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('_');
  if (name.length > max) {
    const cut = name.slice(0, max);
    const atWord = cut.lastIndexOf('_');
    name = atWord >= Math.floor(max / 2) ? cut.slice(0, atWord) : cut;
  }
  name = name.replace(/_+$/, '');
  const fallback = lang === 'es' ? 'Proyecto' : 'Project';
  if (!name) return fallback;
  if (RESERVED.test(name)) return `${fallback}_${name}`;
  return name;
}

/** name, name_2, name_3 ... until `exists(candidate)` is false (exists: (string) => boolean, case-insensitive on Windows is the caller's job). */
export function uniqueFolderName(name, exists, limit = 999) {
  if (!exists(name)) return name;
  for (let i = 2; i <= limit; i++) {
    const cand = `${name}_${i}`;
    if (!exists(cand)) return cand;
  }
  throw new Error('could not find a free folder name');
}
