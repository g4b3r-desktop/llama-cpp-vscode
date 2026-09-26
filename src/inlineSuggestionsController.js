const vscode = require('vscode');
const path = require('path');
const { getConfig } = require('./config');

const SNOOZE_STATE_KEY = 'llamaCpp.autocomplete.snoozedUntil';

class InlineSuggestionsController {
  constructor(context) {
    this.context = context;
    this.disposables = [];
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 95);
    this.status.name = 'llama.cpp Inline Suggestions';
    this.status.command = 'llamaCpp.openInlineStatusMenu';
    this.status.show();

    this.disposables.push(
      this.status,
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('llamaCpp.autocomplete')) this.refresh();
      })
    );

    this.timer = setInterval(() => this.refresh(), 15000);
    this.refresh();
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    for (const disposable of this.disposables) disposable?.dispose?.();
    this.disposables = [];
  }

  get snoozedUntil() {
    return Number(this.context.globalState.get(SNOOZE_STATE_KEY, 0)) || 0;
  }

  isSnoozed() {
    return this.snoozedUntil > Date.now();
  }

  isEnabledForDocument(document) {
    if (!document || document.uri?.scheme !== 'file') return false;
    const config = getConfig();
    if (!config.autocomplete.enabled || this.isSnoozed()) return false;
    return isLanguageEnabled(config.autocomplete.enable, document.languageId);
  }

  refresh() {
    const editor = vscode.window.activeTextEditor;
    const document = editor?.document;
    const config = getConfig();
    const snoozed = this.isSnoozed();
    const languageEnabled = document ? isLanguageEnabled(config.autocomplete.enable, document.languageId) : isLanguageEnabled(config.autocomplete.enable, '*');
    const enabled = Boolean(config.autocomplete.enabled && !snoozed && languageEnabled);

    if (snoozed) this.status.text = '$(clock)';
    else if (enabled) this.status.text = '$(sparkle)';
    else this.status.text = '$(circle-slash)';

    const state = snoozed
      ? `Snoozed until ${new Date(this.snoozedUntil).toLocaleTimeString()}`
      : enabled ? 'Inline suggestions enabled' : 'Inline suggestions disabled';
    const language = document ? describeDocument(document) : 'No file editor active';
    this.status.tooltip = `${state}\n${language}\nClick to configure llama.cpp inline suggestions.`;
    this.status.accessibilityInformation = { label: `llama.cpp Assistant. ${state}. ${language}.` };
  }

  async openMenu() {
    const editor = vscode.window.activeTextEditor;
    const document = editor?.document?.uri?.scheme === 'file' ? editor.document : undefined;
    const config = getConfig();
    const map = normalizeEnableMap(config.autocomplete.enable);
    const defaultEnabled = map['*'] !== false;
    const languageEnabled = document ? isLanguageEnabled(map, document.languageId) : undefined;
    const languageLabel = document ? describeDocument(document) : undefined;
    const snoozed = this.isSnoozed();

    const items = [];
    if (snoozed) {
      items.push({ label: '$(play) Resume inline suggestions', description: 'Cancel snooze now', action: 'resume' });
    } else {
      items.push(
        { label: '$(clock) Snooze 5 minutes', action: 'snooze', minutes: 5 },
        { label: '$(clock) Snooze 15 minutes', action: 'snooze', minutes: 15 },
        { label: '$(clock) Snooze 30 minutes', action: 'snooze', minutes: 30 }
      );
    }

    items.push({ kind: vscode.QuickPickItemKind.Separator, label: 'Inline suggestions' });
    items.push({
      label: `${config.autocomplete.enabled ? '$(check)' : '$(circle-slash)'} ${config.autocomplete.enabled ? 'Disable' : 'Enable'} inline suggestions globally`,
      description: 'Master switch for llama.cpp inline suggestions',
      action: 'toggleMaster'
    });
    items.push({
      label: `${defaultEnabled ? '$(check)' : '$(circle-slash)'} ${defaultEnabled ? 'Disable' : 'Enable'} by default for all languages`,
      description: 'Default used when a language has no override',
      action: 'toggleDefault'
    });

    if (document) {
      const hasOverride = Object.prototype.hasOwnProperty.call(map, document.languageId);
      items.push({
        label: `${languageEnabled ? '$(check)' : '$(circle-slash)'} ${languageEnabled ? 'Disable' : 'Enable'} for ${languageLabel}`,
        description: hasOverride ? 'Language override is set' : 'Currently inherits the global default',
        action: 'toggleLanguage',
        languageId: document.languageId
      });
      if (hasOverride) {
        items.push({
          label: `$(discard) Reset ${languageLabel} to global default`,
          description: 'Remove the language-specific override',
          action: 'resetLanguage',
          languageId: document.languageId
        });
      }
    }

    items.push({ kind: vscode.QuickPickItemKind.Separator, label: 'Actions' });
    if (document && this.isEnabledForDocument(document)) {
      items.push({ label: '$(sparkle) Trigger inline suggestion now', action: 'trigger' });
    }
    items.push(
      { label: '$(comment-discussion) Open llama.cpp Chat', action: 'chat' },
      { label: '$(pulse) Show performance metrics', action: 'metrics' },
      { label: '$(settings-gear) Open inline suggestion settings', action: 'settings' }
    );

    const choice = await vscode.window.showQuickPick(items, {
      title: 'llama.cpp Assistant',
      placeHolder: snoozed ? 'Inline suggestions are temporarily snoozed' : 'Configure inline suggestions'
    });
    if (!choice?.action) return;

    if (choice.action === 'resume') await this.setSnooze(0);
    else if (choice.action === 'snooze') await this.setSnooze(choice.minutes);
    else if (choice.action === 'toggleMaster') await this.setMasterEnabled(!config.autocomplete.enabled);
    else if (choice.action === 'toggleDefault') await this.updateEnableMap('*', !defaultEnabled);
    else if (choice.action === 'toggleLanguage') await this.updateEnableMap(choice.languageId, !languageEnabled);
    else if (choice.action === 'resetLanguage') await this.removeLanguageOverride(choice.languageId);
    else if (choice.action === 'trigger') await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    else if (choice.action === 'chat') await vscode.commands.executeCommand('llamaCpp.openChat');
    else if (choice.action === 'metrics') await vscode.commands.executeCommand('llamaCpp.showPerformanceMetrics');
    else if (choice.action === 'settings') await vscode.commands.executeCommand('workbench.action.openSettings', 'llamaCpp.autocomplete');

    this.refresh();
  }

  async setSnooze(minutes) {
    const until = minutes > 0 ? Date.now() + minutes * 60 * 1000 : 0;
    await this.context.globalState.update(SNOOZE_STATE_KEY, until || undefined);
    this.refresh();
    if (minutes > 0) vscode.window.showInformationMessage(`llama.cpp inline suggestions snoozed for ${minutes} minutes.`);
  }

  async setMasterEnabled(enabled) {
    const configuration = vscode.workspace.getConfiguration('llamaCpp');
    await configuration.update('autocomplete.enabled', Boolean(enabled), vscode.ConfigurationTarget.Global);
  }

  async updateEnableMap(languageId, enabled) {
    const configuration = vscode.workspace.getConfiguration('llamaCpp');
    const map = normalizeEnableMap(configuration.get('autocomplete.enable', { '*': true, plaintext: false, markdown: false, scminput: false }));
    map[languageId] = Boolean(enabled);
    await configuration.update('autocomplete.enable', map, vscode.ConfigurationTarget.Global);
  }

  async removeLanguageOverride(languageId) {
    const configuration = vscode.workspace.getConfiguration('llamaCpp');
    const map = normalizeEnableMap(configuration.get('autocomplete.enable', { '*': true, plaintext: false, markdown: false, scminput: false }));
    delete map[languageId];
    await configuration.update('autocomplete.enable', map, vscode.ConfigurationTarget.Global);
  }
}

function normalizeEnableMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { '*': true };
  const out = {};
  for (const [key, enabled] of Object.entries(value)) out[String(key)] = Boolean(enabled);
  if (!Object.prototype.hasOwnProperty.call(out, '*')) out['*'] = true;
  return out;
}

function isLanguageEnabled(value, languageId) {
  const map = normalizeEnableMap(value);
  if (languageId && languageId !== '*' && Object.prototype.hasOwnProperty.call(map, languageId)) return map[languageId];
  return map['*'] !== false;
}

function describeDocument(document) {
  const extension = path.extname(document.uri.fsPath || '');
  const language = String(document.languageId || 'unknown');
  return extension ? `${language} (${extension})` : language;
}

module.exports = { InlineSuggestionsController, isLanguageEnabled, normalizeEnableMap };
