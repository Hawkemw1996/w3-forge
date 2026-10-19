import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Database, Queryable } from '../src/db/database';
import { applyMigrations } from '../src/db/migrate';
import { createFactoryService } from '../src/factory/service';
import type { FactoryRequest } from '../src/factory/types';

describe('Software Factory durable process with real PostgreSQL semantics',()=>{
  const pg=new PGlite();
  type Executable=Queryable&{exec(sql:string):Promise<unknown>};
  const db:Database={query:async<T>(sql:string,params:unknown[]=[])=>{const r=await pg.query<T>(sql,params);return {rows:r.rows,rowCount:r.affectedRows};},ping:async()=>true,transaction:fn=>pg.transaction(async tx=>fn({query:async<T>(sql:string,params:unknown[]=[])=>{const r=await tx.query<T>(sql,params);return {rows:r.rows,rowCount:r.affectedRows};},exec:(sql:string)=>tx.exec(sql)} as Executable))};
  const service=createFactoryService(db);
  const actor={coreUserId:'core-owner',name:'Forge Owner'};
  const other={coreUserId:'core-other',name:'Other Administrator'};
  const migrationDir=path.resolve(__dirname,'../../database/migrations');
  const execute=async(tx:Queryable,sql:string)=>{await(tx as Executable).exec(sql);};
  const commit='a'.repeat(40);
  const artifact='b'.repeat(64);
  beforeAll(async()=>{await applyMigrations(db,migrationDir,execute);});
  afterAll(async()=>{await pg.close();});
  const project=()=>{const suffix=randomUUID().replace(/-/g,'');return service.createProject(actor,{name:'Factory '+suffix,appId:'app-'+suffix,repositoryUrl:`https://github.com/W3/${suffix}.git`,branch:'dev/v0.4.4',description:'Software project',rulesTitle:'Project rules',rulesMarkdown:'Use this project only. Preserve existing records.'});};
  const request=async(projectId:string)=>service.createRequest(actor,{projectId,title:'Improve the workspace',description:'Build a useful feature.',acceptanceCriteria:'Existing data remains intact and meaningful tests pass.'});
  const act=(r:FactoryRequest,action:string,extra:Record<string,unknown>={})=>service.action(actor,r.id,{action,expectedRevision:r.revision,...extra});
  const planned=async()=>{const p=await project();let r=await request(p.id);r=await act(r,'start_planning');r=await act(r,'submit_plan',{plan:'Implement within the approved branch, then test the acceptance criteria.'});r=await act(r,'approve_plan');return {p,r};};
  const testing=async()=>{const p=await planned();p.r=await act(p.r,'start_testing',{evidence:{commit}});return p;};

  it('applies additive migrations once and safely replays without changing rules or requests',async()=>{
    const p=await project();const r=await request(p.id);const replay=await applyMigrations(db,migrationDir,execute);expect(replay.applied).toEqual([]);expect(replay.skipped).toContain('002_software_factory.sql');expect((await service.snapshot(actor)).requests.find(item=>item.id===r.id)?.rulesChecksum).toBe(p.rulesChecksum);
  });
  it('canonicalizes repository bindings and refuses a second project for the same codebase',async()=>{
    const p=await project();expect(p.repositoryUrl).toMatch(/^https:\/\/github\.com\/w3\/[a-f0-9]+$/);
    await expect(service.createProject(actor,{name:'Duplicate',appId:'duplicate-'+randomUUID(),repositoryUrl:p.repositoryUrl,branch:'dev/v0.4.4',description:'',rulesTitle:'Rules',rulesMarkdown:'Rules'})).rejects.toMatchObject({status:409});
    await expect(service.createProject(actor,{name:'Wrong branch',appId:'other-app',repositoryUrl:'https://github.com/W3/another',branch:'main; touch /tmp/no',description:'',rulesTitle:'Rules',rulesMarkdown:'Rules'})).rejects.toMatchObject({status:400});
    for(const repositoryUrl of ['https://github.com/../repo','https://github.com/./repo','https://github.com/owner/..']) await expect(service.createProject(actor,{name:'Invalid path',appId:'invalid-path',repositoryUrl,branch:'dev/v0.4.4',description:'',rulesTitle:'Rules',rulesMarkdown:'Rules'})).rejects.toMatchObject({status:400});
  });
  it('pins immutable rules and prompt context while new revisions affect only new requests',async()=>{
    const p=await project();const first=await request(p.id);const original=await service.prompt(first.id);await service.updateRules(actor,p.id,{expectedVersion:1,title:'Revised rules',content:'New rules apply to later requests.'});const second=await request(p.id);expect(second.rulesVersion).toBe(2);expect((await service.prompt(first.id)).checksum).toBe(original.checksum);expect(original.prompt).toContain(p.repositoryUrl);expect(original.prompt).toContain(p.branch);expect(original.prompt).toContain('Preserve existing records.');expect(original.prompt).toContain(first.acceptanceCriteria);expect(original.prompt.length).toBeLessThanOrEqual(32000);
    await expect(db.query('UPDATE public.factory_rules SET content=$1 WHERE project_id=$2 AND version=1',['Rewritten',p.id])).rejects.toThrow();
    await expect(db.query('DELETE FROM public.factory_rules WHERE project_id=$1',[p.id])).rejects.toThrow();
    await expect(service.updateRules(actor,p.id,{expectedVersion:1,title:'Stale',content:'Not accepted'})).rejects.toMatchObject({status:409});
  });
  it('enforces FIFO per project and lets a separate project progress independently',async()=>{
    const p=await project();const first=await request(p.id);const second=await request(p.id);await expect(act(second,'start_planning')).rejects.toMatchObject({status:409});const different=await request((await project()).id);expect((await act(different,'start_planning')).status).toBe('planning');const cancelled=await act(first,'cancel',{reason:'Superseded by the second request.'});expect(cancelled.status).toBe('cancelled');expect((await act(second,'start_planning')).status).toBe('planning');
  });
  it('serializes concurrent transitions and rejects stale revisions without duplicate run evidence',async()=>{
    const r=await request((await project()).id);const results=await Promise.allSettled([act(r,'start_planning'),act(r,'start_planning')]);expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(results.filter(x=>x.status==='rejected')).toHaveLength(1);const snapshot=await service.snapshot(actor);expect(snapshot.requests.find(x=>x.id===r.id)?.revision).toBe(2);
  });
  it('does not let a concurrent later request overtake the oldest project request',async()=>{
    const p=await project();const first=await request(p.id);const second=await request(p.id);const results=await Promise.allSettled([act(second,'start_planning'),act(first,'start_planning')]);expect(results[0].status).toBe('rejected');expect(results[1].status).toBe('fulfilled');const snapshot=await service.snapshot(actor);expect(snapshot.requests.find(x=>x.id===second.id)?.status).toBe('queued');expect(snapshot.requests.find(x=>x.id===first.id)?.status).toBe('planning');
  });
  it('requires a submitted and explicitly approved plan before recording a development commit',async()=>{
    let r=await request((await project()).id);await expect(act(r,'approve_plan')).rejects.toMatchObject({status:409});r=await act(r,'start_planning');r=await act(r,'submit_plan',{plan:'First plan.'});r=await act(r,'submit_plan',{plan:'Second plan, preserved as a new revision.'});expect(r.planVersion).toBe(2);await expect(act(r,'start_testing',{evidence:{commit}})).rejects.toMatchObject({status:409});r=await act(r,'approve_plan');expect(r.status).toBe('development');await expect(act(r,'start_testing',{evidence:{commit:'short'}})).rejects.toMatchObject({status:400});
    const plans=(await db.query('SELECT version,content FROM public.factory_plans WHERE request_id=$1 ORDER BY version',[r.id])).rows;expect(plans).toHaveLength(2);await expect(db.query('UPDATE public.factory_plans SET content=$1 WHERE request_id=$2',['Mutated',r.id])).rejects.toThrow();
  });
  it('blocks failed test reports and requires matching current commit evidence before review',async()=>{
    let {r}=await testing();await expect(act(r,'submit_tests',{evidence:{commit:'c'.repeat(40),command:'npm test',exitCode:0,testsFailed:0,summary:'Wrong commit'}})).rejects.toMatchObject({status:400});r=await act(r,'submit_tests',{evidence:{commit,command:'npm test',exitCode:1,testsPassed:3,testsFailed:1,summary:'One test failed.'}});expect(r.status).toBe('blocked');r=await act(r,'resume');expect(r.status).toBe('testing');r=await act(r,'submit_tests',{evidence:{commit,command:'npm test',exitCode:0,testsPassed:4,testsFailed:0,summary:'All four tests passed.'}});expect(r.status).toBe('review');const receipts=(await service.snapshot(actor)).runs.filter(x=>x.requestId===r.id&&x.stage==='testing');expect(receipts).toHaveLength(2);expect(receipts.every(x=>x.source==='administrator_reported')).toBe(true);
  });
  it('requires artifact checksum and reviewer attestation for update ready and notifies only the requester',async()=>{
    let {r}=await testing();r=await act(r,'submit_tests',{evidence:{commit,command:'npm test',exitCode:0,testsPassed:4,testsFailed:0,summary:'Four tests passed.'}});await expect(act(r,'approve_update',{evidence:{commit,summary:'Reviewed.'}})).rejects.toMatchObject({status:400});r=await service.action(other,r.id,{action:'approve_update',expectedRevision:r.revision,evidence:{commit,summary:'Reviewed the reported tests and packaged update.',artifactReference:'w3forge.tar.gz',artifactChecksum:artifact}});expect(r.status).toBe('update_ready');const notice=(await service.snapshot(actor)).notifications.find(x=>x.requestId===r.id&&x.title==='Update ready');expect(notice).toBeDefined();expect((await service.snapshot(other)).notifications.some(x=>x.requestId===r.id)).toBe(false);await expect(service.readNotification(other,notice!.id)).rejects.toMatchObject({status:404});await service.readNotification(actor,notice!.id);expect((await service.snapshot(actor)).notifications.find(x=>x.id===notice!.id)?.read).toBe(true);const count=(await db.query<{count:string}>('SELECT count(*) count FROM public.factory_notifications WHERE request_id=$1 AND title=$2',[r.id,'Update ready'])).rows[0].count;expect(Number(count)).toBe(1);
  });
  it('rolls back project, rule and request changes when the required audit write fails',async()=>{
    const rejecting:Database={...db,transaction:fn=>db.transaction(q=>fn({query:async<T>(sql:string,params:unknown[]=[])=>{if(sql.includes('INSERT INTO public.audit_events'))throw new Error('Required audit rejected');return q.query<T>(sql,params);}}))};const denied=createFactoryService(rejecting);const p=await project();const before=(await service.listRules(p.id)).length;await expect(denied.updateRules(actor,p.id,{expectedVersion:1,title:'Blocked change',content:'Must roll back.'})).rejects.toThrow('audit rejected');expect((await service.listRules(p.id)).length).toBe(before);const requestsBefore=(await db.query('SELECT id FROM public.factory_requests WHERE project_id=$1',[p.id])).rows.length;await expect(denied.createRequest(actor,{projectId:p.id,title:'Rejected',description:'',acceptanceCriteria:'No partial write'})).rejects.toThrow();expect((await db.query('SELECT id FROM public.factory_requests WHERE project_id=$1',[p.id])).rows.length).toBe(requestsBefore);
    await expect(denied.createProject(actor,{name:'Rejected project',appId:'rejected-project',repositoryUrl:'https://github.com/w3/rejected-project',branch:'dev/v0.4.4',description:'',rulesTitle:'Rules',rulesMarkdown:'No partial project'})).rejects.toThrow();expect((await db.query('SELECT id FROM public.factory_projects WHERE app_id=$1',['rejected-project'])).rows).toHaveLength(0);
  });
  it('rolls back status, run receipt and notification together if auditing an action fails',async()=>{
    let {r}=await testing();const rejecting:Database={...db,transaction:fn=>db.transaction(q=>fn({query:async<T>(sql:string,params:unknown[]=[])=>{if(sql.includes('INSERT INTO public.audit_events'))throw new Error('audit unavailable');return q.query<T>(sql,params);}}))};await expect(createFactoryService(rejecting).action(actor,r.id,{action:'submit_tests',expectedRevision:r.revision,evidence:{commit,command:'npm test',exitCode:0,testsFailed:0,summary:'Reported pass'}})).rejects.toThrow();const current=(await service.snapshot(actor)).requests.find(x=>x.id===r.id)!;expect(current.status).toBe('testing');expect(current.revision).toBe(r.revision);expect((await service.snapshot(actor)).runs.filter(x=>x.requestId===r.id&&x.stage==='testing')).toHaveLength(0);
  });
  it('also rolls back evidence, status and audit if durable notification delivery cannot be recorded',async()=>{
    const {r}=await testing();const before=await db.query(`SELECT id FROM public.audit_events WHERE entity_id=$1`,[r.id]);const rejecting:Database={...db,transaction:fn=>db.transaction(q=>fn({query:async<T>(sql:string,params:unknown[]=[])=>{if(sql.includes('INSERT INTO public.factory_notifications'))throw new Error('notification persistence unavailable');return q.query<T>(sql,params);}}))};await expect(createFactoryService(rejecting).action(actor,r.id,{action:'submit_tests',expectedRevision:r.revision,evidence:{commit,command:'npm test',exitCode:0,testsFailed:0,summary:'Reported pass'}})).rejects.toThrow();const snapshot=await service.snapshot(actor);expect(snapshot.requests.find(x=>x.id===r.id)?.status).toBe('testing');expect(snapshot.runs.filter(x=>x.requestId===r.id&&x.stage==='testing')).toHaveLength(0);expect((await db.query('SELECT id FROM public.audit_events WHERE entity_id=$1',[r.id])).rows.length).toBe(before.rows.length);
  });
  it('rejects stale AI drafts after concurrent request changes and never submits or approves them silently',async()=>{
    let r=await request((await project()).id);r=await act(r,'start_planning');const draft=await service.draftPlan(actor,r.id,{model:'qwen2.5-coder:14b',expectedRevision:r.revision},async(_model,prompt)=>{expect(prompt).toContain('PROJECT RULES');return 'A proposed plan for review.';});expect(draft.plan).toBe('A proposed plan for review.');expect((await service.snapshot(actor)).requests.find(x=>x.id===r.id)?.planVersion).toBe(0);
    await expect(service.draftPlan(actor,r.id,{model:'qwen2.5-coder:14b',expectedRevision:r.revision},async()=>{await act(r,'block',{reason:'Hold this request.'});return 'Stale plan';})).rejects.toMatchObject({status:409});
  });
  it('requires reasons for blocked and cancelled work and preserves its resumable stage',async()=>{
    let r=await request((await project()).id);await expect(act(r,'block')).rejects.toMatchObject({status:400});r=await act(r,'block',{reason:'Waiting on requirements.'});expect(r.blockReason).toBe('Waiting on requirements.');r=await act(r,'resume');expect(r.status).toBe('queued');expect(r.blockReason).toBe(null);await expect(act(r,'cancel')).rejects.toMatchObject({status:400});r=await act(r,'cancel',{reason:'No longer needed.'});await expect(act(r,'resume')).rejects.toMatchObject({status:409});
  });
  it('bounds snapshot payloads without hiding the oldest queued work and counts all durable requests',async()=>{
    const p=await project();const first=await request(p.id);await db.query(`INSERT INTO public.factory_requests(id,project_id,title,description,acceptance_criteria,rules_version,rules_checksum,repository_url,branch,created_by,created_by_name) SELECT $1||n::text,$2,'Queued fixture','','Check queue limits',1,$3,$4,$5,$6,$7 FROM generate_series(1,205) n`,['limit-'+randomUUID()+'-',p.id,p.rulesChecksum,p.repositoryUrl,p.branch,actor.coreUserId,actor.name]);const snapshot=await service.snapshot(actor);expect(snapshot.requests).toHaveLength(200);expect(snapshot.requests.some(r=>r.id===first.id)).toBe(true);const queued=(await db.query<{total:number}>(`SELECT count(*)::int total FROM public.factory_requests WHERE status='queued'`)).rows[0].total;expect(snapshot.metrics.queued).toBe(queued);expect(snapshot.metrics.queued).toBeGreaterThan(200);
  });
  it('keeps another project actionable when one project has more than 200 queued requests',async()=>{
    const a=await project();await db.query(`INSERT INTO public.factory_requests(id,project_id,title,description,acceptance_criteria,rules_version,rules_checksum,repository_url,branch,created_by,created_by_name) SELECT $1||n::text,$2,'Large project queue','','Check independent project progress',1,$3,$4,$5,$6,$7 FROM generate_series(1,205) n`,['large-'+randomUUID()+'-',a.id,a.rulesChecksum,a.repositoryUrl,a.branch,actor.coreUserId,actor.name]);const firstA=(await db.query<{id:string}>('SELECT id FROM public.factory_requests WHERE project_id=$1 ORDER BY sequence LIMIT 1',[a.id])).rows[0].id;const b=await project();const firstB=await request(b.id);const snapshot=await service.snapshot(actor);expect(snapshot.requests).toHaveLength(200);expect(snapshot.requests.some(r=>r.id===firstA)).toBe(true);expect(snapshot.requests.some(r=>r.id===firstB.id)).toBe(true);expect((await act(firstB,'start_planning')).status).toBe('planning');
  });
});
