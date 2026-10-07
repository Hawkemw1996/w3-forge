import { vi } from 'vitest';
import type { TerminalProcess } from '../src/admin/terminal/sessionManager';

export function fakeTerminal() {
  const data = new Set<(value: string) => void>();
  const exits = new Set<(event: { exitCode: number }) => void>();
  const process: TerminalProcess & { output(value: string): void; exit(code?: number): void } = {
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    onData(listener) { data.add(listener); return { dispose: () => data.delete(listener) }; },
    onExit(listener) { exits.add(listener); return { dispose: () => exits.delete(listener) }; },
    output(value) { for (const listener of data) listener(value); },
    exit(exitCode = 0) { for (const listener of exits) listener({ exitCode }); }
  };
  return process;
}
