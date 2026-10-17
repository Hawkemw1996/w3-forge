import http from 'node:http';
import os from 'node:os';

export interface TestEnvironment {
  id: string; name: string; image: string; state: string; status: string;
  createdAt: string | null; app: string | null; branch: string | null; commit: string | null;
  runId: string | null; purpose: string | null; ports: string[];
}
export interface EnvironmentInventory {
  host: string; observedAt: string; available: boolean; environments: TestEnvironment[]; message: string | null;
}
const text = (value: unknown, max = 160): string | null => typeof value === 'string' && !/[\x00-\x1f\x7f]/.test(value) ? value.slice(0, max) : null;
/** Summarize only explicitly marked Codex test containers. Never return env, commands or mounts. */
export function summarizeContainers(value: unknown): TestEnvironment[] {
  if (!Array.isArray(value) || value.length > 500) throw Error('Invalid inventory');
  return value.flatMap(item => {
    const labels = item?.Labels;
    if (labels?.['w3forge.managed-by'] !== 'codex' || labels?.['w3forge.environment'] !== 'test') return [];
    if (typeof item.Id !== 'string' || !/^[a-f0-9]{64}$/.test(item.Id)) throw Error('Invalid container');
    const commit = labels['w3forge.commit'];
    return [{ id: item.Id, name: text(item.Names?.[0]?.replace(/^\//, '')) ?? item.Id.slice(0, 12),
      image: text(item.Image) ?? 'Unknown', state: text(item.State, 40) ?? 'unknown', status: text(item.Status) ?? 'Unknown',
      createdAt: Number.isSafeInteger(item.Created) && item.Created > 0 && item.Created < 8640000000000 ? new Date(item.Created * 1000).toISOString() : null,
      app: text(labels['w3forge.app']), branch: text(labels['w3forge.branch']),
      commit: typeof commit === 'string' && /^[a-f0-9]{7,40}$/.test(commit) ? commit : null,
      runId: text(labels['w3forge.run-id']), purpose: text(labels['w3forge.purpose'], 240),
      ports: (Array.isArray(item.Ports) ? item.Ports : []).slice(0, 20).flatMap((port: any) =>
        Number.isInteger(port.PrivatePort) && port.PrivatePort > 0 && port.PrivatePort <= 65535 ?
          [(port.PublicPort && Number.isInteger(port.PublicPort) ? `${text(port.IP, 60) ?? ''}:${port.PublicPort} → ` : '') + `${port.PrivatePort}/${port.Type === 'udp' ? 'udp' : 'tcp'}`] : []) }];
  });
}

/** One fixed read-only Docker API request, with bounded time/output. No Docker CLI or control endpoint. */
export function dockerContainers(socketPath: string): Promise<unknown> {
  const filters = encodeURIComponent(JSON.stringify({ label: ['w3forge.managed-by=codex', 'w3forge.environment=test'] }));
  return new Promise((resolve, reject) => {
    const request = http.get({ socketPath, path: '/containers/json?all=1&filters=' + filters }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(Error('Docker unavailable')); return; }
      let bytes = 0; const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 524288) request.destroy(Error('Inventory too large')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); } });
    });
    const deadline = setTimeout(() => request.destroy(Error('Docker timed out')), 3000);
    request.on('error', reject); request.on('close', () => clearTimeout(deadline));
  });
}
export function createEnvironmentReader(load = () => dockerContainers(process.env.W3_FORGE_DOCKER_SOCKET ?? '/var/run/docker.sock')) {
  let pending: Promise<EnvironmentInventory> | undefined; let cached: EnvironmentInventory | undefined; let expires = 0;
  return async (): Promise<EnvironmentInventory> => {
    if (cached && Date.now() < expires) return cached;
    if (!pending) pending = (async () => {
      let result: EnvironmentInventory;
      try { result = { host: os.hostname(), observedAt: new Date().toISOString(), available: true, environments: summarizeContainers(await load()), message: null }; }
      catch { result = { host: os.hostname(), observedAt: new Date().toISOString(), available: false, environments: [], message: 'Docker test inventory is unavailable. Host access has not been verified.' }; }
      cached = result; expires = Date.now() + 3000; return result;
    })().finally(() => { pending = undefined; });
    return pending;
  };
}
