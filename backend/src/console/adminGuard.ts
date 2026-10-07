import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';

// =============================================================================
// Internal-only admin guard placeholder.
// =============================================================================
//
// v0.5.0 ships the Admin Operations Console as a READ-ONLY foundation. Real
// authentication, roles, and a session/JWT layer are intentionally out of
// scope for this release. Until those land, EVERY request to /api/admin/* is
// gated by this placeholder guard. Its job is twofold:
//
//   1. Refuse requests from outside the LXC's private network surface so the
//      console cannot be accidentally exposed through Caddy/Cloudflare before
//      real auth ships.
//   2. Make it crystal-clear in code and at runtime (via the X-W3-Admin-Mode
//      header and the 403 body) that the admin surface is internal-only and
//      not public-safe yet.
//
// When real auth/admin middleware is added (planned for a later v0.5.x
// release), it should REPLACE this guard wholesale. Until then:
//
//   - No write endpoints exist under /api/admin/*. (Enforced by route code.)
//   - No action endpoints exist under /api/admin/*. (Enforced by route code.)
//   - This guard is the LAST line of defense before real auth/roles.
//
// Configuration: set ADMIN_ALLOWED_IPS in .env (comma-separated CIDRs or
// exact IPs) to override the default localhost+LAN allowlist. Setting the
// special value `*` disables the IP check entirely — DO NOT use `*` outside
// of a controlled internal network. Default allowlist matches the W3 Forge
// LXC's expected internal surface:
//
//   - 127.0.0.0/8        (loopback)
//   - ::1                (IPv6 loopback)
//   - 192.168.0.0/16     (LAN)
//   - 10.0.0.0/8         (LAN)
//   - 172.16.0.0/12      (LAN)
//   - 100.64.0.0/10      (Tailscale CGNAT range — covers 100.121.176.115)
//
// Audit log entries are written by adminAudit() (see adminAudit.ts) to
// /opt/logs/w3forge/admin/. Every request — allowed or denied — is logged.

const DEFAULT_ALLOWED_CIDRS = [
  '127.0.0.0/8',
  '::1/128',
  '192.168.0.0/16',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '100.64.0.0/10'
];

interface Cidr {
  raw: string;
  isV6: boolean;
  bytes: Uint8Array;
  prefix: number;
}

function parseCidr(raw: string): Cidr | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let address = trimmed;
  let prefix: number | null = null;
  if (trimmed.includes('/')) {
    const [a, p] = trimmed.split('/');
    address = a;
    prefix = Number(p);
    if (!Number.isFinite(prefix) || prefix < 0) return null;
  }
  const isV6 = address.includes(':');
  if (isV6) {
    // Very small IPv6 parser — sufficient for ::1/128 and similar.
    const bytes = ipv6ToBytes(address);
    if (!bytes) return null;
    return { raw: trimmed, isV6: true, bytes, prefix: prefix ?? 128 };
  }
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    bytes[i] = n;
  }
  return { raw: trimmed, isV6: false, bytes, prefix: prefix ?? 32 };
}

