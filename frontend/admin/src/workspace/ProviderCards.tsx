import { useState } from 'react';
import { Bot } from 'lucide-react';
import { apiPost, errorMessages } from '../lib/authApi';
import type { ForgeService, ProviderConnection } from './factoryApi';

const stamp = (value: string | null) => value ? new Date(value).toLocaleString() : 'Not reported';
const methods = { chatgpt: 'ChatGPT account', claude_subscription: 'Claude account', api_key: 'API key', other: 'Other sign-in', unknown: 'Not reported' };
export function serviceLabel(service: ForgeService) {
  if (service.connection) {
    if (service.connection.state === 'signed_in') return 'Signed in';
    if (service.connection.state === 'signed_out') return 'Sign-in needed';
    if (service.connection.state === 'not_installed') return 'CLI not installed';
  }
  return service.status === 'not_configured' ? 'Setup needed' : service.status === 'observed' ? 'Test activity observed' : service.status === 'available' ? 'Available' : 'Unavailable';
}
function ProviderCard({ service, onChecked, disabled }: { service: ForgeService; onChecked?(): Promise<unknown>; disabled?: boolean }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const connection = service.connection;
  async function test() {
    if (busy || disabled || connection?.state !== 'signed_in') return;
    setBusy(true); setError('');
    try {
      await apiPost<ProviderConnection>('/api/forge/services/' + service.id + '/test', {});
      await onChecked?.();
    } catch (failure) { setError(errorMessages(failure).join(' ')); }
    finally { setBusy(false); }
  }
  return <section className={"card factory-service-card" + (connection ? " factory-provider-card" : "")}>
    <div className="factory-service-card-heading"><span className="factory-project-avatar"><Bot size={22} /></span><div><h2>{service.name}</h2><span className={'factory-service-label factory-service-' + service.status}>{serviceLabel(service)}</span></div></div>
    <p>{service.message}</p>
    {connection ? <>
      <dl className="factory-details"><dt>Linux account</dt><dd>{connection.account}</dd><dt>CLI version</dt><dd>{connection.version ?? 'Not reported'}</dd><dt>Sign-in method</dt><dd>{methods[connection.authMethod]}</dd><dt>Sign-in checked</dt><dd>{stamp(connection.checkedAt)}</dd></dl>
      <div className="factory-provider-test" aria-live="polite">
        {connection.test ? <><strong>{connection.test.status === 'passed' ? 'Connection test passed' : 'Connection test failed'}</strong><p>{connection.test.message}</p><small>{stamp(connection.test.checkedAt)}</small></> : <p>Model access has not been tested in this Forge session.</p>}
        <p className="factory-muted">Testing sends one short model request and uses your account quota.</p>
        <button type="button" className="btn" disabled={busy || disabled || connection.state !== 'signed_in'} onClick={() => void test()}>{busy ? 'Testing connection…' : 'Test connection'}</button>
        {error && <p className="factory-alert factory-alert-error" role="alert">{error}</p>}
      </div>
    </> : <>
      <div className="factory-capabilities">{service.capabilities.map(capability => <span className="badge" key={capability}>{capability}</span>)}</div>
      {!!service.models.length && <div className="factory-service-models"><h3>Installed models</h3>{service.models.map(model => <code key={model}>{model}</code>)}</div>}
      <dl className="factory-details"><dt>Last observed</dt><dd>{stamp(service.lastSeenAt)}</dd><dt>{service.id === 'codex-tests' ? 'Running test environments' : 'Active tasks'}</dt><dd>{service.activeTasks === null ? 'Not reported' : service.activeTasks}</dd></dl>
    </>}
  </section>;
}
export function ServiceCards({ services, onChecked, disabled }: { services: ForgeService[]; onChecked?(): Promise<unknown>; disabled?: boolean }) {
  return <div className="factory-service-cards">{services.map(service => <ProviderCard key={service.id} service={service} onChecked={onChecked} disabled={disabled} />)}</div>;
}
