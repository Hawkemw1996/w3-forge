import { spawn } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdminError } from '../admin/envelope';

export type ProviderId = 'codex' | 'claude';
export type ConnectionState = 'not_installed' | 'signed_out' | 'signed_in' | 'unavailable';
export interface ConnectionTest { status: 'passed' | 'failed'; checkedAt: string; message: string }
export interface ProviderConnection {
  id: ProviderId; name: string; state: ConnectionState; account: string; version: string | null;
  authMethod: 'chatgpt' | 'claude_subscription' | 'api_key' | 'other' | 'unknown';
  checkedAt: string; message: string; test: ConnectionTest | null;
}
export interface Identity { name: string; uid: number; gid: number; home: string }
export interface CommandResult { code: number; stdout: string; stderr: string }
export interface Invocation { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeout: number }
export const CONNECTION_PROMPT = 'Reply with exactly W3_FORGE_CONNECTION_OK. Do not use tools, read files, run commands, or modify anything.';
const TOKEN = 'W3_FORGE_CONNECTION_OK';
const names = { codex: 'Codex', claude: 'Claude' };
const CACHE_MS = 30_000;
const TEST_COOLDOWN_MS = 30_000;

// These commands never receive a browser-supplied prompt, command, path or environment.
export function providerArgs(id: ProviderId, action: 'version' | 'status' | 'test'): string[] {
  if (action === 'version') return ['--version'];
  if (action === 'status') return id === 'codex' ? ['login', 'status'] : ['auth', 'status'];
  return id === 'codex'
    ? ['exec', '--ignore-user-config', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--json',
      '-c', 'approval_policy="never"', '-c', 'mcp_servers={}', '-c', 'features.shell_tool=false', '-c', 'features.shell_snapshot=false',
      '-c', 'features.apply_patch_freeform=false', '-c', 'features.apps=false', '-c', 'web_search="disabled"', CONNECTION_PROMPT]
    : ['-p', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
      '--disable-slash-commands', '--no-session-persistence', '--output-format', 'json', '--max-turns', '1', CONNECTION_PROMPT];
}

export function parseIdentity(contents: string, name: string): Identity {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(name) || name === 'root') throw Error('Invalid AI account');
  const fields = contents.split('\n').find(line => line.split(':')[0] === name)?.split(':');
  if (!fields || fields.length !== 7) throw Error('AI account unavailable');
  const uid = Number(fields[2]), gid = Number(fields[3]), home = fields[5];
  if (!/^\d+$/.test(fields[2]) || !/^\d+$/.test(fields[3]) || !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)
    || uid <= 0 || gid <= 0 || !path.posix.isAbsolute(home) || home === '/' || /[\s\x00-\x1f]/.test(home)
    || path.posix.normalize(home) !== home) throw Error('Invalid AI account');
  return { name, uid, gid, home };
}

export function planProviderInvocation(identity: Identity, id: ProviderId, action: 'version' | 'status' | 'test', cwd: string, currentUid: number): Invocation {
  if (!['codex', 'claude'].includes(id) || identity.uid <= 0 || identity.gid <= 0) throw Error('Invalid provider');
  const binary = path.posix.join(identity.home, '.local/bin', id);
  const env = { HOME: identity.home, USER: identity.name, LOGNAME: identity.name, LANG: 'C.UTF-8',
    PATH: path.posix.join(identity.home, '.local/bin') + ':/usr/local/bin:/usr/bin:/bin',
    DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  const args = providerArgs(id, action);
  const timeout = action === 'test' ? 60_000 : 10_000;
  if (currentUid === 0) return { file: '/usr/sbin/runuser', args: ['--user', identity.name, '--', '/usr/bin/env', '-i',
    ...Object.entries(env).map(([key, value]) => key + '=' + value), binary, ...args], cwd,
    env: { PATH: '/usr/sbin:/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout };
  if (currentUid !== identity.uid) throw Error('Service cannot use the AI account');
  return { file: binary, args, cwd, env, timeout };
}

export async function executeProvider(invocation: Invocation): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.file, invocation.args, { cwd: invocation.cwd, env: invocation.env, shell: false,
      windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, failed = false;
    const kill = () => {
      failed = true;
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Already exited. */ }
    };
    const timer = setTimeout(kill, invocation.timeout);
    const collect = (value: Buffer, isError: boolean) => {
      bytes += value.length;
      if (bytes > 131_072) { kill(); return; }
      if (isError) stderr += value.toString('utf8'); else stdout += value.toString('utf8');
    };
    child.stdout.on('data', value => collect(value, false));
    child.stderr.on('data', value => collect(value, true));
    child.on('error', () => { clearTimeout(timer); reject(Error('Provider command unavailable')); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (failed || signal || code === null) reject(Error('Provider command unavailable'));
      else resolve({ code, stdout, stderr });
    });
  });
}

