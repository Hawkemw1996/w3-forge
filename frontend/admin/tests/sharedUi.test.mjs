import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const provenance = JSON.parse(readFileSync('console-provenance.json', 'utf8'));
test('the complete canonical frontend and shared layer stay pinned to their reviewed source', () => {
  assert.equal(provenance.files.filter(file => file.source.startsWith('frontend/admin/src/')).length, 55);
  for (const entry of provenance.files) {
    const source = readFileSync(entry.local, 'utf8').replace(/\r\n/g, '\n');
    const actual = createHash('sha256').update(source).digest('hex');
    assert.equal(actual, entry.sha256, entry.local + ' drifted; update the common implementation and provenance deliberately.');
    if (!entry.adaptation) assert.equal(entry.sha256, entry.sourceSha256, entry.local + ' must match its canonical source.');
    else assert.ok(entry.adaptation.length > 20, entry.local + ' must document its adaptation.');
  }
  const styles = readFileSync('src/styles.css', 'utf8');
  assert.match(styles, /@import '\.\/styles\/tokens\.css';/);
  assert.match(styles, /@import '\.\.\/\.\.\/shared\/styles\/primitives\.css';/);
});