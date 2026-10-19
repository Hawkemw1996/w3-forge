import * as os from 'node:os';
import { readFile, statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';

export interface HardwareInventory {
  observedAt: string;
  host: string;
  scope: 'forge-host';
  os: { platform: string; release: string; architecture: string; uptimeSeconds: number };
  cpu: { model: string | null; logicalCores: number; clockMHz: number | null; loadAverage: number[] };
  memory: { totalBytes: number; availableBytes: number | null };
  storage: {
    available: boolean;
    message: string | null;
    devices: Array<{
      name: string; model: string | null; sizeBytes: number | null;
      type: string; rotational: boolean | null; transport: string | null;
    }>;
    root: { totalBytes: number; availableBytes: number } | null;
  };
  gpu: {
    available: boolean;
    message: string | null;
    devices: Array<{ name: string; memoryTotalMiB: number | null; driverVersion: string | null }>;
  };
}

export interface HardwareCommandOptions {
  timeout: number;
  maxBuffer: number;
  encoding: 'utf8';
  windowsHide: true;
  shell: false;
  env: { PATH: string; LANG: string; LC_ALL: string };
}

export interface HardwareSources {
  hostname(): string;
  platform(): string;
  release(): string;
  architecture(): string;
  uptime(): number;
  cpus(): ReadonlyArray<{ model: string; speed: number }>;
  loadAverage(): readonly number[];
  totalMemory(): number;
  readText(path: string): Promise<string>;
  execute(file: string, args: readonly string[], options: HardwareCommandOptions): Promise<{ stdout: string }>;
  statFilesystem(path: string): Promise<{ bsize: number | bigint; blocks: number | bigint; bavail: number | bigint }>;
}

export interface HardwareReaderOptions {
  sources?: Partial<HardwareSources>;
  now?: () => number;
}

const LSBLK = '/usr/bin/lsblk';
const LSBLK_ARGS = ['-J', '-b', '-d', '-o', 'NAME,MODEL,SIZE,TYPE,ROTA,TRAN'] as const;
const NVIDIA_SMI = '/usr/bin/nvidia-smi';
const NVIDIA_ARGS = ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'] as const;
const CACHE_MS = 5_000;
const COMMAND_ENV = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };

const defaultSources: HardwareSources = {
  hostname: os.hostname,
  platform: os.platform,
  release: os.release,
  architecture: os.arch,
  uptime: os.uptime,
  cpus: os.cpus,
  loadAverage: os.loadavg,
  totalMemory: os.totalmem,
  readText: (path) => readFile(path, 'utf8'),
  execute: (file, args, options) => new Promise((resolve, reject) => {
    execFile(file, [...args], options, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout });
    });
  }),
  statFilesystem: (path) => statfs(path),
};

function label(value: unknown, maximum = 160): string | null {
  if (typeof value !== 'string') return null;
  // Inventory exposes display fields only, never complete command output or errors.
  const clean = value.replace(/[^\p{L}\p{N} .,_()+:/@-]/gu, '').trim().slice(0, maximum);
  return clean || null;
}

function integer(value: unknown, minimum = 0): number | null {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value.trim()))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum ? number : null;
}

function safe<T>(read: () => T, fallback: T): T {
  try { return read(); } catch { return fallback; }
}

function memoryKilobytes(value: string): number | null {
  const match = /^\s*(\d+)\s+kB\s*$/.exec(value);
  if (!match) return null;
  const kilobytes = integer(match[1]);
  return kilobytes !== null && Number.isSafeInteger(kilobytes * 1024) ? kilobytes * 1024 : null;
}

async function memoryInventory(sources: HardwareSources): Promise<HardwareInventory['memory']> {
  const fallback = integer(safe(sources.totalMemory, 0)) ?? 0;
  try {
    const text = await sources.readText('/proc/meminfo');
    if (text.length > 65_536) return { totalBytes: fallback, availableBytes: null };
    const values = new Map<string, number | null>();
    for (const line of text.split('\n')) {
      const match = /^(MemTotal|MemAvailable):(.+)$/.exec(line);
      if (match) values.set(match[1], memoryKilobytes(match[2]));
    }
    const measuredTotal = values.get('MemTotal');
    const totalBytes = measuredTotal !== null && measuredTotal !== undefined && measuredTotal > 0 ? measuredTotal : fallback;
    const available = values.get('MemAvailable');
    return {
      totalBytes,
      // Free pages are not equivalent to Linux MemAvailable; do not substitute them.
      availableBytes: available !== null && available !== undefined && available <= totalBytes ? available : null,
    };
  } catch {
    return { totalBytes: fallback, availableBytes: null };
  }
}

function capacityProduct(left: number | bigint, right: number | bigint): number | null {
  try {
    if (typeof left === 'number' && !Number.isSafeInteger(left)) return null;
    if (typeof right === 'number' && !Number.isSafeInteger(right)) return null;
    const product = BigInt(left) * BigInt(right);
    return product >= 0n && product <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(product) : null;
  } catch { return null; }
}

async function rootCapacity(sources: HardwareSources): Promise<HardwareInventory['storage']['root']> {
  try {
    const stats = await sources.statFilesystem('/');
    if (stats.bsize <= 0 || stats.blocks < 0 || stats.bavail < 0) return null;
    const totalBytes = capacityProduct(stats.bsize, stats.blocks);
    const availableBytes = capacityProduct(stats.bsize, stats.bavail);
    return totalBytes !== null && totalBytes > 0 && availableBytes !== null && availableBytes <= totalBytes
      ? { totalBytes, availableBytes } : null;
  } catch { return null; }
}

