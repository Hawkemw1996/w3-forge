import { FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Activity, ArrowRight, Bell, Bot, CheckCircle2, ChevronRight, ClipboardList, Copy, Download, ShieldCheck, FileText, FlaskConical, FolderKanban, LayoutDashboard, Menu, MessageSquare, Plus, RefreshCw, X } from 'lucide-react';
import { W3SidebarBrand, W3SidebarFooter, W3SidebarNav, runtimeSidebarStatus } from '@shared/components';
import { ApiError, apiGet, apiPost, errorMessages } from '../lib/authApi';
import { appPath } from '../../../../shared/navigation';
import { factoryStatusLabels, factoryStatuses, type FactoryNotification, type FactoryProject, type FactoryPrompt, type FactoryRequest, type FactoryRuleRevision, type FactoryRun, type FactorySnapshot, type ForgeService, type ForgeServices } from './factoryApi';
import './factory-workspace.css';
import { ForgeHardwarePanel, ForgeHardwareSummary, type HardwareInventory } from './FactoryHardware';

interface Stage { id: string; status: string; durationMs: number; counts?: { tests: number; passed: number; failed: number; skipped: number } }
interface TestEnvironment {
  id: string; name: string; image: string; state: string; status: string; createdAt: string | null;
  app: string | null; branch: string | null; commit: string | null; runId: string | null; purpose: string | null; ports: string[];
}
interface EnvironmentInventory {
  host: string; observedAt: string; available: boolean; message: string | null; environments: TestEnvironment[];
  pipeline: { requestId: string; status: string; progress?: { totalElapsedMs: number; cacheStatus: string; stages: Stage[] } } | null;
  activeControl: { controlId: string; startedAt: string } | null;
}
interface Models { models: { name: string }[]; defaultModel: string | null }
type Mutate = (path: string, body: unknown) => Promise<boolean>;
const api = '/api/forge/factory';
const stamp = (value: string | null) => value ? new Date(value).toLocaleString() : 'Not reported';
const duration = (ms: number) => ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round(ms % 60000 / 1000)}s`;
const activeStates = new Set(['running', 'restarting', 'paused', 'created']);
const field = (form: HTMLFormElement, name: string) => String(new FormData(form).get(name) ?? '').trim();

function Status({ value }: { value: string }) {
  return <span className={`badge factory-status factory-status-${value}`}>{factoryStatusLabels[value as keyof typeof factoryStatusLabels] ?? value.split('_').join(' ')}</span>;
}
function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="factory-empty"><span className="factory-empty-icon"><FolderKanban size={24} /></span><h3>{title}</h3><p>{children}</p></div>;
}
function Section({ title, description, action, children, className = '' }: { title: string; description?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`card factory-card ${className}`}><div className="factory-section-heading"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>{children}</section>;
}
function ErrorBox({ error }: { error: unknown }) {
  return error ? <div role="alert" className="factory-alert factory-alert-error">{errorMessages(error).join(' ')}</div> : null;
}

export default function FactoryWorkspace({ assistant, signedInAs, onSignOut, signingOut, signOutError }: {
  assistant: ReactNode; signedInAs: string; onSignOut(): Promise<void>; signingOut: boolean; signOutError: string;
}) {
  const location = useLocation(), navigate = useNavigate();
  const [drawer, setDrawer] = useState(false), [busy, setBusy] = useState(false), [mutationError, setMutationError] = useState('');
  const [selectedRequest, setSelectedRequest] = useState<string | null>(null);
  const mainRef = useRef<HTMLDivElement>(null), drawerRef = useRef<HTMLElement>(null), menuRef = useRef<HTMLButtonElement>(null);
  const snapshot = useQuery({ queryKey: ['forge-factory'], queryFn: () => apiGet<FactorySnapshot>(api), retry: false, refetchInterval: 5000, refetchOnWindowFocus: true });
  const environments = useQuery({ queryKey: ['forge-environments'], queryFn: () => apiGet<EnvironmentInventory>('/api/forge/environments'), retry: false, refetchInterval: 5000, refetchOnWindowFocus: true });
  const services = useQuery({ queryKey: ['forge-services'], queryFn: () => apiGet<ForgeServices>('/api/forge/services'), retry: false, refetchInterval: 30000 });
  const hardware = useQuery({ queryKey: ['forge-hardware'], queryFn: () => apiGet<HardwareInventory>('/api/forge/hardware'), retry: false, refetchInterval: 10000 });
  const models = useQuery({ queryKey: ['forge-models'], queryFn: () => apiGet<Models>('/api/forge/models'), retry: false });
  const runtimeQuery = useQuery({ queryKey: ['admin', 'version'], queryFn: () => apiGet<{ version: string; nodeEnv?: string }>('/api/admin/version'), retry: false, refetchInterval: 60000 });
  const runtime = runtimeQuery.isError ? undefined : runtimeQuery.data;
  const runtimeVersion = runtime?.version ? 'v' + runtime.version.replace(/^v/, '') : undefined;
  const runtimeStatus = runtimeSidebarStatus(runtime?.nodeEnv);
  const data = snapshot.isError ? undefined : snapshot.data;
  const inventory = environments.isError ? undefined : environments.data;
  const serviceData = services.isError ? undefined : services.data;
  const hardwareData = hardware.isError ? undefined : hardware.data;
  const authenticationError = [snapshot.error, environments.error, services.error, hardware.error, models.error].find(error => error instanceof ApiError && [401, 403].includes(error.status));
  const items = [
    { to: '.', label: 'Dashboard', icon: LayoutDashboard, end: true },
    { to: 'projects', label: 'Projects', icon: FolderKanban },
    { to: 'requests', label: 'Requests', icon: ClipboardList },
    { to: 'environments', label: 'Test Environments', icon: FlaskConical },
    { to: 'hardware', label: 'Hardware', icon: Activity },
    { to: 'agents', label: 'Agents & AI', icon: Bot },
    { to: 'assistant', label: 'Forge Assistant', icon: MessageSquare },
    { to: 'updates', label: 'Updates', icon: Bell },
  ];
  const segment = location.pathname.replace(/\/$/, '').split('/').slice(-1)[0];
  const assistantVisible = segment === 'assistant';
  const pageTitle = items.find(item => item.to === segment)?.label ?? 'Dashboard';
  const unread = data?.notifications.filter(item => !item.read).length ?? 0;
  useEffect(() => {
    if (!drawer) return;
    const main = mainRef.current, previousOverflow = document.body.style.overflow;
    main?.setAttribute('inert', ''); document.body.style.overflow = 'hidden';
    const controls = () => Array.from(drawerRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex="0"]') ?? []).filter(item => !item.hasAttribute('hidden'));
    controls()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setDrawer(false); }
      if (event.key !== 'Tab') return;
      const elements = controls(), first = elements[0], last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !drawerRef.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !drawerRef.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    const media = window.matchMedia('(min-width: 768px)');
    const resize = () => { if (media.matches) setDrawer(false); };
    document.addEventListener('keydown', keydown); media.addEventListener('change', resize);
    return () => { main?.removeAttribute('inert'); document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', keydown); media.removeEventListener('change', resize); menuRef.current?.focus(); };
  }, [drawer]);
  async function mutate(path: string, body: unknown) {
    if (busy || authenticationError) return false;
    setBusy(true); setMutationError('');
    try { await apiPost(api + path, body); await snapshot.refetch(); return true; }
    catch (error) { setMutationError(error instanceof ApiError && error.status === 409 ? 'This item changed or the FIFO queue is not ready for this action. Refresh, review its latest state, and try again.' : errorMessages(error).join(' ')); return false; }
    finally { setBusy(false); }
  }
  function openRequest(id: string) { setSelectedRequest(id); navigate('requests'); }
  const refresh = () => { setMutationError(''); void snapshot.refetch(); void environments.refetch(); void services.refetch(); void hardware.refetch(); void runtimeQuery.refetch(); };
  return <div className={`factory-workspace${drawer ? ' factory-drawer-open' : ''}`}>
    {drawer && <button className="factory-drawer-backdrop" aria-label="Close navigation" onClick={() => setDrawer(false)} tabIndex={-1} />}
    <aside ref={drawerRef} className="factory-sidebar w3-sidebar" role={drawer ? 'dialog' : undefined} aria-modal={drawer || undefined} aria-label="W3 Forge navigation">
      <div className="factory-sidebar-desktop-brand"><W3SidebarBrand title="W3 Forge" subtitle="Software Factory" version={runtimeVersion} status={runtimeStatus} /></div>
      <div className="factory-sidebar-mobile-brand"><W3SidebarBrand title="W3 Forge" subtitle="Software Factory" version={runtimeVersion} status={runtimeStatus} compact /><button type="button" className="btn btn-ghost" onClick={() => setDrawer(false)} aria-label="Close navigation"><X size={18} /></button></div>
      <W3SidebarNav items={items} sectionLabel="W3 Forge" testId="sidebar-nav" onNavigate={() => setDrawer(false)} />
      <W3SidebarFooter signedInAs={signedInAs} footerHref="/admin/" footerLabel="Admin Console" footerIcon={ShieldCheck} onLogout={onSignOut} logoutPending={signingOut} version={runtimeVersion} status={runtimeStatus} />
    </aside>
    <div className="factory-main" ref={mainRef}>
      <header className="factory-topbar">
        <button ref={menuRef} type="button" className="btn factory-open-navigation" aria-label="Open navigation" aria-expanded={drawer} onClick={() => setDrawer(true)}><Menu size={18} /></button>
        <div className="factory-topbar-title"><div className="factory-app-eyebrow">W3 Forge</div><div className="factory-active-page">{pageTitle}</div></div>
        <div className="factory-topbar-actions">{runtimeVersion && <span className="badge badge-gold" data-testid="version-badge">{runtimeVersion}</span>}<Link className="factory-notification-link" to="updates" aria-label={'Updates, ' + unread + ' unread'}><Bell size={18} />{unread > 0 && <span>{unread}</span>}</Link><button type="button" className="btn" disabled={snapshot.isFetching || busy} onClick={refresh}><RefreshCw size={14} /><span>Refresh</span></button></div>
      </header>
      <main id="factory-content" className="factory-content">
        {(signOutError || mutationError) && <div className="factory-alert factory-alert-error" role="alert">{signOutError || mutationError}</div>}
        {authenticationError && <div className="factory-alert factory-alert-error" role="alert">Your Forge access could not be verified. <a href={appPath('/login')}>Sign in again</a>.</div>}
        <div className="factory-page-heading"><div><h1>{pageTitle === 'Dashboard' ? 'Engineering overview' : pageTitle}</h1><p>{pageTitle === 'Dashboard' ? 'Every change starts with a project, follows its rules, and leaves a verified record.' : pageDescription(pageTitle)}</p></div>
          {pageTitle === 'Dashboard' && <Link className="btn btn-primary" to="requests"><Plus size={16} /> New request</Link>}</div>
        <Routes>
          <Route index element={<><ErrorBox error={snapshot.error} />{snapshot.isPending && <p className="factory-muted" role="status">Loading the software factory…</p>}{data && <Dashboard snapshot={data} inventory={inventory} services={serviceData?.services} hardware={hardwareData} onRequest={openRequest} />}<ErrorBox error={environments.error} /><ErrorBox error={services.error} /><ErrorBox error={hardware.error} /></>} />
          <Route path="projects" element={<><ErrorBox error={snapshot.error} />{data && <Projects projects={data.projects} mutate={mutate} busy={busy || !!authenticationError} />}</>} />
          <Route path="requests" element={<><ErrorBox error={snapshot.error} />{data && <Requests snapshot={data} selectedId={selectedRequest} onSelect={setSelectedRequest} mutate={mutate} busy={busy || !!authenticationError} models={models.isError ? [] : models.data?.models.map(item => item.name) ?? []} />}</>} />
          <Route path="environments" element={<><ErrorBox error={environments.error} />{environments.isPending && <p role="status">Checking test environments…</p>}{inventory && <Environments inventory={inventory} />}</>} />
          <Route path="hardware" element={<><ErrorBox error={hardware.error} />{hardware.isPending && <p role="status">Checking Forge hardware…</p>}{hardwareData && <ForgeHardwarePanel inventory={hardwareData} />}</>} />
          <Route path="agents" element={<><ErrorBox error={services.error} />{services.isPending && <p role="status">Checking AI services…</p>}{serviceData && <><ServiceCards services={serviceData.services} /><p className="factory-footnote">Observed {stamp(serviceData.observedAt)}. Connections are verified from Forge configuration and live observations. Credentials are managed on the server.</p></>}</>} />
          <Route path="assistant" element={null} />
          <Route path="updates" element={<><ErrorBox error={snapshot.error} />{data && <Updates notifications={data.notifications} runs={data.runs} onRequest={openRequest} mutate={mutate} busy={busy} />}</>} />
          <Route path="*" element={<Navigate to="." replace />} />
        </Routes>
        <section hidden={!assistantVisible} aria-label="Forge Assistant">{assistant}</section>
      </main>
    </div>
  </div>;
}

function pageDescription(title: string) {
  const descriptions: Record<string, string> = {
    Projects: 'Repositories, development branches, and versioned rules for every engineering project.',
    Requests: 'A FIFO feature queue with explicit planning, approval, evidence, and review.',
    'Test Environments': 'Live observations of registered Codex environments and Forge pipeline tests.',
    Hardware: 'CPU, memory, storage, and GPU hardware visible inside the Forge virtual machine.',
    'Agents & AI': 'See which services Forge can use and the capabilities each connection provides.',
    'Forge Assistant': 'Work through a question with the models installed on Forge.',
    Updates: 'Review changes in the factory and the evidence behind an update.',
  };
  return descriptions[title] ?? '';
}

function Dashboard({ snapshot, inventory, services, hardware, onRequest }: { snapshot: FactorySnapshot; inventory?: EnvironmentInventory; services?: ForgeService[]; hardware?: HardwareInventory; onRequest(id: string): void }) {
  const active = inventory?.environments.filter(item => activeStates.has(item.state)) ?? [];
  const queue = snapshot.requests.filter(item => !['cancelled', 'update_ready'].includes(item.status)).slice(0, 8);
  const attention = snapshot.requests.filter(item => ['awaiting_approval', 'review', 'blocked'].includes(item.status));
  const metrics = [{ label: 'Queued requests', value: snapshot.metrics.queued, icon: ClipboardList }, { label: 'Work in progress', value: snapshot.metrics.active, icon: Activity }, { label: 'In testing', value: snapshot.metrics.testing, icon: FlaskConical }, { label: 'Updates ready', value: snapshot.metrics.ready, icon: CheckCircle2 }, { label: 'Need attention', value: attention.length, icon: Bell }];
  return <>
    <div className="factory-metrics">{metrics.map(item => <div className="card factory-metric" key={item.label}><span>{item.label}<item.icon size={17} /></span><strong>{item.value}</strong></div>)}</div>
    <div className="factory-process" aria-label="Factory workflow">{['Request', 'Plan', 'Approval', 'Development', 'Testing', 'Review', 'Update ready'].map((step, index) => <span key={step}><i>{index + 1}</i>{step}{index < 6 && <ChevronRight size={14} />}</span>)}</div>
    <div className="factory-dashboard-grid"><div className="factory-stack">
      <Section title="Feature queue" description="Oldest requests first. Each project follows its own FIFO order." action={<Link to="requests" className="factory-text-link">View all <ArrowRight size={14} /></Link>}>
        <RequestTable requests={queue} onSelect={onRequest} />
      </Section>
      <Section title="Active test environments" description={inventory ? `${inventory.host} · observed ${stamp(inventory.observedAt)}` : 'Environment observations are unavailable.'} action={<Link to="environments" className="factory-text-link">View details <ArrowRight size={14} /></Link>}>
        {!inventory ? <div className="factory-inline-empty">No current observation available.</div> : !inventory.available ? <div className="factory-alert">{inventory.message || 'The environment inventory is unavailable.'}</div> : active.length ? <EnvironmentTable environments={active.slice(0, 5)} /> : <div className="factory-inline-empty">No active registered test environments.</div>}
        {inventory?.pipeline && <div className="factory-pipeline-summary"><FlaskConical size={16} /><strong>Forge pipeline</strong><Status value={inventory.pipeline.status} /><code>{inventory.pipeline.requestId}</code></div>}
      </Section>
    </div><div className="factory-stack">
      <Section title="Needs your attention" description="Approvals, review, and blocked work.">
        {attention.length ? <div className="factory-attention-list">{attention.slice(0, 5).map(item => <button key={item.id} onClick={() => onRequest(item.id)}><span><strong>{item.title}</strong><small>{item.projectName} · #{item.sequence}</small></span><Status value={item.status} /></button>)}</div> : <div className="factory-inline-empty">No requests currently need your attention.</div>}
      </Section>
      <Section title="AI services" action={<Link className="factory-text-link" to="agents">Manage visibility <ArrowRight size={14} /></Link>}>
        <div className="factory-service-summary">{services ? services.map(service => <div key={service.id}><span className={`factory-service-dot factory-service-${service.status}`} /><strong>{service.name}</strong><span>{service.status === 'not_configured' ? 'Setup needed' : service.status === 'observed' ? 'Test activity observed' : service.status === 'available' ? 'Available' : 'Unavailable'}</span></div>) : <div className="factory-inline-empty">Service status is unavailable.</div>}</div>
      </Section>
      <ForgeHardwareSummary inventory={hardware} />
      <Section title="Recent updates"><div className="factory-attention-list">{snapshot.notifications.slice(0, 3).map(item => <button key={item.id} onClick={() => onRequest(item.requestId)}><span><strong>{item.title}</strong><small>{stamp(item.createdAt)}</small></span><ChevronRight size={15} /></button>)}{!snapshot.notifications.length && <div className="factory-inline-empty">Factory activity will appear here.</div>}</div></Section>
    </div></div>
    <p className="factory-footnote">Factory snapshot observed {stamp(snapshot.observedAt)}. Update ready means reviewed and packaged; deployment remains an owner action.</p>
  </>;
}

function RequestTable({ requests, onSelect, selectedId }: { requests: FactoryRequest[]; onSelect(id: string): void; selectedId?: string | null }) {
  if (!requests.length) return <Empty title="Your next change starts here">Create a project and add a feature request to start its queue.</Empty>;
  return <div className="factory-table-scroll"><table className="factory-table"><thead><tr><th scope="col">Queue</th><th scope="col">Request</th><th scope="col">Project</th><th scope="col">Status</th><th scope="col">Rules</th></tr></thead><tbody>{requests.map(item => <tr key={item.id} data-selected={selectedId === item.id}><td className="factory-queue-number">#{item.sequence}</td><td><button className="factory-table-link" onClick={() => onSelect(item.id)}>{item.title}</button><small>{stamp(item.createdAt)}</small></td><td>{item.projectName}</td><td><Status value={item.status} /></td><td><span className="factory-rules-tag"><FileText size={13} />v{item.rulesVersion}</span></td></tr>)}</tbody></table></div>;
}

function Projects({ projects, mutate, busy }: { projects: FactoryProject[]; mutate: Mutate; busy: boolean }) {
  const [create, setCreate] = useState(false), [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = projects.find(item => item.id === selectedId) ?? projects[0];
  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget;
    if (await mutate('/projects', { name: field(form, 'name'), appId: field(form, 'appId'), repositoryUrl: field(form, 'repositoryUrl'), branch: field(form, 'branch'), description: field(form, 'description'), rulesTitle: field(form, 'rulesTitle'), rulesMarkdown: field(form, 'rulesMarkdown') })) { form.reset(); setCreate(false); }
  }
  return <div className="factory-stack"><div className="factory-toolbar"><span className="factory-muted">{projects.length} {projects.length === 1 ? 'project' : 'projects'}</span><button className="btn btn-primary" onClick={() => setCreate(!create)} aria-expanded={create}><Plus size={15} /> New project</button></div>
    {create && <Section title="Create project" description="Rules become the initial prompt contract for this project."><form className="factory-form" onSubmit={event => void createProject(event)}><fieldset disabled={busy}><div className="factory-form-grid"><label>Project name<input className="input" name="name" required maxLength={120} placeholder="W3 BuildCost" /></label><label>Application ID<input className="input" name="appId" required maxLength={64} placeholder="w3buildcost" pattern="[a-z][a-z0-9-]*" /></label><label>GitHub repository<input className="input" name="repositoryUrl" type="url" required maxLength={240} placeholder="https://github.com/owner/repository.git" /></label><label>Development branch<input className="input" name="branch" required maxLength={100} placeholder="dev/v0.4.4" /></label></div><label>Description<textarea className="input" name="description" rows={2} maxLength={4000} /></label><label>Rules document title<input className="input" name="rulesTitle" required maxLength={160} defaultValue="Project engineering rules" /></label><label>Rules document <span className="factory-field-hint">Markdown · include architecture, scope, testing, and protected operations</span><textarea className="input factory-code-input" name="rulesMarkdown" required rows={10} maxLength={12000} placeholder={'# Project rules\n\n## Architecture\n\n## Development and testing\n\n## Approval requirements'} /></label><div className="factory-form-actions"><button className="btn" type="button" onClick={() => setCreate(false)}>Cancel</button><button className="btn btn-primary" type="submit">Create project</button></div></fieldset></form></Section>}
    {!projects.length && !create && <Section title="Projects"><Empty title="Give every project its own rules">Create a project to bind its repository, development branch, and prompt rules.</Empty></Section>}
    {!!projects.length && <div className="factory-project-layout"><div className="factory-project-list">{projects.map(project => <button className={`card factory-project-item${project.id === selected?.id ? ' selected' : ''}`} key={project.id} onClick={() => setSelectedId(project.id)}><span className="factory-project-avatar"><FolderKanban size={20} /></span><strong>{project.name}</strong><small>{project.appId}</small><span className="factory-rules-tag"><FileText size={13} /> Rules v{project.rulesVersion}</span></button>)}</div>{selected && <ProjectDetails key={`${selected.id}:${selected.rulesVersion}`} project={selected} mutate={mutate} busy={busy} />}</div>}
  </div>;
}

function ProjectDetails({ project, mutate, busy }: { project: FactoryProject; mutate: Mutate; busy: boolean }) {
  const [edit, setEdit] = useState(false), [history, setHistory] = useState(false);
  const revisions = useQuery({ queryKey: ['forge-rules', project.id, project.rulesVersion], queryFn: () => apiGet<FactoryRuleRevision[]>(`${api}/projects/${project.id}/rules`), enabled: history, retry: false });
  async function publish(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = event.currentTarget; if (await mutate(`/projects/${project.id}/rules`, { expectedVersion: project.rulesVersion, title: field(form, 'title'), content: field(form, 'content') })) setEdit(false); }
  return <Section title={project.name} description={project.description || 'Project engineering workspace.'} action={<span className="badge">{project.appId}</span>}><div className="factory-card-body"><dl className="factory-details"><dt>Repository</dt><dd><code>{project.repositoryUrl}</code></dd><dt>Development branch</dt><dd><code>{project.branch}</code></dd><dt>Current rules</dt><dd>Version {project.rulesVersion} · {project.rulesTitle}</dd><dt>Rules SHA-256</dt><dd><code>{project.rulesChecksum}</code></dd></dl><div className="factory-rule-note"><FileText size={18} /><p>Every new request pins the current rules revision. Publishing new rules keeps existing requests bound to the version they started with.</p></div><div className="factory-toolbar"><h3>{project.rulesTitle}</h3><div className="factory-button-group"><button className="btn" onClick={() => setHistory(!history)} aria-expanded={history}>Revision history</button><button className="btn" onClick={() => setEdit(!edit)} aria-expanded={edit}>Publish revision</button></div></div>
      {edit ? <form className="factory-form factory-form-unpadded" onSubmit={event => void publish(event)}><fieldset disabled={busy}><label>Rules title<input className="input" name="title" required maxLength={160} defaultValue={project.rulesTitle} /></label><label>Rules document<textarea className="input factory-code-input" name="content" rows={14} required maxLength={12000} defaultValue={project.rulesMarkdown} /></label><div className="factory-form-actions"><button className="btn" type="button" onClick={() => setEdit(false)}>Cancel</button><button className="btn btn-primary" type="submit">Publish v{project.rulesVersion + 1}</button></div></fieldset></form> : <pre className="factory-document">{project.rulesMarkdown}</pre>}
      {history && <div className="factory-history"><h3>Rules revision history</h3><ErrorBox error={revisions.error} />{revisions.isPending && <p role="status">Loading revisions…</p>}{revisions.data?.map(revision => <details key={revision.version}><summary>Version {revision.version} · {revision.title}<small>{stamp(revision.createdAt)} · {revision.createdBy}</small></summary><code className="factory-checksum">{revision.checksum}</code><pre className="factory-document">{revision.content}</pre></details>)}</div>}
    </div></Section>;
}

function Requests({ snapshot, selectedId, onSelect, mutate, busy, models }: { snapshot: FactorySnapshot; selectedId: string | null; onSelect(id: string | null): void; mutate: Mutate; busy: boolean; models: string[] }) {
  const [create, setCreate] = useState(false), [projectFilter, setProjectFilter] = useState(''), [statusFilter, setStatusFilter] = useState('');
  const requests = snapshot.requests.filter(item => (!projectFilter || item.projectId === projectFilter) && (!statusFilter || item.status === statusFilter));
  const selected = snapshot.requests.find(item => item.id === selectedId);
  async function submitRequest(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = event.currentTarget; if (await mutate('/requests', { projectId: field(form, 'projectId'), title: field(form, 'title'), description: field(form, 'description'), acceptanceCriteria: field(form, 'acceptanceCriteria') })) { form.reset(); setCreate(false); } }
  return <div className="factory-stack"><div className="factory-toolbar"><div className="factory-filters"><label>Project<select className="input" value={projectFilter} onChange={event => setProjectFilter(event.target.value)}><option value="">All projects</option>{snapshot.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label>Status<select className="input" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="">All statuses</option>{factoryStatuses.map(status => <option key={status} value={status}>{factoryStatusLabels[status]}</option>)}</select></label></div><button className="btn btn-primary" disabled={!snapshot.projects.length} onClick={() => setCreate(!create)} aria-expanded={create}><Plus size={15} /> New request</button></div>
    {!snapshot.projects.length && <div className="factory-alert">Create a project and its rules before submitting a feature request. <Link to="../projects">Open Projects</Link></div>}
    {create && <Section title="Submit feature request" description="The current project rules and development target will be pinned to this request."><form className="factory-form" onSubmit={event => void submitRequest(event)}><fieldset disabled={busy}><label>Project<select className="input" name="projectId" required defaultValue={projectFilter || snapshot.projects[0]?.id}>{snapshot.projects.map(project => <option key={project.id} value={project.id}>{project.name} · rules v{project.rulesVersion}</option>)}</select></label><label>Request title<input className="input" name="title" required maxLength={160} placeholder="What needs to change?" /></label><label>Feature description<textarea className="input" name="description" rows={4} required maxLength={4000} placeholder="Describe the problem, intended behavior, and scope." /></label><label>Acceptance criteria<textarea className="input" name="acceptanceCriteria" rows={4} required maxLength={4000} placeholder="Describe the observable conditions that make this change complete." /></label><div className="factory-form-actions"><button className="btn" type="button" onClick={() => setCreate(false)}>Cancel</button><button className="btn btn-primary" type="submit">Add to FIFO queue</button></div></fieldset></form></Section>}
    <Section title="Feature requests" description="Requests are shown in submission order. The next eligible request in each project can enter planning."><RequestTable requests={requests} selectedId={selectedId} onSelect={onSelect} /></Section>
    {selected && <RequestDetails key={`${selected.id}:${selected.revision}`} request={selected} runs={snapshot.runs.filter(run => run.requestId === selected.id)} mutate={mutate} busy={busy} models={models} onClose={() => onSelect(null)} />}
  </div>;
}

function RequestDetails({ request, runs, mutate, busy, models, onClose }: { request: FactoryRequest; runs: FactoryRun[]; mutate: Mutate; busy: boolean; models: string[]; onClose(): void }) {
  const latestDevelopment = [...runs].filter(run => run.stage === 'development' && run.commit).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const latestPassedTest = [...runs].filter(run => run.stage === 'testing' && run.status === 'passed' && run.commit).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const testedCommit = latestPassedTest?.commit ?? '';
  const [showPrompt, setShowPrompt] = useState(false), [copyState, setCopyState] = useState('');
  const [plan, setPlan] = useState(request.plan), [model, setModel] = useState(models[0] ?? ''), [drafting, setDrafting] = useState(false), [draftError, setDraftError] = useState(''), [draftReceipt, setDraftReceipt] = useState('');
  const [reason, setReason] = useState(''), [commit, setCommit] = useState(latestDevelopment?.commit ?? ''), [summary, setSummary] = useState(''), [command, setCommand] = useState('');
  const [exitCode, setExitCode] = useState('0'), [passed, setPassed] = useState(''), [failed, setFailed] = useState('0'), [artifact, setArtifact] = useState(''), [artifactChecksum, setArtifactChecksum] = useState('');
  const prompt = useQuery({ queryKey: ['forge-prompt', request.id, request.revision], queryFn: () => apiGet<FactoryPrompt>(`${api}/requests/${request.id}/prompt`), enabled: showPrompt, retry: false });
  useEffect(() => { if (!model && models.length) setModel(models[0]); }, [models, model]);
  useEffect(() => { setPlan(request.plan); }, [request.planVersion, request.plan]);
  async function action(actionName: string, extra: Record<string, unknown> = {}) {
    if (extra.evidence && typeof extra.evidence === 'object') {
      const evidence = { ...(extra.evidence as Record<string, unknown>) };
      if (typeof evidence.commit === 'string') evidence.commit = evidence.commit.trim().toLowerCase();
      if (typeof evidence.artifactChecksum === 'string') evidence.artifactChecksum = evidence.artifactChecksum.trim().toLowerCase();
      extra = { ...extra, evidence };
    }
    await mutate(`/requests/${request.id}/action`, { action: actionName, expectedRevision: request.revision, ...extra });
  }
  async function draftPlan() {
    if (!model || busy || drafting) return;
    setDrafting(true); setDraftError(''); setDraftReceipt('');
    try { const result = await apiPost<{ plan: string; model: string; promptChecksum: string }>(`${api}/requests/${request.id}/draft-plan`, { model, expectedRevision: request.revision }); setPlan(result.plan); setDraftReceipt(`Draft from ${result.model} · prompt SHA-256 ${result.promptChecksum}. Review and submit the plan to save it.`); }
    catch (error) { setDraftError(errorMessages(error).join(' ')); }
    finally { setDrafting(false); }
  }
  async function copyPrompt() { if (!prompt.data) return; try { await navigator.clipboard.writeText(prompt.data.prompt); setCopyState('Prompt copied.'); } catch { setCopyState('Clipboard unavailable. Select the prompt text or download it.'); } }
  function downloadPrompt() { if (!prompt.data) return; const url = URL.createObjectURL(new Blob([prompt.data.prompt], { type: 'text/plain;charset=utf-8' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `forge-request-${request.sequence}-prompt.txt`; anchor.click(); URL.revokeObjectURL(url); }
  const commitValid = /^[a-f0-9]{40}$/i.test(commit.trim());
  const actionBusy = busy || drafting;
  return <Section title={`#${request.sequence} · ${request.title}`} description={request.projectName} action={<button className="btn" onClick={onClose} aria-label="Close request details"><X size={16} /></button>}><div className="factory-card-body"><div className="factory-toolbar"><Status value={request.status} /><span className="factory-muted">Revision {request.revision} · opened {stamp(request.createdAt)}</span></div><p className="factory-prose">{request.description}</p><h3>Acceptance criteria</h3><p className="factory-prose">{request.acceptanceCriteria}</p><dl className="factory-details"><dt>Repository</dt><dd><code>{request.repositoryUrl}</code></dd><dt>Branch</dt><dd><code>{request.branch}</code></dd><dt>Pinned rules</dt><dd>Version {request.rulesVersion}</dd><dt>Rules SHA-256</dt><dd><code>{request.rulesChecksum}</code></dd></dl>
    {request.blockReason && <div className="factory-alert">Blocked: {request.blockReason}</div>}
    {!!request.plan && !['planning', 'awaiting_approval'].includes(request.status) && <details className="factory-run-receipt"><summary>Saved implementation plan · version {request.planVersion}</summary><pre className="factory-document">{request.plan}</pre></details>}
    <div className="factory-toolbar"><h3>Prompt contract</h3><button className="btn" onClick={() => setShowPrompt(!showPrompt)} aria-expanded={showPrompt}><FileText size={14} /> {showPrompt ? 'Hide prompt' : 'View full prompt'}</button></div>
    {showPrompt && <div className="factory-prompt"><ErrorBox error={prompt.error} />{prompt.isPending && <p role="status">Building pinned prompt…</p>}{prompt.data && <><div className="factory-button-group"><button className="btn" onClick={() => void copyPrompt()}><Copy size={14} /> Copy</button><button className="btn" onClick={downloadPrompt}><Download size={14} /> Download text</button></div><p className="factory-footnote">Prompt SHA-256 <code>{prompt.data.checksum}</code> · request revision {prompt.data.requestRevision} · rules v{prompt.data.rulesVersion}</p><pre className="factory-document">{prompt.data.prompt}</pre><p role="status" className="factory-muted">{copyState}</p></>}</div>}
    <div className="factory-workflow-actions"><h3>Next step</h3><p className="factory-muted">Each transition is explicit. Recording progress does not execute development commands or deploy an application.</p><fieldset disabled={actionBusy}>
      {request.status === 'queued' && <button className="btn btn-primary" onClick={() => void action('start_planning')}>Start planning <ArrowRight size={14} /></button>}
      {['planning', 'awaiting_approval'].includes(request.status) && <><label>Implementation plan<textarea className="input" value={plan} onChange={event => setPlan(event.target.value)} maxLength={10000} rows={9} placeholder="Define scope, development steps, tests, review, and delivery." /></label><div className="factory-planning-tools"><label>Local Ollama model<select className="input" value={model} onChange={event => setModel(event.target.value)} disabled={!models.length}>{!models.length && <option value="">No installed model available</option>}{models.map(item => <option key={item} value={item}>{item}</option>)}</select></label><button className="btn" disabled={!model || drafting} onClick={() => void draftPlan()}><Bot size={15} />{drafting ? 'Drafting…' : 'Draft with Ollama'}</button></div>{draftReceipt && <p className="factory-alert">{draftReceipt}</p>}{draftError && <div role="alert" className="factory-alert factory-alert-error">{draftError}</div>}<div className="factory-button-group"><button className="btn btn-primary" disabled={!plan.trim()} onClick={() => void action('submit_plan', { plan: plan.trim() })}>Submit plan for approval</button>{request.status === 'awaiting_approval' && <button className="btn" disabled={plan !== request.plan} onClick={() => void action('approve_plan')}>Approve saved plan</button>}</div></>}
      {request.status === 'development' && <><p className="factory-alert">Complete development in the approved branch, then record its exact commit before moving to testing.</p><label>Development commit<input className="input factory-code-input" value={commit} onChange={event => setCommit(event.target.value)} maxLength={40} placeholder="Full 40-character Git commit SHA" /></label><label>Development summary<textarea className="input" value={summary} onChange={event => setSummary(event.target.value)} maxLength={2000} rows={3} /></label><button className="btn btn-primary" disabled={!commitValid || !summary.trim()} onClick={() => void action('start_testing', { evidence: { commit: commit.trim(), summary: summary.trim() } })}>Record development and start testing</button></>}
      {request.status === 'testing' && <><p className="factory-alert">Administrator-reported test receipt. Record the actual command, commit, and results from the isolated test environment.</p><div className="factory-form-grid"><label>Tested commit<input className="input factory-code-input" value={commit} onChange={event => setCommit(event.target.value)} maxLength={40} placeholder="Full 40-character Git commit SHA" /></label><label>Validation command<input className="input factory-code-input" value={command} onChange={event => setCommand(event.target.value)} maxLength={1000} placeholder="npm run typecheck && npm test && npm run build" /></label><label>Exit code<input className="input" type="number" min={0} max={255} value={exitCode} onChange={event => setExitCode(event.target.value)} /></label><label>Tests passed<input className="input" type="number" min={0} value={passed} onChange={event => setPassed(event.target.value)} /></label><label>Tests failed<input className="input" type="number" min={0} value={failed} onChange={event => setFailed(event.target.value)} /></label></div><label>Test summary<textarea className="input" rows={3} maxLength={2000} value={summary} onChange={event => setSummary(event.target.value)} /></label><button className="btn btn-primary" disabled={!commitValid || !command.trim() || !summary.trim() || exitCode === '' || passed === '' || failed === ''} onClick={() => void action('submit_tests', { evidence: { commit: commit.trim(), command: command.trim(), exitCode: Number(exitCode), summary: summary.trim(), testsPassed: Number(passed), testsFailed: Number(failed) } })}>Record test results</button></>}
      {request.status === 'review' && <><p className="factory-alert">Reviewer attestation: confirm the acceptance criteria and test receipts, then identify the prepared package. Update ready does not deploy it.</p><label>Tested commit<input className="input factory-code-input" readOnly value={testedCommit} placeholder="No passed test receipt is available" /></label><label>Package reference<input className="input" value={artifact} onChange={event => setArtifact(event.target.value)} maxLength={500} placeholder="Release package name, approved path, or release identifier" /></label><label>Package SHA-256<input className="input factory-code-input" value={artifactChecksum} onChange={event => setArtifactChecksum(event.target.value)} maxLength={64} placeholder="Full 64-character SHA-256" /></label><label>Review summary<textarea className="input" value={summary} onChange={event => setSummary(event.target.value)} maxLength={2000} rows={3} /></label><button className="btn btn-primary" disabled={!/^[a-f0-9]{40}$/i.test(testedCommit) || !artifact.trim() || !/^[a-f0-9]{64}$/i.test(artifactChecksum.trim()) || !summary.trim()} onClick={() => void action('approve_update', { evidence: { commit: testedCommit, artifactReference: artifact.trim(), artifactChecksum: artifactChecksum.trim(), summary: summary.trim() } })}>Approve update ready</button></>}
      {request.status === 'update_ready' && <div className="factory-alert factory-alert-success"><CheckCircle2 size={17} />This update is reviewed and ready for the owner’s deployment pipeline.</div>}
      {!['update_ready', 'cancelled'].includes(request.status) && <div className="factory-secondary-actions"><label>Reason for queue action<input className="input" value={reason} onChange={event => setReason(event.target.value)} maxLength={2000} placeholder="Explain why this request is blocked, resumed, or cancelled." /></label><div className="factory-button-group">{request.status === 'blocked' ? <button className="btn" disabled={!reason.trim()} onClick={() => void action('resume', { reason: reason.trim() })}>Resume request</button> : <button className="btn" disabled={!reason.trim()} onClick={() => void action('block', { reason: reason.trim() })}>Block request</button>}<button className="btn factory-danger" disabled={!reason.trim()} onClick={() => void action('cancel', { reason: reason.trim() })}>Cancel request</button></div></div>}
    </fieldset></div>
    {!!runs.length && <div className="factory-history"><h3>Execution and review receipts</h3>{runs.map(run => <RunReceipt key={run.id} run={run} />)}</div>}
  </div></Section>;
}

