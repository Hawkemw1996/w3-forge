import { consoleText } from "../../../../shared/consoleApp";
import { ReactNode, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, KeyRound, Loader2, ShieldOff, CloudOff } from 'lucide-react';
import { APP_NAME, APP_VERSION } from '../lib/appInfo';
import { appPath, appRoute, isAdminPath, safeReturnPath } from '../../../../shared/navigation';
import { errorMessages } from '../lib/authApi';
import { loadAuthStatus, startLogin, useAuthStatus } from '../lib/authSession';

// Sign-in is completed on Core; BuildCost never collects account credentials.

/** Only same-app relative paths are accepted as a return target. */
export function safeNext(raw: string | null): string {
  return appRoute(safeReturnPath(raw));
}

export function AuthShell({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10" style={{ background: 'var(--w3-bg)' }}>
      <div className="card w-full max-w-sm" data-testid="auth-shell">
        <div className="card-body space-y-4 p-6">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md font-bold" style={{ background: 'var(--w3-gold-500)', color: '#1A1206' }}>
              W3
            </div>
            <div>
              <div className="text-base font-semibold" style={{ color: 'var(--w3-gold-400)' }}>{APP_NAME}</div>
              <div className="text-[11px]" style={{ color: 'var(--w3-text-muted)' }}>v{APP_VERSION}</div>
            </div>
          </div>
          <h1 className="flex items-center gap-2 text-lg font-semibold" style={{ color: 'var(--w3-text)' }}>
            {icon}
            {title}
          </h1>
          {children}
        </div>
      </div>
    </div>
  );
}

function FormError({ messages }: { messages: string[] }) {
  if (!messages.length) return null;
  return (
    <div role="alert" data-testid="auth-error" className="flex items-start gap-2 rounded-md border p-2 text-xs" style={{ background: 'var(--status-danger-bg)', borderColor: 'rgba(239,68,68,0.4)', color: 'var(--status-danger)' }}>
      <AlertCircle size={13} className="mt-0.5 shrink-0" />
      <div>{messages.map((m) => <div key={m}>{m}</div>)}</div>
    </div>
  );
}

export function LoginPage(){
 const navigate=useNavigate();const[params]=useSearchParams();const next=safeNext(params.get('next'));
 const status=useAuthStatus();const[busy,setBusy]=useState(false),[errors,setErrors]=useState<string[]>(params.has('error')?['Sign-in did not complete. Please start again.']:[]);
 useEffect(()=>{loadAuthStatus().then(s=>{if(s.authenticated){if(isAdminPath(next))window.location.assign(next);else navigate(next,{replace:true});}}).catch(e=>setErrors(errorMessages(e)));},[]);
 const unavailable=status&&!status.loginAvailable?status.loginUnavailableReason?.message??'Sign-in is unavailable.':null;
 async function signIn(){setBusy(true);setErrors([]);try{window.location.assign(await startLogin(next));}catch(e){setErrors(errorMessages(e));setBusy(false);}}
 return <AuthShell title="Sign in" icon={<KeyRound size={18} style={{color:'var(--w3-gold-400)'}}/>}>
  <p className="text-xs" style={{color:'var(--w3-text-muted)'}}>Continue to W3 Core to sign in. The Core owner must allow {consoleText("BuildCost")} sign-in and assign your account access.</p>
  <FormError messages={unavailable?[unavailable]:[]}/><FormError messages={errors}/>
  <button type="button" className="btn btn-primary w-full justify-center" onClick={()=>void signIn()} disabled={busy||!!unavailable||!status} data-testid="login-submit">{busy?<Loader2 size={14} className="animate-spin"/>:null} Sign in with W3 Core</button>
  {status?.connection?.fingerprint&&status.connection.status!=='approved'?<div className="text-xs" style={{color:'var(--w3-text-muted)'}} data-testid="core-pairing"><p>For the Core owner: match this installation fingerprint when approving {consoleText("BuildCost")}.</p><code>{status.connection.fingerprint}</code></div>:null}
 </AuthShell>;
}

export function AccessDeniedPage() {
  const [params] = useSearchParams();
  const admin = params.get('area') === 'admin';
  return (
    <AuthShell title="Access denied" icon={<ShieldOff size={18} style={{ color: 'var(--status-danger)' }} />}>
      <p className="text-sm" style={{ color: 'var(--w3-text-muted)' }} data-testid="access-denied-message">
        {admin
          ? consoleText('Your W3 account is signed in but does not have W3 BuildCost administrator access.')
          : consoleText('Your W3 account is signed in but does not have access to W3 BuildCost.')}{' '}
        Access is granted in W3 Core; ask a W3 administrator.
      </p>
      <div className="flex gap-2">
        {admin ? <a className="btn" href={appPath()}>Back to {APP_NAME}</a> : null}
        <a className="btn" href={appPath('/login')}>Sign in as someone else</a>
      </div>
    </AuthShell>
  );
}

export function CoreUnavailablePage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  return (
    <AuthShell title="W3 Core is unavailable" icon={<CloudOff size={18} style={{ color: 'var(--status-warning)' }} />}>
      <p className="text-sm" style={{ color: 'var(--w3-text-muted)' }} data-testid="core-unavailable-message">
        {consoleText("W3 BuildCost")} verifies every user with W3 Core and cannot sign you in or confirm your session while W3 Core is unreachable. Your saved data is not affected.
      </p>
      <a className="btn btn-primary" href={safeReturnPath(next)}>Try again</a>
    </AuthShell>
  );
}
