import type { ExecutionSettings } from '../agents/settings';
export const EXECUTION_STATUSES = ['queued', 'planning', 'awaiting_approval', 'developing', 'testing', 'reviewing', 'ready', 'blocked', 'cancelled'] as const;
export type ExecutionStatus = typeof EXECUTION_STATUSES[number];
export type ExecutionNextStage = 'planning' | 'developing';
export type ExecutionProvider = 'ollama' | 'codex' | 'claude';
export const EXECUTION_AGENT_SLUGS = ['orchestrator', 'specification-writer', 'developer', 'code-reviewer', 'security-reviewer', 'ui-reviewer', 'ux-reviewer'] as const;
export type ExecutionAgentSlug = typeof EXECUTION_AGENT_SLUGS[number];
export const EXECUTION_REVIEW_ROLES = ['code-reviewer', 'security-reviewer', 'ui-reviewer', 'ux-reviewer'] as const;
export type ExecutionReviewRole = typeof EXECUTION_REVIEW_ROLES[number];
export interface ExecutionProfile {
    id: string;
    slug: ExecutionAgentSlug;
    name: string;
    purpose: string;
    profileVersion: string;
    profileMarkdown: string;
    profileChecksum: string;
    provider: ExecutionProvider;
    model: string | null;
    revision: number;
    assignmentRevision: number;
    executionSettings?: ExecutionSettings;
    executionRevision?: number;
    enabled: true;
}
export interface ExecutionContext {
    request: {
        id: string;
        title: string;
        description: string;
        acceptanceCriteria: string;
        repositoryUrl: string;
        branch: string;
        revision: number;
        rulesVersion: number;
        rulesChecksum: string;
        projectName: string;
    };
    rules: {
        version: number;
        title: string;
        checksum: string;
        markdown: string;
    };
    profiles: ExecutionProfile[];
    actor: {
        coreUserId: string;
        name: string;
    };
}
export interface ExecutionJob {
    id: string;
    requestId: string;
    projectId: string;
    parentJobId: string | null;
    status: ExecutionStatus;
    revision: number;
    round: number;
    nextStage: ExecutionNextStage;
    baseCommit: string | null;
    candidateCommit: string | null;
    specification: string;
    summary: string;
    errorCode: string | null;
    cancelRequested: boolean;
    reconciliationRequired: boolean;
    heartbeatAt: string | null;
    contextChecksum: string;
    context: ExecutionContext;
    createdAt: string;
    updatedAt: string;
}
export interface ExecutionEvent {
    id: string;
    jobId: string;
    sequence: string;
    kind: string;
    data: Record<string, unknown>;
    createdAt: string;
}
export interface ExecutionPatch {
    baseCommit?: string;
    candidateCommit?: string;
    specification?: string;
    errorCode?: string | null;
    round?: number;
    nextStage?: ExecutionNextStage;
}
