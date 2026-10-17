import { ApiError } from '../lib/authApi';

export interface Message { role: 'user' | 'assistant'; content: string; incomplete?: boolean; model?: string }
/** Each line uses the same success/error envelope as the rest of Forge. */
export async function readChatStream(response: Response, onDelta: (delta: string) => void, signal?: AbortSignal, onRequestId?: (requestId: string) => void): Promise<void> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(response.status, body?.error?.code ?? 'CHAT_FAILED', body?.error?.message ?? 'The chat request failed.');
  }
  if (!response.body || !response.headers.get('content-type')?.includes('application/x-ndjson')) throw Error('Chat streaming is unavailable.');
  if (signal?.aborted) throw new DOMException('Generation stopped.', 'AbortError');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let rejectAbort: ((error: Error) => void) | undefined;
  const aborted = signal ? new Promise<never>((_resolve, reject) => { rejectAbort = reject; }) : undefined;
  const onAbort = () => rejectAbort?.(new DOMException('Generation stopped.', 'AbortError'));
  signal?.addEventListener('abort', onAbort, { once: true });
  let buffer = '', complete = false, total = 0;
  function consume(line: string) {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.success !== true) throw Error(event.error?.message ?? 'Generation did not complete.');
    if (typeof event.data?.requestId === 'string' && /^[a-f0-9-]{36}$/.test(event.data.requestId)) onRequestId?.(event.data.requestId);
    if (event.data?.delta !== undefined) {
      if (typeof event.data.delta !== 'string' || (total += event.data.delta.length) > 65536) throw Error('Invalid chat response.');
      onDelta(event.data.delta);
    }
    if (event.data?.done === true) complete = true;
  }
  try {
    while (!complete) {
      if (signal?.aborted) throw new DOMException('Generation stopped.', 'AbortError');
      const { done, value } = await (aborted ? Promise.race([reader.read(), aborted]) : reader.read());
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 131072) throw Error('Invalid chat response.');
      let index: number;
      while (!complete && (index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); consume(line); }
      if (done) { if (!complete && buffer) consume(buffer); break; }
    }
    if (!complete) throw Error('The connection ended before the response completed.');
  } finally { signal?.removeEventListener('abort', onAbort); void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export async function sendChat(model: string, messages: Message[], signal: AbortSignal, onDelta: (delta: string) => void, onRequestId?: (requestId: string) => void) {
  const response = await fetch('/api/forge/chat', { method: 'POST', credentials: 'same-origin', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify({ model, messages: messages.filter(message => !message.incomplete).map(({ role, content }) => ({ role, content })) }) });
  await readChatStream(response, onDelta, signal, onRequestId);
}
