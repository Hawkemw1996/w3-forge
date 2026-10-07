import { consoleText, consolePattern } from "../../../../../shared/consoleApp";
// =============================================================================
// W3 Core v0.5.38 - Deploy Source Panel.
// =============================================================================
//
// Channel/version-aware operator console that exposes the new v0.5.38 release
// model:
//
//   /opt/w3buildcost-update-packages/dev/<vX.Y.Z>/w3buildcost.tar.gz       (dev channel)
//   /opt/w3buildcost-update-packages/main/<vX.Y.Z>/w3buildcost.tar.gz      (main channel)
//   /opt/w3buildcost-update-packages/installed/<vX.Y.Z>/w3buildcost.tar.gz (installed channel)
//
// The panel mirrors the existing Release Pipeline panel's safety patterns
// (typed-phrase + checkbox confirmations, dark UI primitives, per-result
// detail render) but is rendered as a separate section so the existing 7-stage
// release pipeline UI stays untouched and operator muscle memory is preserved.
//
// What this panel can do today (v0.5.38):
//
//   * Select a deploy source channel: DEV / MAIN / INSTALLED.
//   * Pick a version under that channel (populated from the matching
//     /api/admin/packages/* endpoint).
//   * VERIFY  -> POST /controls/pipeline-verify-dev-pkg/run
//                (channel + version + canonical packageName).
//   * PROMOTE -> POST /controls/pipeline-promote-dev-to-main/run
//                (version-only; requires typed PROMOTE phrase + checkbox).
//                Only enabled when source = DEV.
//   * DEPLOY  -> POST /controls/pipeline-deploy-dev/run
//                (channel + version + canonical packageName; requires typed
//                DEPLOY-DEV phrase + checkbox).
//   * ROLLBACK display for INSTALLED versions: surfaces the sidecar metadata
//     (deployed-at, source, sha256, request-id, log-path) read-only from
//     /api/admin/packages/installed/:version so the operator can confirm the
//     known-good install they would roll back to. The actual rollback action
//     remains the existing pipeline-rollback control (already exposed by the
//     7-stage release pipeline panel above) — this panel does NOT introduce a
//     new write-side rollback path because that would land in the
//     deployment-critical restricted category.
//
// Every successful run surface includes: selected channel, selected version,
// resolved_package_path, sha256, verification flag, script name + delegate
// exit code, structured trailer, and the log file path.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  FileText,
  Loader2,
  Package,
  Play,
  RefreshCw,
  ShieldCheck,
  Workflow
} from 'lucide-react';

import { adminGet, adminPost, AdminApiError } from '../../lib/api';
import { DarkSelect, type DarkSelectOption } from '../../components/ui/DarkSelect';
import type { RunResponse } from '../controls/controlsTypes';

// ---------------------------------------------------------------------------
// Wire shapes (read-only) for the v0.5.38 channel/version endpoints.
// ---------------------------------------------------------------------------

type PackageLayout = 'canonical' | 'legacy-flat';
type PackageChannel = 'dev' | 'main' | 'installed' | 'staged-legacy';

interface PackageEntry {
  name: string;
  path: string;
  sizeBytes: number;
  mtime: string;
  validName: boolean;
  parsedVersion: string | null;
  layout: PackageLayout;
  channel: PackageChannel;
}

interface PackagesListResponse {
  root: string;
  namingStandard: string;
  packages: PackageEntry[];
}

interface InstalledVersionSummary {
  version: string;
  dir: string;
  packagePath: string | null;
  deployedAt: string | null;
  source: string | null;
  requestId: string | null;
  logPath: string | null;
  sha256: string | null;
}

interface InstalledVersionsResponse {
  root: string;
  versions: InstalledVersionSummary[];
}

interface InstalledVersionDetailResponse extends InstalledVersionSummary {
  canonicalArchive: string;
}

// ---------------------------------------------------------------------------
// Local types.
// ---------------------------------------------------------------------------

type DeploySource = 'dev' | 'main' | 'installed';

const SOURCE_OPTIONS: Array<{
  id: DeploySource;
  label: string;
  description: string;
}> = [
  {
    id: 'dev',
    label: 'DEV',
    description:
      consoleText('/opt/w3buildcost-update-packages/dev/<vX.Y.Z>/w3buildcost.tar.gz — freshly packaged dev releases awaiting verification + promotion.')
  },
  {
    id: 'main',
    label: 'MAIN',
    description:
      consoleText('/opt/w3buildcost-update-packages/main/<vX.Y.Z>/w3buildcost.tar.gz — promoted release candidates ready for deploy.')
  },
  {
    id: 'installed',
    label: 'INSTALLED',
    description:
      consoleText('/opt/w3buildcost-update-packages/installed/<vX.Y.Z>/ — historical deploy records with sidecar metadata (deployed-at, source, sha256, request-id, log-path).')
  }
];

