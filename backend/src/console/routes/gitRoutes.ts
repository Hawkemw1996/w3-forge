import { getAllowReleasePipeline } from '../appConfigAccessors';
import { githubRepositoryUrl, repositoryIdentity } from '../githubValidation/repositoryIdentity';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Router } from 'express';
import { env } from '../../config/env';
import {
  DEPLOY_DIR,
  UPDATE_PACKAGES_DIR,
  UPDATE_PACKAGES_INSTALLED_DIR,
  parsePackageVersion
} from '../paths';
import {
  getAppGitHubWorkflowMeta,
  isAllowedDevBranchName
} from '../githubValidation/appGitHubWorkflowRegistry';

// =============================================================================
// /api/admin/git/* — safe read-only + metadata-refresh routes (v0.5.5).
// =============================================================================
//
// Every git invocation in this file uses execFile (NOT exec / NOT a shell
// string) with a fixed argv whose tokens are hard-coded constants. The
// frontend cannot pass branch names, tag names, refs, paths, command text,
// or any other arbitrary input that reaches git. The only request input we
// trust at all is the `version` query parameter on `/git/release-notes`,
// which is validated against a strict semver-like regex before being used
// as a string match key against parsed CHANGELOG.md headings — it is never
// passed to git or a shell.
//
// All commands run with cwd pinned to DEPLOY_DIR (/opt/w3forge-deploy) and
// have a hard timeout. Non-zero exits degrade individual fields rather than
// crashing the whole endpoint so the UI can still render partial data.
//
// Allowed commands (v0.5.5):
//   git rev-parse --abbrev-ref HEAD
//   git rev-parse HEAD
//   git rev-parse --short HEAD
//   git describe --tags --always --abbrev=0
//   git status --porcelain
//   git remote get-url origin
//   git log -1 --pretty=format:...
//   git log -n <N> --pretty=format:...
//   git ls-remote --exit-code --heads origin
//   git fetch --tags --prune --force
//   git for-each-ref refs/tags --format=...   (annotated + lightweight tags)
//   git --version                              (used by check-remote diagnostics)
//
// Explicitly NOT allowed in v0.5.5 (planned for v0.5.6+ Controls):
//   git pull, git checkout, git reset, git merge, git push,
//   git tag <create>, git tag -d <delete>, deploy/restore/restart.

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 6000;
const GIT_FETCH_TIMEOUT_MS = 15000;

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Run `git <args...>` with cwd pinned to DEPLOY_DIR. Uses execFile so no
 * shell is involved. The args array is built from hard-coded constants in
 * each call site — never from request input.
 */
async function runGit(args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: DEPLOY_DIR,
      timeout: timeoutMs,
      shell: false,
      windowsHide: true,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
        SystemRoot: process.env.SystemRoot, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
        LANG: 'C.UTF-8', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never',
        GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes' },
      maxBuffer: 8 * 1024 * 1024
    });
    return { ok: true, stdout: stdout.toString(), stderr: stderr.toString(), code: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; code?: number };
    return {
      ok: false,
      stdout: (e.stdout?.toString() ?? '').trim(),
      stderr: 'Git command failed. Check the configured workspace, host credentials and network.',
      code: typeof e.code === 'number' ? e.code : null
    };
  }
}

/**
 * v0.12.10: numeric version ordering for the dev/vX.Y.Z branch allowlist.
 *
 * Parses `dev/v<major>.<minor>.<patch>` into integer segments. Returns null
 * for any other shape so callers never treat an unexpected name as a
 * version. Exported (pure, no git, no I/O) so the ordering is unit-testable.
 */
