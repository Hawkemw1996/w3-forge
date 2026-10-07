// Browser handoff to Core; this app receives only its assigned identity and permissions.
import { useSyncExternalStore } from 'react';
import { ApiError, apiGet, apiPost } from './authApi';
import { safeReturnPath } from '../../../../shared/navigation';

export interface AuthStatus {
  identityProvider: string;
  coreConfigured: boolean;
  connection?: {fingerprint:string|null;status:string};
  loginAvailable: boolean;
  loginUnavailableReason: { code: string; message: string } | null;
  authenticated: boolean;
  user: {
    coreUserId: string;
    username: string;
    displayName: string;
    coreRole: string;
    appRole?: string;
    permissions: string[];
  } | null;
  sessionError: { code: string; message: string } | null;
}

export type Permission = string;

let status: AuthStatus | null = null;
const listeners = new Set<() => void>();
function publish() {
  listeners.forEach((l) => l());
}

export function getAuthStatus(): AuthStatus | null {
  return status;
}

export function useAuthStatus(): AuthStatus | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getAuthStatus,
    getAuthStatus
  );
}

export async function loadAuthStatus(): Promise<AuthStatus> {
  status = await apiGet<AuthStatus>('/api/auth/status');
  publish();
  return status;
}


/** Begin a browser handoff. Passwords and two-factor entry happen only in Core. */
export async function startLogin(next='/'):Promise<string>{
 const result=await apiPost<{redirectTo:string}>('/api/auth/login',{next:safeReturnPath(next)});
 return result.redirectTo;
}


/** Where to send the browser for an auth/availability problem. */
export function redirectFor(err: unknown, next: string): string | null {
  if (!(err instanceof ApiError)) return null;
  const n = encodeURIComponent(next);
  if (err.status === 401) return `/login?next=${n}`;
  if (err.status === 403 && err.code === 'ACCESS_DENIED') return '/access-denied';
  if (err.code === 'CORE_UNAVAILABLE' || err.code === 'CORE_NOT_CONFIGURED' || err.code === 'SESSION_SECRET_MISSING') return `/core-unavailable?next=${n}`;
  return null;
}

export function resetSessionForTests(): void {
  status = null;
  publish();
}
