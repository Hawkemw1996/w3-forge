import { randomUUID } from 'node:crypto';

export interface TerminalIdentity { userId: string; sessionHash: string }
export interface TerminalSize { cols: number; rows: number }
export interface TerminalProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(force?: boolean): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void };
}
export class TerminalError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
interface Session {
  id: string;
  identity: TerminalIdentity;
  process: TerminalProcess;
  createdAt: number;
  lastInput: number;
  lastContact: number;
  buffer: string;
  offset: number;
  closedAt?: number;
  reason?: string;
  exitCode?: number;
  wake?: () => void;
  reading: boolean;
  subscriptions: Array<{ dispose(): void }>;
}
interface Options {
  spawn(size: TerminalSize): TerminalProcess;
  authorize(identity: TerminalIdentity): Promise<boolean>;
  audit(event: { sessionId: string; userId: string; phase: 'opened' | 'closed'; reason?: string }): void;
  now?: () => number;
  maxSessions?: number;
  maxBuffer?: number;
  idleMs?: number;
  disconnectMs?: number;
  pollMs?: number;
}

/** Login-bound PTYs. Output is memory-only and acknowledged by cursor, never logged. */
export class TerminalSessionManager {
  private sessions = new Map<string, Session>();
  private timer?: ReturnType<typeof setInterval>;
  private reaping = false;
  private stopped = false;
  private now: () => number;
  constructor(private options: Options) { this.now = options.now ?? Date.now; }

  create(identity: TerminalIdentity, size: TerminalSize): { id: string } {
    if (this.stopped) throw new TerminalError(503, 'TERMINAL_STOPPING', 'The service is stopping.');
    const active = [...this.sessions.values()].filter(s => s.closedAt === undefined);
    if (active.some(s => s.identity.sessionHash === identity.sessionHash)) {
      throw new TerminalError(409, 'TERMINAL_ALREADY_OPEN', 'This login already has an open terminal. Disconnect it or close its tab and wait 15 seconds.');
    }
    if (active.length >= (this.options.maxSessions ?? 4) || active.filter(s => s.identity.userId === identity.userId).length >= 2) {
      throw new TerminalError(429, 'TERMINAL_LIMIT', 'The terminal session limit has been reached.');
    }
    // Remove completed sessions for this login before allocating another buffer.
    for (const s of this.sessions.values()) {
      if (s.closedAt !== undefined && s.identity.sessionHash === identity.sessionHash) this.sessions.delete(s.id);
    }
    const child = this.options.spawn(size);
    const now = this.now();
    const s: Session = { id: randomUUID(), identity: { ...identity }, process: child,
      createdAt: now, lastInput: now, lastContact: now, buffer: '', offset: 0,
      reading: false, subscriptions: [] };
    this.sessions.set(s.id, s);
    s.subscriptions.push(child.onData(data => {
      if (s.closedAt !== undefined) return;
      if (s.buffer.length + data.length > (this.options.maxBuffer ?? 1_048_576)) {
        this.finish(s, 'Output limit reached. Reconnect to start a new terminal.');
        return;
      }
      s.buffer += data;
      s.wake?.();
    }));
    s.subscriptions.push(child.onExit(({ exitCode }) => {
      s.exitCode = exitCode;
      this.finish(s, `Shell exited (${exitCode}).`, false);
    }));
    this.options.audit({ sessionId: s.id, userId: identity.userId, phase: 'opened' });
    if (!this.timer) {
      this.timer = setInterval(() => { void this.reap(); }, 2_000);
      this.timer.unref();
    }
    return { id: s.id };
  }

  private own(id: string, identity: TerminalIdentity): Session {
    const s = this.sessions.get(id);
    if (!s || s.identity.userId !== identity.userId || s.identity.sessionHash !== identity.sessionHash) {
      throw new TerminalError(404, 'TERMINAL_NOT_FOUND', 'This terminal is no longer available for this login.');
    }
    return s;
  }

  private active(id: string, identity: TerminalIdentity): Session {
    const s = this.own(id, identity);
    if (s.closedAt !== undefined) throw new TerminalError(410, 'TERMINAL_CLOSED', s.reason ?? 'Terminal closed.');
    s.lastContact = this.now();
    return s;
  }

