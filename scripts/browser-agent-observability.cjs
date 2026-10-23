'use strict';
// Optional browser tooling is provided by the caller; it is not an app dependency.
const {chromium}=require(process.argv[2]||'playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),dist=path.join(root,'frontend/admin/dist'),output=path.join(root,'cache/observability-browser');
fs.mkdirSync(output,{recursive:true});
const timestamp='2026-10-22T12:00:00Z';
const settings={contextMode:'structured',contextBudget:30000,timeoutMs:600000,maxRetries:0,maxContextRequests:4,allowedTools:['read_files'],pricing:null};
const ids=['orchestrator','specification-writer','developer','code-reviewer','security-reviewer','ui-reviewer','ux-reviewer'];
const agents=ids.map(slug=>{
 const raw=fs.readFileSync(path.join(root,'config/agents',slug+'.md'),'utf8').replace(/\r/g,'');
 const [,front,body]=raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
 const fields=Object.fromEntries(front.trim().split('\n').map(l=>{const i=l.indexOf(':');return[l.slice(0,i),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')];}));
 return{id:slug,slug,name:fields.name,purpose:fields.purpose,enabled:true,revision:1,profileVersion:'0.1.0',profileMarkdown:body.trim(),profileChecksum:'a'.repeat(64),provider:slug==='orchestrator'?'ollama':'codex',model:slug==='orchestrator'?'qwen-fixture':'codex-fixture',executionSettings:{...settings},executionRevision:1,createdAt:timestamp,updatedAt:timestamp};
});
const project={id:'project-fixture',name:'W3 Forge',appId:'w3forge',repositoryUrl:'https://github.com/example/fixture',branch:'dev/v0.4.8',rulesVersion:1,rulesTitle:'Rules',rulesMarkdown:'# Rules',rulesChecksum:'b'.repeat(64),createdAt:timestamp,updatedAt:timestamp,description:''};
const totals={executions:2,succeeded:1,failed:1,running:0,cancelled:0,input_tokens:140,output_tokens:50,total_tokens:150,provider_reported:1,estimated:1,unavailable_usage:1,average_duration_ms:1250,estimated_cost_usd:0.002,unavailable_cost:1,original_context_tokens:600,processed_context_tokens:400};
const baseRow={jobId:'job-fixture',taskId:'task-fixture',projectId:project.id,projectName:project.name,profileVersion:'0.1.0',profileChecksum:'a'.repeat(64),profileRevision:1,assignmentRevision:1,executionRevision:1,requestedModel:'codex-fixture',resolvedModel:null,contextMode:'compact',retryCount:0,startedAt:timestamp,completedAt:timestamp,durationMs:1000,inputTokens:100,outputTokens:50,totalTokens:150,inputSource:'provider',outputSource:'provider',estimatedCostUsd:0.002,inputRecordId:'original-record',contextRecordId:'context-record',outputRecordId:'output-record',errorCode:null};
const rows=[{...baseRow,id:'execution-1',agentId:'developer',agentName:'Developer',provider:'codex',status:'succeeded'},{...baseRow,id:'execution-2',agentId:'code-reviewer',agentName:'Code Reviewer',provider:'claude',status:'timed_out',inputTokens:40,outputTokens:null,totalTokens:null,inputSource:'estimated',outputSource:'unavailable',estimatedCostUsd:null,errorCode:'PROVIDER_TIMEOUT',outputRecordId:null,retryCount:1}];
const responses={
 '/api/auth/status':{authenticated:true,coreConfigured:true,identityProvider:'core',loginAvailable:true,user:{coreUserId:'fixture',username:'fixture',displayName:'Fixture owner',coreRole:'admin',permissions:['forge:admin']}},
 '/api/admin/version':{version:require('../package.json').version,nodeEnv:'development'},
 '/api/forge/factory':{projects:[project],requests:[],runs:[],notifications:[],metrics:{queued:0,active:0,testing:0,ready:0,blocked:0},observedAt:timestamp},
 '/api/forge/environments':{host:'fixture',available:true,environments:[],observedAt:timestamp,pipeline:null,activeControl:null},
 '/api/forge/models':{models:[{name:'qwen-fixture'}],defaultModel:'qwen-fixture'},
 '/api/forge/hardware':{host:'fixture',scope:'forge-host',observedAt:timestamp,os:{platform:'linux',architecture:'x64',release:'fixture',uptimeSeconds:1},cpu:{model:'Fixture',logicalCores:4,clockMHz:null,loadAverage:[]},memory:{totalBytes:1024,availableBytes:512},storage:{available:false,message:'Unavailable',devices:[],root:null},gpu:{available:false,message:'Unavailable',devices:[]}},
 '/api/forge/services':{observedAt:timestamp,services:[]}
};
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');const rel=url.pathname.startsWith('/admin/assets/')?url.pathname.slice('/admin/'.length):'index.html';
 const target=path.resolve(dist,rel);if(!target.startsWith(dist+path.sep))return res.writeHead(403).end();
 try{res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html'})[path.extname(target)]||'text/plain');res.end(fs.readFileSync(target));}catch{res.writeHead(404).end();}
});
let browser,page,unavailable=false;const mutations=[],errors=[],requests=[];
const clone=v=>JSON.parse(JSON.stringify(v));
const waitFor=async(fn,label)=>{for(let n=0;n<150;n++){if(await fn())return;await new Promise(r=>setTimeout(r,30));}throw Error('Timed out: '+label);};
const noOverflow=async(page,label)=>{const d=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth}));assert(d.width<=d.viewport+1,label+JSON.stringify(d));};
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,...(process.argv[3]?{executablePath:process.argv[3]}:{})});
 page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),p=url.pathname;requests.push(url.pathname+url.search);let data;
  if(p==='/api/forge/agents'&&req.method()==='GET')data={agents,observedAt:timestamp};
  else if(p==='/api/forge/execution/metrics'){
   if(unavailable)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({success:false,error:{code:'METRICS_UNAVAILABLE',message:'Metrics temporarily unavailable.'}})});
   const selected=rows.filter(r=>['projectId','agentId','provider'].every(k=>!url.searchParams.get(k)||url.searchParams.get(k)===r[k]));
   const t=selected.length===2?totals:{...totals,executions:selected.length,succeeded:selected.filter(r=>r.status==='succeeded').length,failed:selected.filter(r=>r.status!=='succeeded').length,total_tokens:selected.length?selected[0].totalTokens:null};
   data={totals:t,byProvider:selected.map(r=>({...t,provider:r.provider})),byProject:selected.length?[{...t,project_id:project.id,project_name:project.name}]:[],history:selected,limit:20,offset:0,observedAt:timestamp};
  }else if(p.startsWith('/api/forge/execution/records/'))data={id:p.split('/').pop(),jobId:'job-fixture',kind:'model_output',content:'WARNING: useful diagnostic\n<script>window.injected=true</script>\npassword=[redacted]\nComplete output retained.',originalChecksum:'d'.repeat(64),redacted:true};
  else if(/^\/api\/forge\/agents\/[^/]+\/(execution|assignment|profile)$/.test(p)){
   const [, , , ,id,action]=p.split('/'),agent=agents.find(a=>a.id===id),body=req.postDataJSON();
   assert(agent);mutations.push({action,body:clone(body)});
   if(agent.revision!==body.expectedRevision)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({success:false,error:{code:'AGENT_CONFLICT',message:'This agent changed. Refresh before saving.'}})});
   if(action==='execution'){agent.executionSettings=body.executionSettings;agent.executionRevision++;}
   else if(action==='assignment'){agent.provider=body.provider;agent.model=body.model;}
   else{agent.profileMarkdown=body.profileMarkdown;agent.profileVersion='0.1.1';agent.name=body.name;agent.purpose=body.purpose;}
   agent.revision++;data=agent;
  }else if(responses[p])data=responses[p];else throw Error('Unexpected API '+req.method()+' '+p);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,data:clone(data)})});
 });
 const origin='http://127.0.0.1:'+server.address().port;
 await page.goto(origin+'/forge/agents');await page.getByRole('heading',{name:'Agents',exact:true}).waitFor();
 await page.getByRole('heading',{name:'Agent execution metrics',exact:true}).waitFor();await page.getByText(/PROVIDER_TIMEOUT/).waitFor();
 await noOverflow(page,'Desktop metrics');
 const developer=agents.find(a=>a.slug==='developer'),original=developer.profileMarkdown;
 await page.getByRole('button',{name:/^Developer v/}).click();
 await page.getByLabel('Context mode',{exact:true}).selectOption('compact');
 await page.getByLabel('Context budget (estimated tokens)',{exact:true}).fill('12000');
 await page.getByLabel('Provider retries',{exact:true}).fill('1');
 await page.getByRole('button',{name:'Save execution settings',exact:true}).click();
 await waitFor(()=>developer.executionRevision===2,'settings saved');
 assert.equal(developer.profileVersion,'0.1.0');assert.equal(developer.profileMarkdown,original);
 await page.getByLabel('AI provider',{exact:true}).selectOption('claude');await page.getByLabel('Model ID',{exact:true}).fill('claude-fixture');
 await page.getByRole('button',{name:'Save model assignment',exact:true}).click();
 await waitFor(()=>developer.provider==='claude','provider reassigned');assert.equal(developer.profileVersion,'0.1.0');assert.equal(developer.executionSettings.contextMode,'compact');
 await page.getByLabel('Context mode',{exact:true}).selectOption('summary');developer.revision++;
 await page.getByRole('button',{name:'Save execution settings',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'This agent changed'}).waitFor();
 await page.getByRole('button',{name:'Reload saved profile',exact:true}).click();
 await waitFor(async()=>await page.getByLabel('Context mode',{exact:true}).inputValue()==='compact','settings conflict reload');
 await page.getByRole('button',{name:'Close profile',exact:true}).click();
 await page.getByRole('region',{name:'Agent execution metrics'}).getByLabel('Provider',{exact:true}).selectOption('codex');
 await waitFor(()=>requests.some(r=>r.includes('metrics?')&&r.includes('provider=codex')),'provider filter request');
 await page.getByText(/PROVIDER_TIMEOUT/).waitFor({state:'hidden'});
 await page.getByText('Execution details',{exact:true}).first().click();
 await page.getByRole('button',{name:'Complete output',exact:true}).click();
 await page.getByRole('button',{name:'Download complete record',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>Boolean(window.injected)),false);
 const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Download complete record',exact:true}).click();
 const downloaded=await downloadPromise;assert(fs.readFileSync(await downloaded.path(),'utf8').includes('WARNING: useful diagnostic'));
 await page.getByRole('button',{name:'Close record',exact:true}).click();
 await page.screenshot({path:path.join(output,'desktop-metrics.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.getByRole('dialog',{name:'W3 Forge navigation',exact:true}).waitFor();await page.keyboard.press('Escape');
 await noOverflow(page,'Mobile metrics');await page.screenshot({path:path.join(output,'mobile-metrics.png'),fullPage:true});
 await page.getByRole('button',{name:/^Developer v/}).click();await page.getByLabel('Context mode',{exact:true}).waitFor();await noOverflow(page,'Mobile settings');
 await page.screenshot({path:path.join(output,'mobile-settings.png'),fullPage:true});await page.getByRole('button',{name:'Close profile',exact:true}).click();
 unavailable=true;await page.getByRole('button',{name:'Refresh metrics',exact:true}).click();await page.getByText('Metrics temporarily unavailable.',{exact:true}).waitFor();
 assert.equal(await page.getByText('Known total tokens',{exact:true}).count(),0);
 unavailable=false;await page.getByRole('button',{name:'Refresh metrics',exact:true}).click();await page.getByText('Known total tokens',{exact:true}).waitFor();
 await page.getByRole('region',{name:'Agent execution metrics'}).getByLabel('Provider',{exact:true}).selectOption('ollama');await page.getByText('No agent executions match these filters. Earlier releases have no backfilled provider metrics.',{exact:true}).waitFor();
 await page.setViewportSize({width:1440,height:1000});await page.goto(origin+'/forge/');await page.getByRole('heading',{name:'Agent execution metrics',exact:true}).waitFor();await noOverflow(page,'Dashboard');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,viewports:['1440x1000','390x844'],checks:['settings save','profile and assignment separation','stale-settings recovery','provider filter','usage unavailable labels','original output and download','escaped output','mobile overflow','navigation drawer','failed refresh hides stale metrics','empty state','dashboard integration'],mutations:mutations.length,screenshots:['desktop-metrics.png','mobile-metrics.png','mobile-settings.png']},null,2));
})().catch(async e=>{console.error(e.stack);if(page){await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});console.error((await page.locator('body').innerText()).slice(-10000));}process.exitCode=1;}).finally(async()=>{await browser?.close();await new Promise(r=>server.close(r));});
