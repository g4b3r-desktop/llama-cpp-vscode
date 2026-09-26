const path = require('path');

function decodePathInput(value) {
  let text = String(value ?? '').trim();
  if (!text) return '.';
  if (text.includes('\0')) throw new Error('Path contains a NUL byte.');
  for (let i = 0; i < 2; i += 1) {
    try {
      const decoded = decodeURIComponent(text);
      if (decoded === text) break;
      text = decoded;
    } catch {
      break;
    }
  }
  return text;
}

function normalizeRelativePath(value) {
  const decoded = decodePathInput(value).replace(/[\\/]+/g, path.sep);
  if (path.isAbsolute(decoded) || /^[A-Za-z]:[\\/]/.test(decoded)) {
    throw new Error('Absolute paths are not allowed. Use a path relative to the workspace root.');
  }
  const normalized = path.normalize(decoded);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error('Path traversal outside the workspace is not allowed.');
  }
  return normalized === '' ? '.' : normalized;
}

function resolveInsideRoot(rootPath, value) {
  const root = path.resolve(rootPath);
  const relative = normalizeRelativePath(value);
  const absolute = path.resolve(root, relative);
  const fromRoot = path.relative(root, absolute);
  if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new Error('Resolved path is outside the workspace root.');
  }
  return { root, relative, absolute };
}

function isInsideRoot(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

module.exports = { decodePathInput, normalizeRelativePath, resolveInsideRoot, isInsideRoot };
