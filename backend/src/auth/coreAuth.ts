import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, json, type Request, type RequestHandler } from 'express';
import { adminGuard } from '../admin/adminGuard';
import { encryptCoreSession, decryptCoreSession, sessionSecretIssue, type SessionSecrets } from './sessionCrypto';
import { AdminError, respond, envelopeErrorHandler, envelopeNotFound } from '../admin/envelope';
import { type CoreClient, type CoreUser, CoreUnavailableError, CoreNotConfiguredError } from './coreClient';

const COOKIE = 'W3FORGE_SESSION';
const PENDING_COOKIE = 'W3FORGE_PENDING';
const LOGIN_TTL = 5 * 60 * 1000;
const SESSION_TTL = 8 * 60 * 60 * 1000;
const token = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export interface CoreAdminSession { userId: string; sessionHash: string }
export interface ConsoleUser {
  coreUserId: string; username: string; displayName: string; coreRole: string; appRole: string;
  permissions: string[]; coreStatus: 'verified'; lastVerifiedAt: string; expiresAt: string;
}
declare global { namespace Express { interface Request { forgeUser?: ConsoleUser } } }
export interface CoreAuthOptions extends SessionSecrets {
  publicAppUrl: string; publicCoreUrl: string; cookieSecure: boolean;
  audit?: (action: string, actor: { coreUserId: string; name: string } | null, details: Record<string, unknown>) => Promise<void>;
}
const APP_BASE = '/forge';
function permissionsForAppRole(role: string): string[] {
  return role === 'admin' ? ['forge:read', 'forge:write', 'forge:admin']
    : role === 'editor' ? ['forge:read', 'forge:write'] : role === 'viewer' ? ['forge:read'] : [];
}

function cookie(req: Request, name: string): string | undefined {
  const values = (req.get('cookie') ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(name + '='));
  if (values.length !== 1) return undefined;
  const value = values[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

export function safeReturnPath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || /[\\\u0000-\u0020]/.test(raw)) return APP_BASE;
  try {
    const url = new URL(raw, 'https://local.invalid');
    if (url.origin !== 'https://local.invalid') return APP_BASE;
    const route = url.pathname === APP_BASE ? '/' : url.pathname.startsWith(APP_BASE + '/') ? url.pathname.slice(APP_BASE.length) : url.pathname;
    const decoded = decodeURIComponent(route);
    if (decoded.startsWith('//') || /[\\\u0000-\u0020]/.test(decoded) || /^\/(api|login|access-denied|core-unavailable)/i.test(decoded)) return APP_BASE;
    const target = url.pathname + url.search + url.hash;
    if (/^\/admin(?:\/|$)/.test(url.pathname) || url.pathname === APP_BASE || url.pathname.startsWith(APP_BASE + '/')) return target;
    return APP_BASE + (target === '/' ? '' : target);
  } catch { return APP_BASE; }
}

