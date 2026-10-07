import { consoleText } from "../../../../shared/consoleApp";
import { useQuery } from '@tanstack/react-query';
import {
  Archive,
  FileText,
  FolderTree,
  Lock,
  PackageX,
  ShieldAlert,
  Upload
} from 'lucide-react';
import { ReactNode } from 'react';
import { Card, CardBody } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { SectionHeader } from '../components/ui/SectionHeader';
import { adminGet } from '../lib/api';
import { DASHBOARD_LAYOUT_STORAGE_KEY } from '../hooks/useDashboardLayout';

interface RootInfo {
  id: string;
  path: string;
  label: string;
  exists: boolean;
}
interface RootsResponse {
  roots: RootInfo[];
  forbidden: string[];
}

// v0.5.1 Settings: read-only policy cards. No edit affordance anywhere on
// this page — every card surfaces the current state without controls.
export function SettingsPage() {
  const rootsQ = useQuery({
    queryKey: ['admin', 'files', 'roots'],
    queryFn: () => adminGet<RootsResponse>('/files/roots')
  });

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Settings"
        subtitle="Operating policies for the Admin Console."
        actions={<Badge tone="success">Read Only</Badge>}
      />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        <PolicyCard
          icon={<ShieldAlert size={14} />}
          title="Internal Only"
          state={<Badge tone="warning">Internal Only</Badge>}
        >
          The Admin API and Console are gated behind an internal-only guard. Do not expose to
          the public internet until real auth and roles land.
        </PolicyCard>

        <PolicyCard
          icon={<Lock size={14} />}
          title="No Public Exposure"
          state={<Badge tone="danger">Do Not Publish</Badge>}
        >
          Caddy / Cloudflare must not proxy <code className="font-mono">/admin</code> or{' '}
          <code className="font-mono">/api/admin/*</code> to the open internet. Reverse-proxy
          rules are validated out-of-band.
        </PolicyCard>

        <PolicyCard
          icon={<Upload size={14} />}
          title="Uploads Disabled"
          state={<Badge tone="success">Disabled</Badge>}
        >
          No file upload endpoint is shipped. The backend has no{' '}
          <code className="font-mono">multer</code> dependency and no multipart handler.
        </PolicyCard>

        <PolicyCard
          icon={<PackageX size={14} />}
          title="Write Actions Disabled"
          state={<Badge tone="success">Read Only</Badge>}
        >
          No deploy / apply / reset / purge / verify-package action is exposed from the UI.
          Every admin route is HTTP <Badge tone="info">GET</Badge>.
        </PolicyCard>

        <PolicyCard
          icon={<Archive size={14} />}
          title="Package Standard"
          state={<Badge tone="gold">Canonical</Badge>}
        >
          <code className="font-mono text-[var(--w3-text)]">{consoleText("w3buildcost-vX")}.Y.Z.tar.gz</code>
          <div className="mt-1 text-[11px] text-[var(--w3-text-muted)]">
            Non-conforming files are listed but flagged. deploy-{consoleText("w3buildcost")}.sh still consumes the
            newest tarball in <code className="font-mono">{consoleText("/opt/w3buildcost-update-packages/")}</code>.
          </div>
        </PolicyCard>

        <PolicyCard
          icon={<FolderTree size={14} />}
          title="Allowed File Roots"
          state={
            <Badge tone="slate">
              {rootsQ.data?.roots.length ?? '…'} Root
              {rootsQ.data?.roots.length === 1 ? '' : 's'}
            </Badge>
          }
        >
          {rootsQ.data?.roots.length ? (
            <ul className="space-y-0.5 font-mono text-[11px]">
              {rootsQ.data.roots.map((r) => (
                <li key={r.id} className="flex items-center gap-1">
                  <span className="text-[var(--w3-text-muted)]">{r.label}:</span>
                  <span className="text-[var(--w3-text)]">{r.path}</span>
                  {!r.exists ? <Badge tone="warning">Missing</Badge> : null}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-[var(--w3-text-muted)]">Loading Allowlist…</span>
          )}
        </PolicyCard>

        <PolicyCard
          icon={<FileText size={14} />}
          title="Backup Policy"
          state={<Badge tone="purple">App + DB Pairs</Badge>}
        >
          Backups are taken nightly to <code className="font-mono">{consoleText("/opt/w3buildcost-backups")}</code> as
          paired app + database archives. Pre-v0.5.0 backups are surfaced as{' '}
          <Badge tone="warning">Legacy Candidate</Badge> for off-line cleanup via{' '}
          <code className="font-mono">cleanup-legacy-{consoleText("w3buildcost")}.sh</code>.
        </PolicyCard>
      </div>

      <Card>
        <CardBody className="text-xs text-[var(--w3-text-muted)]">
          Dashboard layout (widget order + visibility) is stored in this browser's{' '}
          <code className="font-mono">localStorage</code> under{' '}
          <code className="font-mono">{DASHBOARD_LAYOUT_STORAGE_KEY}</code>. Layouts are not
          shared across browsers or devices. Database-backed layouts ship later in the v0.5.x
          line.
        </CardBody>
      </Card>
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
