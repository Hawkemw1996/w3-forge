import { createHash } from 'node:crypto';
import type { ExecutionSettings } from '../agents/settings';
import { ExecutionFailure } from './providers';

export type ContextMode = ExecutionSettings['contextMode'];
export interface ContextView {
  mode: ContextMode; text: string; originalTokens: number; processedTokens: number;
  tokenSource: 'estimated'; estimator: string; omittedLines: number; originalChecksum: string;
  evidenceRef: string; processingMs: number;
}
// Deliberately a disclosed heuristic, never a provider tokenizer or billing count.
export const estimateTokens = (text: string): number => Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
export const checksum = (text: string) => createHash('sha256').update(text).digest('hex');
const critical = /\b(error|fail(?:ed|ure|ures)?|warn(?:ing)?|fatal|panic|security|vulnerab\w*|denied|reject|timeout|timed.out|exception|assert|traceback|cancel|interrupt|not.ok|blocked)\b/i;
const progress = /^(?:\s*|\s*(?:progress[: ]|download(?:ing|ed)[: ]|installing[: ]|[.·#=>-]{3,})[^\n]*)$/i;

/** A view only. The caller must persist original text before using this result. */
export function processContext(original: string, options: {
  mode: ContextMode; evidenceRef: string; failed?: boolean; budget?: number;
}): ContextView {
  const started = performance.now();
  let normalized=original;
  if(options.mode!=='full') { try { const capture=JSON.parse(original); if(typeof capture.stdout==='string'&&typeof capture.stderr==='string'){const {stdout,stderr,...metadata}=capture;normalized='[metadata]\n'+JSON.stringify(metadata)+'\n[stdout]\n'+stdout+'\n[stderr]\n'+stderr;} } catch { /* Plain tool output. */ } }
  const lines=normalized.split('\n');
  let selected = lines.map((_, index) => index);
  if (!options.failed && ['compact', 'summary'].includes(options.mode)) {
    const protect = new Set<number>();
    for (let n = 0; n < lines.length; n++) {
      if (critical.test(lines[n])) for (let k = Math.max(0, n - 2); k <= Math.min(lines.length - 1, n + 3); k++) protect.add(k);
    }
    // Only remove recognized progress/blank repetition. Arbitrary code, diffs,
    // diagnostic lines and structured model responses must remain byte-for-byte.
    selected = selected.filter(n => protect.has(n) || !progress.test(lines[n]) ||
      (options.mode === 'compact' && (n === 0 || lines[n] !== lines[n - 1])));
  }
  const omittedLines = lines.length - selected.length;
  const body = selected.map(n => lines[n]).join('\n');
  const text = options.mode === 'full' ? original : JSON.stringify({
    evidenceRef: options.evidenceRef, failed: options.failed ?? false, omittedLines,
    output: body, complete: omittedLines === 0
  });
  const result: ContextView = {
    mode: options.mode, text, originalTokens: estimateTokens(original), processedTokens: estimateTokens(text),
    tokenSource: 'estimated', estimator: 'utf8-bytes/4-v1', omittedLines, originalChecksum: checksum(original),
    evidenceRef: options.evidenceRef, processingMs: performance.now() - started
  };
  if (options.budget !== undefined && result.processedTokens > options.budget)
    throw new ExecutionFailure('CONTEXT_BUDGET_EXCEEDED', 'Required context exceeds the configured budget. Increase it or request fewer files; execution evidence was retained.');
  return result;
}
export function enforcePromptBudget(prompt: string, budget: number) {
  if (estimateTokens(prompt) > budget || Buffer.byteLength(prompt, 'utf8') > 120000)
    throw new ExecutionFailure('CONTEXT_BUDGET_EXCEEDED', 'Required rules, profile and task context exceed the configured budget. Increase it or narrow the requested context.');
}
