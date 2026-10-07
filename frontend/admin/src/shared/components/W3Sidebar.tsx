import { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { ShieldAlert, ShieldCheck, FlaskConical, ExternalLink, LogOut, LucideIcon } from 'lucide-react';
import { cn } from '../lib/cn';
import { W3Badge, W3BadgeTone } from './W3Badge';

// =============================================================================
// W3 Core — W3Sidebar (v0.10.7, W3 UI System Foundation)
// =============================================================================
//
// Canonical sidebar shell promoted from the Admin Operations Console
// (SidebarBrand + SidebarNav + SidebarFooter). Both consoles consume this so
// the brand block, gold-active nav treatment, and footer never drift.
//
// All chrome styling lives here (and in shared/styles/primitives.css via the
// `.w3-nav-link` hover/active primitive). Consumers pass data + optional
// test markers; no consumer keeps its own copy of this shell or its inline
// style blocks.
//
// Rules going forward:
//   - No new large inline style blocks in layout shell components.
//   - App-specific nav lives in the `items` prop; the shell stays shared.

export interface W3NavItem {
  to: string;
  label: string;
  /** Optional leading icon. Both consoles render icons (Admin via AdminLayout,
   *  Command Center via this shared shell as of v0.10.8). */
  icon?: LucideIcon;
  /** Use exact-match (NavLink `end`) for index-style routes. */
  end?: boolean;
  /** When false, the item renders as a disabled (non-navigating) row. */
  enabled?: boolean;
  /** Small trailing badge text (e.g. a "coming in vX" marker on disabled rows). */
  badge?: string;
  /** Optional per-item test id (rendered on the row element). */
  testId?: string;
}

export interface W3SidebarStatus {
  label: string;
  tone: 'warning' | 'success' | 'info';
  icon: LucideIcon;
}

/** Runtime metadata is informational; unknown environments get no invented label. */
export function runtimeSidebarStatus(nodeEnv?: string): W3SidebarStatus | undefined {
  if (nodeEnv === 'production') return { label: 'Production', tone: 'success', icon: ShieldCheck };
  if (nodeEnv === 'development') return { label: 'Development build', tone: 'warning', icon: FlaskConical };
  if (nodeEnv === 'test') return { label: 'Test environment', tone: 'info', icon: FlaskConical };
  return undefined;
}

export function W3SidebarBrand({
  title,
  subtitle,
  version,
  versionTone = 'gold',
  status,
  compact
}: {
  title: string;
  subtitle: string;
  version?: string;
  /** Badge tone for the version chip (Admin: gold; Command Center: slate). */
  versionTone?: W3BadgeTone;
  status?: W3SidebarStatus;
  compact?: boolean;
}) {
  const brandMark = (
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
  );
  const brandText = (
    <div>
      <div
        className="text-base font-semibold tracking-tight"
        style={{ color: 'var(--w3-gold-400)' }}
      >
        {title}
      </div>
      {compact ? null : (
        <div className="text-[11px]" style={{ color: 'var(--w3-text-muted)' }}>
          {subtitle}
        </div>
      )}
    </div>
  );
  // v0.11.6 — do not render a "Loading…" placeholder badge. The version chip
  // is purely informational; if /version hasn't resolved yet, render nothing
  // rather than a noisy slate "Loading…" pill that flashes on every mount.
  const versionBadge = version ? (
    <W3Badge tone={versionTone}>{version}</W3Badge>
  ) : null;
  if (compact) {
    return (
      <div className="flex items-center gap-2">
        {brandMark}
        <div>
          {brandText}
          {versionBadge}
        </div>
      </div>
    );
  }
  return (
    <div className="px-5 pb-4 pt-5">
      <div className="flex items-center gap-2">
        {brandMark}
        {brandText}
      </div>
      {versionBadge || status ? (
        <div className="mt-3 flex flex-wrap gap-1">
          {versionBadge}
          {status ? <W3Badge tone={status.tone}>{status.label}</W3Badge> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Uppercase section label above a nav group (e.g. "Platform"). */
export function W3SidebarSectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.12em]"
      style={{ color: 'var(--w3-text-dim)' }}
    >
      {children}
    </div>
  );
}

export function W3SidebarNav({
  items,
  onNavigate,
  sectionLabel,
  testId
}: {
  items: W3NavItem[];
  onNavigate?: () => void;
  sectionLabel?: ReactNode;
  /** Optional test id on the <nav> rail element. */
  testId?: string;
}) {
  return (
    <nav
      className="flex-1 space-y-0.5 px-2 pb-3 pt-1"
      aria-label="Primary navigation"
      data-testid={testId}
    >
      <div className="pb-2">
      {sectionLabel ? <W3SidebarSectionLabel>{sectionLabel}</W3SidebarSectionLabel> : null}
      {items.map((item) =>
        item.enabled === false ? (
          <div
            key={item.to}
            data-testid={item.testId}
            title={item.badge ? `Available in ${item.badge}` : 'Coming soon'}
            // v0.11.6 — disabled rows now left-align icon + label with gap-2
            // (matches the active .w3-nav-link layout). Trailing badge (if any)
            // uses ml-auto so it stays right-aligned without pushing the label.
            className="flex cursor-not-allowed items-center gap-2 rounded-md border-l-[3px] border-transparent px-3 py-2 text-sm opacity-55"
            style={{ color: 'var(--w3-text-dim)' }}
          >
            {item.icon ? <item.icon size={16} /> : null}
            <span>{item.label}</span>
            {item.badge ? (
              <span
                className="ml-auto rounded text-[9px] font-semibold tracking-[0.06em]"
                style={{
                  color: 'var(--w3-text-dim)',
                  background: 'rgba(148,163,184,0.08)',
                  border: '1px solid var(--w3-border)',
                  padding: '1px 5px'
                }}
              >
                {item.badge}
              </span>
            ) : null}
          </div>
        ) : (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            data-testid={item.testId}
            className={({ isActive }) =>
              cn('w3-nav-link !py-2 !font-normal', isActive && 'is-active')
            }
          >
            {item.icon ? <item.icon size={16} /> : null}
            <span>{item.label}</span>
          </NavLink>
        )
      )}
      </div>
    </nav>
  );
}

export function W3SidebarFooter({
  version,
  footerHref,
  footerLabel,
  footerIcon: FooterIcon = ExternalLink,
  status,
  signedInAs,
  note,
  onLogout,
  logoutPending = false,
  logoutTestId = 'cc-logout-btn',
  linkTestId,
  signedInTestId
}: {
  version?: string;
  footerHref?: string;
  footerLabel?: string;
  footerIcon?: LucideIcon;
  status?: W3SidebarStatus;
  signedInAs?: string;
  note?: ReactNode;
  /** When provided, renders a Logout button below the footer link. */
  onLogout?: () => void;
  logoutPending?: boolean;
  logoutTestId?: string;
  linkTestId?: string;
  signedInTestId?: string;
}) {
  return (
    <div
      className="px-5 py-3 text-[11px]"
      style={{
        borderTop: '1px solid var(--w3-border)',
        color: 'var(--w3-text-muted)'
      }}
    >
      {status || version ? (
        <div className="flex items-center gap-1" style={status ? { color: `var(--status-${status.tone})` } : undefined}>
          {status ? <status.icon size={12} className="shrink-0" aria-hidden="true" /> : null}
          <span>{status?.label}{status && version ? ' · ' : ''}{version}</span>
        </div>
      ) : null}
      {signedInAs ? (
        <div className="mt-1 truncate" data-testid={signedInTestId} title={`Signed in as ${signedInAs}`}>
          Signed in as {signedInAs}
        </div>
      ) : null}
      {note ? (
        <div
          className="flex items-center gap-1"
          style={{ color: 'var(--status-warning)' }}
        >
          <ShieldAlert size={12} />
          <span>{note}</span>
        </div>
      ) : null}
      {footerHref && footerLabel ? <div className={cn(Boolean(status || version || signedInAs || note) && 'mt-3')}>
        <a
          href={footerHref}
          data-testid={linkTestId}
          className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition hover:bg-white/[0.04] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--w3-gold-400)]"
          style={{ borderColor: 'var(--w3-border)', color: 'var(--w3-text)' }}
        >
          <FooterIcon size={13} className="shrink-0" style={{ color: 'var(--w3-gold-400)' }} aria-hidden="true" />
          <span>{footerLabel}</span>
        </a>
      </div> : null}
      {onLogout ? (
        <div className="mt-2">
          <button
            type="button"
            data-testid={logoutTestId}
            disabled={logoutPending}
            onClick={onLogout}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition hover:bg-white/[0.04] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--w3-gold-400)]"
            style={{ color: 'var(--w3-text-muted)' }}
          >
            <LogOut size={13} aria-hidden="true" />
            <span>{logoutPending ? 'Signing out…' : 'Sign out'}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