export function parseDevBranchVersion(name: string): [number, number, number] | null {
  const m = /^dev\/v(\d+)\.(\d+)\.(\d+)$/.exec(name);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Descending comparator: highest numeric major/minor/patch first, so
 * 0.12.10 > 0.12.9 > 0.12.2, 0.13.0 > 0.12.100 and 1.0.0 > 0.99.99. Names
 * that do not parse (which the allowlist already excludes) sort after every
 * parsed version, ordered lexically among themselves for determinism.
 */
export function compareDevBranchNamesDesc(
  a: { name: string },
  b: { name: string }
): number {
  const va = parseDevBranchVersion(a.name);
  const vb = parseDevBranchVersion(b.name);
  if (!va && !vb) return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  if (!va) return 1;
  if (!vb) return -1;
  for (let i = 0; i < 3; i += 1) {
    if (va[i] !== vb[i]) return vb[i] - va[i];
  }
  return 0;
}

/** Convenience for the common single-line "trimmed stdout or null" pattern. */
async function gitLine(args: string[]): Promise<string | null> {
  const r = await runGit(args);
  if (!r.ok) return null;
  const t = r.stdout.trim();
  return t;
}

async function readReleaseVersion(): Promise<string> {
  try {
    const versionFile = path.join(DEPLOY_DIR, 'VERSION');
    const raw = await fs.readFile(versionFile, 'utf8');
    return raw.trim();
  } catch {
    return env.appVersion;
  }
}

async function readJsonVersion(relPath: string): Promise<string | null> {
  try {
    const full = path.join(DEPLOY_DIR, relPath);
    const raw = await fs.readFile(full, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Normalize a version-like string for equality checks (strips leading 'v'). */
function normVer(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = v.trim();
  if (!t) return null;
  return t.startsWith('v') ? t.slice(1) : t;
}

interface InstalledPackageInfo {
  name: string;
  parsedVersion: string | null;
  mtime: string;
}

/** Find the newest installed canonical package, if any. */
async function findLatestInstalledPackage(): Promise<InstalledPackageInfo | null> {
  try {
    const entries = await fs.readdir(UPDATE_PACKAGES_INSTALLED_DIR, { withFileTypes: true });
    const candidates: InstalledPackageInfo[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!e.name.endsWith('.tar.gz')) continue;
      try {
        const stat = await fs.stat(path.join(UPDATE_PACKAGES_INSTALLED_DIR, e.name));
        candidates.push({
          name: e.name,
          parsedVersion: parsePackageVersion(e.name),
          mtime: stat.mtime.toISOString()
        });
      } catch {
        /* skip unreadable */
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime));
    return candidates[0];
  } catch {
    return null;
  }
}

/** Set of all canonical staged + installed package versions on the host. */
async function collectPackageVersions(): Promise<Set<string>> {
  const versions = new Set<string>();
  for (const dir of [UPDATE_PACKAGES_DIR, UPDATE_PACKAGES_INSTALLED_DIR]) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile()) continue;
        const v = parsePackageVersion(e.name);
        if (v) versions.add(v);
      }
    } catch {
      /* dir missing — ignore */
    }
  }
  return versions;
}

// ---------------------------------------------------------------------------
// CHANGELOG.md parsing — pure string operations on a server-local file.
// ---------------------------------------------------------------------------
//
// Supported heading shapes for a version section:
//   ## v0.5.5
//   ## [v0.5.5]
//   ## [0.5.5]
//   ## v0.5.5 — ...
//   ## W3 Core v0.5.5
//   # v0.5.5
//
// A section runs from its heading until the next heading at the same or
// higher level (or EOF). Returned content excludes the heading itself.

function headingMatchesVersion(headingText: string, version: string): boolean {
  const want = normVer(version);
  if (!want) return false;
  // Strip leading '#' chars + spaces.
  const inner = headingText.replace(/^#+\s*/, '').trim();
  // Collect every vX.Y.Z / [vX.Y.Z] token in the heading and compare.
  const re = /\[?v?(\d+\.\d+\.\d+)\]?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    if (m[1] === want) return true;
  }
  return false;
}

interface ChangelogSection {
  heading: string;
  body: string;
}

