// File types the app can attach to a chat / load into a project (copied into the project's data folder; originals are never changed).
// Shared by the main process (imports) and the renderer (attach button, drop, validation).
export const DOC_EXT = Object.freeze([
  'xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'pptx', 'ppt', 'docx', 'doc', 'pdf', 'txt', 'md', 'json', 'xml', 'html', 'htm', 'rtf',
  'odt', 'ods', 'odp', 'yaml', 'yml', 'toml', 'ini', 'log', 'sql', 'py', 'js', 'ts',
]);
export const IMAGE_EXT = Object.freeze(['png', 'jpg', 'jpeg', 'gif', 'webp']);
export const MAX_DOC_BYTES = 200 * 1024 * 1024;
export const MAX_ATTACH = 5;

export const extOf = (name) => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name ?? '')); return m ? m[1].toLowerCase() : ''; };
export const isDocName = (name) => DOC_EXT.includes(extOf(name));
export const isImageName = (name) => IMAGE_EXT.includes(extOf(name));

/** `accept` value for the HTML file input: documents plus images. */
export const ATTACH_ACCEPT = [...DOC_EXT.map((e) => `.${e}`), 'image/png', 'image/jpeg', 'image/gif', 'image/webp'].join(',');

/**
 * Text appended to the prompt so the agent knows which project files the user attached and how to read them.
 * rels: project-relative paths (already copied into the project).
 */
export function attachNote(rels) {
  const list = (Array.isArray(rels) ? rels : []).filter((r) => typeof r === 'string' && r);
  if (!list.length) return '';
  const hints = [];
  const exts = new Set(list.map(extOf));
  if ([...exts].some((e) => ['xlsx', 'xlsm', 'xls', 'ods'].includes(e))) hints.push('openpyxl or pandas for spreadsheets');
  if ([...exts].some((e) => ['pptx', 'ppt', 'odp'].includes(e))) hints.push('python-pptx for presentations');
  if ([...exts].some((e) => ['docx', 'doc', 'odt', 'rtf'].includes(e))) hints.push('python-docx for documents');
  if (exts.has('pdf')) hints.push('a PDF reader for PDFs');
  const how = hints.length ? ` Read them with the right tool (for example ${hints.join(', ')}); plain text, CSV and Markdown can be read directly.` : '';
  return `\n\n[Attached files, already in this project: ${list.join(', ')}.${how} Never change the originals: work on copies.]`;
}
