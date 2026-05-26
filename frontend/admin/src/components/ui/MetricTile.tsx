import { ReactNode } from 'react';
import { cn } from '../../lib/utils';

// Single metric tile: label on top, large value, optional delta/status footer.

export function MetricTile({
  label,
  value,
  hint,
  right,
  className
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('rounded-md border border-[var(--w3-border)] bg-[var(--w3-card)] p-3', className)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="stat-label">{label}</div>
          <div className="stat-value mt-1 truncate">{value}</div>
          {hint ? (
            <div className="mt-0.5 text-[11px] text-[var(--w3-text-dim)] truncate">{hint}</div>
          ) : null}
        </div>
        {right ? <div className="shrink-0">{right}</div> : null}
      </div>
    </div>
  );
}
