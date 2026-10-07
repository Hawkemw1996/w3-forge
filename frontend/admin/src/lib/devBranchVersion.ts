// =============================================================================
// W3 Core v0.12.10 — dev/vX.Y.Z branch helpers (Admin Console, pure).
// =============================================================================
//
// Shared by the Release Workflow so the branch → version derivation and the
// "highest version" default are unit-testable without mounting React.
//
// Only the existing allowlisted shape `dev/v<major>.<minor>.<patch>` is
// recognised. Anything else parses to null and never yields a version.
// =============================================================================

export const DEV_BRANCH_RE = /^dev\/v(\d+)\.(\d+)\.(\d+)$/;

export type DevBranchVersion = readonly [major: number, minor: number, patch: number];

export function isDevBranchName(branch: string): boolean {
  return DEV_BRANCH_RE.test(branch);
}

export function parseDevBranchVersion(branch: string): DevBranchVersion | null {
  const m = DEV_BRANCH_RE.exec(branch);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Exact-text version derivation. Numeric parsing is for ORDERING only; the
 * tag / bare version handed to the release pipeline must be the identifier
 * the operator selected, digit for digit. Reconstructing from numbers would
 * silently rewrite an already-accepted branch (`dev/v1.00.00` → `v1.0.0`),
 * so the original captured segments are returned instead.
 *
 *   dev/v0.12.10    → v0.12.10    / 0.12.10
 *   dev/v1.00.00    → v1.00.00    / 1.00.00
 *   dev/v01.002.003 → v01.002.003 / 01.002.003
 *   anything else   → ''
 */
export function deriveVersionBare(branch: string): string {
  const m = DEV_BRANCH_RE.exec(branch);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : '';
}

export function deriveVersionTag(branch: string): string {
  const bare = deriveVersionBare(branch);
  return bare ? `v${bare}` : '';
}

/**
 * Descending numeric comparator (highest version first):
 * 0.12.10 > 0.12.9 > 0.12.2, 0.13.0 > 0.12.100, 1.0.0 > 0.99.99.
 * Non-parsing names sort after every parsed version (lexically among
 * themselves) so the result is deterministic.
 */
export function compareDevBranchNamesDesc(a: string, b: string): number {
  const va = parseDevBranchVersion(a);
  const vb = parseDevBranchVersion(b);
  if (!va && !vb) return a < b ? -1 : a > b ? 1 : 0;
  if (!va) return 1;
  if (!vb) return -1;
  for (let i = 0; i < 3; i += 1) {
    if (va[i] !== vb[i]) return vb[i] - va[i];
  }
  return 0;
}

/**
 * The highest numeric dev/vX.Y.Z name in `names`, or null when none parse.
 * Does not depend on the order the backend returned, so the initial default
 * is correct even against an older server that still sorts lexically.
 */
export function pickHighestDevBranch(names: readonly string[]): string | null {
  let best: string | null = null;
  for (const name of names) {
    if (!parseDevBranchVersion(name)) continue;
    if (best === null || compareDevBranchNamesDesc(name, best) < 0) best = name;
  }
  return best;
}
