import { ReactNode } from 'react';
import { cn } from '../../lib/utils';

// Status pill: small colored dot + label. Used in headers/footers where a
// flat badge would dominate. Tones map to the v0.5.1 semantic colors.

export type StatusTone = 'success' | 'info' | 'warning' | 'danger' | 'purple' | 'teal' | 'gold' | 'slate';

const DOT_COLOR: Record<StatusTone, string> = {
  success: 'var(--status-success)',
  info: 'var(--status-info)',
  warning: 'var(--status-warning)',
  danger: 'var(--status-danger)',
  purple: 'var(--status-purple)',
  teal: 'var(--status-teal)',
  gold: 'var(--w3-gold-500)',
  slate: 'var(--w3-text-muted)'
};

const PILL_CLASS: Record<StatusTone, string> = {
  success: 'badge-success',
  info: 'badge-info',
  warning: 'badge-warning',
  danger: 'badge-danger',
  purple: 'badge-purple',
  teal: 'badge-teal',
  gold: 'badge-gold',
  slate: 'badge-slate'
};

export function StatusPill({
  tone = 'slate',
  children,
  pulse = false,
  className
}: {
  tone?: StatusTone;
  children: ReactNode;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span className={cn('badge', PILL_CLASS[tone], className)}>
      <span
        className={cn('inline-block h-1.5 w-1.5 rounded-full', pulse && 'animate-pulse')}
        style={{ background: DOT_COLOR[tone] }}
        aria-hidden
      />
      <span>{children}</span>
    </span>
  );
}
