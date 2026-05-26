import { ReactNode, useCallback, useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Activity,
  FileText,
  FolderTree,
  Settings,
  ShieldAlert,
  Sliders,
  Menu,
  X
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { adminGet } from '../lib/api';
import { cn } from '../lib/utils';

// =============================================================================
// AdminLayout — W3 Forge v0.4.0
// =============================================================================
//
// Adapted from W3 Core Admin Console AdminLayout. Same shell, fewer nav items
// (no Packages, Backups, GitHub/Releases, Manual Setup). Branded W3 Forge.
// "W3 Core remains deployment authority." subline in the footer.

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
  { to: '/controls', label: 'Controls', icon: Sliders },
  { to: '/settings', label: 'Settings', icon: Settings }
];

interface VersionData {
  app: string;
  activeApp: string;
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

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [drawerOpen]);

  const activeLabel =
    NAV.find((n) =>
      n.to === '/' ? location.pathname === '/' : location.pathname.startsWith(n.to)
    )?.label ?? 'Admin';

  return (
    <div className="flex min-h-full" style={{ background: 'var(--w3-bg)' }}>
      <aside
        className="hidden w-60 shrink-0 flex-col md:flex"
        style={{ background: 'var(--w3-surface)', borderRight: '1px solid var(--w3-border)' }}
      >
        <SidebarBrand version={version?.version} />
        <SidebarNav onNavigate={() => undefined} />
        <SidebarFooter version={version?.version} />
      </aside>

      {drawerOpen ? (
        <button
          type="button"
          aria-label="Close Navigation"
          className="md:hidden fixed inset-0 z-30"
          style={{ background: 'rgba(0,0,0,0.55)' }}
          onClick={closeDrawer}
        />
      ) : null}

      <aside
        className={cn(
          'md:hidden fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] flex-col transition-transform duration-200 ease-out',
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
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: '1px solid var(--w3-border)' }}
        >
          <SidebarBrand version={version?.version} compact />
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
        <SidebarFooter version={version?.version} />
      </aside>

      <main className="flex-1 min-w-0" style={{ background: 'var(--w3-bg)' }}>
        <header
          className="flex items-center gap-2 px-4 py-3 sm:px-6"
          style={{
            background: 'var(--w3-surface)',
            borderBottom: '1px solid var(--w3-border-strong)'
          }}
        >
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
              Forge Admin Console
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

function SidebarBrand({ version, compact }: { version?: string; compact?: boolean }) {
  const inner = (
    <div className="flex items-center gap-2">
      <div
        className="flex h-8 w-8 items-center justify-center rounded-md font-bold"
        style={{
          background: 'var(--w3-gold-500)',
          color: '#1A1206',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.2)'
        }}
      >
        W3
      </div>
      <div>
        <div
          className="text-base font-semibold tracking-tight"
          style={{ color: 'var(--w3-gold-400)' }}
        >
          W3 Forge
        </div>
        {compact ? (
          version ? (
            <span className="badge badge-gold">v{version}</span>
          ) : (
            <span className="badge badge-slate">Loading…</span>
          )
        ) : (
          <div className="text-[11px]" style={{ color: 'var(--w3-text-muted)' }}>
            Forge Admin Console
          </div>
        )}
      </div>
    </div>
  );
  if (compact) return inner;
  return (
    <div className="px-5 pb-4 pt-5">
      {inner}
      <div className="mt-3">
        {version ? (
          <span className="badge badge-gold">v{version}</span>
        ) : (
          <span className="badge badge-slate">Loading…</span>
        )}
      </div>
    </div>
  );
}

function SidebarNav({ onNavigate }: { onNavigate: () => void }) {
  return (
    <nav className="flex-1 space-y-0.5 px-2 pb-3 pt-1">
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'relative flex items-center gap-2 rounded-md px-3 py-2 text-sm transition',
              'border-l-[3px]',
              isActive
                ? 'text-white'
                : 'text-[var(--w3-text-muted)] hover:bg-white/[0.04] hover:text-white border-transparent'
            )
          }
          style={({ isActive }) =>
            isActive
              ? {
                  background: 'rgba(217,164,65,0.10)',
                  borderLeftColor: 'var(--w3-gold-500)',
                  color: 'var(--w3-text)'
                }
              : { borderLeftColor: 'transparent' }
          }
        >
          <item.icon size={16} />
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

function SidebarFooter({ version }: { version?: string }) {
  return (
    <div
      className="px-5 py-3 text-[11px]"
      style={{ borderTop: '1px solid var(--w3-border)', color: 'var(--w3-text-muted)' }}
    >
      <div
        className="flex items-center gap-1"
        style={{ color: 'var(--status-warning)' }}
      >
        <ShieldAlert size={12} />
        <span>Forge Foundation · v{version ?? '0.4.0'}</span>
      </div>
      <div className="mt-1" style={{ color: 'var(--w3-text-dim)' }}>
        W3 Core remains deployment authority.
      </div>
    </div>
  );
}
