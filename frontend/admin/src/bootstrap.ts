import { configureConsole } from '../../../shared/consoleApp';
/** Load app/machine settings before any canonical page computes a path or package pattern. */
export async function loadConsoleConfiguration(): Promise<void> {
  const response = await fetch('/api/admin/console-config', { credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store' });
  // The common auth gate handles unauthenticated/denied users; no operations render in those states.
  if (response.status === 401 || response.status === 403) return;
  const body = await response.json();
  if (!response.ok || body?.success !== true) throw new Error('The console configuration could not be loaded.');
  configureConsole(body.data);
}
