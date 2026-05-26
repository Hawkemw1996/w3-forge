// =============================================================================
// Per-control in-memory mutex.
// =============================================================================
//
// Prevents two concurrent invocations of the same control. The v0.4.0
// foundation runs in a single process so an in-memory map is sufficient;
// multi-process deployments would need a file or DB lock.

const locks = new Set<string>();

export function tryAcquire(key: string): boolean {
  if (locks.has(key)) return false;
  locks.add(key);
  return true;
}

export function release(key: string): void {
  locks.delete(key);
}

export function isLocked(key: string): boolean {
  return locks.has(key);
}
