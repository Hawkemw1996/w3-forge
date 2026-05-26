import { ReactNode } from 'react';
import { AlertCircle, Inbox, Loader2 } from 'lucide-react';

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-[var(--w3-text-muted)]">
      <Loader2 size={14} className="animate-spin" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ error, title = 'Failed to load' }: { error: unknown; title?: string }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div
      className="flex items-start gap-2 rounded-md border p-3 text-sm"
      style={{
        background: 'var(--status-danger-bg)',
        borderColor: 'rgba(239,68,68,0.4)',
        color: 'var(--status-danger)'
      }}
    >
      <AlertCircle size={14} className="mt-0.5 shrink-0" />
      <div>
        <div className="font-medium">{title}</div>
        <div className="mt-0.5 text-xs opacity-90 break-all">{message}</div>
      </div>
    </div>
  );
}

export function EmptyState({
  children,
  icon
}: {
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-dashed p-4 text-sm text-[var(--w3-text-muted)]"
      style={{ borderColor: 'var(--w3-border)' }}
    >
      <span className="text-[var(--w3-text-dim)]">{icon ?? <Inbox size={14} />}</span>
      <span>{children}</span>
    </div>
  );
}
