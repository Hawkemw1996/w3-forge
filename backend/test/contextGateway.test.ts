import {describe,it,expect} from 'vitest';
import {processContext,estimateTokens,enforcePromptBudget} from '../src/execution/contextGateway';
import {executionSettings} from '../src/agents/settings';
import {redactEvidence} from '../src/execution/metrics';
import {parseProviderUsage} from '../src/execution/providers';
describe('Context Gateway evidence and budgeting',()=>{
 it('keeps full output byte-for-byte, including Unicode and blank lines',()=>{
  const source='héllo 世界\n\nWARNING: original diagnostic\n';
  const full=processContext(source,{mode:'full',evidenceRef:'record'});
  expect(full.text).toBe(source);expect(full.omittedLines).toBe(0);expect(full.processedTokens).toBe(estimateTokens(source));
  expect(estimateTokens('世界')).toBe(2);expect(estimateTokens('')).toBe(0);
 });
 it('normalizes capture metadata and never removes a failed command line',()=>{
  const original=JSON.stringify({stdout:'progress: 1\nprogress: 1\n',stderr:'FAIL test\nstack\nsecurity warning\n',exitCode:1,durationMs:100});
  for(const mode of ['structured','compact','summary'] as const){
   const view=processContext(original,{mode,evidenceRef:'complete',failed:true});
   expect(view.omittedLines).toBe(0);expect(view.text).toContain('FAIL test');expect(view.text).toContain('security warning');expect(view.evidenceRef).toBe('complete');expect(JSON.parse(view.text).output).toContain('"exitCode":1');expect(JSON.parse(view.text).output).toContain('"durationMs":100');
  }
 });
 it('only reduces known successful progress noise, preserving code and warning neighbors',()=>{
  const source=['progress: 1',...Array(40).fill('progress: 1'),'src/component.ts:42','WARNING dependency mismatch','diagnostic detail','at frame1','at frame2','const unchanged = 42;'].join('\n');
  for(const mode of ['compact','summary'] as const){
   const view=processContext(source,{mode,evidenceRef:'full'});
   expect(view.processedTokens).toBeLessThan(view.originalTokens);
   expect(view.text).toContain('src/component.ts:42');expect(view.text).toContain('WARNING dependency mismatch');expect(view.text).toContain('at frame2');expect(view.text).toContain('const unchanged = 42;');expect(view.omittedLines).toBeGreaterThan(0);
  }
  const ordinary='meaningful output\nmeaningful output\nconst data = 3;';
  expect(JSON.parse(processContext(ordinary,{mode:'summary',evidenceRef:'full'}).text).output).toBe(ordinary);
 });
 it('blocks small budgets without truncating errors or mandatory prompt context',()=>{
  const source='FAIL evidence '+ 'details '.repeat(2000);
  expect(()=>processContext(source,{mode:'summary',evidenceRef:'full',failed:true,budget:100})).toThrow(/budget/i);
  expect(()=>enforcePromptBudget(source,100)).toThrow(/budget/i);
  expect(()=>enforcePromptBudget('short',1000)).not.toThrow();
 });
 it('redacts nested JSON evidence without rewriting the authoritative text',()=>{
  const original=JSON.stringify({stdout:JSON.stringify({password:'private-value',message:'WARNING preserve this diagnostic'}),stderr:'Bearer abc123'});
  const safe=redactEvidence(original);expect(safe).not.toContain('private-value');expect(safe).not.toContain('abc123');expect(safe).toContain('WARNING preserve this diagnostic');expect(original).toContain('private-value');
 });
 it('limits configuration to existing file tools and bounded retries',()=>{
  expect(executionSettings()).toMatchObject({maxRetries:0,maxContextRequests:4,allowedTools:['read_files']});
  for(const v of [{allowedTools:['shell']},{maxRetries:3},{maxContextRequests:5},{timeoutMs:600001},{contextBudget:999},{requiredApprovals:[]}]){
   expect(()=>executionSettings(v)).toThrow();
  }
 });
 it('distinguishes provider reports, zero values, caches and unavailable metadata',()=>{
  expect(parseProviderUsage('codex','{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":0,"cached_input_tokens":50}}')).toMatchObject({inputTokens:100,outputTokens:0,inputSource:'provider',outputSource:'provider',cachedInputTokens:50});
  expect(parseProviderUsage('claude','{"usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":3,"output_tokens":7}}')).toMatchObject({inputTokens:33,outputTokens:7,cachedInputTokens:23});
  for(const raw of ['invalid','{}','{"type":"turn.completed","usage":{"input_tokens":-1}}'])expect(parseProviderUsage('codex',raw)).toMatchObject({inputTokens:null,outputTokens:null,inputSource:'unavailable'});
 });
});
