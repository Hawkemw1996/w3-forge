import { createProviderConnections, type ProviderConnection } from './providerConnections';
import type { createEnvironmentReader } from './environments';
import type { createOllama } from './ollama';

export interface ServiceStatus {
  id: string;
  name: string;
  status: 'available' | 'unavailable' | 'not_configured' | 'observed';
  message: string;
  capabilities: string[];
  models: string[];
  lastSeenAt: string | null;
  activeTasks: number | null;
  connection?: ProviderConnection;
}

export interface ServiceInventory {
  observedAt: string;
  services: ServiceStatus[];
}

export function createServiceInventory(options: {
  ollama: Pick<ReturnType<typeof createOllama>, 'inventory'>;
  environments: ReturnType<typeof createEnvironmentReader>;
  now?: () => Date;
  connections?: ReturnType<typeof createProviderConnections>;
}): () => Promise<ServiceInventory> {
  const now = options.now ?? (() => new Date());
  const connections = options.connections ?? createProviderConnections();

  return async () => {
    // Each existing reader has its own timeout. A failed source must not hide
    // evidence returned by the other source, including synchronous failures.
    const [ollama, environments, accounts] = await Promise.allSettled([
      Promise.resolve().then(() => options.ollama.inventory()),
      Promise.resolve().then(() => options.environments()),
      Promise.resolve().then(() => connections.inventory()),
    ]);
    const observedAt = now().toISOString();

    let local: ServiceStatus = {
      id: 'ollama',
      name: 'Ollama',
      status: 'unavailable',
      message: 'The local Ollama model inventory is unavailable.',
      capabilities: [],
      models: [],
      lastSeenAt: null,
      activeTasks: null,
    };
    if (ollama.status === 'fulfilled') {
      const models = [...new Set(ollama.value.models.map((model) => model.name))];
      local = {
        ...local,
        status: models.length > 0 ? 'available' : 'unavailable',
        message: models.length > 0
          ? 'Ollama returned installed local models for chat and plan drafting.'
          : 'Ollama responded, but no models are installed. Install a local model before using chat or plan drafting.',
        capabilities: models.length > 0 ? ['local_chat', 'plan_drafting'] : [],
        models,
        lastSeenAt: observedAt,
      };
    }

    let codex: ServiceStatus = {
      id: 'codex-tests',
      name: 'Codex test environments',
      status: 'unavailable',
      message: 'Codex test-environment observations are unavailable. A connected coding agent has not been established.',
      capabilities: [],
      models: [],
      lastSeenAt: null,
      activeTasks: null,
    };
    if (environments.status === 'fulfilled' && environments.value.available) {
      const running = environments.value.environments.filter((environment) => environment.state === 'running');
      const historical = environments.value.environments.length > 0;
      codex = {
        ...codex,
        status: running.length > 0 ? 'observed' : 'not_configured',
        message: running.length > 0
          ? 'Running labelled Codex test environments were observed. This is test-environment observation, not a connected coding-agent adapter.'
          : historical
            ? 'Historical Codex test containers were observed. No running test environments or connected coding-agent adapter were found; container history does not establish test results.'
            : 'No running labelled Codex test environments were observed. No coding-agent adapter is configured.',
        capabilities: running.length > 0 ? ['test_environment_observation'] : [],
        lastSeenAt: running.length > 0 ? environments.value.observedAt : null,
        activeTasks: running.length,
      };
    }

    const providers: ServiceStatus[] = accounts.status === 'fulfilled' ? accounts.value.map(connection => ({
      id: connection.id, name: connection.name,
      status: connection.state === 'signed_in' ? 'available' : connection.state === 'not_installed' || connection.state === 'signed_out' ? 'not_configured' : 'unavailable',
      message: connection.message, capabilities: connection.state === 'signed_in' ? ['account_sign_in', 'manual_connection_test'] : [],
      models: [], lastSeenAt: connection.checkedAt, activeTasks: null, connection,
    })) : ['codex', 'claude'].map(id => ({ id, name: id === 'codex' ? 'Codex' : 'Claude', status: 'unavailable',
      message: 'Account checks are unavailable.', capabilities: [], models: [], lastSeenAt: null, activeTasks: null }));

    return { observedAt, services: [local, ...providers, codex] };

  };
}
