import { useQuery } from '@tanstack/react-query';
import { Card } from '../components/ui/Card';
import { SectionHeader } from '../components/ui/SectionHeader';
import { LoadingState, ErrorState } from '../components/ui/States';
import { MetricTile } from '../components/ui/MetricTile';
import { Badge } from '../components/ui/Badge';
import { adminGet } from '../lib/api';

interface SystemResp {
  app: string;
  name: string;
  version: string;
  forgeRoot: string;
  startedAt: string;
  uptimeSeconds: number;
  host: string;
  platform: string;
  nodeVersion: string;
  authority: {
    mayDeploy: boolean;
    mayTagRelease: boolean;
    mayModifyProductionData: boolean;
  };
  readOnlyFoundation: boolean;
}

export function SystemStatusPage() {
  const q = useQuery({
    queryKey: ['system'],
    queryFn: () => adminGet<SystemResp>('/system'),
    refetchInterval: 30_000
  });
  if (q.isLoading) return <LoadingState label="Loading system status" />;
  if (q.isError) return <ErrorState error={q.error} />;
  const s = q.data!;
  return (
    <div className="space-y-5">
      <SectionHeader title="System Status" subtitle={`Forge root: ${s.forgeRoot}`} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile label="App" value={s.app} hint={s.name} />
        <MetricTile label="Version" value={s.version} />
        <MetricTile label="Uptime (s)" value={String(s.uptimeSeconds)} />
        <MetricTile label="Host" value={s.host} hint={s.platform} />
      </div>
      <Card>
        <div className="p-4 space-y-3 text-sm" style={{ color: 'var(--w3-text)' }}>
          <div className="font-semibold">Authority</div>
          <div className="flex flex-wrap gap-2">
            <Badge tone={s.authority.mayDeploy ? 'danger' : 'success'}>
              may_deploy: {String(s.authority.mayDeploy)}
            </Badge>
            <Badge tone={s.authority.mayTagRelease ? 'danger' : 'success'}>
              may_tag_release: {String(s.authority.mayTagRelease)}
            </Badge>
            <Badge tone={s.authority.mayModifyProductionData ? 'danger' : 'success'}>
              may_modify_production_data: {String(s.authority.mayModifyProductionData)}
            </Badge>
          </div>
          <div className="text-xs" style={{ color: 'var(--w3-text-muted)' }}>
            W3 Core remains deployment and release authority.
          </div>
        </div>
      </Card>
      <Card>
        <div className="p-4 space-y-1 text-xs" style={{ color: 'var(--w3-text-muted)' }}>
          <div>Node: {s.nodeVersion}</div>
          <div>Started at: {s.startedAt}</div>
          <div>Read-only foundation: {String(s.readOnlyFoundation)}</div>
        </div>
      </Card>
    </div>
  );
}
