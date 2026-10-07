import { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

// =============================================================================
// W3 BuildCost — W3Button (v0.10.7, W3 UI System Foundation)
// =============================================================================
//
// Canonical button primitive promoted from the Admin Operations Console.
// Renders the `.btn` / `.btn-primary` / `.btn-ghost` classes defined in
// frontend/shared/styles/primitives.css.
//
// Rules going forward:
//   - Do not duplicate `.btn*` styling in app CSS; this is the shared source.

export type W3ButtonVariant = 'default' | 'primary' | 'ghost';

const VARIANT_CLASS: Record<W3ButtonVariant, string | undefined> = {
  default: undefined,
  primary: 'btn-primary',
  ghost: 'btn-ghost'
};

export function W3Button({
  variant = 'default',
  className,
  children,
  ...rest
}: {
  variant?: W3ButtonVariant;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={cn('btn', VARIANT_CLASS[variant], className)} {...rest}>
      {children}
    </button>
  );
}
