import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const provenance = JSON.parse(readFileSync('src/shared/provenance.json', 'utf8'));
test('common console components and styles match the pinned W3 UI reference', () => {
  for (const entry of provenance.files) {
    let source = readFileSync(entry.local, 'utf8').replace(/\r\n/g, '\n');
    if (entry.normalizeStyleImports) source = source.replace(/^@import '[^']+';/gm, '@import <shared-style>;');
    const actual = createHash('sha256').update(source).digest('hex');
    assert.equal(actual, entry.sha256, entry.local + ' drifted from the shared W3 console; update the canonical source and provenance together.');
  }
  const styles = readFileSync('src/styles.css', 'utf8');
  assert.match(styles, /@import '\.\/shared\/styles\/tokens\.css';/);
  assert.match(styles, /@import '\.\/shared\/styles\/primitives\.css';/);
});
