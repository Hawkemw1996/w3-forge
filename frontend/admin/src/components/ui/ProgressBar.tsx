import { cn } from '../../lib/utils';

// Threshold-colored progress bar. Default thresholds: green <70%, amber 70-90%,
// red >=90%. Pass tone="info"|"gold" to override semantic coloring (e.g. for
// non-threshold uses like a fill indicator).

export type ProgressTone = 'auto' | 'success' | 'warning' | 'danger' | 'info' | 'gold';

function autoColor(percent: number): string {
  if (percent >= 90) return 'var(--status-danger)';
  if (percent >= 70) return 'var(--status-warning)';
  return 'var(--status-success)';
}

function toneColor(tone: Exclude<ProgressTone, 'auto'>): string {
  switch (tone) {
    case 'success':
      return 'var(--status-success)';
    case 'warning':
      return 'var(--status-warning)';
    case 'danger':
      return 'var(--status-danger)';
    case 'info':
      return 'var(--status-info)';
    case 'gold':
      return 'var(--w3-gold-500)';
  }
}

export function ProgressBar({
  value,
  max = 100,
  tone = 'auto',
  className,
  ariaLabel
}: {
  value: number | null | undefined;
  max?: number;
  tone?: ProgressTone;
  className?: string;
  ariaLabel?: string;
}) {
  const raw = value == null || !Number.isFinite(value) ? 0 : Number(value);
  const pct = Math.max(0, Math.min(100, max === 100 ? raw : (raw / max) * 100));
  const fill = tone === 'auto' ? autoColor(pct) : toneColor(tone);
  return (
    <div
      className={cn('progress-track', className)}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={ariaLabel}
    >
      <div
        className="progress-fill"
        style={{ width: `${pct}%`, background: fill }}
      />
    </div>
  );
}
