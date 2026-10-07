import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Github, Info, MessageSquare, Network, Settings, ShieldAlert, ShoppingCart, TerminalSquare, Workflow } from 'lucide-react';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { SectionHeader } from '../components/ui/SectionHeader';
import { LoadingState, ErrorState } from '../components/ui/States';
import { MetricTile } from '../components/ui/MetricTile';
import { adminGet } from '../lib/api';
import type { Connections } from '../lib/connections';
import { terminalRequest, type TerminalStatus } from '../lib/terminal';

interface OverviewResp {
  attention: {
    acknowledged: boolean; message: string;
    items: Array<{ severity: 'info' | 'warning' | 'danger'; label: string }>;
  };
}
interface SystemResp {
  app: string; name: string; version: string; forgeRoot: string;
  startedAt: string; uptimeSeconds: number;
  authority: { mayDeploy: boolean; mayTagRelease: boolean; mayModifyProductionData: boolean };
}

export function DashboardPage() {
  const overview = useQuery({ queryKey: ['overview'], queryFn: () => adminGet<OverviewResp>('/overview') });
  const system = useQuery({ queryKey: ['system'], queryFn: () => adminGet<SystemResp>('/system') });
  const connections = useQuery({ queryKey: ['connections'], queryFn: () => adminGet<Connections>('/connections') });
  const terminal = useQuery({ queryKey: ['admin', 'terminal', 'status'], queryFn: () => terminalRequest<TerminalStatus>('/status'), retry: false });

  if (overview.isLoading || system.isLoading) return <LoadingState label="Loading dashboard" />;
  if (overview.isError) return <ErrorState error={overview.error} />;
  if (system.isError) return <ErrorState error={system.error} />;
  const o = overview.data!;
  const s = system.data!;
  const c = connections.data;

  return <div className="space-y-5">
    <SectionHeader title="W3 Forge Workspace" subtitle="Engineering tools and the foundation for your business automations."
      actions={<Link className="btn" to="/settings"><Settings size={14} /> Connections</Link>} />
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <MetricTile label="Active App" value={s.app} />
      <MetricTile label="App Version" value={s.version} />
      <MetricTile label="Uptime (s)" value={String(s.uptimeSeconds)} />
      <MetricTile label="Deploy Authority" value={s.authority.mayDeploy ? 'yes' : 'no'} />
    </div>
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <Card><CardHeader title={<span className="flex items-center gap-2"><Github size={16} /> GitHub</span>} /><CardBody className="space-y-3">
        <p className="text-sm text-[var(--w3-text-muted)]">Review your repository, check its connection, and validate the current development branch.</p>
        <Link className="btn btn-primary" to="/github">Open GitHub Validation</Link>
      </CardBody></Card>
      <Card><CardHeader title={<span className="flex items-center gap-2"><TerminalSquare size={16} /> Terminal</span>}
        right={<Badge tone={terminal.data?.available ? 'success' : 'slate'}>{terminal.isPending ? 'Checking' : terminal.data?.available ? 'Available' : 'Unavailable'}</Badge>} /><CardBody className="space-y-3">
        <p className="text-sm text-[var(--w3-text-muted)]">{terminal.data?.message || (terminal.error instanceof Error ? terminal.error.message : 'Checking access to the Forge host terminal.')}</p>
        <Link className="btn" to="/terminal">Open Terminal</Link>
      </CardBody></Card>
      <Card><CardHeader title={<span className="flex items-center gap-2"><Workflow size={16} /> Admin Controls</span>} /><CardBody className="space-y-3">
        <p className="text-sm text-[var(--w3-text-muted)]">Run registered engineering checks, browse files, and inspect system health and logs.</p>
        <div className="flex flex-wrap gap-2"><Link className="btn" to="/controls">Open Controls</Link><Link className="btn" to="/system">System Status</Link></div>
      </CardBody></Card>
    </div>
    <Card><CardHeader title="Application modules" /><CardBody><p className="mb-4 text-xs text-[var(--w3-text-muted)]">Connection settings are configuration only; they do not confirm service health.</p>
      {connections.isPending ? <LoadingState label="Loading connection settings…" /> : connections.isError ? <ErrorState title="Could not load connection settings" error={connections.error} /> : c ? <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Module title="Lowe's material pricing" icon={<ShoppingCart size={16} />} state={!c.materialPricing.enabled ? 'Disabled' : c.materialPricing.configured ? 'Configured' : 'Needs setup'}>
          Existing material-pricing service. The Forge item-cost interface is planned.
        </Module>
        <Module title="Forge Chat" icon={<MessageSquare size={16} />} state="Planned">
          Your own chat window is the next application layer. Chat model selection and conversation workflows are planned.
        </Module>
        <Module title="n8n automation interface" icon={<Network size={16} />} state="Planned">
          {c.n8n.configured && c.n8n.url ? <><a href={c.n8n.url} target="_blank" rel="noreferrer" className="text-[var(--w3-gold-400)] underline">Open configured n8n instance</a>. The Forge workflow interface is planned.</> : 'Connect an n8n instance in host settings before building the Forge workflow interface.'}
        </Module>
        <Module title="Business automations" icon={<Workflow size={16} />} state="Planned">
          Additional business workflows will build on these admin and connection foundations.
        </Module>
      </div> : null}
    </CardBody></Card>
    <Card><CardBody>
      <div className="flex items-center gap-2 text-sm font-semibold"><ShieldAlert size={14} /> Attention</div>
      <p className="mt-1 text-xs text-[var(--w3-text-muted)]">{o.attention.message}</p>
      <ul className="mt-3 space-y-1.5">{o.attention.items.map((item, i) => <li key={i} className="flex items-start gap-2 text-xs text-[var(--w3-text-muted)]"><Info size={12} className="mt-0.5 shrink-0" /><span>{item.label}</span></li>)}</ul>
    </CardBody></Card>
  </div>;
}

function Module({ title, icon, state, children }: { title: string; icon: React.ReactNode; state: string; children: React.ReactNode }) {
  return <div className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="flex items-center gap-2 text-sm font-medium">{icon}{title}</h3><Badge tone={state === 'Configured' ? 'info' : state === 'Needs setup' ? 'warning' : 'slate'}>{state}</Badge></div><p className="text-xs text-[var(--w3-text-muted)]">{children}</p></div>;
}
