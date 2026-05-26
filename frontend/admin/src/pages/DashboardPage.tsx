import { useQuery } from '@tanstack/react-query';
import { ShieldAlert, Info } from 'lucide-react';
import { Card } from '../components/ui/Card';
import { SectionHeader } from '../components/ui/SectionHeader';
import { LoadingState, ErrorState } from '../components/ui/States';
import { MetricTile } from '../components/ui/MetricTile';
import { adminGet } from '../lib/api';

interface OverviewResp {
  attention: {
    acknowledged: boolean;
    message: string;
    items: Array<{ severity: 'info' | 'warning' | 'danger'; label: string }>;
  };
}
interface SystemResp {
  app: string;
  name: string;
  version: string;
  forgeRoot: string;
  startedAt: string;
  uptimeSeconds: number;
  authority: {
    mayDeploy: boolean;
    mayTagRelease: boolean;
    mayModifyProductionData: boolean;
  };
}

export function DashboardPage() {
  const overview = useQuery({
    queryKey: ['overview'],
    queryFn: () => adminGet<OverviewResp>('/overview')
  });
  const system = useQuery({
    queryKey: ['system'],
    queryFn: () => adminGet<SystemResp>('/system')
  });

  if (overview.isLoading || system.isLoading) return <LoadingState label="Loading dashboard" />;
  if (overview.isError) return <ErrorState error={overview.error} />;
  if (system.isError) return <ErrorState error={system.error} />;

  const o = overview.data!;
  const s = system.data!;

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Forge Foundation"
        subtitle="W3 Core remains deployment and release authority."
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile label="Active App" value={s.app} />
        <MetricTile label="App Version" value={s.version} />
        <MetricTile label="Uptime (s)" value={String(s.uptimeSeconds)} />
        <MetricTile label="Deploy Authority" value={s.authority.mayDeploy ? 'yes' : 'no'} />
      </div>

      <Card>
        <div className="p-4">
          <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--w3-text)' }}>
            <ShieldAlert size={14} />
            Attention
          </div>
          <p className="mt-1 text-xs" style={{ color: 'var(--w3-text-muted)' }}>
            {o.attention.message}
          </p>
          <ul className="mt-3 space-y-1.5">
            {o.attention.items.map((it, i) => (
              <li key={i} className="flex items-start gap-2 text-xs" style={{ color: 'var(--w3-text-muted)' }}>
                <Info size={12} className="mt-0.5 shrink-0" />
                <span>{it.label}</span>
              </li>
            ))}
          </ul>
        </div>
      </Card>
    </div>
  );
}
