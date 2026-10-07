// =============================================================================
// W3 Core v0.12.10 — frontend/admin/src/lib/devBranchVersion.ts unit tests
// =============================================================================
//
// Pure helpers behind the Release Workflow branch picker: parsing, numeric
// (not lexical) ordering, highest-version default, and version derivation.
//
// Run: node --test frontend/admin/tests/   (also part of root `npm test`)
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = path.dirname(fileURLToPath(import.meta.url));
const { outputText } = ts.transpileModule(
  readFileSync(path.join(here, '..', 'src', 'lib', 'devBranchVersion.ts'), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
);
const lib = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

const EXPECTED_DESC = ['dev/v1.0.0', 'dev/v0.99.99', 'dev/v0.13.0', 'dev/v0.12.100', 'dev/v0.12.10', 'dev/v0.12.9', 'dev/v0.12.2'];

test('parseDevBranchVersion / isDevBranchName accept only dev/vX.Y.Z', () => {
  assert.deepEqual(lib.parseDevBranchVersion('dev/v0.12.10'), [0, 12, 10]);
  assert.deepEqual(lib.parseDevBranchVersion('dev/v1.100.100'), [1, 100, 100]);
  for (const bad of ['dev/v0.12', 'dev/v0.12.10-rc1', 'dev-v0.12.10', 'devv0.12.10', 'feature/x', 'main', 'v0.12.10', '']) {
    assert.equal(lib.parseDevBranchVersion(bad), null, bad);
    assert.equal(lib.isDevBranchName(bad), false, bad);
  }
  assert.equal(lib.isDevBranchName('dev/v0.12.10'), true);
});

test('compareDevBranchNamesDesc: 0.12.10 > 0.12.9 > 0.12.2; 0.13.0 > 0.12.100; 1.0.0 > 0.99.99', () => {
  const cmp = lib.compareDevBranchNamesDesc;
  assert.ok(cmp('dev/v0.12.10', 'dev/v0.12.9') < 0);
  assert.ok(cmp('dev/v0.12.9', 'dev/v0.12.2') < 0);
  assert.ok(cmp('dev/v0.13.0', 'dev/v0.12.100') < 0);
  assert.ok(cmp('dev/v1.0.0', 'dev/v0.99.99') < 0);
  assert.ok(cmp('dev/v0.12.9', 'dev/v0.12.10') > 0);
  assert.equal(cmp('dev/v0.12.10', 'dev/v0.12.10'), 0);
  const shuffled = ['dev/v0.12.9', 'dev/v1.0.0', 'dev/v0.12.100', 'dev/v0.12.2', 'dev/v0.13.0', 'dev/v0.12.10', 'dev/v0.99.99'];
  assert.deepEqual([...shuffled].sort(cmp), EXPECTED_DESC);
  // Lexical order is different for this fixture (that was the bug).
  assert.notDeepEqual([...shuffled].sort().reverse(), EXPECTED_DESC);
  // Non-parsing names sort last, deterministically.
  assert.deepEqual(['zzz', 'dev/v0.0.1', 'aaa'].sort(cmp), ['dev/v0.0.1', 'aaa', 'zzz']);
});

test('pickHighestDevBranch: highest numeric version regardless of server order', () => {
  assert.equal(lib.pickHighestDevBranch(['dev/v0.12.9', 'dev/v0.12.10', 'dev/v0.12.2']), 'dev/v0.12.10');
  // Lexically-sorted (old backend) order still yields the right default.
  assert.equal(lib.pickHighestDevBranch(['dev/v0.12.9', 'dev/v0.12.2', 'dev/v0.12.10']), 'dev/v0.12.10');
  assert.equal(lib.pickHighestDevBranch(['dev/v0.12.100', 'dev/v0.13.0']), 'dev/v0.13.0');
  assert.equal(lib.pickHighestDevBranch(['dev/v0.99.99', 'dev/v1.0.0']), 'dev/v1.0.0');
  assert.equal(lib.pickHighestDevBranch(['dev/v0.12.10', 'dev/v1.100.100']), 'dev/v1.100.100');
  assert.equal(lib.pickHighestDevBranch(['main', 'feature/x']), null);
  assert.equal(lib.pickHighestDevBranch([]), null);
});

test('deriveVersionTag / deriveVersionBare preserve the exact accepted identifier text (leading zeros kept)', () => {
  const cases = [
    ['dev/v0.12.10', 'v0.12.10', '0.12.10'],
    ['dev/v1.00.00', 'v1.00.00', '1.00.00'],
    ['dev/v01.002.003', 'v01.002.003', '01.002.003'],
    ['dev/v0.012.010', 'v0.012.010', '0.012.010'],
    ['dev/v00.00.00', 'v00.00.00', '00.00.00']
  ];
  for (const [branch, tag, bare] of cases) {
    assert.equal(lib.deriveVersionTag(branch), tag, `tag for ${branch}`);
    assert.equal(lib.deriveVersionBare(branch), bare, `bare for ${branch}`);
    // The derived text is exactly the branch suffix — never a numeric reconstruction.
    assert.equal(`dev/v${lib.deriveVersionBare(branch)}`, branch);
    assert.equal(lib.deriveVersionTag(branch), `v${lib.deriveVersionBare(branch)}`);
  }
  // Numeric parsing still exists for ordering only and is unaffected.
  assert.deepEqual(lib.parseDevBranchVersion('dev/v01.002.003'), [1, 2, 3]);
  assert.equal(lib.compareDevBranchNamesDesc('dev/v1.00.00', 'dev/v1.0.0'), 0, 'numerically equal for ordering');
  assert.notEqual(lib.deriveVersionTag('dev/v1.00.00'), lib.deriveVersionTag('dev/v1.0.0'), 'but distinct identifiers');
  for (const bad of ['dev/v1.00', 'dev/v01.002.003-rc1', 'v01.002.003', 'main', '']) {
    assert.equal(lib.deriveVersionTag(bad), '', bad);
    assert.equal(lib.deriveVersionBare(bad), '', bad);
  }
});

test('deriveVersionTag / deriveVersionBare: dev/v0.12.10 → v0.12.10 / 0.12.10', () => {
  assert.equal(lib.deriveVersionTag('dev/v0.12.10'), 'v0.12.10');
  assert.equal(lib.deriveVersionBare('dev/v0.12.10'), '0.12.10');
  assert.equal(lib.deriveVersionTag('dev/v1.100.100'), 'v1.100.100');
  assert.equal(lib.deriveVersionBare('dev/v1.100.100'), '1.100.100');
  assert.equal(lib.deriveVersionTag('main'), '');
  assert.equal(lib.deriveVersionBare(''), '');
});