export interface ProviderSources {
  platform(): string; uid(): number; passwd(): Promise<string>; executable(file: string): Promise<void>;
  directory(): Promise<string>; cleanup(directory: string): Promise<void>; execute(invocation: Invocation): Promise<CommandResult>;
}
const sources: ProviderSources = {
  platform: () => process.platform, uid: () => process.getuid?.() ?? -1, passwd: () => readFile('/etc/passwd', 'utf8'),
  executable: file => access(file, constants.X_OK),
  directory: async () => { const dir = await mkdtemp(path.join(os.tmpdir(), 'w3forge-connection-')); await chmod(dir, 0o755); return dir; },
  cleanup: directory => rm(directory, { recursive: true, force: true }), execute: executeProvider,
};

function version(output: string): string | null {
  const match = /^(?:(?:codex-cli|Codex CLI)\s+)?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)(?:\s+\(Claude Code\))?\s*$/.exec(output.trim());
  return match?.[1]?.slice(0, 64) ?? null;
}
export function authenticated(id: ProviderId, result: CommandResult): ProviderConnection['authMethod'] | null {
  if (result.code !== 0) return null;
  if (id === 'claude') {
    const data = JSON.parse(result.stdout);
    if (data?.loggedIn === false) return null;
    if (data?.loggedIn !== true) throw Error('Unrecognized sign-in response');
    if (['claude.ai', 'oauth_token'].includes(data.authMethod)) return 'claude_subscription';
    if (['api_key', 'api_key_helper'].includes(data.authMethod)) return 'api_key';
    return 'other';
  }
  const text = result.stdout + '\n' + result.stderr;
  if (/Logged in using ChatGPT/i.test(text)) return 'chatgpt';
  if (/Logged in using an? API key/i.test(text)) return 'api_key';
  if (/Logged in using/i.test(text)) return 'other';
  throw Error('Unrecognized sign-in response');
}

export function completedTest(id: ProviderId, result: CommandResult): boolean {
  if (result.code !== 0) return false;
  if (id === 'claude') {
    const data = JSON.parse(result.stdout);
    return data.type === 'result' && data.subtype === 'success' && data.is_error !== true && data.result?.trim() === TOKEN;
  }
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  return events.some(event => event.type === 'turn.completed')
    && !events.some(event => ['turn.failed', 'error'].includes(event.type) || (event.type === 'item.completed' && !['agent_message', 'reasoning'].includes(event.item?.type)))
    && events.some(event => event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text?.trim() === TOKEN);
}

