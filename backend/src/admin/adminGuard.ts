// =============================================================================
// adminGuard — IP allowlist for /api/admin/*.
// =============================================================================
//
// Adapted from W3 Core. Same loopback + LAN default allowlist. Returns a
// uniform envelope failure on denial. Override with ADMIN_ALLOWED_IPS env
// (comma-separated CIDRs or exact IPs). Setting it to "*" disables the
// check — DO NOT use "*" outside a controlled internal network.

import type { Request, Response, NextFunction } from 'express';
import { respond } from './envelope';

const DEFAULT_ALLOWED_CIDRS = [
  '127.0.0.0/8',
  '::1/128',
  '192.168.0.0/16',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '100.64.0.0/10'
];

function parseAllowed(): string[] {
  const env = (process.env.ADMIN_ALLOWED_IPS ?? '').trim();
  if (!env) return DEFAULT_ALLOWED_CIDRS;
  return env
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function ipToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/');
  const bits = bitsStr === undefined ? 32 : Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const ipInt = ipToInt(ip);
  const rangeInt = ipToInt(range);
  if (ipInt === null || rangeInt === null) return false;
  if (bits === 0) return true;
  const mask = (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

function isAllowed(remote: string, allowed: string[]): boolean {
  if (allowed.includes('*')) return true;
  // Strip IPv6-mapped IPv4 prefix.
  const ip = remote.startsWith('::ffff:') ? remote.slice(7) : remote;
  if (ip === '::1' || ip === '127.0.0.1') {
    return allowed.some((c) => c === '::1' || c === '::1/128' || c.startsWith('127.'));
  }
  for (const entry of allowed) {
    if (entry === ip) return true;
    if (entry.includes('/') && ipv4InCidr(ip, entry)) return true;
  }
  return false;
}

export function adminGuard(req: Request, res: Response, next: NextFunction): void {
  const allowed = parseAllowed();
  const remote = (req.ip ?? req.socket.remoteAddress ?? '').toString();
  res.setHeader('X-W3-Admin-Mode', 'internal-only');
  if (!isAllowed(remote, allowed)) {
    respond.err(
      res,
      403,
      'ADMIN_FORBIDDEN',
      `Admin console is internal-only. Remote ${remote} not in allowlist.`
    );
    return;
  }
  next();
}
