import { consoleMachineText } from '../../../../shared/consoleApp';
import { AdminApiError, ApiEnvelope } from './api';

export interface TerminalStatus {
  enabled: boolean; supported: boolean; available: boolean; hostname: string;
  access: 'root-shell' | 'root-login'; message: string;
}
export interface TerminalSize { cols: number; rows: number }
interface Session { id: string; hostname: string; access: TerminalStatus['access'] }
interface Output { output: string; cursor: number; closed: boolean; reason?: string }
export interface TerminalTransport {
  <T>(path: string, options?: { body?: unknown; signal?: AbortSignal; keepalive?: boolean }): Promise<T>;
}

export const terminalRequest: TerminalTransport = async <T>(path: string, options: { body?: unknown; signal?: AbortSignal; keepalive?: boolean } = {}) => {
  const response = await fetch(`/api/admin/terminal${path}`, {
    method: options.body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-W3-Terminal': '1' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal, keepalive: options.keepalive
  });
  let envelope: ApiEnvelope<T> | undefined;
  try { envelope = await response.json(); } catch { /* Render a useful error for proxy/HTML failures. */ }
  if (!response.ok || !envelope?.success) {
    const error = envelope && !envelope.success ? envelope.error : undefined;
    const code = error?.code ?? 'TERMINAL_CONNECTION_FAILED';
    if (['AUTH_REQUIRED', 'APP_ADMIN_REQUIRED', 'CORE_UNAVAILABLE', 'CORE_NOT_CONFIGURED'].includes(code)) {
      window.dispatchEvent(new Event('w3-auth-problem'));
    }
    throw new AdminApiError(response.status, code,
      error?.message ?? consoleMachineText('Could not reach the container terminal. Reconnect to try again.'));
  }
  return envelope.data as T;
};

/** Ordered input and acknowledged output; command requests are never retried. */
export class TerminalConnection {
  private session?: Session;
  private abort = new AbortController();
  private stopped = false;
  private queue = '';
  private sending = false;
  private inputTimer?: ReturnType<typeof setTimeout>;
  constructor(private callbacks: {
    output(data: string): Promise<void>;
    connected(session: Session): void;
    closed(reason: string, error: boolean): void;
  }, private request: TerminalTransport = terminalRequest) {}

  async connect(size: TerminalSize): Promise<void> {
    try {
      // Do not abort creation: if navigation wins the race, close the returned session.
      const session = await this.request<Session>('/sessions', { body: size });
      this.session = session;
      if (this.stopped) { await this.closeRemote(); return; }
      this.callbacks.connected(session);
      void this.read();
    } catch (error) { this.fail(error); }
  }

  private path(suffix: string): string { return `/sessions/${encodeURIComponent(this.session!.id)}/${suffix}`; }

  private async read(): Promise<void> {
    let cursor = 0;
    try {
      while (!this.stopped) {
        const result = await this.request<Output>(this.path(`output?cursor=${cursor}`), { signal: this.abort.signal });
        if (this.stopped) return;
        if (result.output) await this.callbacks.output(result.output);
        cursor = result.cursor;
        if (result.closed) { this.stop(result.reason ?? 'Shell closed.'); return; }
      }
    } catch (error) { this.fail(error); }
  }

  send(data: string): void {
    if (this.stopped || !this.session || !data) return;
    if (this.queue.length + data.length > 65_536) { this.fail(new Error('Paste is too large. Reconnect and paste smaller sections.')); return; }
    this.queue += data;
    if (!this.inputTimer && !this.sending) this.inputTimer = setTimeout(() => { this.inputTimer = undefined; void this.flush(); }, 10);
  }

  private async flush(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue && !this.stopped) {
        const data = this.queue.slice(0, 4096);
        this.queue = this.queue.slice(data.length);
        await this.request(this.path('input'), { body: { data }, signal: this.abort.signal });
      }
    } catch (error) { this.fail(error); }
    finally { this.sending = false; }
  }

  async resize(size: TerminalSize): Promise<void> {
    if (this.stopped || !this.session) return;
    try { await this.request(this.path('resize'), { body: size, signal: this.abort.signal }); }
    catch (error) { this.fail(error); }
  }

  private fail(error: unknown): void {
    if (this.stopped) return;
    this.stop(error instanceof Error ? error.message : 'Terminal connection failed.', true);
  }

  private async closeRemote(): Promise<void> {
    if (!this.session) return;
    try { await this.request(this.path('close'), { body: {}, keepalive: true }); }
    catch { /* Server disconnect/authorization timers also dispose of orphaned sessions. */ }
  }

  stop(reason = 'Disconnected.', error = false): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    if (this.inputTimer) clearTimeout(this.inputTimer);
    this.queue = '';
    void this.closeRemote();
    this.callbacks.closed(reason, error);
  }
}
