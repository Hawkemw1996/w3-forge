import { consoleText } from "../../../../../shared/consoleApp";
// =============================================================================
// W3 Core v0.12.10 — Admin Controls UI section map (frontend-only).
// =============================================================================
//
// v0.12.10: the 14 `pipeline-*` controls added to the backend registry after
// v0.5.28 had no explicit entry here, so every Controls-page render logged an
// "Unmapped control id" warning for each of them and dumped them all into
// Developer Tools. They are now mapped explicitly (Release Center for the
// forward pipeline, Recovery Center for the destructive rollback / reset /
// tag-deletion actions). The diagnostic fallback is intentionally retained
// for genuinely unmapped ids; no `pipeline-*` prefix rule is used. See
// hasExplicitUiSection() and the admin test suite, which cross-checks this
// map against the backend registry.
//
// Pure UI organization module. The backend registry's `category` field
// (system-health, logs-diagnostics, backups, packages-deploy,
// service-controls, dangerous-controls) is unchanged and remains part
// of the API contract.
//
// This module maps each control id to an operator-facing UI section
// and, in v0.5.28, also classifies controls as either visible in the
// default operator Controls page or hidden behind an opt-in toggle.
//
// v0.5.28 default-view filter (frontend-only):
//   - Controls with effectiveStatus === 'UI_READY' render by default.
//   - Controls with effectiveStatus === 'TERMINAL_ONLY' or 'DISABLED'
//     are hidden from the default Controls page. They remain in the
//     backend registry, in the /api/admin/controls payload, and in the
//     four-bucket counter. The page exposes a small collapsed
//     "Advanced / hidden controls" disclosure so operators can still
//     audit the full surface from one place.
//
// IMPORTANT: This is UI organization only. No control's id, status,
// enabled flag, runStrategy, riskLevel, effectiveStatus, inputSchema,
// confirmationSchema, timeoutSeconds, allowedRoles, or logCategory is
// changed. The four-bucket counter remains UI_READY 15 / NEEDS_WRAPPER 0
// / TERMINAL_ONLY 3 / DISABLED 1, identical to v0.5.27. No backend
// execution behavior, no script behavior, no auth, and no
// database/schema changes ship with this release.

import type { AdminControlPublic } from './controlsTypes';

export type UiSectionId =
  | 'main-controls'
  | 'backup-center'
  | 'release-center'
  | 'maintenance-center'
  | 'recovery-center'
  | 'developer-tools';

export interface UiSectionMeta {
  id: UiSectionId;
  label: string;
  description: string;
  order: number;
}

export const UI_SECTIONS: ReadonlyArray<UiSectionMeta> = [
  {
    id: 'main-controls',
    label: 'Operations Overview',
    description:
      'Triage essentials. Run any time. Read-only status, diagnostics, log inventory, and the safe service restart.',
    order: 1
  },
  {
    id: 'backup-center',
    label: 'Backup Center',
    description:
      consoleText('List, verify, create, and rehearsal-restore W3 BuildCost backups. Restore-Test runs in /opt/w3buildcost-restore-test/ and never touches /opt/w3buildcost or the live database.'),
    order: 2
  },
  {
    id: 'release-center',
    label: 'Release Center',
    description:
      consoleText('Inspect and verify staged release packages, snapshot the current installed state for forensics, and (when approved) deploy a release package. Also hosts the guided safe-pipeline steps (check remote, fetch tags, checkout / pull / push / test dev, package, verify, promote, tag, deploy). The legacy Deploy control (deploy-w3buildcost) remains disabled in the UI as a Proposal-D safeguard; pipeline deployment (pipeline-deploy-dev) remains available subject to its existing step gates and typed confirmations.'),
    order: 3
  },
  {
    id: 'maintenance-center',
    label: 'Maintenance Center',
    description:
      'Preview and clean up legacy / stale files. Cleanup-Legacy stays disabled in the UI until a dry-run-first safe wrapper is approved.',
    order: 4
  },
  {
    id: 'recovery-center',
    label: 'Recovery Center',
    description:
      'Recovery and destructive corrective actions: pipeline rollback, working-tree reset, and release-tag deletion (each HIGH risk with typed confirmation). Restore-From-Backup is disabled in the UI by design — it is reachable only from the terminal with explicit operator intent.',
    order: 5
  },
  {
    id: 'developer-tools',
    label: 'Developer Tools',
    description:
      'Diff inspection, patch verification, patch apply, and hard-reset of application data. Patch and hard-reset operations remain terminal-only.',
    order: 6
  }
];

