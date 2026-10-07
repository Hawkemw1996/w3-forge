import { AdminError } from '../admin/envelope';

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

// The deadline covers headers AND streamed response body; no upstream errors/body are exposed.
export async function boundedJson(fetcher: Fetcher, url: string, init: RequestInit, timeoutMs: number, maxBytes = 1_048_576): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(url, { ...init, redirect: 'manual', signal: controller.signal });
    if (!res.ok || res.status >= 300 || res.redirected) throw new Error('response');
    const length = Number(res.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) throw new Error('length');
    if (!res.body) throw new Error('body');
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maxBytes) { controller.abort(); throw new Error('length'); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new AdminError(502, 'PRICING_UPSTREAM_UNAVAILABLE', 'The pricing provider did not return a valid bounded response.');
  } finally { clearTimeout(timer); }
}
