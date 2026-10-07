import { afterEach, expect, it, vi } from 'vitest';
import { accessSync } from 'node:fs';
vi.mock('node:fs', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs')>(), accessSync: vi.fn() }));
import { terminalStatus, spawnRootTerminal } from '../src/admin/terminal/runtime';
import { fakeTerminal } from './terminalFixture';
// Load the installed native module before emulating Linux; no real shell is spawned.
const pty = require('node-pty') as typeof import('node-pty');
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const getuid = Object.getOwnPropertyDescriptor(process, 'getuid');
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers();
  Object.defineProperty(process, 'platform', platform);
  if (getuid) Object.defineProperty(process, 'getuid', getuid); else delete (process as any).getuid;
});
function fixture(uid = 1000) {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  Object.defineProperty(process, 'getuid', { value: () => uid, configurable: true });
  vi.mocked(accessSync).mockImplementation(() => {});
  const child = fakeTerminal();
  const spawn = vi.spyOn(pty, 'spawn').mockReturnValue(child as unknown as import('node-pty').IPty);
  return { child, spawn };
}

it('opens fixed su root login with a minimal environment that excludes service secrets', () => {
  const { child, spawn } = fixture();
  const terminal = spawnRootTerminal({ cols: 100, rows: 30 }, { enabled: true });
  const [command, args, options] = spawn.mock.calls[0];
  expect(command).toBe('/usr/bin/su'); expect(args).toEqual(['--login', 'root']);
  expect(options).toMatchObject({ cwd: '/', cols: 100, rows: 30 });
  expect(Object.keys(options!.env!).sort()).toEqual(['COLORTERM', 'HOME', 'LANG', 'LOGNAME', 'PATH', 'TERM', 'USER']);
  terminal.kill(true); expect(child.kill).toHaveBeenCalledWith('SIGKILL');
});

it('uses fixed login shell as root and cancels forced cleanup once the shell exits', () => {
  const { child, spawn } = fixture(0); vi.useFakeTimers();
  const terminal = spawnRootTerminal({ cols: 80, rows: 24 }, { enabled: true });
  expect(terminalStatus({ enabled: true }).access).toBe('root-shell');
  expect(spawn.mock.calls[0].slice(0, 2)).toEqual(['/bin/bash', ['-l']]);
  terminal.kill(); expect(child.kill).toHaveBeenCalledWith('SIGHUP');
  child.exit(); vi.advanceTimersByTime(1000); expect(child.kill).toHaveBeenCalledTimes(1);
});

it('refuses disabled or unsupported terminals and force-kills shells that ignore hangup', () => {
  const { child, spawn } = fixture(0); vi.useFakeTimers();
  expect(terminalStatus({ enabled: false }).available).toBe(false);
  expect(() => spawnRootTerminal({ cols: 80, rows: 24 }, { enabled: false })).toThrowError(expect.objectContaining({ code: 'TERMINAL_UNAVAILABLE' }));
  expect(spawn).not.toHaveBeenCalled();
  const terminal = spawnRootTerminal({ cols: 80, rows: 24 }, { enabled: true });
  terminal.kill(); vi.advanceTimersByTime(1000);
  expect(child.kill.mock.calls).toEqual([['SIGHUP'], ['SIGKILL']]);
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  expect(terminalStatus({ enabled: true }).available).toBe(false);
});

it('turns native PTY startup failure into an actionable envelope error without exposing its cause', () => {
  const { spawn } = fixture(); spawn.mockImplementation(() => { throw new Error('PRIVATE_SERVICE_SECRET'); });
  expect(() => spawnRootTerminal({ cols: 80, rows: 24 }, { enabled: true })).toThrowError(expect.objectContaining({ code: 'TERMINAL_START_FAILED' }));
  expect(() => spawnRootTerminal({ cols: 80, rows: 24 }, { enabled: true })).not.toThrow(/PRIVATE_SERVICE_SECRET/);
});