// Source of truth: every Admin Control id is mapped to exactly one UI
// section. If a new control is added in a future release and not added
// here, controlsUiSectionFor() returns 'developer-tools' as a safe
// catch-all and the page logs a console warning so the gap is visible.
//
// This map is hand-derived from docs/CONTROLS_AND_SCRIPTS_AUDIT_v0.5.21.md
// recommendations. See docs/CONTROLS_UI_LAYOUT_v0.5.22.md for the
// per-control rationale.
const CONTROL_ID_TO_UI_SECTION: Record<string, UiSectionId> = {
  // Operations Overview — triage essentials.
  [consoleText('status-w3buildcost')]: 'main-controls',
  [consoleText('doctor-w3buildcost')]: 'main-controls',
  'logs-list': 'main-controls',
  'service-restart': 'main-controls',

  // Backup Center.
  'backup-list': 'backup-center',
  'backup-verify-latest': 'backup-center',
  'backup-create': 'backup-center',
  'restore-test': 'backup-center',

  // Release Center.
  'package-list': 'release-center',
  'package-verify-latest': 'release-center',
  'release-current': 'release-center',
  [consoleText('deploy-w3buildcost')]: 'release-center',

  // Maintenance Center.
  'cleanup-list': 'maintenance-center',
  'cleanup-legacy': 'maintenance-center',

  // Release Center — v0.12.10: safe-pipeline forward steps (registry
  // category packages-deploy, runStrategy safe-pipeline). Order follows the
  // guided Release Workflow.
  'pipeline-check-remote': 'release-center',
  'pipeline-fetch-tags': 'release-center',
  'pipeline-pull-latest': 'release-center',
  'pipeline-checkout-dev': 'release-center',
  'pipeline-push-dev': 'release-center',
  'pipeline-test-dev': 'release-center',
  'pipeline-package-dev': 'release-center',
  'pipeline-verify-dev-pkg': 'release-center',
  'pipeline-deploy-dev': 'release-center',
  'pipeline-create-tag': 'release-center',
  'pipeline-promote-dev-to-main': 'release-center',

  // Recovery Center.
  [consoleText('restore-w3buildcost')]: 'recovery-center',
  // v0.12.10: destructive / corrective pipeline actions are kept apart from
  // the forward release flow so operators do not meet them mid-workflow.
  'pipeline-rollback': 'recovery-center',
  'pipeline-reset-tree': 'recovery-center',
  'pipeline-delete-tag': 'recovery-center',

  // Developer Tools.
  'changed-files': 'developer-tools',
  'patch-verify': 'developer-tools',
  'patch-apply': 'developer-tools',
  'hardreset-data': 'developer-tools'
};

// v0.12.10: true iff `controlId` has an explicit entry in the section map
// (own property only — no prototype keys, no prefix heuristics). Used by the
// admin regression tests to prove every registered backend control id is
// mapped on purpose rather than landing in the fallback.
export function hasExplicitUiSection(controlId: string): boolean {
  return Object.prototype.hasOwnProperty.call(CONTROL_ID_TO_UI_SECTION, controlId);
}

// Section catch-all used for genuinely unmapped ids (see below).
export const UNMAPPED_CONTROL_FALLBACK_SECTION: UiSectionId = 'developer-tools';

export function controlsUiSectionFor(controlId: string): UiSectionId {
  const mapped = hasExplicitUiSection(controlId)
    ? CONTROL_ID_TO_UI_SECTION[controlId]
    : undefined;
  if (mapped) return mapped;
  // Safe catch-all. Surfaces in the console for operators so unmapped
  // controls are visible during dev. v0.12.10 maps all 33 registered
  // controls (19 legacy + 14 pipeline-*) explicitly, so this branch is only
  // hit if a future registry adds a new control without updating the
  // section map. The warning is deliberately NOT suppressed.
  if (typeof console !== 'undefined' && console.warn) {
    console.warn(
      `[controls] Unmapped control id "${controlId}" — falling back to developer-tools section.`
    );
  }
  return UNMAPPED_CONTROL_FALLBACK_SECTION;
}

