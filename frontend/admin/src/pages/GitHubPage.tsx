import { consoleApp, consoleText } from "../../../../shared/consoleApp";
import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  ExternalLink,
  FileText,
  GitBranch,
  GitCommit,
  GitCompare,
  Github,
  Loader2,
  Lock,
  RefreshCw,
  Rocket,
  ShieldAlert,
  Tag,
  X
} from 'lucide-react';
import { AdminListPage } from '../components/ui/AdminListPage';
import { Badge, statusTone } from '../components/ui/Badge';
import { StatusPill, StatusTone } from '../components/ui/StatusPill';
import { MetricTile } from '../components/ui/MetricTile';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States';
import { adminGet, adminPost, AdminApiError } from '../lib/api';
import { formatRelative, formatTimestamp } from '../lib/format';
import { ReleasePipelinePanel } from './github/ReleasePipelinePanel';
import { DeploySourcePanel } from './github/DeploySourcePanel';
import { UnifiedReleaseWorkflow } from './github/UnifiedReleaseWorkflow';
import { PipelineSharedStateProvider } from './github/pipelineContext';
import { PipelineStateSummary } from './github/PipelineStateSummary';
import { SafePreflightButton } from './github/SafePreflightButton';
import { PipelineReadinessChecklist } from './github/PipelineReadinessChecklist';
import { PipelineHelpPanel } from './github/PipelineHelpPanel';

// =============================================================================
// GitHub / Releases page (v0.5.5)
// =============================================================================
//
// This page is the read-only + safe-metadata-refresh half of the v0.5.x
// admin console release-management story. Dangerous actions (pull,
// checkout, deploy, rollback, reset, push, tag create/delete) are shown
// as DISABLED buttons with "Coming In Controls" tooltips and are wired in
// v0.5.6 (Safe Admin Actions) and beyond.
//
// All API calls go through /api/admin/git/* — fixed argv git invocations
// running with cwd pinned to /opt/w3buildcost-deploy. No user input is passed
// to git anywhere on the page.

const REPO_URL = consoleApp.repositoryUrl;

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

interface GitStatus {
  configuredRepositoryUrl?: string | null;
  repositoryBinding?: string;
  repositoryMessage?: string;
  deployRoot: string;
  isRepo: boolean;
  branch: string | null;
  headSha: string | null;
  headShortSha: string | null;
  describedTag: string | null;
  clean: boolean | null;
  uncommittedCount: number | null;
  remote: string | null;
  lastCommit: {
    sha: string;
    shortSha: string;
    author: string;
    date: string;
    subject: string;
  } | null;
  releaseVersion: string;
  status: string;
}

interface GitTag {
  name: string;
  commit: string | null;
  date: string | null;
  message: string;
  type: string | null;
  matchesInstalled: boolean;
  packageExists: boolean;
  isLatest?: boolean;
}

interface GitCommitEntry {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  subject: string;
  tag: string | null;
}

interface CheckRemoteResult {
  ok: boolean;
  remote: string | null;
  checkedAt: string;
  headCount?: number;
  message: string;
  status: 'remote_ok' | 'remote_failed';
}

interface FetchTagsResult {
  ok: boolean;
  fetchedAt: string;
  beforeCount: number;
  afterCount: number;
  added: number;
  message: string;
  status: 'fetch_ok' | 'fetch_failed';
}

type CompareStatus =
  | 'all_matched'
  | 'dirty_working_tree'
  | 'version_drift'
  | 'git_tag_mismatch'
  | 'package_missing'
  | 'unknown';

interface CompareInstalledResult {
  status: CompareStatus;
  explanation: string;
  fields: {
    runningVersion: string | null;
    versionFile: string | null;
    rootPackageJsonVersion: string | null;
    backendPackageJsonVersion: string | null;
    frontendPackageJsonVersion: string | null;
    latestGitTag: string | null;
    installedPackage: { name: string; parsedVersion: string | null; mtime: string } | null;
    branch: string | null;
    headSha: string | null;
    headShortSha: string | null;
    clean: boolean | null;
    uncommittedCount: number;
    remote: string | null;
  };
  checkedAt: string;
}

