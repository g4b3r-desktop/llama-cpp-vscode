const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { parseDocument, htmlToStructuredText, chunkParagraphs } = require('../src/knowledgeSources/KnowledgeDocumentParser');
const { isBlockedRoot, isSensitiveFilename, isInside, isSafeDocumentPath, looksBinary, isValidSourceId } = require('../src/knowledgeSources/sourceUtils');
const { reciprocalRankFusion, diversifyResults } = require('../src/knowledgeSources/retrievalUtils');

test('HTML extraction removes executable/layout noise and preserves headings and links', () => {
  const html = '<html><head><title>Three.js API</title><style>.hidden{}</style></head><body><nav>Navigation</nav><main><h1>Loading</h1><h2>GLTFLoader</h2><p>Use <a href="../api/GLTFLoader.html">GLTFLoader</a> to load assets.</p><script>alert(1)</script></main></body></html>';
  const parsed = htmlToStructuredText(html);
  assert.equal(parsed.title, 'Three.js API');
  assert.match(parsed.body, /# Loading/);
  assert.match(parsed.body, /## GLTFLoader/);
  assert.match(parsed.body, /GLTFLoader \(\.\.\/api\/GLTFLoader\.html\)/);
  assert.doesNotMatch(parsed.body, /Navigation|alert\(1\)|\.hidden/);
  const chunks = parseDocument('manual/loading.html', html);
  assert.ok(chunks.length > 0);
  assert.equal(chunks[0].startLine, null);
  assert.equal(chunks[0].endLine, null);
  assert.equal(chunks[0].title, 'Three.js API');
});

test('Markdown chunking keeps heading hierarchy and ignores headings inside code fences', () => {
  const fence = String.fromCharCode(96).repeat(3);
  const markdown = ['# Manual', 'Introductory text', '', '## Loading', 'Load a model:', '',
    fence + 'js', '# this is code, not a section', 'const loader = new GLTFLoader();', fence,
    '', '### Animation', 'Use AnimationMixer.'].join('\n');
  const chunks = parseDocument('README.md', markdown);
  const loading = chunks.find(chunk => chunk.section === 'Manual > Loading');
  const animation = chunks.find(chunk => chunk.section === 'Manual > Loading > Animation');
  assert.ok(loading);
  assert.ok(animation);
  assert.match(loading.text, /# this is code, not a section/);
  assert.match(animation.text, /AnimationMixer/);
  assert.ok(Number.isInteger(loading.startLine));
  assert.ok(Number.isInteger(loading.endLine));
});

test('code chunks preserve names and source line ranges', () => {
  const code = Array.from({ length: 120 }, (_, index) => 'export function loadModel' + index + '() { return ' + index + '; }').join('\n');
  const chunks = parseDocument('loader.ts', code, { chunkLines: 40, chunkOverlapLines: 10, chunkCharacters: 5000 });
  assert.ok(chunks.length >= 3);
  assert.equal(chunks[0].startLine, 1);
  assert.ok(chunks[1].startLine < chunks[0].endLine);
  assert.match(chunks[0].text, /loadModel0/);
  assert.match(chunks.at(-1).text, /loadModel119/);
});

test('paragraph chunks add bounded overlap between text groups', () => {
  const first = 'A'.repeat(300);
  const second = 'B'.repeat(300);
  const chunks = chunkParagraphs(first + '\n\n' + second, { maxCharacters: 500, overlapCharacters: 80, title: 'manual.txt' });
  assert.equal(chunks.length, 2);
  assert.ok(chunks[1].text.startsWith('A'.repeat(80)));
  assert.ok(chunks[1].text.includes('B'.repeat(300)));
  assert.ok(chunks.every(chunk => chunk.text.length <= 500));
  const withoutOverlap = chunkParagraphs(first + '\n\n' + second, { maxCharacters: 500, overlapCharacters: 0 });
  assert.equal(withoutOverlap[1].text, second);
});

test('JSON files are normalized for readable structural chunks', () => {
  const chunks = parseDocument('api.json', '{"loader":{"name":"GLTFLoader","animations":true}}');
  assert.match(chunks[0].text, /"GLTFLoader"/);
  assert.match(chunks[0].text, /\n/);
});

test('source safety filters system folders, credentials and path traversal', () => {
  assert.equal(isBlockedRoot('/etc'), true);
  assert.equal(isBlockedRoot('/etc/ssh'), true);
  assert.equal(isBlockedRoot('/home'), true);
  assert.equal(isBlockedRoot(os.homedir()), true);
  assert.equal(isBlockedRoot(path.join(os.homedir(), 'documentation')), false);
  assert.equal(isBlockedRoot('/root/.ssh'), true);
  assert.equal(isSensitiveFilename('secrets/api-key.txt'), true);
  assert.equal(isSensitiveFilename('config/.env.production'), true);
  assert.equal(isSensitiveFilename('docs/GLTFLoader.md'), false);
  assert.equal(isInside('/tmp/docs', '/tmp/docs/api/loader.md'), true);
  assert.equal(isInside('/tmp/docs', '/tmp/docs-evil/secret.txt'), false);
  assert.equal(isValidSourceId('0123456789abcdef01234567'), true);
  assert.equal(isValidSourceId('../etc/passwd'), false);
});

test('cached document paths reject traversal and absolute paths', () => {
  assert.equal(isSafeDocumentPath('manual/api/GLTFLoader.html'), true);
  assert.equal(isSafeDocumentPath('../secrets.txt'), false);
  assert.equal(isSafeDocumentPath('manual/../../secrets.txt'), false);
  assert.equal(isSafeDocumentPath('/etc/passwd'), false);
  assert.equal(isSafeDocumentPath('C:/Windows/win.ini'), false);
  assert.equal(isSafeDocumentPath('manual//loader.html'), false);
});

test('binary detector rejects NUL-containing content', () => {
  assert.equal(looksBinary(Buffer.from([0x7b, 0x00, 0x7d])), true);
  assert.equal(looksBinary(Buffer.from('plain documentation')), false);
});

test('hybrid fusion keeps distinct external chunks from the same HTML page', () => {
  const a = { id: 'source-a:chunk-1', sourceId: 'source-a', filename: 'api.html', startLine: null, endLine: null, text: 'loader' };
  const b = { id: 'source-a:chunk-2', sourceId: 'source-a', filename: 'api.html', startLine: null, endLine: null, text: 'animation' };
  const result = reciprocalRankFusion([a], [b], 5);
  assert.equal(result.length, 2);
});

test('retrieval diversification limits domination by a single source', () => {
  const items = [
    ...Array.from({ length: 6 }, (_, i) => ({ sourceId: 'threejs', score: 10 - i, id: 'a' + i })),
    ...Array.from({ length: 4 }, (_, i) => ({ sourceId: 'python', score: 5 - i, id: 'b' + i }))
  ];
  const selected = diversifyResults(items, 6);
  assert.equal(selected.length, 6);
  assert.ok(selected.filter(item => item.sourceId === 'threejs').length <= 4);
  assert.ok(selected.some(item => item.sourceId === 'python'));
});