function RunReceipt({ run }: { run: FactoryRun }) {
  return <details className="factory-run-receipt"><summary><span>{run.stage.split('_').join(' ')} · {run.provider}</span><Status value={run.status} /><small>{stamp(run.createdAt)}</small></summary><dl className="factory-details"><dt>Source</dt><dd>{run.source === 'administrator_reported' ? 'Administrator-reported receipt' : 'Ollama generation'}</dd><dt>Recorded by</dt><dd>{run.actorName}</dd>{run.commit && <><dt>Commit</dt><dd><code>{run.commit}</code></dd></>}{run.command && <><dt>Command</dt><dd><code>{run.command}</code></dd></>}{run.exitCode !== null && <><dt>Exit code</dt><dd>{run.exitCode}</dd></>}{run.testsPassed !== null && <><dt>Tests</dt><dd>{run.testsPassed} passed · {run.testsFailed ?? 'Not reported'} failed</dd></>}{run.artifactReference && <><dt>Package reference</dt><dd>{run.artifactReference}</dd></>}{run.artifactChecksum && <><dt>Package SHA-256</dt><dd><code>{run.artifactChecksum}</code></dd></>}</dl><p className="factory-prose">{run.summary}</p></details>;
}

function EnvironmentTable({ environments, onSelect, selectedId }: { environments: TestEnvironment[]; onSelect?(id: string): void; selectedId?: string | null }) {
  return <div className="factory-table-scroll"><table className="factory-table"><thead><tr><th scope="col">Environment</th><th scope="col">Application</th><th scope="col">Branch</th><th scope="col">State</th></tr></thead><tbody>{environments.map(item => <tr key={item.id} data-selected={selectedId === item.id}><td>{onSelect ? <button className="factory-table-link" onClick={() => onSelect(item.id)}>{item.name}</button> : <strong>{item.name}</strong>}<small>{item.purpose || 'Purpose not reported'}</small></td><td>{item.app || 'Not reported'}</td><td><code>{item.branch || 'Not reported'}</code></td><td><Status value={item.state} /></td></tr>)}</tbody></table></div>;
}

