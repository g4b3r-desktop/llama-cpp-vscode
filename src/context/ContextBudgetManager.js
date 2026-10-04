const CONTEXT_MARKERS = [
  '\n\n<attached_context',
  '\n\n<mentioned_file',
  '\n\n<editor_context',
  '\n\n<visible_editor',
  '\n\n<workspace_chunk',
  '\n\nExplicitly attached context:'
];
const USER_TRUNCATION_NOTE = '\n\n[contexto adicional reduzido automaticamente para caber na janela do modelo]';
const SYSTEM_SUMMARY_MARKER = '\nInitial workspace entries (summary only):';

class ContextBudgetManager {
  constructor(options = {}) {
    this.charactersPerToken = clampNumber(options.charactersPerToken, 2, 8, 3);
    this.safetyMarginTokens = Math.max(0, Math.floor(Number(options.safetyMarginTokens ?? 128)));
    this.minOutputTokens = Math.max(1, Math.floor(Number(options.minOutputTokens ?? 256)));
  }

  async fit({ messages, tools = [], contextWindowTokens, requestedOutputTokens, countTokens, mode = 'chat' }) {
    const limit = Math.max(256, Math.floor(Number(contextWindowTokens || 0)));
    const requested = Math.max(1, Math.floor(Number(requestedOutputTokens || 1)));
    const safety = Math.min(this.safetyMarginTokens, Math.max(0, limit - 128));
    const minOutput = Math.min(requested, this.minOutputTokens, Math.max(1, limit - safety - 64));
    let outputTokens = Math.min(requested, Math.max(minOutput, limit - safety - 64));
    let inputBudget = Math.max(64, limit - safety - outputTokens);
    let working = cloneMessages(messages);
    const stats = {
      contextWindowTokens: limit,
      requestedOutputTokens: requested,
      maxOutputTokens: outputTokens,
      safetyMarginTokens: safety,
      inputBudgetTokens: inputBudget,
      inputTokens: 0,
      trimmed: false,
      historyMessagesDropped: 0,
      agentGroupsDropped: 0,
      toolMessagesCompacted: 0,
      userContextCharactersDropped: 0,
      systemCharactersDropped: 0,
      outputTokensReduced: 0,
      usedExactCounter: false
    };

    const measure = async candidate => {
      if (typeof countTokens === 'function') {
        try {
          const exact = Number(await countTokens(candidate, tools));
          if (Number.isFinite(exact) && exact >= 0) {
            stats.usedExactCounter = true;
            return Math.ceil(exact);
          }
        } catch {}
      }
      return estimateInputTokens(candidate, tools, this.charactersPerToken);
    };

    let inputTokens = await measure(working);

    if (inputTokens > inputBudget) {
      if (mode === 'agent') {
        const compacted = await compactToolMessagesToFit(working, inputBudget, measure);
        working = compacted.messages;
        stats.toolMessagesCompacted += compacted.compacted;
        inputTokens = compacted.inputTokens;
        while (inputTokens > inputBudget) {
          const dropped = dropOldestAgentGroup(working);
          if (!dropped) break;
          working = dropped.messages;
          stats.agentGroupsDropped += dropped.count;
          inputTokens = await measure(working);
        }
      } else {
        while (inputTokens > inputBudget) {
          const dropped = dropOldestChatTurn(working);
          if (!dropped) break;
          working = dropped.messages;
          stats.historyMessagesDropped += dropped.count;
          inputTokens = await measure(working);
        }
      }
    }

    if (inputTokens > inputBudget) {
      const shrunk = await shrinkLastUserContextToFit(working, inputBudget, measure);
      working = shrunk.messages;
      stats.userContextCharactersDropped += shrunk.droppedCharacters;
      inputTokens = shrunk.inputTokens;
    }

    if (inputTokens > inputBudget) {
      const shrunk = await shrinkAgentSystemSummaryToFit(working, inputBudget, measure);
      working = shrunk.messages;
      stats.systemCharactersDropped += shrunk.droppedCharacters;
      inputTokens = shrunk.inputTokens;
    }

    if (inputTokens > inputBudget && outputTokens > minOutput) {
      const affordableOutput = Math.max(minOutput, limit - safety - inputTokens);
      const nextOutput = Math.min(outputTokens, affordableOutput);
      outputTokens = nextOutput;
      inputBudget = Math.max(64, limit - safety - outputTokens);
      inputTokens = await measure(working);
    }

    if (inputTokens > inputBudget) {
      const shrunk = await shrinkLastUserContextToFit(working, inputBudget, measure);
      working = shrunk.messages;
      stats.userContextCharactersDropped += shrunk.droppedCharacters;
      inputTokens = shrunk.inputTokens;
    }

    if (inputTokens > inputBudget) {
      const needed = inputTokens + outputTokens + safety;
      const error = new Error(`O contexto essencial exige aproximadamente ${inputTokens} tokens de entrada, mas a janela permite ${inputBudget} com ${outputTokens} reservados para saída (n_ctx=${limit}). Reduza o prompt/anexos ou aumente --ctx-size / llamaCpp.context.windowTokens.`);
      error.code = 'CONTEXT_BUDGET_EXCEEDED';
      error.details = { inputTokens, inputBudget, outputTokens, contextWindowTokens: limit, requiredTotalTokens: needed };
      throw error;
    }

    stats.inputTokens = inputTokens;
    stats.inputBudgetTokens = inputBudget;
    stats.maxOutputTokens = outputTokens;
    stats.outputTokensReduced = requested - outputTokens;
    stats.trimmed = stats.historyMessagesDropped > 0 || stats.agentGroupsDropped > 0 || stats.toolMessagesCompacted > 0 || stats.userContextCharactersDropped > 0 || stats.systemCharactersDropped > 0 || stats.outputTokensReduced > 0;
    return { messages: working, maxOutputTokens: outputTokens, stats };
  }
}

