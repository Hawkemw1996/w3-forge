import { ReactNode } from 'react';
import { cn } from '../../lib/utils';

// Semantic badge variants for v0.5.1. Legacy tones (ok/warn/fail/muted) are
// preserved as aliases so v0.5.0 call-sites keep rendering without churn.
export type BadgeTone =
  | 'success'
  | 'info'
  | 'warning'
  | 'danger'
  | 'purple'
  | 'teal'
  | 'gold'
  | 'slate'
  // Legacy aliases (v0.5.0).
  | 'ok'
  | 'warn'
  | 'fail'
  | 'muted';

const TONE_CLASS: Record<BadgeTone, string> = {
  success: 'badge-success',
  info: 'badge-info',
  warning: 'badge-warning',
  danger: 'badge-danger',
  purple: 'badge-purple',
  teal: 'badge-teal',
  gold: 'badge-gold',
  slate: 'badge-slate',
  ok: 'badge-success',
  warn: 'badge-warning',
  fail: 'badge-danger',
  muted: 'badge-slate'
};

export function Badge({
  tone = 'slate',
  children,
  className
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return <span className={cn('badge', TONE_CLASS[tone], className)}>{children}</span>;
}

export function statusTone(status: string | null | undefined): BadgeTone {
  const s = (status ?? '').toLowerCase();
  if (
    s === 'ok' ||
    s === 'active' ||
    s === 'connected' ||
    s === 'running' ||
    s === 'healthy' ||
    s === 'clean' ||
    s === 'success'
  )
    return 'success';
  if (s === 'info') return 'info';
  if (s === 'warn' || s === 'warning' || s === 'degraded') return 'warning';
  if (s === 'fail' || s === 'error' || s === 'unavailable' || s === 'down') return 'danger';
  return 'slate';
}
