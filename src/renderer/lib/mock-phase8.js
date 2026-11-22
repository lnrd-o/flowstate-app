// Phase 8 part of the browser mock: the 10 office "case" methodologies, files.pick / files.import, projects.defaultDir / newDir.
import { folderNameFromTitle } from '../../shared/folder-name.js';

const DIR = 'C:\\Users\\leo\\Documents\\FlowState';
const iso = (d) => new Date(d).toISOString();
const L = (en, es) => ({ en, es });

const file = (key, en, es, required = true) => ({ key, label: L(en, es), type: 'file', required });
const goal = (en, es, phEn, phEs) => ({ key: 'goal', label: L(en, es), type: 'textarea', required: true, placeholder: L(phEn, phEs) });
const pick = (key, en, es, options, def) => ({ key, label: L(en, es), type: 'select', options, default: def || options[0] });

function mk(id, category, ic, name, desc, vars, text, tags = []) {
  return {
    id, version: 1, source: 'bundled', name, description: desc, tags, meta: { kind: 'case', category, icon: ic }, vars,
    nodes: [
      { id: 'n1', type: 'prompt', title: L('Do the work', 'Hacer el trabajo'), text, mode: 'acceptEdits' },
      { id: 'n2', type: 'checkpoint', title: L('Review the result', 'Revisar el resultado'), message: 'Does the result look right?' },
    ],
    edges: [{ from: 'n1', to: 'n2' }],
    createdAt: iso(Date.now() - 30 * 86400000), updatedAt: iso(Date.now() - 2 * 86400000),
  };
}

