import { describe, expect, it, vi } from 'vitest';
import { createHardwareReader, type HardwareSources } from '../src/workspace/hardware';

function fixture(overrides: Partial<HardwareSources> = {}) {
  const execute = vi.fn(async (file: string) => ({
    stdout: file === '/usr/bin/lsblk'
      ? JSON.stringify({ blockdevices: [{ name: 'vda', model: 'Virtual Disk', size: '100000000', type: 'disk', rota: false, tran: 'virtio' }] })
      : 'NVIDIA GeForce RTX 3090 Ti, 24576, 570.133.07\n',
  }));
  const sources: HardwareSources = {
    hostname: () => 'w3forge', platform: () => 'linux', release: () => '6.8.0-90-generic', architecture: () => 'x64',
    uptime: () => 1234.9,
    cpus: () => [{ model: 'Intel(R) Core(TM) i9-12900K', speed: 3200 }, { model: 'Intel(R) Core(TM) i9-12900K', speed: 3400 }],
    loadAverage: () => [0.2, 0.4, 0.6], totalMemory: () => 8 * 1024 ** 3,
    readText: async () => 'MemTotal:       16777216 kB\nMemFree: 100 kB\nMemAvailable:    8388608 kB\n',
    execute,
    statFilesystem: async () => ({ bsize: 4096, blocks: 1000, bavail: 400 }),
    ...overrides,
  };
  return { sources, execute };
}

