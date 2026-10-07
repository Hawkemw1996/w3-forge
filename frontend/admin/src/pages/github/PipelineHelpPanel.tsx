import { consoleText } from "../../../../../shared/consoleApp";
// =============================================================================
// W3 Core v0.5.31 - "Release Pipeline Help" panel.
// =============================================================================
//
// Collapsible UI-only help / release-notes panel placed below the Release
// Pipeline. Three sections:
//
//   1. The 7 pipeline stages explained
//   2. What each HIGH-risk action actually does
//   3. The normal Perplexity dev-branch workflow
//
// Pure text. No backend call, no contract change, no script change.
// =============================================================================

import { useState } from 'react';
import { BookOpen, ChevronDown, ChevronRight, AlertTriangle, Workflow } from 'lucide-react';

interface StageEntry {
  num: number;
  title: string;
  body: string;
  controls: string;
  gate: string;
}

const STAGES: StageEntry[] = [
  {
    num: 1,
    title: 'Check Remote',
    body:
      'Confirm origin is reachable and refresh local tag refs before any pipeline action. Pure read.',
    controls: 'pipeline-check-remote, pipeline-fetch-tags',
    gate: 'pipeline-check-remote success'
  },
  {
    num: 2,
    title: 'Sync Dev Branch',
    body:
      'Pick the active dev/vX.Y.Z branch, check it out, fast-forward pull, and optionally push your local commits up to origin.',
    controls: 'pipeline-checkout-dev, pipeline-pull-latest, pipeline-push-dev',
    gate: 'pipeline-checkout-dev OR pipeline-pull-latest success'
  },
  {
    num: 3,
    title: 'Test Dev Branch',
    body:
      'Run install + build + lint + test on the checked-out dev branch. Required before packaging.',
    controls: 'pipeline-test-dev',
    gate: 'pipeline-test-dev success'
  },
  {
    num: 4,
    title: 'Package Dev Release',
    body:
      consoleText('Build the staged w3buildcost-vX.Y.Z.tar.gz artifact. HIGH-risk — writes to the staging dir. Requires Test ✓.'),
    controls: 'pipeline-package-dev',
    gate: 'pipeline-package-dev success'
  },
  {
    num: 5,
    title: 'Verify Package',
    body:
      'Read-only pre-flight check of the staged tarball: hashes, manifest, version markers. Requires Package ✓.',
    controls: 'pipeline-verify-dev-pkg',
    gate: 'pipeline-verify-dev-pkg success'
  },
  {
    num: 6,
    title: 'Deploy Release',
    body:
      'Pipeline-side deploy action. HIGH-risk — live runtime swap. Requires Verify ✓.',
    controls: 'pipeline-deploy-dev',
    gate: 'pipeline-deploy-dev success'
  },
  {
    num: 7,
    title: 'Tag & Recovery',
    body:
      'Create or delete the release tag once Deploy is complete. Rollback / reset are recovery surfaces and remain available regardless of stage gating.',
    controls:
      'pipeline-create-tag, pipeline-delete-tag, pipeline-rollback, pipeline-reset-tree',
    gate: 'always enabled (recovery surface) — Tag itself recommends Deploy ✓ first'
  }
];

interface HighRiskEntry {
  control: string;
  description: string;
}

const HIGH_RISK: HighRiskEntry[] = [
  {
    control: 'pipeline-package-dev',
    description:
      consoleText('Builds the w3buildcost-vX.Y.Z.tar.gz artifact into the staging directory. Overwrites prior staged artifact for the same version.')
  },
  {
    control: 'pipeline-deploy-dev',
    description:
      'Extracts the verified staged tarball into the live runtime root. Triggers process restart. Reversible only via pipeline-rollback.'
  },
  {
    control: 'pipeline-create-tag',
    description:
      'Creates an annotated git tag at the current HEAD. Once pushed, this tag becomes the canonical release marker on origin.'
  },
  {
    control: 'pipeline-delete-tag',
    description:
      'Deletes a release tag locally AND on origin. Requires typed phrase DELETE-TAG. Irreversible without re-tagging from a saved SHA.'
  },
  {
    control: 'pipeline-rollback',
    description:
      'Restores the previous deploy artifact into the live runtime root. Process restarts.'
  },
  {
    control: 'pipeline-reset-tree',
    description:
      consoleText('Resets the working tree at /opt/w3buildcost-deploy to a known SHA. Discards uncommitted changes in that checkout.')
  }
];

