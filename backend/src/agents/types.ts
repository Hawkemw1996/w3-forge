import type { ExecutionSettings } from './settings';
export type AgentProvider = 'ollama' | 'codex' | 'claude';
export interface AgentProfile {
  id: string; slug: string; name: string; purpose: string; enabled: boolean; revision: number;
  profileVersion: string; profileMarkdown: string; profileChecksum: string;
  provider: AgentProvider | null; model: string | null; executionSettings: ExecutionSettings; executionRevision: number; createdAt: string; updatedAt: string;
}
export interface AgentRevision {
  agentId: string; version: string; name: string; purpose: string; profileMarkdown: string;
  checksum: string; createdAt: string; createdBy: string;
}
export interface AgentSnapshot { agents: AgentProfile[]; observedAt: string }
export interface AgentServiceOptions { validateModel?: (provider: AgentProvider | null, model: string | null) => Promise<void> }