function rotational(value: unknown): boolean | null {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return null;
}

async function storageInventory(sources: HardwareSources): Promise<HardwareInventory['storage']> {
  const rootPromise = rootCapacity(sources);
  let devices: HardwareInventory['storage']['devices'] = [];
  let message: string | null = null;
  try {
    const result = await sources.execute(LSBLK, LSBLK_ARGS, {
      timeout: 3_000, maxBuffer: 131_072, encoding: 'utf8', windowsHide: true, shell: false, env: { ...COMMAND_ENV },
    });
    if (result.stdout.length > 131_072) throw new Error('Inventory too large');
    const parsed: unknown = JSON.parse(result.stdout);
    if (!parsed || typeof parsed !== 'object' || !('blockdevices' in parsed) || !Array.isArray(parsed.blockdevices)) {
      throw new Error('Invalid inventory');
    }
    for (const entry of parsed.blockdevices.slice(0, 128)) {
      if (!entry || typeof entry !== 'object' || entry.type !== 'disk') continue;
      if (typeof entry.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(entry.name)) continue;
      devices.push({
        name: entry.name,
        model: label(entry.model),
        sizeBytes: integer(entry.size, 1),
        type: 'disk',
        rotational: rotational(entry.rota),
        transport: label(entry.tran, 32),
      });
    }
    if (devices.length === 0) message = 'No block devices were reported for this Forge host.';
  } catch {
    message = 'Block device inventory is unavailable on this Forge host.';
  }
  const root = await rootPromise;
  if (root === null && devices.length > 0) message = 'Root filesystem capacity is unavailable.';
  return { available: devices.length > 0, message, devices, root };
}

function csvFields(line: string): string[] | null {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) { fields.push(field.trim()); field = ''; }
    else field += character;
  }
  if (quoted) return null;
  fields.push(field.trim());
  return fields.length === 3 ? fields : null;
}

async function gpuInventory(sources: HardwareSources): Promise<HardwareInventory['gpu']> {
  try {
    const result = await sources.execute(NVIDIA_SMI, NVIDIA_ARGS, {
      timeout: 3_000, maxBuffer: 65_536, encoding: 'utf8', windowsHide: true, shell: false, env: { ...COMMAND_ENV },
    });
    if (result.stdout.length > 65_536) throw new Error('Inventory too large');
    const devices: HardwareInventory['gpu']['devices'] = [];
    for (const line of result.stdout.split(/\r?\n/).slice(0, 64)) {
      if (!line.trim()) continue;
      const fields = csvFields(line);
      if (!fields) continue;
      const name = label(fields[0]);
      if (!name) continue;
      const driverVersion = /^[\d]+(?:\.[\dA-Za-z]+)*$/.test(fields[2]) && fields[2].length <= 48 ? fields[2] : null;
      devices.push({ name, memoryTotalMiB: integer(fields[1], 1), driverVersion });
    }
    return devices.length > 0
      ? { available: true, message: null, devices }
      : { available: false, message: 'No NVIDIA GPU devices were reported for this Forge host.', devices: [] };
  } catch {
    return {
      available: false,
      message: 'NVIDIA GPU inventory is unavailable; GPU presence and health have not been verified.',
      devices: [],
    };
  }
}

/** Read-only inventory of hardware visible to the Forge service, including VM-assigned hardware. */
export function createHardwareReader(options: HardwareReaderOptions = {}): () => Promise<HardwareInventory> {
  const sources = { ...defaultSources, ...options.sources };
  const now = options.now ?? Date.now;
  let cached: HardwareInventory | undefined;
  let cachedAt = 0;
  let inFlight: Promise<HardwareInventory> | undefined;

  async function collect(): Promise<HardwareInventory> {
    const observedAt = new Date(now()).toISOString();
    const cpus = safe(sources.cpus, []);
    const uptime = safe(sources.uptime, 0);
    const speeds = cpus.map((cpu) => cpu.speed).filter((speed) => Number.isFinite(speed) && speed > 0 && speed <= 1_000_000);
    const [memory, storage, gpu] = await Promise.all([
      memoryInventory(sources), storageInventory(sources), gpuInventory(sources),
    ]);
    return {
      observedAt,
      host: label(safe(sources.hostname, ''), 128) ?? 'Unknown Forge host',
      scope: 'forge-host',
      os: {
        platform: label(safe(sources.platform, 'unknown'), 64) ?? 'unknown',
        release: label(safe(sources.release, 'unknown'), 128) ?? 'unknown',
        architecture: label(safe(sources.architecture, 'unknown'), 32) ?? 'unknown',
        uptimeSeconds: Number.isFinite(uptime) && uptime >= 0 ? Math.floor(uptime) : 0,
      },
      cpu: {
        model: cpus.map((cpu) => label(cpu.model)).find((model) => model !== null) ?? null,
        logicalCores: cpus.length,
        clockMHz: speeds.length > 0 ? Math.round(speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length) : null,
        loadAverage: safe(sources.loadAverage, []).slice(0, 3).filter((load) => Number.isFinite(load) && load >= 0),
      },
      memory, storage, gpu,
    };
  }

  return function readHardware(): Promise<HardwareInventory> {
    if (inFlight) return inFlight;
    if (cached && now() - cachedAt >= 0 && now() - cachedAt < CACHE_MS) return Promise.resolve(cached);
    inFlight = collect().then((inventory) => {
      cached = inventory;
      cachedAt = now();
      return inventory;
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
