import { consoleText } from "../../../../shared/consoleApp";
/**
 * W3 BuildCost Admin Console Auth Gate (adapted from W3 Core v0.12.11
 * frontend/admin/src/components/AdminAuthGate.tsx).
 *
 * Identity comes from W3 Core through the BuildCost backend. The app's
 * /buildcost/login page returns administrators to the separate /admin SPA.
 */

import { useEffect } from 'react';
import { appPath } from '../../../../shared/navigation';
import { useQuery } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// Auth status fetch
// ---------------------------------------------------------------------------

interface AuthStatus {
  authenticated: boolean;
  loginAvailable: boolean;
  user: { displayName: string; permissions: string[] } | null;
  sessionError: { code: string; message: string } | null;
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
}

/** Thrown when /api/auth/status cannot be reached or returns no data. */
class AuthStatusUnavailable extends Error {}

async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch('/api/auth/status', {
    method:      'GET',
    credentials: 'include',
    headers:     { Accept: 'application/json' }
  });
  let body: ApiEnvelope<AuthStatus> | null = null;
  try {
    body = (await res.json()) as ApiEnvelope<AuthStatus>;
  } catch {
    body = null;
  }
  if (!res.ok || !body?.success || !body.data) throw new AuthStatusUnavailable(consoleText('W3 BuildCost is not responding.'));
  return body.data;
}

// ---------------------------------------------------------------------------
// Gate component
// ---------------------------------------------------------------------------

/** W3 BuildCost sign-in (W3 Core credentials); returns to the Admin Console. */
const LOGIN_URL = appPath('/login?next=/admin');
const ACCESS_DENIED_URL = appPath('/access-denied?area=admin');
const CORE_UNAVAILABLE_URL = appPath('/core-unavailable?next=/admin');

interface AdminAuthGateProps {
  children: React.ReactNode;
}

/**
 * AdminAuthGate — must wrap the entire Admin Console app tree.
 *
 * W3 BuildCost: renders children only for a signed-in W3 Core user whose
 * BuildCost permissions include buildcost:admin. Otherwise it redirects to
 * the BuildCost sign-in, access-denied, or Core-unavailable page. The backend
 * enforces the same rule on every /api/admin request; this gate only avoids
 * rendering a console the user cannot use.
 */
export function AdminAuthGate({ children }: AdminAuthGateProps) {
  const { data: status, isLoading, isError, refetch } = useQuery({
    queryKey: ['auth', 'status'],
    queryFn:  fetchAuthStatus,
    retry:           1,
    refetchInterval: 5 * 60 * 1_000,
    refetchOnWindowFocus: true
  });

  // Common session-revocation safeguard: failed protected requests trigger a fresh Core check.
  useEffect(() => {
    const refresh = () => { void refetch(); };
    window.addEventListener('w3-auth-problem', refresh);
    return () => window.removeEventListener('w3-auth-problem', refresh);
  }, [refetch]);

  const target = isError
    ? CORE_UNAVAILABLE_URL
    : isLoading || !status
      ? null
      : !status.authenticated
        ? status.sessionError?.code === 'CORE_UNAVAILABLE' || !status.loginAvailable
          ? CORE_UNAVAILABLE_URL
          : LOGIN_URL
        : !status.user?.permissions.includes(consoleText('buildcost:admin'))
          ? ACCESS_DENIED_URL
          : null;

  useEffect(() => {
    if (target) window.location.replace(target);
  }, [target]);

  if (isLoading || target) {
    return (
      <div
        data-testid="admin-auth-gate-loading"
        style={{
          minHeight:      '100vh',
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'center',
          background:     'var(--w3-bg, #0d0d0d)',
          color:          'var(--w3-text-muted, #888)',
          fontSize:       '14px'
        }}
      >
        {target ? 'Redirecting…' : 'Loading…'}
      </div>
    );
  }

  return <>{children}</>;
}
