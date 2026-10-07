import { ReactNode } from 'react';
import { W3Badge } from './W3Badge';

// =============================================================================
// W3 BuildCost — W3PageHeader (v0.10.7, W3 UI System Foundation)
// =============================================================================
//
// Canonical page-header shell promoted from the Admin Operations Console
// header pattern: a small uppercase eyebrow ("ADMIN OPERATIONS CONSOLE" on
// /admin) above a large active-page title, with an optional right-hand slot
// for badges/actions.
//
// Both consoles consume this so the eyebrow + title rhythm never drifts.
// Rules going forward:
//   - No new large inline style blocks in layout shell components; styling
//     comes from shared tokens/primitives.

export function W3PageHeader({
  eyebrow,
  title,
  right
}: {
  eyebrow: string;
  title: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header
      className="flex items-center gap-2 px-4 py-3 sm:px-6"
      style={{
        background: 'var(--w3-surface)',
        borderBottom: '1px solid var(--w3-border-strong)'
      }}
    >
      <div className="min-w-0 flex-1">
        <div
          className="hidden sm:block text-[10px] font-medium uppercase tracking-[0.12em]"
          style={{ color: 'var(--w3-text-muted)' }}
        >
          {eyebrow}
        </div>
        <div
          className="truncate text-base font-semibold sm:text-lg"
          style={{ color: 'var(--w3-text)' }}
        >
          {title}
        </div>
      </div>
      {right ? (
        <div className="flex shrink-0 items-center gap-1.5">{right}</div>
      ) : null}
    </header>
  );
}

export { W3Badge };