interface ReleaseNotesResult {
  version: string;
  found: boolean;
  heading: string | null;
  body: string | null;
  message?: string;
  path: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function remoteToHttps(remote: string | null): string | undefined {
  if (!remote) return REPO_URL ?? undefined;
  if (remote.startsWith('http')) return remote.replace(/\.git$/, '');
  const m = remote.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  return REPO_URL ?? undefined;
}

const COMPARE_LABEL: Record<CompareStatus, string> = {
  all_matched: 'All Matched',
  dirty_working_tree: 'Dirty Working Tree',
  version_drift: 'Version Drift',
  git_tag_mismatch: 'Git Tag Mismatch',
  package_missing: 'Package Missing',
  unknown: 'Unknown'
};

const COMPARE_TONE: Record<CompareStatus, 'success' | 'warning' | 'danger' | 'slate'> = {
  all_matched: 'success',
  dirty_working_tree: 'warning',
  version_drift: 'warning',
  git_tag_mismatch: 'warning',
  package_missing: 'danger',
  unknown: 'slate'
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function GitHubPage() {
  const qc = useQueryClient();
  const [notesVersion, setNotesVersion] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [copiedSha, setCopiedSha] = useState(false);

  const statusQ = useQuery({
    queryKey: ['admin', 'git', 'status'],
    queryFn: () => adminGet<GitStatus>('/git/status'),
    refetchInterval: 60_000
  });

  const tagsQ = useQuery({
    queryKey: ['admin', 'git', 'tags'],
    queryFn: () =>
      adminGet<{ tags: GitTag[]; installedVersion: string; count: number; limit: number; error?: string }>(
        '/git/tags'
      )
  });

  const commitsQ = useQuery({
    queryKey: ['admin', 'git', 'commits'],
    queryFn: () =>
      adminGet<{ commits: GitCommitEntry[]; count: number; limit: number; error?: string }>(
        '/git/commits'
      )
  });

  const checkRemoteM = useMutation<CheckRemoteResult>({
    mutationFn: () => adminPost<CheckRemoteResult>('/git/check-remote')
  });

  const fetchTagsM = useMutation<FetchTagsResult>({
    mutationFn: () => adminPost<FetchTagsResult>('/git/fetch-tags'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'git', 'tags'] });
      qc.invalidateQueries({ queryKey: ['admin', 'git', 'status'] });
    }
  });

  const compareM = useMutation<CompareInstalledResult>({
    mutationFn: () => adminGet<CompareInstalledResult>('/git/compare-installed')
  });

  const notesQ = useQuery({
    queryKey: ['admin', 'git', 'release-notes', notesVersion],
    queryFn: () =>
      adminGet<ReleaseNotesResult>(`/git/release-notes?version=${encodeURIComponent(notesVersion ?? '')}`),
    enabled: notesOpen && !!notesVersion
  });

  // An app link is bound to configured ownership, never inferred from another repository's origin.
  const repoHref = remoteToHttps(statusQ.data?.configuredRepositoryUrl ?? REPO_URL);
  const remoteAllowed = !statusQ.isError && statusQ.data?.repositoryBinding === 'matched';
  const repositoryIdentity = JSON.stringify([statusQ.data?.deployRoot, statusQ.data?.branch, statusQ.data?.remote, statusQ.data?.configuredRepositoryUrl, statusQ.data?.repositoryBinding]);
  useEffect(() => { checkRemoteM.reset(); fetchTagsM.reset(); }, [repositoryIdentity]);

  // Quick heuristic for the inline "Latest Git Tag" hint until the explicit
  // Compare-Installed button is clicked. The full canonical comparison comes
  // from /git/compare-installed.
  let inlineVersionMatch: 'match' | 'mismatch' | 'unknown' = 'unknown';
  if (statusQ.data?.describedTag && statusQ.data.releaseVersion) {
    const tagVer = statusQ.data.describedTag.replace(/^v/, '').split('-')[0];
    inlineVersionMatch = tagVer === statusQ.data.releaseVersion ? 'match' : 'mismatch';
  }

  const refreshAll = () => {
    checkRemoteM.reset(); fetchTagsM.reset();
    qc.invalidateQueries({ queryKey: ['admin', 'git', 'status'] });
    qc.invalidateQueries({ queryKey: ['admin', 'git', 'tags'] });
    qc.invalidateQueries({ queryKey: ['admin', 'git', 'commits'] });
  };

  const copyHeadSha = async () => {
    const sha = statusQ.data?.headSha;
    if (!sha) return;
    try {
      await navigator.clipboard.writeText(sha);
      setCopiedSha(true);
      window.setTimeout(() => setCopiedSha(false), 1500);
    } catch {
      /* clipboard unavailable — ignore */
    }
  };

  const openNotesForInstalled = () => {
    const v = statusQ.data?.releaseVersion;
    if (!v) return;
    setNotesVersion(v.startsWith('v') ? v : `v${v}`);
    setNotesOpen(true);
  };

  const openNotesFor = (version: string) => {
    setNotesVersion(version);
    setNotesOpen(true);
  };

  return (
    <>
      <AdminListPage
        header={{
          title: 'GitHub / Releases',
          subtitle: statusQ.data?.deployRoot ?? consoleText('/opt/w3buildcost-deploy'),
          actions: (
            <>
              {statusQ.data ? (
                <StatusPill tone={statusTone(statusQ.data.status) as StatusTone}>
                  {statusQ.data.status}
                </StatusPill>
              ) : null}
              <button
                type="button"
                className="btn"
                onClick={refreshAll}
                title="Refresh Status, Tags, And Commits"
              >
                <RefreshCw size={13} />
                Refresh Status
              </button>
              <a
                href={repoHref}
                aria-disabled={!repoHref}
                target="_blank"
                rel="noreferrer"
                className="btn"
                title={repoHref}
              >
                <Github size={13} />
                Repo
                <ExternalLink size={11} />
              </a>
            </>
          )
        }}
        standardCard={{
          title: 'GitHub Release Standard',
          subtitle: 'Tags, Packages, And Branches Use The Canonical Conventions Below.',
          body: (
            <>
              <div className="grid grid-cols-1 gap-2 text-xs md:grid-cols-2">
                <div>
                  <span className="text-[var(--w3-text-muted)]">Tag: </span>
                  <code className="font-mono text-[var(--w3-text)]">vX.Y.Z</code>
                </div>
                <div>
                  <span className="text-[var(--w3-text-muted)]">Package: </span>
                  <code className="font-mono text-[var(--w3-text)]">{consoleText("w3buildcost-vX")}.Y.Z.tar.gz</code>
                </div>
                <div>
                  <span className="text-[var(--w3-text-muted)]">Branch: </span>
                  <code className="font-mono text-[var(--w3-text)]">main</code>
                </div>
                <div>
                  <span className="text-[var(--w3-text-muted)]">Deploy Path: </span>
                  <code className="font-mono text-[var(--w3-text)]">{consoleText("/opt/w3buildcost-deploy")}</code>
                </div>
              </div>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-[var(--w3-text-muted)]">
                <li>Annotated Tags Are Pushed Per Release; Lightweight Tags Are Avoided.</li>
                <li>The Installed Version Should Match The Latest Tag On The Deploy Host.</li>
                <li>A Dirty Working Tree Indicates Drift From The Tagged Snapshot.</li>
                <li>Non-Standard Package Names Are Listed But Never Treated As Canonical Releases.</li>
              </ul>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <ActionButton
                  icon={
                    checkRemoteM.isPending ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <RefreshCw size={11} />
                    )
                  }
                  onClick={() => checkRemoteM.mutate()}
                  busy={checkRemoteM.isPending}
                  disabled={!remoteAllowed}
                >
                  Check Remote
                </ActionButton>
                <ActionButton
                  icon={
                    fetchTagsM.isPending ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <Download size={11} />
                    )
                  }
                  onClick={() => fetchTagsM.mutate()}
                  busy={fetchTagsM.isPending}
                  disabled={!remoteAllowed}
                >
                  Fetch Tags
                </ActionButton>
                <ActionButton
                  icon={
                    compareM.isPending ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <GitCompare size={11} />
                    )
                  }
                  onClick={() => compareM.mutate()}
                  busy={compareM.isPending}
                >
                  Compare Installed
                </ActionButton>
                <ActionButton
                  icon={<FileText size={11} />}
                  onClick={openNotesForInstalled}
                  disabled={!statusQ.data?.releaseVersion}
                >
                  View Release Notes
                </ActionButton>
              </div>

              {/* Action results — inline, mobile-safe. */}
              {statusQ.data?.repositoryMessage && !remoteAllowed ? <ResultRow tone="danger" label="Repository connection" detail={statusQ.data.repositoryMessage} /> : null}
              <div className="mt-3 space-y-2">
                {checkRemoteM.data ? (
                  <ResultRow
                    tone={checkRemoteM.data.ok ? 'success' : 'danger'}
                    label={checkRemoteM.data.ok ? 'Remote OK' : 'Remote Failed'}
                    detail={`${checkRemoteM.data.message} · ${formatTimestamp(checkRemoteM.data.checkedAt)}`}
                  />
                ) : null}
                {checkRemoteM.error ? (
                  <ResultRow tone="danger" label="Check Remote Failed" detail={errorMessage(checkRemoteM.error)} />
                ) : null}

                {fetchTagsM.data ? (
                  <ResultRow
                    tone={fetchTagsM.data.ok ? 'success' : 'danger'}
                    label={fetchTagsM.data.ok ? 'Tags Fetched' : 'Fetch Failed'}
                    detail={`${fetchTagsM.data.message} · ${formatTimestamp(fetchTagsM.data.fetchedAt)}`}
                  />
                ) : null}
                {fetchTagsM.error ? (
                  <ResultRow tone="danger" label="Fetch Tags Failed" detail={errorMessage(fetchTagsM.error)} />
                ) : null}
              </div>

              {/* v0.5.38 Unified Operator Workflow.
                  - UnifiedReleaseWorkflow is now the sole release surface on
                    the GitHub tab. The legacy ReleasePipelinePanel and
                    DeploySourcePanel — along with the Force-enable toggle and
                    every granular per-stage button they exposed — are NO
                    LONGER rendered here. Operators who need a specific
                    granular control can still reach it via the Controls tab,
                    where every control id from the registry is enumerated
                    independently of any guided workflow.
                  - This change is purely a layout/visibility change. No
                    backend route, registry entry, role check, or control
                    enablement flag is touched, and the legacy components
                    remain in the source tree (intentionally unrendered)
                    so they can be reinstated quickly if needed.
                  - PipelineSharedStateProvider stays in place so future
                    sibling components keep the shared branch selection. */}
              <div className="mt-4">
                <PipelineSharedStateProvider>
                  <div className="space-y-3">
                    <CurrentWorkflowBanner />
                    <PipelineStateSummary />
                    <div className="grid gap-3 md:grid-cols-2">
                      <SafePreflightButton />
                      <PipelineReadinessChecklist />
                    </div>
                    <UnifiedReleaseWorkflow />
                    <PipelineHelpPanel />
                  </div>
                </PipelineSharedStateProvider>
              </div>
            </>
          )
        }}
        currentStateCard={{
          title: 'Current Source Snapshot',
          subtitle: consoleText('Read-Only Inspection Of /opt/w3buildcost-deploy.'),
          right: statusQ.data?.headSha ? (
            <button
              type="button"
              className="btn"
              onClick={copyHeadSha}
              title="Copy Full Head Commit Hash"
            >
              {copiedSha ? <Check size={11} /> : <Copy size={11} />}
              {copiedSha ? 'Copied' : 'Copy Commit Hash'}
            </button>
          ) : null,
          body: statusQ.isLoading ? (
            <LoadingState />
          ) : statusQ.error ? (
            <ErrorState error={statusQ.error} />
          ) : !statusQ.data ? null : !statusQ.data.isRepo ? (
            <EmptyState>
              {statusQ.data.deployRoot} Is Not A Git Checkout — Git Inspection Unavailable.
            </EmptyState>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                <MetricTile
                  label="Installed Version"
                  value={<Badge tone="gold">v{statusQ.data.releaseVersion}</Badge>}
                  hint={
                    inlineVersionMatch === 'match'
                      ? 'Matches Latest Tag'
                      : inlineVersionMatch === 'mismatch'
                        ? `Tag Mismatch — ${statusQ.data.describedTag}`
                        : undefined
                  }
                />
                <MetricTile
                  label="Latest Git Tag"
                  value={
                    statusQ.data.describedTag ? (
                      <span className="inline-flex items-center gap-1">
                        <Tag size={12} /> {statusQ.data.describedTag}
                      </span>
                    ) : (
                      '—'
                    )
                  }
                  hint={
                    inlineVersionMatch === 'match'
                      ? 'Matches Installed'
                      : inlineVersionMatch === 'mismatch'
                        ? 'Tag Mismatch'
                        : undefined
                  }
                />
                <MetricTile
                  label="Branch"
                  value={
                    <span className="inline-flex items-center gap-1">
                      <GitBranch size={12} /> {statusQ.data.branch ?? '—'}
                    </span>
                  }
                />
                <MetricTile
                  label="Working Tree"
                  value={
                    statusQ.data.clean == null ? (
                      '—'
                    ) : statusQ.data.clean ? (
                      <Badge tone="success">
                        <Check size={11} /> Clean
                      </Badge>
                    ) : (
                      <Badge tone="warning">
                        <AlertCircle size={11} />
                        Dirty ({statusQ.data.uncommittedCount ?? 0})
                      </Badge>
                    )
                  }
                />
                <MetricTile
                  label="Head Commit"
                  value={
                    statusQ.data.headShortSha ? (
                      <code className="font-mono text-xs">{statusQ.data.headShortSha}</code>
                    ) : (
                      '—'
                    )
                  }
                  hint={statusQ.data.headSha ?? undefined}
                />
                <MetricTile
                  label="Remote"
                  value={
                    statusQ.data.remote ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <code className="break-all font-mono text-[11px]">
                          {statusQ.data.remote}
                        </code>
                        {checkRemoteM.data ? (
                          <Badge tone={checkRemoteM.data.ok ? 'success' : 'danger'}>
                            {checkRemoteM.data.ok ? 'Remote OK' : 'Remote Failed'}
                          </Badge>
                        ) : null}
                      </div>
                    ) : (
                      '—'
                    )
                  }
                />
              </div>

              {statusQ.data.lastCommit ? (
                <div
                  className="mt-4 rounded-md border p-3 text-sm"
                  style={{ borderColor: 'var(--w3-border)' }}
                >
                  <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[var(--w3-text-muted)]">
                    <GitCommit size={12} /> Latest Commit
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <code className="font-mono text-xs text-[var(--w3-gold-400)]">
                      {statusQ.data.lastCommit.shortSha}
                    </code>
                    <span className="break-words text-[var(--w3-text)]">
                      {statusQ.data.lastCommit.subject}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-[var(--w3-text-muted)]">
                    {statusQ.data.lastCommit.author} · {formatTimestamp(statusQ.data.lastCommit.date)} (
                    {formatRelative(statusQ.data.lastCommit.date)})
                  </div>
                </div>
              ) : null}
            </>
          )
        }}
        secondaryStateCard={{
          title: 'Compare Installed',
          subtitle: 'Click Compare Installed To Cross-Check Every Version Source.',
          body: compareM.isPending ? (
            <LoadingState label="Comparing installed version…" />
          ) : compareM.error ? (
            <ErrorState error={compareM.error} title="Compare failed" />
          ) : compareM.data ? (
            <CompareView result={compareM.data} onViewNotes={openNotesFor} />
          ) : (
            <EmptyState>
              No Comparison Yet — Click Compare Installed Above To Cross-Check VERSION,
              package.json Files, Latest Git Tag, And Installed Package.
            </EmptyState>
          )
        }}
        historyTables={[
          {
            title: 'Release / Tag History',
            subtitle: 'Latest 20 Tags · Annotated And Lightweight · Sorted Newest First.',
            right: tagsQ.isFetching ? (
              <span className="text-xs text-[var(--w3-text-muted)]">
                <Loader2 size={11} className="mr-1 inline animate-spin" />
                Loading
              </span>
            ) : null,
            body: tagsQ.isLoading ? (
              <LoadingState />
            ) : tagsQ.error ? (
              <ErrorState error={tagsQ.error} />
            ) : !tagsQ.data || tagsQ.data.tags.length === 0 ? (
              <EmptyState>
                {tagsQ.data?.error
                  ? `Tags Unavailable — ${tagsQ.data.error}`
                  : 'No Tags Yet — Click Fetch Tags To Refresh From The Remote.'}
              </EmptyState>
            ) : (
              <TagHistoryView tags={tagsQ.data.tags} onViewNotes={openNotesFor} />
            )
          },
          {
            title: 'Commit History',
            subtitle: 'Latest 25 Commits · Sorted Newest First.',
            right: commitsQ.isFetching ? (
              <span className="text-xs text-[var(--w3-text-muted)]">
                <Loader2 size={11} className="mr-1 inline animate-spin" />
                Loading
              </span>
            ) : null,
            body: commitsQ.isLoading ? (
              <LoadingState />
            ) : commitsQ.error ? (
              <ErrorState error={commitsQ.error} />
            ) : !commitsQ.data || commitsQ.data.commits.length === 0 ? (
              <EmptyState>
                {commitsQ.data?.error
                  ? `Commits Unavailable — ${commitsQ.data.error}`
                  : 'No Commits Available.'}
              </EmptyState>
            ) : (
              <CommitHistoryView commits={commitsQ.data.commits} />
            )
          }
        ]}
      />

      <ReleaseNotesDialog
        open={notesOpen}
        version={notesVersion}
        result={notesQ.data}
        isLoading={notesQ.isLoading || notesQ.isFetching}
        error={notesQ.error}
        onOpenChange={(v) => setNotesOpen(v)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ActionButton({
  icon,
  children,
  onClick,
  busy,
  disabled
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="btn"
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy ? 'true' : undefined}
    >
      {icon}
      {children}
    </button>
  );
}

