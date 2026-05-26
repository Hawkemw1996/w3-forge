import { ReactNode } from 'react';
import { cn } from '../../lib/utils';

// Page/section header: title + optional subtitle + optional action slot.

export function SectionHeader({
  title,
  subtitle,
  actions,
  className
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-3', className)}>
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-[var(--w3-text)] truncate">{title}</h2>
        {subtitle ? (
          <p className="mt-0.5 text-xs text-[var(--w3-text-muted)]">{subtitle}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
