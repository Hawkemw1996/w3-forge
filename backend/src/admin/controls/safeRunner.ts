// =============================================================================
// safeRunner — the ONLY path from an HTTP request to a child process.
// =============================================================================
//
// Invariants (all enforced + tested):
//
//   1. spawn() is called with the array form. shell: false (default), never
//      shell: true. exec / execSync are never imported.
//   2. The frontend body only carries { controlId, appId, inputs? }. The
//      runner builds the argv internally via registry.buildArgs(typedInputs).
//      No arbitrary string is ever joined into a command.
//   3. The script path is path.join(FORGE_ROOT, 'scripts', scriptName),
//      followed by fs.realpath, with an assertion that the real path is
//      still under FORGE_ROOT/scripts. Symlink escape → 403.
//   4. Environment is an explicit allowlist (PATH, HOME, LANG, W3_FORGE_ROOT).
//      process.env is never spread.
//   5. Per-control mutex via actionLock prevents concurrent runs of the
//      same control id.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AdminError } from '../envelope';
import { FORGE_ROOT, loadApp } from '../forgeConfig';
import { getControl } from './registry';
import { ID_REGEX } from './validator';
import { tryAcquire, release } from './actionLock';
import type { ControlRunResult } from './types';

const ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'W3_FORGE_ROOT'] as const;

function buildChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key];
    if (typeof v === 'string') env[key] = v;
  }
  // Always ensure W3_FORGE_ROOT is set in the child env even if the parent
  // ran without it; the scripts depend on it.
  if (!env.W3_FORGE_ROOT) env.W3_FORGE_ROOT = FORGE_ROOT;
  return env;
}

function resolveScriptPath(scriptName: string): string {
  // Disallow any path-like content in scriptName itself.
  if (scriptName.includes('/') || scriptName.includes('\\') || scriptName.includes('..')) {
    throw new AdminError(403, 'SCRIPT_NAME_INVALID', `Invalid script name: ${scriptName}`);
  }
  const scriptsDir = path.join(FORGE_ROOT, 'scripts');
  const candidate = path.join(scriptsDir, scriptName);
  if (!fs.existsSync(candidate)) {
    throw new AdminError(404, 'SCRIPT_NOT_FOUND', `Script not found: ${scriptName}`);
  }
  const realScriptsDir = fs.realpathSync(scriptsDir);
  const realCandidate = fs.realpathSync(candidate);
  if (
    realCandidate !== realScriptsDir &&
    !realCandidate.startsWith(realScriptsDir + path.sep)
  ) {
    throw new AdminError(
      403,
      'SCRIPT_PATH_ESCAPE',
      `Script path escapes ${scriptsDir}: ${realCandidate}`
    );
  }
  return realCandidate;
}

function assertAllowedByConfig(scriptName: string, appId: string): void {
  const cfg = loadApp(appId);
  const allowed = cfg.admin_console?.allowed_scripts ?? [];
  if (!allowed.includes(scriptName)) {
    throw new AdminError(
      403,
      'SCRIPT_NOT_ALLOWED',
      `Script not in admin_console.allowed_scripts for app ${appId}: ${scriptName}`
    );
  }
}

export interface RunControlOptions {
  controlId: string;
  appId: string;
  inputs?: unknown;
}

export async function runControl(opts: RunControlOptions): Promise<ControlRunResult> {
  const { controlId, appId } = opts;

  if (!ID_REGEX.test(controlId)) {
    throw new AdminError(400, 'INVALID_CONTROL_ID', `Invalid control id: ${controlId}`);
  }
  if (!ID_REGEX.test(appId)) {
    throw new AdminError(400, 'INVALID_APP_ID', `Invalid app id: ${appId}`);
  }

  const control = getControl(controlId);
  if (!control) {
    throw new AdminError(404, 'CONTROL_NOT_FOUND', `Unknown control: ${controlId}`);
  }

  // Validate inputs against the control's Zod schema. Any failure → 400.
  let typedInputs: unknown;
  try {
    typedInputs = control.inputSchema.parse(opts.inputs ?? {});
  } catch (e) {
    throw new AdminError(400, 'INVALID_INPUTS', (e as Error).message);
  }

  // Build args from typed inputs ONLY. Result must be a string[].
  const extraArgs = control.buildArgs(typedInputs);
  if (!Array.isArray(extraArgs) || extraArgs.some((a) => typeof a !== 'string')) {
    throw new AdminError(500, 'BUILD_ARGS_INVALID', `buildArgs must return string[]`);
  }

  // Confirm script is allowlisted by both the registry (implicit, since we
  // got here) AND the app config (defense-in-depth).
  assertAllowedByConfig(control.scriptName, appId);

  const scriptPath = resolveScriptPath(control.scriptName);

  // Per-control mutex. Concurrent runs of the same control are refused.
  const lockKey = `${appId}::${controlId}`;
  if (!tryAcquire(lockKey)) {
    throw new AdminError(409, 'CONTROL_BUSY', `Control already running: ${controlId}`);
  }

  const args = ['--app', appId, ...extraArgs];
  const env = buildChildEnv();
  const start = Date.now();
  const timeoutMs = control.timeoutSeconds * 1000;

  try {
    return await new Promise<ControlRunResult>((resolve) => {
      // EXPLICIT array-form spawn. No shell. Hardcoded options to make the
      // safety contract auditable by `git grep`.
      const child = spawn(scriptPath, args, {
        cwd: FORGE_ROOT,
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString('utf8');
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          controlId,
          appId,
          scriptName: control.scriptName,
          args,
          exitCode: -1,
          durationMs: Date.now() - start,
          stdout,
          stderr: stderr + `\n[spawn-error] ${err.message}`,
          timedOut
        });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          controlId,
          appId,
          scriptName: control.scriptName,
          args,
          exitCode: typeof code === 'number' ? code : -1,
          durationMs: Date.now() - start,
          stdout,
          stderr,
          timedOut
        });
      });
    });
  } finally {
    release(lockKey);
  }
}

// Exposed for tests — does NOT spawn, only plans the invocation. Returns the
// argv array and the resolved env so tests can assert no shell-interpreted
// strings and no process.env spread.
export function planControlInvocation(opts: RunControlOptions): {
  scriptPath: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  shell: false;
} {
  const { controlId, appId } = opts;
  if (!ID_REGEX.test(controlId)) {
    throw new AdminError(400, 'INVALID_CONTROL_ID', `Invalid control id: ${controlId}`);
  }
  if (!ID_REGEX.test(appId)) {
    throw new AdminError(400, 'INVALID_APP_ID', `Invalid app id: ${appId}`);
  }
  const control = getControl(controlId);
  if (!control) {
    throw new AdminError(404, 'CONTROL_NOT_FOUND', `Unknown control: ${controlId}`);
  }
  const typedInputs = control.inputSchema.parse(opts.inputs ?? {});
  const extraArgs = control.buildArgs(typedInputs);
  assertAllowedByConfig(control.scriptName, appId);
  const scriptPath = resolveScriptPath(control.scriptName);
  return {
    scriptPath,
    argv: ['--app', appId, ...extraArgs],
    env: buildChildEnv(),
    shell: false
  };
}
