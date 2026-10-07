import { Router } from 'express';
import { spawn } from 'node:child_process';
import { respond, AdminError } from '../envelope';
import { FORGE_ROOT, ACTIVE_APP, loadApp, type ForgeAppConfig } from '../forgeConfig';

const DEV_BRANCH = /^dev\/v[0-9]+\.[0-9]+\.[0-9]+$/;
const OUTPUT_LIMIT = 256 * 1024;
export interface GitResult { code: number; out: string; }
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

export type RepositoryBinding = 'matched' | 'mismatch' | 'missing_config' | 'invalid_config'
  | 'missing_origin' | 'unsupported_origin';

const REPOSITORY_MESSAGES: Record<RepositoryBinding, string> = {
  matched: 'Workspace origin matches this app’s configured GitHub repository.',
  mismatch: 'Workspace origin points to a different GitHub repository than this app’s configuration.',
  missing_config: 'This app does not have a GitHub repository configured.',
  invalid_config: 'This app’s configured repository is not a supported credential-free GitHub address.',
  missing_origin: 'The configured workspace does not have a readable origin remote.',
  unsupported_origin: 'Workspace origin is not a supported credential-free GitHub address.'
};


// Only this module's fixed, read-only commands reach this runner. Credentials
// stay in the host's Git/SSH credential store; no tokens or raw stderr reach UI.
export const runGit: GitRunner = (args, cwd) => new Promise(resolve => {
  const child = spawn('git', args, {
    cwd, shell: false,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
      SystemRoot: process.env.SystemRoot, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK, LANG: 'C.UTF-8', GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '', bytes = 0, ended = false;
  const finish = (code: number) => {
    if (ended) return;
    ended = true; clearTimeout(timer); resolve({ code, out: code === 0 ? out : '' });
  };
  const timer = setTimeout(() => { child.kill('SIGKILL'); finish(-1); }, 12_000);
  timer.unref();
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > OUTPUT_LIMIT) { child.kill('SIGKILL'); finish(-1); }
    else out += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > OUTPUT_LIMIT) { child.kill('SIGKILL'); finish(-1); }
  });
  child.once('error', () => finish(-1));
  child.once('close', code => finish(code ?? -1));
});

