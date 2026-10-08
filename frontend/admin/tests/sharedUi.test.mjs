import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),loader=require('../../../scripts/admin-console.cjs');
test('the complete frontend and shared layer stay pinned to the private upstream source',()=>{
 const root=fileURLToPath(new URL('../../../',import.meta.url));
 const result=loader.verify(root);
 assert.equal(result.verified,true);assert.ok(result.files>100);
 const manifest=JSON.parse(readFileSync(new URL('../../../.w3-admin-console/manifest.json',import.meta.url),'utf8'));
 assert.ok(manifest.files.filter(file=>file.group==='frontend').length>55);
 assert.equal(manifest.files.filter(file=>file.group==='shared').length,12);
 const styles=readFileSync(new URL('../src/styles.css',import.meta.url),'utf8');
 assert.match(styles,/@import '\.\/styles\/tokens\.css';/);
 assert.match(styles,/@import '\.\.\/\.\.\/shared\/styles\/primitives\.css';/);
});
