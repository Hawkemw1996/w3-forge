import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {apiGet,errorMessages} from '../lib/authApi';
export default function ExecutionRecords({jobId}:{jobId:string}) {
  const [open,setOpen]=useState(false),[selected,setSelected]=useState<{id:string;content:string;redacted:boolean;originalChecksum:string}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const query=useQuery({queryKey:['forge-execution-records',jobId],queryFn:()=>apiGet<{records:{id:string;kind:string;sizeBytes:number;createdAt:string}[]}>('/api/forge/execution/jobs/'+encodeURIComponent(jobId)+'/records'),enabled:open,retry:false,refetchInterval:open?5000:false});
  async function view(id:string){setBusy(true);setError('');try{setSelected(await apiGet('/api/forge/execution/records/'+encodeURIComponent(id)));}catch(e){setError(errorMessages(e).join(' '));}finally{setBusy(false);}}
  function download(){if(!selected)return;const url=URL.createObjectURL(new Blob([selected.content],{type:'text/plain;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='forge-evidence-'+selected.id+'.txt';link.click();setTimeout(()=>URL.revokeObjectURL(url),0);}
  return <details className="execution-details" onToggle={e=>setOpen(e.currentTarget.open)}><summary>Complete execution records</summary>
    <p className="factory-muted">Original inputs, sent context, provider outputs and command logs are retained separately from event previews. Sensitive values are redacted when viewed or downloaded. Interrupted calls may have partial output.</p>
    {query.isPending&&<p role="status">Loading records…</p>}{query.error&&<p role="alert">{errorMessages(query.error).join(' ')}</p>}
    {!query.isError&&<ul>{query.data?.records.map(r=><li key={r.id}><button className="btn" disabled={busy} onClick={()=>void view(r.id)}>{r.kind.replace(/_/g,' ')} · {new Date(r.createdAt).toLocaleString()} · {r.sizeBytes.toLocaleString()} bytes</button></li>)}</ul>}
    {error&&<p className="factory-alert factory-alert-error" role="alert">{error}</p>}
    {selected&&<div className="execution-markdown"><p className="factory-muted">{selected.redacted?'Display redactions applied. ':''}Original checksum: <code>{selected.originalChecksum}</code></p><button className="btn" onClick={download}>Download complete record</button><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:480,overflow:'auto'}}>{selected.content}</pre></div>}
  </details>;
}
