/**
 * W3 Forge — test/production database safety guard.
 *
 * Derived from W3 Core v0.12.5+ backend/src/db/testDatabaseGuard.ts and made
 * STRICTER for Forge: under test execution (NODE_ENV=test) the pool may
 * only reach a database whose name starts with `w3forge_test`. Everything
 * else — the production `w3forge` database, the W3 Core `w3core`
 * database, or any other name — is refused before any network call.
 *
 * Outside test mode the guard still refuses every non-Forge database.
 */

/** The database name every real W3 Forge deployment uses. */
export const PRODUCTION_DATABASE_NAME = 'w3forge';
/** The W3 Core database — never a valid Forge target, in any mode. */
export const CORE_DATABASE_NAME = 'w3core';
/** Test databases must use this prefix. */
export const TEST_DATABASE_PREFIX = 'w3forge_test';

export interface ResolvedDatabaseTarget {
  /** `env.databaseUrl` — a full connection string override, or ''. */
  databaseUrl: string;
  /** `env.databaseName` — used when `databaseUrl` is not set. */
  databaseName: string;
}

export function isTestExecutionMode(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return nodeEnv === 'test';
}

/** Database name the target resolves to ('' when it cannot be determined). */
export function resolveDatabaseName(target: ResolvedDatabaseTarget): string {
  if (target.databaseUrl) {
    try {
      const u = new URL(target.databaseUrl);
      return decodeURIComponent(u.pathname.replace(/^\//, ''));
    } catch {
      return '';
    }
  }
  return target.databaseName;
}

export function isProductionDatabaseTarget(target: ResolvedDatabaseTarget): boolean {
  return resolveDatabaseName(target) === PRODUCTION_DATABASE_NAME;
}

export function isCoreDatabaseTarget(target: ResolvedDatabaseTarget): boolean {
  return resolveDatabaseName(target).toLowerCase() === CORE_DATABASE_NAME;
}

export function isTestDatabaseName(name: string): boolean {
  return /^w3forge_test[a-z0-9_]*$/.test(name);
}

export class ProductionDatabaseTestGuardError extends Error {
  constructor(name: string) {
    super(
      `REFUSED: test execution (NODE_ENV=test) attempted to use database "${name || '(unknown)'}". ` +
        `Tests may only use a disposable database named ${TEST_DATABASE_PREFIX}* ` +
        `(never "${PRODUCTION_DATABASE_NAME}" and never "${CORE_DATABASE_NAME}").`
    );
    this.name = 'ProductionDatabaseTestGuardError';
  }
}

export class CoreDatabaseTargetError extends Error {
  constructor() {
    super(`REFUSED: W3 Forge must never connect to the W3 Core database "${CORE_DATABASE_NAME}". Use the W3 Core API.`);
    this.name = 'CoreDatabaseTargetError';
  }
}

/**
 * Throws when the target is not allowed:
 *   - any mode: the w3core database;
 *   - test mode: anything that is not w3forge_test*.
 */
export function assertDatabaseConnectionAllowed(target: ResolvedDatabaseTarget, nodeEnv: string | undefined = process.env.NODE_ENV): void {
  if (isCoreDatabaseTarget(target)) throw new CoreDatabaseTargetError();
  if (!/^w3forge(?:_[a-z0-9_]+)?$/.test(resolveDatabaseName(target))) throw new Error('REFUSED: this installation may connect only to a Forge-owned database.');
  if (isTestExecutionMode(nodeEnv) && !isTestDatabaseName(resolveDatabaseName(target))) {
    throw new ProductionDatabaseTestGuardError(resolveDatabaseName(target));
  }
}
