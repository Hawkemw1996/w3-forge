import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPost, errorMessages } from '../lib/authApi';
import AgentExecutionSettingsEditor, {defaultSettings,type AgentExecutionSettings} from './AgentExecutionSettings';
import AgentMetrics from './AgentMetrics';
import './agents.css';

type Provider = 'ollama' | 'codex' | 'claude' | null;
export interface AgentProfile {
  id: string; slug: string; name: string; purpose: string; enabled: boolean; revision: number;
  profileVersion: string; profileMarkdown: string; profileChecksum: string;
  provider: Provider; model: string | null; executionSettings?:AgentExecutionSettings; executionRevision?:number; createdAt: string; updatedAt: string;
}
interface ProfileRevision {
  agentId: string; version: string; name: string; purpose: string; profileMarkdown: string;
  checksum: string; createdAt: string; createdBy: string;
}
interface ProfileDraft { name: string; purpose: string; markdown: string }
const emptyDraft = (): ProfileDraft => ({ name: '', purpose: '', markdown: '# Purpose\n\n\n## Responsibilities\n\n\n## Supported tasks\n\n\n## Required inputs\n\n\n## Working instructions\n\n\n## Expected outputs\n\n\n## Completion criteria\n\n\n## Governance and review requirements\n\n\n## Output format and validation\n\n\n## Escalation rules\n' });
const providerNames = { ollama: 'Local Ollama', codex: 'Codex', claude: 'Claude' };
const stamp = (value: string) => new Date(value).toLocaleString();
const api = '/api/forge/agents';

function inlineMarkdown(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
    if (link) return <a key={index} href={link[2]} target="_blank" rel="noopener noreferrer">{link[1]}</a>;
    return part;
  });
}

/** Render a limited Markdown vocabulary as React nodes. Raw HTML stays text. */
export function AgentMarkdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      while (++index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index]);
      blocks.push(<pre key={index}><code>{code.join('\n')}</code></pre>);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const content = inlineMarkdown(heading[2]);
      blocks.push(heading[1].length < 3 ? <h3 key={index}>{content}</h3> : <h4 key={index}>{content}</h4>);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: ReactNode[] = [];
      do { items.push(<li key={index}>{inlineMarkdown(lines[index].replace(/^\s*[-*]\s+/, ''))}</li>); index++; }
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index]));
      index--; blocks.push(<ul key={index}>{items}</ul>); continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: ReactNode[] = [];
      do { items.push(<li key={index}>{inlineMarkdown(lines[index].replace(/^\s*\d+[.)]\s+/, ''))}</li>); index++; }
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index]));
      index--; blocks.push(<ol key={index}>{items}</ol>); continue;
    }
    blocks.push(<p key={index}>{inlineMarkdown(line)}</p>);
  }
  return <div className="agent-markdown">{blocks.length ? blocks : <p className="factory-muted">No profile content.</p>}</div>;
}

function downloadProfile(agent: AgentProfile, revision?: ProfileRevision) {
  const selected = revision ?? { name: agent.name, purpose: agent.purpose, version: agent.profileVersion, profileMarkdown: agent.profileMarkdown };
  const content = `---\nid: ${JSON.stringify(agent.slug)}\nname: ${JSON.stringify(selected.name)}\nversion: ${selected.version}\npurpose: ${JSON.stringify(selected.purpose)}\n---\n\n${selected.profileMarkdown}\n`;
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `${agent.slug}-v${selected.version}.md`;
  document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}

