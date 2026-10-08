'use strict';
// Copied with the public integration loader. These exercise the installed
// canonical backend in each app without production data or host commands.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json')));
const forge=pkg.name==='w3forge',compiled=path.join(root,'backend/dist',forge?'':'backend/src');
const admin=path.join(compiled,forge?'console':'admin');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'w3-console-contract-'));
process.env.NODE_ENV='test';process.env.W3_LOG_DIR=path.join(temp,'logs');
process.env.W3_DEPLOY_DIR=path.join(temp,'deploy');
fs.mkdirSync(process.env.W3_LOG_DIR,{recursive:true});
fs.mkdirSync(process.env.W3_DEPLOY_DIR,{recursive:true});
process.on('exit',()=>fs.rmSync(temp,{recursive:true,force:true}));
const {installation}=require(path.join(compiled,'adminConsoleAdapter'));
const loader=require('./admin-console.cjs');
test('the full installed frontend/backend manifest matches one immutable pin',()=>{
 const result=loader.verify(root);
 assert.equal(result.verified,true);assert.ok(result.files>100);
 const lock=JSON.parse(fs.readFileSync(path.join(root,'admin-console.lock.json')));
 assert.equal(lock.consumer,pkg.name);assert.match(lock.revision,/^[a-f0-9]{40}$/);
 assert.equal(lock.repository,'https://github.com/Hawkemw1996/w3-admin-console.git');
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'.w3-admin-console/manifest.json')));
 // Books' production test pipeline deliberately strips .git and all Git
 // credentials before invoking npm. Such snapshots have no tracked files;
 // exact source/manifest/receipt verification above still runs unchanged.
 const tracked=new Set(fs.existsSync(path.join(root,'.git'))?execFileSync('git',['-C',root,'ls-files','-z'],{encoding:'utf8'}).split('\0'):[]);
 for(const file of manifest.files)assert.ok(!tracked.has(lock.targets[file.group]+'/'+file.path),'common source must not be re-forked into this app: '+file.path);
});
test('the shared backend refuses mounting without all original security boundaries',()=>{
 const {buildSharedConsoleRouter}=require(path.join(admin,'sharedRouter'));
 for(const key of ['networkGuard','authorizeAdmin','sameOrigin']){
  const deps={networkGuard(){},authorizeAdmin(){},sameOrigin(){}};
  delete deps[key];assert.throws(()=>buildSharedConsoleRouter(deps),/requires network, app-admin and same-origin guards/);
 }
});
test('configuration exposes only nonsecret installation bindings',()=>{
 process.env.CORE_APP_CLIENT_SECRET='fixture-no-real-secret';
 process.env.DATABASE_PASSWORD='fixture-database-secret';
 const {publicConsoleConfiguration}=require(path.join(admin,'application'));
 const result=publicConsoleConfiguration();
 assert.equal(result.id,installation.id);assert.equal(result.adminPermission,installation.adminPermission);
 assert.equal(result.durableOperations,true);
 assert.deepEqual(Object.keys(result).sort(),['schema','id','name','basePath','repository','branch','timeZone','service','databaseName','adminPermission','permissionPrefix','terminalTarget','durableOperations','paths'].sort());
 assert.doesNotMatch(JSON.stringify(result),/fixture-no-real-secret|fixture-database-secret|gitKeyFile|envFile|sessionHash/);
 delete process.env.CORE_APP_CLIENT_SECRET;delete process.env.DATABASE_PASSWORD;
});
test('pipeline helpers receive only the dedicated source-key path and never app secret values',t=>{
 const keys=['CORE_APP_CLIENT_SECRET','DATABASE_PASSWORD','APP_SESSION_SECRET','ADMIN_CONSOLE_GIT_KEY_FILE'];
 const before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 t.after(()=>{for(const key of keys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}});
 Object.assign(process.env,{CORE_APP_CLIENT_SECRET:'private-core-fixture',DATABASE_PASSWORD:'private-database-fixture',
  APP_SESSION_SECRET:'private-session-fixture',ADMIN_CONSOLE_GIT_KEY_FILE:'/protected/console-read-key'});
 const {controlEnvironment}=require(path.join(admin,'controls/controlEnvironment'));
 const result=controlEnvironment();
 assert.equal(result.ADMIN_CONSOLE_GIT_KEY_FILE,'/protected/console-read-key');
 assert.doesNotMatch(JSON.stringify(result),/private-core-fixture|private-database-fixture|private-session-fixture/);
 for(const key of keys.slice(0,3))assert.equal(result[key],undefined);
});
test('legacy backup eligibility requires a complete own-app pair of regular nonempty files',async t=>{
 const prior={capabilities:installation.legacyBackupCapabilities,eligible:installation.eligibleBackupPair,pair:installation.backupPair};
 t.after(()=>{installation.legacyBackupCapabilities=prior.capabilities;installation.eligibleBackupPair=prior.eligible;installation.backupPair=prior.pair;});
 installation.legacyBackupCapabilities={verify:true,restoreTest:true,restore:true};
 installation.eligibleBackupPair=undefined;installation.backupPair=undefined;
 const {eligibleBackupPair}=require(path.join(admin,'backupAdapter')),dir=path.join(temp,'backups');
 fs.mkdirSync(dir);
 const app=installation.id+'_app_2026-10-07_00-00-00.tar.gz',db=installation.id+'_db_2026-10-07_00-00-00.sql';
 fs.writeFileSync(path.join(dir,app),'synthetic archive marker');fs.writeFileSync(path.join(dir,db),'synthetic SQL marker');
 assert.equal(await eligibleBackupPair(dir,app,db),true);
 assert.equal(await eligibleBackupPair(dir,'w3core_app_2026-10-07_00-00-00.tar.gz',db),false);
 assert.equal(await eligibleBackupPair(dir,app,db.replace('00-00-00','01-00-00')),false);
 assert.equal(await eligibleBackupPair(dir,'../'+app,db),false);
 fs.writeFileSync(path.join(dir,db),'');assert.equal(await eligibleBackupPair(dir,app,db),false);
 fs.unlinkSync(path.join(dir,db));fs.symlinkSync(path.join(dir,app),path.join(dir,db));
 assert.equal(await eligibleBackupPair(dir,app,db),false);
 installation.legacyBackupCapabilities=undefined;
 assert.equal(await eligibleBackupPair(dir,app,db),false);
});
test('detached deployment records require the exact request, unit, numeric exit and final timestamp',t=>{
 const before=installation.legacyDeploymentResults;
 const dir=path.join(temp,'legacy-results');fs.mkdirSync(dir);
 installation.legacyDeploymentResults=dir;
 t.after(()=>{installation.legacyDeploymentResults=before;});
 const {detachedResult}=require(path.join(admin,'controls/operationHistory'));
 const request='req_contract',file=path.join(dir,'deploy-'+request+'.trailer'),unit=installation.id+'-deploy-req-contract';
 const write=text=>fs.writeFileSync(file,text,{mode:0o600});
 write('status=running\nrequest_id='+request+'\nunit='+unit+'\nlaunched_at=2026-10-07T00:00:00Z\n');
 assert.equal(detachedResult(request).runStatus,'running');
 write('status=success\nrequest_id='+request+'\nunit='+unit+'\nexit_code=0\n');
 assert.equal(detachedResult(request).runStatus,'running','health-only or partial evidence cannot finish a worker');
 write('status=failed\nrequest_id='+request+'\nunit='+unit+'\nexit_code=7\nfinished_at=2026-10-07T00:01:00Z\n');
 assert.equal(detachedResult(request).runStatus,'failed');
 write('status=success\nrequest_id='+request+'\nunit='+unit+'\nexit_code=0\nfinished_at=2026-10-07T00:01:00Z\n');
 assert.equal(detachedResult(request).runStatus,'success');
 write('status=success\nrequest_id=foreign\nunit='+unit+'\nexit_code=0\nfinished_at=2026-10-07T00:01:00Z\n');
 assert.equal(detachedResult(request),null);
 write('status=success\nrequest_id='+request+'\nunit=w3core-deploy-req-contract\nexit_code=0\nfinished_at=2026-10-07T00:01:00Z\n');
 assert.equal(detachedResult(request),null);
});
test('the shared-source API rejects incomplete confirmation and reads no browser-selected path',async t=>{
 const express=require('express'),app=express();
 const {buildConsoleSourceRoutes}=require(path.join(admin,'routes/consoleSourceRoutes'));
 app.use(express.json(),buildConsoleSourceRoutes());
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base='http://127.0.0.1:'+server.address().port;
 for(const body of [
  {},{revision:'main',expected:'1'.repeat(40),confirmation:'UPDATE ADMIN CONSOLE'},
  {revision:'2'.repeat(40),expected:'1'.repeat(40),confirmation:'wrong'},
  {revision:'../../outside',expected:'1'.repeat(40),confirmation:'UPDATE ADMIN CONSOLE'}
 ]){
  const response=await fetch(base+'/console/source/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal(response.status,400);assert.equal((await response.json()).error.code,'INVALID_CONSOLE_UPDATE');
 }
});
test('staging another pin never relabels the running server as already updated',async t=>{
 const express=require('express'),app=express();
 const {repoRoot}=require(path.join(admin,'runtimeBridge'));
 const {buildConsoleSourceRoutes}=require(path.join(admin,'routes/consoleSourceRoutes'));
 const lockPath=path.join(repoRoot,'admin-console.lock.json');
 const originalRead=fs.readFileSync;
 const original=JSON.parse(originalRead(lockPath,'utf8'));
 app.use(buildConsoleSourceRoutes());
 const changed={...original,revision:'9'.repeat(40)};
 fs.writeFileSync(path.join(process.env.W3_DEPLOY_DIR,'admin-console.lock.json'),JSON.stringify(changed));
 fs.readFileSync=function(file,...args){
  if(String(file)===lockPath)return args[0]==='utf8'?JSON.stringify(changed):Buffer.from(JSON.stringify(changed));
  return originalRead.call(this,file,...args);
 };
 t.after(()=>{fs.readFileSync=originalRead;});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const response=await fetch('http://127.0.0.1:'+server.address().port+'/console/source');
 assert.equal(response.status,200);
 const data=(await response.json()).data;
 assert.equal(data.installed.revision,original.revision,'running source is captured at server mount');
 assert.equal(data.checkout.revision,changed.revision,'development checkout reports the newly staged pin');
});
test('retired pages cannot reappear from an old app-local source copy',()=>{
 for(const file of ['SettingsPage.tsx','ProductionReadinessPage.tsx'])assert.equal(fs.existsSync(path.join(root,'frontend/admin/src/pages',file)),false);
 const app=fs.readFileSync(path.join(root,'frontend/admin/src/App.tsx'),'utf8');
 assert.doesNotMatch(app,/<Route path="\/(?:settings|production-readiness)"/);
 assert.equal(installation.consumer,pkg.name);
});
test('every operational control names a real app-owned source script',()=>{
 const {ADMIN_CONTROLS}=require(path.join(admin,'controls/registry'));
 assert.equal(ADMIN_CONTROLS.length,30);
 for(const control of ADMIN_CONTROLS){
  const expected=(forge?'scripts/admin/':'scripts/')+control.scriptName;
  assert.equal(control.scriptSourcePath,expected,control.id);
  assert.equal(fs.lstatSync(path.join(root,expected)).isFile(),true,control.id);
 }
});
test('the package wrapper passes the supported archive CLI arguments without running a package',()=>{
 const script=path.join(root,forge?'scripts/admin':'scripts','pipeline-package-dev-release-'+pkg.name+'-ui.sh');
 const lines=fs.readFileSync(script,'utf8').split('\n');
 const command=lines.filter(line=>/^node .*admin-console\.cjs.* archive /.test(line));
 assert.equal(command.length,1,'package source must use the verified archive loader exactly once');
 const fixtureRoot=path.join(temp,'checkout with spaces'),output=path.join(temp,'fixture output.tar.gz');
 // Capture the actual wrapper argv using a shell function; no archive, Git
 // action, production package or host operation is invoked.
 const argv=execFileSync('bash',['-c','node(){ printf "%s\\0" "$@"; }\n'+command[0]],{
  env:{PATH:process.env.PATH,PP_DEPLOY_DIR:fixtureRoot,TMP_PATH:output},encoding:'utf8'
 }).split('\0').filter(Boolean);
 assert.deepEqual(argv,[path.join(fixtureRoot,'scripts/admin-console.cjs'),'archive','--root',fixtureRoot,'--prefix',pkg.name+'/','--output',output]);
 assert.equal(fs.existsSync(output),false);
});