export function createProviderConnections(options: { account?: string; now?: () => number; sources?: Partial<ProviderSources> } = {}) {
  const account = options.account ?? process.env.W3_FORGE_AI_USER?.trim() ?? 'forge-ai';
  const read = { ...sources, ...options.sources }, now = options.now ?? Date.now;
  const cache = new Map<ProviderId, { at: number; value: ProviderConnection }>();
  const inFlight = new Map<ProviderId, Promise<ProviderConnection>>();
  const tests = new Map<ProviderId, ConnectionTest>();
  const testing = new Set<ProviderId>(), attemptedAt = new Map<ProviderId, number>();
  const label = /^[a-z_][a-z0-9_-]{0,31}$/.test(account) && account !== 'root' ? account : 'Invalid account';
  const empty = (id: ProviderId): ProviderConnection => ({ id, name: names[id], account: label, state: 'unavailable', version: null,
    authMethod: 'unknown', checkedAt: new Date(now()).toISOString(), message: 'The AI account or CLI check is unavailable. Check the server setup.', test: null });
  async function context() {
    if (read.platform() !== 'linux') throw Error('Linux required');
    return parseIdentity(await read.passwd(), account);
  }
  async function invoke(identity: Identity, id: ProviderId, action: 'version' | 'status' | 'test') {
    const dir = await read.directory();
    try { return await read.execute(planProviderInvocation(identity, id, action, dir, read.uid())); }
    finally { await read.cleanup(dir); }
  }
  async function collect(id: ProviderId) {
    const result = empty(id);
    try {
      const identity = await context();
      try { await read.executable(path.posix.join(identity.home, '.local/bin', id)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { result.state = 'not_installed'; result.message = 'Install ' + names[id] + ' for ' + account + ' in ~/.local/bin.'; }
        return result;
      }
      const installed = await invoke(identity, id, 'version');
      result.version = installed.code === 0 ? version(installed.stdout) : null;
      if (!result.version) return result;
      const auth = await invoke(identity, id, 'status');
      // Unsupported commands or abnormal output must not be mistaken for a signed-out account.
      if (auth.code !== 0 && (auth.code !== 1 || !(/not logged in|not signed in/i.test(auth.stdout + auth.stderr)
        || (id === 'claude' && (() => { try { return JSON.parse(auth.stdout).loggedIn === false; } catch { return false; } })())))) return result;
      const method = authenticated(id, auth);
      result.state = method ? 'signed_in' : 'signed_out'; result.authMethod = method ?? 'unknown';
      result.message = method ? names[id] + ' is signed in as the ' + account + ' Linux account. Run a connection test to verify model access.'
        : 'Sign in to ' + names[id] + ' from the ' + account + ' Linux account.';
      if (method) result.test = tests.get(id) ?? null;
    } catch { /* Never return CLI output, account email, paths to credentials, or raw errors. */ }
    if (result.state !== 'signed_in') tests.delete(id);
    return result;
  }
  function check(id: ProviderId, force = false): Promise<ProviderConnection> {
    if (inFlight.has(id)) return inFlight.get(id)!;
    const cached = cache.get(id);
    if (!force && cached && now() >= cached.at && now() - cached.at < CACHE_MS) return Promise.resolve(cached.value);
    const pending = collect(id).then(value => {
      const previous = cache.get(id)?.value;
      if (value.state !== 'signed_in' || (previous && (previous.version !== value.version || previous.authMethod !== value.authMethod))) {
        tests.delete(id); value.test = null;
      }
      cache.set(id, { at: now(), value }); return value;
    }).finally(() => inFlight.delete(id));
    inFlight.set(id, pending); return pending;
  }
  return {
    inventory: () => Promise.all([check('codex'), check('claude')]),
    async test(id: ProviderId): Promise<ProviderConnection> {
      if (id !== 'codex' && id !== 'claude') throw new AdminError(400, 'INVALID_AI_PROVIDER', 'Choose Codex or Claude.');
      if (testing.has(id)) throw new AdminError(429, 'AI_TEST_BUSY', 'A connection test is already running for this provider.');
      const last = attemptedAt.get(id);
      if (last !== undefined && now() - last < TEST_COOLDOWN_MS) throw new AdminError(429, 'AI_TEST_COOLDOWN', 'Wait 30 seconds before testing this provider again.');
      testing.add(id); attemptedAt.set(id, now());
      try {
        const connection = await check(id, true);
        if (connection.state !== 'signed_in') throw new AdminError(409, 'AI_SIGN_IN_REQUIRED', connection.message);
        let passed = false;
        try { passed = completedTest(id, await invoke(await context(), id, 'test')); } catch { /* Sanitized below. */ }
        const test: ConnectionTest = { status: passed ? 'passed' : 'failed', checkedAt: new Date(now()).toISOString(),
          message: passed ? 'The provider completed the fixed connection request.' : 'The provider did not complete the connection request. Check sign-in, quota, network access and CLI compatibility on the server.' };
        tests.set(id, test);
        const value = { ...connection, test };
        cache.set(id, { at: now(), value });
        return value;
      } finally { testing.delete(id); }
    },
  };
}
