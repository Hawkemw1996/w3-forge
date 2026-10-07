import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { env } from '../config/env';
import { readContainerMemory } from '../services/memoryReader';
import { dbStatus, readRootVolume } from './routes/systemRoutes';
import { snapshotCurrent, LockSnapshot } from './controls/actionLock';
import { BACKUPS_DIR, DEPLOY_DIR, LOGS_ROOT, UPDATE_PACKAGES_DIR,
  UPDATE_PACKAGES_DEV_DIR, UPDATE_PACKAGES_MAIN_DIR, UPDATE_PACKAGES_INSTALLED_DIR } from './paths';

export interface AttentionItem {
  id: string; label: string; detail: string;
  severity: 'red' | 'amber' | 'gold' | 'info'; href: string; source: string;
}
export interface AttentionSource { id: string; label: string; status: 'ok' | 'unknown'; detail: string; }
interface Observation { items: AttentionItem[]; detail: string; unknown?: boolean; }
interface AttentionPaths {
  deploy: string; backups: string; packages: string; dev: string; main: string;
  installed: string; logs: string; audit: string; detached: string;
}
export interface AttentionOptions {
  now?: number; paths?: Partial<AttentionPaths>; version?: string; allowedIps?: string;
  git?: (args: string[]) => Promise<string>;
  database?: typeof dbStatus; disk?: typeof readRootVolume;
  memory?: typeof readContainerMemory; processMemory?: () => NodeJS.MemoryUsage;
  lock?: () => LockSnapshot | null; timeoutMs?: number;
}
// Backup limits match Production Readiness. Recovery's 24h notice is a
// dashboard display window, never an operational retention or lock policy.
export const ATTENTION_LIMITS = { backupWarningHours: 24, backupCriticalHours: 168,
  recoveryNoticeHours: 24, maxEntries: 1000, maxLogFiles: 24, maxTailBytes: 262144,
  maxArchiveBytes: 256 * 1024 * 1024, maxPackageComparisons: 12, timeoutMs: 6000 };
const HOUR = 3600000;
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;
const DEPLOYS = new Set(['deploy-w3forge', 'pipeline-deploy-dev', 'pipeline-rollback']);
const RECOVERY = new Set(['restore-w3forge', 'hardreset-data']);
const executeFile = promisify(execFile);
const cleanText = (value: string, max = 180) => value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max);
const item = (source: string, id: string, label: string, detail: string,
  severity: AttentionItem['severity'], href: string): AttentionItem => ({ source, id, label, detail, severity, href });

async function directory(dir: string, optional = false) {
  try {
    const handle = await fs.opendir(dir);
    const result: import('node:fs').Dirent[] = [];
    for await (const entry of handle) {
      if (result.length >= ATTENTION_LIMITS.maxEntries) throw new Error('Directory exceeds scan limit');
      result.push(entry);
    }
    return result;
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
async function tail(file: string, maxBytes = ATTENTION_LIMITS.maxTailBytes) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Not a regular file');
    const size = Math.min(stat.size, maxBytes); const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, Math.max(0, stat.size - size));
    const text = buffer.toString('utf8');
    return { text: stat.size > size ? text.slice(text.indexOf('\n') + 1) : text,
      mtime: stat.mtimeMs, truncated: stat.size > size };
  } finally { await handle.close(); }
}
async function regularFile(file: string) {
  const stat = await fs.lstat(file);
  if (!stat.isFile()) throw new Error('Expected regular file');
  return stat;
}

