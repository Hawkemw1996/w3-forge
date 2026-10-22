import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import type { Database, Queryable } from '../src/db/database';
import { applyMigrations } from '../src/db/migrate';
import { createAgentService } from '../src/agents/service';
import { buildWorkspaceRouter } from '../src/workspace/routes';
import { createCoreFixture } from './coreFixture';

const actor={coreUserId:'core-owner',name:'Forge Owner'};
const profileInput={name:'Test Developer',purpose:'Implement a narrow change with recorded evidence.',profileMarkdown:'# Developer\n\nRead project rules and verify acceptance criteria.',provider:'codex',model:null,enabled:true};
describe('durable versioned agent profiles',()=>{
  const pg=new PGlite();
  type Executable=Queryable&{exec(sql:string):Promise<unknown>};
  const db:Database={query:async<T>(sql:string,params:unknown[]=[])=>{const r=await pg.query<T>(sql,params);return {rows:r.rows,rowCount:r.affectedRows};},ping:async()=>true,transaction:fn=>pg.transaction(async tx=>fn({query:async<T>(sql:string,params:unknown[]=[])=>{const r=await tx.query<T>(sql,params);return {rows:r.rows,rowCount:r.affectedRows};},exec:(sql:string)=>tx.exec(sql)} as Executable))};
  const service=createAgentService(db);
  const migrations=path.resolve(__dirname,'../../database/migrations');
  const execute=async(tx:Queryable,sql:string)=>{await(tx as Executable).exec(sql);};
  beforeAll(async()=>{await applyMigrations(db,migrations,execute);});
  afterAll(async()=>{await pg.close();});
  it('seeds all seven complete unique v0.1.0 templates atomically with matching canonical bytes',async()=>{
    const initial=await service.list();expect(initial.agents).toHaveLength(7);
    const ids=['orchestrator','specification-writer','developer','code-reviewer','security-reviewer','ui-reviewer','ux-reviewer'];
    expect(initial.agents.map(a=>a.slug).sort()).toEqual([...ids].sort());
    expect(new Set(initial.agents.map(a=>a.profileChecksum)).size).toBe(7);
    for(const agent of initial.agents){
      const template=fs.readFileSync(path.resolve(__dirname,'../../config/agents',agent.slug+'.md'),'utf8').replace(/\r\n?/g,'\n');
      const match=template.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);expect(match).not.toBeNull();
      expect(agent.profileMarkdown).toBe(match![1].trim());expect(agent.profileVersion).toBe('0.1.0');
      expect(agent.profileChecksum).toBe(createHash('sha256').update(agent.profileMarkdown,'utf8').digest('hex'));
      expect(agent.profileMarkdown.length).toBeGreaterThan(1000);expect(agent.model).toBeNull();
    }
    expect((await applyMigrations(db,migrations,execute)).applied).toEqual([]);
  });
  it('separates profile versions from assignments and enabled state and preserves earlier revisions',async()=>{
    let a=await service.create(actor,profileInput);const original=a.profileChecksum;
    a=await service.assign(actor,a.id,{expectedRevision:a.revision,provider:'claude',model:'provider-model-id'});
    expect(a.profileVersion).toBe('0.1.0');expect(a.profileChecksum).toBe(original);
    a=await service.status(actor,a.id,{expectedRevision:a.revision,enabled:false});expect(a.profileVersion).toBe('0.1.0');
    a=await service.updateProfile(actor,a.id,{expectedRevision:a.revision,name:a.name,purpose:a.purpose,profileMarkdown:a.profileMarkdown+'\n\nRecord the exact commit.'});
    expect(a.profileVersion).toBe('0.1.1');expect(a.provider).toBe('claude');expect(a.model).toBe('provider-model-id');expect(a.enabled).toBe(false);
    const history=await service.history(a.id);expect(history.map(h=>h.version)).toEqual(['0.1.1','0.1.0']);expect(history[1].checksum).toBe(original);
    const noChange=await service.updateProfile(actor,a.id,{expectedRevision:a.revision,name:a.name,purpose:a.purpose,profileMarkdown:a.profileMarkdown.replace(/\n/g,'\r\n')+'\r\n'});expect(noChange.revision).toBe(a.revision);expect((await service.history(a.id))).toHaveLength(2);
    const restarted=createAgentService(db);expect((await restarted.list()).agents.find(item=>item.id===a.id)).toEqual(a);
  });
  it('rejects stale edits and concurrent changes without overwriting profile or assignment history',async()=>{
    const a=await service.create(actor,profileInput);
    const results=await Promise.allSettled([service.status(actor,a.id,{expectedRevision:a.revision,enabled:false}),service.assign(actor,a.id,{expectedRevision:a.revision,provider:'claude',model:null})]);
    expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(results.filter(x=>x.status==='rejected')).toHaveLength(1);
    await expect(service.updateProfile(actor,a.id,{expectedRevision:a.revision,name:'Stale',purpose:a.purpose,profileMarkdown:'Stale content'})).rejects.toMatchObject({status:409});
    const current=(await service.list()).agents.find(item=>item.id===a.id)!;expect(current.name).toBe(a.name);expect((await service.history(a.id))).toHaveLength(1);
  });
  it('duplicates current instructions independently and deletes by retaining immutable history',async()=>{
    const a=await service.create(actor,profileInput);const copy=await service.duplicate(actor,a.id,{expectedRevision:a.revision,name:'Developer copy'});
    expect(copy.id).not.toBe(a.id);expect(copy.slug).not.toBe(a.slug);expect(copy.profileVersion).toBe('0.1.0');expect(copy.profileMarkdown).toBe(a.profileMarkdown);expect(copy.enabled).toBe(false);
    await service.delete(actor,copy.id,{expectedRevision:copy.revision});expect((await service.list()).agents.some(item=>item.id===copy.id)).toBe(false);expect((await service.history(copy.id))).toHaveLength(1);
    await expect(service.status(actor,copy.id,{expectedRevision:copy.revision,enabled:true})).rejects.toMatchObject({status:404});
    await expect(db.query('UPDATE public.factory_agent_profiles SET content=$1 WHERE agent_id=$2',['Rewritten',a.id])).rejects.toThrow();
    await expect(db.query('DELETE FROM public.factory_agent_assignments WHERE agent_id=$1',[a.id])).rejects.toThrow();
    const seed=(await service.list()).agents.find(item=>item.slug==='ux-reviewer')!;await service.delete(actor,seed.id,{expectedRevision:seed.revision});await applyMigrations(db,migrations,execute);expect((await service.list()).agents.some(item=>item.id===seed.id)).toBe(false);expect((await service.history(seed.id))).toHaveLength(1);
  });
  it('rejects invalid input and validates explicit Ollama selection without sending generation requests',async()=>{
    for(const patch of [{name:''},{purpose:' '},{profileMarkdown:'\n'},{profileMarkdown:'x'.repeat(12001)},{provider:'unsupported'},{provider:null,model:'some-model'},{model:'bad model'},{profileMarkdown:'bad\u0000content'},{extra:'not accepted'}])await expect(service.create(actor,{...profileInput,...patch})).rejects.toMatchObject({status:400});
    let checks=0;const checked=createAgentService(db,{validateModel:async(provider,model)=>{checks++;if(provider==='ollama'&&model==='missing')throw new Error('model unavailable');}});
    await expect(checked.create(actor,{...profileInput,provider:'ollama',model:'missing'})).rejects.toThrow('model unavailable');expect(checks).toBe(1);
    expect((await db.query<{count:number}>("SELECT count(*)::int count FROM public.factory_agent_assignments WHERE model='missing'")).rows[0].count).toBe(0);
  });
  it('rolls back every mutation if required audit persistence fails',async()=>{
    const a=await service.create(actor,profileInput);
    const rejecting:Database={...db,transaction:fn=>db.transaction(q=>fn({query:async<T>(sql:string,params:unknown[]=[])=>{if(sql.includes('INSERT INTO public.audit_events'))throw Error('audit unavailable');return q.query<T>(sql,params);}}))};
    const denied=createAgentService(rejecting);const before=(await service.list()).agents.length;
    await expect(denied.create(actor,profileInput)).rejects.toThrow('audit unavailable');
    await expect(denied.updateProfile(actor,a.id,{expectedRevision:a.revision,name:'Changed',purpose:a.purpose,profileMarkdown:a.profileMarkdown+'\nChanged.'})).rejects.toThrow();
    await expect(denied.assign(actor,a.id,{expectedRevision:a.revision,provider:'claude',model:null})).rejects.toThrow();
    await expect(denied.status(actor,a.id,{expectedRevision:a.revision,enabled:false})).rejects.toThrow();
    await expect(denied.delete(actor,a.id,{expectedRevision:a.revision})).rejects.toThrow();
    await expect(denied.duplicate(actor,a.id,{expectedRevision:a.revision,name:'Denied copy'})).rejects.toThrow();
    expect((await service.list()).agents.length).toBe(before);expect((await service.list()).agents.find(item=>item.id===a.id)).toEqual(a);expect((await service.history(a.id))).toHaveLength(1);
    expect((await db.query('SELECT * FROM public.factory_agent_assignments WHERE agent_id=$1',[a.id])).rows).toHaveLength(1);
  });
});
describe('agent API access boundary and sanitized failures',()=>{
  function fixture(){const core=createCoreFixture();let queries=0;const db:Database={query:async()=>{queries++;throw Error('private database secret');},transaction:async()=>{queries++;throw Error('private database secret');},ping:async()=>false};const app=express().use('/api/auth',core.auth.router).use('/api/forge',buildWorkspaceRouter(core.auth,{db}));return {...core,app,agent:request.agent(app),queries:()=>queries};}
  it('requires current Core admin authorization and same-origin before touching profile storage',async()=>{
    const f=fixture();expect((await request(f.app).get('/api/forge/agents')).status).toBe(401);expect(f.queries()).toBe(0);
    await f.login(f.agent);f.state.role='viewer';expect((await f.agent.get('/api/forge/agents')).status).toBe(403);expect((await f.agent.post('/api/forge/agents').send(profileInput)).status).toBe(403);expect(f.queries()).toBe(0);
    f.state.role='admin';expect((await f.agent.post('/api/forge/agents').set('Origin','https://other.test').send(profileInput)).status).toBe(403);expect(f.queries()).toBe(0);
    f.state.revoked=true;expect((await f.agent.get('/api/forge/agents')).status).toBe(401);expect(f.queries()).toBe(0);
  });
  it('validates input before writes and sanitizes unavailable database errors',async()=>{
    const f=fixture();await f.login(f.agent);const invalid=await f.agent.post('/api/forge/agents').send({...profileInput,provider:'unapproved'});expect(invalid.status).toBe(400);expect(f.queries()).toBe(0);
    const unavailable=await f.agent.get('/api/forge/agents');expect(unavailable.status).toBe(503);expect(unavailable.body.error.code).toBe('AGENTS_UNAVAILABLE');expect(unavailable.text).not.toContain('private database secret');
    expect((await f.agent.get('/api/forge/agents/not.valid/history')).status).toBe(400);
  });
});
