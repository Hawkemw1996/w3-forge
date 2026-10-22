import type { Database } from '../db/database';
import { ExecutionStore } from './store';
import { ExecutionEngine } from './engine';
import { ModelBroker } from './providers';
import { loadExecutionConfig, WorkspaceRuntime } from './runtime';
export async function configuredExecutionEngine(db: Database) {
    const store = new ExecutionStore(db);
    try {
        const config = await loadExecutionConfig();
        return new ExecutionEngine(store, new WorkspaceRuntime(config), new ModelBroker(config.workspaceRoot, config.providerTimeoutMs));
    }
    catch {
        return new ExecutionEngine(store, undefined, undefined, 'Install a root-owned /etc/w3forge/execution.json with an approved repository, protected workspace and offline npm cache. See docs/factory-execution.md. Restart Forge after configuration.');
    }
}
