import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ReactNode } from 'react';
import { Cpu, GitBranch, Lock, Network, RefreshCw, ShieldCheck, TerminalSquare } from 'lucide-react';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { SectionHeader } from '../components/ui/SectionHeader';
import { LoadingState, ErrorState } from '../components/ui/States';
import { adminGet } from '../lib/api';
import type { Connections } from '../lib/connections';
import { terminalRequest, type TerminalStatus } from '../lib/terminal';

interface SystemResp {
  app: string; name: string; version: string; forgeRoot: string; host: string;
  platform: string; nodeVersion: string;
  authority: { mayDeploy: boolean; mayTagRelease: boolean; mayModifyProductionData: boolean };
}

export function SettingsPage() {
  const system = useQuery({ queryKey: ['system'], queryFn: () => adminGet<SystemResp>('/system') });
  const connections = useQuery({ queryKey: ['connections'], queryFn: () => adminGet<Connections>('/connections') });
  const terminal = useQuery({ queryKey: ['admin', 'terminal', 'status'], queryFn: () => terminalRequest<TerminalStatus>('/status'), retry: false });
  const terminalData = terminal.isError ? undefined : terminal.data;
  if (system.isPending || connections.isPending) return <LoadingState label="Loading settings…" />;
  if (system.isError) return <ErrorState title="Failed to load settings" error={system.error} />;
  if (connections.isError) return <ErrorState title="Failed to load connections" error={connections.error} />;
  const s = system.data!;
  const c = connections.data!;
  return <div className="space-y-4">
    <SectionHeader title="Settings" subtitle="Configured services and operating boundaries for this Forge installation."
      actions={<button type="button" className="btn" disabled={system.isFetching || connections.isFetching || terminal.isFetching} onClick={() => { void system.refetch(); void connections.refetch(); void terminal.refetch(); }}><RefreshCw size={14} /> Refresh</button>} />
    <Card><CardBody className="text-sm text-[var(--w3-text-muted)]">These settings are read-only. Connection configuration is managed on the Forge host; app approval and user assignments are managed in W3 Core. Configured means settings are present, not that a service is reachable.</CardBody></Card>
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      <SettingCard title="W3 Core access" icon={<ShieldCheck size={14} />} state={c.core.configured ? 'Configured' : 'Needs setup'} tone={c.core.configured ? 'info' : 'warning'}>
        <p>Core-owned sign-in and the Forge admin role protect this console.</p>
        {c.core.publicUrl ? <ExternalConnection href={c.core.publicUrl} label="Open W3 Core" /> : null}
      </SettingCard>
      <SettingCard title="GitHub repository" icon={<GitBranch size={14} />} state={c.github.repositoryUrl ? 'Configured' : 'Needs setup'} tone={c.github.repositoryUrl ? 'info' : 'warning'}>
        {c.github.repositoryUrl ? <ExternalConnection href={c.github.repositoryUrl} label={c.github.repositoryUrl} /> : <p>No repository URL configured.</p>}
        <p className="break-all">Workspace: <code>{c.github.workspace}</code></p><p>Development branch: <code>{c.github.defaultDevBranch}</code></p>
        <Link className="text-[var(--w3-gold-400)] underline" to="/github">Check repository connection</Link>
      </SettingCard>
      <SettingCard title="Terminal access" icon={<TerminalSquare size={14} />} state={terminal.isPending ? 'Checking' : terminalData?.available ? 'Available' : 'Unavailable'} tone={terminalData?.available ? 'success' : 'warning'}>
        <p>{terminalData?.message || (terminal.error instanceof Error ? terminal.error.message : 'Checking host terminal availability.')}</p>
        <p>Host setting: {c.terminal.enabled ? 'enabled' : 'disabled'}. Terminal commands affect the Forge host.</p>
        <Link className="text-[var(--w3-gold-400)] underline" to="/terminal">Open Terminal</Link>
      </SettingCard>
      <SettingCard title="Lowe's material pricing" icon={<Network size={14} />} state={!c.materialPricing.enabled ? 'Disabled' : c.materialPricing.configured ? 'Configured' : 'Needs setup'} tone={c.materialPricing.enabled && c.materialPricing.configured ? 'info' : 'slate'}>
        <p>Existing pricing service for future Forge item-cost workflows.</p>
        <p>Up to {c.materialPricing.maxProducts} products per request.</p>
        <p>Charge limits: {money(c.materialPricing.maxRequestChargeCents)} per request / {money(c.materialPricing.maxDailyChargeCents)} per day.</p>
      </SettingCard>
      <SettingCard title="Material matcher / Ollama" icon={<Cpu size={14} />} state={c.ollama.configured ? 'Configured' : 'Needs setup'} tone={c.ollama.configured ? 'info' : 'slate'}>
        <p>Model: <code>{c.ollama.model || 'Not configured'}</code></p><p>Configured model for matching material-pricing results. Forge Chat is planned separately.</p>
      </SettingCard>
      <SettingCard title="n8n" icon={<Network size={14} />} state={c.n8n.configured ? 'Link configured' : 'Needs setup'} tone={c.n8n.configured ? 'info' : 'slate'}>
        {c.n8n.url ? <ExternalConnection href={c.n8n.url} label="Open n8n" /> : <p>No n8n instance link configured.</p>}
        <p>The Forge automation interface is planned. An instance link does not establish API access.</p>
      </SettingCard>
    </div>
    <Card><CardHeader title="Operating boundaries" /><CardBody className="grid grid-cols-1 gap-4 text-xs text-[var(--w3-text-muted)] md:grid-cols-2">
      <div className="space-y-2"><h3 className="flex items-center gap-2 text-sm font-medium text-[var(--w3-text)]"><Lock size={14} /> Registered controls</h3><p>Registered controls use Forge's safe runner and their declared permissions. Terminal sessions provide separate interactive host access and can change host files.</p></div>
      <div className="space-y-2"><h3 className="flex items-center gap-2 text-sm font-medium text-[var(--w3-text)]"><ShieldCheck size={14} /> Release authority</h3><p>Production release approval remains with the owner. Forge's registered app authority: deploy {s.authority.mayDeploy ? 'enabled' : 'disabled'}, release tagging {s.authority.mayTagRelease ? 'enabled' : 'disabled'}, production data writes {s.authority.mayModifyProductionData ? 'enabled' : 'disabled'}.</p></div>
    </CardBody></Card>
    <Card><CardBody className="space-y-1 text-xs text-[var(--w3-text-muted)]">
      <p>App: <code>{s.app}</code> · v{s.version}</p><p className="break-all">Forge root: <code>{s.forgeRoot}</code></p><p>Host: <code>{s.host}</code> · {s.platform} · Node {s.nodeVersion}</p>
    </CardBody></Card>
  </div>;
}
function money(cents: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100); }
function ExternalConnection({ href, label }: { href: string; label: string }) {
  return <a className="block break-all text-[var(--w3-gold-400)] underline" href={href} target="_blank" rel="noreferrer">{label}</a>;
}
function SettingCard({ title, icon, state, tone, children }: { title: string; icon: ReactNode; state: string; tone: BadgeTone; children: ReactNode }) {
  return <Card><CardHeader title={<span className="flex items-center gap-2">{icon}{title}</span>} right={<Badge tone={tone}>{state}</Badge>} /><CardBody className="space-y-2 text-xs text-[var(--w3-text-muted)]">{children}</CardBody></Card>;
}
