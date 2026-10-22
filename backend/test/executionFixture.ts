import {PGlite} from '@electric-sql/pglite';
import path from 'node:path';
import type {Database,Queryable} from '../src/db/database';
import {applyMigrations} from '../src/db/migrate';
import {createFactoryService} from '../src/factory/service';
import {ExecutionStore} from '../src/execution/store';
export const actor={coreUserId:'execution-owner',name:'Execution Owner'},TOKEN='a'.repeat(64),BASE='1'.repeat(40),COMMITS=['2'.repeat(40),'3'.repeat(40),'4'.repeat(40)];
export async function executionFixture(){const pg=new PGlite();type Exec=Queryable&{exec(s:string):Promise<unknown>};const db:Database={query:async<T>(sql:string,params:unknown[]=[])=>{const r=await pg.query<T>(sql,params);return{rows:r.rows,rowCount:r.affectedRows};},ping:async()=>true,transaction:fn=>pg.transaction(async tx=>fn({query:async<T>(sql:string,params:unknown[]=[])=>{const r=await tx.query<T>(sql,params);return{rows:r.rows,rowCount:r.affectedRows};},exec:(s:string)=>tx.exec(s)} as Exec))};await applyMigrations(db,path.resolve(__dirname,'../../database/migrations'),async(q,s)=>{await(q as Exec).exec(s);});const store=new ExecutionStore(db),factory=createFactoryService(db);let n=0;
 const project=()=>{n++;return factory.createProject(actor,{name:'Execution '+n,appId:'execution'+n,repositoryUrl:'https://github.com/example/execution'+n,branch:'dev/v0.4.7',description:'',rulesTitle:'Rules',rulesMarkdown:'# Rules\nPreserve the requested scope.'});};
 const request=async(projectId?:string)=>factory.createRequest(actor,{projectId:projectId??(await project()).id,title:'Backend pilot',description:'A narrow backend change.',acceptanceCriteria:'Configured checks and reviews pass.'});
 const start=async()=>{const r=await request();return store.start(actor,r.id,r.revision);};
 const reset=async()=>{await db.query("UPDATE public.factory_execution_jobs SET status='cancelled',cancel_requested=true,reconciliation_required=false WHERE status NOT IN ('ready','cancelled')");await db.query('UPDATE public.factory_execution_slot SET job_id=NULL,owner_token=NULL,heartbeat_at=NULL WHERE singleton=true');};
 return{pg,db,store,factory,project,request,start,reset};}
