import { readBootId, bootRelation } from './identity';
import { promises as fs, constants as FS } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { ExecutionJob } from './types';
export interface ExecutionRepository {
    repositoryUrl: string;
    sourcePath: string;
    branch: string;
    testImage: string;
    npmCachePath: string;
    checks: Array<'typecheck' | 'test' | 'build'>;
}
export interface ExecutionConfig {
    workspaceRoot: string;
    repositories: ExecutionRepository[];
    providerTimeoutMs: number;
    testTimeoutMs: number;
}
interface Meta {
    jobId: string;
    repositoryUrl: string;
    branch: string;
    baseCommit: string;
    candidateCommit: string;
    createdAt: string;
}
interface Entry {
    path: string;
    mode: string;
    oid: string;
    size: number;
}
interface Result {
    code: number;
    stdout: Buffer;
    stderr: Buffer;
}
const SHA = /^[a-f0-9]{40}$/, BRANCH = /^dev\/v\d+\.\d+\.\d+$/, URL = /^https:\/\/github\.com\/[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/;
const MAX = 64 * 1024 * 1024;
function fail(code: string): never { throw Error('EXECUTION_' + code); }
const abort = (s?: AbortSignal) => {
    if (s?.aborted)
        fail('CANCELLED');
};
function absolute(v: unknown): string {
    if (typeof v !== 'string' || !path.isAbsolute(v) || /[\x00-\x1f\x7f,:\\]/.test(v) || path.resolve(v) !== v || v === '/')
        fail('CONFIG_PATH_INVALID');
    return v;
}
async function protectedPath(p: string, kind: 'file' | 'directory') {
    let current = '/';
    const parts = p.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
        current = path.join(current, parts[i]);
        const s = await fs.lstat(current);
        if (s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022))
            fail('CONFIG_PATH_UNPROTECTED');
        if (i < parts.length - 1 || kind === 'directory') {
            if (!s.isDirectory())
                fail('CONFIG_PATH_INVALID');
        }
        else if (!s.isFile())
            fail('CONFIG_PATH_INVALID');
    }
}
function inside(a: string, b: string) { const r = path.relative(a, b); return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)); }
function object(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function keys(v: Record<string, unknown>, allowed: string[]) {
    if (Object.keys(v).some(k => !allowed.includes(k)))
        fail('CONFIG_INVALID');
}
export async function loadExecutionConfig(configPath = '/etc/w3forge/execution.json'): Promise<ExecutionConfig> {
    try {
        if (process.platform !== 'linux' || process.getuid?.() !== 0)
            fail('HOST_UNSUPPORTED');
        await protectedPath(absolute(configPath), 'file');
        if ((await fs.stat(configPath)).size > 131072)
            fail('CONFIG_INVALID');
        const v: unknown = JSON.parse(await fs.readFile(configPath, 'utf8'));
        if (!object(v))
            fail('CONFIG_INVALID');
        keys(v, ['workspaceRoot', 'repositories', 'providerTimeoutMs', 'testTimeoutMs']);
        const workspaceRoot = absolute(v.workspaceRoot);
        await protectedPath(workspaceRoot, 'directory');
        if (!Array.isArray(v.repositories) || !v.repositories.length || v.repositories.length > 20)
            fail('CONFIG_INVALID');
        const repositories: ExecutionRepository[] = [];
        for (const r of v.repositories) {
            if (!object(r))
                fail('CONFIG_INVALID');
            keys(r, ['repositoryUrl', 'sourcePath', 'branch', 'testImage', 'npmCachePath', 'checks']);
            if (typeof r.repositoryUrl !== 'string' || !URL.test(r.repositoryUrl) || r.repositoryUrl.endsWith('.git') || typeof r.branch !== 'string' || !BRANCH.test(r.branch))
                fail('CONFIG_REPOSITORY_INVALID');
            const sourcePath = absolute(r.sourcePath), npmCachePath = absolute(r.npmCachePath);
            await protectedPath(sourcePath, 'directory');
            await protectedPath(npmCachePath, 'directory');
            if ([sourcePath, npmCachePath].some(p => inside(p, workspaceRoot) || inside(workspaceRoot, p)))
                fail('CONFIG_PATH_OVERLAP');
            if (typeof r.testImage !== 'string' || !/^node:(?:22|24)(?:\.\d+\.\d+)?-bookworm(?:@sha256:[a-f0-9]{64})?$/.test(r.testImage))
                fail('CONFIG_IMAGE_INVALID');
            if (!Array.isArray(r.checks) || !r.checks.length || r.checks.length > 3 || new Set(r.checks).size !== r.checks.length || r.checks.some(c => !['typecheck', 'test', 'build'].includes(c)))
                fail('CONFIG_CHECKS_INVALID');
            if (repositories.some(x => x.repositoryUrl === r.repositoryUrl && x.branch === r.branch))
                fail('CONFIG_DUPLICATE_REPOSITORY');
            repositories.push({ repositoryUrl: r.repositoryUrl, sourcePath, branch: r.branch, testImage: r.testImage, npmCachePath, checks: r.checks as ExecutionRepository['checks'] });
        }
        const providerTimeoutMs = Number(v.providerTimeoutMs ?? 600000), testTimeoutMs = Number(v.testTimeoutMs ?? 1200000);
        if (!Number.isInteger(providerTimeoutMs) || providerTimeoutMs < 1000 || providerTimeoutMs > 600000 || !Number.isInteger(testTimeoutMs) || testTimeoutMs < 1000 || testTimeoutMs > 1200000)
            fail('CONFIG_TIMEOUT_INVALID');
        await protectedPath('/usr/bin/git', 'file');
        await protectedPath('/usr/bin/docker', 'file');
        return { workspaceRoot, repositories, providerTimeoutMs, testTimeoutMs };
    }
    catch (e) {
        if (e instanceof Error && /^EXECUTION_[A-Z_]+$/.test(e.message))
            throw e;
        fail('CONFIG_UNAVAILABLE');
    }
}
function token(id: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$/.test(id))
        fail('JOB_ID_INVALID');
    return createHash('sha256').update(id).digest('hex').slice(0, 24);
}
export function executionFilePath(v: unknown): string {
    if (typeof v !== 'string' || !v || Buffer.byteLength(v) > 1024 || path.posix.isAbsolute(v) || /[\x00-\x1f\x7f\\]/.test(v) || path.posix.normalize(v) !== v || v.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git'))
        fail('FILE_PATH_INVALID');
    return v;
}
export function readableFile(v: string) { return !v.split('/').some(p => /^(?:\.ssh|\.aws|\.gnupg|\.npmrc|\.netrc|\.codex|\.claude|\.kube|\.azure|gcloud|id_rsa|id_ed25519|credentials\.json)$/i.test(p) || /^\.env(?:\.(?!(?:example|sample|template)$).*)?$/i.test(p) || /\.(?:pem|p12|pfx|key)$/i.test(p)); }
function writableFile(v: string) { return readableFile(v) && !v.split('/').some(p => /^\.git/i.test(p) || /^(?:AGENTS|CLAUDE|CODEX)\.md$/i.test(p)) && v !== 'admin-console.lock.json'; }
function safeLog(v: string) { return v.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/((?:authorization|api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)\S+/gi, '$1[redacted]').replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]').slice(-12000); }
async function exists(p: string) {
    try {
        await fs.lstat(p);
        return true;
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT')
            return false;
        throw e;
    }
}
async function writeJson(p: string, v: unknown) {
    const tmp = p + '.' + randomUUID() + '.tmp';
    try {
        const h = await fs.open(tmp, 'wx', 0o600);
        try {
            await h.writeFile(JSON.stringify(v));
            await h.sync();
        }
        finally {
            await h.close();
        }
        await fs.rename(tmp, p);
        const d = await fs.open(path.dirname(p), 'r');
        try {
            await d.sync();
        }
        finally {
            await d.close();
        }
    }
    finally {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
}
async function ticks(pid: number) {
    try {
        const s = await fs.readFile('/proc/' + pid + '/stat', 'utf8');
        return s.slice(s.lastIndexOf(')') + 2).split(' ')[19] ?? null;
    }
    catch {
        return null;
    }
}
function group(pid: number) {
    try {
        process.kill(-pid, 0);
        return true;
    }
    catch (e) {
        return (e as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}
async function stopGroup(pid: number) {
    try {
        process.kill(-pid, 'SIGKILL');
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH')
            return false;
    }
    for (let n = 0; n < 40; n++) {
        if (!group(pid))
            return true;
        await new Promise(r => setTimeout(r, 50));
    }
    return !group(pid);
}
export class WorkspaceRuntime {
    private active = new Set<string>();
    private initialization?: Promise<void>;
    constructor(private config: ExecutionConfig) { }
    private folder(id: string) { return path.join(this.config.workspaceRoot, 'job-' + token(id)); }
    private container(id: string) { return 'w3forge-test-' + token(id); }
    private async initialize() {
        if (!this.initialization)
            this.initialization = (async () => {
                if (process.platform !== 'linux' || process.getuid?.() !== 0)
                    fail('HOST_UNSUPPORTED');
                await protectedPath(this.config.workspaceRoot, 'directory');
                for (const n of ['.operations', '.empty-template']) {
                    const p = path.join(this.config.workspaceRoot, n);
                    await fs.mkdir(p, { mode: 0o700 }).catch(e => {
                        if (e.code !== 'EEXIST')
                            throw e;
                    });
                    await protectedPath(p, 'directory');
                }
                if ((await fs.readdir(path.join(this.config.workspaceRoot, '.empty-template'))).length)
                    fail('TEMPLATE_NOT_EMPTY');
            })();
        await this.initialization;
    }
    private async exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
        token(id);
        if (this.active.has(id))
            fail('WORKSPACE_BUSY');
        this.active.add(id);
        try {
            await this.initialize();
            return await fn();
        }
        catch (e) {
            if (e instanceof Error && /^EXECUTION_[A-Z_]+$/.test(e.message))
                throw e;
            fail('WORKSPACE_FAILURE');
        }
        finally {
            this.active.delete(id);
        }
    }
    private binding(j: ExecutionJob) {
        const r = this.config.repositories.find(r => r.repositoryUrl === j.context.request.repositoryUrl && r.branch === j.context.request.branch);
        if (!r || !BRANCH.test(r.branch) || !URL.test(r.repositoryUrl))
            fail('REPOSITORY_NOT_CONFIGURED');
        return r;
    }
    private async command(id: string, binary: '/usr/bin/git' | '/usr/bin/docker', args: string[], o: {
        cwd?: string;
        signal?: AbortSignal;
        timeoutMs?: number;
        maxBytes?: number;
        input?: Buffer;
    } = {}): Promise<Result> {
        abort(o.signal);
        const bootId = await readBootId();
        const record = path.join(this.config.workspaceRoot, '.operations', token(id) + '-' + randomUUID() + '.json');
        await writeJson(record, { jobId: id, pid: 0, startTicks: null, bootId, kind: path.basename(binary), createdAt: new Date().toISOString() });
        if (o.signal?.aborted) {
            await fs.rm(record, { force: true });
            fail('CANCELLED');
        }
        const c = spawn(binary, args, { cwd: o.cwd ?? this.config.workspaceRoot, shell: false, detached: true, windowsHide: true, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1', GCM_INTERACTIVE: 'Never' }, stdio: ['pipe', 'pipe', 'pipe'] });
        const out: Buffer[] = [], err: Buffer[] = [];
        let size = 0, problem = '', spawnError = false, registered = false;
        const pid = c.pid;
        const kill = (reason: string) => {
            problem ||= reason;
            if (pid)
                try {
                    process.kill(-pid, 'SIGKILL');
                }
                catch { }
        };
        const collect = (list: Buffer[], b: Buffer) => {
            size += b.length;
            if (size > (o.maxBytes ?? 1048576))
                kill('OUTPUT_LIMIT');
            else
                list.push(Buffer.from(b));
        };
        c.stdout.on('data', b => collect(out, b));
        c.stderr.on('data', b => collect(err, b));
        const closed = new Promise<number>(r => { c.once('error', () => { spawnError = true; r(-1); }); c.once('close', code => r(code ?? -1)); });
        c.stdin.on('error', () => undefined);
        c.stdin.end(o.input);
        const onAbort = () => kill('CANCELLED');
        o.signal?.addEventListener('abort', onAbort, { once: true });
        if (o.signal?.aborted)
            onAbort();
        const timer = setTimeout(() => kill('PROCESS_TIMEOUT'), o.timeoutMs ?? 120000);
        timer.unref();
        try {
            if (pid) {
                await writeJson(record, { jobId: id, pid, startTicks: await ticks(pid), bootId, kind: path.basename(binary), createdAt: new Date().toISOString() });
                registered = true;
            }
            const code = await closed;
            if (pid && group(pid) && !await stopGroup(pid))
                fail('PROCESS_CLEANUP_FAILED');
            if (problem)
                fail(problem);
            if (spawnError || !pid)
                fail('PROCESS_START_FAILED');
            return { code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) };
        }
        catch (e) {
            if (pid && !await stopGroup(pid)) {
                registered = false;
                fail('PROCESS_CLEANUP_FAILED');
            }
            throw e;
        }
        finally {
            clearTimeout(timer);
            o.signal?.removeEventListener('abort', onAbort);
            if (registered)
                await fs.rm(record, { force: true });
        }
    }
    private git(id: string, cwd: string, args: string[], o: {
        signal?: AbortSignal;
        maxBytes?: number;
        input?: Buffer;
    } = {}) { return this.command(id, '/usr/bin/git', ['--no-pager', '--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'commit.gpgSign=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', '-c', 'protocol.ext.allow=never', '-c', 'safe.directory=' + cwd, ...args], { ...o, cwd }); }
    private async gitOk(id: string, cwd: string, args: string[], o: {
        signal?: AbortSignal;
        maxBytes?: number;
        input?: Buffer;
    } = {}) {
        const r = await this.git(id, cwd, args, o);
        if (r.code !== 0)
            fail('GIT_FAILED');
        return r.stdout;
    }
    private docker(id: string, args: string[], o: {
        signal?: AbortSignal;
        timeoutMs?: number;
        maxBytes?: number;
    } = {}) { return this.command(id, '/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', ...args], o); }
    private async tree(id: string, repo: string, commit: string, signal?: AbortSignal) {
        if (!SHA.test(commit))
            fail('COMMIT_INVALID');
        const raw = await this.gitOk(id, repo, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit], { signal, maxBytes: 4194304 });
        if (!Buffer.from(raw.toString('utf8')).equals(raw))
            fail('UNSUPPORTED_TRACKED_FILENAME');
        const files: Entry[] = [];
        let total = 0;
        for (const item of raw.toString('utf8').split('\0').filter(Boolean)) {
            const m = /^([0-9]{6}) (blob|commit) ([a-f0-9]{40})\s+([0-9]+|-)\t([\s\S]+)$/.exec(item);
            if (!m || m[2] !== 'blob' || !['100644', '100755'].includes(m[1]))
                fail('UNSUPPORTED_TRACKED_FILE');
            const size = Number(m[4]);
            if (!Number.isSafeInteger(size) || size < 0)
                fail('REPOSITORY_TOO_LARGE');
            total += size;
            files.push({ path: executionFilePath(m[5]), mode: m[1], oid: m[3], size });
            if (files.length > 8000 || total > MAX)
                fail('REPOSITORY_TOO_LARGE');
        }
        return files;
    }
    private async blobs(id: string, repo: string, files: Entry[], signal?: AbortSignal) {
        const result = new Map<string, Buffer>();
        if (!files.length)
            return result;
        const raw = await this.gitOk(id, repo, ['cat-file', '--batch'], { signal, input: Buffer.from(files.map(f => f.oid + '\n').join('')), maxBytes: MAX + 8000 * 160 });
        let offset = 0;
        for (const f of files) {
            const end = raw.indexOf(10, offset);
            if (end < 0 || raw.subarray(offset, end).toString('ascii') !== f.oid + ' blob ' + f.size)
                fail('OBJECT_INVALID');
            offset = end + 1;
            const b = raw.subarray(offset, offset + f.size);
            if (b.length !== f.size || raw[offset + f.size] !== 10 || createHash('sha1').update('blob ' + f.size + '\0').update(b).digest('hex') !== f.oid)
                fail('OBJECT_INVALID');
            result.set(f.path, b);
            offset += f.size + 1;
        }
        if (offset !== raw.length)
            fail('OBJECT_INVALID');
        return result;
    }
    private async metadata(j: ExecutionJob) {
        const binding = this.binding(j), folder = this.folder(j.id);
        await protectedPath(folder, 'directory');
        await protectedPath(path.join(folder, 'workspace.json'), 'file');
        const meta: Meta = JSON.parse(await fs.readFile(path.join(folder, 'workspace.json'), 'utf8'));
        if (meta.jobId !== j.id || meta.repositoryUrl !== binding.repositoryUrl || meta.branch !== binding.branch || !SHA.test(meta.baseCommit) || !SHA.test(meta.candidateCommit) || (j.baseCommit && j.baseCommit !== meta.baseCommit) || (j.candidateCommit && j.candidateCommit !== meta.candidateCommit))
            fail('WORKSPACE_MISMATCH');
        const repo = path.join(folder, 'repo');
        await protectedPath(repo, 'directory');
        const head = (await this.gitOk(j.id, repo, ['rev-parse', '--verify', 'HEAD'])).toString('ascii').trim();
        if (head !== meta.candidateCommit)
            fail('WORKSPACE_HEAD_CHANGED');
        return { meta, repo, binding };
    }
    async prepare(j: ExecutionJob, signal?: AbortSignal) {
        return this.exclusive(j.id, async () => {
            abort(signal);
            const binding = this.binding(j), folder = this.folder(j.id);
            if (await exists(folder)) {
                const { meta, repo } = await this.metadata(j);
                if (meta.candidateCommit !== meta.baseCommit)
                    fail('WORKSPACE_ALREADY_MODIFIED');
                return { baseCommit: meta.baseCommit, files: (await this.tree(j.id, repo, meta.baseCommit, signal)).map(f => f.path).filter(readableFile) };
            }
            await protectedPath(binding.sourcePath, 'directory');
            const dotgit = path.join(binding.sourcePath, '.git');
            if (await exists(dotgit)) {
                const info = await fs.lstat(dotgit);
                await protectedPath(dotgit, info.isDirectory() ? 'directory' : 'file');
                if (info.isDirectory())
                    await protectedPath(path.join(dotgit, 'config'), 'file');
            }
            const common = (await this.gitOk(j.id, binding.sourcePath, ['rev-parse', '--git-common-dir'], { signal })).toString('utf8').trim();
            const commonPath = absolute(path.resolve(binding.sourcePath, common));
            await protectedPath(commonPath, 'directory');
            await protectedPath(path.join(commonPath, 'config'), 'file');
            let origin = (await this.gitOk(j.id, binding.sourcePath, ['remote', 'get-url', 'origin'], { signal })).toString('utf8').trim().toLowerCase().replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '').replace(/\/$/, '');
            if (origin !== binding.repositoryUrl)
                fail('SOURCE_REPOSITORY_MISMATCH');
            const baseCommit = (await this.gitOk(j.id, binding.sourcePath, ['rev-parse', '--verify', 'refs/heads/' + binding.branch + '^{commit}'], { signal })).toString('ascii').trim();
            if (!SHA.test(baseCommit) || (j.baseCommit && j.baseCommit !== baseCommit))
                fail('BASE_COMMIT_CHANGED');
            const files = await this.tree(j.id, binding.sourcePath, baseCommit, signal);
            await fs.mkdir(folder, { mode: 0o700 });
            const repo = path.join(folder, 'repo');
            await this.gitOk(j.id, this.config.workspaceRoot, ['clone', '--local', '--no-hardlinks', '--no-checkout', '--no-tags', '--single-branch', '--branch', binding.branch, '--template=' + path.join(this.config.workspaceRoot, '.empty-template'), '--', binding.sourcePath, repo], { signal });
            if (await exists(path.join(repo, '.git/objects/info/alternates')))
                fail('WORKSPACE_ALTERNATES_UNSUPPORTED');
            await this.gitOk(j.id, repo, ['checkout', '--force', '-B', binding.branch, baseCommit], { signal });
            await this.gitOk(j.id, repo, ['remote', 'set-url', 'origin', binding.repositoryUrl], { signal });
            const meta: Meta = { jobId: j.id, repositoryUrl: binding.repositoryUrl, branch: binding.branch, baseCommit, candidateCommit: baseCommit, createdAt: new Date().toISOString() };
            await writeJson(path.join(folder, 'workspace.json'), meta);
            return { baseCommit, files: files.map(f => f.path).filter(readableFile) };
        });
    }
    async read(j: ExecutionJob, paths: string[]) {
        return this.exclusive(j.id, async () => {
            if (!Array.isArray(paths) || paths.length > 30 || new Set(paths).size !== paths.length)
                fail('READ_REQUEST_INVALID');
            const { meta, repo } = await this.metadata(j);
            if (!paths.length)
                return [];
            const tree = await this.tree(j.id, repo, meta.candidateCommit);
            const wanted = paths.map(p => {
                executionFilePath(p);
                if (!readableFile(p))
                    fail('FILE_RESTRICTED');
                const f = tree.find(f => f.path === p);
                if (!f)
                    fail('FILE_NOT_FOUND');
                if (f.size > 131072)
                    fail('FILE_TOO_LARGE');
                return f;
            });
            if (wanted.reduce((s, f) => s + f.size, 0) > 262144)
                fail('READ_TOO_LARGE');
            const blobs = await this.blobs(j.id, repo, wanted);
            return wanted.map(f => {
                const bytes = blobs.get(f.path)!, content = bytes.toString('utf8');
                if (bytes.includes(0) || !Buffer.from(content).equals(bytes))
                    fail('BINARY_FILE_UNSUPPORTED');
                return { path: f.path, content };
            });
        });
    }
    private async parent(root: string, filename: string) {
        let p = root;
        for (const segment of executionFilePath(filename).split('/').slice(0, -1)) {
            p = path.join(p, segment);
            if (!await exists(p))
                await fs.mkdir(p, { mode: 0o755 });
            const s = await fs.lstat(p);
            if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022))
                fail('FILE_PARENT_UNSAFE');
        }
    }
    async apply(j: ExecutionJob, changes: Array<{
        path: string;
        content: string | null;
    }>, round: number, signal?: AbortSignal) {
        return this.exclusive(j.id, async () => {
            abort(signal);
            if (!j.baseCommit || !SHA.test(j.baseCommit) || !Number.isInteger(round) || round < 1 || round > 3 || !Array.isArray(changes) || !changes.length || changes.length > 24)
                fail('CHANGE_REQUEST_INVALID');
            const { meta, repo } = await this.metadata(j), tree = await this.tree(j.id, repo, meta.candidateCommit, signal);
            const names = new Set<string>();
            let bytes = 0;
            for (const c of changes) {
                const p = executionFilePath(c.path);
                if (!writableFile(p) || names.has(p) || (c.content !== null && (typeof c.content !== 'string' || c.content.includes('\0'))))
                    fail('CHANGE_REQUEST_INVALID');
                names.add(p);
                bytes += Buffer.byteLength(c.content ?? '');
                if (bytes > 64000)
                    fail('CHANGES_TOO_LARGE');
                if (c.content === null && !tree.some(f => f.path === p))
                    fail('DELETE_TARGET_NOT_FOUND');
            }
            if ((await this.gitOk(j.id, repo, ['status', '--porcelain', '--untracked-files=all'], { signal })).length)
                fail('WORKSPACE_DIRTY');
            for (const c of changes) {
                abort(signal);
                await this.parent(repo, c.path);
                const p = path.join(repo, c.path);
                if (await exists(p)) {
                    const s = await fs.lstat(p);
                    if (!s.isFile() || s.isSymbolicLink() || s.uid !== 0 || s.nlink !== 1)
                        fail('FILE_TARGET_UNSAFE');
                }
                if (c.content === null) {
                    await fs.unlink(p);
                    continue;
                }
                const tmp = path.join(path.dirname(p), '.w3forge-' + randomUUID() + '.tmp'), mode = tree.find(f => f.path === c.path)?.mode === '100755' ? 0o755 : 0o644;
                const h = await fs.open(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, mode);
                try {
                    await h.writeFile(c.content, 'utf8');
                }
                finally {
                    await h.close();
                }
                await fs.rename(tmp, p);
            }
            await this.gitOk(j.id, repo, ['add', '--force', '--', ...names], { signal });
            for (const c of changes) {
                if (c.content !== null) {
                    const staged = await this.gitOk(j.id, repo, ['show', ':' + c.path], { signal, maxBytes: 262144 });
                    if (!staged.equals(Buffer.from(c.content, 'utf8')))
                        fail('STAGED_CONTENT_CHANGED');
                }
            }
            const changed = await this.git(j.id, repo, ['diff', '--cached', '--quiet', '--no-ext-diff', '--no-textconv'], { signal });
            if (changed.code === 0)
                fail('NO_CHANGES');
            if (changed.code !== 1)
                fail('GIT_FAILED');
            if ((await this.gitOk(j.id, repo, ['diff', '--no-ext-diff', '--no-textconv', '--binary', meta.baseCommit], { signal, maxBytes: 2097152 })).length > 18000)
                fail('DIFF_TOO_LARGE');
            await this.gitOk(j.id, repo, ['-c', 'user.name=W3 Forge', '-c', 'user.email=forge@localhost', 'commit', '--no-gpg-sign', '--no-verify', '-m', 'Factory ' + token(j.id) + ' round ' + round], { signal });
            const commit = (await this.gitOk(j.id, repo, ['rev-parse', '--verify', 'HEAD'], { signal })).toString('ascii').trim();
            if (!SHA.test(commit))
                fail('COMMIT_INVALID');
            await writeJson(path.join(this.folder(j.id), 'workspace.json'), { ...meta, candidateCommit: commit });
            const diff = (await this.gitOk(j.id, repo, ['diff', '--no-ext-diff', '--no-textconv', '--binary', meta.baseCommit + '..' + commit], { signal, maxBytes: 2097152 })).toString('utf8');
            if (Buffer.byteLength(diff) > 18000)
                fail('DIFF_TOO_LARGE');
            const paths = (await this.gitOk(j.id, repo, ['diff', '--name-only', '-z', meta.baseCommit + '..' + commit], { signal })).toString('utf8').split('\0');
            const visual = paths.some(p => /(?:^|\/)(?:frontend|client|web|ui|public|pages|components|styles)(?:\/|$)|\.(?:tsx|jsx|vue|svelte|html|css|scss|sass|less|svg)$/i.test(p));
            return { commit, diff, visual };
        });
    }
    private async stopContainer(id: string) {
        try {
            const name = this.container(id);
            const rows = await this.docker(id, ['ps', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}} {{.Names}}'], { timeoutMs: 10000, maxBytes: 8192 });
            if (rows.code !== 0)
                return false;
            const items = rows.stdout.toString('utf8').trim().split('\n').filter(Boolean);
            if (!items.length)
                return true;
            if (items.length !== 1 || !new RegExp('^[a-f0-9]{12,64} ' + name + '$').test(items[0]))
                return false;
            const label = await this.docker(id, ['inspect', '--format', '{{index .Config.Labels "org.w3forge.job"}}', name], { timeoutMs: 10000, maxBytes: 8192 });
            if (label.code !== 0 || label.stdout.toString('ascii').trim() !== token(id))
                return false;
            const rm = await this.docker(id, ['rm', '--force', name], { timeoutMs: 10000, maxBytes: 8192 });
            if (rm.code !== 0)
                return false;
            const check = await this.docker(id, ['ps', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}'], { timeoutMs: 10000, maxBytes: 8192 });
            return check.code === 0 && !check.stdout.toString('utf8').trim();
        }
        catch {
            return false;
        }
    }
    async test(j: ExecutionJob, commit: string, signal?: AbortSignal) {
        return this.exclusive(j.id, async () => {
            abort(signal);
            const { meta, repo, binding } = await this.metadata(j);
            if (!SHA.test(commit) || commit !== meta.candidateCommit || !j.baseCommit)
                fail('TEST_COMMIT_MISMATCH');
            if (!await this.stopContainer(j.id))
                fail('CONTAINER_CLEANUP_FAILED');
            await protectedPath(binding.npmCachePath, 'directory');
            const files = await this.tree(j.id, repo, commit, signal);
            if (files.some(f => !readableFile(f.path)))
                fail('CREDENTIAL_FILE_IN_SNAPSHOT');
            if (!['package.json', 'package-lock.json'].every(p => files.some(f => f.path === p)))
                fail('NPM_LOCKFILE_REQUIRED');
            const data = await this.blobs(j.id, repo, files, signal), folder = this.folder(j.id), snapshotName = 'snapshot-' + randomUUID(), snapshot = path.join(folder, snapshotName);
            await fs.mkdir(snapshot, { mode: 0o755 });
            await writeJson(path.join(folder, 'test.json'), { jobId: j.id, commit, container: this.container(j.id), snapshot: snapshotName });
            try {
                for (const f of files) {
                    abort(signal);
                    await this.parent(snapshot, f.path);
                    await fs.writeFile(path.join(snapshot, f.path), data.get(f.path)!, { flag: 'wx', mode: f.mode === '100755' ? 0o755 : 0o644 });
                }
                const script = ['umask 022', 'mkdir -p /tmp/home', 'cp -R --no-preserve=mode,ownership /source/. /work/', 'cp -R --no-preserve=mode,ownership /cache-source/. /cache/', 'cd /work', 'if ! npm ci --offline --cache /cache --no-audit --no-fund; then exit 42; fi', ...binding.checks.map(c => 'npm run ' + c)].join('\n');
                const created = await this.docker(j.id, ['create', '--pull=never', '--name', this.container(j.id), '--label', 'org.w3forge.job=' + token(j.id), '--label', 'w3forge.managed-by=codex', '--label', 'w3forge.environment=test', '--label', 'w3forge.app=w3forge', '--label', 'w3forge.branch=' + binding.branch, '--label', 'w3forge.run=' + token(j.id), '--label', 'w3forge.commit=' + commit, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '2g', '--cpus', '2', '--user', '1000:1000', '--read-only', '--ipc', 'none', '--restart', 'no', '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777', '--tmpfs', '/work:rw,nosuid,nodev,size=1024m,uid=1000,gid=1000,mode=0700', '--tmpfs', '/cache:rw,nosuid,nodev,size=512m,uid=1000,gid=1000,mode=0700', '--mount', 'type=bind,src=' + snapshot + ',dst=/source,readonly', '--mount', 'type=bind,src=' + binding.npmCachePath + ',dst=/cache-source,readonly', '--env', 'HOME=/tmp/home', '--env', 'CI=true', '--env', 'NPM_CONFIG_OFFLINE=true', '--env', 'NPM_CONFIG_USERCONFIG=/dev/null', '--env', 'NPM_CONFIG_CACHE=/cache', '--workdir', '/work', '--entrypoint', '/bin/sh', binding.testImage, '-eu', '-c', script], { signal, timeoutMs: 30000, maxBytes: 16384 });
                if (created.code !== 0)
                    fail('TEST_RUNNER_UNAVAILABLE');
                const run = await this.docker(j.id, ['start', '--attach', this.container(j.id)], { signal, timeoutMs: this.config.testTimeoutMs, maxBytes: 4194304 });
                return { commit, passed: run.code === 0, exitCode: run.code, summary: (run.code === 42 ? 'Offline dependency installation failed.\n' : 'Configured checks: ' + binding.checks.join(', ') + '; exit ' + run.code + '\n') + safeLog(Buffer.concat([run.stdout, run.stderr]).toString('utf8')) };
            }
            finally {
                if (!await this.stopContainer(j.id))
                    fail('CONTAINER_CLEANUP_FAILED');
                await fs.rm(path.join(folder, 'test.json'), { force: true });
                await fs.rm(snapshot, { recursive: true, force: true });
            }
        });
    }
    async recover(id: string) {
        if (this.active.has(id))
            return false;
        try {
            return await this.exclusive(id, async () => {
                const dir = path.join(this.config.workspaceRoot, '.operations');
                for (const name of await fs.readdir(dir)) {
                    if (!name.startsWith(token(id) + '-') || !name.endsWith('.json'))
                        continue;
                    const p = path.join(dir, name);
                    await protectedPath(p, 'file');
                    const op = JSON.parse(await fs.readFile(p, 'utf8'));
                    if (op.jobId !== id)
                        return false;
                    const relation = bootRelation(op.bootId, await readBootId());
                    if (relation === 'unknown')
                        return false;
                    if (relation === 'previous') {
                        await fs.rm(p, { force: true });
                        continue;
                    }
                    if (op.jobId !== id || !Number.isInteger(op.pid) || op.pid <= 1)
                        return false;
                    const current = await ticks(op.pid);
                    if (current !== null) {
                        if (!op.startTicks || current !== op.startTicks || !await stopGroup(op.pid))
                            return false;
                    }
                    else if (group(op.pid))
                        return false;
                    await fs.rm(p, { force: true });
                }
                if (!await this.stopContainer(id))
                    return false;
                const folder = this.folder(id);
                if (!await exists(folder))
                    return true;
                await protectedPath(folder, 'directory');
                const p = path.join(folder, 'workspace.json');
                if (!await exists(p))
                    return false;
                await protectedPath(p, 'file');
                const m: Meta = JSON.parse(await fs.readFile(p, 'utf8'));
                if (m.jobId !== id || !SHA.test(m.baseCommit) || !SHA.test(m.candidateCommit) || !this.config.repositories.some(r => r.repositoryUrl === m.repositoryUrl && r.branch === m.branch))
                    return false;
                const head = (await this.gitOk(id, path.join(folder, 'repo'), ['rev-parse', '--verify', 'HEAD'])).toString('ascii').trim();
                if (head !== m.candidateCommit)
                    return false;
                await fs.rm(path.join(folder, 'test.json'), { force: true });
                return true;
            });
        }
        catch {
            return false;
        }
    }
    async dispose(id: string) {
        await this.exclusive(id, async () => {
            if (!await this.stopContainer(id))
                fail('CONTAINER_CLEANUP_FAILED');
            const folder = this.folder(id);
            if (!await exists(folder))
                return;
            await protectedPath(folder, 'directory');
            for (const n of await fs.readdir(folder)) {
                if (!/^snapshot-[a-f0-9-]{36}$/.test(n))
                    continue;
                const p = path.join(folder, n);
                await protectedPath(p, 'directory');
                await fs.rm(p, { recursive: true, force: true });
            }
            await fs.rm(path.join(folder, 'test.json'), { force: true });
        });
    }
}