export function createCoreAuth(core: CoreClient, options: CoreAuthOptions) {
  const pending = new Map<string, { state: string; verifier: string; next: string; expires: number }>();
  const sessions = new Map<string, { sealedCoreToken: string; userId: string; expires: number; lastVerifiedAt: string }>();
  const cookieOptions = { httpOnly: true, secure: options.cookieSecure, sameSite: 'lax' as const, path: '/' };
  function requireSessionSecret() {
    const issue = sessionSecretIssue(options);
    if (issue) throw new AdminError(503, issue.code, issue.message);
  }
  function prune() {
    const now = Date.now();
    for (const [key, value] of pending) if (value.expires <= now) pending.delete(key);
    for (const [key, value] of sessions) if (value.expires <= now) sessions.delete(key);
  }
  function authError(error: unknown): unknown {
    if (error instanceof CoreNotConfiguredError) return new AdminError(503, 'CORE_NOT_CONFIGURED', error.message);
    if (error instanceof CoreUnavailableError) return new AdminError(503, 'CORE_UNAVAILABLE', 'W3 Core is unavailable. Access cannot be verified.');
    return error;
  }
  const sameOrigin: RequestHandler = (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    const site = req.get('sec-fetch-site');
    if ((origin && origin !== options.publicAppUrl) || (site && !['same-origin', 'none'].includes(site))) {
      return next(new AdminError(403, 'CROSS_ORIGIN_REFUSED', 'Use this app to submit the request.'));
    }
    if (!req.is('application/json')) return next(new AdminError(415, 'JSON_REQUIRED', 'A JSON request is required.'));
    next();
  };
  function adminSession(req: Request): CoreAdminSession | null {
    prune();
    const browserToken = cookie(req, COOKIE);
    if (!browserToken) return null;
    const sessionHash = hash(browserToken), session = sessions.get(sessionHash);
    return session ? { userId: session.userId, sessionHash } : null;
  }
  async function identityByHash(key: string): Promise<CoreUser | null> {
    prune();
    const session = sessions.get(key);
    if (!session) return null;
    let coreToken: string;
    try { requireSessionSecret(); coreToken = decryptCoreSession(session.sealedCoreToken, options.sessionSecret ?? ''); }
    catch { sessions.delete(key); return null; }
    const result = await core.me(coreToken);
    if (!result.ok || result.user.id !== session.userId) { sessions.delete(key); return null; }
    // A concurrent logout must not permit the request after its Core check.
    if (sessions.get(key) !== session || session.expires <= Date.now()) return null;
    session.lastVerifiedAt = new Date().toISOString();
    session.expires = Math.min(session.expires, Date.parse(result.expiresAt));
    return result.user;
  }
  async function identity(req: Request): Promise<CoreUser | null> {
    const browserToken = cookie(req, COOKIE);
    return browserToken ? identityByHash(hash(browserToken)) : null;
  }
  function publicUser(req: Request, user: CoreUser): ConsoleUser {
    const browserToken = cookie(req, COOKIE);
    const session = browserToken ? sessions.get(hash(browserToken)) : undefined;
    if (!session) throw new AdminError(401, 'AUTH_REQUIRED', 'Not signed in.');
    return { coreUserId: user.id, username: user.username, displayName: user.username,
      // Compatibility name only: this is the explicit app assignment, never a Core platform role.
      coreRole: user.appRole, appRole: user.appRole, permissions: permissionsForAppRole(user.appRole),
      coreStatus: 'verified', lastVerifiedAt: session.lastVerifiedAt, expiresAt: new Date(session.expires).toISOString() };
  }
  // Long-lived human terminals retain only the browser-session hash. Core credentials
  // stay in this module, and permissions are checked again even without HTTP input.
  async function authorizeAdminSession(session: CoreAdminSession): Promise<boolean> {
    try {
      const user = await identityByHash(session.sessionHash);
      return !!user && user.id === session.userId && user.appRole === 'admin';
    } catch { return false; }
  }
  async function logout(req: Request) {
    const browserToken = cookie(req, COOKIE);
    if (!browserToken) return;
    const key = hash(browserToken), session = sessions.get(key);
    sessions.delete(key);
    if (session) {
      try { await core.logout(decryptCoreSession(session.sealedCoreToken, options.sessionSecret ?? '')); }
      catch { /* Local logout remains final after key rotation or a corrupted seal. */ }
    }
  }
  const requireAdmin: RequestHandler = async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const user = await identity(req);
      if (!user) throw new AdminError(401, 'AUTH_REQUIRED', 'Sign in with W3 Core.');
      if (user.appRole !== 'admin') throw new AdminError(403, 'APP_ADMIN_REQUIRED', 'The Core owner must assign you the Forge admin role.');
      req.forgeUser = publicUser(req, user);
      res.locals.coreUser = { id: user.id, username: user.username, appRole: user.appRole };
      next();
    } catch (error) { next(authError(error)); }
  };

  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  router.use(adminGuard, sameOrigin, json({ limit: '8kb' }));
  router.get('/status', async (req, res, next) => {
    try {
      const issue = sessionSecretIssue(options);
      const unavailable = !core.configured
        ? { code: 'CORE_NOT_CONFIGURED', message: 'Sign-in is unavailable: W3 Core is not configured for this installation.' }
        : issue;
      let user: CoreUser | null = null;
      let sessionError: { code: string; message: string } | null = null;
      try { user = await identity(req); }
      catch (error) {
        const failure = authError(error);
        if (!(failure instanceof AdminError)) throw failure;
        sessionError = { code: failure.code, message: failure.message };
      }
      respond.ok(res, {
        identityProvider: 'w3core', coreConfigured: core.configured,
        loginAvailable: !unavailable, loginUnavailableReason: unavailable, sessionError,
        configured: core.configured && !sessionSecretIssue(options), connection: core.connection,
        setupError: core.configured ? sessionSecretIssue(options)?.message ?? null : null,
        coreUrl: core.configured ? options.publicCoreUrl : null,
        authenticated: !!user,
        user: user ? publicUser(req, user) : null
      });
    } catch (error) { next(authError(error)); }
  });
  router.get('/me', async (req, res, next) => {
    try {
      const user = await identity(req);
      if (!user) throw new AdminError(401, 'AUTH_REQUIRED', 'Not signed in.');
      respond.ok(res, publicUser(req, user));
    } catch (error) { next(authError(error)); }
  });
  router.post('/login', async (req, res, next) => {
    try {
      if (req.body?.password !== undefined || req.body?.identifier !== undefined) {
        throw new AdminError(400, 'CORE_SIGN_IN_REQUIRED', 'Enter credentials only on W3 Core.');
      }
      requireSessionSecret();
      prune();
      if (pending.size >= 2000) throw new AdminError(429, 'LOGIN_BUSY', 'Try signing in again shortly.');
      const state = token(), verifier = token();
      const redirectTo = await core.authorizationUrl(state, createHash('sha256').update(verifier).digest('base64url'));
      if (pending.size >= 2000) throw new AdminError(429, 'LOGIN_BUSY', 'Try signing in again shortly.');
      const id = token();
      pending.set(hash(id), { state, verifier, next: safeReturnPath(req.body?.next), expires: Date.now() + LOGIN_TTL });
      res.cookie(PENDING_COOKIE, id, { ...cookieOptions, maxAge: LOGIN_TTL });
      respond.ok(res, { redirectTo });
    } catch (error) {
      const failure = authError(error);
      if (failure instanceof AdminError) await options.audit?.('auth.login_failed', null, { code: failure.code }).catch(() => undefined);
      next(failure);
    }
  });
  router.post('/login/verify-2fa', (_req, res) => {
    respond.err(res, 410, 'CORE_SIGN_IN_REQUIRED', 'Complete sign-in on W3 Core.');
  });
  router.get('/callback', async (req, res) => {
    res.clearCookie(PENDING_COOKIE, { path: '/' });
    try {
      prune();
      const id = cookie(req, PENDING_COOKIE), key = id ? hash(id) : '';
      const login = pending.get(key);
      pending.delete(key);
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      if (!login || !/^[A-Za-z0-9_-]{43}$/.test(code) || !timingSafeEqual(Buffer.from(hash(state), 'hex'), Buffer.from(hash(login.state), 'hex'))) {
        throw new AdminError(401, 'INVALID_LOGIN', 'Start sign-in again.');
      }
      requireSessionSecret();
      const result = await core.exchange(code, login.verifier);
      if (!result.ok) throw new AdminError(result.status, result.code, result.message);
      if (sessions.size >= 2000) {
        await core.logout(result.sessionToken);
        throw new AdminError(429, 'LOGIN_BUSY', 'Try signing in again shortly.');
      }
      await logout(req);
      const browserToken = token(), expires = Math.min(Date.now() + SESSION_TTL, Date.parse(result.expiresAt));
      sessions.set(hash(browserToken), { sealedCoreToken: encryptCoreSession(result.sessionToken, options.sessionSecret ?? ''), userId: result.user.id, expires, lastVerifiedAt: new Date().toISOString() });
      res.cookie(COOKIE, browserToken, { ...cookieOptions, maxAge: Math.max(0, expires - Date.now()) });
      await options.audit?.('auth.login', { coreUserId: result.user.id, name: result.user.username }, { appRole: result.user.appRole }).catch(() => undefined);
      res.redirect(303, login.next);
    } catch (error) {
      const failure = authError(error);
      const status = failure instanceof AdminError ? failure.status : 500;
      res.redirect(303, APP_BASE + (status === 503 ? '/core-unavailable' : status === 403 ? '/access-denied' : '/login?error=sign_in_failed'));
    }
  });
  router.post('/logout', async (req, res, next) => {
    try {
      const id = cookie(req, PENDING_COOKIE);
      if (id) pending.delete(hash(id));
      await logout(req);
      res.clearCookie(COOKIE, { path: '/' });
      res.clearCookie(PENDING_COOKIE, { path: '/' });
      respond.ok(res, { signedOut: true });
    } catch (error) { next(authError(error)); }
  });
  router.use(envelopeNotFound, envelopeErrorHandler);
  return { router, requireAdmin, sameOrigin, adminSession, authorizeAdminSession, publicAppUrl: options.publicAppUrl };
}
export type CoreAuth = ReturnType<typeof createCoreAuth>;