describe('Forge host hardware inventory', () => {
  it('reports VM-visible CPU, memory, block devices, filesystem capacity and NVIDIA inventory with bounded fixed commands', async () => {
    const { sources, execute } = fixture();
    const read = createHardwareReader({ sources, now: () => Date.parse('2026-10-19T22:00:00Z') });
    const hardware = await read();
    expect(hardware).toMatchObject({
      observedAt: '2026-10-19T22:00:00.000Z', host: 'w3forge', scope: 'forge-host',
      os: { platform: 'linux', architecture: 'x64', uptimeSeconds: 1234 },
      cpu: { logicalCores: 2, clockMHz: 3300, loadAverage: [0.2, 0.4, 0.6] },
      memory: { totalBytes: 16 * 1024 ** 3, availableBytes: 8 * 1024 ** 3 },
      storage: { available: true, message: null, root: { totalBytes: 4096000, availableBytes: 1638400 }, devices: [{ name: 'vda', model: 'Virtual Disk', sizeBytes: 100000000, type: 'disk', rotational: false, transport: 'virtio' }] },
      gpu: { available: true, message: null, devices: [{ name: 'NVIDIA GeForce RTX 3090 Ti', memoryTotalMiB: 24576, driverVersion: '570.133.07' }] },
    });
    expect(execute).toHaveBeenCalledWith('/usr/bin/lsblk', ['-J', '-b', '-d', '-o', 'NAME,MODEL,SIZE,TYPE,ROTA,TRAN'], {
      timeout: 3000, maxBuffer: 131072, encoding: 'utf8', windowsHide: true, shell: false,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    });
    expect(execute).toHaveBeenCalledWith('/usr/bin/nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], {
      timeout: 3000, maxBuffer: 65536, encoding: 'utf8', windowsHide: true, shell: false,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    });
  });

  it('keeps available memory unknown when MemAvailable is absent rather than substituting free pages', async () => {
    const { sources } = fixture({ readText: async () => 'MemTotal: 4096 kB\nMemFree: 10 kB\n' });
    const hardware = await createHardwareReader({ sources })();
    expect(hardware.memory).toEqual({ totalBytes: 4194304, availableBytes: null });
  });

  it('rejects invalid memory values and preserves the OS total when procfs is unavailable', async () => {
    const malformed = fixture({ readText: async () => 'MemTotal: 9007199254740992 kB\nMemAvailable: -1 kB\n' });
    expect((await createHardwareReader({ sources: malformed.sources })()).memory).toEqual({ totalBytes: 8 * 1024 ** 3, availableBytes: null });
    const unavailable = fixture({ readText: async () => { throw new Error('credential=private'); } });
    const result = await createHardwareReader({ sources: unavailable.sources })();
    expect(result.memory).toEqual({ totalBytes: 8 * 1024 ** 3, availableBytes: null });
    expect(result.storage.available).toBe(true);
    expect(result.gpu.available).toBe(true);
    expect(JSON.stringify(result)).not.toContain('credential');
  });

  it('isolates command failures and never returns raw errors or claims absent GPU verification', async () => {
    const { sources } = fixture({ execute: async () => { throw new Error('token=private-command-secret'); } });
    const hardware = await createHardwareReader({ sources })();
    expect(hardware.cpu.logicalCores).toBe(2);
    expect(hardware.memory.totalBytes).toBe(16 * 1024 ** 3);
    expect(hardware.storage).toMatchObject({ available: false, devices: [], root: { totalBytes: 4096000 } });
    expect(hardware.gpu).toMatchObject({ available: false, devices: [] });
    expect(hardware.gpu.message).toContain('have not been verified');
    expect(JSON.stringify(hardware)).not.toContain('private-command-secret');
  });

  it('treats an empty or non-NVIDIA inventory as unverified with explicit empty states', async () => {
    const { sources } = fixture({ execute: async (file) => ({ stdout: file === '/usr/bin/lsblk' ? '{"blockdevices":[]}' : '' }) });
    const hardware = await createHardwareReader({ sources })();
    expect(hardware.storage).toMatchObject({ available: false, devices: [] });
    expect(hardware.storage.message).toContain('No block devices');
    expect(hardware.gpu).toMatchObject({ available: false, devices: [] });
    expect(hardware.gpu.message).toContain('No NVIDIA GPU');
  });

  it('returns only allowed fields and rejects unsafe device names, non-disks and invalid numeric values', async () => {
    const { sources } = fixture({ execute: async (file) => ({ stdout: file === '/usr/bin/lsblk' ? JSON.stringify({ blockdevices: [
      { name: 'loop0', type: 'loop', size: 100 },
      { name: '../private', type: 'disk', size: 100 },
      { name: 'vda', type: 'disk', size: '9007199254740992', rota: 'unknown', model: 'Disk\u0000 Model', tran: null, serial: 'secret-serial', uuid: 'secret-uuid', mountpoint: '/private' },
    ] }) : 'NVIDIA GPU, 9007199254740992, [N/A]\n' }) });
    const hardware = await createHardwareReader({ sources })();
    expect(hardware.storage.devices).toEqual([{ name: 'vda', type: 'disk', sizeBytes: null, rotational: null, model: 'Disk Model', transport: null }]);
    expect(hardware.gpu.devices).toEqual([{ name: 'NVIDIA GPU', memoryTotalMiB: null, driverVersion: null }]);
    expect(JSON.stringify(hardware)).not.toMatch(/secret-serial|secret-uuid|mountpoint/);
  });

  it('handles malformed command output independently while retaining valid measurements', async () => {
    const { sources } = fixture({ execute: async (file) => ({ stdout: file === '/usr/bin/lsblk' ? 'not JSON' : 'invalid GPU row\n"unclosed, 100, 570.1\n' }) });
    const hardware = await createHardwareReader({ sources })();
    expect(hardware.storage.available).toBe(false);
    expect(hardware.storage.root).not.toBeNull();
    expect(hardware.gpu.available).toBe(false);
    expect(hardware.memory.availableBytes).toBe(8 * 1024 ** 3);
  });

  it('uses null for unavailable CPU clock data and excludes invalid load measurements', async () => {
    const { sources } = fixture({ cpus: () => [{ model: '', speed: 0 }, { model: '', speed: Number.NaN }], loadAverage: () => [Number.NaN, -1, 2] });
    const hardware = await createHardwareReader({ sources })();
    expect(hardware.cpu).toEqual({ model: null, logicalCores: 2, clockMHz: null, loadAverage: [2] });
  });

  it('coalesces concurrent reads and refreshes all sources only after five seconds', async () => {
    let clock = Date.parse('2026-10-19T22:00:00Z');
    const { sources, execute } = fixture();
    const read = createHardwareReader({ sources, now: () => clock });
    const first = read();
    expect(read()).toBe(first);
    const initial = await first;
    expect(execute).toHaveBeenCalledTimes(2);
    clock += 4999;
    expect(await read()).toBe(initial);
    expect(execute).toHaveBeenCalledTimes(2);
    clock += 1;
    expect((await read()).observedAt).not.toBe(initial.observedAt);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('does not return nonfinite uptime from an unavailable host measurement', async () => {
    const { sources } = fixture({ uptime: () => Number.POSITIVE_INFINITY });
    expect((await createHardwareReader({ sources })()).os.uptimeSeconds).toBe(0);
  });

  it('handles bigint filesystem counts, rejects impossible capacity and isolates statfs failures', async () => {
    const bigint = fixture({ statFilesystem: async () => ({ bsize: 4096n, blocks: 1000n, bavail: 400n }) });
    expect((await createHardwareReader({ sources: bigint.sources })()).storage.root).toEqual({ totalBytes: 4096000, availableBytes: 1638400 });
    const impossible = fixture({ statFilesystem: async () => ({ bsize: 4096, blocks: 10, bavail: 11 }) });
    expect((await createHardwareReader({ sources: impossible.sources })()).storage.root).toBeNull();
    const unavailable = fixture({ statFilesystem: async () => { throw new Error('secret-path'); } });
    const hardware = await createHardwareReader({ sources: unavailable.sources })();
    expect(hardware.storage).toMatchObject({ available: true, root: null, message: 'Root filesystem capacity is unavailable.' });
    expect(JSON.stringify(hardware)).not.toContain('secret-path');
  });
});
