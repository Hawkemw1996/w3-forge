import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { LayoutDashboard } from 'lucide-react';
import { AccessDeniedPage, AuthShell, CoreUnavailablePage, LoginPage } from './pages/AuthPages';
import { loadAuthStatus, useAuthStatus } from './lib/authSession';
import { apiPost, errorMessages } from './lib/authApi';
import { appPath } from '../../../shared/navigation';
import { consoleApp } from '../../../shared/consoleApp';

/** Product landing only; the common admin console remains mounted at /admin. */
function ProductLanding() {
  const status = useAuthStatus();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { loadAuthStatus().catch(reason => setError(errorMessages(reason).join(' '))); }, []);
  if (status && !status.authenticated) return <Navigate to="/login" replace />;
  async function signOut() {
    setBusy(true); setError('');
    try { await apiPost('/api/auth/logout', {}); window.location.replace(appPath('/login')); }
    catch (reason) { setError(errorMessages(reason).join(' ')); setBusy(false); }
  }
  return <AuthShell title={consoleApp.name} icon={<LayoutDashboard size={18} />}>
    <p className="text-sm text-[var(--w3-text-muted)]">{status?.authenticated ? 'The application workspace is being prepared.' : 'Checking your W3 Core session…'}</p>
    {error && <p role="alert" className="text-xs text-[var(--status-danger)]">{error}</p>}
    {status?.authenticated && <div className="flex flex-wrap gap-2">
      {status.user?.permissions.includes(consoleApp.permissionPrefix + ':admin') && <a href="/admin/" className="btn btn-primary">Admin Console</a>}
      <button className="btn" type="button" disabled={busy} onClick={() => void signOut()}>{busy ? 'Signing out…' : 'Sign out'}</button>
    </div>}
    {error && !status && <a className="btn" href={appPath('/login')}>Try again</a>}
  </AuthShell>;
}
export default function PublicApp() {
  return <Routes><Route path="/login" element={<LoginPage />} /><Route path="/access-denied" element={<AccessDeniedPage />} />
    <Route path="/core-unavailable" element={<CoreUnavailablePage />} /><Route path="/" element={<ProductLanding />} />
    <Route path="*" element={<Navigate to="/" replace />} /></Routes>;
}
