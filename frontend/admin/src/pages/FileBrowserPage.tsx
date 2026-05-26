import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Folder, FileText, ChevronRight } from 'lucide-react';
import { Card } from '../components/ui/Card';
import { SectionHeader } from '../components/ui/SectionHeader';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/States';
import { adminGet } from '../lib/api';

interface FilesResp {
  forgeRoot: string;
  path: string;
  entries: Array<{ name: string; type: 'file' | 'dir'; size: number; modifiedMs: number }>;
}

export function FileBrowserPage() {
  const [cwd, setCwd] = useState<string>('.');
  const q = useQuery({
    queryKey: ['files', cwd],
    queryFn: () => adminGet<FilesResp>(`/files?path=${encodeURIComponent(cwd)}`)
  });

  const breadcrumbs = useMemo(() => {
    if (cwd === '.' || cwd === '') return [{ label: 'root', target: '.' }];
    const parts = cwd.split('/').filter(Boolean);
    const out: { label: string; target: string }[] = [{ label: 'root', target: '.' }];
    let acc = '';
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      out.push({ label: p, target: acc });
    }
    return out;
  }, [cwd]);

  if (q.isLoading) return <LoadingState label="Loading files" />;
  if (q.isError) return <ErrorState error={q.error} />;
  const data = q.data!;
  return (
    <div className="space-y-5">
      <SectionHeader title="File Browser" subtitle={`Read-only · ${data.forgeRoot}`} />

      <div className="flex flex-wrap items-center gap-1 text-xs">
        {breadcrumbs.map((b, i) => (
          <span key={b.target} className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setCwd(b.target)}
              className="btn-ghost btn !py-0.5 !px-1.5"
            >
              {b.label}
            </button>
            {i < breadcrumbs.length - 1 ? <ChevronRight size={12} /> : null}
          </span>
        ))}
      </div>

      {data.entries.length === 0 ? (
        <EmptyState>Empty directory.</EmptyState>
      ) : (
        <Card>
          <ul className="divide-y" style={{ borderColor: 'var(--w3-border)' }}>
            {data.entries.map((e) => (
              <li key={e.name} className="flex items-center gap-2 px-3 py-2 text-sm">
                {e.type === 'dir' ? <Folder size={14} /> : <FileText size={14} />}
                {e.type === 'dir' ? (
                  <button
                    type="button"
                    className="btn-ghost btn !py-0.5 !px-1.5"
                    onClick={() => setCwd(data.path === '.' ? e.name : `${data.path}/${e.name}`)}
                  >
                    {e.name}/
                  </button>
                ) : (
                  <span style={{ color: 'var(--w3-text)' }}>{e.name}</span>
                )}
                <span className="ml-auto text-xs" style={{ color: 'var(--w3-text-muted)' }}>
                  {e.type === 'file' ? `${e.size} bytes` : ''}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
