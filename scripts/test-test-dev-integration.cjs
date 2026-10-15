'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync,execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),pkg=require(path.join(root,'package.json')),consumer=pkg.name;
const scripts=path.join(root,consumer==='w3forge'?'scripts/admin':'scripts');
const host=require(path.join(scripts,'test-dev-host.cjs'));
const bash=process.env.W3_TEST_BASH||(process.platform==='win32'?path.resolve(path.dirname(process.execPath),'../../native/git/usr/bin/sh.exe'):'/bin/bash');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),consumer+'-test-contract-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('test supervisor receives only this app identity and rejects missing host isolation',t=>{
 const dir=fixture(t),env={W3_TEST_BUILD_USER:'testbuild',W3_TEST_PRODUCTION_USER:'production',W3_TEST_INSTALLATION_ID:'fixture',W3_TEST_OWNER_PID:String(process.pid)};
 for(const [key,name]of [['W3_DEPLOY_DIR','source'],['W3_TEST_SNAPSHOT_ROOT','snapshots'],['W3_TEST_CACHE_ROOT','cache'],['W3_DATA_DIR','data']]){const item=path.join(dir,name);fs.mkdirSync(item);env[key]=fs.realpathSync(item);}
 for(const [key,name]of [['W3_ENV_FILE','env'],['W3_TEST_NPM_CLI','npm.cjs']]){const item=path.join(dir,name);fs.writeFileSync(item,'');env[key]=fs.realpathSync(item);}
 assert.equal(host.configuration(consumer,'req_fixture',env).consumer,consumer);
 assert.throws(()=>host.configuration(consumer,'req_fixture',{...env,W3_TEST_BUILD_USER:'production'}));
 assert.throws(()=>host.configuration(consumer,'req_fixture',{...env,W3_TEST_CACHE_ROOT:env.W3_DEPLOY_DIR}));
 assert.throws(()=>host.configuration('w3core','req_fixture',env));
});
test('unconfigured host fails with correlated failure before any development execution',()=>{
 const result=spawnSync(process.execPath,[path.join(scripts,'test-dev-host.cjs'),consumer,'req_fixture'],{env:{},encoding:'utf8',windowsHide:true});
 assert.equal(result.status,1,result.error?.message);assert.match(result.stdout,/status=failed/);assert.match(result.stdout,/request_id=req_fixture/);assert.doesNotMatch(result.stdout,/status=success/);
});
test('the actual wrapper still refuses main before invoking the host supervisor',t=>{
 const dir=fixture(t),checkout=path.join(dir,'checkout');fs.mkdirSync(checkout);
 const git=(args)=>execFileSync('git',['-C',checkout,...args],{encoding:'utf8',env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'},stdio:['ignore','pipe','pipe']});
 git(['init','--quiet','--initial-branch=main']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','--allow-empty','-m','fixture']);
 const repository=consumer==='w3forge'?'w3-forge':consumer;git(['remote','add','origin','https://github.com/Hawkemw1996/'+repository+'.git']);
 const unix=value=>value.replaceAll('\\','/');
 const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,HOME:unix(dir),LANG:'C.UTF-8',W3_DEPLOY_DIR:unix(checkout),W3_APP_DIR:unix(path.join(dir,'runtime')),W3_DATA_DIR:unix(path.join(dir,'data')),W3_SCRIPT_DIR:unix(scripts),W3_SCRIPTS_DIR:unix(scripts),W3_LOG_DIR:unix(path.join(dir,'logs')),W3_LOG_ROOT:unix(path.join(dir,'logs')),W3LOG_ROOT:unix(path.join(dir,'logs')),W3_UPDATE_DIR:unix(path.join(dir,'packages')),W3_BACKUP_DIR:unix(path.join(dir,'backups')),W3_BACKUPS_DIR:unix(path.join(dir,'backups')),W3_FORGE_ROOT:unix(root),W3_ENV_FILE:unix(path.join(dir,'env'))};
 if(consumer==='w3forge'){
  const configs=path.join(dir,'config');fs.mkdirSync(configs);fs.writeFileSync(path.join(configs,'w3forge.yml'),JSON.stringify({app_id:'w3forge',repo:{url:'https://github.com/Hawkemw1996/w3-forge.git'},controls:{allow_legacy_w3forge_controls:true},github_workflow:{allow_release_pipeline:true},service:{name:'w3forge.service',port:8765}}));env.W3_APP_CONFIG_DIR=unix(configs);
 }
 const result=spawnSync(bash,[unix(path.join(scripts,'pipeline-test-dev-branch-'+consumer+'-ui.sh')),'--yes','--source','ui','--request-id','req_fixture'],{env,encoding:'utf8',windowsHide:true,timeout:10000});
 assert.equal(result.status,1,result.stderr||result.error?.message);assert.match(result.stdout,/status=blocked/);assert.match(result.stdout,/Refusing to run tests on main/);assert.doesNotMatch(result.stdout,/status=success/);assert.equal(fs.existsSync(path.join(checkout,'node_modules')),false);
});
test('operator installation includes the exact trusted helper inventory',()=>{
 const files=['admin-console.cjs','test-dev-host.cjs','test-dev-snapshot.cjs'];
 if(consumer==='w3books'){
  const manifest=require(path.join(scripts,'operations-manifest.json'));for(const file of files)assert.ok(manifest.files.some(entry=>entry.path===file&&entry.mode==='0644'),file);
 }else{
  const installer=fs.readFileSync(path.join(scripts,'install-server-scripts.sh'),'utf8');for(const file of files)assert.ok(installer.includes('$TARGET_DIR/'+file),file);
 }
});
