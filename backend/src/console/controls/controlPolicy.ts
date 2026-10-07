import type { AdminControl } from './types';
import { getAllowLegacyW3ForgeControls, getAllowReleasePipeline } from '../appConfigAccessors';

/**
 * Installation opt-ins gate the common operator workflows. The authority snapshot
 * describes app/agent authority; the canonical owner/operator release gate is the
 * per-action input/confirmation validator, whitelist and lock, not that metadata.
 */
export function controlPolicyReason(control: AdminControl): string | null {
  if (!getAllowLegacyW3ForgeControls()) return 'Operational controls are disabled by this installation’s configuration.';
  if (control.id.startsWith('pipeline-') && !getAllowReleasePipeline()) return 'The release pipeline is disabled by this installation’s configuration.';
  return null;
}

export function applyControlPolicy(control: AdminControl): AdminControl {
  const reason = controlPolicyReason(control);
  return reason ? { ...control, enabled: false, notes: reason + ' ' + (control.notes ?? '') } : control;
}
