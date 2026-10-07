import { ReactNode, useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { cn } from '../lib/cn';
import {
  W3SidebarBrand,
  W3SidebarNav,
  W3SidebarSectionLabel,
  W3SidebarFooter,
  W3NavItem
} from './W3Sidebar';
import { W3BadgeTone } from './W3Badge';

// =============================================================================
// W3 BuildCost — W3Layout (v0.10.7, W3 UI System Foundation)
// =============================================================================
//
// Canonical app shell promoted from the Admin Operations Console AdminLayout:
//   - Desktop (>=768px): left sidebar + main column, scrolling as one
//     natural document (no sticky pinning).
//   - Tablet/Mobile (<768px): sidebar hidden; a hamburger opens a slide-out
//     drawer that auto-closes on route change, outside-tap, and Escape, with
//     body scroll locked while open.
//
// Both consoles consume this shell so the chrome never drifts. App-specific
// pieces (brand text, nav items, header content, footer) are passed in as
// props — there are NO app-specific copies of this layout, and no app keeps
// its own large inline-style layout shell.
//
// Rules going forward:
//   - No new large inline style blocks in layout shell components.

export function W3Layout({
  brandTitle,
  brandSubtitle,
  version,
  versionTone = 'gold',
  sectionLabel,
  navItems,
  header,
  footerHref,
  footerLabel,
  footerNote,
  onLogout,
  sidebarTestId,
  navTestId,
  children
}: {
  brandTitle: string;
  brandSubtitle: string;
  version?: string;
  /** Badge tone for the brand version chip (Admin: gold; Command Center: slate). */
  versionTone?: W3BadgeTone;
  /** Optional uppercase group label above the nav (e.g. "Platform"). */
  sectionLabel?: ReactNode;
  navItems: W3NavItem[];
  /** Top header content (typically a W3PageHeader). */
  header: ReactNode;
  /** Optional footer link. Omit for consoles with no external footer link. */
  footerHref?: string;
  footerLabel?: string;
  footerNote?: ReactNode;
  /** When provided, renders a Logout button in the sidebar footer below the footer link. */
  onLogout?: () => void;
  /** Optional test id on the desktop sidebar <aside>. */
  sidebarTestId?: string;
  /** Optional test id on the nav rail <nav>. */
  navTestId?: string;
  children: ReactNode;
}) {
  const location = useLocation();
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

  const showFooter = Boolean(footerHref && footerLabel);

  return (
    <div className="flex min-h-full" style={{ background: 'var(--w3-bg)' }}>
      {/* ----- Desktop sidebar (>=768px) ----- */}
      {/* Sticky full-height rail: stays pinned while the main column scrolls. */}
      <aside
        data-testid={sidebarTestId}
        className="hidden w-60 shrink-0 flex-col md:flex md:sticky md:top-0 md:h-screen md:overflow-y-auto"
        style={{
          background: 'var(--w3-surface)',
          borderRight: '1px solid var(--w3-border)'
        }}
      >
        <W3SidebarBrand
          title={brandTitle}
          subtitle={brandSubtitle}
          version={version}
          versionTone={versionTone}
        />
        {sectionLabel ? (
          <W3SidebarSectionLabel>{sectionLabel}</W3SidebarSectionLabel>
        ) : null}
        <W3SidebarNav items={navItems} testId={navTestId} />
        {showFooter ? (
          <W3SidebarFooter
            version={version}
            footerHref={footerHref!}
            footerLabel={footerLabel!}
            note={footerNote}
            onLogout={onLogout}
          />
        ) : null}
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
          <W3SidebarBrand
            title={brandTitle}
            subtitle={brandSubtitle}
            version={version}
            versionTone={versionTone}
            compact
          />
          <button
            type="button"
            className="btn-ghost btn !px-2 !py-1"
            aria-label="Close Navigation"
            onClick={closeDrawer}
          >
            <X size={18} />
          </button>
        </div>
        {sectionLabel ? (
          <W3SidebarSectionLabel>{sectionLabel}</W3SidebarSectionLabel>
        ) : null}
        <W3SidebarNav items={navItems} onNavigate={closeDrawer} />
        {showFooter ? (
          <W3SidebarFooter
            version={version}
            footerHref={footerHref!}
            footerLabel={footerLabel!}
            note={footerNote}
            onLogout={onLogout}
          />
        ) : null}
      </aside>

      <main className="flex-1 min-w-0" style={{ background: 'var(--w3-bg)' }}>
        {/* Sticky top header bar: stays pinned while page content scrolls. */}
        <div
          className="sticky top-0 z-20 flex items-stretch"
          style={{
            background: 'var(--w3-bg)',
            borderBottom: '1px solid var(--w3-border)'
          }}
        >
          {/* Hamburger — mobile/tablet only; sits to the left of the header. */}
          <button
            type="button"
            className="md:hidden btn !px-2 !py-1 m-3"
            aria-label="Open Navigation"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          >
            <Menu size={18} />
          </button>
          <div className="min-w-0 flex-1">{header}</div>
        </div>
        <div className="px-4 py-4 sm:px-6 sm:py-5">{children}</div>
      </main>
    </div>
  );
}
