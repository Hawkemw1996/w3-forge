import { consoleText } from "../../../../shared/consoleApp";
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EyeOff, ShieldAlert, Sliders } from 'lucide-react';
import { Badge } from '../components/ui/Badge';
import { SectionHeader } from '../components/ui/SectionHeader';
import { ErrorState, LoadingState } from '../components/ui/States';
import { adminGet } from '../lib/api';
import { ControlCard } from './controls/ControlCard';
import type {
  AdminControlPublic,
  AdminControlsResponse,
  EffectiveStatus,
  RiskLevel
} from './controls/controlsTypes';
import { UI_SECTIONS, partitionUiSections } from './controls/uiSections';
import type { UiSectionId } from './controls/uiSections';

// =============================================================================
// ControlsPage — Admin Center Controls tab.
// =============================================================================
//
// v0.5.28 — Release-readiness polish. The default Controls page now renders
// only UI_READY controls. Controls in the TERMINAL_ONLY and DISABLED buckets
// (cleanup-legacy, patch-verify, patch-apply, hardreset-data) are still
// present in the backend registry and in the /api/admin/controls payload,
// but are filtered out of the visible sections and surfaced in a small
// collapsed "Advanced / hidden controls" disclosure so the full surface
// remains auditable.
//
// No backend execution behavior, no script behavior, no auth, and no
// database/schema changes ship with this release. Every control's id,
// status, enabled flag, runStrategy, riskLevel, effectiveStatus,
// inputSchema, and confirmationSchema is preserved exactly. The
// four-bucket counter remains 15 UI ready / 0 needs wrapper / 3 terminal
// only / 1 disabled.

// Canonical four-bucket totals (v0.5.14+).
function effectiveTotalsLabel(
  byEffective: Record<EffectiveStatus, number> | undefined
): string {
  if (!byEffective) return '';
  const parts: string[] = [];
  if (byEffective.UI_READY) parts.push(`${byEffective.UI_READY} UI ready`);
  if (byEffective.NEEDS_WRAPPER) parts.push(`${byEffective.NEEDS_WRAPPER} needs wrapper`);
  if (byEffective.TERMINAL_ONLY) parts.push(`${byEffective.TERMINAL_ONLY} terminal only`);
  if (byEffective.DISABLED) parts.push(`${byEffective.DISABLED} disabled`);
  return parts.join(' · ');
}

function riskTotalsLabel(byRisk: Record<RiskLevel, number>): string {
  const parts: string[] = [];
  if (byRisk.LOW) parts.push(`${byRisk.LOW} low`);
  if (byRisk.MEDIUM) parts.push(`${byRisk.MEDIUM} medium`);
  if (byRisk.HIGH) parts.push(`${byRisk.HIGH} high`);
  if (byRisk.CRITICAL) parts.push(`${byRisk.CRITICAL} critical`);
  return parts.join(' · ');
}

// Stable lookup for the section label of a hidden control (used in the
// collapsed advanced disclosure). Falls back to "Developer Tools" if a
// future registry adds a hidden control without a section mapping.
const SECTION_LABEL_BY_ID = new Map(UI_SECTIONS.map((s) => [s.id, s.label]));