function DisabledFutureButton({ children }: { children: React.ReactNode }) {
  return (
    <span title="Coming In Controls — Wired In v0.5.6+">
      <button type="button" className="btn" disabled>
        <Lock size={11} />
        {children}
        <span className="text-[10px] text-[var(--w3-text-dim)]">· Coming In Controls</span>
      </button>
    </span>
  );
}

function ResultRow({
  tone,
  label,
  detail
}: {
  tone: 'success' | 'warning' | 'danger';
  label: string;
  detail: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Badge tone={tone}>{label}</Badge>
      <span className="text-[var(--w3-text-muted)] break-words">{detail}</span>
    </div>
  );
}

function CompareView({
  result,
  onViewNotes
}: {
  result: CompareInstalledResult;
  onViewNotes: (version: string) => void;
}) {
  const tone = COMPARE_TONE[result.status];
  const label = COMPARE_LABEL[result.status];
  const f = result.fields;

  const tagToInspect = f.latestGitTag ?? (f.runningVersion ? `v${f.runningVersion}` : null);

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge tone={tone}>{label}</Badge>
        <span className="text-xs text-[var(--w3-text-muted)]">
          Checked {formatTimestamp(result.checkedAt)} ({formatRelative(result.checkedAt)})
        </span>
      </div>
      <p className="mb-3 text-sm text-[var(--w3-text)]">{result.explanation}</p>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <CompareRow label="Running App Version" value={f.runningVersion} tone="gold" />
        <CompareRow label="VERSION File" value={f.versionFile} />
        <CompareRow label="Root package.json" value={f.rootPackageJsonVersion} />
        <CompareRow label="Backend package.json" value={f.backendPackageJsonVersion} />
        <CompareRow label="Frontend package.json" value={f.frontendPackageJsonVersion} />
        <CompareRow label="Latest Git Tag" value={f.latestGitTag} />
        <CompareRow
          label="Installed Package"
          value={f.installedPackage?.name ?? null}
          hint={
            f.installedPackage?.parsedVersion
              ? `v${f.installedPackage.parsedVersion} · ${formatRelative(f.installedPackage.mtime)}`
              : 'No canonical package detected'
          }
          badge={f.installedPackage ? 'Package Exists' : 'Missing'}
          badgeTone={f.installedPackage ? 'success' : 'danger'}
        />
        <CompareRow label="Branch" value={f.branch} />
        <CompareRow label="Head Commit" value={f.headShortSha} hint={f.headSha ?? undefined} />
        <CompareRow
          label="Working Tree"
          value={f.clean == null ? null : f.clean ? 'Clean' : `Dirty (${f.uncommittedCount})`}
          badge={f.clean == null ? null : f.clean ? 'Clean' : 'Dirty'}
          badgeTone={f.clean == null ? 'slate' : f.clean ? 'success' : 'warning'}
        />
        <CompareRow label="Remote" value={f.remote} />
      </div>

      {tagToInspect ? (
        <div className="mt-3">
          <button
            type="button"
            className="btn"
            onClick={() => onViewNotes(tagToInspect)}
            title={`View Release Notes For ${tagToInspect}`}
          >
            <FileText size={11} />
            View Release Notes For {tagToInspect}
          </button>
        </div>
      ) : null}
    </>
  );
}

