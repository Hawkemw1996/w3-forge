#!/usr/bin/env node
'use strict';
// Public integration loader. The console implementation remains in its private repository.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const REPOSITORY = 'https://github.com/Hawkemw1996/w3-admin-console.git';
const LOCK = 'admin-console.lock.json';
const SHA = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/;
const GROUPS = {backend:['backend/admin','backend/src/admin','backend/src/console'],
  frontend:['frontend/admin/src','frontend/admin/src'],shared:['frontend/shared','frontend/shared']};
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => {throw new Error(message);};
function safePath(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.\/-]+$/.test(value)
    && !value.startsWith('/') && value.split('/').every(p => p && p !== '.' && p !== '..' && p !== '.git');
}
function secureTarget(root, rel) {
  if (!safePath(rel)) fail('Invalid managed path.');
  let current = root;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) fail('Refusing a symlinked managed path.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return current;
}
function validateLock(lock) {
  if (lock?.schema !== 1 || lock.repository !== REPOSITORY || !SHA.test(lock.revision)
    || /^0+$/.test(lock.revision) || !HASH.test(lock.manifestSha256) || lock.api !== 1
    || !/^\d+\.\d+\.\d+$/.test(lock.version)) fail('Invalid shared-console lock.');
  if(!['w3buildcost','w3books','w3forge'].includes(lock.consumer))fail('Invalid console consumer; W3 Core is not a shared-console consumer.');
  for (const [key, values] of Object.entries(GROUPS)) {
    if (!values.slice(1).includes(lock.targets?.[key])) fail('Invalid console target mapping.');
  }
  return lock;
}
function readLock(root) {
  const lock=validateLock(JSON.parse(fs.readFileSync(secureTarget(root,LOCK),'utf8')));
  const app=JSON.parse(fs.readFileSync(secureTarget(root,'package.json'),'utf8'));
  if(app.name!==lock.consumer)fail('Console lock belongs to a different app.');
  return lock;
}
function readManifest(bytes, lock) {
  if (sha256(bytes) !== lock.manifestSha256) fail('Console manifest checksum mismatch.');
  const manifest=JSON.parse(bytes);
  if (manifest.schema!==1 || manifest.api!==lock.api || manifest.version!==lock.version
    || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length>500) fail('Incompatible console manifest.');
  const seen=new Set();
  for(const file of manifest.files) {
    if(!GROUPS[file.group] || !safePath(file.path) || !HASH.test(file.sha256)
      || !Number.isSafeInteger(file.bytes) || file.bytes<0 || file.bytes>2*1024*1024) fail('Invalid console file record.');
    const key=file.group+'/'+file.path;
    if(seen.has(key))fail('Duplicate console manifest path.');seen.add(key);
    if(file.group==='backend' && ['index.ts','productionReadinessRoutes.ts','routes/productionReadinessRoutes.ts','booksBackups.ts'].includes(file.path))fail('Manifest overwrites app composition.');
    if(file.path==='adminConsoleAdapter.ts')fail('Manifest overwrites an app adapter.');
    if(file.group==='frontend' && ['entry.tsx','forgeMain.tsx','PublicApp.tsx','AuthPages.tsx'].includes(file.path))fail('Manifest overwrites the app entry point.');
  }
  return manifest;
}
function metadata(root) {return secureTarget(root,'.w3-admin-console/manifest.json');}
function receipt(root) {return secureTarget(root,'.w3-admin-console/receipt.json');}
function sameLock(a,b) {
  return ['schema','repository','consumer','revision','manifestSha256','api','version'].every(key=>a[key]===b[key])
    && Object.keys(GROUPS).every(key=>a.targets[key]===b.targets[key]);
}
function installedLock(root) {
  return validateLock(JSON.parse(fs.readFileSync(receipt(root),'utf8')));
}
function gitEnvironment() {
  const result={};
  // No app database, Core, session or provider credentials enter git.
  for(const key of ['PATH','HOME','USERPROFILE','SystemRoot','SSH_AUTH_SOCK','LANG','SSL_CERT_FILE','SSL_CERT_DIR']) {
    if(process.env[key])result[key]=process.env[key];
  }
  result.GIT_TERMINAL_PROMPT='0';result.GCM_INTERACTIVE='Never';
  // Use a dedicated, operator-provisioned console deploy key. Never reuse an app's key implicitly.
  const key=process.env.ADMIN_CONSOLE_GIT_KEY_FILE;
  if(key) {
    if(!path.isAbsolute(key)||/[\r\n\0]/.test(key))fail('Console key path must be absolute.');
    const st=fs.lstatSync(key);
    if(!st.isFile()||st.isSymbolicLink()||(process.platform!=='win32'&&(st.mode&0o077)))fail('Console key file is not protected.');
    result.GIT_SSH_COMMAND="ssh -i '"+key.replace(/'/g,"'\\''")+"' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10";
  }
  return result;
}
function git(cwd,args) {
  try {return execFileSync('git',args,{cwd,env:gitEnvironment(),stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024,timeout:120000});}
  catch {fail('Git operation failed. Verify the console repository access and host SSH configuration.');}
}
function transport() {
  return process.env.ADMIN_CONSOLE_GIT_KEY_FILE ? 'git@github.com:Hawkemw1996/w3-admin-console.git' : REPOSITORY;
}
function withSource(root,revision,source,fn) {
  if(source) {
    const resolved=fs.realpathSync(source);
    if(git(resolved,['rev-parse',revision+'^{commit}']).toString().trim()!==revision)fail('Local console revision is missing.');
    return fn(resolved);
  }
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'w3-console-source-'));
  try {
    git(dir,['init','--quiet']);
    git(dir,['remote','add','origin',transport()]);
    git(dir,['-c','protocol.file.allow=never','fetch','--quiet','--depth=1','origin',revision]);
    if(git(dir,['rev-parse','FETCH_HEAD^{commit}']).toString().trim()!==revision)fail('Fetched console revision mismatch.');
    return fn(dir);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
function inspectTree(source,revision) {
  const entries=git(source,['ls-tree','-r','-z',revision]).toString().split('\0').filter(Boolean);
  return new Map(entries.map(line=>{const [head,file]=line.split('\t');return [file,head.split(' ')[0]];}));
}
function payload(source,lock) {
  const bytes=git(source,['show',lock.revision+':console.manifest.json']);
  const manifest=readManifest(bytes,lock),tree=inspectTree(source,lock.revision),files=[];
  for(const file of manifest.files) {
    const from=GROUPS[file.group][0]+'/'+file.path;
    if(tree.get(from)!=='100644')fail('Shared console source must be a regular file.');
    const content=git(source,['show',lock.revision+':'+from]);
    if(content.length!==file.bytes||sha256(content)!==file.sha256)fail('Console source checksum mismatch.');
    files.push({relative:lock.targets[file.group]+'/'+file.path,content});
  }
  return {manifest,bytes,files};
}
function verify(root,lock=readLock(root)) {
  if (!sameLock(installedLock(root),lock)) fail('Installed console receipt differs from the app lock; run console:sync.');
  const manifest=readManifest(fs.readFileSync(metadata(root)),lock);
  for(const file of manifest.files) {
    const name=secureTarget(root,lock.targets[file.group]+'/'+file.path);
    const st=fs.lstatSync(name);
    if(!st.isFile()||st.size!==file.bytes||sha256(fs.readFileSync(name))!==file.sha256)fail('Shared console drift: '+file.group+'/'+file.path);
  }
  return {version:lock.version,revision:lock.revision,files:manifest.files.length,verified:true};
}
function atomicWrite(file,bytes) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+'.w3-tmp-'+crypto.randomBytes(8).toString('hex');
  try {fs.writeFileSync(tmp,bytes,{flag:'wx',mode:0o644});fs.renameSync(tmp,file);}
  finally {fs.rmSync(tmp,{force:true});}
}
function install(root,lock,data,oldManifest,writeLock=false) {
  const updates=data.files.map(file=>({file:secureTarget(root,file.relative),content:file.content}));
  updates.push({file:metadata(root),content:data.bytes});
  const lockBytes=Buffer.from(JSON.stringify(lock,null,2)+'\n');
  updates.push({file:receipt(root),content:lockBytes});
  if(writeLock)updates.push({file:secureTarget(root,LOCK),content:lockBytes});
  const next=new Set(updates.map(row=>row.file));
  for(const file of oldManifest?.files??[]) {
    const target=secureTarget(root,lock.targets[file.group]+'/'+file.path);
    if(!next.has(target))updates.push({file:target,content:null});
  }
  const backups=updates.map(row=>({...row,before:fs.existsSync(row.file)?fs.readFileSync(row.file):null}));
  try {
    for(const row of updates)if(row.content===null)fs.rmSync(row.file,{force:true});else atomicWrite(row.file,row.content);
    verify(root,lock);
  }catch(error) {
    for(const row of backups)if(row.before===null)fs.rmSync(row.file,{force:true});else atomicWrite(row.file,row.before);
    throw error;
  }
}
function exclusive(root,fn) {
  const dir=secureTarget(root,'.w3-admin-console');fs.mkdirSync(dir,{recursive:true});
  const lock=path.join(dir,'sync.lock');
  let fd;try{fd=fs.openSync(lock,'wx',0o600);}catch{fail('Another console operation holds the local source lock.');}
  try{return fn();}finally{fs.closeSync(fd);fs.rmSync(lock,{force:true});}
}
function sync(root,{source}={}) {
  return exclusive(root,()=>{
    const lock=readLock(root);
    let prior;
    if(fs.existsSync(metadata(root))) {
      const installed=installedLock(root);
      // A git pull may advance the pin. Check the previous materialization for
      // drift before replacing it; never treat a changed pin as permission to
      // discard locally edited generated files.
      verify(root,installed);
      if(sameLock(installed,lock))return verify(root,lock);
      if(!Object.keys(GROUPS).every(key=>installed.targets[key]===lock.targets[key]))fail('Console target mapping changed; operator migration is required.');
      prior=readManifest(fs.readFileSync(metadata(root)),installed);
    }
    return withSource(root,lock.revision,source,dir=>{
      const data=payload(dir,lock);install(root,lock,data,prior);return verify(root,lock);
    });
  });
}
function requireDevelopmentCheckout(root) {
  const branch=git(root,['branch','--show-current']).toString().trim();
  if(!/^dev\/v\d+\.\d+\.\d+$/.test(branch))fail('Console adoption requires an approved dev/vX.Y.Z checkout.');
  if(git(root,['status','--porcelain']).toString().trim())fail('Commit or preserve current app changes before adopting a console revision.');
}
function update(root,{revision,expected,source}) {
  if(!SHA.test(revision)||!SHA.test(expected))fail('Full immutable revision and expected-current SHA are required.');
  return exclusive(root,()=>{
    requireDevelopmentCheckout(root);
    const old=readLock(root);if(old.revision!==expected)fail('Console lock changed; refresh before adopting.');
    verify(root,old);
    return withSource(root,revision,source,dir=>{
      const bytes=git(dir,['show',revision+':console.manifest.json']),manifest=JSON.parse(bytes);
      const next=validateLock({...old,revision,version:manifest.version,api:manifest.api,manifestSha256:sha256(bytes)});
      const data=payload(dir,next),prior=readManifest(fs.readFileSync(metadata(root)),old);
      // Validate the complete new payload before touching either lock or sources.
      // The pin, source, manifest and receipt share one rollback transaction.
      install(root,next,data,prior,true);
      return {...verify(root,next),requiresTests:true,requiresCommit:true,productionChanged:false};
    });
  });
}
function archive(root,{output,prefix}) {
  if(!output||!prefix||!/^[a-z0-9_-]+\/$/.test(prefix))fail('Archive requires an output and safe app prefix.');
  const lock=readLock(root),result=verify(root,lock);
  if(git(root,['status','--porcelain']).toString().trim())fail('A package requires a clean app checkout.');
  const manifest=readManifest(fs.readFileSync(metadata(root)),lock);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'w3-console-archive-'));
  try {
    const sourceTar=path.join(temp,'source.tar'),stage=path.join(temp,'stage');
    fs.mkdirSync(stage);
    git(root,['archive','--format=tar','--prefix='+prefix,'--output='+sourceTar,'HEAD']);
    execFileSync('tar',['-xf',sourceTar,'-C',stage],{stdio:'pipe'});
    const app=path.join(stage,prefix);
    for(const file of manifest.files) {
      const relative=lock.targets[file.group]+'/'+file.path;
      const target=secureTarget(app,relative);fs.mkdirSync(path.dirname(target),{recursive:true});
      fs.copyFileSync(secureTarget(root,relative),target);
    }
    const meta=metadata(app);fs.mkdirSync(path.dirname(meta),{recursive:true});fs.copyFileSync(metadata(root),meta);
    fs.copyFileSync(receipt(root),receipt(app));
    verify(app);
    // The calling app pipeline chooses a temporary output and performs its existing atomic promotion.
    execFileSync('tar',['-czf',path.resolve(output),'-C',stage,prefix.slice(0,-1)],{stdio:'pipe'});
    return {...result,archive:output};
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
function snapshot(root,{destination}) {
  if(!destination)fail('Snapshot requires a destination with the app files already copied.');
  const lock=readLock(root),result=verify(root,lock);
  if(fs.lstatSync(destination).isSymbolicLink())fail('Refusing a symlinked snapshot destination.');
  const target=fs.realpathSync(destination);
  if(target===fs.realpathSync(root)||!sameLock(readLock(target),lock))fail('Snapshot app lock does not match its verified source.');
  const bytes=fs.readFileSync(metadata(root)),manifest=readManifest(bytes,lock);
  const files=manifest.files.map(file=>{
    const relative=lock.targets[file.group]+'/'+file.path;
    const content=fs.readFileSync(secureTarget(root,relative));
    if(content.length!==file.bytes||sha256(content)!==file.sha256)fail('Console source changed during snapshot.');
    return {relative,content};
  });
  // No Git, network, source hooks, credential directory or app-owned file is
  // copied here. A trusted operator loader calls this before dropping privilege.
  install(target,lock,{manifest,bytes,files},null);
  return {...result,snapshot:target};
}
function refs(root) {
  readLock(root);
  const lines=git(root,['ls-remote',transport(),'refs/tags/v*','refs/heads/dev/v*']).toString().trim().split('\n');
  return parseRefs(lines);
}
function parseRefs(lines) {
  const refs=new Map(),peeled=new Map();
  for(const line of lines) {
    const [revision,ref]=line.split(/\s+/);
    if(!SHA.test(revision)||!/^refs\/(?:heads\/dev\/v\d+\.\d+\.\d+|tags\/v\d+\.\d+\.\d+(?:\^\{\})?)$/.test(ref??''))continue;
    if(ref.endsWith('^{}'))peeled.set(ref.slice(0,-3),revision);else refs.set(ref,revision);
  }
  for(const [ref,revision] of peeled)refs.set(ref,revision);
  return [...refs].map(([ref,revision])=>({ref,revision}));
}
function main(argv) {
  const command=argv.shift()||'status',opts={};
  while(argv.length){const key=argv.shift();if(!['--root','--source','--revision','--expected','--output','--prefix','--destination'].includes(key)||!argv.length)fail('Unknown or incomplete argument.');opts[key.slice(2)]=argv.shift();}
  const root=fs.realpathSync(opts.root||path.join(__dirname,'..'));
  if(command==='sync')return sync(root,opts);
  if(command==='verify')return verify(root);
  if(command==='status'){const lock=readLock(root);return {...lock,verified:verify(root).verified};}
  if(command==='refs')return refs(root);
  if(command==='update')return update(root,opts);
  if(command==='archive')return archive(root,opts);
  if(command==='snapshot')return snapshot(root,opts);
  fail('Unknown console command.');
}
module.exports={sha256,safePath,validateLock,readManifest,verify,sync,update,archive,snapshot,secureTarget,parseRefs,main};
if(require.main===module) {
  try{console.log(JSON.stringify(main(process.argv.slice(2)),null,2));}
  catch(error){console.error('Admin Console: '+error.message);process.exitCode=1;}
}
