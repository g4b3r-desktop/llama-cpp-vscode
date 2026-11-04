const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_SOURCE_EXTENSIONS = Object.freeze([
  'html','htm','md','mdx','txt','json','jsonc','js','jsx','mjs','cjs','ts','tsx',
  'py','java','c','cc','cpp','h','hpp','cs','go','rs','php','rb','swift','kt',
  'kts','scala','sh','bash','zsh','lua','vue','svelte','css','scss','less','xml',
  'yaml','yml','sql','graphql','gql','proto'
]);

function isValidSourceId(value) {
  return typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
}

function isBlockedRoot(root) {
  const value = path.resolve(root);
  const home = path.resolve(os.homedir());
  if (value === home || value === path.parse(value).root) return true;
  const blocked = process.platform === 'win32'
    ? [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData]
    : ['/', '/etc', '/usr', '/bin', '/sbin', '/proc', '/sys', '/dev', '/var', '/boot', '/root', '/home'];
  return blocked.filter(Boolean).some(base => {
    const normalized = path.resolve(base);
    if (normalized === path.resolve('/home')) return value === normalized;
    return value === normalized || (normalized !== path.parse(normalized).root && value.startsWith(normalized + path.sep));
  });
}

function isSensitiveFilename(filename) {
  const normalized = String(filename || '').replace(/\\/g, '/').toLowerCase();
  const base = path.posix.basename(normalized);
  const segments = normalized.split('/');
  if (segments.some(part => ['.ssh', '.gnupg', '.aws', '.azure', 'secrets', 'credentials'].includes(part))) return true;
  return base === '.env' || base.startsWith('.env.')
    || ['.npmrc', '.pypirc', '.netrc', 'credentials', 'credentials.json', 'secrets.json', 'id_rsa', 'id_ed25519', 'id_ecdsa'].includes(base)
    || /\.(pem|key|p12|pfx|kdbx|keystore)$/i.test(base)
    || /^(credentials?|secrets?|id_rsa|id_ed25519|id_ecdsa)(\.|$)/i.test(base);
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function normalizeRelative(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function isSafeDocumentPath(value) {
  const normalized = normalizeRelative(value);
  return Boolean(normalized) && !path.posix.isAbsolute(normalized) && !path.win32.isAbsolute(normalized)
    && !normalized.split('/').some(part => !part || part === '.' || part === '..');
}

function looksBinary(bytes) {
  const count = Math.min(bytes.length, 4096);
  if (!count) return false;
  let suspicious = 0;
  for (let i = 0; i < count; i += 1) {
    const value = bytes[i];
    if (value === 0) return true;
    if (value < 7 || (value > 14 && value < 32)) suspicious += 1;
  }
  return suspicious / count > 0.08;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function normalizeSourceExtensions(values) {
  const items = Array.isArray(values) ? values : String(values || '').split(',');
  const normalized = [...new Set(items.map(value => String(value || '').trim().replace(/^\.+/, '').toLowerCase()).filter(Boolean))];
  if (!normalized.length) return [...DEFAULT_SOURCE_EXTENSIONS];
  const allowed = new Set(DEFAULT_SOURCE_EXTENSIONS);
  const invalid = normalized.filter(value => !/^[a-z0-9]{1,10}$/.test(value) || !allowed.has(value));
  if (invalid.length) throw new Error('Unsupported document extension(s): ' + invalid.join(', '));
  return normalized;
}

function normalizeSourceDirectories(values) {
  const items = Array.isArray(values) ? values : String(values || '').split(',');
  const normalized = [...new Set(items.map(value => {
    let directory = String(value || '').trim().split(String.fromCharCode(92)).join('/');
    if (directory.startsWith('./')) directory = directory.slice(2);
    while (directory.endsWith('/')) directory = directory.slice(0, -1);
    return directory;
  }).filter(Boolean))];
  for (const directory of normalized) {
    if (path.posix.isAbsolute(directory) || path.win32.isAbsolute(directory)
      || directory.split('/').some(segment => !segment || segment === '.' || segment === '..')
      || directory.split('/').some(segment => ['*', '?', '[', ']', '{', '}', '#', '!', ':', ','].some(character => segment.includes(character)))
      || directory.length > 200) {
      throw new Error('Invalid include directory: ' + directory);
    }
  }
  return normalized;
}

function buildSourceIncludeGlob(source) {
  const extensions = normalizeSourceExtensions(source.extensions);
  const directories = normalizeSourceDirectories(source.includeDirectories || []);
  const directoryPattern = directories.length === 1 ? directories[0] + '/**/*' : directories.length ? '{' + directories.join(',') + '}/**/*' : '**/*';
  const prefix = directoryPattern;
  return prefix + '.{' + extensions.join(',') + '}';
}

function normalizeSelectedFiles(values) {
  if (values === null || values === undefined) return null;
  if (!Array.isArray(values)) throw new Error('Selected files must be an array or null.');
  const normalized = [...new Set(values.map(value => normalizeRelative(value).trim()).filter(Boolean))].sort();
  for (const filename of normalized) {
    if (!isSafeDocumentPath(filename) || isSensitiveFilename(filename)) {
      throw new Error('Invalid selected document path: ' + filename);
    }
  }
  return normalized;
}

function matchesSelectedFile(filename, source) {
  const selected = source.selectedFiles;
  return selected === null || selected === undefined || (Array.isArray(selected) && selected.includes(normalizeRelative(filename)));
}

function normalizeSourceTags(values) {
  if (values == null) return [];
  const list = Array.isArray(values) ? values : String(values).split(',');
  return [...new Set(list.map(value => String(value || '').trim().toLowerCase())
    .filter(value => /^[a-z0-9][a-z0-9_-]{0,31}$/.test(value)))].sort();
}

function matchesRetrievalScope(chunk, options = {}) {
  const directories = Array.isArray(options.directories) ? options.directories : [];
  if (directories.length) {
    const filename = normalizeRelative(chunk.filename || '').toLowerCase();
    const matches = directories.some(value => {
      const directory = normalizeRelative(value).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
      return directory && !directory.startsWith('../') && (filename === directory || filename.startsWith(directory + '/'));
    });
    if (!matches) return false;
  }
  const tags = normalizeSourceTags(options.tags);
  if (tags.length) {
    const chunkTags = new Set(normalizeSourceTags(chunk.tags));
    if (!tags.some(tag => chunkTags.has(tag))) return false;
  }
  const recentDays = Number(options.recentDays);
  if (Number.isFinite(recentDays) && recentDays > 0) {
    const modified = Number(chunk.mtimeMs || 0);
    if (!modified || Date.now() - modified > recentDays * 86400000) return false;
  }
  return true;
}

function sourceFiltersFingerprint(source) {
  const value = JSON.stringify({
    includeDirectories: normalizeSourceDirectories(source.includeDirectories || []).slice().sort(),
    extensions: normalizeSourceExtensions(source.extensions).slice().sort(),
    selectedFiles: normalizeSelectedFiles(source.selectedFiles)
  });
  return crypto.createHash('sha256').update(value).digest('hex');
}

function matchesSourceFilter(filename, source) {
  const normalized = normalizeRelative(filename);
  const extension = path.posix.extname(normalized).slice(1).toLowerCase();
  if (!normalizeSourceExtensions(source.extensions).includes(extension)) return false;
  const directories = normalizeSourceDirectories(source.includeDirectories || []);
  if (!directories.length) return true;
  const segments = normalized.split('/');
  return directories.some(directory => normalized.startsWith(directory + '/'));
}

module.exports = {
  isValidSourceId, isBlockedRoot, isSensitiveFilename, isInside, normalizeRelative,
  isSafeDocumentPath, looksBinary, sha256, DEFAULT_SOURCE_EXTENSIONS,
  normalizeSourceExtensions, normalizeSourceDirectories, buildSourceIncludeGlob,
  sourceFiltersFingerprint, matchesSourceFilter, normalizeSelectedFiles, matchesSelectedFile, normalizeSourceTags, matchesRetrievalScope
};
