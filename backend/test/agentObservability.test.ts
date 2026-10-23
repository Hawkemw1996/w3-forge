import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {executionFixture,actor,TOKEN} from './executionFixture';
import {createAgentService} from '../src/agents/service';
import {DEFAULT_EXECUTION_SETTINGS} from '../src/agents/settings';
import {usage} from '../src/execution/metrics';
let f:Awaited<ReturnType<typeof executionFixture>>;
beforeAll(async()=>{f=await executionFixture();},30000);
beforeEach(async()=>{await f.reset();});afterAll(async()=>{await f.pg.close();});
describe('durable agent settings, usage and evidence',()=>{
 it('versions settings independently, rejects stale writes and freezes exact revisions',async()=>{
  const service=createAgentService(f.db);
  let a=(await service.list()).agents.find(a=>a.slug==='developer')!;
  const profile=a.profileChecksum,version=a.profileVersion;
  const first=a.executionRevision;
  a=await service.configure(actor,a.id,{expectedRevision:a.revision,executionSettings:{...a.executionSettings,contextMode:'compact'}});
  expect(a.executionRevision).toBe(first+1);expect(a.profileVersion).toBe(version);expect(a.profileChecksum).toBe(profile);
  await expect(service.configure(actor,a.id,{expectedRevision:a.revision-1,executionSettings:{}})).rejects.toMatchObject({status:409});
  const job=await f.start();
  a=await service.configure(actor,a.id,{expectedRevision:a.revision,executionSettings:{...a.executionSettings,contextMode:'summary'}});
  expect((await f.store.get(job.id)).context.profiles.find(p=>p.id===a.id)).toMatchObject({executionRevision:first+1,executionSettings:{contextMode:'compact'}});
  expect((await f.db.query('SELECT * FROM public.factory_agent_execution_settings WHERE agent_id=$1',[a.id])).rows.length).toBe(first+2);
  await expect(f.db.query("UPDATE public.factory_agent_execution_settings SET config='{}' WHERE agent_id=$1",[a.id])).rejects.toThrow();
  await expect(f.db.query('DELETE FROM public.factory_agent_execution_settings WHERE agent_id=$1',[a.id])).rejects.toThrow();
  const copy=await service.duplicate(actor,a.id,{expectedRevision:a.revision,name:'Configured duplicate'});
  expect(copy.executionSettings).toEqual(a.executionSettings);expect(copy.executionRevision).toBeGreaterThanOrEqual(1);
 });
 it('retains original records, redacts only the display, reports sources and configured cost',async()=>{
  const j=await f.start();const job=(await f.store.claim(TOKEN))!;
  const profile={...job.context.profiles[0],model:'qwen-fixture',executionSettings:{...DEFAULT_EXECUTION_SETTINGS,pricing:{provider:'ollama' as const,model:'qwen-fixture',inputUsdPerMillion:2,outputUsdPerMillion:4}}};
  const id=await f.store.beginCall(j.id,TOKEN,profile,'original input','sent context',0);
  await f.store.finishCall(j.id,TOKEN,id,{text:'answer',rawOutput:'WARNING useful\npassword=abc123\n<script>text</script>',resolvedModel:'qwen-fixture',usage:usage(100,50)},'succeeded');
  const snapshot=await f.store.metrics.snapshot({projectId:j.projectId});
  const found=snapshot.history.find(r=>r.id===id)!;
  expect(found).toMatchObject({status:'succeeded',inputTokens:100,outputTokens:50,totalTokens:150,inputSource:'provider',outputSource:'provider',estimatedCostUsd:0.0004});
  expect(found.profileVersion).toBe(profile.profileVersion);expect(found.profileChecksum).toBe(profile.profileChecksum);
  const record=await f.store.metrics.record(found.outputRecordId!);
  expect(record.content).toContain('WARNING useful');expect(record.content).not.toContain('abc123');expect(record.redacted).toBe(true);
  expect((await f.db.query<{content:string}>('SELECT content FROM public.factory_execution_records WHERE id=$1',[record.id])).rows[0].content).toContain('abc123');
  await expect(f.db.query("UPDATE public.factory_execution_records SET content='changed' WHERE id=$1",[record.id])).rejects.toThrow();
  await expect(f.db.query("UPDATE public.factory_agent_executions SET output_tokens=0 WHERE id=$1",[id])).rejects.toThrow();
  expect((await f.store.metrics.records(j.id))).toHaveLength(3);
 });
 it('does not invent usage or costs when an attempt fails, and rejects a second completion',async()=>{
  const j=await f.start(),job=(await f.store.claim(TOKEN))!,p=job.context.profiles[0];
  const id=await f.store.beginCall(j.id,TOKEN,p,'input','input',1);
  await f.store.finishCall(j.id,TOKEN,id,{},'timed_out','PROVIDER_TIMEOUT');
  const row=(await f.store.metrics.snapshot({projectId:j.projectId})).history[0];
  expect(row).toMatchObject({status:'timed_out',outputTokens:null,totalTokens:null,outputSource:'unavailable',estimatedCostUsd:null,retryCount:1});
  expect(row.inputSource).toBe('estimated');expect(row.completedAt).not.toBeNull();
  await expect(f.store.finishCall(j.id,TOKEN,id,{text:'late'},'succeeded')).rejects.toMatchObject({code:'OBSERVATION_CLOSED'});
 });
 it('keeps cache-sensitive costs unavailable and zero provider tokens as zero',async()=>{
  const j=await f.start(),job=(await f.store.claim(TOKEN))!,p={...job.context.profiles[0],model:'qwen-fixture',executionSettings:{...DEFAULT_EXECUTION_SETTINGS,pricing:{provider:'ollama' as const,model:'qwen-fixture',inputUsdPerMillion:2,outputUsdPerMillion:4}}};
  const id=await f.store.beginCall(j.id,TOKEN,p,'input','input',0);
  await f.store.finishCall(j.id,TOKEN,id,{text:'',usage:{...usage(0,0),cachedInputTokens:2}},'succeeded');
  const r=(await f.store.metrics.snapshot({projectId:j.projectId})).history[0];
  expect(r).toMatchObject({inputTokens:0,outputTokens:0,totalTokens:0,estimatedCostUsd:null});
 });
 it('reconciles running provider observations after a stale worker',async()=>{
  const j=await f.start(),job=(await f.store.claim(TOKEN))!;
  const id=await f.store.beginCall(j.id,TOKEN,job.context.profiles[0],'input','input',0);
  await f.db.query("UPDATE public.factory_execution_slot SET heartbeat_at=now()-interval '120 seconds' WHERE singleton=true");
  await f.store.recoverStale(new Date(Date.now()-60000).toISOString());
  const r=(await f.store.metrics.snapshot({projectId:j.projectId})).history[0];
  expect(r).toMatchObject({id,status:'interrupted',errorCode:'WORKER_INTERRUPTED',outputTokens:null});
  await expect(f.store.finishCall(j.id,TOKEN,id,{text:'stale'},'succeeded')).rejects.toMatchObject({code:'EXECUTION_LEASE_LOST'});
 });
 it('aggregates the whole filtered selection separately from the page and validates boundaries',async()=>{
  const j=await f.start(),job=(await f.store.claim(TOKEN))!;
  for(const p of job.context.profiles.slice(0,2)){
   const id=await f.store.beginCall(j.id,TOKEN,p,'x','x',0);await f.store.finishCall(j.id,TOKEN,id,{text:'done'},'succeeded');
  }
  const all=await f.store.metrics.snapshot({projectId:j.projectId,limit:1});
  expect(all.history).toHaveLength(1);expect(all.totals.executions).toBe(2);expect(all.totals.estimated).toBe(2);
  const one=await f.store.metrics.snapshot({projectId:j.projectId,agentId:job.context.profiles[0].id});
  expect(one.history).toHaveLength(1);expect(one.byProject[0].project_id).toBe(j.projectId);
  expect((await f.store.metrics.snapshot({projectId:j.projectId,provider:job.context.profiles[0].provider})).totals.executions).toBe(1);
  expect((await f.store.metrics.snapshot({projectId:j.projectId,from:'2099-01-01T00:00:00Z'})).totals).toMatchObject({executions:0,total_tokens:null,estimated_cost_usd:null});
  for(const bad of [{from:'bad'},{from:'2026-10-23T00:00:00Z',to:'2026-10-20T00:00:00Z'},{limit:1000},{provider:'unapproved'},{projectId:"x' OR 1=1"},{extra:'bad'}])await expect(f.store.metrics.snapshot(bad)).rejects.toMatchObject({code:'INVALID_METRICS_FILTER'});
 });
 it('supports the previous application writer without changing its profile data',async()=>{
  const id='legacy-writer-agent';
  await f.db.transaction(async q=>{
   await q.query('INSERT INTO public.factory_agents(id,slug,created_by) VALUES($1,$1,$2)',[id,actor.coreUserId]);
   await q.query('INSERT INTO public.factory_agent_profiles(agent_id,revision,version,name,purpose,content,checksum,created_by) VALUES($1,1,$2,$3,$4,$5,$6,$7)',[id,'0.1.0','Legacy writer','Compatibility fixture','# Legacy profile','f'.repeat(64),actor.coreUserId]);
   await q.query('INSERT INTO public.factory_agent_assignments(agent_id,revision,provider,model,created_by) VALUES($1,1,$2,NULL,$3)',[id,'codex',actor.coreUserId]);
  });
  const agent=(await createAgentService(f.db).list()).agents.find(a=>a.id===id)!;
  expect(agent.profileMarkdown).toBe('# Legacy profile');expect(agent.executionSettings).toEqual(DEFAULT_EXECUTION_SETTINGS);expect(agent.executionRevision).toBe(1);
 });
 it('does not record observations without an owned active lease',async()=>{
  const j=await f.start();
  await expect(f.store.beginCall(j.id,TOKEN,j.context.profiles[0],'x','x',0)).rejects.toMatchObject({code:'EXECUTION_LEASE_LOST'});
 });
});
