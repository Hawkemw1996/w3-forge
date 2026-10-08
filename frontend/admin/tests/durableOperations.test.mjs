// Current installations use request-bound durable evidence, not health-only success.
import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildHarness} from './helpers/buildHarness.mjs';
import {installMiniDom,fire,textOf,queryAll} from './helpers/miniDom.mjs';
const dom=installMiniDom(),React=(await import('react')).default,{createRoot}=await import('react-dom/client');
const {act}=React;
let harness,root;
before(async()=>{harness=await buildHarness('pipelineOverridesHarness',{appRoot:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')});});
const originalFetch=globalThis.fetch,originalTimeout=window.setTimeout;
const settle=()=>new Promise(resolve=>setTimeout(resolve,25));
const json=data=>({ok:true,status:200,json:async()=>({success:true,data})});
const control={id:'pipeline-deploy-dev',label:'Deploy Dev Package',description:'Fixture',
 enabled:true,status:'UI_READY',effectiveStatus:'UI_READY',riskLevel:'HIGH',runStrategy:'safe-pipeline',
 restartsService:true,readOnly:false,requiresInputs:false,requiresConfirmation:false,timeoutSeconds:1800,
 interactivePromptsToday:[],allowedRoles:['admin'],notes:''};
const runButton=()=>queryAll(dom.root,'button').find(button=>textOf(button).trim()==='Run');
async function mount(options={}) {
 const state={posts:0,successes:[],probes:[],status:'running',active:false,...options};
 window.setTimeout=(fn,ms)=>originalTimeout(fn,ms===2000?10:ms);
 globalThis.fetch=async(url,init={})=>{
  if(init.method==='POST'){
   state.posts++;state.requestId=JSON.parse(init.body).requestId;
   assert.match(state.requestId,/^req_[a-f0-9]{32}$/);
   if(state.disconnect)throw new TypeError('Failed to fetch');
   return json({controlId:control.id,accepted:true,runStatus:'running',requestId:state.requestId,reason:'Worker launched.'});
  }
  state.probes.push(url);
  if(url==='/api/admin/controls/lock')return json({active:state.active?{controlId:control.id,requestId:state.requestId,startedAt:new Date().toISOString()}:null});
  if(url==='/version')return json({version:'0.0.1'});
  if(url==='/health')return json({status:'ok'});
  if(url.startsWith('/api/admin/packages/installed/'))return json({version:'0.0.1',requestId:'old',deployedAt:new Date().toISOString(),packagePath:'/fixture/installed/app.tar.gz'});
  if(url.startsWith('/api/admin/controls/runs/')){
   assert.equal(decodeURIComponent(url.split('/').pop()),state.requestId);
   if(state.missing)return {ok:false,status:404,json:async()=>({success:false,error:{code:'NOT_FOUND',message:'Not recorded yet.'}})};
   return json({controlId:state.otherControl?'backup-create':control.id,accepted:true,requestId:state.wrongRequest?'req_foreign':state.requestId,
    runStatus:state.status,exitCode:state.status==='success'?0:state.status==='failed'?7:undefined,
    reason:state.status==='failed'?'Worker failed.':'Durable evidence.'});
  }
  throw new Error('Unexpected request '+url);
 };
 root=createRoot(dom.root);
 await act(async()=>{root.render(React.createElement(harness.ControlCard,{control,extraInputs:{version:'v0.0.1'},onRunSuccess:result=>state.successes.push(result)}));await settle();});
 if(!state.active)await act(async()=>{fire(runButton(),'click');await settle();});
 return state;
}
async function poll(){await act(settle);}
afterEach(async()=>{
 if(root)await act(async()=>root.unmount());root=undefined;
 globalThis.fetch=originalFetch;window.setTimeout=originalTimeout;
});
after(()=>dom.uninstall());
test('launch acknowledgment remains pending, disables duplicate submission, and final success completes once',async()=>{
 const state=await mount();assert.match(textOf(dom.root),/Operation running/);assert.equal(state.successes.length,0);assert.equal(runButton().disabled,true);
 await act(async()=>{fire(runButton(),'click');await settle();});assert.equal(state.posts,1);
 state.status='success';await poll();await poll();assert.equal(state.successes.length,1);assert.equal(state.successes[0].requestId,state.requestId);
});
test('final worker failure is shown and never completes the release step',async()=>{
 const state=await mount();state.status='failed';await poll();
 assert.match(textOf(dom.root),/Worker failed/);assert.match(textOf(dom.root),/Failed/);assert.equal(state.successes.length,0);
});
test('a lost HTTP reply never infers completion from a healthy service or installed archive',async()=>{
 const state=await mount({disconnect:true,missing:true});await poll();
 assert.match(textOf(dom.root),/Awaiting operation confirmation/);assert.equal(state.successes.length,0);assert.equal(state.posts,1);
 state.missing=false;state.status='success';await poll();assert.equal(state.successes.length,1);assert.equal(state.posts,1);
});
for(const patch of [{wrongRequest:true},{otherControl:true}])test('foreign operation evidence cannot complete this request '+JSON.stringify(patch),async()=>{
 const state=await mount({...patch,status:'success'});await poll();
 assert.equal(state.successes.length,0);assert.equal(runButton().disabled,true);
 state.wrongRequest=false;state.otherControl=false;await poll();assert.equal(state.successes.length,1);
});
test('reload resumes the active worker without submitting another command',async()=>{
 const state=await mount({active:true,requestId:'req_resumed'});assert.match(textOf(dom.root),/Operation running/);assert.equal(state.posts,0);
 state.status='success';await poll();assert.equal(state.successes.length,1);assert.equal(state.posts,0);
});
test('unmount stops durable polling and cannot complete a removed card',async()=>{
 const state=await mount();await act(async()=>root.unmount());root=undefined;
 const count=state.probes.length;state.status='success';await poll();assert.equal(state.probes.length,count);assert.equal(state.successes.length,0);
});
