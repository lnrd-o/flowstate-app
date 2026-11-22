// One-off generator for the bundled office case methodologies (methodologies/*.json). Run: node scripts/gen-cases.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMethodology, undeclaredVars } from '../src/shared/methodology.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'methodologies');

const RULES = `GROUND RULES (follow strictly):
- Any user-provided input file lives in data/ inside this project. NEVER modify, move or delete the originals: work on copies inside the project.
- Put every deliverable in artifacts/ (create the folder if needed). Do not write deliverables anywhere else.
- Prefer Python. Create a virtual environment (python -m venv .venv) and pip install ONLY what you need from: openpyxl pandas xlsxwriter matplotlib python-docx. If Python is not installed or cannot be run, say so plainly in one short message and STOP (do not try to install Python yourself).
- Do not ask questions mid-way unless you are truly blocked. Instead, make sensible choices and write your assumptions down in the deliverable and in your final message.
- Write the deliverables and the final message in the same language as the user's request (Spanish or English).
- Be safe: do not run anything destructive, do not touch files outside this project, do not send data over the network (except where this task explicitly needs web search).
- FINISH with a short plain-language summary for a non-technical person: what you produced, where it is (exact paths under artifacts/), the assumptions you made, and anything they should double-check.`;

const fileVar = (key, en, es, required = true) => ({ key, label: { en, es }, type: 'file', required, ...(required ? {} : { default: '' }) });
const textarea = (key, en, es, required = true) => ({ key, label: { en, es }, type: 'textarea', required, ...(required ? {} : { default: '' }) });
const select = (key, en, es, options, def) => ({ key, label: { en, es }, type: 'select', options, default: def ?? options[0] });

function mk({ id, category, icon, name, description, tags = [], vars, work, deliverable, checkTitle, reviewMsg, commitMsg }) {
  return {
    id, version: 1, source: 'bundled', name, description,
    tags: ['case', ...tags],
    meta: { kind: 'case', category, icon },
    vars,
    nodes: [
      { id: 'work', type: 'prompt', title: work.title, text: `${work.text}\n\n${RULES}` },
      { id: 'check', type: 'artifact', title: checkTitle, path: deliverable },
      { id: 'review', type: 'checkpoint', title: { en: 'Review the result', es: 'Revisa el resultado' }, message: reviewMsg },
      { id: 'save', type: 'git-commit', title: { en: 'Save a version', es: 'Guardar una versión' }, message: commitMsg },
    ],
    edges: [{ from: 'work', to: 'check' }, { from: 'check', to: 'review' }, { from: 'review', to: 'save' }],
  };
}

