import { useQuery } from '@tanstack/react-query';
import {
  Lock,
  ShieldAlert,
  ShieldCheck,
  GitBranch,
  PackageX,
  FileCheck,
  Network,
  Cpu
} from 'lucide-react';
import { ReactNode } from 'react';
import { Card, CardBody } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { SectionHeader } from '../components/ui/SectionHeader';
import { LoadingState, ErrorState } from '../components/ui/States';
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

// v0.4.0 Settings: read-only view of W3 Forge operating policies and
// authority boundaries. No edit affordance anywhere — every card surfaces
// the current state. W3 Core remains the deployment & release authority.
export function SettingsPage() {
  const sysQ = useQuery({
    queryKey: ['system'],
    queryFn: () => adminGet<SystemResp>('/system')
  });

  if (sysQ.isLoading) return <LoadingState label="Loading settings…" />;
  if (sysQ.isError)
    return <ErrorState title="Failed to load settings" error={sysQ.error as Error} />;

  const sys = sysQ.data;

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Settings"
        subtitle="W3 Forge operating policies and authority boundaries."
        actions={<Badge tone="success">Read Only</Badge>}
      />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        <PolicyCard
          icon={<ShieldCheck size={14} />}
          title="W3 Forge Authority"
          state={<Badge tone="info">Foundation</Badge>}
        >
          W3 Forge proposes and validates changes only. It does not deploy, tag releases,
          or modify production data. <strong>W3 Core remains the deployment authority.</strong>
        </PolicyCard>

        <PolicyCard
          icon={<PackageX size={14} />}
          title="Deploy Disabled"
          state={
            <Badge tone={sys?.authority.mayDeploy ? 'danger' : 'success'}>
              {sys?.authority.mayDeploy ? 'Enabled' : 'Disabled'}
            </Badge>
          }
        >
          No deploy endpoint or control is exposed. The Forge backend ships zero deploy,
          publish, or apply actions.
        </PolicyCard>

        <PolicyCard
          icon={<FileCheck size={14} />}
          title="Release Tags Disabled"
          state={
            <Badge tone={sys?.authority.mayTagRelease ? 'danger' : 'success'}>
              {sys?.authority.mayTagRelease ? 'Enabled' : 'Disabled'}
            </Badge>
          }
        >
          The Admin Console cannot create release tags. All production release tagging is
          performed by W3 Core out-of-band.
        </PolicyCard>

        <PolicyCard
          icon={<ShieldAlert size={14} />}
          title="Production Data"
          state={
            <Badge tone={sys?.authority.mayModifyProductionData ? 'danger' : 'success'}>
              {sys?.authority.mayModifyProductionData ? 'Mutable' : 'Untouched'}
            </Badge>
          }
        >
          The Forge admin layer has no write path to persistent production data. Every
          admin control runs read-only (<code className="font-mono">readOnly: true</code>,{' '}
          <code className="font-mono">riskLevel: LOW</code>).
        </PolicyCard>

        <PolicyCard
          icon={<GitBranch size={14} />}
          title="Branch Policy"
          state={<Badge tone="gold">dev/v*</Badge>}
        >
          All Forge work occurs on <code className="font-mono">dev/vX.Y.Z</code> branches.
          The launcher refuses to start on <code className="font-mono">main</code> or{' '}
          <code className="font-mono">master</code>, and Git routes return{' '}
          <Badge tone="danger">PROTECTED_BRANCH</Badge> for protected refs.
        </PolicyCard>

        <PolicyCard
          icon={<Lock size={14} />}
          title="Loopback Only"
          state={<Badge tone="warning">127.0.0.1</Badge>}
        >
          The Admin API binds to <code className="font-mono">127.0.0.1</code> by default.
          A guard rejects non-loopback / non-LAN / non-Tailscale clients with{' '}
          <Badge tone="danger">FORBIDDEN_REMOTE</Badge>.
        </PolicyCard>

        <PolicyCard
          icon={<Network size={14} />}
          title="No Public Exposure"
          state={<Badge tone="danger">Do Not Publish</Badge>}
        >
          Caddy / Cloudflare must not proxy <code className="font-mono">/admin</code> or{' '}
          <code className="font-mono">/api/admin/*</code> to the open internet. Reverse-proxy
          rules are validated out-of-band.
        </PolicyCard>

        <PolicyCard
          icon={<Cpu size={14} />}
          title="Safe Runner"
          state={<Badge tone="teal">shell: false</Badge>}
        >
          Controls run via array-form <code className="font-mono">spawn</code> with a fixed
          env allowlist (PATH, HOME, LANG, W3_FORGE_ROOT). No{' '}
          <code className="font-mono">exec</code>, no shell, no body-driven args.
        </PolicyCard>
      </div>

      {sys ? (
        <Card>
          <CardBody className="space-y-1 text-xs text-[var(--w3-text-muted)]">
            <div>
              <span className="text-[var(--w3-text)]">App:</span>{' '}
              <code className="font-mono">{sys.app}</code> · v
              <code className="font-mono">{sys.version}</code>
            </div>
            <div>
              <span className="text-[var(--w3-text)]">Forge root:</span>{' '}
              <code className="font-mono">{sys.forgeRoot}</code>
            </div>
            <div>
              <span className="text-[var(--w3-text)]">Host:</span>{' '}
              <code className="font-mono">{sys.host}</code> ·{' '}
              <code className="font-mono">{sys.platform}</code> · Node{' '}
              <code className="font-mono">{sys.nodeVersion}</code>
            </div>
            <div className="pt-1">
              Settings are sourced from <code className="font-mono">config/apps/&lt;app_id&gt;.yml</code>{' '}
              and surfaced read-only here. To change a policy, edit the YAML on a{' '}
              <code className="font-mono">dev/v*</code> branch and re-run config validation.
            </div>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

function PolicyCard({
  icon,
  title,
  state,
  children
}: {
  icon: ReactNode;
  title: string;
  state: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardBody className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-[var(--w3-text)]">
            <span style={{ color: 'var(--w3-gold-400)' }}>{icon}</span>
            <span>{title}</span>
          </div>
          {state}
        </div>
        <div className="text-xs text-[var(--w3-text-muted)]">{children}</div>
      </CardBody>
    </Card>
  );
}
