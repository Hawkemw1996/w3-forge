export type FactoryStatus = 'queued' | 'planning' | 'awaiting_approval' | 'development' | 'testing' | 'review' | 'update_ready' | 'blocked' | 'cancelled';

export interface FactoryProject {
  id: string; name: string; appId: string; repositoryUrl: string; branch: string; description: string;
  rulesVersion: number; rulesTitle: string; rulesMarkdown: string; rulesChecksum: string; createdAt: string; updatedAt: string;
}
export interface FactoryRuleRevision {
  projectId: string; version: number; title: string; content: string; checksum: string; createdAt: string; createdBy: string;
}
export interface FactoryRequest {
  id: string; sequence: string; projectId: string; projectName: string; title: string; description: string;
  acceptanceCriteria: string; status: FactoryStatus; revision: number; rulesVersion: number; rulesChecksum: string;
  repositoryUrl: string; branch: string; plan: string; planVersion: number; blockReason: string | null;
  createdAt: string; updatedAt: string; createdBy: string;
}
export interface FactoryRun {
  id: string; requestId: string; projectId: string; stage: 'planning' | 'development' | 'testing' | 'review';
  provider: string; status: 'passed' | 'failed'; commit: string | null; command: string | null; exitCode: number | null;
  summary: string; testsPassed: number | null; testsFailed: number | null; artifactReference: string | null;
  artifactChecksum: string | null; createdAt: string; actorName: string; source: 'administrator_reported' | 'ollama';
}
export interface FactoryNotification {
  id: string; requestId: string; title: string; message: string; createdAt: string; read: boolean;
}
export interface FactorySnapshot {
  projects: FactoryProject[]; requests: FactoryRequest[]; runs: FactoryRun[]; notifications: FactoryNotification[];
  metrics: { queued: number; active: number; testing: number; ready: number; blocked: number }; observedAt: string;
}
export interface FactoryPrompt {
  prompt: string; checksum: string; rulesVersion: number; rulesChecksum: string; requestRevision: number; requestId: string;
}
export interface ForgeService {
  id: string; name: string; status: 'available' | 'unavailable' | 'not_configured' | 'observed';
  message: string; capabilities: string[]; models: string[]; lastSeenAt: string | null; activeTasks: number | null;
}
export interface ForgeServices { observedAt: string; services: ForgeService[] }

export const factoryStatusLabels: Record<FactoryStatus, string> = {
  queued: 'Queued', planning: 'Planning', awaiting_approval: 'Plan approval', development: 'Development',
  testing: 'Testing', review: 'Review', update_ready: 'Update ready', blocked: 'Blocked', cancelled: 'Cancelled',
};

export const factoryStatuses = Object.keys(factoryStatusLabels) as FactoryStatus[];
