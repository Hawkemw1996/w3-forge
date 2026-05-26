import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card } from '../components/ui/Card';
import { SectionHeader } from '../components/ui/SectionHeader';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/States';
import { adminGet } from '../lib/api';

interface LogsListResp {
  root: string;
  files: string[];
}
interface LogTailResp {
  file: string;
  size: number;
  bytesReturned: number;
  content: string;
}

export function LogsPage() {
  const [selected, setSelected] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['logs'],
    queryFn: () => adminGet<LogsListResp>('/logs')
  });

  const tail = useQuery({
    queryKey: ['logs', 'tail', selected],
    enabled: !!selected,
    queryFn: () => adminGet<LogTailResp>(`/logs/tail?file=${encodeURIComponent(selected!)}`)
  });

  if (list.isLoading) return <LoadingState label="Listing logs" />;
  if (list.isError) return <ErrorState error={list.error} />;
  const files = list.data!.files;

  return (
    <div className="space-y-5">
      <SectionHeader title="Logs" subtitle={list.data!.root} />
      {files.length === 0 ? (
        <EmptyState>No log files yet under logs/.</EmptyState>
      ) : (
        <Card>
          <div className="p-3 grid grid-cols-1 gap-2 md:grid-cols-[260px_1fr]">
            <ul className="space-y-1 text-xs">
              {files.map((f) => (
                <li key={f}>
                  <button
                    type="button"
                    className="btn-ghost btn w-full justify-start truncate"
                    onClick={() => setSelected(f)}
                    style={selected === f ? { background: 'rgba(217,164,65,0.10)' } : {}}
                  >
                    {f}
                  </button>
                </li>
              ))}
            </ul>
            <div className="min-w-0">
              {selected ? (
                tail.isLoading ? (
                  <LoadingState label="Reading tail" />
                ) : tail.isError ? (
                  <ErrorState error={tail.error} />
                ) : (
                  <pre
                    className="rounded-md p-3 overflow-auto text-[11px] leading-relaxed"
                    style={{
                      background: 'var(--w3-surface)',
                      color: 'var(--w3-text)',
                      maxHeight: '60vh',
                      whiteSpace: 'pre-wrap'
                    }}
                  >
                    {tail.data?.content || '(empty)'}
                  </pre>
                )
              ) : (
                <div className="text-xs" style={{ color: 'var(--w3-text-muted)' }}>
                  Select a log file to tail (last 256 KB).
                </div>
              )}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