// Build a section -> controls map from the flat list returned by the
// /api/admin/controls endpoint. The original backend `category` data
// on each control is preserved on the control object itself; this
// function only rebuckets for display.
//
// Returns sections in the order defined by UI_SECTIONS.order. Empty
// sections are returned with an empty `controls` array so the page can
// render a "no controls" placeholder if needed. v0.5.22 ships with no
// empty sections — every section has at least one control.
export interface UiSectionWithControls {
  meta: UiSectionMeta;
  controls: AdminControlPublic[];
}

export function buildUiSections(
  flatControls: AdminControlPublic[]
): UiSectionWithControls[] {
  const buckets = new Map<UiSectionId, AdminControlPublic[]>();
  for (const section of UI_SECTIONS) {
    buckets.set(section.id, []);
  }
  for (const c of flatControls) {
    const sectionId = controlsUiSectionFor(c.id);
    const arr = buckets.get(sectionId);
    if (arr) arr.push(c);
  }
  return [...UI_SECTIONS]
    .sort((a, b) => a.order - b.order)
    .map((meta) => ({
      meta,
      controls: buckets.get(meta.id) ?? []
    }));
}

// =============================================================================
// v0.5.28: default-view visibility filter.
// =============================================================================
//
// The default operator Controls page renders only controls whose
// `effectiveStatus` is 'UI_READY'. Controls in the 'TERMINAL_ONLY' or
// 'DISABLED' buckets are filtered out of the visible sections and
// surfaced separately in a collapsed disclosure so the full surface
// remains auditable but does not clutter the default view.
//
// This filter is frontend-only. The backend registry, the API payload,
// and the four-bucket counter are unchanged. Every hidden control's
// id, status, enabled flag, runStrategy, riskLevel, inputSchema,
// confirmationSchema, timeoutSeconds, and logCategory is preserved.
//
// Hidden-by-default controls in v0.5.28:
//   - cleanup-legacy   (DANGEROUS_DISABLED / runStrategy=disabled)
//   - patch-verify     (TERMINAL_ONLY / runStrategy=terminal-only)
//   - patch-apply      (TERMINAL_ONLY / runStrategy=terminal-only)
//   - hardreset-data   (TERMINAL_ONLY / runStrategy=terminal-only)
export function isControlVisibleByDefault(
  control: AdminControlPublic
): boolean {
  return control.effectiveStatus === 'UI_READY';
}

export interface PartitionedUiSections {
  // Sections containing only the controls visible in the default view.
  // Empty sections (no UI_READY controls) are dropped from this list so
  // the page does not render empty placeholders for advanced-only
  // sections such as Developer Tools or Recovery Center when nothing
  // there is currently UI_READY.
  visibleSections: UiSectionWithControls[];
  // Controls hidden from the default view (TERMINAL_ONLY + DISABLED).
  // Used to populate the collapsed "Advanced / hidden controls"
  // disclosure. Preserves registry order.
  hiddenControls: AdminControlPublic[];
  // Section memberships for hidden controls, so the disclosure can
  // label each hidden item with the section it would belong to if it
  // were enabled in the UI.
  hiddenControlSections: Record<string, UiSectionId>;
}

// Partition the section list into the default-visible view + a
// hidden-controls list. UI-only — backend registry is untouched.
export function partitionUiSections(
  flatControls: AdminControlPublic[]
): PartitionedUiSections {
  const visibleFlat: AdminControlPublic[] = [];
  const hiddenControls: AdminControlPublic[] = [];
  const hiddenControlSections: Record<string, UiSectionId> = {};
  for (const c of flatControls) {
    if (isControlVisibleByDefault(c)) {
      visibleFlat.push(c);
    } else {
      hiddenControls.push(c);
      hiddenControlSections[c.id] = controlsUiSectionFor(c.id);
    }
  }
  const allSections = buildUiSections(visibleFlat);
  const visibleSections = allSections.filter(
    (s) => s.controls.length > 0
  );
  return { visibleSections, hiddenControls, hiddenControlSections };
}
