import { consoleText } from "../../../../shared/consoleApp";
import { APP_BASE, appPath } from '../../../../shared/navigation';
import { ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Activity,
  FileText,
  Package,
  Archive,
  FolderTree,
  Github,
  TerminalSquare,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Menu,
  X
} from 'lucide-react';
import { W3SidebarBrand, W3SidebarNav, W3SidebarFooter, runtimeSidebarStatus } from '@shared/components';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { adminGet } from '../lib/api';
import { cn } from '../lib/utils';

// W3 Core sidebar styling shared with the BuildCost app; admin routes stay unchanged.

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/system', label: 'System Status', icon: Activity },
  { to: '/logs', label: 'Logs', icon: FileText },
  { to: '/packages', label: 'Packages', icon: Package },
  { to: '/backups', label: 'Backups', icon: Archive },
  { to: '/files', label: 'File Browser', icon: FolderTree },
  { to: '/github', label: 'GitHub / Releases', icon: Github },
  { to: '/terminal', label: 'Terminal', icon: TerminalSquare },
  { to: '/controls', label: 'Controls', icon: Sliders },
  { to: '/production-readiness', label: 'Production Readiness', icon: ShieldCheck },
  { to: '/settings', label: 'Settings', icon: Settings }
];

interface VersionData {
  app: string;
  version: string;
  nodeEnv: string;
}

export function AdminLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { data: version } = useQuery({
    queryKey: ['admin', 'version'],
    queryFn: () => adminGet<VersionData>('/version'),
    refetchInterval: 60_000
  });

  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // Auto-close drawer on route change.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Keep keyboard focus inside the visible mobile dialog and return it on close.
  useEffect(() => {
    if (!drawerOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const main = mainRef.current;
    main?.setAttribute('inert', '');
    const focusable = () => Array.from(drawerRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]'
    ) ?? []).filter(element => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setDrawerOpen(false); }
      if (event.key !== 'Tab') return;
      const elements = focusable(), first = elements[0], last = elements[elements.length - 1];
      if (!first || !last) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    const desktop = window.matchMedia('(min-width: 768px)');
    const onResize = () => { if (desktop.matches) setDrawerOpen(false); };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    desktop.addEventListener('change', onResize);
    return () => {
      window.removeEventListener('keydown', onKey);
      desktop.removeEventListener('change', onResize);
      document.body.style.overflow = prevOverflow;
      main?.removeAttribute('inert');
      previousFocus?.focus();
    };
  }, [drawerOpen]);

  const activeLabel =
    NAV.find((n) =>
      n.to === '/' ? location.pathname === '/' : location.pathname.startsWith(n.to)
    )?.label ?? 'Admin';

  return (
    <div className="flex min-h-full" style={{ background: 'var(--w3-bg)' }}>
      {/* ----- Desktop sidebar (≥768px) ----- */}
      {/* Sticky full-height rail: stays pinned while the main column scrolls. */}
      <aside
        className="w3-sidebar hidden w-60 shrink-0 flex-col md:flex md:sticky md:top-0 md:h-screen md:overflow-y-auto"
        style={{
          background: 'var(--w3-surface)',
          borderRight: '1px solid var(--w3-border)'
        }}
      >
        <SidebarBrand version={version?.version} nodeEnv={version?.nodeEnv} />
        <SidebarNav onNavigate={() => undefined} />
        <SidebarFooter version={version?.version} nodeEnv={version?.nodeEnv} />
      </aside>

      {/* ----- Mobile drawer overlay ----- */}
      {drawerOpen ? (
        <button
          type="button"
          aria-label="Close Navigation"
          tabIndex={-1}
          className="md:hidden fixed inset-0 z-30"
          style={{ background: 'rgba(0,0,0,0.55)' }}
          onClick={closeDrawer}
        />
      ) : null}

      {/* ----- Mobile drawer (<768px) ----- */}
      {drawerOpen ? <aside
        ref={drawerRef}
        id="admin-mobile-navigation"
        className={cn(
          'w3-sidebar md:hidden fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] flex-col overflow-y-auto transition-transform duration-200 ease-out',
          drawerOpen ? 'translate-x-0' : '-translate-x-full'
        )}
        style={{
          background: 'var(--w3-surface)',
          borderRight: '1px solid var(--w3-border)',
          boxShadow: '8px 0 24px rgba(0,0,0,0.45)'
        }}
        aria-modal="true"
        aria-label="Navigation"
        role="dialog"
      >
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--w3-border)' }}>
          <SidebarBrand version={version?.version} nodeEnv={version?.nodeEnv} compact />
          <button
            type="button"
            className="btn-ghost btn !px-2 !py-1"
            aria-label="Close Navigation"
            onClick={closeDrawer}
          >
            <X size={18} />
          </button>
        </div>
        <SidebarNav onNavigate={closeDrawer} />
        <SidebarFooter version={version?.version} nodeEnv={version?.nodeEnv} />
      </aside> : null}

      <main ref={mainRef} className="flex-1 min-w-0" style={{ background: 'var(--w3-bg)' }}>
        {/* v0.12.1: header is sticky again. The sidebar is pinned full-height
            and this top bar stays at top:0 while only the main content scrolls
            beneath it. The mobile drawer overlay continues to use fixed
            positioning so it can dim the viewport while open. */}
        <header
          className="sticky top-0 z-20 flex items-center gap-2 px-4 py-3 sm:px-6"
          style={{
            background: 'var(--w3-surface)',
            borderBottom: '1px solid var(--w3-border-strong)'
          }}
        >
          {/* Hamburger — mobile/tablet only */}
          <button
            type="button"
            className="md:hidden btn !px-2 !py-1"
            aria-label="Open Navigation"
            aria-expanded={drawerOpen}
            aria-controls="admin-mobile-navigation"
            onClick={() => setDrawerOpen(true)}
          >
            <Menu size={18} />
          </button>
          <div className="min-w-0 flex-1">
            <div
              className="hidden sm:block text-[10px] font-medium uppercase tracking-[0.12em]"
              style={{ color: 'var(--w3-text-muted)' }}
            >
              Admin Operations Console
            </div>
            <div
              className="truncate text-base font-semibold sm:text-lg"
              style={{ color: 'var(--w3-text)' }}
            >
              {activeLabel}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="badge badge-warning">
              <ShieldAlert size={11} />
              <span className="hidden xs:inline">Internal Only</span>
              <span className="xs:hidden">Internal</span>
            </span>
            {version ? (
              <span className="badge badge-gold">v{version.version}</span>
            ) : null}
          </div>
        </header>
        <div className="px-4 py-4 sm:px-6 sm:py-5">{children}</div>
      </main>
    </div>
  );
}


