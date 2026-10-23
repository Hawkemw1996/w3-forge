import type { ChangeEvent } from 'react';
export interface AgentExecutionSettings {
  contextMode: 'full'|'structured'|'compact'|'summary'; contextBudget:number; timeoutMs:number;
  maxRetries:number;maxContextRequests:number;allowedTools:'read_files'[];
  pricing:{provider:'ollama'|'codex'|'claude';model:string;inputUsdPerMillion:number;outputUsdPerMillion:number}|null;
}
export const defaultSettings:AgentExecutionSettings={contextMode:'structured',contextBudget:30000,timeoutMs:600000,maxRetries:0,maxContextRequests:4,allowedTools:['read_files'],pricing:null};
export default function AgentExecutionSettingsEditor({value,onChange,disabled,provider,model}:{value:AgentExecutionSettings;onChange:(v:AgentExecutionSettings)=>void;disabled:boolean;provider:'ollama'|'codex'|'claude'|null;model:string}) {
  const number=(key:'contextBudget'|'timeoutMs'|'maxRetries'|'maxContextRequests',scale=1)=>(event:ChangeEvent<HTMLInputElement>)=>onChange({...value,[key]:Number(event.target.value)*scale});
  return <div className="agent-settings-section"><h3>Execution settings</h3><p className="factory-muted">Saved separately from instructions. New runs freeze these settings; active runs keep their original revision.</p>
    <label>Context mode<select aria-label="Context mode" className="input" value={value.contextMode} disabled={disabled} onChange={e=>onChange({...value,contextMode:e.target.value as AgentExecutionSettings['contextMode']})}><option value="full">Full</option><option value="structured">Structured</option><option value="compact">Compact</option><option value="summary">Summary</option></select></label>
    <label>Context budget (estimated tokens)<input className="input" aria-label="Context budget (estimated tokens)" type="number" min={1000} max={30000} step={1000} value={value.contextBudget} onChange={number('contextBudget')} disabled={disabled}/></label>
    <label>Timeout (seconds)<input className="input" aria-label="Timeout (seconds)" type="number" min={1} max={600} value={value.timeoutMs/1000} onChange={number('timeoutMs',1000)} disabled={disabled}/></label>
    <label>Provider retries<input className="input" aria-label="Provider retries" type="number" min={0} max={2} value={value.maxRetries} onChange={number('maxRetries')} disabled={disabled}/></label>
    <label>File context requests<input className="input" aria-label="File context requests" type="number" min={0} max={4} value={value.maxContextRequests} onChange={number('maxContextRequests')} disabled={disabled}/></label>
    <label><span><input type="checkbox" checked={value.allowedTools.includes('read_files')} disabled={disabled} onChange={e=>onChange({...value,allowedTools:e.target.checked?['read_files']:[]})}/> Allow repository file requests</span></label>
    <details><summary>API cost estimates</summary><p className="factory-muted">Enter your confirmed rates in USD per million tokens. Cost is unavailable without a matching explicit model, provider usage and compatible cache accounting.</p>
      <label><span><input type="checkbox" checked={!!value.pricing} disabled={disabled||!provider||!model.trim()} onChange={e=>onChange({...value,pricing:e.target.checked&&provider?{provider,model:model.trim(),inputUsdPerMillion:0,outputUsdPerMillion:0}:null})}/> Configure rates for assigned model</span></label>
      {value.pricing&&<><p>{value.pricing.provider} · {value.pricing.model}</p><label>Input USD per million<input className="input" type="number" min={0} max={10000} step="any" value={value.pricing.inputUsdPerMillion} disabled={disabled} onChange={e=>onChange({...value,pricing:{...value.pricing!,inputUsdPerMillion:Number(e.target.value)}})}/></label><label>Output USD per million<input className="input" type="number" min={0} max={10000} step="any" value={value.pricing.outputUsdPerMillion} disabled={disabled} onChange={e=>onChange({...value,pricing:{...value.pricing!,outputUsdPerMillion:Number(e.target.value)}})}/></label></>}
    </details>
    <details><summary>Execution safeguards</summary><p>Specification approval, independent reviews, owner release approval and the two-correction limit remain required. Profiles cannot grant host tools or release permissions. Context reduction keeps original records and preserves failure evidence.</p></details>
  </div>;
}
