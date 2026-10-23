import { z } from 'zod';

export const CONTEXT_MODES = ['full', 'structured', 'compact', 'summary'] as const;
export const executionSettingsSchema = z.object({
  contextMode: z.enum(CONTEXT_MODES).default('structured'),
  contextBudget: z.number().int().min(1000).max(30000).default(30000),
  timeoutMs: z.number().int().min(1000).max(600000).default(600000),
  maxRetries: z.number().int().min(0).max(2).default(0),
  maxContextRequests: z.number().int().min(0).max(4).default(4),
  allowedTools: z.array(z.literal('read_files')).max(1).default(['read_files']),
  pricing: z.object({
    provider: z.enum(['ollama', 'codex', 'claude']),
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,159}$/),
    inputUsdPerMillion: z.number().finite().min(0).max(10000),
    outputUsdPerMillion: z.number().finite().min(0).max(10000)
  }).strict().nullable().default(null)
}).strict();
export type ExecutionSettings = z.infer<typeof executionSettingsSchema>;
export const DEFAULT_EXECUTION_SETTINGS: ExecutionSettings = executionSettingsSchema.parse({});
export function executionSettings(value?: unknown): ExecutionSettings {
  // Jobs frozen before this schema existed keep the historical limits.
  return executionSettingsSchema.parse(value ?? {});
}
