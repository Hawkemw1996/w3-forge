import type { Terminal } from '@xterm/xterm';

export function clearTerminalScreen(term: Pick<Terminal, 'write'>, onCleared: () => void) {
  // Queue the erase behind pending output. Unlike clear(), this also works when
  // the cursor is on the first row. Preserve terminal modes and the shell session.
  term.write('\x1b[2J\x1b[3J\x1b[H', onCleared);
}
