import { createHash, randomUUID } from 'node:crypto';
import type { Database, Queryable } from '../db/database';
import { audit, type AuditActor } from '../db/audit';
import { AdminError } from '../admin/envelope';
import { EXECUTION_AGENT_SLUGS, EXECUTION_REVIEW_ROLES, type ExecutionContext, type ExecutionJob, type ExecutionEvent, type ExecutionPatch, type ExecutionStatus } from './types';
type Row = Record<string, any>;
const running = ['planning', 'developing', 'testing', 'reviewing'];
const select = 'SELECT j.*,c.content context,c.checksum context_checksum,s.heartbeat_at FROM public.factory_execution_jobs j JOIN public.factory_execution_contexts c ON c.job_id=j.id LEFT JOIN public.factory_execution_slot s ON s.job_id=j.id';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function canonical(v: any): string { return v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'; }
const fail = (code: string, message: string): never => { throw new AdminError(409, code, message); };
const stamp = (v: any) => new Date(v).toISOString();
function dto(r: Row): ExecutionJob {
    if (hash(canonical(r.context)) !== r.context_checksum)
        fail('EXECUTION_CONTEXT_INVALID', 'The pinned context could not be verified.');
    return { id: r.id, requestId: r.request_id, projectId: r.project_id, parentJobId: r.parent_job_id, status: r.status, revision: r.revision, round: r.round, nextStage: r.next_stage, baseCommit: r.base_commit, candidateCommit: r.candidate_commit, specification: r.specification, summary: r.summary, errorCode: r.error_code, cancelRequested: r.cancel_requested, reconciliationRequired: r.reconciliation_required, heartbeatAt: r.heartbeat_at ? stamp(r.heartbeat_at) : null, contextChecksum: r.context_checksum, context: r.context, createdAt: stamp(r.created_at), updatedAt: stamp(r.updated_at) };
}
async function load(q: Queryable, id: string) {
    const r = (await q.query<Row>(select + ' WHERE j.id=$1', [id])).rows[0];
    if (!r)
        throw new AdminError(404, 'EXECUTION_NOT_FOUND', 'Execution not found.');
    return dto(r);
}
async function slot(q: Queryable) {
    const s = (await q.query<Row>('SELECT * FROM public.factory_execution_slot WHERE singleton=true FOR UPDATE')).rows[0];
    if (!s)
        throw new AdminError(503, 'EXECUTION_NOT_INITIALIZED', 'Apply the execution migration.');
    return s;
}
async function locked(q: Queryable, id: string) { await q.query('SELECT id FROM public.factory_execution_jobs WHERE id=$1 FOR UPDATE', [id]); return load(q, id); }
function rev(j: ExecutionJob, n: number) {
    if (!Number.isInteger(n) || n !== j.revision)
        fail('EXECUTION_REVISION_CONFLICT', 'This run changed. Refresh before trying again.');
}
function owned(s: Row, j: ExecutionJob, t: string, allowCancel = false) {
    if (s.job_id !== j.id || s.owner_token !== t || !running.includes(j.status))
        fail('EXECUTION_LEASE_LOST', 'The worker no longer owns this run.');
    if (!allowCancel && j.cancelRequested)
        fail('EXECUTION_CANCELLING', 'Execution cancellation is pending.');
}
async function append(q: Queryable, id: string, kind: string, data: Record<string, unknown>) {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(kind) || Buffer.byteLength(JSON.stringify(data)) > 24000)
        throw new AdminError(400, 'INVALID_EXECUTION_EVENT', 'Evidence exceeds its limit.');
    const r = (await q.query<Row>('INSERT INTO public.factory_execution_events(id,job_id,kind,data) VALUES($1,$2,$3,$4::jsonb) RETURNING *', [randomUUID(), id, kind, JSON.stringify(data)])).rows[0];
    return { id: r.id, jobId: r.job_id, sequence: String(r.sequence), kind: r.kind, data: r.data, createdAt: stamp(r.created_at) };
}
async function release(q: Queryable) { await q.query('UPDATE public.factory_execution_slot SET job_id=NULL,owner_token=NULL,heartbeat_at=NULL WHERE singleton=true'); }
async function changed(q: Queryable, id: string) {
    const j = await load(q, id);
    const map: Record<ExecutionStatus, string> = { queued: j.nextStage === 'developing' ? 'development' : 'planning', planning: 'planning', awaiting_approval: 'awaiting_approval', developing: 'development', testing: 'testing', reviewing: 'review', ready: 'update_ready', blocked: 'blocked', cancelled: 'cancelled' };
    await q.query('UPDATE public.factory_requests SET blocked_from=CASE WHEN $2=\'blocked\' THEN CASE WHEN status=\'blocked\' THEN blocked_from ELSE status END ELSE NULL END,block_reason=CASE WHEN $2=\'blocked\' THEN $3 ELSE NULL END,status=$2,revision=revision+1,updated_at=now(),development_commit=COALESCE($4,development_commit) WHERE id=$1', [j.requestId, map[j.status], j.summary, j.candidateCommit]);
    if (['awaiting_approval', 'ready', 'blocked'].includes(j.status))
        await q.query("INSERT INTO public.factory_notifications(id,request_id,recipient_id,title,message,dedupe_key) SELECT $1,id,created_by,$2,title||': '||$3,$4 FROM public.factory_requests WHERE id=$5 ON CONFLICT(dedupe_key) DO NOTHING", [randomUUID(), j.status === 'ready' ? 'Development work ready for owner review' : j.status === 'awaiting_approval' ? 'Specification approval required' : 'Factory execution blocked', j.summary, 'execution:' + j.id + ':' + j.status, j.requestId]);
    return j;
}
export class ExecutionStore {
    constructor(private db: Database) { }
    async pendingRecovery() { const r = (await this.db.query<Row>(select + " WHERE j.reconciliation_required=true AND s.job_id=j.id LIMIT 1")).rows[0]; return r ? dto(r) : null; }
    get(id: string) { return load(this.db, id); }
    async list(requestId: string) { return (await this.db.query<Row>(select + ' WHERE j.request_id=$1 ORDER BY j.created_at DESC,j.id DESC LIMIT 100', [requestId])).rows.map(dto); }
    async events(id: string): Promise<ExecutionEvent[]> { await this.get(id); return (await this.db.query<Row>('SELECT * FROM public.factory_execution_events WHERE job_id=$1 ORDER BY sequence LIMIT 2000', [id])).rows.map(r => ({ id: r.id, jobId: r.job_id, sequence: String(r.sequence), kind: r.kind, data: r.data, createdAt: stamp(r.created_at) })); }
    async hasActiveRequest(id: string) { return (await this.db.query('SELECT j.id FROM public.factory_execution_slot s JOIN public.factory_execution_jobs j ON j.id=s.job_id WHERE j.request_id=$1', [id])).rows.length > 0; }
    async start(actor: AuditActor, requestId: string, expected: number) {
        return this.db.transaction(async (q) => {
            const s = await slot(q);
            if (s.job_id)
                fail('EXECUTION_SLOT_BUSY', 'Another run reserves the worker slot.');
            const r = (await q.query<Row>('SELECT r.*,p.name project_name FROM public.factory_requests r JOIN public.factory_projects p ON p.id=r.project_id WHERE r.id=$1', [requestId])).rows[0];
            if (!r)
                throw new AdminError(404, 'FACTORY_REQUEST_NOT_FOUND', 'Request not found.');
            await q.query('SELECT id FROM public.factory_projects WHERE id=$1 FOR UPDATE', [r.project_id]);
            const fresh = (await q.query<Row>('SELECT * FROM public.factory_requests WHERE id=$1 FOR UPDATE', [requestId])).rows[0];
            if (!Number.isInteger(expected) || fresh.revision !== expected)
                fail('EXECUTION_REVISION_CONFLICT', 'This request changed. Refresh before starting.');
            if (fresh.status !== 'queued')
                fail('EXECUTION_REQUEST_STATE', 'Start from a queued request.');
            const head = (await q.query<Row>("SELECT id FROM public.factory_requests WHERE project_id=$1 AND status NOT IN ('cancelled','update_ready') ORDER BY sequence LIMIT 1", [r.project_id])).rows[0];
            if (head?.id !== requestId)
                fail('FACTORY_FIFO_REQUIRED', 'Finish the earlier request first.');
            if (!/^dev\/v\d+\.\d+\.\d+$/.test(r.branch) || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.repository_url))
                fail('EXECUTION_BRANCH_NOT_ALLOWED', 'Use a GitHub repository and approved dev/vX.Y.Z branch.');
            const rules = (await q.query<Row>('SELECT * FROM public.factory_rules WHERE project_id=$1 AND version=$2', [r.project_id, r.rules_version])).rows[0];
            if (!rules || rules.checksum !== r.rules_checksum || hash(rules.content) !== rules.checksum)
                fail('EXECUTION_RULES_INVALID', 'Pinned project rules could not be verified.');
            const rows = (await q.query<Row>('SELECT a.*,p.name,p.purpose,p.version,p.content,p.checksum,m.provider,m.model FROM public.factory_agents a JOIN public.factory_agent_profiles p ON p.agent_id=a.id AND p.revision=a.profile_revision JOIN public.factory_agent_assignments m ON m.agent_id=a.id AND m.revision=a.assignment_revision WHERE a.slug=ANY($1::text[]) AND a.deleted_at IS NULL ORDER BY a.slug FOR SHARE OF a', [[...EXECUTION_AGENT_SLUGS]])).rows;
            if (rows.length !== 7 || rows.some(x => !x.enabled || !x.provider || hash(x.content) !== x.checksum))
                fail('EXECUTION_PROFILES_INVALID', 'Enable and assign all seven verifiable agent profiles.');
            const context: ExecutionContext = { request: { id: r.id, title: r.title, description: r.description, acceptanceCriteria: r.acceptance_criteria, repositoryUrl: r.repository_url, branch: r.branch, revision: r.revision, rulesVersion: r.rules_version, rulesChecksum: r.rules_checksum, projectName: r.project_name }, rules: { version: rules.version, title: rules.title, checksum: rules.checksum, markdown: rules.content }, profiles: EXECUTION_AGENT_SLUGS.map(slug => { const p = rows.find(x => x.slug === slug)!; return { id: p.id, slug, name: p.name, purpose: p.purpose, profileVersion: p.version, profileMarkdown: p.content, profileChecksum: p.checksum, provider: p.provider, model: p.model, revision: p.profile_revision, assignmentRevision: p.assignment_revision, enabled: true }; }), actor };
            const encoded = canonical(context);
            if (Buffer.byteLength(encoded) > 120000)
                fail('EXECUTION_CONTEXT_TOO_LARGE', 'Shorten project rules or profiles before starting.');
            const id = randomUUID();
            await q.query('INSERT INTO public.factory_execution_jobs(id,request_id,project_id,summary) VALUES($1,$2,$3,$4)', [id, requestId, r.project_id, 'Queued for specification planning.']);
            await q.query('INSERT INTO public.factory_execution_contexts(job_id,content,checksum) VALUES($1,$2::jsonb,$3)', [id, encoded, hash(encoded)]);
            await q.query('UPDATE public.factory_execution_slot SET job_id=$1 WHERE singleton=true', [id]);
            await append(q, id, 'created', { contextChecksum: hash(encoded), requestRevision: expected });
            await audit(q, actor, 'execution.start', 'factory_execution', id, r.project_id, null, { requestId });
            return changed(q, id);
        });
    }
    async claim(token: string) {
        if (token.length < 32 || token.length > 128)
            throw Error('Invalid worker token');
        return this.db.transaction(async (q) => {
            const s = await slot(q);
            if (!s.job_id)
                return null;
            const j = await locked(q, s.job_id);
            if (j.status !== 'queued' || j.cancelRequested || s.owner_token || j.reconciliationRequired)
                return null;
            await q.query('UPDATE public.factory_execution_jobs SET status=next_stage,round=CASE WHEN next_stage=\'developing\' AND round=0 THEN 1 ELSE round END,revision=revision+1,updated_at=now() WHERE id=$1', [j.id]);
            await q.query('UPDATE public.factory_execution_slot SET owner_token=$1,heartbeat_at=now() WHERE singleton=true', [token]);
            await append(q, j.id, 'claimed', { stage: j.nextStage });
            return changed(q, j.id);
        });
    }
    async heartbeat(id: string, token: string) { return this.db.transaction(async (q) => { const s = await slot(q), j = await locked(q, id); owned(s, j, token, true); await q.query('UPDATE public.factory_execution_slot SET heartbeat_at=now() WHERE singleton=true'); return load(q, id); }); }
    async event(id: string, kind: string, data: Record<string, unknown>, token: string) {
        return this.db.transaction(async (q) => {
            const s = await slot(q), j = await locked(q, id);
            owned(s, j, token);
            if ((kind === 'tests' && j.status !== 'testing') || (kind === 'review' && j.status !== 'reviewing'))
                fail('EXECUTION_EVENT_STATE', 'Evidence does not belong to this stage.');
            return append(q, id, kind, data);
        });
    }
    async transition(id: string, expected: number, status: ExecutionStatus, summary: string, patch: ExecutionPatch = {}, token?: string) {
        return this.db.transaction(async (q) => {
            const s = await slot(q), j = await locked(q, id);
            rev(j, expected);
            owned(s, j, token ?? '', status === 'cancelled' || status === 'blocked');
            const next: Partial<Record<ExecutionStatus, ExecutionStatus[]>> = { planning: ['awaiting_approval', 'blocked', 'cancelled'], developing: ['testing', 'blocked', 'cancelled'], testing: ['reviewing', 'developing', 'blocked', 'cancelled'], reviewing: ['ready', 'developing', 'blocked', 'cancelled'] };
            if (!next[j.status]?.includes(status))
                fail('EXECUTION_INVALID_TRANSITION', 'Invalid worker transition.');
            if (j.cancelRequested && status !== 'cancelled' && status !== 'blocked')
                fail('EXECUTION_CANCELLING', 'Cancellation must finish before progress.');
            const allowed = ['baseCommit', 'candidateCommit', 'specification', 'errorCode', 'round', 'nextStage'];
            if (Object.keys(patch).some(k => !allowed.includes(k)) || summary.length > 2000)
                throw Error('Invalid execution patch');
            for (const c of [patch.baseCommit, patch.candidateCommit])
                if (c !== undefined && !/^[a-f0-9]{40}$/.test(c))
                    throw Error('Invalid commit');
            if (patch.specification !== undefined && (patch.specification.length > 24000 || j.specification))
                fail('EXECUTION_SPEC_IMMUTABLE', 'The approved specification cannot be replaced.');
            if (patch.baseCommit !== undefined && j.baseCommit && patch.baseCommit !== j.baseCommit)
                fail('EXECUTION_BASE_IMMUTABLE', 'The source commit is frozen.');
            if (patch.round !== undefined && (status !== 'developing' || patch.round !== j.round + 1 || patch.round > 3))
                fail('EXECUTION_RETRY_LIMIT', 'Only two correction attempts are permitted.');
            if (patch.candidateCommit !== undefined && !(j.status === 'developing' && status === 'testing'))
                fail('EXECUTION_CANDIDATE_STATE', 'Candidates are recorded when development enters testing.');
            const correction = status === 'developing' && ['testing', 'reviewing'].includes(j.status);
            if (correction) {
                const round = j.round + 1;
                if (round > 3 || (patch.round !== undefined && patch.round !== round))
                    fail('EXECUTION_RETRY_LIMIT', 'Only two correction attempts are permitted.');
                patch = { ...patch, round };
            }
            const candidate = patch.candidateCommit ?? j.candidateCommit;
            if (status === 'testing' && !candidate)
                fail('EXECUTION_COMMIT_REQUIRED', 'A candidate commit is required.');
            if (status === 'reviewing') {
                const tests = (await q.query<Row>("SELECT data FROM public.factory_execution_events WHERE job_id=$1 AND kind='tests' ORDER BY sequence DESC", [id])).rows.find(e => e.data.commit === candidate);
                if (!tests || tests.data.passed !== true || tests.data.exitCode !== 0)
                    fail('EXECUTION_TEST_GATE', 'Passing tests for this candidate are required.');
            }
            if (status === 'awaiting_approval' && (!(patch.specification ?? j.specification).trim() || !(patch.baseCommit ?? j.baseCommit)))
                fail('EXECUTION_SPEC_REQUIRED', 'A pinned source and specification are required.');
            if (status === 'ready') {
                const events = (await q.query<Row>('SELECT kind,data FROM public.factory_execution_events WHERE job_id=$1 ORDER BY sequence', [id])).rows;
                if (!candidate || (() => { const t = events.filter(e => e.kind === 'tests' && e.data.commit === candidate).at(-1); return !t || t.data.passed !== true || t.data.exitCode !== 0; })())
                    fail('EXECUTION_TEST_GATE', 'Passing checks for the exact candidate are required.');
                for (const role of EXECUTION_REVIEW_ROLES) {
                    const e = events.filter(e => e.kind === 'review' && e.data.commit === candidate && e.data.role === role).at(-1);
                    if (!e || !(['ui-reviewer', 'ux-reviewer'].includes(role) ? e.data.verdict === 'NOT_APPLICABLE' && typeof e.data.reason === 'string' && e.data.reason.trim() : e.data.verdict === 'PASS'))
                        fail('EXECUTION_REVIEW_GATE', 'Every required review must cover the exact candidate.');
                }
            }
            await q.query('UPDATE public.factory_execution_jobs SET status=$2,summary=$3,base_commit=COALESCE($4,base_commit),candidate_commit=COALESCE($5,candidate_commit),specification=COALESCE($6,specification),error_code=$7,round=COALESCE($8,round),next_stage=COALESCE($9,next_stage),revision=revision+1,updated_at=now() WHERE id=$1', [id, status, summary, patch.baseCommit ?? null, patch.candidateCommit ?? null, patch.specification ?? null, patch.errorCode ?? null, patch.round ?? null, status === 'awaiting_approval' ? 'developing' : patch.nextStage ?? null]);
            await append(q, id, 'stage', { status, summary, round: patch.round ?? j.round, candidateCommit: candidate });
            await audit(q, null, 'execution.transition', 'factory_execution', id, j.projectId, summary, { from: j.status, to: status, round: patch.round ?? j.round, candidateCommit: candidate });
            if (['ready', 'cancelled'].includes(status))
                await release(q);
            else if (['awaiting_approval', 'blocked'].includes(status))
                await q.query('UPDATE public.factory_execution_slot SET owner_token=NULL,heartbeat_at=NULL WHERE singleton=true');
            return changed(q, id);
        });
    }
    async approve(actor: AuditActor, id: string, expected: number) {
        return this.db.transaction(async (q) => {
            const s = await slot(q), j = await locked(q, id);
            rev(j, expected);
            if (s.job_id !== id || j.status !== 'awaiting_approval' || j.cancelRequested || !j.specification.trim() || !j.baseCommit)
                fail('EXECUTION_APPROVAL_STATE', 'Review the current specification before approving.');
            await q.query('UPDATE public.factory_execution_jobs SET status=\'queued\',next_stage=\'developing\',summary=\'Specification approved; queued for development.\',revision=revision+1,updated_at=now() WHERE id=$1', [id]);
            await append(q, id, 'approved', { actor: actor.coreUserId, specificationChecksum: hash(j.specification), baseCommit: j.baseCommit });
            await audit(q, actor, 'execution.approve', 'factory_execution', id, j.projectId, null, {});
            return changed(q, id);
        });
    }
    async cancel(actor: AuditActor, id: string, expected: number) {
        return this.db.transaction(async (q) => {
            const s = await slot(q), j = await locked(q, id);
            rev(j, expected);
            if (s.job_id !== id || ['ready', 'cancelled'].includes(j.status))
                fail('EXECUTION_CANCEL_STATE', 'This run is no longer cancellable.');
            const immediate = !s.owner_token && !j.reconciliationRequired;
            await q.query('UPDATE public.factory_execution_jobs SET cancel_requested=true,status=CASE WHEN $2 THEN \'cancelled\' ELSE status END,summary=$3,revision=revision+1,updated_at=now() WHERE id=$1', [id, immediate, immediate ? 'Cancelled before worker dispatch.' : 'Cancellation requested; waiting for verified cleanup.']);
            if (immediate)
                await release(q);
            await append(q, id, 'cancellation_requested', { immediate });
            await audit(q, actor, 'execution.cancel', 'factory_execution', id, j.projectId, null, {});
            return changed(q, id);
        });
    }
    async retry(actor: AuditActor, id: string, expected: number) {
        return this.db.transaction(async (q) => {
            const s = await slot(q), j = await locked(q, id);
            rev(j, expected);
            if (s.job_id !== id || j.status !== 'blocked' || j.reconciliationRequired || j.cancelRequested || s.owner_token)
                fail('EXECUTION_RETRY_STATE', 'Resolve cleanup before retrying the blocked run.');
            const newId = randomUUID();
            await q.query('INSERT INTO public.factory_execution_jobs(id,request_id,project_id,parent_job_id,summary) VALUES($1,$2,$3,$4,$5)', [newId, j.requestId, j.projectId, id, 'New attempt with the original frozen context.']);
            await q.query('INSERT INTO public.factory_execution_contexts(job_id,content,checksum) SELECT $1,content,checksum FROM public.factory_execution_contexts WHERE job_id=$2', [newId, id]);
            await q.query('UPDATE public.factory_execution_slot SET job_id=$1 WHERE singleton=true', [newId]);
            await append(q, newId, 'retried', { parentJobId: id });
            await audit(q, actor, 'execution.retry', 'factory_execution', newId, j.projectId, null, { parentJobId: id });
            return changed(q, newId);
        });
    }
    async blockUnreconciled(id: string, expected: number, summary: string, code: string, token: string) { return this.db.transaction(async (q) => { const s = await slot(q), j = await locked(q, id); rev(j, expected); owned(s, j, token, true); await q.query('UPDATE public.factory_execution_jobs SET status=\'blocked\',reconciliation_required=true,summary=$2,error_code=$3,revision=revision+1,updated_at=now() WHERE id=$1', [id, summary, code]); await q.query('UPDATE public.factory_execution_slot SET owner_token=NULL,heartbeat_at=NULL WHERE singleton=true'); await append(q, id, 'cleanup_required', { summary, code }); return changed(q, id); }); }
    async recoverStale(cutoff: string) {
        return this.db.transaction(async (q) => {
            const s = await slot(q);
            if (!s.job_id || !s.owner_token || stamp(s.heartbeat_at) >= cutoff)
                return null;
            const fresh = (await q.query<Row>("SELECT heartbeat_at < now()-interval '60 seconds' AS stale FROM public.factory_execution_slot WHERE singleton=true")).rows[0];
            if (!fresh?.stale)
                return null;
            const j = await locked(q, s.job_id);
            await q.query('UPDATE public.factory_execution_jobs SET status=\'blocked\',reconciliation_required=true,error_code=\'WORKER_INTERRUPTED\',summary=\'Worker interrupted. Verify runtime cleanup before retrying.\',revision=revision+1,updated_at=now() WHERE id=$1', [j.id]);
            await q.query('UPDATE public.factory_execution_slot SET owner_token=NULL,heartbeat_at=NULL WHERE singleton=true');
            await append(q, j.id, 'worker_interrupted', {});
            return changed(q, j.id);
        });
    }
    async reconcile(id: string, expected: number) {
        return this.db.transaction(async (q) => {
            const s = await slot(q), j = await locked(q, id);
            rev(j, expected);
            if (s.job_id !== id || j.status !== 'blocked' || !j.reconciliationRequired || s.owner_token)
                fail('EXECUTION_RECOVERY_STATE', 'This run does not need recovery.');
            await q.query('UPDATE public.factory_execution_jobs SET reconciliation_required=false,status=CASE WHEN cancel_requested THEN \'cancelled\' ELSE status END,summary=\'Runtime cleanup verified.\',revision=revision+1,updated_at=now() WHERE id=$1', [id]);
            if (j.cancelRequested)
                await release(q);
            await append(q, id, 'cleanup_verified', {});
            return changed(q, id);
        });
    }
}
