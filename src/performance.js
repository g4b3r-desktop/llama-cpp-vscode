const vscode = require('vscode');
const { getConfig } = require('./config');

class PerformanceIndicator {
  constructor(client) {
    this.client = client;
    this.last = undefined;
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.name = 'llama.cpp Performance';
    this.item.command = 'llamaCpp.showPerformanceMetrics';
    this.subscription = client.onMetrics(metrics => this.update(metrics));
    this.refreshVisibility();
  }

  refreshVisibility() {
    if (getConfig().metrics.showStatusBar) this.item.show();
    else this.item.hide();
  }

  update(metrics) {
    this.last = metrics;
    const kind = metrics.kind === 'autocomplete' ? 'AC' : 'Chat';
    const ttft = formatDuration(metrics.ttftMs);
    const prompt = formatRate(metrics.promptTps);
    const generation = formatRate(metrics.generationTps);
    const cache = metrics.cacheHit === true ? '✓' : metrics.cacheHit === false ? '×' : '?';
    this.item.text = `$(pulse) ${kind} ${ttft} · P${prompt} · G${generation} · C${cache}`;
    this.item.tooltip = buildTooltip(metrics);
    this.refreshVisibility();
  }

  showDetails() {
    if (!this.last) {
      vscode.window.showInformationMessage('llama.cpp: no performance sample yet. Run chat or autocomplete first.');
      return;
    }
    const m = this.last;
    const parts = [
      `${m.kind === 'autocomplete' ? 'Autocomplete' : 'Chat'}`,
      `TTFT ${formatDuration(m.ttftMs, true)}`,
      `prompt ${formatRate(m.promptTps)} tok/s`,
      `generation ${formatRate(m.generationTps)} tok/s`,
      `cache ${m.cacheHit === true ? `hit (${m.cacheTokens || 0} tokens)` : m.cacheHit === false ? 'miss' : 'unknown'}`,
      `total ${formatDuration(m.totalMs, true)}`
    ];
    vscode.window.showInformationMessage(`llama.cpp performance: ${parts.join(' · ')}`);
  }

  dispose() {
    this.subscription?.dispose();
    this.item.dispose();
  }
}

function buildTooltip(m) {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**llama.cpp performance — ${m.kind === 'autocomplete' ? 'autocomplete' : 'chat'}**\n\n`);
  md.appendMarkdown(`- TTFT: **${formatDuration(m.ttftMs, true)}**\n`);
  md.appendMarkdown(`- Prompt: **${formatRate(m.promptTps)} tok/s**`);
  if (Number.isFinite(m.promptTokens)) md.appendMarkdown(` (${m.promptTokens} processed)`);
  md.appendMarkdown('\n');
  md.appendMarkdown(`- Generation: **${formatRate(m.generationTps)} tok/s**`);
  if (Number.isFinite(m.predictedTokens)) md.appendMarkdown(` (${m.predictedTokens} tokens)`);
  md.appendMarkdown('\n');
  const cacheText = m.cacheHit === true ? `hit (${m.cacheTokens || 0} reused tokens)` : m.cacheHit === false ? 'miss' : 'unknown / API did not report it';
  md.appendMarkdown(`- Cache: **${cacheText}**\n`);
  md.appendMarkdown(`- Total request time: **${formatDuration(m.totalMs, true)}**\n`);
  md.appendMarkdown('\nClick for a compact summary.');
  return md;
}

function formatDuration(ms, precise = false) {
  if (!Number.isFinite(ms)) return '–';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(precise ? 2 : 1)}s`;
}

function formatRate(value) {
  if (!Number.isFinite(value) || value <= 0) return '–';
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

module.exports = { PerformanceIndicator, formatDuration, formatRate };
