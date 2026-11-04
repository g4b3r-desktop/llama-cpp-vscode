const path = require('path');

const CODE_EXTENSIONS = new Set([
  '.js','.jsx','.mjs','.cjs','.ts','.tsx','.py','.java','.c','.cc','.cpp','.h','.hpp',
  '.cs','.go','.rs','.php','.rb','.swift','.kt','.kts','.scala','.sh','.bash','.zsh',
  '.lua','.vue','.svelte','.css','.scss','.less','.xml','.json','.yaml','.yml',
  '.sql','.graphql','.gql','.proto'
]);

function parseDocument(filename, input, options = {}) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  const text = String(input ?? '').replace(/\r\n?/g, '\n');
  const maxLines = Math.max(10, Number(options.chunkLines || 80));
  const overlapLines = Math.min(maxLines - 1, Math.max(0, Number(options.chunkOverlapLines ?? 20)));
  const maxCharacters = Math.max(500, Number(options.chunkCharacters || 5000));
  const overlapCharacters = Math.min(maxCharacters - 1, Math.max(0, Number(options.chunkOverlapCharacters ?? 500)));
  const basename = path.basename(filename || 'document');

  if (ext === '.html' || ext === '.htm') {
    const html = htmlToStructuredText(text);
    return parseMarkdownLike(html.body, { maxLines, overlapLines, maxCharacters, title: html.title || basename, preserveTitle: Boolean(html.title), lineNumbers: false });
  }
  if (ext === '.md' || ext === '.mdx') {
    return parseMarkdownLike(text, { maxLines, overlapLines, maxCharacters, title: basename, lineNumbers: true });
  }
  if (ext === '.json' || ext === '.jsonc') {
    let normalized = text;
    if (ext === '.json') {
      try { normalized = JSON.stringify(JSON.parse(text), null, 2); } catch {}
    }
    return chunkLines(normalized, { maxLines, overlapLines, maxCharacters, title: basename, lineNumbers: true });
  }
  if (CODE_EXTENSIONS.has(ext)) {
    return chunkLines(text, { maxLines, overlapLines, maxCharacters, title: basename, lineNumbers: true, code: true });
  }
  return chunkParagraphs(text, { maxCharacters, overlapCharacters, title: basename });
}

function parseMarkdownLike(text, options = {}) {
  const lines = String(text || '').split('\n');
  const sections = [];
  const hierarchy = [];
  let current = null;
  let fenced = false;
  let fenceMarker = '';

  const flush = () => {
    if (current && current.lines.some(line => line.trim())) sections.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = line.match(/^\s*([\x60]{3,}|~{3,})/);
    if (fence) {
      if (!fenced) {
        fenced = true;
        fenceMarker = fence[1][0];
      } else if (fence[1][0] === fenceMarker) {
        fenced = false;
        fenceMarker = '';
      }
    }
    const heading = !fenced ? line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/) : null;
    if (heading) {
      flush();
      const level = heading[1].length;
      while (hierarchy.length && hierarchy[hierarchy.length - 1].level >= level) hierarchy.pop();
      hierarchy.push({ level, title: heading[2].trim() });
      current = { heading: heading[2].trim(), section: hierarchy.map(item => item.title).join(' > '), start: i, lines: [line] };
      continue;
    }
    if (!current) current = { heading: '', section: hierarchy.map(item => item.title).join(' > '), start: i, lines: [] };
    current.lines.push(line);
  }
  flush();

  const firstHeading = lines.find(line => /^#\s+/.test(line.trim()))?.replace(/^#\s+/, '').trim();
  const documentTitle = options.preserveTitle ? (options.title || firstHeading || '') : (firstHeading || options.title || '');
  const chunks = [];
  for (const section of sections) {
    chunks.push(...chunkLines(section.lines.join('\n'), {
      maxLines: options.maxLines, overlapLines: options.overlapLines, maxCharacters: options.maxCharacters,
      title: documentTitle || section.heading, section: section.section || section.heading,
      lineNumbers: options.lineNumbers, startLine: section.start + 1
    }));
  }
  return chunks;
}