export function ControlsPage() {
  const q = useQuery({
    queryKey: ['admin', 'controls'],
    queryFn: () => adminGet<AdminControlsResponse>('/controls'),
    refetchInterval: 60_000
  });

  // Partition the flat control list into the default-visible view + a
  // hidden-by-default list. The backend `categories` payload is preserved
  // on each control but is no longer used for grouping at the page level.
  const partitioned = useMemo(() => {
    if (!q.data) {
      return {
        visibleSections: [],
        hiddenControls: [] as AdminControlPublic[],
        hiddenControlSections: {} as Record<string, UiSectionId>
      };
    }
    const flat: AdminControlPublic[] = q.data.categories.flatMap(
      (cat) => cat.controls
    );
    return partitionUiSections(flat);
  }, [q.data]);

  const hiddenCount = partitioned.hiddenControls.length;

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Controls"
        subtitle={consoleText("Operator actions for W3 BuildCost. Registry-driven, audit-logged, and gated by safe wrappers.")}
        actions={
          <>
            <Badge tone="warning">
              <ShieldAlert size={11} />
              Foundation
            </Badge>
            {q.data ? <Badge tone="gold">{q.data.release}</Badge> : null}
          </>
        }
      />

      {q.isLoading ? <LoadingState label="Loading control registry…" /> : null}
      {q.isError ? <ErrorState error={q.error} title="Failed to load controls" /> : null}

      {q.data ? (
        <>
          <div
            className="rounded-md border p-3 text-xs"
            style={{
              background: 'var(--w3-card)',
              borderColor: 'var(--w3-border-tile)',
              color: 'var(--w3-text-muted)'
            }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Sliders size={13} style={{ color: 'var(--w3-gold-400)' }} />
              <span className="font-medium text-[var(--w3-text)]">
                {q.data.counts.total} control{q.data.counts.total === 1 ? '' : 's'}
              </span>
              <span className="text-[var(--w3-text-dim)]">
                Buckets: {effectiveTotalsLabel(q.data.counts.byEffectiveStatus) || '—'}
              </span>
              <span className="text-[var(--w3-text-dim)]">
                Risk: {riskTotalsLabel(q.data.counts.byRisk) || '—'}
              </span>
            </div>
            <p className="mt-1.5 text-[11px]" style={{ color: 'var(--w3-text-dim)' }}>
              Cards below show only UI-ready controls. Each card describes
              what the action does, when to use it, what it affects, and any
              required confirmation. Terminal-only and disabled controls
              stay in the registry and remain reachable from the collapsed
              section at the bottom of this page.
            </p>
          </div>

          <div className="space-y-5">
            {partitioned.visibleSections.map((section) => {
              // Per-section UI_READY count for the header badge. The
              // visible view only contains UI_READY controls, so this is
              // also the section's total here.
              const visibleCount = section.controls.length;
              return (
                <section key={section.meta.id} id={`section-${section.meta.id}`}>
                  <header className="mb-2 flex flex-wrap items-end justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold text-[var(--w3-text)]">
                        {section.meta.label}
                      </h3>
                      <p className="text-[11px] text-[var(--w3-text-muted)]">
                        {section.meta.description}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone="slate">
                        {visibleCount} item{visibleCount === 1 ? '' : 's'}
                      </Badge>
                      {visibleCount > 0 ? (
                        <Badge tone="success">{visibleCount} UI ready</Badge>
                      ) : null}
                    </div>
                  </header>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {section.controls.map((c) => (
                      <ControlCard key={c.id} control={c} />
                    ))}
                  </div>
                </section>
              );
            })}

            {hiddenCount > 0 ? (
              <details
                className="rounded-md border"
                style={{
                  background: 'var(--w3-card)',
                  borderColor: 'var(--w3-border-tile)'
                }}
              >
                <summary
                  className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-xs"
                  style={{ color: 'var(--w3-text-muted)' }}
                >
                  <EyeOff size={13} style={{ color: 'var(--w3-text-dim)' }} />
                  <span className="font-medium text-[var(--w3-text)]">
                    Advanced / hidden controls
                  </span>
                  <Badge tone="slate">{hiddenCount} item{hiddenCount === 1 ? '' : 's'}</Badge>
                  <span className="text-[11px]" style={{ color: 'var(--w3-text-dim)' }}>
                    Terminal-only and disabled actions. Visible here for audit
                    only — they cannot be executed from the UI.
                  </span>
                </summary>
                <div
                  className="border-t px-3 py-3"
                  style={{ borderColor: 'var(--w3-border-section)' }}
                >
                  <ul
                    className="mb-3 space-y-1 text-[11px]"
                    style={{ color: 'var(--w3-text-muted)' }}
                  >
                    {partitioned.hiddenControls.map((c) => {
                      const sectionId =
                        partitioned.hiddenControlSections[c.id] ?? 'developer-tools';
                      const sectionLabel =
                        SECTION_LABEL_BY_ID.get(sectionId) ?? 'Developer Tools';
                      const bucketLabel =
                        c.effectiveStatus === 'TERMINAL_ONLY'
                          ? 'Terminal only'
                          : c.effectiveStatus === 'DISABLED'
                            ? 'Disabled'
                            : c.effectiveStatus;
                      return (
                        <li
                          key={c.id}
                          className="flex flex-wrap items-center gap-2"
                        >
                          <span
                            className="font-mono text-[10.5px]"
                            style={{ color: 'var(--w3-text-dim)' }}
                          >
                            {c.id}
                          </span>
                          <span className="text-[var(--w3-text)]">{c.label}</span>
                          <Badge
                            tone={
                              c.effectiveStatus === 'DISABLED' ? 'danger' : 'info'
                            }
                          >
                            {bucketLabel}
                          </Badge>
                          <span
                            className="text-[10.5px]"
                            style={{ color: 'var(--w3-text-dim)' }}
                          >
                            {sectionLabel} · {c.scriptName}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {partitioned.hiddenControls.map((c) => (
                      <ControlCard key={c.id} control={c} />
                    ))}
                  </div>
                </div>
              </details>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
