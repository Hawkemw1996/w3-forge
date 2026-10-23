import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Queryable } from '../db/database';
import { AdminError } from '../admin/envelope';
import type { ExecutionJob, ExecutionProfile } from './types';
import { executionSettings } from '../agents/settings';
import { checksum, estimateTokens } from './contextGateway';

export type UsageSource = 'provider' | 'estimated' | 'unavailable';
export interface ModelUsage { inputTokens: number | null; outputTokens: number | null; inputSource: UsageSource; outputSource: UsageSource; cachedInputTokens?: number | null }
export const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
export function usage(input: unknown, output: unknown): ModelUsage {
  const i = count(input), o = count(output);
  return { inputTokens: i, outputTokens: o, inputSource: i === null ? 'unavailable' : 'provider', outputSource: o === null ? 'unavailable' : 'provider' };
}
function redactText(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/((?:"?)(?:authorization|api[_-]?key|(?:access|refresh)[_-]?token|password|(?:client[_-]?)?secret|private[_-]?key)(?:"?)\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g, '[redacted]')
    .replace(/\b(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi,'$1[redacted]@')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[redacted private key]');
}
export function redactEvidence(value: string, depth=0): string {
  if(depth>12)return redactText(value);
  try {
    const data=JSON.parse(value);let changed=false;
    const visit=(item:any,level:number):any=>{
      if(typeof item==='string'){const safe=redactEvidence(item,depth+level+1);changed ||= safe!==item;return safe;}
      if(!item||typeof item!=='object')return item;
      if(level>12){const safe=redactText(JSON.stringify(item));changed=true;return safe;}
      if(Array.isArray(item))return item.map(v=>visit(v,level+1));
      return Object.fromEntries(Object.entries(item).map(([k,v])=>{
        if(/^(?:authorization|api[_-]?key|(?:access|refresh)[_-]?token|password|(?:client[_-]?)?secret|private[_-]?key)$/i.test(k)){changed=true;return[k,'[redacted]'];}
        return[k,visit(v,level+1)];
      }));
    };
    const safe=visit(data,0);
    return changed?JSON.stringify(safe):value;
  }catch{return redactText(value);}
}
export async function keepRecord(q: Queryable, jobId: string, kind: string, content: string) {
  const id = randomUUID();
  if (Buffer.byteLength(content) > 8388608) throw new AdminError(409, 'EVIDENCE_LIMIT', 'Execution evidence exceeds its storage limit.');
  await q.query('INSERT INTO public.factory_execution_records(id,job_id,kind,content,checksum) VALUES($1,$2,$3,$4,$5)', [id, jobId, kind, content, checksum(content)]);
  return id;
}
export async function beginCall(q: Queryable, job: ExecutionJob, profile: ExecutionProfile, original: string, prompt: string, attempt: number) {
  const id = randomUUID(), settings = executionSettings(profile.executionSettings);
  const input = await keepRecord(q, job.id, 'model_input', original), view = await keepRecord(q, job.id, 'context_view', prompt);
  await q.query('INSERT INTO public.factory_agent_executions(id,job_id,project_id,agent_id,agent_name,profile_version,profile_checksum,profile_revision,assignment_revision,execution_revision,provider,requested_model,context_mode,settings,attempt,input_record_id,context_record_id,input_tokens,input_source,original_context_tokens,processed_context_tokens) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21)',
    [id, job.id, job.projectId, profile.id, profile.name, profile.profileVersion, profile.profileChecksum, profile.revision, profile.assignmentRevision, profile.executionRevision ?? 1, profile.provider, profile.model, settings.contextMode, JSON.stringify(settings), attempt, input, view, estimateTokens(prompt), 'estimated', estimateTokens(original), estimateTokens(prompt)]);
  return id;
}
export async function finishCall(q: Queryable, jobId: string, id: string, result: {
  text?: string; rawOutput?: string; resolvedModel?: string | null; usage?: ModelUsage;
}, status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled', errorCode?: string) {
  const row = (await q.query<any>("SELECT * FROM public.factory_agent_executions WHERE id=$1 AND job_id=$2 AND status='running' FOR UPDATE", [id,jobId])).rows[0];
  if (!row) throw new AdminError(409, 'OBSERVATION_CLOSED', 'This provider attempt is already closed.');
  const output = result.rawOutput ?? result.text;
  const recordId = output === undefined ? null : await keepRecord(q, jobId, 'model_output', output);
  const i = count(result.usage?.inputTokens) ?? Number(row.input_tokens);
  const o = count(result.usage?.outputTokens) ?? (result.text === undefined ? null : estimateTokens(result.text));
  const inputSource = count(result.usage?.inputTokens) !== null ? result.usage!.inputSource : 'estimated';
  const outputSource = count(result.usage?.outputTokens) !== null ? result.usage!.outputSource : o === null ? 'unavailable' : 'estimated';
  const pricing = executionSettings(row.settings).pricing, model = result.resolvedModel ?? row.requested_model;
  const cost = pricing && pricing.provider === row.provider && pricing.model === model && inputSource === 'provider' && outputSource === 'provider' && !result.usage?.cachedInputTokens && (row.provider==='ollama'||result.usage?.cachedInputTokens===0) ?
    (i * pricing.inputUsdPerMillion + o! * pricing.outputUsdPerMillion) / 1000000 : null;
  await q.query("UPDATE public.factory_agent_executions SET status=$2,completed_at=now(),duration_ms=GREATEST(0,EXTRACT(EPOCH FROM(now()-started_at))*1000),input_tokens=$3,output_tokens=$4,input_source=$5,output_source=$6,estimated_cost_usd=$7,output_record_id=$8,resolved_model=$9,error_code=$10 WHERE id=$1 AND status='running'",
    [id,status,i,o,inputSource,outputSource,cost,recordId,result.resolvedModel??null,errorCode??null]);
}
export async function interruptCalls(q: Queryable, jobId: string) {
  await q.query("UPDATE public.factory_agent_executions SET status='interrupted',completed_at=now(),duration_ms=GREATEST(0,EXTRACT(EPOCH FROM(now()-started_at))*1000),error_code='WORKER_INTERRUPTED' WHERE job_id=$1 AND status='running'", [jobId]);
}
const identifier = z.string().regex(/^[A-Za-z0-9-]{1,80}$/), date = z.string().datetime({ offset: true });
export const metricsFilterSchema = z.object({
  projectId: identifier.optional(), agentId: identifier.optional(), provider: z.enum(['ollama','codex','claude']).optional(),
  from: date.optional(), to: date.optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0)
}).strict().refine(v => !v.from || !v.to || new Date(v.from) <= new Date(v.to));
export class ExecutionMetrics {
  constructor(private db: Database) {}
  async record(id: string) {
    const r = (await this.db.query<any>('SELECT id,job_id,kind,content,checksum,created_at FROM public.factory_execution_records WHERE id=$1', [id])).rows[0];
    if (!r) throw new AdminError(404,'EVIDENCE_NOT_FOUND','Execution evidence not found.');
    if (checksum(r.content) !== r.checksum) throw new AdminError(409,'EVIDENCE_INVALID','Execution evidence failed verification.');
    const content = redactEvidence(r.content);
    return { id:r.id, jobId:r.job_id, kind:r.kind, content, originalChecksum:r.checksum, redacted:content!==r.content, createdAt:new Date(r.created_at).toISOString() };
  }
  async records(jobId: string) {
    return (await this.db.query<any>('SELECT id,kind,checksum,octet_length(content) size_bytes,created_at FROM public.factory_execution_records WHERE job_id=$1 ORDER BY created_at,id LIMIT 2000',[jobId])).rows.map(r=>({id:r.id,kind:r.kind,checksum:r.checksum,sizeBytes:r.size_bytes,createdAt:new Date(r.created_at).toISOString()}));
  }
  async snapshot(input: unknown) {
    const parsed = metricsFilterSchema.safeParse(input);
    if (!parsed.success) throw new AdminError(400,'INVALID_METRICS_FILTER','Choose valid filters and a date range in chronological order.');
    const f=parsed.data, values:unknown[]=[], clauses:string[]=[];
    for(const [column,value] of [['e.project_id',f.projectId],['e.agent_id',f.agentId],['e.provider',f.provider],['e.started_at >=',f.from],['e.started_at <',f.to]] as const) {
      if(value!==undefined){values.push(value);clauses.push(column+(column.includes(' ')?' ':'=')+'$'+values.length);}
    }
    const where=clauses.length?' WHERE '+clauses.join(' AND '):'';
    const aggregate = [
      "count(*)::int executions,count(*) FILTER(WHERE status='succeeded')::int succeeded,",
      "count(*) FILTER(WHERE status IN ('failed','timed_out','interrupted'))::int failed,",
      "count(*) FILTER(WHERE status='running')::int running,count(*) FILTER(WHERE status='cancelled')::int cancelled,",
      'sum(input_tokens)::float8 input_tokens,sum(output_tokens)::float8 output_tokens,',
      'sum(CASE WHEN input_tokens IS NOT NULL AND output_tokens IS NOT NULL THEN input_tokens+output_tokens END)::float8 total_tokens,',
      "count(*) FILTER(WHERE input_source='provider' AND output_source='provider')::int provider_reported,",
      "count(*) FILTER(WHERE input_source='estimated' OR output_source='estimated')::int estimated,",
      'count(*) FILTER(WHERE input_tokens IS NULL OR output_tokens IS NULL)::int unavailable_usage,',
      'avg(duration_ms)::float8 average_duration_ms,sum(estimated_cost_usd)::float8 estimated_cost_usd,',
      'count(*) FILTER(WHERE estimated_cost_usd IS NULL)::int unavailable_cost,',
      'sum(original_context_tokens)::float8 original_context_tokens,sum(processed_context_tokens)::float8 processed_context_tokens'
    ].join(' ');
    const total=await this.db.query<any>('SELECT '+aggregate+' FROM public.factory_agent_executions e'+where,values);
    const providers=await this.db.query<any>('SELECT provider,'+aggregate+' FROM public.factory_agent_executions e'+where+' GROUP BY provider ORDER BY provider',values);
    const projects=await this.db.query<any>('SELECT e.project_id,p.name project_name,'+aggregate+' FROM public.factory_agent_executions e JOIN public.factory_projects p ON p.id=e.project_id'+where+' GROUP BY e.project_id,p.name ORDER BY p.name,e.project_id',values);
    const history=await this.db.query<any>('SELECT e.*,j.request_id,p.name project_name FROM public.factory_agent_executions e JOIN public.factory_execution_jobs j ON j.id=e.job_id JOIN public.factory_projects p ON p.id=e.project_id'+where+' ORDER BY e.started_at DESC,e.id DESC LIMIT $'+(values.length+1)+' OFFSET $'+(values.length+2),[...values,f.limit,f.offset]);
    return { totals:total.rows[0], byProvider:providers.rows, byProject:projects.rows, history:history.rows.map(r=>({
      id:r.id,jobId:r.job_id,taskId:r.request_id,projectId:r.project_id,projectName:r.project_name,agentId:r.agent_id,agentName:r.agent_name,
      profileVersion:r.profile_version,profileRevision:r.profile_revision,profileChecksum:r.profile_checksum,assignmentRevision:r.assignment_revision,executionRevision:r.execution_revision,
      provider:r.provider,requestedModel:r.requested_model,resolvedModel:r.resolved_model,contextMode:r.context_mode,retryCount:r.attempt,status:r.status,
      startedAt:new Date(r.started_at).toISOString(),completedAt:r.completed_at?new Date(r.completed_at).toISOString():null,durationMs:r.duration_ms,
      inputTokens:r.input_tokens===null?null:Number(r.input_tokens),outputTokens:r.output_tokens===null?null:Number(r.output_tokens),
      totalTokens:r.input_tokens===null||r.output_tokens===null?null:Number(r.input_tokens)+Number(r.output_tokens),
      inputSource:r.input_source,outputSource:r.output_source,estimatedCostUsd:r.estimated_cost_usd===null?null:Number(r.estimated_cost_usd),
      inputRecordId:r.input_record_id,contextRecordId:r.context_record_id,outputRecordId:r.output_record_id,errorCode:r.error_code
    })), limit:f.limit,offset:f.offset,observedAt:new Date().toISOString() };
  }
}
