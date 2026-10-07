/** Configuration boundary for the canonical W3 admin console. No workflow flags. */
export interface ConsoleAppConfig {
  id: string; name: string; permissionPrefix: string; productBase: string;
  repositoryUrl: string | null; packageStem: string; serviceName: string; databaseName: string;
  paths: { runtime: string; deploy: string; packages: string; backups: string; logs: string; scripts: string; restoreTest: string };
  legacyBackupCutoff: string | null;
  terminalTarget: 'host' | 'container';
}
export const consoleApp: ConsoleAppConfig = {
  id: 'w3forge', name: 'W3 Forge', permissionPrefix: 'forge', productBase: '/forge',
  repositoryUrl: null, packageStem: 'w3forge', serviceName: 'w3forge-admin.service', databaseName: 'w3forge',
  paths: { runtime: '/opt/w3forge', deploy: '/opt/w3forge-deploy', packages: '/opt/w3forge-update-packages',
    backups: '/opt/backups/w3forge', logs: '/opt/logs/w3forge', scripts: '/opt/w3forge-scripts', restoreTest: '/opt/w3forge-restore-test' },
  legacyBackupCutoff: null, terminalTarget: 'host'
};
/** Called before importing page modules; backend supplies this installation's public configuration. */
export function configureConsole(value: unknown): void {
  if (!value || typeof value !== 'object') throw new Error('Console configuration is unavailable.');
  const input = value as Partial<ConsoleAppConfig>;
  for (const key of ['id', 'name', 'permissionPrefix', 'productBase', 'packageStem', 'serviceName', 'databaseName'] as const) {
    if (typeof input[key] !== 'string' || !input[key]?.trim()) throw new Error('Console configuration is incomplete.');
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(input.packageStem!)) throw new Error('Invalid package identity.');
  if (!/^\/[a-z0-9_-]+$/i.test(input.productBase!)) throw new Error('Invalid product base.');
  for (const key of Object.keys(consoleApp.paths) as Array<keyof ConsoleAppConfig['paths']>) {
    if (typeof input.paths?.[key] !== 'string' || !input.paths[key].trim()) throw new Error('Console paths are incomplete.');
  }
  if (input.legacyBackupCutoff !== null && (typeof input.legacyBackupCutoff !== 'string' || !Number.isFinite(Date.parse(input.legacyBackupCutoff)))) throw new Error('Invalid backup policy.');
  if (input.terminalTarget !== undefined && !['host', 'container'].includes(input.terminalTarget)) throw new Error('Invalid terminal target.');
  if (input.repositoryUrl !== undefined && input.repositoryUrl !== null) {
    if (typeof input.repositoryUrl !== 'string') throw new Error('Invalid repository URL.');
    const url = new URL(input.repositoryUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid repository URL.');
  }
  Object.assign(consoleApp, input, { paths: { ...input.paths } });
}
/** Translate canonical identity literals without changing page markup or workflow logic. */
export function consoleText(reference: string): string {
  const replacements: Record<string, string> = {
    '/opt/w3buildcost-update-packages': consoleApp.paths.packages,
    '/opt/w3buildcost-restore-test': consoleApp.paths.restoreTest,
    '/opt/w3buildcost-backups': consoleApp.paths.backups,
    '/opt/w3buildcost-scripts': consoleApp.paths.scripts,
    '/opt/w3buildcost-deploy': consoleApp.paths.deploy,
    '/opt/logs/w3buildcost': consoleApp.paths.logs,
    '/opt/w3buildcost': consoleApp.paths.runtime,
    'journalctl -u w3buildcost': 'journalctl -u ' + consoleApp.serviceName,
    'w3buildcost service': consoleApp.serviceName + ' service',
    'W3 BuildCost': consoleApp.name, 'W3BuildCost': consoleApp.name,
    'BuildCost': consoleApp.name.replace(/^W3\s*/, ''),
    '/buildcost': consoleApp.productBase,
    'w3buildcost': consoleApp.packageStem, 'buildcost': consoleApp.permissionPrefix
  };
  const keys = Object.keys(replacements).sort((a, b) => b.length - a.length);
  const escaped = keys.map(escapePattern);
  return reference.replace(new RegExp(escaped.join('|'), 'g'), match => replacements[match]);
}
/** A configured stem is escaped before insertion into the canonical package validation regex. */
export function consolePattern(reference: string): string {
  return reference.split('w3buildcost').join(escapePattern(consoleApp.packageStem));
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Machine terminology is configuration; terminal markup and controls are shared. */
export function consoleMachineText(reference: string): string {
  return reference.replace(/Container|container/g, token => token === 'Container' ? consoleApp.terminalTarget[0].toUpperCase() + consoleApp.terminalTarget.slice(1) : consoleApp.terminalTarget);
}