export function parseGitChanges(raw: string) {
  const tokens = raw.split('\0'); const files: Array<{ mode: string; file: string }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const record = tokens[i]; if (!record) continue;
    if (record.length < 4) throw new Error('Malformed git status');
    const mode = record.slice(0, 2); let filename = record.slice(3);
    if (/[RC]/.test(mode)) filename = `${tokens[++i] ?? '?'} → ${filename}`;
    files.push({ mode, file: cleanText(filename) });
  }
  return { count: files.length, staged: files.filter((f) => ![' ', '?'].includes(f.mode[0])).length,
    unstaged: files.filter((f) => ![' ', '?'].includes(f.mode[1])).length,
    untracked: files.filter((f) => f.mode === '??').length, files: files.slice(0, 8) };
}
async function gitObservation(git: (args: string[]) => Promise<string>, version: string): Promise<Observation> {
  const [raw, tagResult] = await Promise.all([git(['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
    git(['describe', '--tags', '--always', '--abbrev=0'])]);
  const changes = parseGitChanges(raw); const items: AttentionItem[] = []; const tag = tagResult.trim();
  if (VERSION.test(tag) && tag.replace(/^v/, '') !== version.replace(/^v/, '')) items.push(item('git', 'version-tag-mismatch',
    'Runtime Version Differs From Checkout Tag', `Running v${version.replace(/^v/, '')} · checkout tag ${cleanText(tag)}`, 'amber', '/github'));
  if (changes.count) items.push(item('git', 'working-tree-dirty', 'Working Tree Is Dirty',
    `${changes.count} changed paths (${changes.staged} staged, ${changes.unstaged} unstaged, ${changes.untracked} untracked). ` +
    changes.files.map((f) => `${f.mode.replace(/ /g, '·')} ${f.file}`).join('; ') +
    (changes.count > changes.files.length ? '; additional paths omitted.' : ''), 'amber', '/github'));
  const versionKnown = VERSION.test(tag) && VERSION.test(version);
  return { items, unknown: !versionKnown, detail: versionKnown
    ? `Checked local working tree and reachable release tag; ${changes.count} changed paths. Porcelain codes describe index/worktree state, not the cause of a modification.`
    : `Checked local working tree; ${changes.count} changed paths. ${VERSION.test(tag) ? 'Running version is unavailable.' : 'No reachable release version tag was found; a commit hash is not a release tag.'} Version comparison is unavailable.` };
}
async function backupObservation(dir: string, now: number): Promise<Observation> {
  const entries = await directory(dir); const pairs = new Map<string, { app?: number; db?: number }>();
  const complete: number[] = []; let invalid = false;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const paired = /^w3forge_(app|db)_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.(tar\.gz|sql)$/.exec(entry.name);
    const versioned = /^w3forge-(?:backup-v\d+\.\d+\.\d+|v\d+\.\d+\.\d+-backup)-\d{8}-\d{6}\.tar\.gz$/.test(entry.name);
    if (!paired && !versioned) continue;
    if (paired && ((paired[1] === 'app') !== (paired[3] === 'tar.gz'))) continue;
    const stat = await regularFile(path.join(dir, entry.name));
    if (stat.size <= 0 || stat.mtimeMs > now + 5 * 60000) { invalid = true; continue; }
    if (versioned) complete.push(stat.mtimeMs);
    if (paired) { const pair = pairs.get(paired[2]) ?? {}; pair[paired[1] as 'app' | 'db'] = stat.mtimeMs; pairs.set(paired[2], pair); }
  }
  for (const pair of pairs.values()) if (pair.app != null && pair.db != null) complete.push(Math.min(pair.app, pair.db));
  const latest = complete.length ? Math.max(...complete) : null;
  if (latest === null) return { items: [item('backup', 'backup-stale', 'No Complete Backup Found',
    'No nonempty matching app/database pair or versioned backup archive was found.', 'red', '/backups')],
    detail: 'Backup directory read; no complete backup found.', unknown: invalid };
  const age = Math.max(0, (now - latest) / HOUR);
  return { items: age >= 24 ? [item('backup', 'backup-stale', 'Backup Has Not Run Recently',
    `Newest complete backup is ${age.toFixed(1)} hours old. Warning: 24 hours; critical: 7 days.`, age >= 168 ? 'red' : 'amber', '/backups')] : [],
    detail: `Newest complete backup: ${new Date(latest).toISOString()}. Archive contents are not verified.` };
}

interface Archive { file: string; version: string; channel: string; }
async function archives(root: string, channel: string, optional = false): Promise<Archive[]> {
  const entries = await directory(root, optional); const found: Archive[] = [];
  for (const entry of entries) {
    let file: string; let version: string; const legacy = /^w3forge-v(\d+\.\d+\.\d+)\.tar\.gz$/.exec(entry.name);
    if (entry.isFile() && legacy) { file = path.join(root, entry.name); version = legacy[1]; }
    else if (entry.isDirectory() && /^v\d+\.\d+\.\d+$/.test(entry.name)) { file = path.join(root, entry.name, 'w3forge.tar.gz'); version = entry.name.slice(1); }
    else continue;
    try { const stat = await regularFile(file); if (stat.size > 0) found.push({ file, version, channel }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return found;
}
const digestCache = new Map<string, { identity: string; value: string }>();
async function digest(file: string): Promise<string> {
  const stat = await regularFile(file);
  if (stat.size > ATTENTION_LIMITS.maxArchiveBytes) throw new Error('Archive exceeds checksum limit');
  const identity = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
  const cached = digestCache.get(file); if (cached?.identity === identity) return cached.value;
  const handle = await fs.open(file, 'r');
  try {
    const hash = createHash('sha256'); const buffer = Buffer.alloc(65536); let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (!bytesRead) throw new Error('Archive changed while checksumming');
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await handle.stat();
    if ([after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs].join(':') !== identity) throw new Error('Archive changed while checksumming');
    const value = hash.digest('hex'); if (digestCache.size >= 64) digestCache.clear(); digestCache.set(file, { identity, value }); return value;
  } finally { await handle.close(); }
}
function compareVersions(a: string, b: string) {
  const av = a.replace(/^v/, '').split('.').map(Number); const bv = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i] - bv[i]; return 0;
}
async function packageObservation(paths: AttentionPaths, version: string): Promise<Observation> {
  if (!VERSION.test(version)) throw new Error('Running version unavailable');
  const [legacy, dev, main] = await Promise.all([archives(paths.packages, 'staged'), archives(paths.dev, 'dev', true), archives(paths.main, 'main', true)]);
  const candidates = [...legacy, ...dev, ...main].filter((a) => compareVersions(a.version, version) >= 0);
  if (candidates.length > ATTENTION_LIMITS.maxPackageComparisons) throw new Error('Too many packages to compare');
  const pending: Archive[] = []; let unknown = false;
  for (const archive of candidates) {
    if (compareVersions(archive.version, version) > 0) { pending.push(archive); continue; }
    let installedDigest: string | null = null;
    for (const file of [path.join(paths.installed, `v${archive.version}`, 'w3forge.tar.gz'), path.join(paths.installed, `w3forge-v${archive.version}.tar.gz`)]) {
      try { installedDigest = await digest(file); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { unknown = true; break; } }
    }
    if (!installedDigest) {
      try { const file = path.join(paths.installed, `v${archive.version}`, 'sha256.txt'); await regularFile(file);
        const value = (await tail(file, 1024)).text.trim(); if (/^[a-f0-9]{64}$/i.test(value)) installedDigest = value.toLowerCase();
      } catch { /* Unknown below; missing metadata is never a match. */ }
    }
    if (!installedDigest) { unknown = true; continue; }
    if (await digest(archive.file) !== installedDigest) pending.push(archive);
  }
  return { items: pending.length ? [item('packages', 'package-staged', 'New Package Is Staged',
    `${pending.length} package(s) are newer than the running version or differ from its installed checksum: ` + pending.map((a) => `${a.channel}/v${a.version}`).join(', '), 'gold', '/packages')] : [], unknown,
    detail: unknown ? 'Some same-version packages lack comparable installed metadata.' : `Compared ${candidates.length} relevant staged packages with running/installed release evidence.` };
}

/** Configuration observation only; does not claim to test public reachability. */
export function exposureObservation(allowedIps: string): Observation {
  if (!allowedIps.trim()) return { items: [], detail: 'Default internal network allowlist configured; reverse-proxy/public reachability is not assessed.' };
  if (allowedIps.trim() === '*') return { items: [item('admin-exposure', 'admin-exposure-risk', 'Admin Console Exposure Risk',
    'ADMIN_ALLOWED_IPS=* disables the network allowlist. Owner/admin authentication remains required.', 'red', '/settings')], detail: 'Checked configured network allowlist, not external reachability.' };
  const publicRanges: string[] = []; let invalid = false;
  for (const raw of allowedIps.split(',')) {
    const [address, prefixText, extra] = raw.trim().split('/'); const family = isIP(address); const width = family === 4 ? 32 : 128;
    const prefix = prefixText === undefined ? width : Number(prefixText);
    if (!family || extra !== undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > width) { invalid = true; continue; }
    let internal = false;
    if (family === 4) { const p = address.split('.').map(Number);
      internal = (p[0] === 127 && prefix >= 8) || (p[0] === 10 && prefix >= 8) || (p[0] === 192 && p[1] === 168 && prefix >= 16) ||
        (p[0] === 172 && p[1] >= 16 && p[1] <= 31 && prefix >= 12) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127 && prefix >= 10);
    } else internal = (address === '::1' && prefix === 128) || (/^f[cd]/i.test(address) && prefix >= 7) || (/^fe[89ab]/i.test(address) && prefix >= 10);
    if (!internal) publicRanges.push(cleanText(raw.trim(), 70));
  }
  return { items: publicRanges.length || invalid ? [item('admin-exposure', 'admin-exposure-risk', 'Admin Console Exposure Risk',
    publicRanges.length ? `Allowlist includes non-internal ranges: ${publicRanges.slice(0, 4).join(', ')}. This is a configuration warning, not a public reachability test.` :
      'The configured network allowlist contains invalid entries. Review the effective configuration.', 'amber', '/settings')] : [], unknown: invalid,
    detail: invalid ? 'Some allowlist entries cannot be assessed.' : 'Configured ranges checked; proxy/public reachability is not assessed.' };
}

interface Operation { kind: 'deploy' | 'recovery'; state: 'success' | 'failed' | 'pending'; at: number; requestId?: string; evidence: string; final: boolean; }
function pairs(text: string) { const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) { const m = /^([a-zA-Z_]+)=(.*)$/.exec(line); if (m) result[m[1]] = m[2].trim(); } return result; }
export function parseOperationLog(text: string, kind: Operation['kind'], mtime: number, evidence: string): Operation | null {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, ''); const blocks = [...clean.matchAll(/===STRUCTURED-RESULT===([\s\S]*?)===END===/g)];
  if (blocks.length) { const data = pairs(blocks[blocks.length - 1][1]);
    const launched = data.runStatus === 'launched-detached' || /launched.*(?:detached|transient)/i.test(data.reason ?? '');
    const state = launched ? 'pending' : data.status === 'success' ? 'success' : ['failed', 'failure'].includes(data.status) ? 'failed' : 'pending';
    return { kind, state, at: mtime, requestId: data.request_id, evidence, final: !launched && state !== 'pending' }; }
  if (kind === 'deploy') {
    const success = [...clean.matchAll(/Runtime deployment completed successfully\.|W3 Forge Deploy Complete/g)].at(-1)?.index ?? -1;
    const failure = [...clean.matchAll(/(?:^|\n)\[(?:FAIL(?:ED)?|ERROR)\]/g)].at(-1)?.index ?? -1;
    if (success >= 0 || failure >= 0) return { kind, state: failure > success ? 'failed' : 'success', at: mtime, evidence, final: true };
  }
  if (kind === 'recovery' && /Hard reset complete|=== Restore Complete(?: \(non-interactive\))? ===/.test(clean)) return { kind, state: 'success', at: mtime, evidence, final: true };
  if (kind === 'recovery' && /TRUNCATE failed\.|\[restore-w3forge\] step FAILED:/.test(clean)) return { kind, state: 'failed', at: mtime, evidence, final: true };
  if (kind === 'recovery' && /All allowlisted tables truncated\./.test(clean)) return { kind, state: 'pending', at: mtime, evidence, final: false };
  return null;
}
// Only a complete, single-run hard-reset log ending at a known prompt can
// establish that no reset execution was recorded. Age alone is not evidence.
const HARD_RESET_CONFIRMATION = /(?:^|\n)Confirmation (?:1 of 2\r?\nType the exact phrase HARDRESET to continue:|2 of 2\r?\nType the exact target database name \([^\r\n)]+\) to continue:)\s*$/;
function hardResetAtConfirmation(text: string, truncated: boolean) {
  if (truncated) return false;
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  const starts = clean.match(/^\[w3log\] ===== hardreset-w3forge-data started [^\r\n]+ =====\r?$/gm);
  return starts?.length === 1 && clean.startsWith(starts[0]) &&
    !/TRUNCATE TABLE|All allowlisted tables truncated\.|TRUNCATE failed\.|Hard reset complete|\[ERROR\]|\[FAIL(?:ED)?\]/i.test(clean) &&
    HARD_RESET_CONFIRMATION.test(clean);
}
class HistoryReadError extends Error {}
const historyLocation = (file: string) => cleanText(`${path.basename(path.dirname(file))}/${path.basename(file)}`);
function historyReadError(file: string, error: unknown) {
  if (error instanceof HistoryReadError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  return new HistoryReadError(`${historyLocation(file)}: could not read evidence${code && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? ` (${code})` : ''}.`);
}
function checkHistoryDeadline(deadline: number, location: string) {
  if (Date.now() >= deadline) throw new HistoryReadError(`${historyLocation(location)}: history scan exceeded its time limit.`);
}
async function recentFiles(dir: string, pattern: RegExp, deadline: number) {
  // Operational log directories grow with normal use. Stream all names and
  // stat matching files sequentially, retaining only the newest 24. Do not
  // apply the package/backup directory cap before filtering unrelated logs.
  const files: Array<{ file: string; name: string; stat: Awaited<ReturnType<typeof regularFile>> }> = [];
  checkHistoryDeadline(deadline, dir);
  let handle: Awaited<ReturnType<typeof fs.opendir>>;
  try { handle = await fs.opendir(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return files; throw historyReadError(dir, error); }
  try {
    for await (const entry of handle) {
      checkHistoryDeadline(deadline, dir);
      if (!entry.isFile() || !pattern.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      let stat: Awaited<ReturnType<typeof regularFile>>;
      try { stat = await regularFile(file); } catch (error) { throw historyReadError(file, error); }
      checkHistoryDeadline(deadline, dir);
      files.push({ file, name: entry.name, stat });
      files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.name.localeCompare(b.name));
      if (files.length > ATTENTION_LIMITS.maxLogFiles) files.pop();
    }
    checkHistoryDeadline(deadline, dir);
    return files;
  } catch (error) { throw historyReadError(dir, error); }
}
async function operationsObservation(paths: AttentionPaths, now: number, lock: LockSnapshot | null,
  timeoutMs: number): Promise<Observation> {
  const events: Operation[] = []; const issues: string[] = []; let issueCount = 0; let preConfirmation = 0;
  const deadline = Date.now() + timeoutMs;
  const issue = (detail: string) => { issueCount++; if (issues.length < 6) issues.push(detail); };
  const collect = async (location: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (error) { issue(historyReadError(location, error).message); }
  };
  const read = async (file: string, bytes = ATTENTION_LIMITS.maxTailBytes) => {
    checkHistoryDeadline(deadline, file);
    const data = await tail(file, bytes);
    checkHistoryDeadline(deadline, file);
    return data;
  };
  const eachFile = (dir: string, pattern: RegExp, visit: (file: Awaited<ReturnType<typeof recentFiles>>[number]) => Promise<void>) =>
    collect(dir, async () => {
      for (const file of await recentFiles(dir, pattern, deadline)) await collect(file.file, () => visit(file));
    });
  await Promise.all([
    eachFile(paths.audit, /^controls-run-\d{4}-\d{2}-\d{2}\.log$/, async (f) => {
      const data = await read(f.file); if (data.truncated) issue(`${historyLocation(f.file)}: audit history exceeds the ${ATTENTION_LIMITS.maxTailBytes}-byte read limit.`);
      let invalidRows = 0;
      for (const line of data.text.split(/\r?\n/)) { if (!line.trim()) continue;
        try { const row = JSON.parse(line); if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid audit row');
          if (row.kind !== 'control-run') continue;
          if (row.phase !== 'completed' || !['success', 'failed'].includes(row.outcome)) continue;
          const kind = DEPLOYS.has(row.controlId) ? 'deploy' : RECOVERY.has(row.controlId) ? 'recovery' : null;
          if (!kind) continue;
          const at = Date.parse(row.ts); if (!Number.isFinite(at)) throw new Error('Invalid operation timestamp');
          const launched = row.controlId === 'pipeline-deploy-dev' && row.outcome === 'success';
          events.push({ kind, state: launched ? 'pending' : row.outcome, at, requestId: row.requestId, evidence: `${f.name}: ${row.controlId}`, final: !launched });
        } catch { invalidRows++; }
      }
      if (invalidRows) issue(`${historyLocation(f.file)}: ${invalidRows} invalid audit record(s).`);
    }),
    eachFile(paths.detached, /^deploy-[A-Za-z0-9_-]+\.trailer$/, async (f) => {
      const data = pairs((await read(f.file, 8192)).text);
      const state = data.status === 'success' ? 'success' : ['failed', 'launch_failed'].includes(data.status) ? 'failed' : 'pending';
      const at = Date.parse(data.finished_at ?? data.launched_at ?? '') || f.stat.mtimeMs;
      events.push({ kind: 'deploy', state, at, requestId: data.request_id, evidence: f.name, final: state !== 'pending' });
    }),
    ...(['deploy', 'pipeline', 'restore', 'hardreset'] as const).map((category) => eachFile(path.join(paths.logs, category),
      /^(?:deploy-w3forge(?:-noninteractive)?|pipeline-deploy-dev-package-w3forge-ui|restore-w3forge(?:-ui)?|hardreset-w3forge-data)_.*\.log$/, async (f) => {
        const data = await read(f.file);
        if (category === 'hardreset' && f.name.startsWith('hardreset-w3forge-data_') && hardResetAtConfirmation(data.text, data.truncated)) {
          preConfirmation++; return;
        }
        if (category === 'hardreset' && HARD_RESET_CONFIRMATION.test(data.text.replace(/\x1b\[[0-9;]*m/g, ''))) {
          issue(`${historyLocation(f.file)}: cannot establish pre-reset state from an incomplete or conflicting confirmation log.`); return;
        }
        const event = parseOperationLog(data.text,
          category === 'restore' || category === 'hardreset' ? 'recovery' : 'deploy', data.mtime, f.name);
        if (event) events.push(event);
        else if (category === 'deploy' || category === 'pipeline') {
          // set -e failures (npm/systemctl) need not print a final marker.
          // Keep this unresolved until a newer actual completion supersedes
          // it; elapsed time alone must never convert failure into health.
          events.push({ kind: 'deploy', state: 'pending', at: data.mtime, evidence: f.name, final: false });
        } else if (!/Restore cancelled|Nothing was changed|Dry.run|dry.run/i.test(data.text)) {
          issue(`${historyLocation(f.file)}: recovery outcome is unrecognized${data.truncated ? ' in the bounded log tail' : ''}.`);
        }
      }))
  ]);
  if (lock && DEPLOYS.has(lock.controlId)) events.push({ kind: 'deploy', state: 'pending', at: Date.parse(lock.startedAt),
    requestId: lock.requestId, evidence: `Active ${lock.controlId} operation`, final: false });
  const finalById = new Map<string, Operation>();
  for (const event of events) if (event.final && event.requestId) { const prev = finalById.get(event.requestId); if (!prev || event.at > prev.at) finalById.set(event.requestId, event); }
  const effective = events.filter((e) => e.final || !e.requestId || !finalById.has(e.requestId)).sort((a, b) => b.at - a.at || Number(b.final) - Number(a.final));
  const latestDeploy = effective.find((e) => e.kind === 'deploy' && e.final);
  const pendingDeploy = effective.find((e) => e.kind === 'deploy' && !e.final && (!latestDeploy || e.at >= latestDeploy.at));
  const recovery = effective.find((e) => e.kind === 'recovery' && now - e.at <= ATTENTION_LIMITS.recoveryNoticeHours * HOUR);
  const items: AttentionItem[] = [];
  if (latestDeploy?.state === 'failed') items.push(item('operations', 'failed-deploy', 'Failed Deploy Detected',
    `Latest final deployment result failed (${new Date(latestDeploy.at).toISOString()}, ${cleanText(latestDeploy.evidence)}). Review deployment logs.`, 'red', '/logs'));
  if (pendingDeploy) items.push(item('operations', 'deploy-outcome-pending', 'Deployment Outcome Is Not Yet Confirmed',
    `A deployment launch has no matching final result (${cleanText(pendingDeploy.evidence)}). Launch success is not deployment success.`, 'info', '/logs'));
  if (lock && RECOVERY.has(lock.controlId)) items.push(item('operations', 'restore-hard-reset', 'Restore / Hard Reset Is Running',
    `Active ${lock.controlId} operation started ${cleanText(lock.startedAt)}.`, 'amber', '/controls'));
  else if (recovery) items.push(item('operations', 'restore-hard-reset', 'Restore / Hard Reset Warning',
    `Recovery activity ${recovery.state} within the last 24 hours (${cleanText(recovery.evidence)}). Verify application and database state.`, recovery.state === 'failed' ? 'red' : 'amber', '/logs'));
  const pendingRecovery = effective.find((e) => e.kind === 'recovery' && !e.final);
  if (pendingDeploy) issue(`${cleanText(pendingDeploy.evidence)}: deployment has no confirmed final result.`);
  if (pendingRecovery) issue(`${cleanText(pendingRecovery.evidence)}: recovery has no confirmed final result.`);
  if (!events.length) issue('No completed deployment or recovery history was found.');
  const confirmationDetail = preConfirmation ? ` ${preConfirmation} hard-reset log(s) stop at confirmation before any recorded reset execution.` : '';
  return { items, unknown: issueCount > 0, detail: issueCount ?
    `History incomplete: ${issues.join(' ')}${issueCount > issues.length ? ` ${issueCount - issues.length} additional issue(s).` : ''}${confirmationDetail}` :
    `Read bounded control audits, CLI operation logs and detached final trailers. Recovery notices cover 24 hours.${confirmationDetail}` };
}
async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Observation timed out')), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}
// A timed-out probe can still be waiting on the shared PostgreSQL pool or
// filesystem. Keep just one underlying observation per source/context alive;
// later dashboard polls wait on that same promise instead of queuing work.
const sourceFlights = new Map<string, Promise<Observation>>();
const readerIds = new WeakMap<Function, number>();
let nextReaderId = 0;
function readerId(reader: Function | undefined) {
  if (!reader) return 0;
  if (!readerIds.has(reader)) readerIds.set(reader, ++nextReaderId);
  return readerIds.get(reader)!;
}
function singleFlight(key: string, read: () => Promise<Observation>) {
  const current = sourceFlights.get(key); if (current) return current;
  const pending = read(); sourceFlights.set(key, pending);
  const release = () => { if (sourceFlights.get(key) === pending) sourceFlights.delete(key); };
  void pending.then(release, release); return pending;
}
export async function collectAttention(options: AttentionOptions = {}) {
  const now = options.now ?? Date.now();
  const paths: AttentionPaths = { deploy: DEPLOY_DIR, backups: BACKUPS_DIR, packages: UPDATE_PACKAGES_DIR,
    dev: UPDATE_PACKAGES_DEV_DIR, main: UPDATE_PACKAGES_MAIN_DIR, installed: UPDATE_PACKAGES_INSTALLED_DIR,
    logs: LOGS_ROOT, audit: env.adminLogDir, detached: path.join('/var/log', env.appId), ...options.paths };
  const version = options.version ?? env.appVersion;
  const git = options.git ?? (async (args: string[]) => (await executeFile('git', args, {
    cwd: paths.deploy, timeout: 4000, maxBuffer: 1024 * 1024, shell: false, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  })).stdout);
  const definitions: Array<{ id: string; label: string; href: string; read: () => Promise<Observation> }> = [
    { id: 'git', label: 'Git checkout', href: '/github', read: () => gitObservation(git, version) },
    { id: 'system', label: 'Disk and memory', href: '/system', read: async () => {
      const [disk, memory] = await Promise.all([(options.disk ?? readRootVolume)(), (options.memory ?? readContainerMemory)()]); const items: AttentionItem[] = [];
      if (disk.available && disk.usePercent != null && disk.usePercent >= 70) items.push(item('system', disk.usePercent >= 90 ? 'disk-high' : 'disk-warning',
        'Disk Usage Is High', `Root volume at ${disk.usePercent}%. Warning: 70%; critical: 90%.`, disk.usePercent >= 90 ? 'red' : 'amber', '/system'));
      if (memory.usagePercent != null && memory.usagePercent >= 80) items.push(item('system', memory.usagePercent >= 90 ? 'container-memory-critical' : 'container-memory-warning',
        memory.usagePercent >= 90 ? 'Container Memory Is Critical' : 'Container Memory Is Elevated', `Container at ${memory.usagePercent}% of its limit.`, memory.usagePercent >= 90 ? 'red' : 'amber', '/system'));
      if (memory.usagePercent == null) { const mem = (options.processMemory ?? process.memoryUsage)(); const pct = Math.round(mem.heapUsed / Math.max(1, mem.heapTotal) * 100);
        if (pct >= 90) items.push(item('system', 'process-heap-watch', 'Process Heap Is Tight (Container Metrics Unavailable)', `Heap at ${pct}%; informational because the container limit is unavailable.`, 'info', '/system')); }
      return { items, unknown: !disk.available || disk.usePercent == null || memory.usagePercent == null, detail: 'Root volume and container memory checked; missing metrics remain unknown.' };
    } },
    { id: 'database', label: 'Database connection', href: '/system', read: async () => {
      const db = await (options.database ?? dbStatus)(); return { items: db.status === 'unavailable' ? [item('database', 'db-connection-failed', 'Database Connection Failed',
        'The read-only PostgreSQL SELECT 1 check failed.', 'red', '/system')] : [], unknown: !['connected', 'unavailable'].includes(db.status), detail: `Database check: ${db.status}.` };
    } },
    { id: 'backup', label: 'Backup freshness', href: '/backups', read: () => backupObservation(paths.backups, now) },
    { id: 'packages', label: 'Staged packages', href: '/packages', read: () => packageObservation(paths, version) },
    { id: 'admin-exposure', label: 'Admin network configuration', href: '/settings', read: async () => exposureObservation(options.allowedIps ?? env.adminAllowedIps) },
    { id: 'operations', label: 'Deployment and recovery history', href: '/logs', read: () => operationsObservation(paths, now, (options.lock ?? snapshotCurrent)(), options.timeoutMs ?? ATTENTION_LIMITS.timeoutMs) }
  ];
  const context = JSON.stringify([paths, version, options.allowedIps ?? env.adminAllowedIps,
    ...[options.git, options.database, options.disk, options.memory, options.processMemory, options.lock].map(readerId)]);
  const observations = await Promise.all(definitions.map(async (source) => {
    try { return await bounded(singleFlight(`${source.id}:${context}`, source.read), options.timeoutMs ?? ATTENTION_LIMITS.timeoutMs); }
    catch { return { items: [], unknown: true, detail: source.id === 'operations' ?
      'Deployment and recovery history could not finish within the observation time limit. Review the operational log directories.' :
      'Evidence could not be read within the observation limits.' } as Observation; }
  }));
  const sources: AttentionSource[] = definitions.map((source, i) => ({ id: source.id, label: source.label, status: observations[i].unknown ? 'unknown' : 'ok', detail: observations[i].detail }));
  const items = observations.flatMap((observation, i) => [...observation.items, ...(observation.unknown ? [item(definitions[i].id, `${definitions[i].id}-unavailable`,
    `${definitions[i].label} Check Is Incomplete`, observation.detail, 'info', definitions[i].href)] : [])]);
  const order = { red: 0, amber: 1, gold: 2, info: 3 }; items.sort((a, b) => order[a.severity] - order[b.severity]);
  const coverageComplete = sources.every((s) => s.status === 'ok'); const allClear = coverageComplete && items.length === 0;
  return { generatedAt: new Date(now).toISOString(), attention: { acknowledged: false, message: allClear ? 'No attention items detected in the available operational evidence.' :
    coverageComplete ? 'Review the attention items below.' : 'Some checks are incomplete; an all-clear cannot be confirmed.', allClear, coverageComplete, items, sources } };
}
