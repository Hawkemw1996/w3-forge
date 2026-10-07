import { consoleText, consolePattern } from "../../../../../shared/consoleApp";
import type { RunResponse } from './controlsTypes';

export interface InstalledDeployment {
  version: string;
  requestId: string | null;
  deployedAt: string | null;
  packagePath: string | null;
  logPath?: string | null;
}

// null means a confirmed 404; undefined means the pre-run read was unavailable.
export interface DeploymentCheck {
  version?: string;
  before?: InstalledDeployment | null;
  response?: RunResponse;
}

export function deploymentVersion(inputs: Record<string, unknown>): string | undefined {
  const version = typeof inputs.version === 'string' ? inputs.version : '';
  if (/^v?\d+\.\d+\.\d+$/.test(version)) return version.replace(/^v/, '');
  const name = typeof inputs.packageName === 'string' ? inputs.packageName : '';
  return new RegExp(consolePattern("^w3buildcost-v(\\d+\\.\\d+\\.\\d+)\\.tar\\.gz$"), "").exec(name)?.[1];
}

export function needsDeploymentCheck(controlId: string, result: RunResponse): boolean {
  if (controlId !== 'pipeline-deploy-dev' || result.controlId !== controlId || !result.accepted) return false;
  // Explicit wrapper refusals/failures and real nonzero exits are final.
  // -1 is the runner's sentinel for a missing numeric exit code, not a deploy exit.
  if (result.structured?.status && !['success', 'launched-detached'].includes(result.structured.status)) return false;
  if (typeof result.structured?.delegate_exit_code === 'number' && result.structured.delegate_exit_code !== 0) return false;
  if (result.exitCode !== undefined && result.exitCode !== 0 && result.exitCode !== -1) return false;
  return result.runStatus === 'success' || (result.runStatus === 'failed' && result.exitCode === -1);
}

export async function readInstalledDeployment(version?: string): Promise<InstalledDeployment | null | undefined> {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`/api/admin/packages/installed/${version}`, {
      credentials: 'same-origin', headers: { Accept: 'application/json' },
      cache: 'no-store', signal: controller.signal
    });
    if (res.status === 404) return null;
    if (!res.ok) return undefined;
    const body = await res.json();
    return body?.success === true && body.data ? body.data as InstalledDeployment : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export function deploymentConfirmed(
  check: DeploymentCheck, record: InstalledDeployment | null | undefined,
  health: string | undefined, version: string | undefined
): record is InstalledDeployment {
  if (!check.version || !record || !['ok', 'healthy'].includes(health ?? '')) return false;
  if (version?.replace(/^v/, '') !== check.version || record.version?.replace(/^v/, '') !== check.version) return false;
  if (!record.packagePath || !record.requestId || !record.deployedAt || !Number.isFinite(Date.parse(record.deployedAt))) return false;
  const requestId = check.response?.requestId;
  if (requestId) return record.requestId === requestId;
  // A lost HTTP reply has no action handle. Only a known pre-run snapshot can
  // establish a newly installed record; an unavailable snapshot cannot prove it.
  if (check.before === undefined) return false;
  if (check.before === null) return true;
  return record.requestId !== check.before.requestId &&
    Number.isFinite(Date.parse(check.before.deployedAt ?? '')) &&
    Date.parse(record.deployedAt) > Date.parse(check.before.deployedAt!);
}
