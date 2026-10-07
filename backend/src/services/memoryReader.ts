// =============================================================================
// memoryReader — v0.5.3.1
// =============================================================================
//
// Reads container/system memory from cgroup v2 (preferred in LXC + modern
// kernels) with /proc/meminfo as a fallback. The previous v0.5.3 code reported
// only Node.js process memory (process.memoryUsage()), which made the LXC
// look like it was running out of memory whenever V8 happened to keep a tiny
// heap (e.g. 14 MB heap used / 15 MB heap total = 89%, even though the
// container has 4 GB available).
//
// This module is read-only, safe to call on every /system/status request, and
// returns null fields on any failure rather than throwing — the route handler
// should always be able to respond even if cgroup access is denied.
//
// cgroup v2 layout (Debian 12 / Proxmox LXC default):
//   /sys/fs/cgroup/memory.current        — bytes currently in use
//   /sys/fs/cgroup/memory.max            — limit ("max" string = unlimited)
//   /sys/fs/cgroup/memory.swap.current   — swap bytes in use
//   /sys/fs/cgroup/memory.swap.max       — swap limit
//
// /proc/meminfo fallback (used when cgroup is unavailable OR memory.max is
// "max" — i.e. unlimited, so we fall back to host RAM):
//   MemTotal:  <kB>
//   MemAvailable: <kB>
//   SwapTotal / SwapFree

import { promises as fs } from 'node:fs';
import os from 'node:os';

export interface ContainerMemory {
  /** Bytes currently used by the container/system. */
  usedBytes: number | null;
  /** Limit in bytes. null when unknown OR unlimited. */
  limitBytes: number | null;
  /** Available bytes (limit - used) when both are known. */
  availableBytes: number | null;
  /** Usage as 0–100 integer; null when limit unknown. */
  usagePercent: number | null;
  /** Where the numbers came from, for the UI footnote. */
  source: 'cgroup-v2' | 'meminfo' | 'os' | 'unavailable';
}

export interface ContainerSwap {
  usedBytes: number | null;
  limitBytes: number | null;
  source: 'cgroup-v2' | 'meminfo' | 'unavailable';
}

const CGROUP_MEM_CURRENT = '/sys/fs/cgroup/memory.current';
const CGROUP_MEM_MAX = '/sys/fs/cgroup/memory.max';
const CGROUP_SWAP_CURRENT = '/sys/fs/cgroup/memory.swap.current';
const CGROUP_SWAP_MAX = '/sys/fs/cgroup/memory.swap.max';
const PROC_MEMINFO = '/proc/meminfo';

async function readNumber(path: string): Promise<number | null> {
  try {
    const raw = (await fs.readFile(path, 'utf8')).trim();
    if (!raw) return null;
    if (raw === 'max') return null; // cgroup "no limit"
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function readMeminfo(): Promise<Record<string, number>> {
  try {
    const raw = await fs.readFile(PROC_MEMINFO, 'utf8');
    const out: Record<string, number> = {};
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Za-z_()]+):\s+(\d+)(?:\s+kB)?/);
      if (!m) continue;
      out[m[1]] = Number(m[2]) * 1024; // kB → bytes
    }
    return out;
  } catch {
    return {};
  }
}

export async function readContainerMemory(): Promise<ContainerMemory> {
  // Try cgroup v2 first — that's what gives us the actual LXC container limit
  // rather than host RAM.
  const cgUsed = await readNumber(CGROUP_MEM_CURRENT);
  const cgMax = await readNumber(CGROUP_MEM_MAX);

  if (cgUsed != null && cgMax != null && cgMax > 0) {
    const available = Math.max(0, cgMax - cgUsed);
    const pct = Math.min(100, Math.max(0, Math.round((cgUsed / cgMax) * 100)));
    return {
      usedBytes: cgUsed,
      limitBytes: cgMax,
      availableBytes: available,
      usagePercent: pct,
      source: 'cgroup-v2'
    };
  }

  // Fallback 1: /proc/meminfo — reflects the host kernel view. In an LXC this
  // is usually the host's RAM (because cgroup limits weren't exposed), but it
  // is still a real bound the process can run against.
  const meminfo = await readMeminfo();
  const total = meminfo.MemTotal ?? null;
  const avail = meminfo.MemAvailable ?? null;
  if (total != null && avail != null) {
    const used = Math.max(0, total - avail);
    const pct = total > 0 ? Math.min(100, Math.max(0, Math.round((used / total) * 100))) : null;
    return {
      usedBytes: used,
      limitBytes: total,
      availableBytes: avail,
      usagePercent: pct,
      source: 'meminfo'
    };
  }

  // Fallback 2: os.totalmem / os.freemem — last resort, non-Linux dev machines.
  const osTotal = os.totalmem();
  const osFree = os.freemem();
  if (osTotal > 0) {
    const used = Math.max(0, osTotal - osFree);
    return {
      usedBytes: used,
      limitBytes: osTotal,
      availableBytes: osFree,
      usagePercent: Math.min(100, Math.max(0, Math.round((used / osTotal) * 100))),
      source: 'os'
    };
  }

  return {
    usedBytes: null,
    limitBytes: null,
    availableBytes: null,
    usagePercent: null,
    source: 'unavailable'
  };
}

export async function readContainerSwap(): Promise<ContainerSwap> {
  const cgUsed = await readNumber(CGROUP_SWAP_CURRENT);
  const cgMax = await readNumber(CGROUP_SWAP_MAX);
  if (cgUsed != null) {
    return {
      usedBytes: cgUsed,
      limitBytes: cgMax,
      source: 'cgroup-v2'
    };
  }
  const meminfo = await readMeminfo();
  const sTotal = meminfo.SwapTotal ?? null;
  const sFree = meminfo.SwapFree ?? null;
  if (sTotal != null && sFree != null) {
    return {
      usedBytes: Math.max(0, sTotal - sFree),
      limitBytes: sTotal,
      source: 'meminfo'
    };
  }
  return { usedBytes: null, limitBytes: null, source: 'unavailable' };
}