const cases = [
  mk({
    id: 'excel-clean-summarize', category: 'excel', icon: 'table', tags: ['excel', 'clean'],
    name: { en: 'Clean up and summarise my Excel/CSV', es: 'Limpiar y resumir mi Excel/CSV' },
    description: { en: 'Cleans a messy spreadsheet, removes duplicates, fixes data types and adds a summary sheet with formulas and charts.', es: 'Limpia una hoja de cálculo desordenada, quita duplicados, corrige tipos de datos y agrega una hoja de resumen con fórmulas y gráficos.' },
    vars: [
      fileVar('inputFile', 'Your Excel or CSV file', 'Tu archivo de Excel o CSV'),
      textarea('goal', 'What do you want to see in the summary?', '¿Qué quieres ver en el resumen?'),
    ],
    work: {
      title: { en: 'Clean and summarise', es: 'Limpiar y resumir' },
      text: `The user gave you the spreadsheet {{inputFile}} (inside data/). Their goal: {{goal}}

Do this:
1. Inspect the file first (sheets, headers, column types, blank rows, merged cells, obvious errors). Never change the original in data/.
2. Work on a copy. Clean it: trim spaces, fix inconsistent capitalisation, standardise dates and numbers, convert text-numbers to real numbers, remove empty rows and exact duplicate rows, and handle missing values in a sensible, documented way. Keep a count of every kind of fix.
3. Build artifacts/<original-name>-clean.xlsx (use the original file name without extension) with: a 'Clean data' sheet (formatted header, frozen top row, filters, sensible column widths), a 'Summary' sheet answering the user's goal using real Excel formulas (SUMIFS, COUNTIFS, AVERAGEIFS or a pivot-style table), at least one chart that fits the goal, and a 'Notes' sheet listing every cleaning step with counts and your assumptions.
4. Verify the workbook opens and the formulas have no errors.`,
    },
    deliverable: 'artifacts', checkTitle: { en: 'Clean workbook exists', es: 'Existe el libro limpio' },
    reviewMsg: 'Open the clean workbook in artifacts/ and check the Summary and Notes sheets. Approve if it looks right.',
    commitMsg: 'Clean and summarise spreadsheet',
  }),
  mk({
    id: 'excel-build', category: 'excel', icon: 'table', tags: ['excel', 'build'],
    name: { en: 'Build an Excel workbook', es: 'Crear un libro de Excel' },
    description: { en: 'Builds a ready-to-use workbook (budget, tracker, invoice, schedule, inventory...) with formulas, formatting and validation.', es: 'Arma un libro de Excel listo para usar (presupuesto, seguimiento, factura, calendario, inventario...) con fórmulas, formato y validación.' },
    vars: [
      textarea('description', 'Describe the workbook you need', 'Describe el libro que necesitas'),
      select('kind', 'Type of workbook', 'Tipo de libro', ['budget', 'tracker', 'invoice', 'schedule', 'inventory', 'other'], 'tracker'),
    ],
    work: {
      title: { en: 'Build the workbook', es: 'Crear el libro' },
      text: `Build an Excel workbook of type '{{kind}}'. What the user needs: {{description}}

Do this:
1. Decide the sheets and columns that fit the request. Add a few realistic example rows so it is easy to see how it works (clearly marked as examples).
2. Use real Excel formulas for every calculation (totals, balances, status, dates), never hard-coded results. Use named header styles, number/currency/date formats, frozen header rows, filters, column widths and conditional formatting where it helps.
3. Add data validation (drop-down lists for categories and statuses, date and number limits) so users cannot easily enter bad data.
4. Add a first sheet called 'Instructions' explaining in plain language how to use each sheet, which cells to fill in, and which cells are calculated (do not type over them).
5. Save as artifacts/workbook.xlsx. Verify it opens and that no formula shows an error.`,
    },
    deliverable: 'artifacts/workbook.xlsx', checkTitle: { en: 'workbook.xlsx exists', es: 'Existe workbook.xlsx' },
    reviewMsg: 'Open artifacts/workbook.xlsx in Excel, read the Instructions sheet and try it. Approve if it fits.',
    commitMsg: 'Add Excel workbook',
  }),
  mk({
    id: 'excel-formulas', category: 'excel', icon: 'edit', tags: ['excel', 'formulas'],
    name: { en: 'Fix or explain my spreadsheet formulas', es: 'Corregir o explicar las fórmulas de mi hoja' },
    description: { en: 'Audits the formulas in a workbook, explains them in plain language, fixes errors and delivers a corrected copy plus a report.', es: 'Revisa las fórmulas de un libro, las explica en palabras simples, corrige errores y entrega una copia corregida más un informe.' },
    vars: [
      fileVar('inputFile', 'Your Excel file', 'Tu archivo de Excel'),
      textarea('question', 'What is wrong, or what do you want to understand?', '¿Qué está fallando o qué quieres entender?'),
    ],
    work: {
      title: { en: 'Audit and fix formulas', es: 'Revisar y corregir fórmulas' },
      text: `The user gave you the workbook {{inputFile}} (inside data/). Their question: {{question}}

Do this:
1. Read every sheet with openpyxl (formulas, not only values) and list the formulas, grouped by pattern. Never change the original in data/.
2. Audit them: errors (#REF!, #DIV/0!, #N/A, #VALUE!), inconsistent formulas inside a column, hard-coded numbers inside formulas, ranges that miss rows, text stored as numbers, circular or fragile references, and volatile or slow patterns.
3. Explain the important formulas in plain, non-technical language, answering the user's question directly.
4. Write artifacts/formulas-report.md with: a short answer to the question, a table (sheet, cell, original formula, what it does, problem found, fixed formula), and any assumptions.
5. Save a corrected copy as artifacts/<original-name>-corrected.xlsx with the fixes applied (keep formatting) and changed cells highlighted in light yellow. If a fix is uncertain, leave the cell as is and flag it in the report.`,
    },
    deliverable: 'artifacts/formulas-report.md', checkTitle: { en: 'Formulas report exists', es: 'Existe el informe de fórmulas' },
    reviewMsg: 'Read artifacts/formulas-report.md and open the corrected copy. Approve if the fixes look right.',
    commitMsg: 'Audit spreadsheet formulas',
  }),
  mk({
    id: 'html-page', category: 'web', icon: 'globe', tags: ['web', 'html'],
    name: { en: 'Create an HTML page', es: 'Crear una página HTML' },
    description: { en: 'Creates one self-contained, responsive HTML page you can open by double-clicking it.', es: 'Crea una página HTML responsiva y autocontenida que puedes abrir con doble clic.' },
    vars: [
      textarea('what', 'What should the page show or do?', '¿Qué debe mostrar o hacer la página?'),
      select('audience', 'Who is it for?', '¿Para quién es?', ['general public', 'customers', 'my team', 'executives', 'students'], 'general public'),
      select('style', 'Visual style', 'Estilo visual', ['clean and modern', 'corporate', 'playful', 'minimal', 'dark'], 'clean and modern'),
      fileVar('inputFile', 'Optional: a file with content or data (leave empty if none)', 'Opcional: un archivo con contenido o datos (déjalo vacío si no tienes)', false),
    ],
    work: {
      title: { en: 'Write the page', es: 'Escribir la página' },
      text: `Create ONE self-contained, responsive HTML page. What it should show or do: {{what}}
Audience: {{audience}}. Visual style: {{style}}.
Optional content file (ignore if empty): {{inputFile}} (inside data/; read it and use its content, never modify it).

Requirements:
- A single file, artifacts/index.html, with all CSS and JavaScript inline. No external network at all: no CDN, no web fonts, no remote images (use system fonts, inline SVG or CSS shapes).
- Responsive (works on phone and desktop), accessible (semantic HTML, good contrast, alt text, keyboard friendly) and printable.
- Real, sensible content written for the audience (no lorem ipsum). If you invent placeholder text or numbers, mark them clearly so the user can replace them.
- Keep the code tidy and commented where the user may want to edit text or colours.
- Add a short artifacts/HOW-TO-OPEN.md explaining how to open the page (double-click index.html), how to change the text and colours, and how to share it.`,
    },
    deliverable: 'artifacts/index.html', checkTitle: { en: 'index.html exists', es: 'Existe index.html' },
    reviewMsg: 'Open artifacts/index.html in your browser and check it. Approve if it is what you wanted.',
    commitMsg: 'Add HTML page',
  }),
  mk({
    id: 'data-analysis', category: 'data', icon: 'chart', tags: ['data', 'analysis'],
    name: { en: 'Analyze a CSV or text file', es: 'Analizar un CSV o archivo de texto' },
    description: { en: 'Profiles your data, answers your question and writes a report with charts.', es: 'Revisa tus datos, responde tu pregunta y escribe un informe con gráficos.' },
    vars: [
      fileVar('inputFile', 'Your data file (CSV, TSV, TXT, JSON or Excel)', 'Tu archivo de datos (CSV, TSV, TXT, JSON o Excel)'),
      textarea('question', 'What do you want to find out?', '¿Qué quieres averiguar?'),
    ],
    work: {
      title: { en: 'Analyse the data', es: 'Analizar los datos' },
      text: `Analyse the data file {{inputFile}} (inside data/) to answer this question: {{question}}

Do this:
1. Profile the data first: rows, columns, types, missing values, duplicates, ranges, odd values and outliers. Do not modify the original.
2. Answer the question with evidence: the numbers, comparisons and trends that matter. Be honest about limits (small samples, missing data, correlation is not causation).
3. Make 2 to 5 clear charts with matplotlib, saved as PNG in artifacts/ (titles, labelled axes, readable fonts).
4. Write artifacts/report.md: the short answer first, then data overview, method in plain words, findings with the charts embedded, caveats and suggested next steps. Also write artifacts/report.html as a single self-contained version (charts embedded as base64 images) that opens offline.`,
    },
    deliverable: 'artifacts/report.md', checkTitle: { en: 'report.md exists', es: 'Existe report.md' },
    reviewMsg: 'Read artifacts/report.md (or open report.html) and check the findings. Approve if they make sense.',
    commitMsg: 'Add data analysis report',
  }),
  mk({
    id: 'dashboard', category: 'dashboard', icon: 'chart', tags: ['dashboard', 'data'],
    name: { en: 'Make a dashboard from my data', es: 'Crear un panel (dashboard) con mis datos' },
    description: { en: 'Builds one offline HTML dashboard with KPI cards, charts and filters from your data file.', es: 'Arma un dashboard HTML que funciona sin internet, con tarjetas de indicadores, gráficos y filtros a partir de tus datos.' },
    vars: [
      fileVar('inputFile', 'Your data file (CSV or Excel)', 'Tu archivo de datos (CSV o Excel)'),
      textarea('what', 'What should the dashboard show?', '¿Qué debe mostrar el dashboard?'),
    ],
    work: {
      title: { en: 'Build the dashboard', es: 'Construir el dashboard' },
      text: `Build a dashboard from the data file {{inputFile}} (inside data/). What it should show: {{what}}

Requirements:
- ONE self-contained HTML file: artifacts/dashboard.html. Embed the data (aggregated if large) as JSON inside the file, and draw the charts with inline JavaScript using SVG or canvas. No external network: no CDN, no web fonts. It must work offline by double-clicking.
- A row of KPI cards for the key numbers, 3 to 5 charts that fit the data (bars, lines, pie/donut only if few categories), a sortable table of the details, and filters (for example by date range and category) that update every chart and KPI.
- Clean, accessible design: readable colours with good contrast, labelled axes, tooltips on hover, responsive layout, sensible number and date formats.
- Read the data with Python (pandas), clean it on a copy (never change the original), and generate the HTML from a small script saved in artifacts/build_dashboard.py so it can be regenerated.
- Optional extra only: at the end, mention in one sentence that a Streamlit version is possible if the user later wants a live app. Do not build it unless asked.`,
    },
    deliverable: 'artifacts/dashboard.html', checkTitle: { en: 'dashboard.html exists', es: 'Existe dashboard.html' },
    reviewMsg: 'Open artifacts/dashboard.html in your browser, try the filters and check the numbers. Approve if it is right.',
    commitMsg: 'Add dashboard',
  }),
  mk({
    id: 'online-research', category: 'research', icon: 'search', tags: ['research', 'web'],
    name: { en: 'Research a topic online', es: 'Investigar un tema en internet' },
    description: { en: 'Searches the web, cross-checks several sources and writes a cited research note with a sources list.', es: 'Busca en la web, contrasta varias fuentes y escribe una nota de investigación con citas y lista de fuentes.' },
    vars: [
      textarea('topic', 'What do you want to research?', '¿Qué quieres investigar?'),
      select('depth', 'How deep?', '¿Qué tan a fondo?', ['quick', 'standard', 'deep'], 'standard'),
      select('audience', 'Who will read it?', '¿Quién lo va a leer?', ['general public', 'my team', 'executives', 'technical experts'], 'general public'),
    ],
    work: {
      title: { en: 'Research and write', es: 'Investigar y redactar' },
      text: `Research this topic online: {{topic}}
Depth: {{depth}} (quick = about 5 sources, standard = about 10, deep = 20 or more). Audience: {{audience}}.

Use your web search and web fetch tools. Rules for honest research:
- Check at least 3 independent sources for each key claim. Independent means not copies of each other. Prefer primary and official sources, then reputable publications. Be wary of blogs, marketing pages and undated content.
- Mark uncertainty explicitly: 'confirmed by several sources', 'single source', 'sources disagree'. Report disagreements instead of hiding them.
- NEVER invent sources, quotes, numbers or URLs. If you could not verify something, say so.
- Cite every source with its URL and the date you accessed it. Do not copy long passages; summarise in your own words.

Deliverables:
- artifacts/research.md: summary first (5 lines), then key findings with inline citations like [1], [2], then open questions and limits, then the numbered source list.
- artifacts/sources.csv with columns: id, title, publisher, url, date_published, date_accessed, reliability_note, claims_supported.
If web tools are unavailable, say so plainly and stop instead of answering from memory.`,
    },
    deliverable: 'artifacts/research.md', checkTitle: { en: 'research.md exists', es: 'Existe research.md' },
    reviewMsg: 'Read artifacts/research.md and spot-check a few sources from sources.csv. Approve if you trust it.',
    commitMsg: 'Add online research',
  }),
  mk({
    id: 'document-from-notes', category: 'document', icon: 'file-text', tags: ['document', 'writing'],
    name: { en: 'Turn notes into a report, summary or email', es: 'Convertir notas en informe, resumen o correo' },
    description: { en: 'Turns your notes (pasted or from a file) into a polished report, executive summary, email, minutes or presentation outline.', es: 'Convierte tus notas (pegadas o de un archivo) en un informe, resumen ejecutivo, correo, minuta o esquema de presentación.' },
    vars: [
      textarea('notes', 'Paste your notes here (or pick a file below)', 'Pega tus notas aquí (o elige un archivo abajo)', false),
      fileVar('inputFile', 'Optional: a file with your notes', 'Opcional: un archivo con tus notas', false),
      select('format', 'What do you need?', '¿Qué necesitas?', ['report', 'executive summary', 'email', 'meeting minutes', 'presentation outline'], 'report'),
      select('tone', 'Tone', 'Tono', ['professional', 'friendly', 'formal', 'persuasive'], 'professional'),
      select('length', 'Length', 'Extensión', ['short', 'medium', 'long'], 'medium'),
    ],
    work: {
      title: { en: 'Write the document', es: 'Escribir el documento' },
      text: `Turn the user's notes into a {{format}}. Tone: {{tone}}. Length: {{length}}.

Pasted notes (may be empty): {{notes}}
Notes file (may be empty): {{inputFile}} (inside data/; read it, never modify it). If both are empty, say so plainly and stop.

Do this:
1. Read everything and identify the goal, audience, key points, decisions, numbers, names, dates and action items. Do not invent facts: if something is missing or unclear, mark it as [TO CONFIRM] in the text and list it at the end.
2. Structure it for the chosen format (report: summary, sections, conclusions; executive summary: one page max with the decision/ask first; email: subject line plus body; meeting minutes: attendees if known, decisions, action items with owner and date; presentation outline: slide-by-slide titles with 3 bullets and speaker notes).
3. Write artifacts/document.md. If python-docx can be installed, also produce artifacts/document.docx with proper headings, lists and readable styling.
4. End the document with a short 'Assumptions and items to confirm' section.`,
    },
    deliverable: 'artifacts/document.md', checkTitle: { en: 'document.md exists', es: 'Existe document.md' },
    reviewMsg: 'Read artifacts/document.md (or the .docx) and check the [TO CONFIRM] items. Approve if it is ready.',
    commitMsg: 'Add document from notes',
  }),
  mk({
    id: 'clean-merge-files', category: 'data', icon: 'folder', tags: ['data', 'merge'],
    name: { en: 'Clean and merge several files', es: 'Limpiar y combinar varios archivos' },
    description: { en: 'Combines two files into one tidy table and documents every change.', es: 'Combina dos archivos en una sola tabla ordenada y documenta cada cambio.' },
    vars: [
      fileVar('fileA', 'First file', 'Primer archivo'),
      fileVar('fileB', 'Second file', 'Segundo archivo'),
      textarea('matchBy', 'How should the rows be matched? (e.g. same customer ID, or just stack them)', '¿Cómo se deben emparejar las filas? (p. ej. mismo ID de cliente, o solo apilarlas)'),
    ],
    work: {
      title: { en: 'Clean and merge', es: 'Limpiar y combinar' },
      text: `Combine two files into one tidy table. First file: {{fileA}}. Second file: {{fileB}} (both inside data/). How to match rows: {{matchBy}}

Do this:
1. Inspect both files (sheets, headers, types, duplicates, blanks, different spellings of the same thing). Never change the originals.
2. Clean copies: trim spaces, standardise names, dates, numbers and codes, align column names that mean the same thing, and remove exact duplicates.
3. Merge as the user described. Keep unmatched rows (do not silently drop data) and add a column 'source' or 'match_status' showing where each row came from or whether it matched. Report how many rows matched, only-in-A and only-in-B.
4. Write artifacts/merged.xlsx with a 'Merged' sheet (formatted, filters, frozen header) and a 'Changes' sheet with the counts of each fix.
5. Write artifacts/changes.md: a change log in plain language (what was cleaned, what was merged, how conflicts were resolved, rows needing human review) plus your assumptions.`,
    },
    deliverable: 'artifacts/merged.xlsx', checkTitle: { en: 'merged.xlsx exists', es: 'Existe merged.xlsx' },
    reviewMsg: 'Open artifacts/merged.xlsx and read artifacts/changes.md. Approve if the merge is right.',
    commitMsg: 'Clean and merge files',
  }),
  mk({
    id: 'automate-task', category: 'automation', icon: 'zap', tags: ['automation', 'python'],
    name: { en: 'Automate a repetitive task', es: 'Automatizar una tarea repetitiva' },
    description: { en: 'Writes a small, safe Python script with a dry-run mode that shows what it would change before touching anything.', es: 'Escribe un script pequeño y seguro en Python con modo de prueba (dry-run) que muestra qué cambiaría antes de tocar nada.' },
    vars: [
      textarea('description', 'Describe the task you repeat', 'Describe la tarea que repites'),
      fileVar('inputFile', 'Optional: an example file', 'Opcional: un archivo de ejemplo', false),
    ],
    work: {
      title: { en: 'Write the automation', es: 'Escribir la automatización' },
      text: `Automate this repetitive task with a small Python script: {{description}}
Optional example file (ignore if empty): {{inputFile}} (inside data/; study it, never modify it).

Design rules:
- Put everything in artifacts/automation/: the script (automation.py), a README.md and, if useful, a sample config.
- The script has a DRY-RUN mode that is the DEFAULT: it only prints/writes a clear table of what it WOULD change (which files or rows, old value, new value) and changes nothing. A real run needs an explicit flag such as --apply.
- When applied, it works on COPIES (for example into artifacts/automation/output/) and never overwrites or deletes the originals. Refuse to run if the output would overwrite an existing file.
- Use only the Python standard library plus openpyxl, pandas, xlsxwriter, matplotlib or python-docx if truly needed. Handle errors with friendly messages.
- First run the script yourself in dry-run mode on the example file (or on a small sample you create inside the project), show the user what it would change, and ONLY THEN run it with --apply on copies to confirm it works.
- README.md in plain language: what it does, how to install (python -m venv .venv, pip install ...), how to run dry-run and apply, how to undo (delete the output folder), and known limits.`,
    },
    deliverable: 'artifacts/automation', checkTitle: { en: 'Automation folder exists', es: 'Existe la carpeta de automatización' },
    reviewMsg: 'Read artifacts/automation/README.md and the dry-run output. Approve if the script does what you want.',
    commitMsg: 'Add automation script',
  }),
];

for (const c of cases) {
  const errs = validateMethodology(c);
  const und = undeclaredVars(c);
  if (errs.length || und.length) throw new Error(`${c.id}: ${errs.join('; ')} ${und.join(',')}`);
  fs.writeFileSync(path.join(OUT, `${c.id}.json`), `${JSON.stringify(c, null, 2)}\n`, 'utf8');
}
console.log(`wrote ${cases.length} cases`);
