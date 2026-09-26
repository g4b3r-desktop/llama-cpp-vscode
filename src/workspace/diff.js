function unifiedDiff(filePath, beforeText, afterText, contextLines = 3) {
  const before = splitLines(beforeText);
  const after = splitLines(afterText);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  if (prefix === before.length && prefix === after.length) return '';
  const start = Math.max(0, prefix - contextLines);
  const beforeEnd = Math.min(before.length, before.length - suffix + contextLines);
  const afterEnd = Math.min(after.length, after.length - suffix + contextLines);
  const oldChanged = before.slice(prefix, before.length - suffix);
  const newChanged = after.slice(prefix, after.length - suffix);
  const lines = [`--- a/${filePath}`, `+++ b/${filePath}`, `@@ -${start + 1},${Math.max(0, beforeEnd - start)} +${start + 1},${Math.max(0, afterEnd - start)} @@`];
  for (const line of before.slice(start, prefix)) lines.push(` ${line}`);
  for (const line of oldChanged) lines.push(`-${line}`);
  for (const line of newChanged) lines.push(`+${line}`);
  const sharedTail = Math.min(beforeEnd - (before.length - suffix), afterEnd - (after.length - suffix));
  for (const line of before.slice(before.length - suffix, before.length - suffix + sharedTail)) lines.push(` ${line}`);
  return lines.join('\n');
}
function splitLines(text) {
  const value = String(text ?? '').replace(/\r\n/g, '\n');
  return value.endsWith('\n') ? value.slice(0, -1).split('\n') : value.split('\n');
}
module.exports = { unifiedDiff };
