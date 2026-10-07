import { getLogsPath } from '../appConfigAccessors';
// =============================================================================
// W3 Core v0.5.14 — Admin action lock.
// =============================================================================
//
// A small in-process mutex paired with an on-disk marker that guarantees only
// one write-class admin action runs at a time across the W3 Forge backend.
//
//   - In-process state is the source of truth while the Node process is alive.
//   - The on-disk marker lives at /opt/logs/w3forge/locks/<controlId>.lock and
//     is best-effort: it documents what the process *thinks* is holding the
//     lock for operators inspecting the box. If the process dies, restart
//     clears in-process state and the routes ignore stale on-disk markers.
//
// Public surface (kept intentionally tiny):
//
//   acquire({ controlId, requestId }) -> { ok: true }
//                                      | { ok: false, active: LockSnapshot }
//   release(requestId)                -> void
//   current()                         -> LockSnapshot | null
//
// The lock has a hard wall-clock ceiling: any holder older than
// MAX_LOCK_AGE_MS is considered stale and forcibly cleared on the next
// acquire(). This is a safety net for crashes, not a normal code path.

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

const LOCK_DIR = path.join(getLogsPath(), 'locks');
const MAX_LOCK_AGE_MS = 30 * 60 * 1000; // 30 minutes — well past any real admin action

export interface LockSnapshot {
  controlId: string;
  requestId: string;
  startedAt: string; // ISO8601
}

export type AcquireResult =
  | { ok: true }
  | { ok: false; active: LockSnapshot };

interface InternalLock {
  controlId: string;
  requestId: string;
  startedAtMs: number;
}

let current: InternalLock | null = null;

function snapshot(l: InternalLock): LockSnapshot {
  return {
    controlId: l.controlId,
    requestId: l.requestId,
    startedAt: new Date(l.startedAtMs).toISOString()
  };
}

function isStale(l: InternalLock): boolean {
  return Date.now() - l.startedAtMs > MAX_LOCK_AGE_MS;
}

async function writeMarker(l: InternalLock): Promise<void> {
  try {
    await fsp.mkdir(LOCK_DIR, { recursive: true });
    const file = path.join(LOCK_DIR, `${l.controlId}.lock`);
    const body = JSON.stringify(snapshot(l), null, 2) + '\n';
    await fsp.writeFile(file, body, { encoding: 'utf8' });
  } catch {
    // On-disk marker is informational; never fail the lock because of FS.
  }
}

async function clearMarker(controlId: string): Promise<void> {
  try {
    const file = path.join(LOCK_DIR, `${controlId}.lock`);
    await fsp.unlink(file);
  } catch {
    // Missing marker is fine.
  }
}

/**
 * Try to acquire the global admin action lock for a control.
 *
 * Returns `{ ok: true }` on success. On contention returns `{ ok: false, active }`
 * with a snapshot of whoever currently holds the lock.
 *
 * Stale holders older than MAX_LOCK_AGE_MS are forcibly cleared.
 */
export async function acquire({
  controlId,
  requestId
}: {
  controlId: string;
  requestId: string;
}): Promise<AcquireResult> {
  if (current && isStale(current)) {
    // Force-clear a stuck holder. Operators see this as the new acquisition
    // overwriting the old marker; we do not surface it as an error.
    await clearMarker(current.controlId);
    current = null;
  }
  if (current) {
    return { ok: false, active: snapshot(current) };
  }
  const next: InternalLock = {
    controlId,
    requestId,
    startedAtMs: Date.now()
  };
  current = next;
  await writeMarker(next);
  return { ok: true };
}

/**
 * Release the lock only if the given requestId currently holds it. No-op if
 * the caller is not the holder (prevents accidental release by a stale
 * cleanup path).
 */
export async function release(requestId: string): Promise<void> {
  if (!current) return;
  if (current.requestId !== requestId) return;
  const controlId = current.controlId;
  current = null;
  await clearMarker(controlId);
}

/**
 * Read-only snapshot of who holds the lock right now (or null).
 */
export function snapshotCurrent(): LockSnapshot | null {
  if (!current) return null;
  if (isStale(current)) return null;
  return snapshot(current);
}

/**
 * Generate a short opaque request id. Used by the routes so each accepted
 * action has a stable handle in logs and audit trails.
 */
export function newRequestId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36);
  return `req_${ts}_${rand}`;
}