// Action ids that this panel calls into. Kept distinct from the granular
// PipelineControlId union used by ReleasePipelinePanel because this panel
// only drives the v0.5.38 subset.
type PanelControlId =
  | 'pipeline-verify-dev-pkg'
  | 'pipeline-promote-dev-to-main'
  | 'pipeline-deploy-dev';

const CANONICAL_FILENAME = consoleText('w3buildcost.tar.gz');

// Accepts BOTH the v0.5.38 canonical filename (w3buildcost.tar.gz, lives under a
// <vX.Y.Z>/ directory) and the pre-v0.5.38 legacy versioned-flat filename
// (w3buildcost-vX.Y.Z.tar.gz). Either form is a valid `packageName` input for the
// pipeline-verify / pipeline-deploy controls.
const PACKAGE_NAME_RE = new RegExp(consolePattern("^(?:w3buildcost\\.tar\\.gz|w3buildcost-v\\d+\\.\\d+\\.\\d+\\.tar\\.gz)$"), "");
const VERSION_TAG_RE = /^v\d+\.\d+\.\d+$/;

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function formatBytes(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

function shortSha(s: string | null | undefined): string {
  if (!s) return '—';
  return s.length > 12 ? `${s.slice(0, 12)}…` : s;
}

function copyToClipboard(text: string): void {
  // Best-effort. We never throw out of a click handler.
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    /* clipboard unavailable; silently noop */
  }
}

// ---------------------------------------------------------------------------
// Panel.
// ---------------------------------------------------------------------------

