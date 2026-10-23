import {beforeAll,beforeEach,afterAll,afterEach,describe,it,expect} from 'vitest';
import {executionFixture,actor,BASE} from './executionFixture';
import {ExecutionEngine,type RuntimePort,type BrokerPort} from '../src/execution/engine';
import {ExecutionFailure} from '../src/execution/providers';
import {createAgentService} from '../src/agents/service';
let f:Awaited<ReturnType<typeof executionFixture>>,engines:ExecutionEngine[]=[];
beforeAll(async()=>{f=await executionFixture();},30000);beforeEach(async()=>{await f.reset();});afterEach(async()=>{for(const e of engines.splice(0))await e.stop();});afterAll(async()=>{await f.pg.close();});
async function settings(patch:object){const s=createAgentService(f.db),a=(await s.list()).agents.find(a=>a.slug==='orchestrator')!;await s.configure(actor,a.id,{expectedRevision:a.revision,executionSettings:{...a.executionSettings,contextBudget:30000,maxRetries:0,timeoutMs:600000,allowedTools:['read_files'],...patch}});}
function setup(invoke:BrokerPort['invoke']){
 const runtime:RuntimePort={prepare:async()=>({baseCommit:BASE,files:['AGENTS.md']}),read:async()=>[],apply:async()=>{throw Error('no unapproved edits');},test:async()=>{throw Error('no unapproved tests');},recover:async()=>true,dispose:async()=>{}};
 const e=new ExecutionEngine(f.store,runtime,{invoke,recover:async()=>true});engines.push(e);return e;
}
async function until(id:string,status:string){for(let i=0;i<800;i++){const j=await f.store.get(id);if(j.status===status)return j;await new Promise(r=>setTimeout(r,10));}throw Error('Execution remained '+(await f.store.get(id)).status);}
const answer=(p:any,v:unknown)=>({text:JSON.stringify(v),provider:p.provider,requestedModel:p.model,resolvedModel:null});
describe('observed bounded execution',()=>{
 it('honors a real call deadline, safely retries once and keeps both observations',async()=>{
  await settings({timeoutMs:1000,maxRetries:1});let calls=0;
  const e=setup(async(_id,p,_prompt,signal)=>{
   if(p.slug==='orchestrator'&&++calls===1)return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new ExecutionFailure('PROVIDER_TIMEOUT','timed out','partial response')),{once:true}));
   return answer(p,p.slug==='orchestrator'?{summary:'Plan',instructions:'Bounded spec'}:{specification:'# Approved scope\nVerify behavior'});
  });
  const j=await f.start();await e.tick();await until(j.id,'awaiting_approval');
  const rows=(await f.store.metrics.snapshot({projectId:j.projectId})).history;
  expect(rows).toHaveLength(3);expect(rows.filter(r=>r.status==='timed_out')).toHaveLength(1);expect(rows.filter(r=>r.status==='succeeded')).toHaveLength(2);expect(rows.find(r=>r.retryCount===1)?.status).toBe('succeeded');
  expect((await f.store.get(j.id)).status).toBe('awaiting_approval');
  const timedOut=rows.find(r=>r.status==='timed_out')!;expect(timedOut.outputRecordId).not.toBeNull();expect((await f.store.metrics.record(timedOut.outputRecordId!)).content).toContain('partial response');
 },15000);
 it('enforces the configured file-tool restriction regardless of model prose',async()=>{
  await settings({allowedTools:[]});const e=setup(async(_id,p)=>answer(p,{readFiles:['README.md']}));const j=await f.start();await e.tick();expect((await until(j.id,'blocked')).errorCode).toBe('TOOL_NOT_ALLOWED');
 });
 it('retains an over-budget original context without launching a provider',async()=>{
  await settings({contextBudget:1000});let calls=0;const e=setup(async()=>{calls++;throw Error('not launched');});const j=await f.start();await e.tick();
  expect((await until(j.id,'blocked')).errorCode).toBe('CONTEXT_BUDGET_EXCEEDED');expect(calls).toBe(0);
  expect((await f.store.metrics.records(j.id)).length).toBe(1);expect((await f.store.events(j.id)).some(e=>e.kind==='context_blocked')).toBe(true);
 });
});
