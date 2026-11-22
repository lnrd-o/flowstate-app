// Project folder layout: inputs in data/, generated outputs in outputs/, code and scripts in the project root.
// Names follow the language the project was created in (English: data, outputs; Spanish: datos, salidas).
export const LAYOUTS = Object.freeze({
  en: Object.freeze({ data: 'data', outputs: 'outputs' }),
  es: Object.freeze({ data: 'datos', outputs: 'salidas' }),
});

/** Layout for a language ('es' -> Spanish names, anything else -> English). */
export const layoutFor = (lang) => (lang === 'es' ? LAYOUTS.es : LAYOUTS.en);

/** Pick the layout a project already uses (by existing folders), else the one for `lang`. exists(name) -> boolean. */
export function detectLayout(exists, lang) {
  for (const l of [LAYOUTS.es, LAYOUTS.en]) if (exists(l.data) || exists(l.outputs)) return l;
  return layoutFor(lang);
}

/** Prompt note that tells the agent where things go (the case prompts say data/ and outputs/; these are the real names). */
export function layoutNote(l) {
  return `[FlowState project layout] Input data goes in ${l.data}/, everything the code generates (reports, charts, exports, deliverables) goes in ${l.outputs}/, and code and scripts stay in the project root. Wherever instructions say data/ or outputs/, use ${l.data}/ and ${l.outputs}/. Prefer Python packages that are already installed globally; create a .venv only when a needed package is missing.`;
}
