import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Radar,
  Activity,
  FileText,
  FolderTree,
  Github,
  Settings,
  ShieldAlert,
  ShieldCheck,
  FlaskConical,
  Sliders,
  TerminalSquare,
  Menu,
  X
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { adminGet } from '../lib/api';
import { cn } from '../lib/utils';
import { useCoreStatus, signOut } from './CoreAuthGate';
import { W3SidebarBrand, W3SidebarNav, W3SidebarFooter } from '../shared/components/W3Sidebar';

// =============================================================================
// AdminLayout — Forge v0.4.1, inherited from Core v0.12.16
// =============================================================================
//
// Layout model:
//   - Desktop (≥768px): left sidebar + main column. The sidebar is pinned
//     full-height (sticky, top:0, h-screen) and the top header bar is sticky
//     at top:0; only the main content column scrolls beneath them.
//   - Tablet/Mobile (<768px): desktop sidebar is hidden; a hamburger button
//     in the top header opens a slide-out drawer from the left. The drawer
//     overlay remains fixed so it can dim the viewport, but the underlying
//     content does not pin. The drawer auto-closes on route change, on
//     outside-tap (overlay), and on Escape. Body scroll is locked while
//     the drawer is open.
//
// v0.12.15: Sidebar fragments use the Command Center shared components.
// Forge keeps its engineering routes and Core-owned sign-in.

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/system', label: 'System Status', icon: Activity },
  { to: '/logs', label: 'Logs', icon: FileText },
  { to: '/files', label: 'File Browser', icon: FolderTree },
  { to: '/github', label: 'GitHub Validation', icon: Github },
  { to: '/controls', label: 'Controls', icon: Sliders },
  { to: '/terminal', label: 'Terminal', icon: TerminalSquare },
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
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // Auto-close drawer on route change.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Escape key + body scroll lock while drawer is open.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
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
          className="md:hidden fixed inset-0 z-30"
          style={{ background: 'rgba(0,0,0,0.55)' }}
          onClick={closeDrawer}
        />
      ) : null}

      {/* ----- Mobile drawer (<768px) ----- */}
      <aside
        className={cn(
          'w3-sidebar md:hidden fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] flex-col overflow-y-auto transition-transform duration-200 ease-out',
          drawerOpen ? 'translate-x-0' : '-translate-x-full'
        )}
        style={{
          background: 'var(--w3-surface)',
          borderRight: '1px solid var(--w3-border)',
          boxShadow: '8px 0 24px rgba(0,0,0,0.45)'
        }}
        aria-hidden={!drawerOpen}
        role="navigation"
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
      </aside>

      <main className="flex-1 min-w-0" style={{ background: 'var(--w3-bg)' }}>
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

// -----------------------------------------------------------------------------
// Shared sidebar fragments — used by both the desktop sidebar and the mobile
// drawer so the two surfaces never drift.
// -----------------------------------------------------------------------------

function sidebarStatus(nodeEnv?: string) {
  return nodeEnv === 'production'
    ? { label: 'Production', tone: 'success' as const, icon: ShieldCheck }
    : nodeEnv === 'development'
      ? { label: 'Development build', tone: 'warning' as const, icon: FlaskConical }
      : nodeEnv === 'test'
        ? { label: 'Test environment', tone: 'info' as const, icon: FlaskConical }
        : undefined;
}

function SidebarBrand({ version, nodeEnv, compact }: { version?: string; nodeEnv?: string; compact?: boolean }) {
  return <W3SidebarBrand title="W3 Forge" subtitle="Admin Console"
    version={version ? 'v' + version : undefined} status={sidebarStatus(nodeEnv)} compact={compact} />;
}

function SidebarNav({ onNavigate }: { onNavigate: () => void }) {
  return <W3SidebarNav items={NAV.map(item => ({ ...item, end: item.to === '/' }))}
    sectionLabel="W3 Forge" onNavigate={onNavigate} />;
}

function SidebarFooter({ version, nodeEnv }: { version?: string; nodeEnv?: string }) {
  const status = useCoreStatus();
  const [error, setError] = useState('');
  const signingOut = useRef(false);
  const logout = async () => {
    if (signingOut.current) return;
    signingOut.current = true;
    try { await signOut(); } catch { setError('Could not sign out. Please try again.'); }
    finally { signingOut.current = false; }
  };
  return <div>
    <W3SidebarFooter version={version ? 'v' + version : undefined} status={sidebarStatus(nodeEnv)}
      signedInAs={status.data?.user?.username} footerHref={status.data?.coreUrl ?? '/admin/'}
      footerLabel="W3 Core" footerIcon={Radar} onLogout={logout}
      note="Engineering console · production release authority stays with the owner." />
    {error ? <p role="alert" className="px-5 pb-3 text-xs text-[var(--status-danger)]">{error}</p> : null}
  </div>;
}
