import { useQuery } from '@tanstack/react-query';
import { adminGet } from './api';

export interface InventoryBase {
  app: { id: string; name: string };
  root: string | null;
  connection: { configured: boolean; available: boolean; state: 'ready' | 'not_configured' | 'missing' | 'unavailable'; message: string | null };
  truncated: boolean;
}
export interface PackageEntry {
  name: string; path: string; sizeBytes: number; mtime: string; validName: boolean;
  parsedVersion: string | null; layout: 'canonical' | 'legacy-flat';
}
export interface PackagesInventory extends InventoryBase { packages: PackageEntry[] }
export interface BackupEntry { name: string; sizeBytes: number; mtime: string; parsedVersion: string | null; kind: 'archive' | 'database' }
export interface BackupsInventory extends InventoryBase { backups: BackupEntry[]; totalSizeBytes: number }
export type ArtifactInventory = PackagesInventory | BackupsInventory;
export interface InventoryQuery<T extends InventoryBase> { data?: T; isPending: boolean; isError: boolean; error: unknown }

export function usePackageInventory(kind: 'staged' | 'installed') {
  return useQuery({ queryKey: ['admin', 'packages', kind], queryFn: () => adminGet<PackagesInventory>(`/packages/${kind}`), refetchInterval: kind === 'staged' ? 30_000 : 60_000 });
}
export function useBackupInventory() {
  return useQuery({ queryKey: ['admin', 'backups'], queryFn: () => adminGet<BackupsInventory>('/backups'), refetchInterval: 60_000 });
}
/** Do not present cached inventories as current after an unsuccessful refresh. */
export function inventoryData<T extends InventoryBase>(query: InventoryQuery<T>): T | undefined {
  return query.isError || query.isPending ? undefined : query.data;
}
export function availableInventory<T extends InventoryBase>(query: InventoryQuery<T>): T | undefined {
  const data = inventoryData(query);
  return data?.connection.available && data.connection.state === 'ready' ? data : undefined;
}
export function inventoryStatus(query: InventoryQuery<InventoryBase>): { label: string; tone: 'slate' | 'danger' | 'warning' | 'info'; message: string } {
  if (query.isPending) return { label: 'Checking', tone: 'slate', message: 'Loading the app inventory.' };
  if (query.isError) return { label: 'Unavailable', tone: 'danger', message: query.error instanceof Error ? query.error.message : 'The inventory request failed. Retry to check this app’s storage.' };
  const data = inventoryData(query);
  if (!data) return { label: 'Unavailable', tone: 'slate', message: 'No inventory response is available.' };
  if (data.connection.state === 'not_configured') return { label: 'Not configured', tone: 'slate', message: data.connection.message || 'Configure this app’s inventory directory on the host.' };
  if (data.connection.state === 'missing') return { label: 'Directory missing', tone: 'warning', message: data.connection.message || 'The configured inventory directory does not exist on this host.' };
  if (!data.connection.available || data.connection.state !== 'ready') return { label: 'Unavailable', tone: 'warning', message: data.connection.message || 'The configured inventory directory cannot be read.' };
  return { label: data.truncated ? 'Partial listing' : 'Available', tone: data.truncated ? 'warning' : 'info', message: data.truncated ? 'The scan limit was reached. Counts and listed files are incomplete.' : 'Directory metadata is available. File contents have not been verified.' };
}