function ipv6ToBytes(addr: string): Uint8Array | null {
  // Strip an embedded IPv4 suffix like ::ffff:1.2.3.4 — treat it as IPv4.
  const m = addr.match(/(.*:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (m && m[1]) {
    const v4 = parseCidr(m[2]);
    if (!v4) return null;
    const out = new Uint8Array(16);
    out[10] = 0xff;
    out[11] = 0xff;
    out[12] = v4.bytes[0];
    out[13] = v4.bytes[1];
    out[14] = v4.bytes[2];
    out[15] = v4.bytes[3];
    return out;
  }
  // Generic ::1 / 2001:db8:: handling.
  const groups = addr.split('::');
  if (groups.length > 2) return null;
  const head = groups[0] ? groups[0].split(':') : [];
  const tail = groups.length === 2 ? (groups[1] ? groups[1].split(':') : []) : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  const fullGroups = [...head, ...new Array(fill).fill('0'), ...tail];
  if (fullGroups.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const n = parseInt(fullGroups[i] || '0', 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
    out[i * 2] = (n >> 8) & 0xff;
    out[i * 2 + 1] = n & 0xff;
  }
  return out;
}

function normalizeClientIp(req: Request): string {
  // Express's req.ip respects trust proxy. We don't enable trust proxy here
  // because v0.5.0 expects direct internal connections only.
  const raw = (req.ip || req.socket.remoteAddress || '').trim();
  if (!raw) return '';
  // Convert IPv4-mapped IPv6 (::ffff:1.2.3.4) to plain IPv4 for prefix checks.
  if (raw.startsWith('::ffff:')) return raw.slice('::ffff:'.length);
  return raw;
}

function ipMatchesCidr(ip: string, cidr: Cidr): boolean {
  const parsedIp = parseCidr(ip);
  if (!parsedIp) return false;
  if (parsedIp.isV6 !== cidr.isV6) return false;
  const bytes = parsedIp.bytes;
  const cidrBytes = cidr.bytes;
  let bitsLeft = cidr.prefix;
  let i = 0;
  while (bitsLeft >= 8 && i < bytes.length) {
    if (bytes[i] !== cidrBytes[i]) return false;
    bitsLeft -= 8;
    i++;
  }
  if (bitsLeft > 0 && i < bytes.length) {
    const mask = (0xff << (8 - bitsLeft)) & 0xff;
    if ((bytes[i] & mask) !== (cidrBytes[i] & mask)) return false;
  }
  return true;
}

function loadAllowlist(): { mode: 'wildcard' | 'cidr'; cidrs: Cidr[] } {
  // A4 — read from env module (which reads from process.env.ADMIN_ALLOWED_IPS)
  const raw = env.adminAllowedIps;
  if (raw === '*') {
    return { mode: 'wildcard', cidrs: [] };
  }
  const sources = raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_CIDRS;
  const cidrs: Cidr[] = [];
  for (const src of sources) {
    const parsed = parseCidr(src);
    if (parsed) cidrs.push(parsed);
  }
  return { mode: 'cidr', cidrs };
}

const ALLOWLIST = loadAllowlist();

// True when no real auth is configured. v0.5.0 is hard-coded here because no
// real admin auth exists in the repo yet; once real auth lands this constant
// goes away with the rest of this file.
export const ADMIN_AUTH_PLACEHOLDER = true;

export interface AdminAuthContext {
  mode: 'internal-only-placeholder';
  authenticated: false;
  reason: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminAuth?: AdminAuthContext;
    }
  }
}

export function adminGuard(req: Request, res: Response, next: NextFunction) {
  const ip = normalizeClientIp(req);
  res.setHeader('X-W3-Admin-Mode', 'internal-only-placeholder');
  res.setHeader('Cache-Control', 'no-store');

  if (ALLOWLIST.mode === 'wildcard') {
    req.adminAuth = {
      mode: 'internal-only-placeholder',
      authenticated: false,
      reason: 'wildcard-allowlist'
    };
    return next();
  }

  if (!ip) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'ADMIN_GUARD_DENIED',
        message:
          'Admin API is internal-only in v0.5.0. Client IP could not be determined.'
      }
    });
  }

  const matched = ALLOWLIST.cidrs.some((c) => ipMatchesCidr(ip, c));
  if (!matched) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'ADMIN_GUARD_DENIED',
        message:
          'Admin API is internal-only in v0.5.0. Client IP is not on the admin allowlist. ' +
          'Until real auth ships, do not expose /api/admin/* or /admin/ publicly. ' +
          'See docs/ARCHITECTURE.md (Admin Console).'
      }
    });
  }

  req.adminAuth = {
    mode: 'internal-only-placeholder',
    authenticated: false,
    reason: 'cidr-match'
  };
  return next();
}
