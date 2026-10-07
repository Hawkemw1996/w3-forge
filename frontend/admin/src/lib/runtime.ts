export interface RuntimeSystem {
  app: string; name: string; version: string; forgeRoot: string; startedAt: string;
  uptimeSeconds: number; host: string; platform: string; nodeVersion: string;
  authority: { mayDeploy: boolean; mayTagRelease: boolean; mayModifyProductionData: boolean };
  readOnlyFoundation?: boolean;
  memory?: { processRssBytes: number | null; processHeapUsedBytes: number | null; processHeapTotalBytes: number | null; hostTotalBytes: number | null; hostFreeBytes: number | null };
  cpu?: { cores: number; loadAverage: number[] | null };
  disk?: { root: string; sizeBytes: number; availableBytes: number; usedBytes: number } | null;
}
