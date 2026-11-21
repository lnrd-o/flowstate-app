// Copies browser-ready ESM builds from node_modules into src/renderer/vendor (no bundler, no CDN).
// Run: npm run vendor   (output is committed so the renderer loads offline)
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const nm = resolve('node_modules');
const out = resolve('src/renderer/vendor');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

cpSync(`${nm}/marked/lib/marked.esm.js`, `${out}/marked.js`);
cpSync(`${nm}/dompurify/dist/purify.es.mjs`, `${out}/purify.js`);
cpSync(`${nm}/highlight.js/es`, `${out}/hljs`, { recursive: true });
cpSync(`${nm}/highlight.js/styles`, `${out}/hljs-styles`, { recursive: true });
// hljs/core.js imports ../lib/core.js (CommonJS, not browser-loadable): wrap the CJS file as ESM.
const core = readFileSync(`${nm}/highlight.js/lib/core.js`, 'utf8');
writeFileSync(
  `${out}/hljs-core.js`,
  '// highlight.js core as ESM (generated wrapper of highlight.js/lib/core.js, which is CommonJS). See scripts/vendor.js.\n'
  + 'const module = { exports: {} };\nconst exports = module.exports;\n(function () {\n' + core + '\n})();\nexport default module.exports;\n',
);
console.log('vendored marked, dompurify, highlight.js ->', out);