function Environments({ inventory }: { inventory: EnvironmentInventory }) {
  const [recent, setRecent] = useState(false), [app, setApp] = useState(''), [state, setState] = useState(''), [selectedId, setSelectedId] = useState<string | null>(null);
  const filtered = inventory.environments.filter(item => (recent || activeStates.has(item.state)) && (!app || item.app === app) && (!state || item.state === state)).sort((a, b) => Number(activeStates.has(b.state)) - Number(activeStates.has(a.state)) || (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const selected = filtered.find(item => item.id === selectedId) ?? filtered[0];
  const apps = [...new Set(inventory.environments.map(item => item.app).filter((value): value is string => !!value))].sort();
  const states = [...new Set(inventory.environments.map(item => item.state))].sort();
  return <div className="factory-stack"><div className="factory-toolbar"><div className="factory-observation"><span className={`factory-service-dot factory-service-${inventory.available ? 'available' : 'unavailable'}`} /><strong>{inventory.host}</strong><span>Observed {stamp(inventory.observedAt)} · refreshes every 5 seconds</span></div><label className="factory-checkbox"><input type="checkbox" checked={recent} onChange={event => setRecent(event.target.checked)} /> Include recent inactive environments</label></div>
    {!inventory.available && <div className="factory-alert">{inventory.message || 'The environment inventory is unavailable.'}</div>}
    {inventory.pipeline && <Section title="Forge pipeline test" description={`Request ${inventory.pipeline.requestId}`} action={<Status value={inventory.pipeline.status} />}><div className="factory-card-body">{inventory.pipeline.progress ? <><p className="factory-muted">{duration(inventory.pipeline.progress.totalElapsedMs)} elapsed · {inventory.pipeline.progress.cacheStatus} cache</p><div className="factory-stage-list">{inventory.pipeline.progress.stages.map(stage => <div key={stage.id}><strong>{stage.id}</strong><Status value={stage.status} /><span>{duration(stage.durationMs)}</span>{stage.counts && <small>{stage.counts.passed}/{stage.counts.tests} passed · {stage.counts.failed} failed · {stage.counts.skipped} skipped</small>}</div>)}</div></> : <p className="factory-muted">Stage measurements have not been reported for this pipeline run.</p>}</div></Section>}
    {inventory.activeControl && !inventory.pipeline && <div className="factory-alert">Active Admin Console operation: {inventory.activeControl.controlId}. Test progress is unavailable.</div>}
    <Section title={recent ? 'Active and recent test environments' : 'Active test environments'} description="Only registered Codex environments on this Forge host are included."><div className="factory-card-body factory-filter-body"><div className="factory-filters"><label>Application<select className="input" value={app} onChange={event => setApp(event.target.value)}><option value="">All applications</option>{apps.map(value => <option key={value} value={value}>{value}</option>)}</select></label><label>State<select className="input" value={state} onChange={event => setState(event.target.value)}><option value="">All states</option>{states.map(value => <option key={value} value={value}>{value}</option>)}</select></label></div></div>{filtered.length ? <EnvironmentTable environments={filtered} onSelect={setSelectedId} selectedId={selected?.id} /> : <Empty title={inventory.available ? 'No matching environments' : 'No current environment inventory'}>{inventory.available ? 'Change the filters or include recent inactive environments to see more observations.' : 'Restore the inventory connection to see current environments.'}</Empty>}</Section>
    {selected && <Section title={selected.name} description={selected.purpose || 'Purpose not reported'} action={<Status value={selected.state} />}><div className="factory-card-body"><dl className="factory-details"><dt>Application</dt><dd>{selected.app || 'Not reported'}</dd><dt>Branch</dt><dd><code>{selected.branch || 'Not reported'}</code></dd><dt>Commit</dt><dd><code>{selected.commit || 'Not reported'}</code></dd><dt>Container ID</dt><dd><code>{selected.id}</code></dd><dt>Image</dt><dd><code>{selected.image}</code></dd><dt>Runtime status</dt><dd>{selected.status}</dd><dt>Run ID</dt><dd><code>{selected.runId || 'Not reported'}</code></dd><dt>Created</dt><dd>{stamp(selected.createdAt)}</dd><dt>Published ports</dt><dd>{selected.ports.length ? selected.ports.join(', ') : 'None reported'}</dd></dl></div></Section>}
    <p className="factory-footnote">Container state reports runtime activity. Test results come from measured pipeline stages or explicitly recorded receipts. Other hosts and unregistered environments are outside this inventory. <a href="/admin/github">Open test controls in Admin Console</a>.</p>
  </div>;
}

function ServiceCards({ services }: { services: ForgeService[] }) {
  return <div className="factory-service-cards">{services.map(service => <section className="card factory-service-card" key={service.id}><div className="factory-service-card-heading"><span className="factory-project-avatar"><Bot size={22} /></span><div><h2>{service.name}</h2><span className={`factory-service-label factory-service-${service.status}`}>{service.status === 'not_configured' ? 'Setup needed' : service.status === 'observed' ? 'Test activity observed' : service.status === 'available' ? 'Available' : 'Unavailable'}</span></div></div><p>{service.message}</p><div className="factory-capabilities">{service.capabilities.map(capability => <span className="badge" key={capability}>{capability}</span>)}</div>{!!service.models.length && <div className="factory-service-models"><h3>Installed models</h3>{service.models.map(model => <code key={model}>{model}</code>)}</div>}<dl className="factory-details"><dt>Last observed</dt><dd>{stamp(service.lastSeenAt)}</dd><dt>Active tasks</dt><dd>{service.activeTasks === null ? 'Not reported' : service.activeTasks}</dd></dl></section>)}</div>;
}

function Updates({ notifications, runs, onRequest, mutate, busy }: { notifications: FactoryNotification[]; runs: FactoryRun[]; onRequest(id: string): void; mutate: Mutate; busy: boolean }) {
  return <div className="factory-stack"><Section title="Factory notifications" description="In-app notifications are recorded when requests progress through the process.">{notifications.length ? <div className="factory-updates">{notifications.map(notification => <article key={notification.id} className={notification.read ? '' : 'factory-update-unread'}><span className="factory-update-icon"><Bell size={18} /></span><div><button className="factory-table-link" onClick={() => onRequest(notification.requestId)}>{notification.title}</button><p>{notification.message}</p><small>{stamp(notification.createdAt)}</small></div>{!notification.read && <button className="btn" disabled={busy} onClick={() => void mutate(`/notifications/${notification.id}/read`, {})}>Mark read</button>}</article>)}</div> : <Empty title="No updates yet">Planning, approvals, test results, and reviewed updates will appear here.</Empty>}</Section><Section title="Recent execution receipts" description="Reported validation and review records remain attached to their requests."><div className="factory-card-body">{runs.length ? runs.slice(0, 20).map(run => <RunReceipt key={run.id} run={run} />) : <p className="factory-muted">No execution receipts have been recorded.</p>}</div></Section></div>;
}
