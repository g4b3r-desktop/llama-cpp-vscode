class HttpError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function requestJson(url, init, timeoutMs, externalSignal) {
  const { response, cleanup } = await fetchWithTimeout(url, init, timeoutMs, externalSignal);
  try {
    const text = await response.text();
    if (!response.ok) {
      throw new HttpError(`HTTP ${response.status} ${response.statusText} from ${url}`, response.status, text);
    }
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON returned by ${url}: ${text.slice(0, 400)}`);
    }
  } finally {
    cleanup();
  }
}

async function requestSse(url, init, timeoutMs, externalSignal, onEvent) {
  const { response, cleanup } = await fetchWithTimeout(url, init, timeoutMs, externalSignal);
  try {
    if (!response.ok) {
      const text = await response.text();
      throw new HttpError(`HTTP ${response.status} ${response.statusText} from ${url}`, response.status, text);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!response.body || !contentType.includes('text/event-stream')) {
      const text = await response.text();
      if (!text) return;
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      await onEvent(data);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let dataLines = [];

    const dispatch = async () => {
      if (!dataLines.length) return;
      const payload = dataLines.join('\n');
      dataLines = [];
      if (payload === '[DONE]') return;
      let parsed;
      try { parsed = JSON.parse(payload); } catch { parsed = payload; }
      await onEvent(parsed);
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line) {
          await dispatch();
          continue;
        }
        if (line.startsWith(':')) continue;
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
    }
    if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).trimStart());
    await dispatch();
  } finally {
    cleanup();
  }
}

async function fetchWithTimeout(url, init, timeoutMs, externalSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromExternal = () => controller.abort();
  externalSignal?.addEventListener('abort', abortFromExternal, { once: true });

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        ...(init.headers || {})
      }
    });
    return {
      response,
      cleanup: () => {
        clearTimeout(timeout);
        externalSignal?.removeEventListener('abort', abortFromExternal);
      }
    };
  } catch (error) {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abortFromExternal);
    throw error;
  }
}

module.exports = { HttpError, requestJson, requestSse };
