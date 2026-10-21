import { describe, expect, it, vi } from 'vitest';
import { authenticated, completedTest, createProviderConnections, executeProvider, parseIdentity, planProviderInvocation, providerArgs, type Invocation, type ProviderSources } from '../src/workspace/providerConnections';

const passwd = 'root:x:0:0::/root:/bin/bash\nforge-ai:x:1001:1001::/home/forge-ai:/bin/bash\n';
const identity = parseIdentity(passwd, 'forge-ai');
const ok = (stdout = '', stderr = '', code = 0) => ({ stdout, stderr, code });
function fixture() {
  let time = 1_792_600_000_000;
  const execute = vi.fn(async (inv: Invocation) => {
    const args = inv.args;
    if (args.at(-1) === '--version') return ok(args.some(arg => arg.endsWith('/claude')) ? '2.1.120 (Claude Code)' : 'codex-cli 0.120.0');
    if (args.at(-1) === 'status') return args.includes('auth') ? ok(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'private@example.test', accessToken: 'never-return-this' })) : ok('', 'Logged in using ChatGPT');
    return args.includes('--max-turns') ? ok(JSON.stringify({ type: 'result', subtype: 'success', result: 'W3_FORGE_CONNECTION_OK' }))
      : ok(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'W3_FORGE_CONNECTION_OK' } }) + '\n' + JSON.stringify({ type: 'turn.completed' }));
  });
  const sources: ProviderSources = { platform: () => 'linux', uid: () => 0, passwd: async () => passwd,
    executable: vi.fn(async () => {}), directory: vi.fn(async () => '/tmp/isolated-check'), cleanup: vi.fn(async () => {}), execute };
  const service = createProviderConnections({ sources, now: () => time });
  return { service, sources, execute, advance: (ms = 30_001) => { time += ms; } };
}

