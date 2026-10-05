// W3 Core 0.12.16 app-bound identity client. No passwords or general Core cookies.
import { createHash } from 'node:crypto';
export interface CoreUser { id:string; username:string; email:string; appRole:string; status:'active'; }
export class CoreUnavailableError extends Error { constructor(message='W3 Core is unavailable.'){super(message);this.name='CoreUnavailableError';} }
export class CoreNotConfiguredError extends Error { constructor(){super('Configure the W3 Core address, public app address, instance ID and pairing credential.');this.name='CoreNotConfiguredError';} }
export interface CoreAuthFailure {ok:false;status:number;code:string;message:string;}
export type CoreMeResult={ok:true;user:CoreUser;expiresAt:string}|CoreAuthFailure;
export type CoreVerifyResult={ok:true;sessionToken:string;user:CoreUser;expiresAt:string}|CoreAuthFailure;
export interface CoreHealth {reachable:boolean;status?:number;version?:string;registration?:'registered'|'not_registered'|'unknown';detail?:string;}
export interface CoreClient {
 readonly configured:boolean;readonly baseUrl:string;
 readonly connection:{fingerprint:string|null;status:string};
 authorizationUrl(state:string,challenge:string):Promise<string>;
 exchange(code:string,verifier:string):Promise<CoreVerifyResult>;
 me(token:string):Promise<CoreMeResult>;logout(token:string):Promise<void>;
 announce():Promise<void>;health():Promise<CoreHealth>;
}
export interface CoreClientOptions {
 baseUrl:string;publicCoreUrl?:string;publicAppUrl?:string;clientSecret?:string;instanceId?:string;
 appId?:string;appName?:string;version?:string;serviceToken?:string;timeoutMs?:number;
 fetchImpl?:(url:string,init:RequestInit)=>Promise<Response>;
}
function origin(raw:string|undefined):string|null {
 try{const u=new URL(raw??'');return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/'?u.origin:null;}catch{return null;}
}
export function createCoreClient(opts:CoreClientOptions):CoreClient {
 const baseUrl=origin(opts.baseUrl)??'',publicCore=origin(opts.publicCoreUrl??opts.baseUrl),publicApp=origin(opts.publicAppUrl);
 const secret=opts.clientSecret??'',appId=opts.appId??'w3forge';
 const configured=!!baseUrl&&!!publicCore&&!!publicApp&&/^[A-Za-z0-9_-]{43}$/.test(secret)&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(opts.instanceId??'');
 const callback=publicApp+'/api/auth/callback';
 const fingerprint=/^[A-Za-z0-9_-]{43}$/.test(secret)?createHash('sha256').update(secret).digest('hex').slice(0,16):null;
 let connectionStatus='not_announced';
 const fetcher=opts.fetchImpl??fetch;
 async function call(path:string,data?:unknown,auth=true){
  if(!baseUrl||(auth&&!configured))throw new CoreNotConfiguredError();
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),opts.timeoutMs??5000);
  try{
   const res=await fetcher(baseUrl+path,{method:data===undefined?'GET':'POST',redirect:'manual',signal:controller.signal,
    headers:{Accept:'application/json',...(data===undefined?{}:{'Content-Type':'application/json'}),...(auth?{'X-W3-App-Id':appId,Authorization:'Bearer '+secret}:{})},
    ...(data===undefined?{}:{body:JSON.stringify(data)})});
   if(res.status>=500||res.status>=300&&res.status<400)throw new CoreUnavailableError();
   const body=await res.json() as {success?:boolean;data?:any};
   return {status:res.status,data:res.ok&&body.success===true?body.data:null};
  }catch(error){if(error instanceof CoreNotConfiguredError||error instanceof CoreUnavailableError)throw error;throw new CoreUnavailableError();}
  finally{clearTimeout(timer);}
 }
 const denied=(status:number):CoreAuthFailure=>({ok:false,status,code:status===403?'ACCESS_DENIED':'AUTH_REQUIRED',message:'This app sign-in is no longer authorized by W3 Core.'});
 async function me(token:string):Promise<CoreMeResult>{
  const r=await call('/api/app-sign-in/session',{session_token:token});
  if(!r.data)return denied(r.status);
  const d=r.data,u=d.user;
  if(d.app_id!==appId||!u||!/^\d+$/.test(String(u.id))||typeof u.username!=='string'||!u.username||!['viewer','editor','admin'].includes(d.app_role)||!Number.isFinite(Date.parse(d.expires_at))||Date.parse(d.expires_at)<=Date.now())throw new CoreUnavailableError('W3 Core returned an invalid app identity.');
  return {ok:true,user:{id:String(u.id),username:u.username,email:typeof u.email==='string'?u.email:'',appRole:d.app_role,status:'active'},expiresAt:d.expires_at};
 }
 async function announce(){
  const r=await call('/api/app-discovery/announce',{instance_id:opts.instanceId,app_id:appId,name:opts.appName??'W3 Forge',app_url:publicApp+'/',redirect_uris:[callback],version:opts.version??'0.0.0'});
  if(!r.data){connectionStatus='rejected';throw new CoreNotConfiguredError();}
  if(!['pending','approved'].includes(r.data.status))throw new CoreUnavailableError();
  connectionStatus=r.data.status;
 }
 return {
  configured,baseUrl,get connection(){return {fingerprint,status:connectionStatus};},announce,
  async authorizationUrl(state,challenge){
   if(!configured)throw new CoreNotConfiguredError();
   await announce();
   const target=new URL('/command-center/sign-in',publicCore!);
   target.search=new URLSearchParams({client_id:appId,redirect_uri:callback,state,code_challenge:challenge,code_challenge_method:'S256'}).toString();
   return target.href;
  },
  async exchange(code,verifier){
   const r=await call('/api/app-sign-in/exchange',{code,code_verifier:verifier,redirect_uri:callback});
   if(!r.data)return denied(r.status);
   const token=r.data.session_token;
   if(typeof token!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(token))throw new CoreUnavailableError();
   const identity=await me(token);if(!identity.ok)return identity;
   return {...identity,sessionToken:token};
  },
  me,
  async logout(token){try{await call('/api/app-sign-in/logout',{session_token:token});}catch{/* Local logout always succeeds. */}},
  async health(){
   if(!baseUrl)return {reachable:false,detail:'CORE_API_URL is not configured.'};
   try{const r=await call('/health',undefined,false);return {reachable:r.status===200,status:r.status,version:r.data?.version,registration:connectionStatus==='approved'?'registered':connectionStatus==='pending'?'not_registered':'unknown',detail:'Connection status: '+connectionStatus};}
   catch{return {reachable:false,detail:'W3 Core could not be reached.'};}
  }
 };
}
