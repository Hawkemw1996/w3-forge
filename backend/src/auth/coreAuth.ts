import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, json, type Request, type RequestHandler } from 'express';
import { adminGuard } from '../admin/adminGuard';
import { AdminError, respond, envelopeErrorHandler, envelopeNotFound } from '../admin/envelope';
import { type CoreClient, type CoreUser, CoreUnavailableError, CoreNotConfiguredError } from './coreClient';

const COOKIE = 'W3FORGE_SESSION';
const PENDING_COOKIE = 'W3FORGE_PENDING';
const LOGIN_TTL = 5 * 60 * 1000;
const SESSION_TTL = 8 * 60 * 60 * 1000;
const token = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function cookie(req: Request, name: string): string | undefined {
  const values = (req.get('cookie') ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(name + '='));
  if (values.length !== 1) return undefined;
  const value = values[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

export function safeReturnPath(raw: unknown): string {
  if (typeof raw !== 'string' || /[\\\u0000-\u0020]/.test(raw)) return '/admin/';
  try {
    const url = new URL(raw, 'https://local.invalid');
    return url.origin === 'https://local.invalid' && (url.pathname === '/admin' || url.pathname.startsWith('/admin/'))
      ? url.pathname + url.search + url.hash : '/admin/';
  } catch { return '/admin/'; }
}

export function createCoreAuth(core: CoreClient, options: { publicAppUrl: string; publicCoreUrl: string; cookieSecure: boolean }) {
  const pending = new Map<string, { state: string; verifier: string; next: string; expires: number }>();
  const sessions = new Map<string, { token: string; userId: string; expires: number }>();
  const cookieOptions = { httpOnly: true, secure: options.cookieSecure, sameSite: 'lax' as const, path: '/' };
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
  async function identity(req: Request): Promise<CoreUser | null> {
    prune();
    const browserToken = cookie(req, COOKIE);
    if (!browserToken) return null;
    const key = hash(browserToken), session = sessions.get(key);
    if (!session) return null;
    const result = await core.me(session.token);
    if (!result.ok || result.user.id !== session.userId) { sessions.delete(key); return null; }
    // A concurrent logout must not permit the request after its Core check.
    if (sessions.get(key) !== session) return null;
    return result.user;
  }
  async function logout(req: Request) {
    const browserToken = cookie(req, COOKIE);
    if (!browserToken) return;
    const key = hash(browserToken), session = sessions.get(key);
    sessions.delete(key);
    if (session) await core.logout(session.token);
  }
  const requireAdmin: RequestHandler = async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const user = await identity(req);
      if (!user) throw new AdminError(401, 'AUTH_REQUIRED', 'Sign in with W3 Core.');
      if (user.appRole !== 'admin') throw new AdminError(403, 'APP_ADMIN_REQUIRED', 'The Core owner must assign you the Forge admin role.');
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
      const user = await identity(req);
      respond.ok(res, {
        configured: core.configured, connection: core.connection,
        coreUrl: core.configured ? options.publicCoreUrl : null,
        authenticated: !!user,
        user: user ? { id: user.id, username: user.username, appRole: user.appRole } : null
      });
    } catch (error) { next(authError(error)); }
  });
  router.post('/login', async (req, res, next) => {
    try {
      if (req.body?.password !== undefined || req.body?.identifier !== undefined) {
        throw new AdminError(400, 'CORE_SIGN_IN_REQUIRED', 'Enter credentials only on W3 Core.');
      }
      prune();
      if (pending.size >= 2000) throw new AdminError(429, 'LOGIN_BUSY', 'Try signing in again shortly.');
      const state = token(), verifier = token();
      const redirectTo = await core.authorizationUrl(state, createHash('sha256').update(verifier).digest('base64url'));
      if (pending.size >= 2000) throw new AdminError(429, 'LOGIN_BUSY', 'Try signing in again shortly.');
      const id = token();
      pending.set(hash(id), { state, verifier, next: safeReturnPath(req.body?.next), expires: Date.now() + LOGIN_TTL });
      res.cookie(PENDING_COOKIE, id, { ...cookieOptions, maxAge: LOGIN_TTL });
      respond.ok(res, { redirectTo });
    } catch (error) { next(authError(error)); }
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
      const result = await core.exchange(code, login.verifier);
      if (!result.ok) throw new AdminError(result.status, result.code, result.message);
      if (sessions.size >= 2000) {
        await core.logout(result.sessionToken);
        throw new AdminError(429, 'LOGIN_BUSY', 'Try signing in again shortly.');
      }
      await logout(req);
      const browserToken = token(), expires = Math.min(Date.now() + SESSION_TTL, Date.parse(result.expiresAt));
      sessions.set(hash(browserToken), { token: result.sessionToken, userId: result.user.id, expires });
      res.cookie(COOKIE, browserToken, { ...cookieOptions, maxAge: Math.max(0, expires - Date.now()) });
      res.redirect(303, login.next);
    } catch (error) {
      const failure = authError(error);
      const status = failure instanceof AdminError ? failure.status : 500;
      res.redirect(303, '/admin/?sign_in=' + (status === 503 ? 'unavailable' : status === 403 ? 'denied' : 'failed'));
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
  return { router, requireAdmin, sameOrigin };
}
export type CoreAuth = ReturnType<typeof createCoreAuth>;
