import { consoleText } from "./consoleApp";
/** Browser routes shared by the app, Admin Console and login callback. */
export const APP_BASE = consoleText('/buildcost');

export function appRoute(path: string): string {
  if (path === APP_BASE) return '/';
  if (path.startsWith(APP_BASE + '/')) return path.slice(APP_BASE.length);
  if (path.startsWith(APP_BASE + '?') || path.startsWith(APP_BASE + '#')) return '/' + path.slice(APP_BASE.length);
  return path;
}

/** Build an app URL from a router-relative path; never double-prefix it. */
export function appPath(route = '/'): string {
  const relative = appRoute(route);
  return APP_BASE + (relative === '/' ? '' : relative.startsWith('/?') || relative.startsWith('/#') ? relative.slice(1) : relative);
}

export function isAdminPath(path: string): boolean {
  return /^\/admin(?:[/?#]|$)/.test(path);
}

/** Accept only local app/admin return paths and exclude authentication loops. */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020]/.test(value)) return APP_BASE;
  try {
    const parsed = new URL(value, 'https://local.invalid');
    if (parsed.origin !== 'https://local.invalid') return APP_BASE;
    const route = appRoute(parsed.pathname);
    const decoded = decodeURIComponent(route);
    if (decoded.startsWith('//') || /[\\\u0000-\u0020]/.test(decoded) || /^\/(api|login|access-denied|core-unavailable)/i.test(decoded)) return APP_BASE;
    const target = parsed.pathname + parsed.search + parsed.hash;
    return isAdminPath(parsed.pathname) ? target : appPath(target);
  } catch { return APP_BASE; }
}