async function compactToolMessagesToFit(messages, budget, measure) {
  let working = cloneMessages(messages);
  let inputTokens = await measure(working);
  let compacted = 0;
  if (inputTokens <= budget) return { messages: working, inputTokens, compacted };
  for (const threshold of [8000, 4000, 2000, 1000]) {
    let changed = false;
    for (let i = 0; i < working.length; i += 1) {
      if (working[i]?.role !== 'tool') continue;
      const content = String(working[i].content || '');
      if (content.length <= threshold) continue;
      working[i] = { ...working[i], content: compactStructuredContent(content, threshold) };
      compacted += 1;
      changed = true;
    }
    if (!changed) continue;
    inputTokens = await measure(working);
    if (inputTokens <= budget) break;
  }
  return { messages: working, inputTokens, compacted };
}

function compactStructuredContent(content, maxCharacters) {
  const text = String(content || '');
  if (text.length <= maxCharacters) return text;
  const room = Math.max(200, maxCharacters - 120);
  const head = Math.max(80, Math.floor(room * 0.6));
  const tail = Math.max(40, room - head);
  return JSON.stringify({
    truncated: true,
    originalCharacters: text.length,
    excerpt: `${text.slice(0, head)}\n... [tool result compactado] ...\n${text.slice(-tail)}`
  });
}

function dropOldestChatTurn(messages) {
  const lastUser = findLastRole(messages, 'user');
  if (lastUser <= 1) return undefined;
  let start = 1;
  while (start < lastUser && messages[start]?.role === 'system') start += 1;
  if (start >= lastUser) return undefined;
  let end = start + 1;
  if (messages[start]?.role === 'user') {
    while (end < lastUser && messages[end]?.role !== 'assistant') end += 1;
    if (end < lastUser) end += 1;
  }
  const next = messages.slice(0, start).concat(messages.slice(end));
  return { messages: next, count: end - start };
}

function dropOldestAgentGroup(messages) {
  const initialUser = messages.findIndex(message => message?.role === 'user');
  if (initialUser < 0 || initialUser >= messages.length - 1) return undefined;
  let start = initialUser + 1;
  while (start < messages.length && messages[start]?.role !== 'assistant') start += 1;
  if (start >= messages.length) return undefined;
  let end = start + 1;
  while (end < messages.length && messages[end]?.role !== 'assistant') end += 1;
  if (end >= messages.length) return undefined;
  const next = messages.slice(0, start).concat(messages.slice(end));
  return { messages: next, count: end - start };
}

async function shrinkLastUserContextToFit(messages, budget, measure) {
  const index = findLastRole(messages, 'user');
  if (index < 0) return { messages, inputTokens: await measure(messages), droppedCharacters: 0 };
  const original = contentToText(messages[index]?.content);
  const boundary = inferUserPromptBoundary(original);
  if (boundary >= original.length) return { messages, inputTokens: await measure(messages), droppedCharacters: 0 };
  const minimum = Math.max(1, boundary);
  const candidateAtMinimum = replaceMessageContent(messages, index, truncateTextAt(original, minimum));
  const minimumTokens = await measure(candidateAtMinimum);
  if (minimumTokens > budget) return { messages: candidateAtMinimum, inputTokens: minimumTokens, droppedCharacters: original.length - minimum };
  let low = minimum;
  let high = original.length;
  let best = minimum;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = replaceMessageContent(messages, index, truncateTextAt(original, mid));
    const tokens = await measure(candidate);
    if (tokens <= budget) { best = mid; low = mid + 1; } else high = mid - 1;
  }
  const fitted = replaceMessageContent(messages, index, truncateTextAt(original, best));
  return { messages: fitted, inputTokens: await measure(fitted), droppedCharacters: Math.max(0, original.length - best) };
}

