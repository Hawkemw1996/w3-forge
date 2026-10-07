import { ReactNode } from 'react';
import { cn } from '../lib/cn';

// =============================================================================
// W3 BuildCost — W3Card (v0.10.7, W3 UI System Foundation)
// =============================================================================
//
// Canonical card/tile shell promoted from the Admin Operations Console.
// Renders the `.card`, `.card-header`, `.card-title`, `.card-body`,
// `.card-footer` classes defined in frontend/shared/styles/primitives.css.
//
// Rules going forward:
//   - Do not duplicate `.card*` styling in app CSS; this is the shared source.

export function W3Card({
  children,
  className,
  hover
}: {
  children: ReactNode;
  className?: string;
  hover?: boolean;
}) {
  return (
    <section className={cn('card', hover && 'card-hover', className)}>
      {children}
    </section>
  );
}

export function W3CardHeader({
  title,
  subtitle,
  right
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header className="card-header">
      <div className="min-w-0">
        <div className="card-title">{title}</div>
        {subtitle ? (
          <div
            className="mt-0.5 text-sm"
            style={{ color: 'var(--w3-text-muted)' }}
          >
            {subtitle}
          </div>
        ) : null}
      </div>
      {right ? <div>{right}</div> : null}
    </header>
  );
}

export function W3CardBody({
  children,
  className
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn('card-body', className)}>{children}</div>;
}

export function W3CardFooter({
  children,
  className
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn('card-footer', className)}>{children}</div>;
}
