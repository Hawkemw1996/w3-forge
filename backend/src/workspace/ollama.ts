import { AdminError } from '../admin/envelope';

export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface Model { name: string; size: number | null; parameterSize: string | null }
export interface ModelInventory { models: Model[]; defaultModel: string | null }
type Fetch = typeof fetch;

export function validateMessages(body: unknown): { model: string; messages: ChatMessage[] } {
  const value = body as { model?: unknown; messages?: unknown };
  if (!value || typeof value.model !== 'string' || value.model.length > 160 ||
      !Array.isArray(value.messages) || !value.messages.length || value.messages.length > 40) {
    throw new AdminError(400, 'INVALID_CHAT', 'Choose an installed model and send 1–40 messages.');
  }
  let length = 0;
  const messages = value.messages.map((message: unknown) => {
    const item = message as ChatMessage;
    if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string' ||
        !item.content.trim() || (length += item.content.length) > 32000) {
      throw new AdminError(400, 'INVALID_CHAT', 'Messages must contain text and total at most 32,000 characters.');
    }
    return { role: item.role, content: item.content };
  });
  if (messages[messages.length - 1].role !== 'user') throw new AdminError(400, 'INVALID_CHAT', 'Send a user message to continue.');
  return { model: value.model, messages };
}

/** Only server configuration selects the upstream. No browser URL or tool execution. */
export function createOllama(options: { baseUrl?: string; preferredModel?: string; fetchImpl?: Fetch } = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const raw = options.baseUrl ?? process.env.W3_FORGE_OLLAMA_URL ?? 'http://127.0.0.1:11434';
  const preferred = options.preferredModel ?? process.env.W3_FORGE_OLLAMA_MODEL ?? 'qwen2.5-coder:14b';
  function endpoint(route: string): string {
    try {
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw Error();
      return new URL(route, url).href;
    } catch { throw new AdminError(503, 'OLLAMA_CONFIGURATION', 'The Ollama server address is invalid.'); }
  }
  async function inventory(signal?: AbortSignal): Promise<ModelInventory> {
    try {
      const response = await fetchImpl(endpoint('/api/tags'), { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]) });
      if (!response.ok || !response.body) throw Error();
      const reader = response.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 262144) throw Error(); chunks.push(value); }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Array.isArray(data.models) || data.models.length > 100) throw Error();
      const models: Model[] = data.models.map((item: any) => {
        if (typeof item?.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(item.name)) throw Error();
        return { name: item.name, size: Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : null,
          parameterSize: typeof item.details?.parameter_size === 'string' ? item.details.parameter_size.slice(0, 40) : null };
      });
      return { models, defaultModel: models.find(model => model.name === preferred)?.name ?? models[0]?.name ?? null };
    } catch (error) {
      if (error instanceof AdminError) throw error;
      throw new AdminError(503, 'OLLAMA_UNAVAILABLE', 'Ollama could not be reached or returned an invalid model list.');
    }
  }
  async function chat(model: string, messages: ChatMessage[], signal: AbortSignal, emit: (data: { delta: string }) => Promise<void>): Promise<void> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const upstream = new AbortController();
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    void aborted.catch(() => undefined);
    const onAbort = () => rejectAbort(Error('Generation stopped'));
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal.aborted) throw Error('Generation stopped');
      const response = await fetchImpl(endpoint('/api/chat'), { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, upstream.signal]),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages, stream: true, options: { num_predict: 4096 } }) });
      if (!response.ok || !response.body) throw Error();
      reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '', total = 0, complete = false;
      const consume = async (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line);
        if (event.error || (event.message?.content !== undefined && typeof event.message.content !== 'string')) throw Error();
        const delta = event.message?.content ?? '';
        total += delta.length; if (total > 65536) throw Error();
        if (delta) await emit({ delta });
        if (event.done === true) complete = true;
      };
      while (!complete) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        if (buffer.length > 131072) throw Error();
        let index: number;
        while (!complete && (index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); await consume(line); }
        if (done) { if (!complete && buffer) await consume(buffer); break; }
      }
      if (!complete) throw Error();
    } catch {
      throw new AdminError(502, 'OLLAMA_CHAT_FAILED', signal.aborted ? 'Generation stopped or timed out.' : 'Ollama did not complete the response. Try again.');
    } finally {
      // Abort releases the upstream independently of a potentially stalled stream cancellation.
      // The HTTP route announces completion only after this cleanup and slot release.
      signal.removeEventListener('abort', onAbort); upstream.abort();
      if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
    }
  }
  return { inventory, chat };
}