  write(id: string, identity: TerminalIdentity, data: string): void {
    const s = this.active(id, identity);
    s.lastInput = this.now();
    try { s.process.write(data); }
    catch { this.finish(s, 'Shell input failed.'); throw new TerminalError(410, 'TERMINAL_CLOSED', 'The shell is no longer accepting input.'); }
  }

  resize(id: string, identity: TerminalIdentity, size: TerminalSize): void {
    const s = this.active(id, identity);
    try { s.process.resize(size.cols, size.rows); }
    catch { this.finish(s, 'Terminal resize failed.'); throw new TerminalError(410, 'TERMINAL_CLOSED', 'The shell is no longer available.'); }
  }

  close(id: string, identity: TerminalIdentity): void {
    this.finish(this.own(id, identity), 'Disconnected.');
  }

  async read(id: string, identity: TerminalIdentity, cursor: number, signal?: AbortSignal) {
    const s = this.own(id, identity);
    if (s.reading) throw new TerminalError(409, 'TERMINAL_READER_BUSY', 'A terminal read is already pending.');
    if (!Number.isSafeInteger(cursor) || cursor < s.offset || cursor > s.offset + s.buffer.length) {
      throw new TerminalError(409, 'TERMINAL_CURSOR_INVALID', 'Terminal output is out of sync. Reconnect to continue.');
    }
    s.buffer = s.buffer.slice(cursor - s.offset);
    s.offset = cursor;
    s.lastContact = this.now();
    s.reading = true;
    try {
      if (!s.buffer && s.closedAt === undefined && !signal?.aborted) {
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timeout); signal?.removeEventListener('abort', done); s.wake = undefined; resolve(); };
          const timeout = setTimeout(done, this.options.pollMs ?? 1_000);
          s.wake = done;
          signal?.addEventListener('abort', done, { once: true });
        });
      }
      // Check again after a held read: expired/revoked sessions must not receive output.
      let authorized = false;
      try { authorized = await this.options.authorize(identity); } catch { /* Fail closed. */ }
      if (!authorized) {
        this.finish(s, 'Administrator login expired or access was removed.');
        s.buffer = '';
        throw new TerminalError(401, 'TERMINAL_AUTH_EXPIRED', 'Sign in again to open a terminal.');
      }
      s.lastContact = this.now();
      const output = s.buffer.slice(0, 65_536);
      // Drain all buffered output before reporting shell exit to the client.
      const closed = s.closedAt !== undefined && output.length === s.buffer.length;
      return { output, cursor: s.offset + output.length, closed,
        reason: closed ? s.reason : undefined, exitCode: closed ? s.exitCode : undefined };
    } finally { s.reading = false; }
  }

  private finish(s: Session, reason: string, kill = true, force = false): void {
    if (s.closedAt !== undefined) return;
    s.closedAt = this.now();
    s.reason = reason;
    if (kill) { try { s.process.kill(force); } catch { /* Process may already have exited. */ } }
    for (const subscription of s.subscriptions) subscription.dispose();
    s.wake?.();
    this.options.audit({ sessionId: s.id, userId: s.identity.userId, phase: 'closed', reason });
  }

  async reap(): Promise<void> {
    if (this.reaping) return;
    this.reaping = true;
    try {
      for (const s of this.sessions.values()) {
        const now = this.now();
        if (s.closedAt !== undefined) {
          if (now - s.closedAt > 30_000) this.sessions.delete(s.id);
          continue;
        }
        if (now - s.lastContact > (this.options.disconnectMs ?? 15_000)) this.finish(s, 'Connection lost.');
        else if (now - s.lastInput > (this.options.idleMs ?? 900_000)) this.finish(s, 'Closed after 15 minutes without input.');
        else if (now - s.createdAt > 14_400_000) this.finish(s, 'Maximum session duration reached.');
        else {
          let allowed = false;
          try { allowed = await this.options.authorize(s.identity); } catch { /* Fail closed. */ }
          if (!allowed) { this.finish(s, 'Administrator login expired or access was removed.'); s.buffer = ''; }
        }
      }
      if (!this.sessions.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
    } finally { this.reaping = false; }
  }

  shutdown(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const s of this.sessions.values()) this.finish(s, 'Service is stopping.', true, true);
    this.sessions.clear();
  }
}
