const path = require('path');
const os = require('os');
const crypto = require('crypto');

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

module.exports = { isValidSourceId, isBlockedRoot, isSensitiveFilename, isInside, normalizeRelative, isSafeDocumentPath, looksBinary, sha256 };
