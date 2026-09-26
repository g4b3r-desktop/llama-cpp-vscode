const vscode = require('vscode');
const { buildChatContext } = require('./chatPanel');
const { getConfig } = require('./config');
const { VENDOR } = require('./nativeModelProvider');

const PARTICIPANT_ID = 'llama-cpp-assistant.llama';

function registerNativeChat(context, client, workspaceIndex) {
  if (!vscode.chat?.createChatParticipant) return undefined;

  const handler = async (request, chatContext, stream, token) => {
    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    try {
      const command = request.command || '';
      const commandPrompt = commandInstruction(command);
      const referenceContext = await resolveReferences(request.references || [], stream);
      const includeActiveFile = referenceContext.blocks.length ? false : getConfig().chat.includeEditorContext;
      const autoContext = await buildChatContext(request.prompt, workspaceIndex, controller.signal, {
        includeActiveFile,
        editor: vscode.window.activeTextEditor,
        forceCodebase: command === 'codebase'
      });

      const messages = [
        {
          role: 'system',
          content: [
            'You are llama.cpp Assistant inside Visual Studio Code.',
            'Be precise, practical, and code-aware. Use GitHub-flavored Markdown.',
            'When context contains filenames or line ranges, cite them naturally.',
            'Do not claim to have read files that were not supplied.',
            commandPrompt
          ].filter(Boolean).join('\n')
        },
        ...historyMessages(chatContext.history || []),
        {
          role: 'user',
          content: [request.prompt, referenceContext.blocks.join('\n\n'), autoContext.text].filter(Boolean).join('\n\n')
        }
      ];

      const modelOverride = request.model?.vendor === VENDOR ? request.model.id : undefined;
      const answer = await client.chatStream(
        messages,
        controller.signal,
        delta => stream.markdown(delta),
        { model: modelOverride }
      );

      return {
        metadata: {
          command,
          model: modelOverride || getConfig().api.model || '',
          answerLength: answer.length,
          references: referenceContext.labels
        }
      };
    } catch (error) {
      if (controller.signal.aborted) return;
      client.logError('native chat', error);
      return { errorDetails: { message: error instanceof Error ? error.message : String(error) } };
    } finally {
      cancellation.dispose();
    }
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = new vscode.ThemeIcon('sparkle');
  participant.followupProvider = {
    provideFollowups() {
      return [
        { prompt: 'Explain the most important part of this code', command: 'explain' },
        { prompt: 'Review this code for bugs and edge cases', command: 'review' },
        { prompt: 'Suggest a safe refactor', command: 'refactor' }
      ];
    }
  };
  return participant;
}

async function resolveReferences(references, stream) {
  const blocks = [];
  const labels = [];
  let remaining = 40000;
  for (const reference of references) {
    if (remaining <= 0) break;
    const value = reference?.value;
    let uri;
    let range;
    if (value instanceof vscode.Uri) uri = value;
    else if (value instanceof vscode.Location) { uri = value.uri; range = value.range; }
    if (!uri || uri.scheme !== 'file') continue;
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      let text = range ? doc.getText(range) : doc.getText();
      text = text.slice(0, remaining);
      remaining -= text.length;
      const label = vscode.workspace.asRelativePath(uri, true);
      labels.push(label);
      blocks.push(`<attached_context file="${escapeAttr(label)}" language="${escapeAttr(doc.languageId)}">\n${text}\n</attached_context>`);
      if (typeof stream.reference === 'function') stream.reference(range ? new vscode.Location(uri, range) : uri);
    } catch { /* ignore unreadable reference */ }
  }
  return { blocks, labels };
}

function historyMessages(history) {
  const out = [];
  for (const turn of history.slice(-10)) {
    if (turn && typeof turn.prompt === 'string') {
      out.push({ role: 'user', content: turn.prompt });
      continue;
    }
    if (turn?.response && Array.isArray(turn.response)) {
      const text = turn.response.map(part => {
        const value = part?.value;
        if (typeof value === 'string') return value;
        if (typeof value?.value === 'string') return value.value;
        return '';
      }).join('');
      if (text) out.push({ role: 'assistant', content: text });
    }
  }
  return out;
}

function commandInstruction(command) {
  const commands = {
    explain: 'Explain the relevant code clearly, including data flow and important edge cases.',
    fix: 'Find the bug or defect and propose the smallest safe fix. Show changed code when useful.',
    review: 'Perform a code review focused on correctness, security, maintainability, and performance. Prioritize concrete findings.',
    tests: 'Generate focused tests for the supplied code, covering happy paths, edge cases, and failure cases.',
    refactor: 'Propose a behavior-preserving refactor. Prefer small, reviewable changes and explain tradeoffs.',
    codebase: 'Use workspace context aggressively to answer as a codebase-aware assistant.'
  };
  return commands[command] || '';
}

function escapeAttr(value) {
  return String(value).replace(/[&"<>]/g, char => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[char]));
}

module.exports = { registerNativeChat, PARTICIPANT_ID };
