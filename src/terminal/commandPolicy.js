function assertWorkspaceScopedCommand(command) {
  const text = String(command || '').trim();
  if (!text) throw new Error('Terminal command is empty.');
  const forbidden = [
    { pattern: /(^|[\\/])\.\.([\\/]|$)/, reason: 'parent-directory traversal is not allowed' },
    { pattern: /(^|[\s"'=])\/[A-Za-z0-9._-]/, reason: 'absolute POSIX paths are not allowed' },
    { pattern: /(^|[\s"'=])[A-Za-z]:[\\/]/, reason: 'absolute Windows paths are not allowed' },
    { pattern: /(^|[\s"'=])\\\\[^\\]/, reason: 'UNC paths are not allowed' },
    { pattern: /(^|[\s"'=])~([\\/]|\s|$)/, reason: 'home-directory expansion is not allowed' },
    { pattern: /\$(HOME|USERPROFILE|HOMEPATH)\b|\$\{(HOME|USERPROFILE|HOMEPATH)\}|%(HOME|USERPROFILE|HOMEPATH)%/i, reason: 'home-directory environment expansion is not allowed' },
    { pattern: /\b(node\s+-e|python(?:3)?\s+-c|ruby\s+-e|perl\s+-e|php\s+-r|powershell(?:\.exe)?\s+-(?:command|encodedcommand)|pwsh\s+-(?:command|encodedcommand))\b/i, reason: 'inline interpreter execution is blocked in agent terminal mode' }
  ];
  for (const rule of forbidden) {
    if (rule.pattern.test(text)) throw new Error(`Terminal command rejected: ${rule.reason}. Use workspace-relative project commands instead.`);
  }
  return text;
}

function isDangerousCommand(command) {
  return [
    /(^|\s)(sudo|su)(\s|$)/i,
    /\brm\s+-[^\n]*r/i,
    /\b(del|erase|rmdir|rd)\b/i,
    /\bgit\s+(reset\s+--hard|clean\s+-|checkout\s+--|restore\s+--source)/i,
    /\b(chmod|chown|mkfs|diskpart|format)\b/i,
    /\b(curl|wget)\b[^\n|]*(\||;|&&)\s*(sh|bash|zsh|powershell|pwsh)\b/i,
    /\b(npm|pnpm|yarn|pip|pip3|cargo|gem|composer)\s+(install|add|remove|uninstall)\b/i,
    /(^|[^>])>{1,2}\s*[^&]/
  ].some(pattern => pattern.test(command));
}

module.exports = { assertWorkspaceScopedCommand, isDangerousCommand };
