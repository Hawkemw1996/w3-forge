import { FormEvent, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bot, MessageSquare, Send, Square, RefreshCw, FlaskConical, ExternalLink, LogOut, Plus } from 'lucide-react';
import { ApiError, apiGet, apiPost, errorMessages } from '../lib/authApi';
import { appPath } from '../../../../shared/navigation';
import { APP_VERSION } from '../lib/appInfo';
import { sendChat, type Message } from './chatStream';
import './workspace.css';

interface Models { models: Array<{ name: string; parameterSize: string | null; size: number | null }>; defaultModel: string | null }
interface Stage { id: string; status: string; durationMs: number; counts?: { tests: number; passed: number; failed: number; skipped: number } }
interface Inventory {
  host: string; observedAt: string; available: boolean; message: string | null;
  environments: Array<{ id: string; name: string; image: string; state: string; status: string; createdAt: string | null;
    app: string | null; branch: string | null; commit: string | null; runId: string | null; purpose: string | null; ports: string[] }>;
  pipeline: { requestId: string; status: string; progress?: { totalElapsedMs: number; cacheStatus: string; stages: Stage[] } } | null;
  activeControl: { controlId: string; startedAt: string } | null;
}
const duration = (ms: number) => ms < 60000 ? Math.round(ms / 1000) + 's' : Math.floor(ms / 60000) + 'm ' + Math.round(ms % 60000 / 1000) + 's';
const stamp = (value: string) => new Date(value).toLocaleString();