function CompareRow({
  label,
  value,
  hint,
  tone,
  badge,
  badgeTone
}: {
  label: string;
  value: string | null;
  hint?: string;
  tone?: 'gold';
  badge?: string | null;
  badgeTone?: 'success' | 'warning' | 'danger' | 'slate';
}) {
  return (
    <div
      className="rounded-md border p-2.5"
      style={{ borderColor: 'var(--w3-border)', background: 'var(--w3-card)' }}
    >
      <div className="stat-label">{label}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {tone === 'gold' && value ? (
          <Badge tone="gold">v{value.replace(/^v/, '')}</Badge>
        ) : (
          <code className="break-all font-mono text-xs text-[var(--w3-text)]">
            {value ?? '—'}
          </code>
        )}
        {badge ? <Badge tone={badgeTone ?? 'slate'}>{badge}</Badge> : null}
      </div>
      {hint ? <div className="mt-0.5 text-[11px] text-[var(--w3-text-dim)] break-all">{hint}</div> : null}
    </div>
  );
}

function TagHistoryView({
  tags,
  onViewNotes
}: {
  tags: GitTag[];
  onViewNotes: (version: string) => void;
}) {
  return (
    <>
      {/* Desktop table */}
      <div className="desktop-table">
        <table className="table-dark">
          <thead>
            <tr>
              <th>Tag</th>
              <th>Commit</th>
              <th>Date</th>
              <th>Message</th>
              <th>Status</th>
              <th className="text-right">Notes</th>
            </tr>
          </thead>
          <tbody>
            {tags.map((t) => (
              <tr key={t.name}>
                <td>
                  <div className="flex items-center gap-1.5">
                    <Tag size={11} />
                    <code className="font-mono text-xs">{t.name}</code>
                    {t.isLatest ? <Badge tone="gold">Latest</Badge> : null}
                  </div>
                </td>
                <td>
                  <code className="font-mono text-xs text-[var(--w3-text-muted)]">
                    {t.commit ?? '—'}
                  </code>
                </td>
                <td className="text-xs text-[var(--w3-text-muted)]">
                  {t.date ? formatTimestamp(t.date) : '—'}
                </td>
                <td className="text-xs text-[var(--w3-text)] break-words">
                  {t.message || '—'}
                </td>
                <td>
                  <div className="flex flex-wrap items-center gap-1">
                    {t.matchesInstalled ? <Badge tone="success">Installed</Badge> : null}
                    {t.packageExists ? (
                      <Badge tone="info">Package Exists</Badge>
                    ) : (
                      <Badge tone="slate">No Package</Badge>
                    )}
                    {t.type === 'commit' ? <Badge tone="slate">Lightweight</Badge> : null}
                  </div>
                </td>
                <td className="text-right">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => onViewNotes(t.name)}
                    title={`View Release Notes For ${t.name}`}
                  >
                    <FileText size={11} />
                    Notes
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile stacked cards */}
      <div className="mobile-cards">
        {tags.map((t) => (
          <div key={t.name} className="stack-card">
            <div className="stack-card__row">
              <div className="stack-card__title flex items-center gap-1.5">
                <Tag size={12} />
                {t.name}
                {t.isLatest ? <Badge tone="gold">Latest</Badge> : null}
              </div>
            </div>
            <div className="stack-card__meta">
              <span>
                <code className="font-mono">{t.commit ?? '—'}</code>
              </span>
              <span>{t.date ? formatTimestamp(t.date) : '—'}</span>
            </div>
            {t.message ? (
              <div className="text-xs text-[var(--w3-text)] break-words">{t.message}</div>
            ) : null}
            <div className="flex flex-wrap items-center gap-1">
              {t.matchesInstalled ? <Badge tone="success">Installed</Badge> : null}
              {t.packageExists ? (
                <Badge tone="info">Package Exists</Badge>
              ) : (
                <Badge tone="slate">No Package</Badge>
              )}
              {t.type === 'commit' ? <Badge tone="slate">Lightweight</Badge> : null}
            </div>
            <div className="stack-card__actions">
              <button
                type="button"
                className="btn"
                onClick={() => onViewNotes(t.name)}
              >
                <FileText size={11} />
                View Release Notes
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function CommitHistoryView({ commits }: { commits: GitCommitEntry[] }) {
  return (
    <>
      <div className="desktop-table">
        <table className="table-dark">
          <thead>
            <tr>
              <th>Commit</th>
              <th>Message</th>
              <th>Author</th>
              <th>Date</th>
              <th>Tag</th>
            </tr>
          </thead>
          <tbody>
            {commits.map((c) => (
              <tr key={c.sha}>
                <td>
                  <code className="font-mono text-xs text-[var(--w3-gold-400)]">{c.shortSha}</code>
                </td>
                <td className="text-[var(--w3-text)] break-words">{c.subject}</td>
                <td className="text-xs text-[var(--w3-text-muted)]">{c.author}</td>
                <td className="text-xs text-[var(--w3-text-muted)]">
                  {formatTimestamp(c.date)} · {formatRelative(c.date)}
                </td>
                <td>
                  {c.tag ? (
                    <Badge tone="gold">
                      <Tag size={10} /> {c.tag}
                    </Badge>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mobile-cards">
        {commits.map((c) => (
          <div key={c.sha} className="stack-card">
            <div className="stack-card__row">
              <code className="font-mono text-xs text-[var(--w3-gold-400)]">{c.shortSha}</code>
              {c.tag ? (
                <Badge tone="gold">
                  <Tag size={10} /> {c.tag}
                </Badge>
              ) : null}
            </div>
            <div className="text-sm text-[var(--w3-text)] break-words">{c.subject}</div>
            <div className="stack-card__meta">
              <span>{c.author}</span>
              <span>{formatRelative(c.date)}</span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Release Notes Dialog
// ---------------------------------------------------------------------------

function ReleaseNotesDialog({
  open,
  version,
  result,
  isLoading,
  error,
  onOpenChange
}: {
  open: boolean;
  version: string | null;
  result: ReleaseNotesResult | undefined;
  isLoading: boolean;
  error: unknown;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.65)',
            zIndex: 60
          }}
        />
        <Dialog.Content
          aria-describedby={undefined}
          style={{
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            maxWidth: 'min(720px, calc(100vw - 1.5rem))',
            width: '100%',
            maxHeight: 'calc(100vh - 2rem)',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--w3-card)',
            border: '1px solid var(--w3-border)',
            borderRadius: 'var(--w3-radius-lg, 0.5rem)',
            color: 'var(--w3-text)',
            zIndex: 70,
            boxShadow: '0 12px 40px rgba(0,0,0,0.5)'
          }}
        >
          <div
            className="card-header"
            style={{ borderBottom: '1px solid var(--w3-border)' }}
          >
            <div className="min-w-0">
              <Dialog.Title className="card-title truncate">
                Release Notes — {version ?? '—'}
              </Dialog.Title>
              <div className="mt-0.5 text-xs text-[var(--w3-text-muted)] truncate">
                {result?.path ?? 'CHANGELOG.md'}
              </div>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="btn" aria-label="Close release notes">
                <X size={13} />
                Close
              </button>
            </Dialog.Close>
          </div>
          <div
            className="card-body"
            style={{ overflow: 'auto', flex: '1 1 auto' }}
          >
            {isLoading ? (
              <LoadingState label="Loading release notes…" />
            ) : error ? (
              <ErrorState error={error} title="Failed to load release notes" />
            ) : !result ? null : !result.found ? (
              <EmptyState>
                {result.message ?? `No release notes found for ${version}.`}
              </EmptyState>
            ) : (
              <article className="release-notes">
                <h3 className="section-title">{result.heading}</h3>
                <pre
                  style={{
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: 'inherit',
                    fontSize: '0.875rem',
                    lineHeight: 1.55,
                    margin: '0.75rem 0 0',
                    color: 'var(--w3-text)'
                  }}
                >
                  {result.body}
                </pre>
              </article>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  if (err instanceof AdminApiError) return `${err.code} — ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// v0.5.38 — Current workflow banner + Advanced/Danger Zone accordion.
// ---------------------------------------------------------------------------
//
// CurrentWorkflowBanner tells the operator which UI is the current workflow
// (the guided 7-step UnifiedReleaseWorkflow; v0.5.39 dropped the legacy
// Step 8 "Confirm Installed Metadata" from this surface) and which UI is
// legacy /
// advanced-only (the original ReleasePipelinePanel + DeploySourcePanel,
// kept behind the AdvancedDangerZone accordion).
//
// Neither component talks to the network, mutates state, or invokes
// restricted-category controls. They are purely layout + disclosure.
// ---------------------------------------------------------------------------

function CurrentWorkflowBanner() {
  return (
    <div
      className="rounded-md border px-3 py-2 text-[11px]"
      style={{
        borderColor: 'var(--w3-accent, #38bdf8)',
        background: 'rgba(56, 189, 248, 0.10)',
        color: 'var(--w3-text)'
      }}
      role="note"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Rocket size={12} style={{ color: 'var(--w3-accent, #38bdf8)' }} />
        <strong className="font-semibold">Current workflow:</strong>
        <span>
          Release Workflow — Guided (7 steps, below). This is the
          recommended path for v0.5.39.
        </span>
      </div>
      <div
        className="mt-1 flex flex-wrap items-center gap-2 text-[10.5px]"
        style={{ color: 'var(--w3-text-muted)' }}
      >
        <ShieldAlert size={11} />
        <span>
          For break-glass use of individual controls (Force-enable, granular
          per-stage buttons, etc.), use the Controls tab. The GitHub tab is
          intentionally focused on the guided release workflow only.
        </span>
      </div>
    </div>
  );
}

function AdvancedDangerZone({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<boolean>(false);
  return (
    <section
      className="rounded-md border"
      style={{
        borderColor: open ? 'var(--status-warning, #facc15)' : 'var(--w3-border-section)',
        background: 'var(--w3-bg-panel)'
      }}
      aria-label="Advanced / Danger Zone"
    >
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          <AlertTriangle
            size={13}
            style={{ color: 'var(--status-warning, #facc15)' }}
          />
          <span
            className="text-[12px] font-semibold uppercase tracking-wide"
            style={{ color: 'var(--w3-text)' }}
          >
            Advanced / Danger Zone
          </span>
          <span
            className="text-[10.5px]"
            style={{ color: 'var(--w3-text-muted)' }}
          >
            legacy Release Pipeline · granular controls · Force-enable
          </span>
        </span>
        <span
          className="inline-flex items-center gap-1 text-[10.5px]"
          style={{ color: 'var(--w3-text-muted)' }}
        >
          {open ? 'Hide' : 'Show'}
          {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        </span>
      </button>
      {open ? (
        <div
          className="space-y-3 border-t p-3"
          style={{ borderColor: 'var(--w3-border-section)' }}
        >
          <div
            className="rounded-sm border px-2 py-1.5 text-[10.5px]"
            style={{
              borderColor: 'var(--status-warning, #facc15)',
              color: 'var(--status-warning, #facc15)',
              background: 'rgba(250, 204, 21, 0.08)'
            }}
          >
            These controls are kept for break-glass use only. Use the guided
            Release Workflow above for normal v0.5.38 operations.
          </div>
          {children}
        </div>
      ) : null}
    </section>
  );
}
