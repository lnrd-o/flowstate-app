// node:test reporter for GitHub Actions: every FAILING test becomes an error annotation (visible in the run's Annotations box)
// with the test name, file, line and the assertion message, and a short pass/fail summary is added at the end.
// Use together with the spec reporter:  npm run test:ci
const esc = (s) => String(s ?? '').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

function errorText(err) {
  if (!err) return 'failed';
  const cause = err.cause && typeof err.cause === 'object' ? err.cause : err;
  const msg = String(cause.message ?? err.message ?? err).split('\n').slice(0, 6).join('\n');
  const where = String(cause.stack ?? '').split('\n').find((l) => /\.(js|mjs):\d+/.test(l) && !l.includes('node:internal'));
  const exp = cause.expected !== undefined ? `\nexpected: ${JSON.stringify(cause.expected)?.slice(0, 160)}` : '';
  const act = cause.actual !== undefined ? `\nactual: ${JSON.stringify(cause.actual)?.slice(0, 160)}` : '';
  return `${msg}${exp}${act}${where ? `\nat ${where.trim()}` : ''}`;
}

export default async function* githubReporter(source) {
  let pass = 0; let fail = 0; const failed = [];
  for await (const ev of source) {
    if (ev.type === 'test:pass') pass++;
    if (ev.type === 'test:fail') {
      const d = ev.data;
      if (d.details?.type === 'suite') continue;
      fail++;
      const file = String(d.file ?? '').replace(/^.*[\\/](tests[\\/])/, 'tests/').replace(/\\/g, '/');
      failed.push(d.name);
      const line = d.line ? `,line=${d.line}` : '';
      yield `::error file=${escProp(file)}${line},title=${escProp(`FAILED: ${d.name}`)}::${esc(errorText(d.details?.error))}\n`;
    }
  }
  yield `::notice title=Unit tests::${pass} passed, ${fail} failed${fail ? `: ${esc(failed.join(' | ')).slice(0, 900)}` : ''}\n`;
}
