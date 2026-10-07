import { ReactNode, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { authGet, authPost } from '../lib/api';

export interface CoreStatus {
  configured: boolean;
  setupError?: string | null;
  authenticated: boolean;
  coreUrl: string | null;
  connection: { fingerprint: string | null; status: string };
  user: { id: string; username: string; appRole: string } | null;
}
export const CORE_STATUS_KEY = ['core', 'auth'];
export function useCoreStatus() {
  return useQuery({ queryKey: CORE_STATUS_KEY, queryFn: () => authGet<CoreStatus>('/status'),
    refetchInterval: 30_000, refetchOnWindowFocus: true, retry: false });
}
export async function signOut() {
  await authPost('/logout', {});
  window.location.replace('/admin/');
}
export function CoreAuthGate({ children }: { children: ReactNode }) {
  const status = useCoreStatus();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [accessProblem, setAccessProblem] = useState(false);
  useEffect(() => {
    const block = () => { setAccessProblem(true); void status.refetch(); };
    window.addEventListener('w3-auth-problem', block);
    return () => window.removeEventListener('w3-auth-problem', block);
  }, [status.refetch]);
  useEffect(() => {
    if (!status.isError && status.data?.authenticated && status.data.user?.appRole === 'admin') setAccessProblem(false);
    else if (!status.isPending) queryClient.removeQueries({ predicate: q => q.queryKey !== CORE_STATUS_KEY && q.queryKey[0] !== 'core' });
  }, [status.dataUpdatedAt, status.isError, status.isPending, queryClient]);
  const start = async () => {
    setBusy(true); setError('');
    try {
      const result = await authPost<{ redirectTo: string }>('/login', { next: window.location.pathname + window.location.search });
      window.location.assign(result.redirectTo);
    } catch (e) { setError(e instanceof Error ? e.message : 'Sign-in could not start.'); setBusy(false); }
  };
  if (status.isPending) return <div className="p-6 text-sm">Checking W3 Core access…</div>;
  if (!accessProblem && !status.isError && status.data?.authenticated && status.data.user?.appRole === 'admin') return <>{children}</>;
  const denied = status.data?.authenticated && status.data.user?.appRole !== 'admin';
  const callbackError = new URLSearchParams(window.location.search).get('sign_in');
  return <div className="min-h-screen flex items-center justify-center p-6">
    <div className="card w-full max-w-md"><div className="card-body space-y-4">
      <div className="text-lg font-semibold text-[var(--w3-gold-400)]">W3 Forge</div>
      <h1 className="text-base font-semibold">{denied ? 'Forge admin access required' : status.isError ? 'Core access unavailable' : 'Sign in with W3 Core'}</h1>
      <p className="text-sm text-[var(--w3-text-muted)]">The Core owner must approve this app, enable W3 sign-in and assign your account the Forge admin role.</p>
      {!status.data?.configured && !status.isError ? <p role="alert">{status.data?.setupError || 'This installation needs its Core connection configured.'}</p> : null}
      {status.data?.connection.fingerprint && status.data.connection.status !== 'approved' ? <div className="text-xs"><p>For the Core owner: match this installation fingerprint before approving it.</p><code>{status.data.connection.fingerprint}</code></div> : null}
      {error || status.isError || callbackError ? <p role="alert" className="text-sm text-[var(--status-danger)]">{error || (status.error instanceof Error ? status.error.message : callbackError === 'denied' ? 'Core has not allowed this sign-in.' : 'Sign-in could not finish. Check app access in Core and try again.')}</p> : null}
      <button type="button" className="btn btn-primary" disabled={busy || status.data?.configured === false} onClick={() => void start()}>Sign in with W3 Core</button>
      <button type="button" className="btn ml-2" onClick={() => void status.refetch()}>Retry access check</button>
      {status.data?.authenticated ? <button type="button" className="btn" onClick={() => void signOut().catch(() => setError('Could not sign out.'))}>Sign out</button> : null}
    </div></div>
  </div>;
}
