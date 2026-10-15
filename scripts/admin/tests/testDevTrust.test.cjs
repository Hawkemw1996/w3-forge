'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path');
const {protectedStatus,trustedTestYaml}=require('../_w3forge-policy.cjs');
test('root Test Dev policy never resolves its parser from the development checkout',()=>{
 const source=path.resolve('/fixture/w3forge-deploy');
 for(const runtime of [source,path.join(source,'runtime'),path.dirname(source)])assert.throws(()=>trustedTestYaml(source,{W3_APP_DIR:runtime}),/separate protected runtime parser/);
});
test('trusted parser status rejects non-root ownership, write access, links and special files',()=>{
 const status=(uid,mode,kind)=>({uid,mode,isSymbolicLink:()=>kind==='link',isDirectory:()=>kind==='directory',isFile:()=>kind==='file'});
 assert.equal(protectedStatus(status(0,0o755,'directory')),true);assert.equal(protectedStatus(status(0,0o644,'file')),true);
 for(const st of [status(1000,0o644,'file'),status(0,0o664,'file'),status(0,0o777,'directory'),status(0,0o644,'link'),status(0,0o600,'socket')])assert.equal(protectedStatus(st),false);
});
