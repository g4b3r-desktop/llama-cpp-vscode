const test = require('node:test');
const assert = require('node:assert/strict');
const { sourcesFromChunks, sourcesFromToolResult, mergeSources, formatSourcesMarkdown, formatWebResearchStatus } = require('../src/chat/sourceReferences');

test('local documentation sources are grouped by source and file with line ranges', () => {
  const sources = sourcesFromChunks([
    { sourceId: 'docs', sourceName: 'Framework Docs', filename: 'api/guide.md', section: 'Setup', startLine: 10, endLine: 15 },
    { sourceId: 'docs', sourceName: 'Framework Docs', filename: 'api/guide.md', section: 'Setup', startLine: 18, endLine: 24 },
    { filename: 'src/app.js' }
  ]);

  assert.deepEqual(sources, [{
    type: 'knowledge',
    source: 'Framework Docs',
    file: 'api/guide.md',
    title: '',
    section: 'Setup',
    startLine: 10,
    endLine: 24
  }]);
});

test('web research sources retain valid URLs and deduplicate search results', () => {
  const researchSources = sourcesFromToolResult('research_web', {
    sources: [{ title: 'Source A', url: 'https://example.com/a' }],
    searchResults: [
      { title: 'Source A result', url: 'https://example.com/a' },
      { title: 'Unsafe', url: 'javascript:alert(1)' }
    ]
  });
  const additionalSources = sourcesFromToolResult('fetch_url', { title: 'Source B', url: 'http://example.org/b' });

  assert.deepEqual(mergeSources(researchSources, additionalSources), [
    { type: 'web', title: 'Source A', url: 'https://example.com/a' },
    { type: 'web', title: 'Source B', url: 'http://example.org/b' }
  ]);
});

test('source markdown contains links for web references and paths for local docs', () => {
  const markdown = formatSourcesMarkdown([
    { type: 'web', title: 'Source A', url: 'https://example.com/a' },
    { type: 'knowledge', source: 'Framework Docs', file: 'api/guide.md', startLine: 3, endLine: 5 }
  ]);

  assert.match(markdown, /\[Source A\]\(https:\/\/example\.com\/a\)/);
  assert.ok(markdown.includes('**Framework Docs** — api/guide\\.md · linhas 3-5'));
});

test('research results with no successfully retrieved sources say that citations are unverified', () => {
  const markdown = formatSourcesMarkdown([], true);

  assert.match(markdown, /Nenhuma fonte foi retornada com sucesso pelas ferramentas/);
  assert.match(markdown, /URLs citadas no texto não foram verificadas pela extensão/);
});

test('web research status explains provider errors and empty search results', () => {
  assert.match(formatWebResearchStatus({
    provider: 'searxng',
    error: 'Could not reach SearXNG at http://127.0.0.1:8888/search: fetch failed'
  }), /Pesquisa web falhou \(SearXNG\): Could not reach SearXNG at http:\/\/127\.0\.0\.1:8888\/search: fetch failed/);
  assert.match(formatWebResearchStatus({ provider: 'brave', searchResults: 0 }), /Brave Search não retornou resultados/);
  assert.match(formatWebResearchStatus({ provider: 'searxng', searchResults: 4, fetchedSources: 0 }), /retornou 4 link\(s\), mas nenhuma página pôde ser lida/);
});
