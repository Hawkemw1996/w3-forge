import { ReactNode } from 'react';
import { cn } from '../lib/cn';

// =============================================================================
// W3 BuildCost — W3Table (v0.10.7, W3 UI System Foundation)
// =============================================================================
//
// Canonical dark data-table primitive promoted from the Admin Operations
// Console. Renders the `.table-dark` class defined in
// frontend/shared/styles/primitives.css.
//
// Rules going forward:
//   - Do not duplicate `.table-dark` styling in app CSS; this is the shared
//     source.

export function W3Table({
  children,
  className
}: {
  children: ReactNode;
  className?: string;
}) {
  return <table className={cn('table-dark', className)}>{children}</table>;
}
