import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { AdminListPage } from '../components/ui/AdminListPage';
import { Badge } from '../components/ui/Badge';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States';
import { formatBytes, formatTimestamp } from '../lib/format';
import { availableInventory, inventoryData, inventoryStatus, useBackupInventory, type BackupEntry } from '../lib/inventory';

// Core / BuildCost table-and-card presentation; no archive integrity is inferred.
export function BackupsPage() {
  const query = useBackupInventory();
  const data = inventoryData(query);
  const available = availableInventory(query);
  const status = inventoryStatus(query);
  const entries = available?.backups.slice().sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime)) || [];
  const latest = entries[0];
  const statusBody = query.isPending ? <div className="p-4"><LoadingState label="Loading backup inventory…" /></div>
    : query.isError ? <div className="p-4 space-y-3"><ErrorState title="Backup inventory unavailable" error={query.error} /><Retry query={query} /></div>
    : !available ? <div className="p-4 space-y-3"><EmptyState>{status.message}</EmptyState><Retry query={query} /></div> : null;
  return <AdminListPage header={{ title: 'Backups', subtitle: `Read-only backup file inventory for ${data?.app.name || 'W3 Forge'}.`, actions: <div className="flex max-w-[calc(100vw-3rem)] flex-wrap items-center gap-2">
    <Badge tone="warning">Read Only</Badge>{available ? <><Badge tone="slate">{entries.length} {available.truncated ? 'Listed ' : ''}File{entries.length === 1 ? '' : 's'}</Badge><Badge tone="gold">Listed Size {formatBytes(available.totalSizeBytes)}</Badge></> : null}
    <button type="button" className="btn" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={14} /> Refresh</button>
  </div> }}
    standardCard={{ title: 'Backup Inventory', right: <Badge tone={status.tone}>{status.label}</Badge>, body: <div className="space-y-2 text-xs text-[var(--w3-text-muted)]">
      <p>App: {data?.app.name || 'W3 Forge'}</p><p className="break-all">Directory: <code>{data ? data.root || 'Not configured' : query.isPending ? 'Checking…' : 'Unavailable'}</code></p><p>Files belong to this app's configured backup directory. Names, sizes and modification times are metadata only.</p><p>Archive contents, database inclusion and restore readiness have not been verified. File modification time is not a confirmed backup completion time.</p>{available?.truncated ? <p role="status">{status.message}</p> : null}
    </div> }}
    currentStateCard={{ title: 'Latest Backup File', subtitle: available?.truncated ? 'Newest modification time within this partial listing.' : 'Most recently modified file in the reported inventory.', flush: true, body: statusBody || (latest ? <BackupTable entries={[latest]} /> : <div className="p-4"><EmptyState>No backup files found.</EmptyState></div>) }}
    historyTables={[{ title: 'Backup History', subtitle: 'File inventory; each archive or database file is listed separately.', flush: true, body: statusBody || (entries.length ? <BackupTable entries={entries} /> : <div className="p-4"><EmptyState>No backup files found.</EmptyState></div>) }]}
    detailsSlot={<div className="flex flex-wrap gap-2"><Link className="btn" to="/packages">Packages</Link><Link className="btn" to="/production-readiness">Production Readiness</Link><Link className="btn" to="/settings">Settings</Link></div>} />;
}
function Retry({ query }: { query: ReturnType<typeof useBackupInventory> }) {
  return <button type="button" className="btn" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={13} /> Retry</button>;
}
function BackupTable({ entries }: { entries: BackupEntry[] }) {
  return <><div className="desktop-table overflow-x-auto"><table className="table-dark w-full"><thead><tr><th>Name</th><th>Version in name</th><th>File type</th><th>Size</th><th>Modified (UTC)</th><th>Verification</th></tr></thead><tbody>{entries.map(entry => <tr key={entry.name}>
    <td className="font-mono text-xs break-all">{entry.name}</td><td>{entry.parsedVersion ? <Badge tone="slate">v{entry.parsedVersion}</Badge> : '—'}</td><td><Badge tone="info">{entry.kind === 'database' ? 'Database file' : 'Archive'}</Badge></td><td>{formatBytes(entry.sizeBytes)}</td><td className="text-xs text-[var(--w3-text-muted)]">{formatTimestamp(entry.mtime)}</td><td><Badge tone="slate">Not verified</Badge></td>
  </tr>)}</tbody></table></div><div className="mobile-cards p-3">{entries.map(entry => <div className="stack-card" key={entry.name}>
    <div className="stack-card__row"><div className="stack-card__title font-mono break-all">{entry.name}</div></div><div className="stack-card__meta"><Badge tone="info">{entry.kind === 'database' ? 'Database file' : 'Archive'}</Badge>{entry.parsedVersion ? <Badge tone="slate">v{entry.parsedVersion}</Badge> : <span>Version unknown</span>}<span>{formatBytes(entry.sizeBytes)}</span><Badge tone="slate">Not verified</Badge></div><p className="text-xs text-[var(--w3-text-muted)]">Modified: {formatTimestamp(entry.mtime)} UTC</p>
  </div>)}</div></>;
}
