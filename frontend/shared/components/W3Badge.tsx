import { ReactNode } from 'react';
import { cn } from '../lib/cn';

// =============================================================================
// W3 BuildCost — W3Badge (v0.10.7, W3 UI System Foundation)
// =============================================================================
//
// Canonical badge/pill primitive promoted from the Admin Operations Console.
// Renders the `.badge` + `.badge-<tone>` classes defined in
// frontend/shared/styles/primitives.css. Both consoles consume this component
// so badge styling never drifts between surfaces.
//
// Rules going forward:
//   - Do not duplicate `.badge*` styling in app CSS; this is the shared source.

export type W3BadgeTone =
  | 'success'
  | 'info'
  | 'warning'
  | 'danger'
  | 'purple'
  | 'teal'
  | 'gold'
  | 'slate';

const TONE_CLASS: Record<W3BadgeTone, string> = {
  success: 'badge-success',
  info: 'badge-info',
  warning: 'badge-warning',
  danger: 'badge-danger',
  purple: 'badge-purple',
  teal: 'badge-teal',
  gold: 'badge-gold',
  slate: 'badge-slate'
};

export function W3Badge({
  tone = 'slate',
  children,
  className
}: {
  tone?: W3BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn('badge', TONE_CLASS[tone], className)}>{children}</span>
  );
}