export default function Agents({ models, disabled = false }: { models: string[]; disabled?: boolean }) {
  const query = useQuery({ queryKey: ['forge-agent-profiles'], queryFn: () => apiGet<{ agents: AgentProfile[]; observedAt: string }>(api), retry: false });
  const [active, setActive] = useState<AgentProfile | null>(null);
  const [creating, setCreating] = useState(false), [draft, setDraft] = useState<ProfileDraft>(emptyDraft);
  const [settings,setSettings]=useState<AgentExecutionSettings>(defaultSettings);
  const [provider, setProvider] = useState<Provider>(null), [model, setModel] = useState('');
  const [preview, setPreview] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [history, setHistory] = useState<ProfileRevision[] | null>(null), [historical, setHistorical] = useState<ProfileRevision | null>(null);
  const [search, setSearch] = useState('');
  const profileDirty = creating || !!active && (draft.name !== active.name || draft.purpose !== active.purpose || draft.markdown !== active.profileMarkdown);
  const assignmentDirty = !!active && (provider !== active.provider || (model.trim() || null) !== active.model);
  const settingsDirty=!!active && JSON.stringify(settings)!==JSON.stringify(active.executionSettings??defaultSettings);
  const dirty = profileDirty || assignmentDirty || settingsDirty;
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', prevent);
    const navigate = (event: MouseEvent) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || !(event.target instanceof Element)) return;
      const link = event.target.closest<HTMLAnchorElement>('a[href]');
      if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
      const target = new URL(link.href, window.location.href);
      if (target.origin === window.location.origin && target.pathname !== window.location.pathname && !window.confirm('Discard unsaved agent changes?')) { event.preventDefault(); event.stopPropagation(); }
    };
    document.addEventListener('click', navigate, true);
    return () => { window.removeEventListener('beforeunload', prevent); document.removeEventListener('click', navigate, true); };
  }, [dirty]);
  function select(agent: AgentProfile | null, create = false) {
    if (dirty && !window.confirm('Discard unsaved agent changes?')) return;
    setActive(agent); setCreating(create); setDraft(agent ? { name: agent.name, purpose: agent.purpose, markdown: agent.profileMarkdown } : emptyDraft());
    setSettings(agent?.executionSettings??defaultSettings);
    setProvider(agent?.provider ?? null); setModel(agent?.model ?? ''); setHistory(null); setHistorical(null); setPreview(false); setError(''); setNotice('');
  }
  async function mutate(path: string, body: object, kind: 'profile' | 'assignment' | 'status' | 'duplicate' | 'delete' | 'settings') {
    if (busy || disabled) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await apiPost<AgentProfile | { deleted: boolean; id: string }>(path, body);
      await query.refetch();
      if (kind === 'delete') { setActive(null); setCreating(false); setHistory(null); setHistorical(null); setNotice('Agent deleted. Its profile history is retained.'); }
      else {
        const agent = result as AgentProfile;
        setActive(agent); setCreating(false);
        if(kind==='settings'||kind==='duplicate')setSettings(agent.executionSettings??defaultSettings);
        if (kind === 'profile' || kind === 'duplicate') setDraft({ name: agent.name, purpose: agent.purpose, markdown: agent.profileMarkdown });
        if (kind === 'assignment' || kind === 'duplicate') { setProvider(agent.provider); setModel(agent.model ?? ''); }
        setHistory(null); setHistorical(null); setNotice(kind === 'settings' ? 'Execution settings saved. Existing runs keep their frozen settings.' : kind === 'assignment' ? 'Model assignment saved. Profile version unchanged.' : kind === 'status' ? 'Agent status saved.' : kind === 'duplicate' ? 'Agent duplicated with profile v0.1.0.' : 'Agent profile saved.');
      }
    } catch (failure) { setError(errorMessages(failure).join(' ')); }
    finally { setBusy(false); }
  }
  function saveProfile(event: FormEvent) {
    event.preventDefault();
    const body = { name: draft.name.trim(), purpose: draft.purpose.trim(), profileMarkdown: draft.markdown.trim() };
    void mutate(creating ? api : `${api}/${active!.id}/profile`, creating ? { ...body, provider, model: model.trim() || null, enabled: true, executionSettings:settings } : { ...body, expectedRevision: active!.revision }, 'profile');
  }
  async function showHistory() {
    if (!active || busy || disabled) return;
    setBusy(true); setError('');
    try { const result = await apiGet<ProfileRevision[]>(`${api}/${active.id}/history`); setHistory(result); setHistorical(null); }
    catch (failure) { setError(errorMessages(failure).join(' ')); }
    finally { setBusy(false); }
  }
  async function reloadSaved() {
    if (!active || busy || disabled) return;
    setBusy(true);
    try {
      const result = await query.refetch();
      if (result.error) throw result.error;
      const saved = result.data?.agents.find(item => item.id === active.id);
      if (saved) select(saved);
      else setError('Agent is no longer available. Close this profile and refresh the list.');
    } catch (failure) { setError(errorMessages(failure).join(' ')); }
    finally { setBusy(false); }
  }
  const agents = query.isError ? [] : query.data?.agents ?? [];
  const visible = agents.filter(agent => `${agent.name} ${agent.purpose}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="factory-stack">
    <section className="card factory-card">
      <div className="factory-section-heading"><div><h2>Agent profiles</h2><p>Define each agent’s role and instructions, then assign the AI model that will use its profile.</p></div><button className="btn btn-primary" disabled={busy || disabled} onClick={() => select(null, true)}>Create agent</button></div>
      <div className="agent-directory-body">
        <label className="agent-search">Find an agent<input className="input" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search names and purposes" /></label>
        {query.isPending && <p role="status">Loading agent profiles…</p>}
        {query.error && <p className="factory-alert factory-alert-error" role="alert">{errorMessages(query.error).join(' ')}</p>}
        {!query.isPending && !query.error && !visible.length && <p className="factory-muted">{agents.length ? 'No agents match this search.' : 'No agents yet. Create an agent to define its profile.'}</p>}
        <div className="agent-directory">{visible.map(agent => <button key={agent.id} className="agent-directory-card" aria-pressed={active?.id === agent.id} disabled={busy || disabled} onClick={() => select(agent)}>
          <span className="agent-card-heading"><strong>{agent.name}</strong><span className="badge">v{agent.profileVersion}</span></span><span className="agent-card-purpose">{agent.purpose}</span>
          <span className="agent-card-footer"><span>{agent.provider ? `${providerNames[agent.provider]} · ${agent.model ?? 'Provider default'}` : 'Model unassigned'}</span><span className={agent.enabled ? 'agent-enabled' : 'factory-muted'}>{agent.enabled ? 'Enabled' : 'Disabled'}</span></span>
        </button>)}</div>
      </div>
    </section>
    {notice && <p className="factory-alert" role="status">{notice}</p>}
    {error && <div className="factory-alert factory-alert-error" role="alert"><p>{error}</p>{active && <button className="btn" disabled={busy || disabled} onClick={() => void reloadSaved()}>Reload saved profile</button>}</div>}
    {(creating || active) && <section className="card factory-card agent-editor" aria-label="Agent profile editor">
      <div className="factory-section-heading"><div><h2>{creating ? 'Create agent' : active!.name}</h2><p>{creating ? 'New profiles start at v0.1.0.' : `Profile v${active!.profileVersion} · Updated ${stamp(active!.updatedAt)}`}</p></div><button type="button" className="btn" disabled={busy} onClick={() => select(null)}>Close profile</button></div>
      <div className="agent-editor-layout">
        <form className="agent-profile-form" onSubmit={saveProfile}>
          <label>Name<input aria-label="Name" className="input" required maxLength={120} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} disabled={busy || disabled} /></label>
          <label>Purpose<input aria-label="Purpose" className="input" required maxLength={600} value={draft.purpose} onChange={event => setDraft({ ...draft, purpose: event.target.value })} disabled={busy || disabled} /></label>
          <div className="agent-profile-toolbar"><strong>Markdown profile</strong><div className="factory-button-group"><button type="button" className="btn" aria-pressed={!preview} onClick={() => setPreview(false)}>Edit</button><button type="button" className="btn" aria-pressed={preview} onClick={() => setPreview(true)}>Preview</button></div></div>
          {preview ? <div className="agent-profile-preview" aria-label="Markdown preview"><AgentMarkdown source={draft.markdown} /></div> : <label className="agent-markdown-label"><span className="agent-visually-hidden">Markdown profile</span><textarea aria-label="Markdown profile" className="input agent-markdown-input" rows={22} required maxLength={12000} value={draft.markdown} onChange={event => setDraft({ ...draft, markdown: event.target.value })} disabled={busy || disabled} spellCheck={false} /></label>}
          <div className="factory-button-group"><button className="btn btn-primary" disabled={busy || disabled || !profileDirty || !draft.name.trim() || !draft.purpose.trim() || !draft.markdown.trim()}>{busy ? 'Saving…' : creating ? 'Save agent' : 'Save profile'}</button>{active && <button type="button" className="btn" onClick={() => downloadProfile(active)}>Download Markdown</button>}</div>
          {profileDirty && <p className="factory-muted">Unsaved profile changes{creating ? '' : ' will create the next profile version'}.</p>}
        </form>
        <aside className="agent-settings" aria-label="Agent settings">
          <div className="agent-settings-section"><h3>Model assignment</h3><p className="factory-muted">Select which AI uses this profile. Changing the model preserves the profile version.</p>
            <label>AI provider<select aria-label="AI provider" className="input" value={provider ?? ''} disabled={busy || disabled} onChange={event => { setProvider((event.target.value || null) as Provider); setModel(''); }}><option value="">Unassigned</option><option value="ollama">Local Ollama</option><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
            <label>{provider === 'ollama' ? 'Installed model' : 'Model ID'}{provider === 'ollama' ? <select aria-label="Installed model" className="input" value={model} disabled={busy || disabled} onChange={event => setModel(event.target.value)}><option value="">Provider default</option>{model && !models.includes(model) && <option value={model}>{model} (not currently installed)</option>}{models.map(name => <option key={name} value={name}>{name}</option>)}</select> : <input aria-label="Model ID" className="input" value={model} disabled={!provider || busy || disabled} maxLength={160} placeholder="Provider default" onChange={event => setModel(event.target.value)} />}</label>
            {provider && provider !== 'ollama' && <p className="factory-muted">Leave blank for the provider default. An explicit model ID is saved as your selection; availability is verified when used.</p>}
            {active && <button className="btn" disabled={busy || disabled || !assignmentDirty} onClick={() => void mutate(`${api}/${active.id}/assignment`, { expectedRevision: active.revision, provider, model: model.trim() || null }, 'assignment')}>Save model assignment</button>}
          </div>
          <AgentExecutionSettingsEditor value={settings} onChange={setSettings} disabled={busy||disabled} provider={provider} model={model}/>
          {active&&<div className="agent-settings-section"><p className="factory-muted">Settings revision {active.executionRevision??1}</p><button className="btn" disabled={busy||disabled||!settingsDirty} onClick={()=>void mutate(`${api}/${active.id}/execution`,{expectedRevision:active.revision,executionSettings:settings},'settings')}>Save execution settings</button></div>}
          {active && <><div className="agent-settings-section"><h3>Profile history</h3><p className="factory-muted">Saved revisions remain available when instructions change.</p><button className="btn" disabled={busy || disabled} onClick={() => void showHistory()}>Revision history</button><dl className="factory-details"><dt>Profile file</dt><dd><code>{active.slug}.md</code></dd><dt>Current version</dt><dd>v{active.profileVersion}</dd><dt>Checksum</dt><dd className="agent-checksum"><code>{active.profileChecksum}</code></dd></dl></div>
          <div className="agent-settings-section"><h3>Manage agent</h3><p className="factory-muted">{active.enabled ? 'Enabled for future assignment.' : 'Disabled for future assignment.'}</p><div className="agent-management-actions"><button className="btn" disabled={busy || disabled} onClick={() => void mutate(`${api}/${active.id}/status`, { expectedRevision: active.revision, enabled: !active.enabled }, 'status')}>{active.enabled ? 'Disable agent' : 'Enable agent'}</button><button className="btn" disabled={busy || disabled} onClick={() => { if (dirty && !window.confirm('Duplicate the saved profile and discard unsaved changes?')) return; void mutate(`${api}/${active.id}/duplicate`, { expectedRevision: active.revision, name: `${active.name.slice(0, 110)} copy` }, 'duplicate'); }}>Duplicate agent</button><button className="btn agent-delete" disabled={busy || disabled} onClick={() => { if (window.confirm(`Delete ${active.name}? The agent will leave this list. Its saved profile history will be retained.`)) void mutate(`${api}/${active.id}/delete`, { expectedRevision: active.revision }, 'delete'); }}>Delete agent</button></div></div></>}
        </aside>
      </div>
      {history && <section className="agent-history" aria-label="Profile revision history"><div className="agent-profile-toolbar"><h3>Revision history</h3><button className="btn" onClick={() => { setHistory(null); setHistorical(null); }}>Close history</button></div><div className="agent-history-list">{history.map(item => <button className="btn" key={item.version} aria-pressed={historical?.version === item.version} onClick={() => setHistorical(item)}>v{item.version} · {stamp(item.createdAt)}</button>)}</div>{historical && <div className="agent-history-detail"><h3>{historical.name} · v{historical.version}</h3><p>{historical.purpose}</p><p className="factory-muted">Saved by {historical.createdBy} · {stamp(historical.createdAt)}</p><AgentMarkdown source={historical.profileMarkdown} /><button className="btn" onClick={() => downloadProfile(active!, historical)}>Download revision</button></div>}</section>}
    </section>}
    <AgentMetrics agents={agents}/>
  </div>;
}
