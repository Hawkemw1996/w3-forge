import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { executionSettingsSchema, executionSettings } from './settings';
import type { Database, Queryable } from '../db/database';
import { audit, type AuditActor } from '../db/audit';
import { AdminError } from '../admin/envelope';
import type { AgentProfile, AgentRevision, AgentSnapshot, AgentServiceOptions } from './types';

const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !value.includes('\u0000'));
const markdown = z.string().transform(value => value.replace(/\r\n?/g, '\n').trim()).pipe(text(12000));
const revision = z.number().int().positive().max(2147483646);
const provider = z.enum(['ollama', 'codex', 'claude']).nullable();
const model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,159}$/).nullable();
const profileFields = { name: text(120), purpose: text(600), profileMarkdown: markdown };
export const createAgentSchema = z.object({ ...profileFields, provider: provider.default(null), model: model.default(null), enabled: z.boolean().default(true), executionSettings: executionSettingsSchema.default({}) }).strict();
export const updateAgentSchema = z.object({ ...profileFields, expectedRevision: revision }).strict();
export const settingsSchema = z.object({ expectedRevision: revision, executionSettings: executionSettingsSchema }).strict();
export const assignmentSchema = z.object({ expectedRevision: revision, provider, model }).strict();
export const statusSchema = z.object({ expectedRevision: revision, enabled: z.boolean() }).strict();
export const deleteAgentSchema = z.object({ expectedRevision: revision }).strict();
export const duplicateAgentSchema = z.object({ expectedRevision: revision, name: text(120) }).strict();
function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, any>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success || Buffer.byteLength(JSON.stringify(result.data), 'utf8') > 60000) throw new AdminError(400, 'INVALID_AGENT_INPUT', 'Check the required agent fields and their limits.');
  return result.data;
}
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
type Row = Record<string, any>;
const SELECT = `SELECT a.*,p.version profile_version,p.name,p.purpose,p.content profile_markdown,p.checksum profile_checksum,s.provider,s.model,e.config execution_settings FROM public.factory_agents a JOIN public.factory_agent_profiles p ON p.agent_id=a.id AND p.revision=a.profile_revision JOIN public.factory_agent_assignments s ON s.agent_id=a.id AND s.revision=a.assignment_revision JOIN public.factory_agent_execution_settings e ON e.agent_id=a.id AND e.revision=a.execution_revision`;
const dto = (r: Row): AgentProfile => ({ id:r.id,slug:r.slug,name:r.name,purpose:r.purpose,enabled:r.enabled,revision:r.revision,profileVersion:r.profile_version,profileMarkdown:r.profile_markdown,profileChecksum:r.profile_checksum,provider:r.provider,model:r.model,executionSettings:executionSettings(r.execution_settings),executionRevision:r.execution_revision,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at) });
const conflict = (): never => { throw new AdminError(409, 'AGENT_CONFLICT', 'This agent changed. Refresh before saving.'); };
async function row(q: Queryable, id: string, lock = false, includeDeleted = false): Promise<Row> {
  const result = await q.query<Row>(`${SELECT} WHERE a.id=$1${includeDeleted ? '' : ' AND a.deleted_at IS NULL'}${lock ? ' FOR UPDATE OF a' : ''}`, [id]);
  if (!result.rows[0]) throw new AdminError(404, 'AGENT_NOT_FOUND', 'Agent not found.');
  return result.rows[0];
}
async function locked(q: Queryable, id: string, expected: number) { const current=await row(q,id,true); if(current.revision!==expected) conflict(); return current; }
function checkAssignment(p: {provider: string | null; model: string | null}) {
  if(p.provider===null && p.model!==null) throw new AdminError(400,'INVALID_AGENT_ASSIGNMENT','Choose a provider before assigning a model.');
}
function nextVersion(value: string) {
  const parts=value.split('.').map(Number);
  if(parts.length!==3 || parts.some(part=>!Number.isSafeInteger(part)||part<0) || parts[2]>=2147483646) throw new AdminError(409,'AGENT_VERSION_LIMIT','The profile version needs owner review.');
  return `${parts[0]}.${parts[1]}.${parts[2]+1}`;
}
async function insert(q: Queryable, actor: AuditActor, p: {name:string;purpose:string;profileMarkdown:string;provider:AgentProfile['provider'];model:string|null;enabled:boolean;executionSettings?:unknown}) {
  const id=randomUUID(); const base=p.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60); const slug=(/^[a-z]/.test(base)?base:'agent-'+base)+'-'+id.slice(0,8);
  await q.query('INSERT INTO public.factory_agents(id,slug,enabled,created_by) VALUES($1,$2,$3,$4)',[id,slug,p.enabled,actor.coreUserId]);
  await q.query('INSERT INTO public.factory_agent_profiles(agent_id,revision,version,name,purpose,content,checksum,created_by) VALUES($1,1,$2,$3,$4,$5,$6,$7)',[id,'0.1.0',p.name,p.purpose,p.profileMarkdown,hash(p.profileMarkdown),actor.coreUserId]);
  await q.query('INSERT INTO public.factory_agent_assignments(agent_id,revision,provider,model,created_by) VALUES($1,1,$2,$3,$4)',[id,p.provider,p.model,actor.coreUserId]);
  const config=executionSettings(p.executionSettings);
  if(JSON.stringify(config)!==JSON.stringify(executionSettings())){
    await q.query('INSERT INTO public.factory_agent_execution_settings(agent_id,revision,config,created_by) VALUES($1,2,$2::jsonb,$3)',[id,JSON.stringify(config),actor.coreUserId]);
    await q.query('UPDATE public.factory_agents SET execution_revision=2 WHERE id=$1',[id]);
  }
  return row(q,id);
}
export function createAgentService(db: Database, options: AgentServiceOptions = {}) {
  return {
    async list(): Promise<AgentSnapshot> { const result=await db.query<Row>(`${SELECT} WHERE a.deleted_at IS NULL ORDER BY a.created_at,a.slug`);return {agents:result.rows.map(dto),observedAt:new Date().toISOString()}; },
    async history(id: string): Promise<AgentRevision[]> {
      await row(db,id,false,true);
      const result=await db.query<Row>('SELECT * FROM public.factory_agent_profiles WHERE agent_id=$1 ORDER BY revision DESC',[id]);
      return result.rows.map(p=>({agentId:p.agent_id,version:p.version,name:p.name,purpose:p.purpose,profileMarkdown:p.content,checksum:p.checksum,createdAt:iso(p.created_at),createdBy:p.created_by}));
    },
    async create(actor: AuditActor, input: unknown): Promise<AgentProfile> {
      const p=parse(createAgentSchema,input);checkAssignment(p);await options.validateModel?.(p.provider,p.model);
      return db.transaction(async q=>{const created=await insert(q,actor,p);await audit(q,actor,'agent.create','factory_agent',created.id,null,null,{version:created.profile_version,checksum:created.profile_checksum,provider:p.provider,model:p.model});return dto(created);});
    },
    async updateProfile(actor: AuditActor, id: string, input: unknown): Promise<AgentProfile> {
      const p=parse(updateAgentSchema,input);
      return db.transaction(async q=>{const current=await locked(q,id,p.expectedRevision);if(current.name===p.name&&current.purpose===p.purpose&&current.profile_markdown===p.profileMarkdown)return dto(current);
        const version=nextVersion(current.profile_version), number=current.profile_revision+1;
        await q.query('INSERT INTO public.factory_agent_profiles(agent_id,revision,version,name,purpose,content,checksum,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,number,version,p.name,p.purpose,p.profileMarkdown,hash(p.profileMarkdown),actor.coreUserId]);
        await q.query('UPDATE public.factory_agents SET profile_revision=$2,revision=revision+1,updated_at=now() WHERE id=$1',[id,number]);
        await audit(q,actor,'agent.profile_revise','factory_agent',id,null,null,{version,checksum:hash(p.profileMarkdown)});return dto(await row(q,id));
      });
    },
    async assign(actor: AuditActor, id: string, input: unknown): Promise<AgentProfile> {
      const p=parse(assignmentSchema,input);checkAssignment(p);await options.validateModel?.(p.provider,p.model);
      return db.transaction(async q=>{const current=await locked(q,id,p.expectedRevision);if(current.provider===p.provider&&current.model===p.model)return dto(current);const number=current.assignment_revision+1;
        await q.query('INSERT INTO public.factory_agent_assignments(agent_id,revision,provider,model,created_by) VALUES($1,$2,$3,$4,$5)',[id,number,p.provider,p.model,actor.coreUserId]);
        await q.query('UPDATE public.factory_agents SET assignment_revision=$2,revision=revision+1,updated_at=now() WHERE id=$1',[id,number]);
        await audit(q,actor,'agent.assign','factory_agent',id,null,null,{assignmentRevision:number,provider:p.provider,model:p.model});return dto(await row(q,id));
      });
    },
    async configure(actor: AuditActor, id: string, input: unknown): Promise<AgentProfile> {
      const p=parse(settingsSchema,input);
      return db.transaction(async q=>{ const current=await locked(q,id,p.expectedRevision);
        if(JSON.stringify(executionSettings(current.execution_settings))===JSON.stringify(p.executionSettings))return dto(current);
        const number=current.execution_revision+1;
        await q.query('INSERT INTO public.factory_agent_execution_settings(agent_id,revision,config,created_by) VALUES($1,$2,$3::jsonb,$4)',[id,number,JSON.stringify(p.executionSettings),actor.coreUserId]);
        await q.query('UPDATE public.factory_agents SET execution_revision=$2,revision=revision+1,updated_at=now() WHERE id=$1',[id,number]);
        await audit(q,actor,'agent.execution_configure','factory_agent',id,null,null,{executionRevision:number});return dto(await row(q,id));
      });
    },
    async status(actor: AuditActor, id: string, input: unknown): Promise<AgentProfile> {
      const p=parse(statusSchema,input);return db.transaction(async q=>{const current=await locked(q,id,p.expectedRevision);if(current.enabled===p.enabled)return dto(current);
        await q.query('UPDATE public.factory_agents SET enabled=$2,revision=revision+1,updated_at=now() WHERE id=$1',[id,p.enabled]);await audit(q,actor,'agent.status','factory_agent',id,null,null,{enabled:p.enabled});return dto(await row(q,id));});
    },
    async delete(actor: AuditActor, id: string, input: unknown) {
      const p=parse(deleteAgentSchema,input);return db.transaction(async q=>{await locked(q,id,p.expectedRevision);await q.query('UPDATE public.factory_agents SET deleted_at=now(),enabled=false,revision=revision+1,updated_at=now() WHERE id=$1',[id]);await audit(q,actor,'agent.delete','factory_agent',id,null,null,{retainedHistory:true});return {deleted:true,id};});
    },
    async duplicate(actor: AuditActor, id: string, input: unknown): Promise<AgentProfile> {
      const p=parse(duplicateAgentSchema,input);return db.transaction(async q=>{const current=await locked(q,id,p.expectedRevision);const created=await insert(q,actor,{name:p.name,purpose:current.purpose,profileMarkdown:current.profile_markdown,provider:current.provider,model:current.model,enabled:false,executionSettings:current.execution_settings});await audit(q,actor,'agent.duplicate','factory_agent',created.id,null,null,{sourceId:id,sourceVersion:current.profile_version});return dto(created);});
    }
  };
}
