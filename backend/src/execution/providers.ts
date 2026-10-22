import { readBootId, bootRelation } from './identity';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rm, chmod, mkdtemp, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { planProviderInvocation, parseIdentity } from '../workspace/providerConnections';
import { createOllama } from '../workspace/ollama';
import type { ExecutionProfile } from './types';
export class ExecutionFailure extends Error {
    constructor(public code: string, message: string) { super(message); }
}
export interface ModelResult {
    text: string;
    provider: string;
    requestedModel: string | null;
    resolvedModel: string | null;
}
const failure = () => new ExecutionFailure('PROVIDER_FAILED', 'The assigned provider did not complete. Check its connection, quota and CLI compatibility.');
export function parseModelResult(provider: 'codex' | 'claude', output: string): string {
    try {
        if (provider === 'claude') {
            const data = JSON.parse(output);
            if (data.type !== 'result' || data.subtype !== 'success' || data.is_error || typeof data.result !== 'string')
                throw failure();
            return data.result;
        }
        const events = output.trim().split('\n').map(line => JSON.parse(line));
        if (!events.some(e => e.type === 'turn.completed') || events.some(e => ['turn.failed', 'error'].includes(e.type) || (e.type === 'item.completed' && !['agent_message', 'reasoning'].includes(e.item?.type))))
            throw failure();
        const messages = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message');
        if (!messages.length || typeof messages.at(-1).item.text !== 'string')
            throw failure();
        return messages.at(-1).item.text;
    }
    catch {
        throw failure();
    }
}
export function parseObject(text: string): Record<string, unknown> {
    try {
        const value = JSON.parse(text.trim());
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw Error();
        return value;
    }
    catch {
        throw new ExecutionFailure('INVALID_MODEL_RESPONSE', 'The assigned agent returned an invalid structured response.');
    }
}
interface Operation {
    bootId?: string;
    launching: boolean;
    pid?: number;
    start?: string;
    cwd?: string;
    createdAt?: string;
}
async function procStart(pid: number): Promise<string | null> {
    try {
        const value = await readFile('/proc/' + pid + '/stat', 'utf8');
        return value.slice(value.lastIndexOf(')') + 2).split(' ')[19];
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT')
            return null;
        throw e;
    }
}
async function persist(file: string, value: unknown) {
    const tmp = file + '.tmp';
    const h = await open(tmp, 'w', 0o600);
    try {
        await h.writeFile(JSON.stringify(value));
        await h.sync();
    }
    finally {
        await h.close();
    }
    await rename(tmp, file);
    const d = await open(path.dirname(file), 'r');
    try {
        await d.sync();
    }
    finally {
        await d.close();
    }
}
export class ModelBroker {
    constructor(private root: string, private timeoutMs = 600000, private ollama = createOllama()) { }
    private file(id: string) {
        if (!/^[a-zA-Z0-9-]{1,80}$/.test(id))
            throw failure();
        return path.join(this.root, '.provider-operations', id + '.json');
    }
    async recover(id: string): Promise<boolean> {
        const file = this.file(id);
        let op: Operation;
        try {
            op = JSON.parse(await readFile(file, 'utf8'));
        }
        catch (e) {
            return (e as NodeJS.ErrnoException).code === 'ENOENT';
        }
        const relation = bootRelation(op.bootId, await readBootId());
        if (relation === 'unknown')
            return false;
        if (relation === 'previous') {
            await rm(file, { force: true });
            return true;
        }
        if (op.launching || !op.pid || !op.start)
            return false;
        const current = await procStart(op.pid);
        if (current === op.start) {
            try {
                process.kill(-op.pid, 'SIGKILL');
            }
            catch {
                return false;
            }
            return false; // Recheck after the killed process has actually exited.
        }
        // A missing leader alone cannot prove that its process group has stopped.
        try {
            process.kill(-op.pid, 0);
            return false;
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ESRCH')
                return false;
        }
        await rm(file, { force: true });
        return true;
    }
    async invoke(jobId: string, profile: ExecutionProfile, prompt: string, signal: AbortSignal): Promise<ModelResult> {
        if (signal.aborted)
            throw new ExecutionFailure('CANCELLED', 'Execution stopped.');
        if (Buffer.byteLength(prompt, 'utf8') > 120000)
            throw new ExecutionFailure('CONTEXT_TOO_LARGE', 'Agent context exceeds the bounded input limit.');
        const controller = new AbortController();
        const stop = () => controller.abort();
        signal.addEventListener('abort', stop, { once: true });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; stop(); }, this.timeoutMs);
        try {
            if (profile.provider === 'ollama') {
                const available = await this.ollama.inventory(controller.signal);
                const model = profile.model ?? available.defaultModel;
                if (!model || !available.models.some(item => item.name === model))
                    throw new ExecutionFailure('MODEL_NOT_INSTALLED', 'The frozen Ollama model is not installed.');
                let text = '';
                await this.ollama.chat(model, [{ role: 'user', content: prompt }], controller.signal, async ({ delta }) => {
                    text += delta;
                    if (text.length > 65536)
                        throw failure();
                });
                if (controller.signal.aborted)
                    throw failure();
                return { text, provider: profile.provider, requestedModel: profile.model, resolvedModel: model };
            }
            if (process.platform !== 'linux')
                throw failure();
            const identity = parseIdentity(await readFile('/etc/passwd', 'utf8'), process.env.W3_FORGE_AI_USER?.trim() ?? 'forge-ai');
            const operations = path.join(this.root, '.provider-operations');
            await mkdir(operations, { recursive: true, mode: 0o700 });
            const cwd = await mkdtemp('/tmp/w3forge-model-');
            await chmod(cwd, 0o755);
            const invocation = planProviderInvocation(identity, profile.provider, 'test', cwd, process.getuid?.() ?? -1);
            invocation.args.pop();
            if (profile.model)
                invocation.args.push('--model', profile.model);
            if (profile.provider === 'codex')
                invocation.args.push('-');
            const file = this.file(jobId);
            const bootId = await readBootId();
            await persist(file, { launching: true, cwd, bootId, createdAt: new Date().toISOString() });
            const text = await new Promise<string>((resolve, reject) => {
                const child = spawn(invocation.file, invocation.args, { cwd, env: invocation.env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
                let output = '', bytes = 0, stopped = false;
                const kill = () => {
                    stopped = true;
                    try {
                        if (child.pid)
                            process.kill(-child.pid, 'SIGKILL');
                    }
                    catch { /* Already exited. */ }
                };
                controller.signal.addEventListener('abort', kill, { once: true });
                if (controller.signal.aborted)
                    kill();
                child.once('spawn', () => {
                    void (async () => {
                        const start = child.pid ? await procStart(child.pid) : null;
                        if (!start || !child.pid) {
                            kill();
                            return;
                        }
                        await persist(file, { launching: false, pid: child.pid, start, cwd, bootId, createdAt: new Date().toISOString() });
                        if (!controller.signal.aborted)
                            child.stdin.end(prompt);
                        else
                            kill();
                    })().catch(kill);
                });
                child.stdout.on('data', (buf: Buffer) => {
                    bytes += buf.length;
                    if (bytes > 262144)
                        kill();
                    else
                        output += buf.toString('utf8');
                });
                child.stderr.on('data', (buf: Buffer) => {
                    bytes += buf.length;
                    if (bytes > 262144)
                        kill();
                });
                child.stdin.on('error', () => kill());
                child.once('error', () => { controller.signal.removeEventListener('abort', kill); reject(failure()); });
                child.once('close', code => {
                    controller.signal.removeEventListener('abort', kill);
                    // Kill residual descendants before resolving or deleting the operation record.
                    try {
                        if (child.pid)
                            process.kill(-child.pid, 'SIGKILL');
                    }
                    catch { /* Group gone. */ }
                    if (stopped || code !== 0 || controller.signal.aborted)
                        reject(failure());
                    else {
                        try {
                            resolve(parseModelResult(profile.provider as 'codex' | 'claude', output));
                        }
                        catch (e) {
                            reject(e);
                        }
                    }
                });
            });
            if (!await this.recover(jobId))
                throw new ExecutionFailure('CLEANUP_REQUIRED', 'Provider cleanup must be verified before continuing.');
            await rm(cwd, { recursive: true, force: true });
            return { text, provider: profile.provider, requestedModel: profile.model, resolvedModel: null };
        }
        catch (e) {
            if (timedOut)
                throw new ExecutionFailure('PROVIDER_TIMEOUT', 'The assigned provider exceeded its execution deadline.');
            if (e instanceof ExecutionFailure)
                throw e;
            throw failure();
        }
        finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', stop);
            controller.abort();
        }
    }
}
