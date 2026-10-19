'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const policy=path.resolve(__dirname,'../_w3forge-policy.sh').replaceAll('\\','/');
const bash=process.env.W3_TEST_BASH||(process.platform==='win32'?path.resolve(path.dirname(process.execPath),'../../native/git/usr/bin/sh.exe'):'/bin/bash');
const fixtures=[
 ['absent setting',undefined,'PGHOST=fixture\n',undefined],
 ['exported empty setting',undefined,'PGSSLMODE=\n',undefined],
 ['inherited empty setting','','PGHOST=fixture\n',undefined],
 ['configured empty setting','require','PGSSLMODE=\n',undefined],
 ['inherited explicit setting','require','PGHOST=fixture\n','require'],
 ['configured explicit setting','prefer','PGSSLMODE=verify-full\n','verify-full'],
 ['invalid populated setting',undefined,'PGSSLMODE=invalid\n','invalid'],
 ['whitespace populated setting',undefined,'PGSSLMODE= \n',' '],
];
for(const [label,inherited,exported,expected]of fixtures){
 test('database environment handles '+label+' without selecting a new SSL policy',()=>{
  const body=[
   'set -euo pipefail','source "$W3_TEST_POLICY"',
   'node() { printf "%s" "$W3_TEST_DATABASE_EXPORT"; }',
   'w3forge_database_env',
   'if [[ -v PGSSLMODE ]]; then printf "set\\0%s\\0" "$PGSSLMODE"; else printf "unset\\0"; fi',
  ].join('\n');
  const env={...process.env,W3_TEST_POLICY:policy,W3_FORGE_ROOT:'/fixture',W3_TEST_DATABASE_EXPORT:exported};
  if(inherited===undefined)delete env.PGSSLMODE;else env.PGSSLMODE=inherited;
  const result=spawnSync(bash,['-s'],{input:body,env,encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.error?.message||result.stderr);
  assert.equal(result.stdout,expected===undefined?'unset\0':'set\0'+expected+'\0');
 });
}
