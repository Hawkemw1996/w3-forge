import { ReactNode } from 'react';
import { cn } from '../../lib/utils';

// Card primitives — wired to the v0.5.1 dark tokens via .card / .card-header /
// .card-body in styles.css. Set hover to enable the lift-to-card-hover variant.

export function Card({
  className,
  children,
  hover = false
}: {
  className?: string;
  children: ReactNode;
  hover?: boolean;
}) {
  return (
    <div className={cn('card', hover && 'card-hover', className)}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  right
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="card-header">
      <div className="min-w-0">
        <div className="card-title truncate">{title}</div>
        {subtitle ? (
          <div className="mt-0.5 text-xs text-[var(--w3-text-muted)] truncate">{subtitle}</div>
        ) : null}
      </div>
      {right ? <div className="flex shrink-0 items-center gap-2">{right}</div> : null}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('card-body', className)}>{children}</div>;
}

export function CardFooter({
  className,
  children
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn('card-footer', className)}>{children}</div>;
}
