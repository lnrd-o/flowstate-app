import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { openZip, parseCsv, parseXlsx, parsePptx, parseDocx, listZip, excelDate, colIndex, colName, previewType, createPreview, CAPS } from '../../src/main/files-preview.js';

function crc32(b) { let c, crc = 0xffffffff; for (let i = 0; i < b.length; i++) { c = (crc ^ b[i]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
/** Minimal zip writer: files = {name: string|Buffer}; opts.store = names kept uncompressed. */
export function makeZip(files, { store = [] } = {}) {
  const locals = []; const central = []; let off = 0;
  for (const [name, data] of Object.entries(files)) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const method = store.includes(name) ? 0 : 8;
    const comp = method ? zlib.deflateRawSync(raw) : raw;
    const nb = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, comp); central.push(ch, nb); off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

const xlsxFiles = () => ({
  'xl/workbook.xml': '<workbook xmlns:r="x"><sheets><sheet name="Sales &amp; Co" sheetId="1" r:id="rId1"/><sheet name="Empty" sheetId="2" r:id="rId2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="t/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="t/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>Name</t></si><si><r><t>Al</t></r><r><t>ice</t></r></si><si><t>Total</t></si></sst>',
  'xl/styles.xml': '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="9"/></cellXfs></styleSheet>',
  'xl/worksheets/sheet1.xml': '<worksheet><dimension ref="A1:D3"/><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c><c r="D1" t="inlineStr"><is><t>inline</t></is></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>1234.5000000000002</v></c><c r="C2" s="1"><v>45000</v></c><c r="D2" s="3"><v>0.25</v></c></row>'
    + '<row r="3"><c r="A3" t="b"><v>1</v></c><c r="B3" s="2"><v>45000.5</v></c><c r="C3" t="e"><v>#DIV/0!</v></c></row></sheetData></worksheet>',
  'xl/worksheets/sheet2.xml': '<worksheet><sheetData/></worksheet>',
});

test('openZip lists entries and reads stored + deflated', () => {
  const z = openZip(makeZip({ 'a.txt': 'hello', 'dir/': '', 'b.txt': 'world' }, { store: ['b.txt'] }));
  assert.deepEqual(z.entries.map((e) => e.name), ['a.txt', 'dir/', 'b.txt']);
  assert.equal(z.read('a.txt').toString(), 'hello');
  assert.equal(z.read('b.txt').toString(), 'world');
  assert.equal(z.read('nope'), null);
});

test('openZip rejects garbage, too many entries and zip bombs', () => {
  assert.throws(() => openZip(Buffer.from('not a zip at all, definitely not')), /Not a zip/);
  const many = makeZip({ a: '1', b: '2', c: '3' });
  assert.throws(() => openZip(many, { ...CAPS, zipEntries: 2 }), /Too many/);
  const bomb = makeZip({ 'big.txt': Buffer.alloc(2 * 1024 * 1024, 0x41) });
  const small = { ...CAPS, entryInflated: 1024 * 1024 };
  assert.throws(() => openZip(bomb, small).read('big.txt', small.entryInflated), /too large/i);
  const z = openZip(makeZip({ a: Buffer.alloc(600, 1), b: Buffer.alloc(600, 1) }), { ...CAPS, totalInflated: 1000 });
  z.read('a');
  assert.throws(() => z.read('b'), /too large|expands/i);
});

test('parseCsv: delimiter detection, quotes, caps', () => {
  const r = parseCsv('a;b;c\n1;"x;y";"he said ""hi"""\n2;3;4');
  assert.equal(r.delimiter, ';');
  assert.deepEqual(r.rows, [['a', 'b', 'c'], ['1', 'x;y', 'he said "hi"'], ['2', '3', '4']]);
  const big = parseCsv(Array.from({ length: 50 }, (_, i) => `${i},x`).join('\r\n'), { maxRows: 10 });
  assert.equal(big.rows.length, 10); assert.equal(big.truncated, true);
  assert.equal(parseCsv('a,b,c,d', { maxCols: 2 }).colsTruncated, true);
});

test('xlsx helpers', () => {
  assert.equal(colIndex('AA3'), 26); assert.equal(colName(27), 'AB');
  assert.equal(excelDate(45000), '2023-03-15'); assert.equal(excelDate(45000.5), '2023-03-15 12:00');
});

test('parseXlsx: sheets, shared strings, dates, percent, bool, errors', () => {
  const r = parseXlsx(makeZip(xlsxFiles()));
  assert.deepEqual(r.sheets.map((s) => s.name), ['Sales & Co', 'Empty']);
  const [s1, s2] = r.sheets;
  assert.deepEqual(s1.rows[0], ['Name', 'Total', '', 'inline']);
  assert.deepEqual(s1.rows[1], ['Alice', '1234.5', '2023-03-15', '25%']);
  assert.deepEqual(s1.rows[2], ['TRUE', '2023-03-15 12:00', '#DIV/0!']);
  assert.equal(s1.dims, 'A1:D3');
  assert.deepEqual(s2.rows, []);
});

test('parseXlsx caps rows and columns', () => {
  const rows = Array.from({ length: 30 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c><c r="ZZ${i + 1}"><v>1</v></c></row>`).join('');
  const f = { ...xlsxFiles(), 'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rows}</sheetData></worksheet>` };
  const r = parseXlsx(makeZip(f), { ...CAPS, rows: 5, cols: 3 });
  assert.equal(r.sheets[0].rows.length, 5); assert.equal(r.sheets[0].truncated, true); assert.equal(r.sheets[0].colsTruncated, true);
  assert.throws(() => parseXlsx(makeZip({ 'x.txt': 'y' })), /workbook/i);
});

const pptxFiles = (png) => ({
  'ppt/presentation.xml': '<p:presentation xmlns:r="r"><p:sldIdLst><p:sldId id="1" r:id="rId2"/><p:sldId id="2" r:id="rId1"/></p:sldIdLst></p:presentation>',
  'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId1" Type="t/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="t/slide" Target="slides/slide2.xml"/></Relationships>',
  'ppt/slides/slide1.xml': '<p:sld><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Second &amp; last</a:t></a:r></a:p></p:txBody></p:sp></p:sld>',
  'ppt/slides/slide2.xml': '<p:sld><p:sp><p:nvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Intro</a:t></a:r></a:p></p:txBody></p:sp>'
    + '<p:sp><p:txBody><a:p><a:r><a:t>Point one</a:t></a:r></a:p><a:p><a:r><a:t>Point </a:t></a:r><a:r><a:t>two</a:t></a:r></a:p></p:txBody></p:sp></p:sld>',
  'ppt/slides/_rels/slide2.xml.rels': '<Relationships><Relationship Id="r1" Type="x/image" Target="../media/image1.png"/><Relationship Id="r2" Type="x/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>',
  'ppt/notesSlides/notesSlide1.xml': '<p:notes><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Say hello</a:t></a:r></a:p></p:txBody></p:sp></p:notes>',
  'ppt/media/image1.png': png,
});

test('parsePptx: order, titles, text, notes, images', () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const r = parsePptx(makeZip(pptxFiles(png)));
  assert.equal(r.slides.length, 2);
  assert.equal(r.slides[0].title, 'Intro');
  assert.deepEqual(r.slides[0].lines, ['Point one', 'Point two']);
  assert.equal(r.slides[0].notes, 'Say hello');
  assert.equal(r.slides[0].images.length, 1);
  assert.ok(r.slides[0].images[0].startsWith('data:image/png;base64,'));
  assert.equal(r.slides[1].title, 'Second & last');
  assert.equal(parsePptx(makeZip(pptxFiles(png)), { ...CAPS, slides: 1 }).moreSlides, 1);
});

test('parseDocx: headings, paragraphs, tables, caps', () => {
  const doc = '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:r><w:t>&lt;world&gt;</w:t></w:r><w:r><w:tab/><w:t>x</w:t></w:r></w:p><w:p></w:p>'
    + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
  const r = parseDocx(makeZip({ 'word/document.xml': doc }));
  assert.deepEqual(r.blocks[0], { t: 'p', text: 'Title', level: 1 });
  assert.equal(r.blocks[1].text, 'Hello <world>\tx');
  assert.deepEqual(r.blocks[2], { t: 'table', rows: [['A', 'B']] });
  assert.equal(parseDocx(makeZip({ 'word/document.xml': doc }), { ...CAPS, blocks: 1 }).truncated, true);
});

test('listZip caps the entry list', () => {
  const r = listZip(makeZip({ a: '1', b: '22', 'c/': '' }), { ...CAPS, listEntries: 2 });
  assert.equal(r.total, 3); assert.equal(r.entries.length, 2); assert.equal(r.truncated, true);
});

test('previewType', () => {
  assert.equal(previewType('a/B.XLSX'), 'xlsx'); assert.equal(previewType('x.pptx'), 'pptx'); assert.equal(previewType('x.docx'), 'docx');
  assert.equal(previewType('x.csv'), 'csv'); assert.equal(previewType('x.pdf'), 'pdf'); assert.equal(previewType('x.zip'), 'archive');
  assert.equal(previewType('x.json'), 'json'); assert.equal(previewType('x.md'), 'markdown'); assert.equal(previewType('x.py'), 'text');
  assert.equal(previewType('x.png'), 'image'); assert.equal(previewType('x.weird'), 'binary');
});

test('createPreview: guarded paths, typed results, generic fallback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-prev-'));
  try {
    fs.writeFileSync(path.join(root, 'a.xlsx'), makeZip(xlsxFiles()));
    fs.writeFileSync(path.join(root, 'bad.docx'), 'not a zip');
    fs.writeFileSync(path.join(root, 'd.json'), '{"a":1}');
    fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 0, 2]));
    fs.writeFileSync(path.join(root, 'notes.weird'), 'plain text here');
    fs.writeFileSync(path.join(root, 't.csv'), 'a,b\n1,2\n');
    fs.writeFileSync(path.join(root, 'x.pdf'), '%PDF-1.4');
    const pv = createPreview({ getProject: (id) => (id === 'p' ? { path: root } : null) });
    assert.equal(pv.preview('p', 'a.xlsx').type, 'xlsx');
    assert.equal(pv.preview('p', 'a.xlsx').sheets.length, 2);
    const bad = pv.preview('p', 'bad.docx'); assert.equal(bad.type, 'generic'); assert.ok(bad.error);
    assert.equal(pv.preview('p', 'd.json').content, '{\n  "a": 1\n}');
    assert.equal(pv.preview('p', 'bin.dat').type, 'generic');
    assert.equal(pv.preview('p', 'notes.weird').type, 'text');
    assert.deepEqual(pv.preview('p', 't.csv').rows, [['a', 'b'], ['1', '2']]);
    assert.ok(pv.preview('p', 'x.pdf').dataUrl.startsWith('data:application/pdf;base64,'));
    assert.throws(() => pv.preview('p', '../x.txt'), /traversal|escapes/i);
    assert.throws(() => pv.preview('p', 'C:/x.txt'), /Invalid path/);
    assert.throws(() => pv.preview('nope', 'a.xlsx'), /Unknown project/);
    assert.throws(() => pv.preview('p', 'missing.txt'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