export function DeploySourcePanel() {
  const qc = useQueryClient();

  // Selection state.
  const [source, setSource] = useState<DeploySource>('dev');
  const [version, setVersion] = useState<string>('');

  // Promote confirmation gate (only used when source === 'dev').
  const [typedPromote, setTypedPromote] = useState<string>('');
  const [confirmPromote, setConfirmPromote] = useState<boolean>(false);

  // Deploy confirmation gate (used when source === 'dev' or 'main').
  const [typedDeployDev, setTypedDeployDev] = useState<string>('');
  const [confirmDeployDev, setConfirmDeployDev] = useState<boolean>(false);

  // Last result keyed by panel control id.
  const [lastResult, setLastResult] = useState<Record<PanelControlId, RunResponse | null>>({
    'pipeline-verify-dev-pkg': null,
    'pipeline-promote-dev-to-main': null,
    'pipeline-deploy-dev': null
  });

  // ------------------------------------------------------------------------
  // Data queries (channel-aware).
  // ------------------------------------------------------------------------

  const devPkgsQ = useQuery({
    queryKey: ['admin', 'packages', 'deploy-source', 'dev'],
    queryFn: () => adminGet<PackagesListResponse>('/packages/staged-dev'),
    enabled: source === 'dev'
  });

  const mainPkgsQ = useQuery({
    queryKey: ['admin', 'packages', 'deploy-source', 'main'],
    queryFn: () => adminGet<PackagesListResponse>('/packages/staged-main'),
    enabled: source === 'main'
  });

  const installedVersionsQ = useQuery({
    queryKey: ['admin', 'packages', 'deploy-source', 'installed-versions'],
    queryFn: () => adminGet<InstalledVersionsResponse>('/packages/installed-versions'),
    enabled: source === 'installed'
  });

  // Per-version installed detail (lazy on selection).
  const installedDetailQ = useQuery({
    queryKey: ['admin', 'packages', 'deploy-source', 'installed-detail', version],
    queryFn: () =>
      adminGet<InstalledVersionDetailResponse>(
        `/packages/installed/${encodeURIComponent(version)}`
      ),
    enabled: source === 'installed' && VERSION_TAG_RE.test(version)
  });

  // ------------------------------------------------------------------------
  // Derived: version options for the current source.
  // ------------------------------------------------------------------------

  const channelEntries = useMemo<PackageEntry[]>(() => {
    if (source === 'dev') return devPkgsQ.data?.packages ?? [];
    if (source === 'main') return mainPkgsQ.data?.packages ?? [];
    return [];
  }, [source, devPkgsQ.data, mainPkgsQ.data]);

  const versionOptions = useMemo<DarkSelectOption[]>(() => {
    if (source === 'installed') {
      const versions = installedVersionsQ.data?.versions ?? [];
      return versions.map((v) => ({
        value: `v${v.version}`,
        label: `v${v.version}`,
        hint: v.packagePath ? 'canonical' : 'metadata-only'
      }));
    }
    // dev / main: prefer canonical entries (one per version dir), fall back to
    // any legacy-flat entries still hanging around during transition.
    const canonical = channelEntries.filter((p) => p.layout === 'canonical');
    const legacy = channelEntries.filter((p) => p.layout === 'legacy-flat');
    const seen = new Set<string>();
    const opts: DarkSelectOption[] = [];
    for (const p of canonical) {
      const v = p.parsedVersion;
      if (!v) continue;
      const tag = `v${v}`;
      if (seen.has(tag)) continue;
      seen.add(tag);
      opts.push({ value: tag, label: tag, hint: 'canonical' });
    }
    for (const p of legacy) {
      const v = p.parsedVersion;
      if (!v) continue;
      const tag = `v${v}`;
      if (seen.has(tag)) continue;
      seen.add(tag);
      opts.push({ value: tag, label: tag, hint: 'legacy' });
    }
    return opts;
  }, [source, channelEntries, installedVersionsQ.data]);

  // Resolve the currently selected entry (for dev / main) or installed detail.
  const selectedDevMainEntry = useMemo<PackageEntry | null>(() => {
    if (source === 'installed' || !version) return null;
    // Prefer canonical layout for the selected version.
    const cand = channelEntries.find(
      (p) =>
        p.layout === 'canonical' &&
        p.parsedVersion &&
        `v${p.parsedVersion}` === version
    );
    if (cand) return cand;
    return (
      channelEntries.find(
        (p) =>
          p.layout === 'legacy-flat' &&
          p.parsedVersion &&
          `v${p.parsedVersion}` === version
      ) ?? null
    );
  }, [source, channelEntries, version]);

  // What package basename do we send to the backend?
  // - Canonical entries -> 'w3buildcost.tar.gz'
  // - Legacy-flat       -> the actual versioned filename
  const packageNameForBackend = useMemo<string>(() => {
    if (source === 'installed') {
      // For installed we don't run verify/deploy from this panel today —
      // installed is read-only display. Still expose canonical name as the
      // most accurate value for any future wiring.
      return CANONICAL_FILENAME;
    }
    if (selectedDevMainEntry?.layout === 'legacy-flat') {
      return selectedDevMainEntry.name;
    }
    return CANONICAL_FILENAME;
  }, [source, selectedDevMainEntry]);

  // ------------------------------------------------------------------------
  // Mutation: run a control.
  // ------------------------------------------------------------------------

  const runMut = useMutation({
    mutationFn: async (args: {
      id: PanelControlId;
      inputs: Record<string, unknown>;
      confirmations?: Record<string, unknown>;
    }) => {
      const res = await adminPost<RunResponse>(
        `/controls/${args.id}/run`,
        { inputs: args.inputs, confirmations: args.confirmations ?? {} }
      );
      return { id: args.id, res };
    },
    onSuccess: ({ id, res }) => {
      setLastResult((prev) => ({ ...prev, [id]: res }));
      // Refresh packages so newly promoted main version shows up.
      qc.invalidateQueries({
        queryKey: ['admin', 'packages', 'deploy-source'],
        exact: false
      });
      // Also refresh installed history if deploy ran successfully.
      if (id === 'pipeline-deploy-dev' && res.runStatus === 'success') {
        qc.invalidateQueries({
          queryKey: ['admin', 'packages', 'deploy-source', 'installed-versions']
        });
      }
    }
  });

  // ------------------------------------------------------------------------
  // Gate helpers (button enable rules).
  // ------------------------------------------------------------------------

  const haveVersion = VERSION_TAG_RE.test(version);
  const havePackageName = PACKAGE_NAME_RE.test(packageNameForBackend);
  const verifyEnabled =
    haveVersion && havePackageName && source !== 'installed' && !runMut.isPending;
  const promoteEnabled =
    source === 'dev' &&
    haveVersion &&
    typedPromote === 'PROMOTE' &&
    confirmPromote &&
    !runMut.isPending;
  const deployEnabled =
    source !== 'installed' &&
    haveVersion &&
    havePackageName &&
    typedDeployDev === 'DEPLOY-DEV' &&
    confirmDeployDev &&
    !runMut.isPending;

  // ------------------------------------------------------------------------
  // Click handlers.
  // ------------------------------------------------------------------------

  function onVerify() {
    if (!verifyEnabled) return;
    runMut.mutate({
      id: 'pipeline-verify-dev-pkg',
      inputs: {
        packageName: packageNameForBackend,
        channel: source,
        version
      }
    });
  }

  function onPromote() {
    if (!promoteEnabled) return;
    runMut.mutate({
      id: 'pipeline-promote-dev-to-main',
      inputs: { version },
      confirmations: { typedPromote, confirmPromote }
    });
  }

  function onDeploy() {
    if (!deployEnabled) return;
    runMut.mutate({
      id: 'pipeline-deploy-dev',
      inputs: {
        packageName: packageNameForBackend,
        channel: source,
        version
      },
      confirmations: { typedDeployDev, confirmDeployDev }
    });
  }

  // ------------------------------------------------------------------------
  // Render.
  // ------------------------------------------------------------------------

  return (
    <section
      className="rounded-md border p-3"
      style={{
        borderColor: 'var(--w3-border-section)',
        background: 'var(--w3-bg-panel)'
      }}
      aria-label="v0.5.38 Deploy Source Panel"
    >
      <header className="mb-3 flex items-center gap-2">
        <Workflow size={14} style={{ color: 'var(--w3-text-muted)' }} />
        <h3
          className="text-[12.5px] font-semibold uppercase tracking-wide"
          style={{ color: 'var(--w3-text)' }}
        >
          v0.5.38 Deploy Source
        </h3>
        <span
          className="text-[10.5px]"
          style={{ color: 'var(--w3-text-muted)' }}
        >
          Channel + version aware (dev / main / installed)
        </span>
      </header>

      {/* Source selector ----------------------------------------------------*/}
      <div className="mb-3">
        <div
          className="mb-1 text-[10.5px] uppercase tracking-wide"
          style={{ color: 'var(--w3-text-muted)' }}
        >
          Source channel
        </div>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Deploy source channel">
          {SOURCE_OPTIONS.map((opt) => {
            const active = source === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => {
                  setSource(opt.id);
                  setVersion('');
                  // Reset confirmations when switching source.
                  setTypedPromote('');
                  setConfirmPromote(false);
                  setTypedDeployDev('');
                  setConfirmDeployDev(false);
                }}
                className="rounded-sm border px-2 py-1 text-[11px] font-mono"
                style={{
                  borderColor: active
                    ? 'var(--w3-accent-gold)'
                    : 'var(--w3-border-section)',
                  background: active
                    ? 'rgba(212,175,55,0.12)'
                    : 'rgba(15,23,42,0.45)',
                  color: 'var(--w3-text)'
                }}
                title={opt.description}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <p
          className="mt-1 text-[10.5px]"
          style={{ color: 'var(--w3-text-muted)' }}
        >
          {SOURCE_OPTIONS.find((o) => o.id === source)?.description}
        </p>
      </div>

      {/* Version picker -----------------------------------------------------*/}
      <div className="mb-3">
        <label
          htmlFor="deploy-source-version"
          className="mb-1 block text-[10.5px] uppercase tracking-wide"
          style={{ color: 'var(--w3-text-muted)' }}
        >
          Version
        </label>
        <DarkSelect
          id="deploy-source-version"
          value={version}
          onChange={(v) => {
            setVersion(v);
            // Reset confirmations whenever the version changes.
            setTypedPromote('');
            setConfirmPromote(false);
            setTypedDeployDev('');
            setConfirmDeployDev(false);
          }}
          options={[
            { value: '', label: '— Select version —' },
            ...versionOptions
          ]}
          placeholder="— Select version —"
          ariaLabel="Selected package version"
          emptyMessage={
            source === 'installed'
              ? 'No installed versions found.'
              : 'No packages found for this channel.'
          }
        />
        <PackageInputsSummary
          source={source}
          version={version}
          packageName={packageNameForBackend}
          selectedDevMainEntry={selectedDevMainEntry}
          installedDetail={installedDetailQ.data ?? null}
        />
      </div>

      {/* Action row ---------------------------------------------------------*/}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ActionButton
          label="Verify"
          icon={<ShieldCheck size={12} />}
          tone="medium"
          disabled={!verifyEnabled}
          onClick={onVerify}
          busy={runMut.isPending && runMut.variables?.id === 'pipeline-verify-dev-pkg'}
          hint={
            source === 'installed'
              ? 'Verify is gated to dev/main staged packages in v0.5.38.'
              : !haveVersion
                ? 'Pick a version first.'
                : 'Read-only verification of the staged tarball.'
          }
        />
        <ActionButton
          label="Promote Dev → Main"
          icon={<Package size={12} />}
          tone="high"
          disabled={!promoteEnabled}
          onClick={onPromote}
          busy={
            runMut.isPending &&
            runMut.variables?.id === 'pipeline-promote-dev-to-main'
          }
          hint={
            source !== 'dev'
              ? 'Promote is only available when Source = DEV.'
              : !haveVersion
                ? 'Pick a dev version first.'
                : !confirmPromote || typedPromote !== 'PROMOTE'
                  ? 'Type PROMOTE and tick the checkbox below to enable.'
                  : consoleText('Atomic channel flip: dev/<v>/w3buildcost.tar.gz → main/<v>/w3buildcost.tar.gz.')
          }
        />
        <ActionButton
          label="Deploy"
          icon={<Play size={12} />}
          tone="high"
          disabled={!deployEnabled}
          onClick={onDeploy}
          busy={runMut.isPending && runMut.variables?.id === 'pipeline-deploy-dev'}
          hint={
            source === 'installed'
              ? 'Deploy is gated to dev/main staged packages. Use the existing Release Pipeline rollback above.'
              : !haveVersion
                ? 'Pick a version first.'
                : !confirmDeployDev || typedDeployDev !== 'DEPLOY-DEV'
                  ? 'Type DEPLOY-DEV and tick the checkbox below to enable.'
                  : 'Runs the safe-pipeline deploy path for the selected channel/version.'
          }
        />
        <RollbackHint disabled={source !== 'installed'} />
      </div>

      {/* Confirmation gates -------------------------------------------------*/}
      <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-2">
        {source === 'dev' ? (
          <ConfirmCard
            title="Promote Dev → Main confirmation"
            tone="high"
            typedKey="PROMOTE"
            typedValue={typedPromote}
            onTypedChange={setTypedPromote}
            checkboxValue={confirmPromote}
            onCheckboxChange={setConfirmPromote}
            checkboxLabel="I understand this publishes the dev tarball into the main channel directory (no runtime touch, no git push)."
          />
        ) : null}
        {source !== 'installed' ? (
          <ConfirmCard
            title="Deploy confirmation"
            tone="high"
            typedKey="DEPLOY-DEV"
            typedValue={typedDeployDev}
            onTypedChange={setTypedDeployDev}
            checkboxValue={confirmDeployDev}
            onCheckboxChange={setConfirmDeployDev}
            checkboxLabel="I understand this prepares a release for the live runtime via the safe-pipeline path."
          />
        ) : null}
      </div>

      {/* Installed history detail (read-only) -------------------------------*/}
      {source === 'installed' ? (
        <InstalledHistorySection
          versionsQuery={{
            data: installedVersionsQ.data,
            isLoading: installedVersionsQ.isLoading,
            isError: installedVersionsQ.isError,
            error: installedVersionsQ.error
          }}
          detail={installedDetailQ.data ?? null}
          detailLoading={
            VERSION_TAG_RE.test(version) && installedDetailQ.isLoading
          }
        />
      ) : null}

      {/* Mutation error (network / 4xx envelope) ----------------------------*/}
      {runMut.isError ? (
        <div
          className="mb-2 rounded-sm border p-2 text-[11px]"
          style={{
            borderColor: 'var(--status-danger)',
            background: 'rgba(127,29,29,0.25)',
            color: 'var(--status-danger)'
          }}
        >
          <div className="flex items-center gap-1.5">
            <AlertTriangle size={11} />
            <span>
              {runMut.error instanceof AdminApiError
                ? `${runMut.error.code}: ${runMut.error.message}`
                : (runMut.error as Error)?.message || 'unknown error'}
            </span>
          </div>
        </div>
      ) : null}

      {/* Per-action result panels ------------------------------------------*/}
      <div className="space-y-2">
        <ResultPanel
          id="pipeline-verify-dev-pkg"
          label="Verify"
          result={lastResult['pipeline-verify-dev-pkg']}
        />
        {source === 'dev' ? (
          <ResultPanel
            id="pipeline-promote-dev-to-main"
            label="Promote Dev → Main"
            result={lastResult['pipeline-promote-dev-to-main']}
          />
        ) : null}
        {source !== 'installed' ? (
          <ResultPanel
            id="pipeline-deploy-dev"
            label="Deploy"
            result={lastResult['pipeline-deploy-dev']}
          />
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sub-components.
// ---------------------------------------------------------------------------

interface PackageInputsSummaryProps {
  source: DeploySource;
  version: string;
  packageName: string;
  selectedDevMainEntry: PackageEntry | null;
  installedDetail: InstalledVersionDetailResponse | null;
}

function PackageInputsSummary({
  source,
  version,
  packageName,
  selectedDevMainEntry,
  installedDetail
}: PackageInputsSummaryProps) {
  if (!version) return null;
  const resolvedPath =
    source === 'installed'
      ? installedDetail?.canonicalArchive ?? installedDetail?.packagePath ?? '—'
      : selectedDevMainEntry?.path ?? '—';
  return (
    <div
      className="mt-1.5 rounded-sm border p-1.5 text-[10.5px] font-mono"
      style={{
        borderColor: 'var(--w3-border-section)',
        background: 'rgba(15,23,42,0.45)',
        color: 'var(--w3-text)'
      }}
    >
      <div>
        <span style={{ color: 'var(--w3-text-muted)' }}>channel:</span>{' '}
        {source}
      </div>
      <div>
        <span style={{ color: 'var(--w3-text-muted)' }}>version:</span>{' '}
        {version}
      </div>
      <div>
        <span style={{ color: 'var(--w3-text-muted)' }}>packageName:</span>{' '}
        {packageName}
      </div>
      <div className="break-all">
        <span style={{ color: 'var(--w3-text-muted)' }}>resolved path:</span>{' '}
        {resolvedPath}
      </div>
      {selectedDevMainEntry?.layout === 'legacy-flat' ? (
        <div
          className="mt-1.5 rounded-sm border px-1.5 py-1 text-[10px]"
          style={{
            borderColor: 'var(--status-warning)',
            color: 'var(--status-warning)',
            background: 'rgba(120, 90, 0, 0.15)'
          }}
        >
          legacy-flat package detected. Re-package this version with Step 4
          (Package DEV) to produce the canonical
          {' '}<span className="font-mono">{source}/&lt;v&gt;/{consoleText("w3buildcost")}.tar.gz</span>{' '}
          path. Resolver prefers canonical automatically once present.
        </div>
      ) : null}
    </div>
  );
}

interface ActionButtonProps {
  label: string;
  icon: React.ReactNode;
  tone: 'medium' | 'high';
  disabled: boolean;
  onClick: () => void;
  busy: boolean;
  hint: string;
}

function ActionButton({
  label,
  icon,
  tone,
  disabled,
  onClick,
  busy,
  hint
}: ActionButtonProps) {
  const isHigh = tone === 'high';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={hint}
      className="inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-[11px] font-mono disabled:cursor-not-allowed disabled:opacity-50"
      style={{
        borderColor: isHigh
          ? 'var(--status-danger)'
          : 'var(--w3-border-section)',
        background: isHigh
          ? 'rgba(127,29,29,0.18)'
          : 'rgba(15,23,42,0.55)',
        color: isHigh ? 'var(--status-danger)' : 'var(--w3-text)'
      }}
    >
      {busy ? (
        <Loader2 size={12} className="animate-spin" />
      ) : (
        icon
      )}
      {label}
    </button>
  );
}

function RollbackHint({ disabled }: { disabled: boolean }) {
  return (
    <span
      className="ml-auto text-[10.5px]"
      style={{
        color: disabled
          ? 'var(--w3-text-muted)'
          : 'var(--status-warning)'
      }}
      title="The write-side rollback action is gated to the Release Pipeline above (pipeline-rollback). This panel surfaces the installed sidecar metadata read-only so you can confirm the known-good install."
    >
      {disabled
        ? 'Rollback: pick INSTALLED source to inspect history.'
        : 'Rollback (read-only history below). Use Release Pipeline → Rollback above to perform the action.'}
    </span>
  );
}

interface ConfirmCardProps {
  title: string;
  tone: 'high';
  typedKey: string;
  typedValue: string;
  onTypedChange: (v: string) => void;
  checkboxValue: boolean;
  onCheckboxChange: (v: boolean) => void;
  checkboxLabel: string;
}

function ConfirmCard({
  title,
  tone: _tone,
  typedKey,
  typedValue,
  onTypedChange,
  checkboxValue,
  onCheckboxChange,
  checkboxLabel
}: ConfirmCardProps) {
  const match = typedValue === typedKey;
  return (
    <div
      className="rounded-sm border p-2"
      style={{
        borderColor: 'var(--status-danger)',
        background: 'rgba(127,29,29,0.10)',
        color: 'var(--w3-text)'
      }}
    >
      <div
        className="mb-1 text-[10.5px] uppercase tracking-wide"
        style={{ color: 'var(--status-danger)' }}
      >
        {title}
      </div>
      <label className="block">
        <span
          className="block text-[10.5px]"
          style={{ color: 'var(--w3-text-muted)' }}
        >
          Type {typedKey} to enable
        </span>
        <input
          type="text"
          value={typedValue}
          onChange={(e) => onTypedChange(e.target.value)}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          className="mt-0.5 w-full rounded-sm border px-1.5 py-1 font-mono text-[11px]"
          style={{
            borderColor: match
              ? 'var(--status-success)'
              : 'var(--w3-border-section)',
            background: 'rgba(15,23,42,0.65)',
            color: 'var(--w3-text)'
          }}
          aria-label={`Type ${typedKey} to confirm`}
        />
      </label>
      <label className="mt-1.5 flex items-start gap-1.5 text-[10.5px]">
        <input
          type="checkbox"
          checked={checkboxValue}
          onChange={(e) => onCheckboxChange(e.target.checked)}
          className="mt-[2px]"
        />
        <span style={{ color: 'var(--w3-text)' }}>{checkboxLabel}</span>
      </label>
    </div>
  );
}

interface InstalledHistorySectionProps {
  versionsQuery: {
    data: InstalledVersionsResponse | undefined;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
  };
  detail: InstalledVersionDetailResponse | null;
  detailLoading: boolean;
}

function InstalledHistorySection({
  versionsQuery,
  detail,
  detailLoading
}: InstalledHistorySectionProps) {
  return (
    <div
      className="mb-3 rounded-sm border p-2"
      style={{
        borderColor: 'var(--w3-border-section)',
        background: 'rgba(15,23,42,0.40)',
        color: 'var(--w3-text)'
      }}
      aria-label="Installed history (read-only)"
    >
      <div
        className="mb-1.5 flex items-center gap-1.5 text-[10.5px] uppercase tracking-wide"
        style={{ color: 'var(--w3-text-muted)' }}
      >
        <RefreshCw size={11} />
        Installed history (read-only)
      </div>
      {versionsQuery.isLoading ? (
        <div className="flex items-center gap-1.5 text-[11px]">
          <Loader2 size={11} className="animate-spin" />
          Loading installed versions…
        </div>
      ) : versionsQuery.isError ? (
        <div className="text-[11px]" style={{ color: 'var(--status-danger)' }}>
          Failed to load installed versions:{' '}
          {(versionsQuery.error as Error)?.message ?? 'unknown'}
        </div>
      ) : (versionsQuery.data?.versions ?? []).length === 0 ? (
        <div className="text-[11px]" style={{ color: 'var(--w3-text-muted)' }}>
          No installed versions recorded under{' '}
          {versionsQuery.data?.root ?? consoleText('/opt/w3buildcost-update-packages/installed')}.
        </div>
      ) : (
        <ul className="space-y-1">
          {versionsQuery.data!.versions.map((v) => (
            <li
              key={v.version}
              className="rounded-sm border p-1.5 text-[10.5px] font-mono"
              style={{
                borderColor: 'var(--w3-border-section)',
                background: 'rgba(15,23,42,0.55)'
              }}
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span style={{ color: 'var(--w3-text)' }}>
                  v{v.version}
                </span>
                <span style={{ color: 'var(--w3-text-muted)' }}>
                  deployed: {v.deployedAt ?? '—'}
                </span>
                <span style={{ color: 'var(--w3-text-muted)' }}>
                  source: {v.source ?? '—'}
                </span>
                <span style={{ color: 'var(--w3-text-muted)' }}>
                  sha256: {shortSha(v.sha256)}
                </span>
                <span style={{ color: 'var(--w3-text-muted)' }}>
                  request-id: {v.requestId ?? '—'}
                </span>
              </div>
              <div
                className="break-all"
                style={{ color: 'var(--w3-text-muted)' }}
              >
                pkg: {v.packagePath ?? '— (metadata-only sidecar dir)'}
              </div>
              <div
                className="break-all"
                style={{ color: 'var(--w3-text-muted)' }}
              >
                log: {v.logPath ?? '—'}
              </div>
            </li>
          ))}
        </ul>
      )}

      {detailLoading ? (
        <div className="mt-2 flex items-center gap-1.5 text-[11px]">
          <Loader2 size={11} className="animate-spin" />
          Loading sidecar detail…
        </div>
      ) : detail ? (
        <div
          className="mt-2 rounded-sm border p-1.5 text-[10.5px] font-mono"
          style={{
            borderColor: 'var(--w3-accent-gold)',
            background: 'rgba(212,175,55,0.10)',
            color: 'var(--w3-text)'
          }}
        >
          <div>
            <span style={{ color: 'var(--w3-text-muted)' }}>
              selected version detail:
            </span>{' '}
            v{detail.version}
          </div>
          <div className="break-all">
            <span style={{ color: 'var(--w3-text-muted)' }}>canonical:</span>{' '}
            {detail.canonicalArchive}
          </div>
          <div>
            <span style={{ color: 'var(--w3-text-muted)' }}>sha256:</span>{' '}
            {detail.sha256 ?? '—'}
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface ResultPanelProps {
  id: PanelControlId;
  label: string;
  result: RunResponse | null;
}

function ResultPanel({ id, label, result }: ResultPanelProps) {
  if (!result) return null;
  const ok = result.runStatus === 'success';
  const s = result.structured ?? {};
  return (
    <div
      className="rounded-sm border p-2 text-[10.5px]"
      style={{
        borderColor: ok ? 'var(--status-success)' : 'var(--status-danger)',
        background: ok
          ? 'rgba(22,101,52,0.18)'
          : 'rgba(127,29,29,0.18)',
        color: 'var(--w3-text)'
      }}
      aria-label={`${label} result`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        {ok ? (
          <CheckCircle2 size={12} style={{ color: 'var(--status-success)' }} />
        ) : (
          <AlertTriangle size={12} style={{ color: 'var(--status-danger)' }} />
        )}
        <span
          className="font-mono uppercase tracking-wide"
          style={{
            color: ok ? 'var(--status-success)' : 'var(--status-danger)'
          }}
        >
          {label}: {result.runStatus}
        </span>
        <span
          className="font-mono"
          style={{ color: 'var(--w3-text-muted)' }}
        >
          control={id}
        </span>
        {typeof result.exitCode === 'number' ? (
          <span
            className="font-mono"
            style={{ color: 'var(--w3-text-muted)' }}
          >
            exit={result.exitCode}
          </span>
        ) : null}
        {typeof result.durationMs === 'number' ? (
          <span
            className="font-mono"
            style={{ color: 'var(--w3-text-muted)' }}
          >
            duration={result.durationMs}ms
          </span>
        ) : null}
        {result.requestId ? (
          <button
            type="button"
            onClick={() => copyToClipboard(result.requestId ?? '')}
            className="inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px]"
            style={{
              borderColor: 'var(--w3-border-section)',
              color: 'var(--w3-text-muted)',
              background: 'rgba(15,23,42,0.55)'
            }}
            title="Copy request id"
          >
            <Copy size={9} /> {result.requestId.slice(0, 8)}…
          </button>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-x-3 gap-y-0.5 font-mono md:grid-cols-2">
        <KV k="channel" v={s.channel} />
        <KV k="version" v={s.version} />
        <KV k="resolved_package_path" v={s.resolved_package_path} breakAll />
        <KV k="sha256" v={s.sha256} />
        <KV k="verified" v={s.verified} />
        <KV
          k="delegate_exit_code"
          v={typeof s.delegate_exit_code === 'number' ? s.delegate_exit_code : undefined}
        />
        <KV k="output_path" v={s.output_path} breakAll />
        <KV k="staged_path" v={s.staged_path} breakAll />
        <KV k="installed_metadata_dir" v={s.installed_metadata_dir} breakAll />
        <KV k="bytes" v={formatBytes(s.bytes)} />
        <KV k="package" v={s.package} />
        <KV k="branch" v={s.branch} />
        <KV k="head" v={s.head} />
      </div>

      {result.logFile ? (
        <div
          className="mt-1.5 flex items-center gap-1.5 rounded-sm border p-1 font-mono"
          style={{
            borderColor: 'var(--w3-border-section)',
            background: 'rgba(15,23,42,0.55)',
            color: 'var(--w3-text)'
          }}
        >
          <FileText size={11} style={{ color: 'var(--w3-text-muted)' }} />
          <span style={{ color: 'var(--w3-text-muted)' }}>log file:</span>
          <span className="break-all">{result.logFile}</span>
        </div>
      ) : null}

      {result.reason ? (
        <div
          className="mt-1.5 rounded-sm border p-1 font-mono"
          style={{
            borderColor: 'var(--w3-border-section)',
            background: 'rgba(15,23,42,0.55)',
            color: 'var(--w3-text)'
          }}
        >
          <span style={{ color: 'var(--w3-text-muted)' }}>reason:</span>{' '}
          {result.reason}
        </div>
      ) : null}

      {result.stdoutTail ? (
        <pre
          className="mt-1.5 max-h-44 overflow-x-auto whitespace-pre-wrap font-mono text-[10.5px] leading-snug"
          style={{ color: 'var(--w3-text)' }}
          aria-label={`${label} stdout tail`}
        >
          <span
            className="mb-0.5 inline-block text-[10px] uppercase tracking-wide"
            style={{ color: 'var(--w3-text-muted)' }}
          >
            stdout
          </span>
          {'\n'}
          {result.stdoutTail}
        </pre>
      ) : null}

      {result.stderrTail ? (
        <pre
          className="mt-1 max-h-44 overflow-x-auto whitespace-pre-wrap font-mono text-[10.5px] leading-snug"
          style={{ color: 'var(--status-warning)' }}
          aria-label={`${label} stderr tail`}
        >
          <span
            className="mb-0.5 inline-block text-[10px] uppercase tracking-wide"
            style={{ color: 'var(--status-warning)' }}
          >
            stderr
          </span>
          {'\n'}
          {result.stderrTail}
        </pre>
      ) : null}
    </div>
  );
}

function KV({
  k,
  v,
  breakAll
}: {
  k: string;
  v: unknown;
  breakAll?: boolean;
}) {
  let label: string;
  if (v === undefined || v === null || v === '') label = '—';
  else if (typeof v === 'boolean') label = v ? 'true' : 'false';
  else label = String(v);
  return (
    <div className={breakAll ? 'break-all' : undefined}>
      <span style={{ color: 'var(--w3-text-muted)' }}>{k}:</span> {label}
    </div>
  );
}