function chunkLines(input, options = {}) {
  const lines = String(input || '').split('\n');
  const size = Math.max(1, Number(options.maxLines || 80));
  const overlap = Math.min(size - 1, Math.max(0, Number(options.overlapLines || 0)));
  const maxCharacters = Math.max(500, Number(options.maxCharacters || 5000));
  const output = [];
  let start = 0;

  while (start < lines.length) {
    let end = start;
    let length = 0;
    while (end < lines.length && end - start < size) {
      const lineLength = lines[end].length + (end > start ? 1 : 0);
      if (end > start && length + lineLength > maxCharacters) break;
      length += lineLength;
      end += 1;
      if (length >= maxCharacters) break;
    }
    if (end === start) end += 1;
    const content = lines.slice(start, end).join('\n').trim();
    const baseLine = Number(options.startLine || 1);
    if (content) {
      if (content.length > maxCharacters) {
        const step = Math.max(1, maxCharacters - Math.min(500, Math.floor(maxCharacters / 10)));
        for (let offset = 0; offset < content.length; offset += step) {
          const part = content.slice(offset, offset + maxCharacters).trim();
          if (part) output.push({
            title: options.title || '', section: options.section || '',
            startLine: options.lineNumbers === false ? null : baseLine + start,
            endLine: options.lineNumbers === false ? null : baseLine + end - 1, text: part
          });
          if (offset + maxCharacters >= content.length) break;
        }
      } else output.push({
        title: options.title || '', section: options.section || '',
        startLine: options.lineNumbers === false ? null : baseLine + start,
        endLine: options.lineNumbers === false ? null : baseLine + end - 1, text: content
      });
    }
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return output;
}

function chunkParagraphs(input, options = {}) {
  const lines = String(input || '').split('\n');
  const paragraphs = [];
  let current = [];
  let startLine = 1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) {
      if (current.length) paragraphs.push({ text: current.join('\n'), startLine, endLine: i });
      current = [];
      startLine = i + 2;
    } else {
      if (!current.length) startLine = i + 1;
      current.push(lines[i]);
    }
  }
  if (current.length) paragraphs.push({ text: current.join('\n'), startLine, endLine: lines.length });

  const output = [];
  let buffer = [];
  let bufferStart = 1;
  let bufferEnd = 1;
  let length = 0;
  let lastParagraph;
  const flush = (keepOverlap = false) => {
    if (!buffer.length) return;
    output.push({ title: options.title || '', section: '', startLine: bufferStart, endLine: bufferEnd, text: buffer.join('\n\n') });
    const overlapLength = Math.max(0, options.overlapCharacters || 0);
    const overlap = keepOverlap && overlapLength ? String(lastParagraph?.text || '').slice(-overlapLength) : '';
    buffer = overlap ? [overlap] : [];
    bufferStart = lastParagraph?.startLine || bufferEnd;
    bufferEnd = lastParagraph?.endLine || bufferEnd;
    length = overlap.length;
  };

  for (const paragraph of paragraphs) {
    const value = paragraph.text;
    if (value.length > options.maxCharacters) {
      flush();
      const step = Math.max(1, options.maxCharacters - options.overlapCharacters);
      for (let offset = 0; offset < value.length; offset += step) {
        const part = value.slice(offset, offset + options.maxCharacters).trim();
        if (part) output.push({ title: options.title || '', section: '', startLine: paragraph.startLine, endLine: paragraph.endLine, text: part });
        if (offset + options.maxCharacters >= value.length) break;
      }
      lastParagraph = paragraph;
      continue;
    }
    if (buffer.length && length + value.length + 2 > options.maxCharacters) flush(true);
    if (!buffer.length) bufferStart = paragraph.startLine;
    buffer.push(value);
    bufferEnd = paragraph.endLine;
    length += value.length + 2;
    lastParagraph = paragraph;
  }
  flush();
  return output;
}

function htmlToStructuredText(input) {
  const original = String(input || '');
  const titleMatch = original.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const h1Match = original.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i);
  const title = decodeEntities(stripTags(titleMatch?.[1] || h1Match?.[1] || '')).trim();
  let body = original
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_, href, label) => stripTags(label) + ' (' + href + ')')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, level, heading) => '\n' + '#'.repeat(Number(level)) + ' ' + stripTags(heading) + '\n')
    .replace(/<\/(p|div|section|article|main|li|pre|blockquote|tr|table|ul|ol|dl|dt|dd|header|h[1-6])\s*>/gi, '\n\n')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  body = decodeEntities(body).replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { title, body };
}

function stripTags(value) { return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function decodeEntities(value) {
  return String(value || '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, ' ')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

module.exports = { parseDocument, htmlToStructuredText, decodeEntities, chunkLines, chunkParagraphs, parseMarkdownLike };