const WORKFLOW: string[] = [
  '1. Create a Perplexity Space task on dev/vX.Y.Z. Approve a scoped plan.',
  '2. Branch off origin/main as dev/vX.Y.Z. Never work directly on main.',
  '3. Implement changes inside the approved scope. Stay frontend-only when possible.',
  '4. Run Safe Preflight at the top of the page to warm up Check Remote + Fetch Tags + lists.',
  '5. Walk stages 1 → 6 in order. Honor disabled-state explanations.',
  '6. Tag only after Deploy ✓. HIGH-risk actions require typed confirmation.',
  '7. Commit a single focused commit: vX.Y.Z <short description>. Push to origin/dev/vX.Y.Z.',
  '8. Open a PR into main. Merge only after operator review.',
  '9. The merge into main + tag are owner-driven. The pipeline UI does not push to main.'
];

function SectionHeader({
  icon,
  label,
  open,
  onToggle
}: {
  icon: React.ReactNode;
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left text-[12px]"
      style={{
        borderColor: 'var(--w3-border-section)',
        background: 'rgba(15,23,42,0.55)',
        color: 'var(--w3-text)'
      }}
      onClick={onToggle}
      aria-expanded={open}
    >
      <span className="flex items-center gap-2">
        {icon}
        <span className="font-semibold uppercase tracking-wide">{label}</span>
      </span>
      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
    </button>
  );
}

export function PipelineHelpPanel() {
  const [open, setOpen] = useState<boolean>(false);
  const [openSection, setOpenSection] = useState<'stages' | 'highrisk' | 'workflow' | null>(
    'stages'
  );

  return (
    <div
      className="rounded-md border p-3"
      style={{
        borderColor: 'var(--w3-border-section)',
        background: 'rgba(15,23,42,0.35)'
      }}
    >
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          <BookOpen size={14} style={{ color: 'var(--w3-gold)' }} />
          <span className="text-[12px] font-semibold uppercase tracking-wide"
                style={{ color: 'var(--w3-text)' }}>
            Release Pipeline Help &amp; Notes
          </span>
        </span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>

      {open ? (
        <div className="mt-3 space-y-3">
          {/* Stages 1-7 */}
          <div>
            <SectionHeader
              icon={<Workflow size={12} style={{ color: 'var(--status-info)' }} />}
              label="The 7 Pipeline Stages"
              open={openSection === 'stages'}
              onToggle={() =>
                setOpenSection(openSection === 'stages' ? null : 'stages')
              }
            />
            {openSection === 'stages' ? (
              <ol className="mt-2 space-y-2">
                {STAGES.map((s) => (
                  <li
                    key={s.num}
                    className="rounded-md border p-2"
                    style={{ borderColor: 'var(--w3-border-section)' }}
                  >
                    <div className="text-[11.5px] font-semibold"
                         style={{ color: 'var(--w3-text)' }}>
                      {s.num}. {s.title}
                    </div>
                    <div className="mt-1 text-[11px]"
                         style={{ color: 'var(--w3-text-muted)' }}>
                      {s.body}
                    </div>
                    <div className="mt-1 font-mono text-[10.5px]"
                         style={{ color: 'var(--w3-text)' }}>
                      controls: {s.controls}
                    </div>
                    <div className="font-mono text-[10.5px]"
                         style={{ color: 'var(--w3-text-muted)' }}>
                      gate: {s.gate}
                    </div>
                  </li>
                ))}
              </ol>
            ) : null}
          </div>

          {/* HIGH-risk actions */}
          <div>
            <SectionHeader
              icon={<AlertTriangle size={12} style={{ color: 'var(--status-danger)' }} />}
              label="HIGH-Risk Actions"
              open={openSection === 'highrisk'}
              onToggle={() =>
                setOpenSection(openSection === 'highrisk' ? null : 'highrisk')
              }
            />
            {openSection === 'highrisk' ? (
              <ul className="mt-2 space-y-2">
                {HIGH_RISK.map((h) => (
                  <li
                    key={h.control}
                    className="rounded-md border p-2"
                    style={{
                      borderColor: 'var(--status-danger)',
                      background: 'rgba(127,29,29,0.18)'
                    }}
                  >
                    <div className="font-mono text-[11.5px]"
                         style={{ color: 'var(--w3-text)' }}>
                      {h.control}
                    </div>
                    <div className="mt-1 text-[11px]"
                         style={{ color: 'var(--w3-text-muted)' }}>
                      {h.description}
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {/* Workflow */}
          <div>
            <SectionHeader
              icon={<BookOpen size={12} style={{ color: 'var(--w3-gold)' }} />}
              label="Normal Perplexity Dev-Branch Workflow"
              open={openSection === 'workflow'}
              onToggle={() =>
                setOpenSection(openSection === 'workflow' ? null : 'workflow')
              }
            />
            {openSection === 'workflow' ? (
              <ol className="mt-2 space-y-1 text-[11.5px]"
                  style={{ color: 'var(--w3-text)' }}>
                {WORKFLOW.map((line) => (
                  <li key={line} className="font-mono text-[11px]">
                    {line}
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