export const CASES = [
  mk('case-excel-analyze', 'excel', 'table', L('Analyze an Excel file', 'Analizar un archivo de Excel'),
    L('Find totals, trends and problems in a spreadsheet and explain them in plain words.', 'Encuentra totales, tendencias y problemas en una hoja de c\u00e1lculo y expl\u00edcalos en palabras simples.'),
    [file('input', 'Excel file', 'Archivo de Excel'), goal('What do you want to know?', '\u00bfQu\u00e9 quieres saber?', 'Example: which products sell best each month?', 'Ejemplo: \u00bfqu\u00e9 productos se venden m\u00e1s cada mes?'), pick('depth', 'Detail', 'Detalle', ['short', 'normal', 'deep'], 'normal')],
    'Open {{input}} and answer: {{goal}}. Detail level: {{depth}}. Save a summary in report.md.', ['excel']),
  mk('case-excel-build', 'excel', 'table', L('Build a new Excel file', 'Crear un Excel nuevo'),
    L('Describe the sheet you need and get a ready-to-use workbook with formulas.', 'Describe la hoja que necesitas y recibe un libro listo para usar, con f\u00f3rmulas.'),
    [goal('What should the sheet do?', '\u00bfQu\u00e9 debe hacer la hoja?', 'Example: a monthly budget with totals and a chart', 'Ejemplo: un presupuesto mensual con totales y una gr\u00e1fica'), pick('style', 'Look', 'Aspecto', ['simple', 'with charts'], 'simple')],
    'Create workbook.xlsx that does: {{goal}}. Style: {{style}}.', ['excel']),
  mk('case-excel-clean', 'excel', 'table', L('Clean up or merge spreadsheets', 'Limpiar o unir hojas de c\u00e1lculo'),
    L('Remove duplicates, fix formats and combine data into one tidy sheet.', 'Quita duplicados, arregla formatos y junta los datos en una sola hoja ordenada.'),
    [file('input', 'Spreadsheet', 'Hoja de c\u00e1lculo'), goal('What needs fixing?', '\u00bfQu\u00e9 hay que arreglar?', 'Example: dates are mixed and some rows are repeated', 'Ejemplo: las fechas est\u00e1n mezcladas y hay filas repetidas')],
    'Clean {{input}}: {{goal}}. Save the result as clean.xlsx and keep the original untouched.', ['excel']),
  mk('case-web-page', 'web', 'globe', L('Build an HTML page', 'Crear una p\u00e1gina HTML'),
    L('A simple web page from your description: one file you can open in any browser.', 'Una p\u00e1gina web sencilla a partir de tu descripci\u00f3n: un solo archivo que abre cualquier navegador.'),
    [goal('What should the page show?', '\u00bfQu\u00e9 debe mostrar la p\u00e1gina?', 'Example: a one-page menu for my caf\u00e9 with prices', 'Ejemplo: un men\u00fa de una p\u00e1gina para mi caf\u00e9 con precios'), pick('look', 'Look', 'Aspecto', ['clean', 'colorful', 'dark'], 'clean')],
    'Create index.html: {{goal}}. Look: {{look}}. No external libraries.', ['html', 'web']),
  mk('case-data-analysis', 'data', 'chart', L('Analyze a TXT or CSV file', 'Analizar un archivo TXT o CSV'),
    L('Understand a data file: columns, patterns, outliers and a short written report.', 'Entiende un archivo de datos: columnas, patrones, valores raros y un breve informe.'),
    [file('data', 'Data file (TXT or CSV)', 'Archivo de datos (TXT o CSV)'), goal('What is the question?', '\u00bfCu\u00e1l es la pregunta?', 'Example: why did sales drop in March?', 'Ejemplo: \u00bfpor qu\u00e9 bajaron las ventas en marzo?')],
    'Analyze {{data}} to answer: {{goal}}. Write analysis.md with findings and charts.', ['csv', 'data']),
  mk('case-data-dashboard', 'dashboard', 'chart', L('Dashboard from a TXT or CSV file', 'Dashboard desde un archivo TXT o CSV'),
    L('Turn a data file into an interactive dashboard with charts and filters.', 'Convierte un archivo de datos en un dashboard interactivo con gr\u00e1ficas y filtros.'),
    [file('data', 'Data file (TXT or CSV)', 'Archivo de datos (TXT o CSV)'), goal('What should it show?', '\u00bfQu\u00e9 debe mostrar?', 'Example: sales by region and month, with a filter by product', 'Ejemplo: ventas por regi\u00f3n y mes, con filtro por producto'), pick('style', 'Style', 'Estilo', ['minimal', 'detailed', 'executive'], 'minimal')],
    'Build a {{style}} dashboard from {{data}} showing: {{goal}}.', ['dashboard', 'python']),
  mk('case-research-topic', 'research', 'search', L('Research something online', 'Investigar algo en internet'),
    L('Search the web, compare sources and get a short report with links.', 'Busca en la web, compara fuentes y recibe un informe corto con enlaces.'),
    [goal('What do you want to find out?', '\u00bfQu\u00e9 quieres averiguar?', 'Example: best laptops under 800 dollars for video editing', 'Ejemplo: las mejores laptops de menos de 800 d\u00f3lares para editar video'), pick('length', 'Report size', 'Tama\u00f1o del informe', ['short', 'normal', 'long'], 'normal')],
    'Research online: {{goal}}. Write research.md ({{length}}) with sources and links.', ['research']),
  mk('case-doc-summary', 'document', 'file-text', L('Summarize a document', 'Resumir un documento'),
    L('Read a PDF, Word or text file and get the key points and next steps.', 'Lee un PDF, Word o texto y obt\u00e9n los puntos clave y los siguientes pasos.'),
    [file('doc', 'Document', 'Documento'), pick('format', 'Summary as', 'Resumen en', ['bullets', 'one page', 'email'], 'bullets')],
    'Summarize {{doc}} as {{format}} and save it in summary.md.', ['document']),
  mk('case-automation', 'automation', 'zap', L('Automate a repeated task', 'Automatizar una tarea repetitiva'),
    L('Describe a chore you do often and get a script that does it for you.', 'Describe una tarea que haces seguido y recibe un script que la hace por ti.'),
    [goal('What do you repeat?', '\u00bfQu\u00e9 repites?', 'Example: rename photos by date and move them to folders', 'Ejemplo: renombrar fotos por fecha y moverlas a carpetas')],
    'Write a small script that automates: {{goal}}. Explain how to run it in README.md.', ['automation']),
  mk('case-organize', 'other', 'folder', L('Organize my files', 'Organizar mis archivos'),
    L('Look at a messy folder of documents and propose a clean structure.', 'Revisa una carpeta desordenada y propone una estructura limpia.'),
    [file('sample', 'A file from the folder (optional)', 'Un archivo de la carpeta (opcional)', false), goal('How do you want it organized?', '\u00bfC\u00f3mo quieres organizarla?', 'Example: by client and year', 'Ejemplo: por cliente y a\u00f1o')],
    'Propose a folder structure for: {{goal}}. Example file: {{sample}}.', ['files']),
];

export function createPhase8() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return {
    cases: CASES,
    files: {
      pick: async ({ kind } = {}) => {
        await sleep(120);
        const names = { office: 'sales-2026.xlsx', data: 'orders.csv', any: 'notes.txt' };
        return ['C:\\Users\\leo\\Documents\\' + (names[kind] || names.office)];
      },
      import: async (_projectId, abs) => {
        await sleep(150);
        const name = String(abs).split(/[\\/]/).pop();
        return { rel: 'data/' + name, name, size: 48213 };
      },
    },
    projects: {
      defaultDir: async () => DIR,
      newDir: async (name) => { const folder = folderNameFromTitle(name); return { path: DIR + '\\' + folder, folder }; },
    },
  };
}