function SidebarBrand({ version, nodeEnv, compact }: { version?: string; nodeEnv?: string; compact?: boolean }) {
  return <W3SidebarBrand title={consoleText("W3 BuildCost")} subtitle="Admin Console"
    version={version ? 'v' + version : undefined} status={runtimeSidebarStatus(nodeEnv)} compact={compact} />;
}

function SidebarNav({ onNavigate }: { onNavigate: () => void }) {
  return <W3SidebarNav items={NAV.map(item => ({ ...item, end: item.to === '/' }))}
    sectionLabel={consoleText("W3 BuildCost")} onNavigate={onNavigate} />;
}

function SidebarFooter({ version, nodeEnv }: { version?: string; nodeEnv?: string }) {
  // Presentation reads the status already maintained by AdminAuthGate.
  const queryClient = useQueryClient();
  const snapshot = useCallback(() => queryClient.getQueryData<{
    authenticated: boolean; user?: { displayName?: string; username?: string } | null
  }>(['auth', 'status']), [queryClient]);
  const auth = useSyncExternalStore(
    useCallback(notify => queryClient.getQueryCache().subscribe(notify), [queryClient]),
    snapshot, snapshot
  );
  const inFlight = useRef(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState('');
  const logout = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSigningOut(true);
    setError('');
    try {
      const res = await fetch('/api/auth/logout', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
      });
      const body = await res.json();
      if (!res.ok || body?.success !== true) throw new Error('Sign out failed');
      window.location.replace(appPath('/login'));
    } catch {
      setError('Could not sign out. Please try again.');
    } finally {
      inFlight.current = false;
      setSigningOut(false);
    }
  };
  return (
    <div data-testid={consoleText("admin-footer-buildcost-link")}>
      <W3SidebarFooter version={version ? 'v' + version : undefined} status={runtimeSidebarStatus(nodeEnv)}
        signedInAs={auth?.authenticated ? auth.user?.displayName || auth.user?.username : undefined}
        footerHref={APP_BASE} footerLabel={consoleText("Back to W3 BuildCost")} footerIcon={LayoutDashboard}
        onLogout={logout} logoutPending={signingOut} logoutTestId="admin-sign-out" />
      {error ? <p role="alert" className="px-5 pb-3 text-xs text-[var(--status-danger)]">{error}</p> : null}
    </div>
  );
}