function extractChangelogSection(text: string, version: string): ChangelogSection | null {
  const lines = text.split(/\r?\n/);
  let startIdx = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    if (headingMatchesVersion(line, version)) {
      startIdx = i;
      startLevel = m[1].length;
      break;
    }
  }
  if (startIdx === -1) return null;

  let endIdx = lines.length;
  for (let j = startIdx + 1; j < lines.length; j++) {
    const m = /^(#{1,6})\s+/.exec(lines[j]);
    if (m && m[1].length <= startLevel) {
      endIdx = j;
      break;
    }
  }
  const heading = lines[startIdx].replace(/^#+\s*/, '').trim();
  const body = lines.slice(startIdx + 1, endIdx).join('\n').trim();
  return { heading, body };
}

// Strict allow-list regex for the only request input on this surface.
const VERSION_QUERY_REGEX = /^v?\d+\.\d+\.\d+$/;

// ---------------------------------------------------------------------------
// v0.6.4 — additive metadata builder.
//
// Every /api/admin/git/* response is decorated with the same compact block
// of additive fields sourced from the app-aware GitHub workflow registry.
// Existing fields are NEVER touched; the legacy frontend keeps working
// unchanged. Spreading this block LAST in each route also guarantees a
// future field-name collision can never silently overwrite a legacy field.
// ---------------------------------------------------------------------------
function buildAdditiveMeta(): {
  app_id: string;
  app_name: string;
  repo_source: 'app-config' | 'legacy-fallback';
  authority_source: 'app-config' | 'safe-fallback';
  config_driven: boolean;
  registry_migration_status: string;
  registry_source: string;
  github_workflow: {
    mode: string;
    allow_release_pipeline: boolean;
    enforce_main_protection: boolean;
    enforce_release_gate: boolean;
    default_dev_branch: string | null;
    allowed_branch_pattern: string | null;
    blocked_branches: string[];
  };
} {
  const m = getAppGitHubWorkflowMeta();
  return {
    app_id: m.app_id,
    app_name: m.app_name,
    repo_source: m.repo_source,
    authority_source: m.authority_source,
    config_driven: m.config_driven,
    registry_migration_status: m.registry_migration_status,
    registry_source: m.registry_source,
    github_workflow: {
      mode: m.mode,
      allow_release_pipeline: m.allow_release_pipeline,
      enforce_main_protection: m.enforce_main_protection,
      enforce_release_gate: m.enforce_release_gate,
      default_dev_branch: m.default_dev_branch,
      allowed_branch_pattern: m.allowed_branch_pattern,
      blocked_branches: m.blocked_branches
    }
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function buildAdminGitRoutes(): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /git/status
  // Read-only snapshot of the deploy checkout. Backwards-compatible with the
  // v0.5.4 shape; v0.5.5 adds nothing breaking.
  // -------------------------------------------------------------------------
  router.get('/git/status', async (_req, res, next) => {
    try {
      let isRepo = false;
      try {
        const gitDir = await fs.stat(path.join(DEPLOY_DIR, '.git'));
        isRepo = gitDir.isDirectory() || gitDir.isFile();
      } catch {
        isRepo = false;
      }

      const releaseVersion = await readReleaseVersion();
      // v0.6.4 additive metadata. Spread last so legacy fields take precedence
      // in the unlikely case of a future field-name collision.
      const ghMeta = buildAdditiveMeta();

      if (!isRepo) {
        return res.json({
          success: true,
          data: {
            deployRoot: DEPLOY_DIR,
            isRepo: false,
            branch: null,
            headSha: null,
            headShortSha: null,
            describedTag: null,
            clean: null,
            uncommittedCount: null,
            remote: null,
            ...repositoryIdentity(null),
            lastCommit: null,
            releaseVersion,
            status: 'unavailable',
            ...ghMeta
          }
        });
      }

      const [branch, headSha, headShortSha, describedTag, statusPorcelain, remote, lastCommitLine] =
        await Promise.all([
          gitLine(['rev-parse', '--abbrev-ref', 'HEAD']),
          gitLine(['rev-parse', 'HEAD']),
          gitLine(['rev-parse', '--short', 'HEAD']),
          gitLine(['describe', '--tags', '--always', '--abbrev=0']),
          gitLine(['status', '--porcelain']),
          gitLine(['remote', 'get-url', 'origin']),
          gitLine(['log', '-1', '--pretty=format:%H%x09%h%x09%an%x09%aI%x09%s'])
        ]);

      const lines = (statusPorcelain ?? '').split('\n').filter((l) => l.length > 0);
      const clean = statusPorcelain === null ? null : statusPorcelain === '';
      const uncommittedCount = clean === null ? null : clean ? 0 : lines.length;

      let lastCommit: {
        sha: string;
        shortSha: string;
        author: string;
        date: string;
        subject: string;
      } | null = null;
      if (lastCommitLine) {
        const parts = lastCommitLine.split('\t');
        if (parts.length >= 5) {
          lastCommit = {
            sha: parts[0],
            shortSha: parts[1],
            author: parts[2],
            date: parts[3],
            subject: parts.slice(4).join('\t')
          };
        }
      }

      res.json({
        success: true,
        data: {
          deployRoot: DEPLOY_DIR,
          isRepo: true,
          branch,
          headSha,
          headShortSha,
          describedTag,
          clean,
          uncommittedCount,
          remote: githubRepositoryUrl(remote ?? undefined),
          ...repositoryIdentity(remote),
          lastCommit,
          releaseVersion,
          status: clean === null ? 'unavailable' : clean ? 'ok' : 'degraded',
          ...ghMeta
        }
      });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /git/check-remote
  // Safe reachability probe — `git ls-remote --exit-code --heads origin`.
  // Does not modify the working tree, fetch refs, or pull anything.
  // -------------------------------------------------------------------------
  router.post('/git/check-remote', async (_req, res, next) => {
    try {
      const remote = await gitLine(['remote', 'get-url', 'origin']);
      const checkedAt = new Date().toISOString();

      if (!repositoryIdentity(remote).remoteMatchesConfig) {
        return res.json({
          success: true,
          data: {
            ok: false,
            remote: githubRepositoryUrl(remote ?? undefined),
            ...repositoryIdentity(remote),
            checkedAt,
            message: repositoryIdentity(remote).repositoryMessage,
            status: 'remote_failed'
          }
        });
      }

      const r = await runGit(['ls-remote', '--exit-code', '--heads', remote!], GIT_FETCH_TIMEOUT_MS);
      if (!r.ok) {
        return res.json({
          success: true,
          data: {
            ok: false,
            remote: githubRepositoryUrl(remote ?? undefined),
          ...repositoryIdentity(remote),
            checkedAt,
            message: r.stderr || 'git ls-remote failed.',
            status: 'remote_failed'
          }
        });
      }

      const headCount = r.stdout.split('\n').filter((l) => l.trim().length > 0).length;
      res.json({
        success: true,
        data: {
          ok: true,
          remote: githubRepositoryUrl(remote ?? undefined),
          ...repositoryIdentity(remote),
          checkedAt,
          headCount,
          message: `Remote reachable — ${headCount} head ref(s).`,
          status: 'remote_ok'
        }
      });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /git/branches-dev
  //
  // v0.5.29 Release Pipeline support route. Read-only.
  //
  // Lists only `origin/dev/vX.Y.Z` branch heads (e.g. origin/dev/v0.5.29).
  // The Release Pipeline UI uses this to populate the dev-branch picker;
  // main and any other branch shape is filtered out at the route layer so a
  // mis-typed or stale branch ref can never reach a pipeline-* action.
  //
  // Affects: nothing — runs `git ls-remote --heads origin` against the
  // /opt/w3forge-deploy clone and filters the result in-process.
  // -------------------------------------------------------------------------
  router.get('/git/branches-dev', async (_req, res, next) => {
    try {
      const listedAt = new Date().toISOString();
      const remote = await gitLine(['remote', 'get-url', 'origin']);
      const identity = repositoryIdentity(remote);
      if (!identity.remoteMatchesConfig || !remote) {
        return res.json({ success: true, data: { ok: false, listedAt, branches: [], count: 0,
          message: identity.repositoryMessage, status: 'list_failed', ...buildAdditiveMeta(), ...identity } });
      }
      const r = await runGit(
        ['ls-remote', '--heads', remote],
        GIT_FETCH_TIMEOUT_MS
      );
      if (!r.ok) {
        return res.json({
          success: true,
          data: {
            ok: false,
            listedAt,
            branches: [],
            count: 0,
            message: r.stderr || 'git ls-remote --heads failed.',
            status: 'list_failed',
            ...buildAdditiveMeta()
          }
        });
      }

      // Each line looks like:
      //   <sha>\trefs/heads/<branch>
      // v0.6.4: filter through appGitHubWorkflowRegistry.isAllowedDevBranchName()
      // which (a) requires the ref to match repo.allowed_branch_pattern AND
      // (b) rejects anything in repo.blocked_branches (main/master always).
      // The pattern is still ^dev/v[0-9]+\.[0-9]+\.[0-9]+$ in v0.6.4 so the
      // visible result list is unchanged. The hard-coded prefix strip below
      // assumes a `refs/heads/` prefix; only that prefix is removed before
      // the policy check, so an attacker-controlled remote could never
      // smuggle a non-`refs/heads/` ref through this filter.
      const REF_HEADS_PREFIX = 'refs/heads/';
      const branches: Array<{ name: string; sha: string }> = [];
      for (const line of r.stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const tab = trimmed.indexOf('\t');
        if (tab < 0) continue;
        const sha = trimmed.slice(0, tab).trim();
        const ref = trimmed.slice(tab + 1).trim();
        if (!ref.startsWith(REF_HEADS_PREFIX)) continue;
        const branchName = ref.slice(REF_HEADS_PREFIX.length);
        if (!isAllowedDevBranchName(branchName)) continue;
        branches.push({ name: branchName, sha });
      }

      // v0.12.10: sort descending by numeric major.minor.patch (highest dev
      // branch first). A whole-string comparison is NOT correct here: it is
      // lexical, so "dev/v0.12.9" > "dev/v0.12.10" and "dev/v0.12.100" >
      // "dev/v0.13.0". Every name has already passed the dev/vX.Y.Z allowlist,
      // so each segment is parsed as an integer; the response fields, names,
      // and SHA pairings are unchanged — only the order is corrected.
      branches.sort(compareDevBranchNamesDesc);

      res.json({
        success: true,
        data: {
          ok: true,
          listedAt,
          branches,
          count: branches.length,
          message:
            branches.length === 0
              ? 'No dev/vX.Y.Z branches found on origin.'
              : `Found ${branches.length} dev branch(es).`,
          status: 'list_ok',
          ...buildAdditiveMeta()
        }
      });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /git/fetch-tags
  // `git fetch --tags --prune --force` against origin. Updates git
  // metadata (refs/tags) only. Does NOT touch the working tree.
  // No `--no-write-fetch-head` because that flag is not universally
  // available — `--prune --force` is portable across modern git releases.
  // -------------------------------------------------------------------------
  router.post('/git/fetch-tags', async (_req, res, next) => {
    try {
      const fetchedAt = new Date().toISOString();
      if (!getAllowReleasePipeline()) {
        return res.status(409).json({ success: true, data: { ok: false, fetchedAt, beforeCount: 0,
          afterCount: 0, added: 0, message: 'The release pipeline is disabled by this installation’s configuration.', status: 'fetch_failed' } });
      }
      const remote = await gitLine(['remote', 'get-url', 'origin']);
      const identity = repositoryIdentity(remote);
      if (!identity.remoteMatchesConfig || !remote) {
        return res.json({ success: true, data: { ok: false, fetchedAt, beforeCount: 0, afterCount: 0,
          added: 0, message: identity.repositoryMessage, status: 'fetch_failed', ...identity } });
      }
      const before = await runGit(['tag', '--list']);
      const beforeCount = before.ok
        ? before.stdout.split('\n').filter((l) => l.trim().length > 0).length
        : 0;

      const r = await runGit(['fetch', '--tags', '--prune', '--force', remote], GIT_FETCH_TIMEOUT_MS);

      if (!r.ok) {
        return res.json({
          success: true,
          data: {
            ok: false,
            fetchedAt,
            beforeCount,
            afterCount: beforeCount,
            added: 0,
            message: r.stderr || 'git fetch --tags failed.',
            status: 'fetch_failed'
          }
        });
      }

      const after = await runGit(['tag', '--list']);
      const afterCount = after.ok
        ? after.stdout.split('\n').filter((l) => l.trim().length > 0).length
        : beforeCount;

      res.json({
        success: true,
        data: {
          ok: true,
          fetchedAt,
          beforeCount,
          afterCount,
          added: Math.max(0, afterCount - beforeCount),
          message:
            afterCount > beforeCount
              ? `Fetched ${afterCount - beforeCount} new tag(s).`
              : 'Tags refreshed — no new tags.',
          status: 'fetch_ok'
        }
      });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /git/tags
  // Most-recent tags (default 20). Uses for-each-ref so both annotated and
  // lightweight tags are returned, sorted by creator/tagger date descending.
  // Cross-references the installed VERSION + package files on the host so the
  // UI can render `Latest`, `Installed`, `Package Exists` badges without a
  // second round-trip.
  // -------------------------------------------------------------------------
  router.get('/git/tags', async (_req, res, next) => {
    try {
      // %x09 = TAB. Field order:
      //   refname:short, objectname:short, taggerdate:iso8601, creatordate:iso8601,
      //   subject, type
      const r = await runGit([
        'for-each-ref',
        '--sort=-creatordate',
        '--count=20',
        '--format=%(refname:short)%09%(objectname:short)%09%(taggerdate:iso8601)%09%(creatordate:iso8601)%09%(subject)%09%(*objectname:short)%09%(type)',
        'refs/tags'
      ]);

      const installedVersion = await readReleaseVersion();
      const pkgVersions = await collectPackageVersions();

      if (!r.ok) {
        return res.json({
          success: true,
          data: {
            tags: [],
            installedVersion,
            count: 0,
            limit: 20,
            error: r.stderr || 'git for-each-ref failed.'
          }
        });
      }

      const lines = r.stdout.split('\n').filter((l) => l.trim().length > 0);
      const tags = lines.map((line) => {
        const [name, objShort, taggerDate, creatorDate, subject, peeledShort, type] = line.split('\t');
        const date = (taggerDate && taggerDate.trim()) || (creatorDate && creatorDate.trim()) || null;
        const commit = (peeledShort && peeledShort.trim()) || objShort || null;
        const tagVer = normVer(name);
        return {
          name,
          commit,
          date,
          message: subject ?? '',
          type: type ?? null, // 'tag' (annotated) or 'commit' (lightweight)
          matchesInstalled: tagVer != null && tagVer === installedVersion,
          packageExists: tagVer != null && pkgVersions.has(tagVer)
        };
      });

      if (tags.length > 0) {
        // First entry from --sort=-creatordate is the most recent.
        (tags[0] as { isLatest?: boolean }).isLatest = true;
      }

      res.json({
        success: true,
        data: {
          tags,
          installedVersion,
          count: tags.length,
          limit: 20
        }
      });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /git/commits
  // Most-recent commits (default 25). Each commit is mapped to a tag if a
  // tag points at exactly that commit (uses git's points-at via for-each-ref
  // — but to avoid N round-trips we build the map up front in JS).
  // -------------------------------------------------------------------------
  router.get('/git/commits', async (_req, res, next) => {
    try {
      // Build a sha -> tag map first so we can decorate the commit list.
      const tagsRef = await runGit([
        'for-each-ref',
        '--format=%(objectname)%09%(*objectname)%09%(refname:short)',
        'refs/tags'
      ]);
      const tagBySha = new Map<string, string>();
      if (tagsRef.ok) {
        for (const line of tagsRef.stdout.split('\n')) {
          if (!line.trim()) continue;
          const [objSha, peeledSha, refName] = line.split('\t');
          const sha = (peeledSha && peeledSha.trim()) || objSha;
          if (sha && refName) {
            // Prefer the highest-precedence (first-seen) tag for any sha.
            if (!tagBySha.has(sha)) tagBySha.set(sha, refName);
          }
        }
      }

      const r = await runGit([
        'log',
        '-n',
        '25',
        '--pretty=format:%H%x09%h%x09%an%x09%aI%x09%s'
      ]);

      if (!r.ok) {
        return res.json({
          success: true,
          data: {
            commits: [],
            count: 0,
            limit: 25,
            error: r.stderr || 'git log failed.'
          }
        });
      }

      const commits = r.stdout
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((line) => {
          const parts = line.split('\t');
          const sha = parts[0] ?? '';
          const shortSha = parts[1] ?? '';
          const author = parts[2] ?? '';
          const date = parts[3] ?? '';
          const subject = parts.slice(4).join('\t');
          return {
            sha,
            shortSha,
            author,
            date,
            subject,
            tag: tagBySha.get(sha) ?? null
          };
        });

      res.json({
        success: true,
        data: {
          commits,
          count: commits.length,
          limit: 25
        }
      });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /git/compare-installed
  // Cross-checks every authoritative version surface on the deploy host:
  //   - Running app version (from env.appVersion)
  //   - VERSION file
  //   - root package.json
  //   - backend/package.json
  //   - frontend/package.json
  //   - latest git tag (describedTag)
  //   - newest installed package filename
  //   - working tree clean/dirty
  //   - head commit
  //   - remote
  // and returns a single overall status code + a human-readable explanation.
  // -------------------------------------------------------------------------
  router.get('/git/compare-installed', async (_req, res, next) => {
    try {
      const [
        runningVersion,
        versionFile,
        rootPkgVersion,
        backendPkgVersion,
        frontendPkgVersion,
        branch,
        headSha,
        headShortSha,
        describedTag,
        statusPorcelain,
        remote
      ] = await Promise.all([
        Promise.resolve(env.appVersion),
        readReleaseVersion(),
        readJsonVersion('package.json'),
        readJsonVersion('backend/package.json'),
        readJsonVersion('frontend/admin/package.json'),
        gitLine(['rev-parse', '--abbrev-ref', 'HEAD']),
        gitLine(['rev-parse', 'HEAD']),
        gitLine(['rev-parse', '--short', 'HEAD']),
        gitLine(['describe', '--tags', '--always', '--abbrev=0']),
        gitLine(['status', '--porcelain']),
        gitLine(['remote', 'get-url', 'origin'])
      ]);

      const installedPackage = await findLatestInstalledPackage();

      const clean = statusPorcelain === null ? null : statusPorcelain === '';
      const uncommittedCount = clean === false
        ? statusPorcelain!.split('\n').filter((l) => l.length > 0).length
        : 0;

      const targets = {
        runningVersion: normVer(runningVersion),
        versionFile: normVer(versionFile),
        rootPkg: normVer(rootPkgVersion),
        backendPkg: normVer(backendPkgVersion),
        frontendPkg: normVer(frontendPkgVersion),
        latestTag: normVer(describedTag),
        installedPackage: installedPackage?.parsedVersion ?? null
      };

      // Compute overall status. Order matters — first hit wins.
      let status:
        | 'all_matched'
        | 'dirty_working_tree'
        | 'version_drift'
        | 'git_tag_mismatch'
        | 'package_missing'
        | 'unknown' = 'unknown';
      let explanation = '';

      const haveAllVersionFields =
        targets.runningVersion &&
        targets.versionFile &&
        targets.rootPkg &&
        targets.backendPkg &&
        targets.frontendPkg;

      const versionFieldsAgree = haveAllVersionFields
        ? targets.runningVersion === targets.versionFile &&
          targets.runningVersion === targets.rootPkg &&
          targets.runningVersion === targets.backendPkg &&
          targets.runningVersion === targets.frontendPkg
        : false;

      if (!haveAllVersionFields) {
        status = 'unknown';
        explanation = 'One or more version sources could not be read.';
      } else if (!versionFieldsAgree) {
        status = 'version_drift';
        explanation = `Version sources disagree: VERSION=${targets.versionFile}, root=${targets.rootPkg}, backend=${targets.backendPkg}, frontend=${targets.frontendPkg}, running=${targets.runningVersion}.`;
      } else if (targets.latestTag && targets.latestTag !== targets.runningVersion) {
        status = 'git_tag_mismatch';
        explanation = `Installed version v${targets.runningVersion} does not match latest git tag v${targets.latestTag}.`;
      } else if (clean === false) {
        status = 'dirty_working_tree';
        explanation = `Working tree has ${uncommittedCount} uncommitted change(s) — deploy snapshot differs from the tagged source.`;
      } else if (!installedPackage || !targets.installedPackage || targets.installedPackage !== targets.runningVersion) {
        status = 'package_missing';
        explanation = installedPackage
          ? `Installed package v${targets.installedPackage} does not match running version v${targets.runningVersion}.`
          : `No canonical installed package found under ${UPDATE_PACKAGES_INSTALLED_DIR}.`;
      } else {
        status = 'all_matched';
        explanation = `Installed version v${targets.runningVersion} matches VERSION, all package.json files, latest git tag, and the installed package.`;
      }

      res.json({
        success: true,
        data: {
          status,
          explanation,
          fields: {
            runningVersion,
            versionFile,
            rootPackageJsonVersion: rootPkgVersion,
            backendPackageJsonVersion: backendPkgVersion,
            frontendPackageJsonVersion: frontendPkgVersion,
            latestGitTag: describedTag,
            installedPackage: installedPackage
              ? {
                  name: installedPackage.name,
                  parsedVersion: installedPackage.parsedVersion,
                  mtime: installedPackage.mtime
                }
              : null,
            branch,
            headSha,
            headShortSha,
            clean,
            uncommittedCount,
            remote: githubRepositoryUrl(remote ?? undefined),
            ...repositoryIdentity(remote)
          },
          checkedAt: new Date().toISOString(),
          ...buildAdditiveMeta()
        }
      });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /git/release-notes?version=vX.Y.Z
  // Reads CHANGELOG.md and returns only the matching version section.
  // The `version` parameter is validated against VERSION_QUERY_REGEX before
  // being used as a string match key — it is NEVER passed to git or a shell.
  // -------------------------------------------------------------------------
  router.get('/git/release-notes', async (req, res, next) => {
    try {
      const requested = typeof req.query.version === 'string' ? req.query.version.trim() : '';
      const fallback = await readReleaseVersion();
      const candidate = requested.length > 0 ? requested : fallback;

      if (!VERSION_QUERY_REGEX.test(candidate)) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_VERSION', message: 'Version must match X.Y.Z or vX.Y.Z.' }
        });
      }

      const version = normVer(candidate)!;
      const changelogPath = path.join(DEPLOY_DIR, 'CHANGELOG.md');

      let text: string;
      try {
        text = await fs.readFile(changelogPath, 'utf8');
      } catch {
        return res.json({
          success: true,
          data: {
            version,
            found: false,
            heading: null,
            body: null,
            message: `CHANGELOG.md not found at ${changelogPath}.`,
            path: changelogPath
          }
        });
      }

      const section = extractChangelogSection(text, version);
      if (!section) {
        return res.json({
          success: true,
          data: {
            version,
            found: false,
            heading: null,
            body: null,
            message: `No release notes found for v${version}.`,
            path: changelogPath
          }
        });
      }

      res.json({
        success: true,
        data: {
          version,
          found: true,
          heading: section.heading,
          body: section.body,
          path: changelogPath
        }
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
