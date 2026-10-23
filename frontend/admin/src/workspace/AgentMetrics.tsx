import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet, errorMessages } from '../lib/authApi';
import type { FactorySnapshot } from './factoryApi';
import './agent-metrics.css';
interface Totals {
  executions:number;succeeded:number;failed:number;running:number;cancelled:number;
  input_tokens:number|null;output_tokens:number|null;total_tokens:number|null;
  provider_reported:number;estimated:number;unavailable_usage:number;average_duration_ms:number|null;
  estimated_cost_usd:number|null;unavailable_cost:number;original_context_tokens:number|null;processed_context_tokens:number|null;
}
interface Observation {
  id:string;jobId:string;taskId:string;agentId:string;agentName:string;profileVersion:string;profileChecksum:string;profileRevision:number;assignmentRevision:number;executionRevision:number;
  projectId:string;projectName:string;provider:string;requestedModel:string|null;resolvedModel:string|null;contextMode:string;retryCount:number;status:string;
  startedAt:string;completedAt:string|null;durationMs:number|null;inputTokens:number|null;outputTokens:number|null;totalTokens:number|null;inputSource:string;outputSource:string;estimatedCostUsd:number|null;
  inputRecordId:string;contextRecordId:string;outputRecordId:string|null;errorCode:string|null;
}
interface Snapshot {totals:Totals;byProvider:(Totals&{provider:string})[];byProject:(Totals&{project_id:string;project_name:string})[];history:Observation[];offset:number;limit:number;observedAt:string}
interface Evidence {id:string;jobId:string;kind:string;content:string;originalChecksum:string;redacted:boolean}
const root='/api/forge/execution';
export const metricNumber=(v:number|null|undefined)=>v===null||v===undefined?'Unavailable':v.toLocaleString();
const money=(v:number|null|undefined)=>v===null||v===undefined?'Unavailable':v.toLocaleString(undefined,{style:'currency',currency:'USD',minimumFractionDigits:4,maximumFractionDigits:6});
const duration=(v:number|null|undefined)=>v===null||v===undefined?'Unavailable':(v/1000).toFixed(1)+'s';
export default function AgentMetrics({agents=[],compact=false}:{agents?:{id:string;name:string}[];compact?:boolean}) {
  const [filters,setFilters]=useState({projectId:'',agentId:'',provider:'',from:'',to:''}),[offset,setOffset]=useState(0);
  const [evidence,setEvidence]=useState<Evidence|null>(null),[failure,setFailure]=useState(''),[loading,setLoading]=useState('');
  const params=new URLSearchParams({limit:'20',offset:String(offset)});
  for(const key of ['projectId','agentId','provider'] as const)if(filters[key])params.set(key,filters[key]);
  if(filters.from)params.set('from',new Date(filters.from+'T00:00:00').toISOString());
  if(filters.to){const end=new Date(filters.to+'T00:00:00');end.setDate(end.getDate()+1);params.set('to',end.toISOString());}
  const query=useQuery({queryKey:['forge-agent-metrics',params.toString()],queryFn:()=>apiGet<Snapshot>(root+'/metrics?'+params),retry:false,refetchInterval:10000});
  const projects=useQuery({queryKey:['forge-factory'],queryFn:()=>apiGet<FactorySnapshot>('/api/forge/factory'),enabled:!compact,retry:false});
  const data=query.isError?undefined:query.data;
  const set=(key:keyof typeof filters,value:string)=>{setFilters({...filters,[key]:value});setOffset(0);setEvidence(null);};
  async function show(id:string){setLoading(id);setFailure('');try{setEvidence(await apiGet<Evidence>(root+'/records/'+encodeURIComponent(id)));}catch(error){setFailure(errorMessages(error).join(' '));}finally{setLoading('');}}
  function download(){if(!evidence)return;const url=URL.createObjectURL(new Blob([evidence.content],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='forge-'+evidence.kind+'-'+evidence.id+'.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),0);}
  return <section className="card factory-card agent-metrics" aria-label="Agent execution metrics">
    <div className="factory-section-heading"><div><h2>Agent execution metrics</h2><p>Each provider attempt counts as one execution. Usage estimates and configured costs are labeled separately from provider reports.</p></div><button className="btn" disabled={query.isFetching} onClick={()=>void query.refetch()}>Refresh metrics</button></div>
    <div className="factory-card-body agent-metrics-body">
      {!compact&&<div className="agent-metrics-filters">
        <label>Project<select aria-label="Project" className="input" value={filters.projectId} onChange={e=>set('projectId',e.target.value)}><option value="">All projects</option>{!projects.isError&&projects.data?.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>Agent<select aria-label="Agent" className="input" value={filters.agentId} onChange={e=>set('agentId',e.target.value)}><option value="">All agents</option>{agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label>Provider<select aria-label="Provider" className="input" value={filters.provider} onChange={e=>set('provider',e.target.value)}><option value="">All providers</option><option value="ollama">Local Ollama</option><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
        <label>From date<input type="date" className="input" value={filters.from} onChange={e=>set('from',e.target.value)}/></label>
        <label>Through date<input type="date" className="input" min={filters.from||undefined} value={filters.to} onChange={e=>set('to',e.target.value)}/></label>
      </div>}
      {query.isPending&&<p role="status">Loading execution metrics…</p>}
      {query.error&&<p className="factory-alert factory-alert-error" role="alert">{errorMessages(query.error).join(' ')}</p>}
      {!compact&&projects.error&&<p role="alert" className="factory-alert factory-alert-error">{errorMessages(projects.error).join(' ')}</p>}
      {data&&<><dl className="agent-metric-totals">
        {Object.entries({'Agent executions':metricNumber(data.totals.executions),'Successful executions':metricNumber(data.totals.succeeded),'Failed executions':metricNumber(data.totals.failed),'Running / cancelled':data.totals.running+' / '+data.totals.cancelled,'Known total tokens':metricNumber(data.totals.total_tokens),'Average duration':duration(data.totals.average_duration_ms),'Estimated API cost':money(data.totals.estimated_cost_usd)}).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl><p className="factory-muted">{data.totals.provider_reported} provider-reported · {data.totals.estimated} estimated · {data.totals.unavailable_usage} incomplete token pairs · {data.totals.unavailable_cost} executions without cost estimates. Available sums can cover only part of the selected executions.</p>
      <p className="factory-muted">Context Gateway: {metricNumber(data.totals.original_context_tokens)} original → {metricNumber(data.totals.processed_context_tokens)} sent estimated tokens. Rules, profiles, source and failure evidence stay intact. Small outputs can grow with structured metadata.</p>
      {!data.totals.executions&&<p className="factory-muted">No agent executions match these filters. Earlier releases have no backfilled provider metrics.</p>}
      {!compact&&<><div className="agent-metric-groups"><div><h3>Tokens by provider</h3>{data.byProvider.map(p=><p key={p.provider}>{p.provider}: {metricNumber(p.total_tokens)} · {p.provider_reported} reported / {p.estimated} estimated · {money(p.estimated_cost_usd)}</p>)}</div><div><h3>Tokens by project</h3>{data.byProject.map(p=><p key={p.project_id}>{p.project_name}: {metricNumber(p.total_tokens)}</p>)}</div></div>
      <h3>Agent execution history</h3><div className="agent-metrics-table" tabIndex={0} aria-label="Scrollable agent execution history"><table><thead><tr><th>Agent / profile</th><th>Project / model</th><th>Status / duration</th><th>Tokens</th><th>Context / cost</th><th>Evidence</th></tr></thead><tbody>{data.history.map(r=><tr key={r.id}>
        <td><strong>{r.agentName}</strong><br/>v{r.profileVersion}<br/>{new Date(r.startedAt).toLocaleString()}</td>
        <td>{r.projectName}<br/>{r.provider} · {r.resolvedModel??r.requestedModel??'Provider default (unresolved)'}</td>
        <td>{r.status}<br/>{duration(r.durationMs)}<br/>Retries: {r.retryCount}{r.errorCode&&<><br/>{r.errorCode}</>}</td>
        <td>In: {metricNumber(r.inputTokens)} ({r.inputSource})<br/>Out: {metricNumber(r.outputTokens)} ({r.outputSource})<br/>Total: {metricNumber(r.totalTokens)}</td>
        <td>{r.contextMode}<br/>{money(r.estimatedCostUsd)}</td>
        <td><details><summary>Execution details</summary><dl><dt>Execution</dt><dd>{r.id}</dd><dt>Task / job</dt><dd>{r.taskId}<br/>{r.jobId}</dd><dt>Started</dt><dd>{new Date(r.startedAt).toLocaleString()}</dd><dt>Completed</dt><dd>{r.completedAt?new Date(r.completedAt).toLocaleString():'Unavailable'}</dd><dt>Frozen revisions</dt><dd>Profile {r.profileRevision} · model {r.assignmentRevision} · settings {r.executionRevision}</dd><dt>Profile checksum</dt><dd>{r.profileChecksum}</dd></dl><div className="factory-button-group">{[['Original input',r.inputRecordId],['Sent context',r.contextRecordId],['Complete output',r.outputRecordId]].map(([label,id])=>id&&<button key={id} className="btn" disabled={!!loading} onClick={()=>void show(id)}>{loading===id?'Loading…':label}</button>)}</div></details></td>
      </tr>)}</tbody></table></div>
      <div className="factory-button-group"><button className="btn" disabled={offset===0||query.isFetching} onClick={()=>setOffset(Math.max(0,offset-20))}>Previous</button><span>Showing {data.history.length?offset+1:0}–{offset+data.history.length} of {data.totals.executions}</span><button className="btn" disabled={offset+data.history.length>=data.totals.executions||query.isFetching} onClick={()=>setOffset(offset+20)}>Next</button></div>
      {failure&&<p role="alert" className="factory-alert factory-alert-error">{failure}</p>}
      {evidence&&<div className="agent-evidence"><div className="factory-section-heading"><h3>{evidence.kind.replace(/_/g,' ')}</h3><div className="factory-button-group"><button className="btn" onClick={download}>Download complete record</button><button className="btn" onClick={()=>setEvidence(null)}>Close record</button></div></div><p className="factory-muted">{evidence.redacted?'Sensitive values and terminal formatting were removed from this display.':'Complete recorded text.'} Original SHA-256: <code>{evidence.originalChecksum}</code></p><pre>{evidence.content}</pre></div>}
      </>}
      </>}
    </div>
  </section>;
}
