// Copies browser-ready ESM builds from node_modules into src/renderer/vendor (no bundler, no CDN).
// Run: npm run vendor   (output is committed so the renderer loads offline)
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const nm = resolve('node_modules');
const out = resolve('src/renderer/vendor');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

cpSync(`${nm}/marked/lib/marked.esm.js`, `${out}/marked.js`);
cpSync(`${nm}/dompurify/dist/purify.es.mjs`, `${out}/purify.js`);
cpSync(`${nm}/highlight.js/es`, `${out}/hljs`, { recursive: true });
cpSync(`${nm}/highlight.js/styles`, `${out}/hljs-styles`, { recursive: true });
console.log('vendored marked, dompurify, highlight.js ->', out);