/** Browser-safe public repository identity, never an embedded password/token. */
export function githubRepositoryUrl(raw: string | undefined): string | null {
  if (!raw || /[\u0000-\u0020]/.test(raw)) return null;
  let repository: string;
  const ssh = /^(?:git@)?github\.com(?:-[A-Za-z0-9_-]+)?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(raw);
  if (ssh) repository = ssh[1];
  else {
    try {
      const url = new URL(raw);
      if (!['https:', 'ssh:'].includes(url.protocol) || url.hostname !== 'github.com'
        || url.port || url.search || url.hash || url.password
        || (url.username && !(url.protocol === 'ssh:' && url.username === 'git'))) return null;
      repository = url.pathname.replace(/^\//, '');
    } catch { return null; }
  }
  repository = repository.replace(/\.git$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || repository.split('/').some(part => part === '.' || part === '..')) return null;
  return 'https://github.com/' + repository;
}

export function buildForgeGitRoutes(options: { git?: GitRunner; config?: () => ForgeAppConfig } = {}): Router {
  const router = Router();
  const git = options.git ?? runGit;
  const config = options.config ?? (() => loadApp(ACTIVE_APP));
  let checking = false;
  const checked = async (args: string[], cwd: string) => {
    const result = await git(args, cwd);
    if (result.code !== 0) throw new AdminError(503, 'GIT_UNAVAILABLE', 'Cannot read the configured Git workspace. Check its path and service-account access.');
    return result.out.trim();
  };
  async function workspaceState(cfg: ForgeAppConfig) {
    const branch = await checked(['rev-parse', '--abbrev-ref', 'HEAD'], cfg.paths.workspaces);
    if (['main', 'master', ...(cfg.repo.blocked_branches ?? [])].includes(branch)) {
      throw new AdminError(403, 'PROTECTED_BRANCH', 'Forge administration requires an approved development branch.');
    }
    const remote = await git(['remote', 'get-url', 'origin'], cfg.paths.workspaces);
    const remoteAddress = remote.code === 0 ? remote.out.trim() : null;
    const remoteRepositoryUrl = githubRepositoryUrl(remoteAddress ?? undefined);
    const configuredRepositoryUrl = githubRepositoryUrl(cfg.repo.url);
    const repositoryBinding: RepositoryBinding = !cfg.repo.url ? 'missing_config'
      : !configuredRepositoryUrl ? 'invalid_config'
      : !remoteAddress ? 'missing_origin'
      : !remoteRepositoryUrl ? 'unsupported_origin'
      : remoteRepositoryUrl.toLowerCase() !== configuredRepositoryUrl.toLowerCase() ? 'mismatch'
      : 'matched';
    return { branch, remoteAddress, identity: {
      appId: cfg.app_id, appName: cfg.name,
      // Always identify the configured app repository. A different workspace
      // origin is a separate fact and must never replace this link in the UI.
      repositoryUrl: configuredRepositoryUrl, configuredRepositoryUrl, remoteRepositoryUrl,
      remoteConfigured: !!remoteRepositoryUrl, remoteMatchesConfig: repositoryBinding === 'matched',
      repositoryBinding, repositoryMessage: REPOSITORY_MESSAGES[repositoryBinding]
    } };
  }
  router.get('/git/status', async (_req, res, next) => {
    try {
      const cfg = config(), workspace = cfg.paths.workspaces;
      const state = await workspaceState(cfg);
      const [statusShort, head, branches, upstreamResult] = await Promise.all([
        checked(['status', '--short'], workspace), checked(['rev-parse', 'HEAD'], workspace),
        checked(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin'], workspace),
        git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], workspace)
      ]);
      const upstream = upstreamResult.code === 0 ? upstreamResult.out.trim() : null;
      const counts = upstream ? await git(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], workspace) : null;
      const match = counts?.code === 0 ? /^(\d+)\s+(\d+)$/.exec(counts.out.trim()) : null;
      respond.ok(res, { forgeRoot: FORGE_ROOT, workspace, branch: state.branch, ...state.identity, head,
        branchAllowed: DEV_BRANCH.test(state.branch), dirty: statusShort.length > 0, statusShort,
        devBranches: [...new Set(branches.split('\n').map(s => s.trim().replace(/^origin\//, '')).filter(s => DEV_BRANCH.test(s)))].sort(),
        defaultDevBranch: cfg.repo.default_dev_branch ?? '', upstream,
        ahead: match ? Number(match[1]) : null, behind: match ? Number(match[2]) : null });
    } catch (error) { next(error); }
  });
  router.post('/git/check-remote', async (req, res, next) => {
    try {
      if (!req.body || Array.isArray(req.body) || Object.keys(req.body).length !== 0) {
        throw new AdminError(400, 'INVALID_REQUEST_BODY', 'Connection checks accept an empty JSON object.');
      }
      if (checking) throw new AdminError(409, 'GIT_CHECK_BUSY', 'A repository connection check is already running.');
      checking = true;
      try {
        const cfg = config(), state = await workspaceState(cfg);
        if (!DEV_BRANCH.test(state.branch)) throw new AdminError(403, 'DEV_BRANCH_REQUIRED', 'Select an approved dev/vX.Y.Z branch on the host first.');
        if (!state.identity.remoteMatchesConfig || !state.remoteAddress) {
          throw new AdminError(409, 'GIT_REMOTE_MISMATCH', state.identity.repositoryMessage);
        }
        // Pin the validated resolved origin address. Reusing the name "origin"
        // would permit a host-side config change to check another repository
        // after the identity comparison above. This command never fetches.
        const branchRef = 'refs/heads/' + state.branch;
        const result = await git(['ls-remote', '--exit-code', '--heads', state.remoteAddress, branchRef], cfg.paths.workspaces);
        const remoteHead = result.code === 0 ? result.out.trim().split('\n')
          .map(line => /^([a-f0-9]{40,64})\s+(\S+)$/.exec(line.trim()))
          .find(match => match?.[2] === branchRef)?.[1] ?? null : null;
        const connected = (result.code === 0 && !!remoteHead) || result.code === 2;
        respond.ok(res, { connected, ...state.identity, workspace: cfg.paths.workspaces, branch: state.branch, remoteHead,
          checkedAt: new Date().toISOString(), message: connected
            ? remoteHead ? 'GitHub connection verified for this development branch.' : 'GitHub connection verified. This development branch has not been pushed yet.'
            : 'GitHub could not be reached. Check the host’s Git credentials, SSH host key, repository access and network.' });
      } finally { checking = false; }
    } catch (error) { next(error); }
  });
  return router;
}
