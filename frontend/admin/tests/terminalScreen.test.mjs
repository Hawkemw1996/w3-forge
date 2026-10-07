import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import xterm from '@xterm/xterm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/terminalScreen.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
});
const { clearTerminalScreen } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
const write = (term, data) => new Promise(resolve => term.write(data, resolve));
const clear = term => new Promise(resolve => clearTerminalScreen(term, resolve));
const lines = term => Array.from({ length: term.buffer.active.length }, (_, i) => term.buffer.active.getLine(i).translateToString(true));

function terminal(t) {
  const term = new xterm.Terminal({ cols: 80, rows: 5 });
  t.after(() => term.dispose());
  return term;
}

test('clear removes visible output even when the cursor is already at the top', async t => {
  const term = terminal(t);
  await write(term, 'root@container:~#\r\nold output\r\nmore output\x1b[H');
  assert.equal(term.buffer.active.cursorY, 0);
  assert.ok(lines(term).includes('old output'));
  await clear(term);
  assert.deepEqual(lines(term), ['', '', '', '', '']);
  assert.equal(term.buffer.active.cursorX, 0);
  assert.equal(term.buffer.active.cursorY, 0);
});

test('clear drains already queued output and removes scrollback before completing', async t => {
  const term = terminal(t);
  await write(term, Array.from({ length: 15 }, (_, i) => `old line ${i}\r\n`).join(''));
  assert.ok(term.buffer.active.baseY > 0);
  term.write('pending output');
  await clear(term);
  assert.deepEqual(lines(term), ['', '', '', '', '']);
  assert.equal(term.buffer.active.baseY, 0);
  assert.equal(term.buffer.active.viewportY, 0);
  await write(term, 'new output');
  assert.equal(lines(term)[0], 'new output');
});

test('clear erases the alternate screen without resetting terminal modes or sending shell input', async t => {
  const term = terminal(t);
  const input = [];
  term.onData(data => input.push(data));
  await write(term, '\x1b[?1049h\x1b[?2004h\x1b[?1h\x1b[31mfull screen output\r\nold details\x1b[H');
  await clear(term);
  assert.equal(term.buffer.active.type, 'alternate');
  assert.deepEqual(lines(term), ['', '', '', '', '']);
  assert.equal(term.modes.bracketedPasteMode, true);
  assert.equal(term.modes.applicationCursorKeysMode, true);
  await write(term, 'new output');
  assert.equal(lines(term)[0], 'new output');
  assert.equal(term.buffer.active.getLine(0).getCell(0).getFgColor(), 1);
  assert.deepEqual(input, []);
});