async function shrinkAgentSystemSummaryToFit(messages, budget, measure) {
  const index = messages.findIndex(message => message?.role === 'system');
  if (index < 0) return { messages, inputTokens: await measure(messages), droppedCharacters: 0 };
  const original = contentToText(messages[index]?.content);
  const marker = original.indexOf(SYSTEM_SUMMARY_MARKER);
  if (marker < 0) return { messages, inputTokens: await measure(messages), droppedCharacters: 0 };
  const prefix = `${original.slice(0, marker).trimEnd()}\nInitial workspace entries omitted by context budget.`;
  const candidate = replaceMessageContent(messages, index, prefix);
  const tokens = await measure(candidate);
  if (tokens > budget) return { messages: candidate, inputTokens: tokens, droppedCharacters: Math.max(0, original.length - prefix.length) };
  let low = marker;
  let high = original.length;
  let best = marker;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const text = mid >= original.length ? original : `${original.slice(0, mid).trimEnd()}\n... [workspace summary reduzido]`;
    const current = replaceMessageContent(messages, index, text);
    const currentTokens = await measure(current);
    if (currentTokens <= budget) { best = mid; low = mid + 1; } else high = mid - 1;
  }
  const text = best >= original.length ? original : `${original.slice(0, best).trimEnd()}\n... [workspace summary reduzido]`;
  const fitted = replaceMessageContent(messages, index, text);
  return { messages: fitted, inputTokens: await measure(fitted), droppedCharacters: Math.max(0, original.length - best) };
}

function inferUserPromptBoundary(content) {
  const text = String(content || '');
  let boundary = text.length;
  for (const marker of CONTEXT_MARKERS) {
    const index = text.indexOf(marker);
    if (index >= 0 && index < boundary) boundary = index;
  }
  return boundary;
}

function truncateTextAt(text, characters) {
  const value = String(text || '');
  if (characters >= value.length) return value;
  return `${value.slice(0, Math.max(1, characters)).trimEnd()}${USER_TRUNCATION_NOTE}`;
}

function replaceMessageContent(messages, index, content) {
  const next = cloneMessages(messages);
  next[index] = { ...next[index], content };
  return next;
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : (part?.text || part?.content || '')).join('');
  return content == null ? '' : String(content);
}

function findLastRole(messages, role) {
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]?.role === role) return i;
  return -1;
}

function estimateInputTokens(messages, tools = [], charactersPerToken = 3) {
  const messageChars = (messages || []).reduce((sum, message) => sum + contentToText(message?.content).length + safeJsonLength(message?.tool_calls) + safeJsonLength(message?.name) + 24, 0);
  const toolChars = safeJsonLength(tools);
  return Math.ceil((messageChars + toolChars) / Math.max(2, Number(charactersPerToken || 3))) + (messages?.length || 0) * 4 + (tools?.length || 0) * 8 + 16;
}

function extractLlamaContextWindow(props) {
  const values = [props?.default_generation_settings?.n_ctx, props?.slot_n_ctx, props?.n_ctx, props?.context_size];
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return Math.floor(number);
  }
  return undefined;
}

function parseContextSizeArgs(args) {
  const values = Array.isArray(args) ? args.map(String) : [];
  for (let i = 0; i < values.length; i += 1) {
    const current = values[i];
    const inline = current.match(/^(?:--ctx-size|-c)=(\d+)$/);
    if (inline) return Number(inline[1]);
    if ((current === '--ctx-size' || current === '-c') && /^\d+$/.test(values[i + 1] || '')) return Number(values[i + 1]);
  }
  return undefined;
}

function cloneMessages(messages) { return JSON.parse(JSON.stringify(Array.isArray(messages) ? messages : [])); }
function safeJsonLength(value) { if (value == null) return 0; try { return JSON.stringify(value).length; } catch { return String(value).length; } }
function clampNumber(value, min, max, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback; }

module.exports = { ContextBudgetManager, estimateInputTokens, extractLlamaContextWindow, parseContextSizeArgs, inferUserPromptBoundary, compactStructuredContent, dropOldestChatTurn, dropOldestAgentGroup };
