function sourcesFromChunks(chunks) {
  return uniqueSources((Array.isArray(chunks) ? chunks : [])
    .filter(chunk => chunk?.sourceId)
    .map(chunk => ({
      type: 'knowledge',
      source: chunk.sourceName || 'Documentação local',
      file: chunk.displayFilename || chunk.filename || '',
      title: chunk.title || '',
      section: chunk.section || '',
      startLine: chunk.startLine,
      endLine: chunk.endLine
    })));
}

function sourcesFromToolResult(toolName, result) {
  if (!result || typeof result !== 'object') return [];
  if (toolName === 'search_knowledge_base') {
    return uniqueSources((Array.isArray(result.results) ? result.results : []).map(item => ({
      type: 'knowledge',
      source: item?.source || 'Documentação local',
      file: item?.file || '',
      title: item?.title || '',
      section: item?.section || '',
      startLine: item?.startLine,
      endLine: item?.endLine
    })));
  }

  const results = [];
  if (toolName === 'research_web') {
    results.push(...(Array.isArray(result.sources) ? result.sources : []));
    results.push(...(Array.isArray(result.searchResults) ? result.searchResults : []));
  } else if (toolName === 'web_search') {
    results.push(...(Array.isArray(result.results) ? result.results : []));
  } else if (toolName === 'fetch_url') {
    results.push(result);
  }
  return uniqueSources(results.map(item => webSource(item)));
}

function mergeSources(...groups) {
  return uniqueSources(groups.flatMap(group => Array.isArray(group) ? group : []));
}

function formatSourcesMarkdown(sources) {
  const items = uniqueSources(Array.isArray(sources) ? sources : []);
  if (!items.length) return '';
  const lines = items.map(source => {
    if (source.type === 'web') {
      const url = encodeURI(source.url).replace(/\(/g, '%28').replace(/\)/g, '%29');
      return `- [${escapeMarkdown(source.title)}](${url})`;
    }
    const location = [source.file, source.section, source.startLine ? `linhas ${source.startLine}${source.endLine && source.endLine !== source.startLine ? `-${source.endLine}` : ''}` : '']
      .filter(Boolean)
      .join(' · ');
    return `- **${escapeMarkdown(source.source)}**${location ? ` — ${escapeMarkdown(location)}` : ''}`;
  });
  return `\n\n### Fontes\n${lines.join('\n')}`;
}

function webSource(item) {
  if (!item || typeof item !== 'object') return undefined;
  const url = safeHttpUrl(item.url);
  if (!url) return undefined;
  return { type: 'web', title: String(item.title || item.name || url), url };
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function uniqueSources(sources) {
  const seen = new Map();
  const result = [];
  for (const source of sources) {
    if (!source || (source.type !== 'web' && source.type !== 'knowledge')) continue;
    const key = source.type === 'web'
      ? `${source.type}:${source.url}`
      : `${source.type}:${source.source}:${source.file}:${source.section}`;
    if (seen.has(key)) {
      if (source.type === 'knowledge') {
        const existing = result[seen.get(key)];
        if (Number.isInteger(source.startLine)) existing.startLine = Number.isInteger(existing.startLine) ? Math.min(existing.startLine, source.startLine) : source.startLine;
        if (Number.isInteger(source.endLine)) existing.endLine = Number.isInteger(existing.endLine) ? Math.max(existing.endLine, source.endLine) : source.endLine;
      }
      continue;
    }
    seen.set(key, result.length);
    result.push(source);
  }
  return result;
}

function escapeMarkdown(value) {
  return String(value || '').replace(/[\\`*_{}[\]()#+.!|>]/g, '\\$&').replace(/\r?\n/g, ' ');
}

module.exports = { sourcesFromChunks, sourcesFromToolResult, mergeSources, formatSourcesMarkdown };