describe('Codex and Claude account connections', () => {
  it('checks both CLIs under the non-root account and never exposes account identifiers or raw output', async () => {
    const f = fixture(), result = await f.service.inventory();
    expect(result.map(item => item.state)).toEqual(['signed_in', 'signed_in']);
    expect(result.map(item => item.authMethod)).toEqual(['chatgpt', 'claude_subscription']);
    expect(result.every(item => item.test === null)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private@example|never-return-this/);
    for (const [inv] of f.execute.mock.calls) {
      expect(inv.file).toBe('/usr/sbin/runuser');
      expect(inv.args.slice(0, 6)).toEqual(['--user', 'forge-ai', '--', '/usr/bin/env', '-i', 'HOME=/home/forge-ai']);
      expect(inv.env).toEqual({ PATH: '/usr/sbin:/usr/bin:/bin', LANG: 'C.UTF-8' });
      expect(inv.cwd).toBe('/tmp/isolated-check');
      expect(inv.args).not.toContain('exec');
    }
    expect(f.sources.cleanup).toHaveBeenCalledTimes(4);
  });
  it('caches and shares refresh work without starting a model request', async () => {
    const f = fixture();
    await Promise.all([f.service.inventory(), f.service.inventory()]);
    expect(f.execute).toHaveBeenCalledTimes(4);
    await f.service.inventory(); expect(f.execute).toHaveBeenCalledTimes(4);
    f.advance(); await f.service.inventory(); expect(f.execute).toHaveBeenCalledTimes(8);
  });
  it('distinguishes missing tools, signed-out accounts and unsupported/failed checks independently', async () => {
    const f = fixture();
    vi.mocked(f.sources.executable).mockImplementation(async file => { if (file.endsWith('codex')) throw Object.assign(Error('missing'), { code: 'ENOENT' }); });
    f.execute.mockImplementation(async inv => inv.args.at(-1) === '--version' ? ok('2.1.120 (Claude Code)') : ok('{"loggedIn":false}', '', 1));
    expect((await f.service.inventory()).map(item => item.state)).toEqual(['not_installed', 'signed_out']);
    f.advance(); f.execute.mockImplementation(async () => { throw Error('private-token'); });
    expect((await f.service.inventory())[1].state).toBe('unavailable');
    await expect(f.service.test('claude')).rejects.toMatchObject({ code: 'AI_SIGN_IN_REQUIRED' });
  });
  it('requires recognizable CLI output instead of treating an exit-0 failure as signed in', async () => {
    expect(() => authenticated('codex', ok('something unexpected'))).toThrow();
    expect(authenticated('claude', ok('{"loggedIn":false}'))).toBeNull();
    const f = fixture(); f.execute.mockResolvedValue(ok('invalid output including secret'));
    const result = await f.service.inventory();
    expect(result.every(item => item.state === 'unavailable')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('tests actual model completion, with fixed instructions and CLI guard arguments', async () => {
    const f = fixture();
    for (const id of ['codex', 'claude'] as const) expect((await f.service.test(id)).test?.status).toBe('passed');
    expect(providerArgs('codex', 'test')).toContain('read-only');
    expect(providerArgs('codex', 'test')).toContain('approval_policy="never"');
    expect(providerArgs('codex', 'test')).toContain('--ignore-user-config');
    expect(providerArgs('claude', 'test')).toContain('--strict-mcp-config');
    expect(providerArgs('claude', 'test').slice(1, 3)).toEqual(['--tools', '']);
    expect(providerArgs('claude', 'test')).not.toContain('--dangerously-skip-permissions');
    expect(f.sources.cleanup).toHaveBeenCalledTimes(6);
  });
  it('does not turn partial, malformed or failed model output into a passing test', () => {
    expect(completedTest('codex', ok('{"type":"turn.completed"}'))).toBe(false);
    expect(completedTest('codex', ok('{"type":"item.completed","item":{"type":"agent_message","text":"W3_FORGE_CONNECTION_OK"}}'))).toBe(false);
    expect(completedTest('claude', ok('{"type":"result","subtype":"error_during_execution","result":"W3_FORGE_CONNECTION_OK"}'))).toBe(false);
    expect(completedTest('claude', ok('{"type":"result","subtype":"success","is_error":true,"result":"W3_FORGE_CONNECTION_OK"}'))).toBe(false);
    expect(completedTest('codex', ok('', '', 1))).toBe(false);
  });
  it('records safe test failures and invalidates a prior pass when sign-in disappears', async () => {
    const f = fixture(); expect((await f.service.test('codex')).test?.status).toBe('passed');
    f.advance(); f.execute.mockImplementation(async inv => inv.args.at(-1) === '--version' ? ok('codex-cli 0.120.0')
      : inv.args.at(-1) === 'status' ? ok('', 'Logged in using ChatGPT') : ok('private-model-output', 'secret', 1));
    const failed = await f.service.test('codex'); expect(failed.test?.status).toBe('failed');
    expect(JSON.stringify(failed)).not.toMatch(/secret|private-model-output/);
    f.advance(); f.execute.mockImplementation(async inv => inv.args.at(-1) === '--version' ? ok('codex-cli 0.120.0') : ok('', 'Not logged in', 1));
    const signedOut = (await f.service.inventory())[0];
    expect(signedOut.state).toBe('signed_out'); expect(signedOut.test).toBeNull();
  });
  it('rejects duplicate model requests and enforces the cooldown', async () => {
    const f = fixture();
    let release!: () => void;
    const wait = new Promise<void>(r => { release = r; });
    const real = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async inv => { if (inv.args.includes('exec')) await wait; return real(inv); });
    const pending = f.service.test('codex');
    await expect(f.service.test('codex')).rejects.toMatchObject({ code: 'AI_TEST_BUSY' });
    release(); await pending;
    await expect(f.service.test('codex')).rejects.toMatchObject({ code: 'AI_TEST_COOLDOWN' });
    await expect(f.service.test('perplexity' as any)).rejects.toMatchObject({ code: 'INVALID_AI_PROVIDER' });
  });
  it('rejects root and invalid accounts and cannot switch from an unrelated service user', async () => {
    for (const name of ['root', '../root', 'forge-ai;id']) expect(() => parseIdentity(passwd, name)).toThrow();
    expect(() => parseIdentity('forge-ai:x:0:1001::/home/forge-ai:/bin/bash', 'forge-ai')).toThrow();
    expect(() => planProviderInvocation(identity, 'codex', 'status', '/tmp/check', 1002)).toThrow();
    expect(planProviderInvocation(identity, 'codex', 'status', '/tmp/check', 1001).file).toBe('/home/forge-ai/.local/bin/codex');
    const f = fixture(); f.sources.uid = () => 1002;
    expect((await createProviderConnections({ sources: f.sources }).inventory()).every(item => item.state === 'unavailable')).toBe(true);
  });
  it('bounds subprocess output and runtime and reports ordinary nonzero exits as data', async () => {
    const invocation = (script: string, timeout = 1000): Invocation => ({ file: process.execPath, args: ['-e', script], cwd: process.cwd(), env: {}, timeout });
    expect(await executeProvider(invocation('process.stdout.write("ok");process.exitCode=1'))).toMatchObject({ code: 1, stdout: 'ok' });
    await expect(executeProvider(invocation('process.stdout.write("x".repeat(140000))'))).rejects.toThrow('Provider command unavailable');
    await expect(executeProvider(invocation('setInterval(()=>{},1000)', 30))).rejects.toThrow('Provider command unavailable');
  });
});