export default function ForgeWorkspace({ name, signOut, signingOut, signOutError }: {
  name: string; signOut(): Promise<void>; signingOut: boolean; signOutError: string;
}) {
  const models = useQuery({ queryKey: ['forge-models'], queryFn: () => apiGet<Models>('/api/forge/models'), retry: false });
  const inventory = useQuery({ queryKey: ['forge-environments'], queryFn: () => apiGet<Inventory>('/api/forge/environments'),
    refetchInterval: 5000, refetchOnWindowFocus: true, retry: false });
  const [model, setModel] = useState(''), [draft, setDraft] = useState(''), [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false), [chatError, setChatError] = useState(''), [tab, setTab] = useState<'chat' | 'environments'>('chat');
  const activePrompt = useRef(''), activeRequestId = useRef<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const controller = useRef<AbortController | null>(null), bottom = useRef<HTMLDivElement>(null), running = useRef(false);
  useEffect(() => {
    if (models.data && !models.data.models.some(item => item.name === model)) setModel(models.data.defaultModel ?? '');
  }, [models.data]);
  useEffect(() => () => { controller.current?.abort(); }, []);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest' }); }, [messages]);
  const authError = [models.error, inventory.error].find(error => error instanceof ApiError && [401, 403].includes(error.status));
  const data = inventory.isError ? null : inventory.data;
  function stopGeneration() {
    const active = controller.current; if (!active) return;
    const requestId = activeRequestId.current; activeRequestId.current = null;
    if (requestId) {
      setStopping(true);
      void apiPost('/api/forge/chat/' + requestId + '/cancel').catch(() => undefined).finally(() => setStopping(false));
    }
    active.abort(); controller.current = null; running.current = false; setBusy(false);
    setChatError('Response stopped. You can retry your message.'); setDraft(activePrompt.current);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (running.current || stopping || !draft.trim() || !model || !!authError) return;
    const history: Message[] = messages.filter(message => !message.incomplete);
    // A stopped/failed assistant turn is removed from context; its user can be retried.
    if (history[history.length - 1]?.role === 'user') history.pop();
    const next: Message[] = [...history, { role: 'user', content: draft.trim() }];
    if (next.length > 39 || next.reduce((n, message) => n + message.content.length, 0) > 32000) {
      setChatError('This conversation has reached its limit. Start a new chat to continue.'); return;
    }
    running.current = true; setBusy(true); setChatError(''); setDraft('');
    const abort = new AbortController(); controller.current = abort; activeRequestId.current = null; activePrompt.current = next[next.length - 1].content;
    setMessages([...next, { role: 'assistant', content: '', incomplete: true, model }]);
    try {
      await sendChat(model, next, abort.signal, delta => {
        if (controller.current !== abort || abort.signal.aborted) return;
        setMessages(current => {
        const last = current[current.length - 1];
        return [...current.slice(0, -1), { ...last, content: last.content + delta }];
        });
      }, requestId => { if (controller.current === abort) activeRequestId.current = requestId; });
      if (controller.current !== abort) return;
      setMessages(current => current.map((message, index) => index === current.length - 1 ? { ...message, incomplete: false } : message));
    } catch (error) {
      if (controller.current !== abort) return;
      setChatError(abort.signal.aborted ? 'Response stopped. You can retry your message.' : errorMessages(error).join(' '));
      setDraft(next[next.length - 1].content);
    } finally { if (controller.current === abort) { activeRequestId.current = null; controller.current = null; running.current = false; setBusy(false); } }
  }
  return <div className="forge-workspace">
    <header className="forge-header">
      <a href="/forge/" className="forge-brand"><span className="forge-mark">W3</span><span><strong>W3 Forge</strong><small>Engineering workspace · v{APP_VERSION}</small></span></a>
      <nav aria-label="Workspace"><button className={tab === 'chat' ? 'selected' : ''} onClick={() => setTab('chat')}><MessageSquare size={16} /> Chat</button>
        <button className={tab === 'environments' ? 'selected' : ''} onClick={() => setTab('environments')}><FlaskConical size={16} /> Test environments</button></nav>
      <div className="forge-account"><span>{name}</span><a className="btn" href="/admin/">Admin Console <ExternalLink size={13} /></a>
        <button className="btn" aria-label="Sign out" disabled={signingOut} onClick={() => void signOut()}><LogOut size={15} /></button></div>
    </header>
    {(signOutError || authError) && <div role="alert" className="forge-error">{signOutError || 'Your Forge access could not be verified.'} {authError && <a href={appPath('/login')}>Sign in again</a>}</div>}
    <main className={'forge-grid forge-tab-' + tab}>
      <section className="forge-chat forge-panel" aria-label="Ollama chat">
        <div className="forge-panel-heading"><div><span className="forge-eyebrow">LOCAL INTELLIGENCE</span><h1>What are we building?</h1><p>Chat with the models installed on Forge.</p></div>
          <button className="btn" disabled={busy || !messages.length} onClick={() => { setMessages([]); setDraft(''); setChatError(''); }}><Plus size={14} /> New chat</button></div>
        <div className="forge-model"><Bot size={18} /><label htmlFor="forge-model">Model</label>
          <select id="forge-model" value={model} disabled={busy || models.isFetching || !!models.error} onChange={event => setModel(event.target.value)}>
            {!models.data?.models.length && <option value="">{models.isPending ? 'Connecting to Ollama…' : 'No models available'}</option>}
            {models.data?.models.map(item => <option key={item.name} value={item.name}>{item.name}{item.size ? ' · ' + (item.size / 1e9).toFixed(1) + ' GB' : ''}</option>)}
          </select><button className="btn" aria-label="Refresh models" disabled={busy || models.isFetching} onClick={() => void models.refetch()}><RefreshCw size={14} /></button>
        </div>
        {models.error && <div role="alert" className="forge-error">{errorMessages(models.error).join(' ')}</div>}
        {models.data && models.data.models.length === 0 && <div className="forge-notice">No installed models were found. Add a model to Ollama on Forge, then refresh.</div>}
        <div className="forge-messages" role="log" aria-label="Conversation" aria-busy={busy}>
          {!messages.length && <div className="forge-empty-chat"><span className="forge-orbit"><Bot size={30} /></span><h2>Your Forge assistant</h2>
            <p>Work through code, plan a feature, or ask a technical question.</p>
            <div className="forge-suggestions">{['Help me plan a W3 app feature.', 'Explain this code and suggest improvements.', 'Help me troubleshoot a failing test.'].map(prompt =>
              <button key={prompt} onClick={() => setDraft(prompt)}>{prompt}</button>)}</div>
          </div>}
          {messages.map((message, index) => <article key={index} className={'forge-message ' + message.role}>
            <div className="forge-message-label">{message.role === 'user' ? 'You' : message.model || model || 'Forge assistant'}{message.incomplete && !busy ? ' · Incomplete' : ''}</div>
            <div className="forge-message-content">{message.content || (busy ? 'Thinking…' : 'No response received.')}</div>
          </article>)}<div ref={bottom} />
        </div>
        <form className="forge-composer" onSubmit={event => void submit(event)}>
          {chatError && <p role="alert" className="forge-error">{chatError}</p>}
          <label className="sr-only" htmlFor="forge-prompt">Message Forge</label>
          <textarea id="forge-prompt" value={draft} maxLength={8000} placeholder="Message Forge…" rows={3} disabled={busy || !!authError}
            onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(event as unknown as FormEvent); } }} />
          <div className="forge-composer-footer"><small>Conversation stays in this tab. Chat responses do not run commands.</small>
            {busy ? <button type="button" className="btn" onClick={stopGeneration}><Square size={13} /> Stop</button>
              : <button className="btn btn-primary" type="submit" disabled={stopping || !draft.trim() || !model || !!models.error || !!authError}><Send size={14} /> Send</button>}</div>
        </form>
      </section>
      <section className="forge-environments forge-panel" aria-label="Codex test environments">
        <div className="forge-panel-heading"><div><span className="forge-eyebrow">CODEX TESTING</span><h2>Test environments</h2><p>Live observations from the Forge host.</p></div>
          <button className="btn" aria-label="Refresh environments" disabled={inventory.isFetching} onClick={() => void inventory.refetch()}><RefreshCw size={14} /></button></div>
        <div className="forge-inventory-body">
          {inventory.isPending && <p className="forge-muted">Checking test environments…</p>}
          {inventory.error && <div role="alert" className="forge-error">{errorMessages(inventory.error).join(' ')} Previous observations are not current.</div>}
          {data && <><div className="forge-host"><span className="forge-status-dot" data-active={data.available} /><strong>{data.host}</strong>
            <span>{data.available ? data.environments.filter(item => item.state === 'running').length + ' running' : 'Unavailable'}</span></div>
            <p className="forge-caption">Observed {stamp(data.observedAt)} · Refreshes every 5 seconds</p>
            {!data.available && <div className="forge-notice">{data.message}</div>}
            {data.pipeline && <article className="forge-env-card"><div className="forge-env-title"><strong>Forge pipeline test</strong><span className="forge-state">{data.pipeline.status}</span></div>
              <code>{data.pipeline.requestId}</code>
              {data.pipeline.progress && <><p className="forge-caption">{duration(data.pipeline.progress.totalElapsedMs)} elapsed · {data.pipeline.progress.cacheStatus} cache</p>
                <ul className="forge-stages">{data.pipeline.progress.stages.map(stage => <li key={stage.id}><span>{stage.id}</span><strong>{stage.status}</strong><span>{duration(stage.durationMs)}</span>
                  {stage.counts && <small>{stage.counts.passed}/{stage.counts.tests} passed · {stage.counts.failed} failed · {stage.counts.skipped} skipped</small>}</li>)}</ul></>}
            </article>}
            {data.activeControl && !data.pipeline && <p className="forge-notice">Active admin operation: {data.activeControl.controlId}. Test progress is unavailable.</p>}
            {data.environments.map(environment => <article className="forge-env-card" key={environment.id}>
              <div className="forge-env-title"><strong>{environment.name}</strong><span className="forge-state" data-running={environment.state === 'running'}>{environment.state}</span></div>
              {environment.purpose && <p>{environment.purpose}</p>}<dl>
                <dt>App</dt><dd>{environment.app ?? 'Not reported'}</dd>
                <dt>Branch</dt><dd><code>{environment.branch ?? 'Not reported'}</code></dd>
                <dt>Commit</dt><dd><code>{environment.commit ?? 'Not reported'}</code></dd>
                <dt>Image</dt><dd>{environment.image}</dd><dt>Status</dt><dd>{environment.status}</dd>
                <dt>Created</dt><dd>{environment.createdAt ? stamp(environment.createdAt) : 'Not reported'}</dd>
                <dt>Container</dt><dd><code>{environment.id.slice(0, 12)}</code></dd>
                {environment.runId && <><dt>Run</dt><dd><code>{environment.runId}</code></dd></>}
                {!!environment.ports.length && <><dt>Ports</dt><dd>{environment.ports.join(', ')}</dd></>}
              </dl>
            </article>)}
            {data.available && !data.environments.length && <div className="forge-empty-env"><FlaskConical size={28} /><h3>No Codex test containers</h3><p>No labeled Codex test containers are present on this host.</p></div>}
          </>}
          <p className="forge-caption">Shows Codex test containers registered with Forge and the active Forge pipeline test. Other hosts and unregistered environments are not included. Container state does not confirm test results.</p>
          <a className="forge-admin-link" href="/admin/github">Open test controls in Admin Console <ExternalLink size={13} /></a>
        </div>
      </section>
    </main>
  </div>;
}
