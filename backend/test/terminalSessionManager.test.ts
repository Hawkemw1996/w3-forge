import { afterEach, expect, it, vi } from 'vitest';
import { TerminalSessionManager } from '../src/admin/terminal/sessionManager';
import { fakeTerminal } from './terminalFixture';
const owner = { userId: '42', sessionHash: 'LOGIN_A' };
const size = { cols: 80, rows: 24 };
const managers: TerminalSessionManager[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.shutdown(); });
function fixture(options: Partial<ConstructorParameters<typeof TerminalSessionManager>[0]> = {}) {
  const processes: ReturnType<typeof fakeTerminal>[] = [], audit = vi.fn();
  const manager = new TerminalSessionManager({ spawn: () => { const p = fakeTerminal(); processes.push(p); return p; },
    authorize: async () => true, audit, pollMs: 1, ...options });
  managers.push(manager);
  return { manager, processes, audit };
}

it('binds a terminal to both user and login, and refuses duplicates before spawning', async () => {
  const { manager, processes } = fixture();
  const { id } = manager.create(owner, size);
  expect(() => manager.create(owner, size)).toThrowError(expect.objectContaining({ code: 'TERMINAL_ALREADY_OPEN' }));
  for (const stranger of [{ ...owner, userId: '99' }, { ...owner, sessionHash: 'LOGIN_B' }]) {
    expect(() => manager.write(id, stranger, 'whoami\r')).toThrowError(expect.objectContaining({ code: 'TERMINAL_NOT_FOUND' }));
    expect(() => manager.resize(id, stranger, size)).toThrow();
    expect(() => manager.close(id, stranger)).toThrow();
    await expect(manager.read(id, stranger, 0)).rejects.toMatchObject({ code: 'TERMINAL_NOT_FOUND' });
  }
  manager.write(id, owner, '\u0003'); manager.resize(id, owner, { cols: 100, rows: 40 });
  expect(processes).toHaveLength(1);
  expect(processes[0].write).toHaveBeenCalledWith('\u0003');
  expect(processes[0].resize).toHaveBeenCalledWith(100, 40);
});

it('retries output without loss, acknowledges buffers, and rejects stale cursors', async () => {
  const { manager, processes } = fixture(); const { id } = manager.create(owner, size);
  processes[0].output('\x1b[32mhello\r\n'); const first = await manager.read(id, owner, 0);
  expect((await manager.read(id, owner, 0)).output).toBe(first.output);
  processes[0].output('next'); expect((await manager.read(id, owner, first.cursor)).output).toBe('next');
  await expect(manager.read(id, owner, 0)).rejects.toMatchObject({ code: 'TERMINAL_CURSOR_INVALID' });
  await expect(manager.read(id, owner, Number.MAX_SAFE_INTEGER)).rejects.toMatchObject({ code: 'TERMINAL_CURSOR_INVALID' });
});

it('allows one waiting reader and kills a revoked login before releasing held output', async () => {
  let authorized = true;
  const { manager, processes } = fixture({ authorize: async () => authorized, pollMs: 5_000 });
  const { id } = manager.create(owner, size); const read = manager.read(id, owner, 0);
  await expect(manager.read(id, owner, 0)).rejects.toMatchObject({ code: 'TERMINAL_READER_BUSY' });
  authorized = false; processes[0].output('PRIVATE_OUTPUT');
  await expect(read).rejects.toMatchObject({ code: 'TERMINAL_AUTH_EXPIRED' });
  expect(processes[0].kill).toHaveBeenCalledTimes(1);
  expect(() => manager.write(id, owner, 'more')).toThrowError(expect.objectContaining({ code: 'TERMINAL_CLOSED' }));
});

it('caps output and audits lifecycle without commands, output, or login hashes', async () => {
  const { manager, processes, audit } = fixture({ maxBuffer: 20 }); const { id } = manager.create(owner, size);
  manager.write(id, owner, 'CANARY_PASSWORD\r'); processes[0].output('CANARY_OUTPUT'.repeat(3));
  expect(processes[0].kill).toHaveBeenCalledTimes(1);
  expect((await manager.read(id, owner, 0)).closed).toBe(true);
  expect(audit).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(audit.mock.calls)).not.toMatch(/CANARY|LOGIN_A/);
});

it('expires disconnected and input-idle sessions despite read polling and fails closed on Core outages', async () => {
  let now = 100, authorized = true;
  const { manager, processes } = fixture({ now: () => now, idleMs: 100, disconnectMs: 50,
    authorize: async () => { if (!authorized) throw new Error('Core unavailable'); return true; } });
  let { id } = manager.create(owner, size);
  now += 40; await manager.read(id, owner, 0); now += 40; await manager.read(id, owner, 0);
  now += 40; await manager.reap(); expect(processes[0].kill).toHaveBeenCalledTimes(1);
  id = manager.create(owner, size).id; now += 51; await manager.reap(); expect(processes[1].kill).toHaveBeenCalledTimes(1);
  id = manager.create(owner, size).id; authorized = false; await manager.reap(); expect(processes[2].kill).toHaveBeenCalledTimes(1);
});

it('drains shell-exit output and force-kills remaining terminals exactly once at shutdown', async () => {
  const { manager, processes, audit } = fixture(); const { id } = manager.create(owner, size);
  processes[0].output('x'.repeat(70_000)); processes[0].exit(7);
  const first = await manager.read(id, owner, 0), last = await manager.read(id, owner, first.cursor);
  expect(first.closed).toBe(false); expect(last.closed).toBe(true); expect(last.exitCode).toBe(7);
  expect(first.output.length + last.output.length).toBe(70_000);
  manager.create(owner, size); manager.shutdown(); manager.shutdown();
  expect(processes[1].kill).toHaveBeenCalledTimes(1); expect(processes[1].kill).toHaveBeenCalledWith(true);
  expect(audit.mock.calls.filter(([event]) => event.phase === 'closed')).toHaveLength(2);
  expect(() => manager.create(owner, size)).toThrowError(expect.objectContaining({ code: 'TERMINAL_STOPPING' }));
});

it('enforces global capacity before creating another PTY', () => {
  const { manager, processes } = fixture({ maxSessions: 1 }); manager.create(owner, size);
  expect(() => manager.create({ userId: '99', sessionHash: 'OTHER' }, size)).toThrowError(expect.objectContaining({ code: 'TERMINAL_LIMIT' }));
  expect(processes).toHaveLength(1);
});
