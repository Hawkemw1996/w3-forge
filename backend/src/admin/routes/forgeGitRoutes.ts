import { Router } from 'express';
import { spawn } from 'node:child_process';
import { respond, AdminError } from '../envelope';
import { FORGE_ROOT, ACTIVE_APP, loadApp } from '../forgeConfig';

// Slim, READ-ONLY git surface. Wraps `git status` and `git branch` against
// the configured workspace. Filters branches to dev/v* per Forge rules and
// explicitly rejects any reference to main/master.

const BRANCH_FILTER = /^dev\/v[0-9]+\.[0-9]+\.[0-9]+$/;
const FORBIDDEN_BRANCH = /^(main|master)$/;

function runGit(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      shell: false,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('close', (code) => resolve({ code: code ?? -1, out, err }));
    child.on('error', (e) => resolve({ code: -1, out, err: err + e.message }));
  });
}

export function buildForgeGitRoutes(): Router {
  const router = Router();

  router.get('/git/status', async (_req, res, next) => {
    try {
      const cfg = loadApp(ACTIVE_APP);
      const workspace = cfg.paths.workspaces;
      const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], workspace);
      const branchName = branch.out.trim();
      if (FORBIDDEN_BRANCH.test(branchName)) {
        throw new AdminError(
          403,
          'PROTECTED_BRANCH',
          `Forge admin refuses to operate on ${branchName}`
        );
      }
      const status = await runGit(['status', '--short'], workspace);
      const branches = await runGit(['branch', '--list'], workspace);
      const devBranches = branches.out
        .split('\n')
        .map((s) => s.replace(/^\*?\s+/, '').trim())
        .filter((s) => s.length > 0 && BRANCH_FILTER.test(s));
      respond.ok(res, {
        forgeRoot: FORGE_ROOT,
        workspace,
        branch: branchName,
        branchAllowed: BRANCH_FILTER.test(branchName),
        dirty: status.out.trim().length > 0,
        statusShort: status.out,
        devBranches
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
