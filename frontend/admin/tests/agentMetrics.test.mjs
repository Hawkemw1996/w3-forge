import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import React from 'react';
import {renderToString} from 'react-dom/server';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
const server=await createServer({server:{middlewareMode:true,hmr:false},appType:'custom'});test.after(()=>server.close());
const {default:Metrics,metricNumber}=await server.ssrLoadModule('/src/workspace/AgentMetrics.tsx');
const {default:Settings,defaultSettings}=await server.ssrLoadModule('/src/workspace/AgentExecutionSettings.tsx');
const totals={executions:2,succeeded:1,failed:1,running:0,cancelled:0,input_tokens:100,output_tokens:null,total_tokens:null,provider_reported:0,estimated:2,unavailable_usage:1,average_duration_ms:1200,estimated_cost_usd:null,unavailable_cost:2,original_context_tokens:200,processed_context_tokens:150};
const snapshot={totals,byProvider:[{...totals,provider:'codex'}],byProject:[{...totals,project_id:'p',project_name:'W3 Fixture'}],history:[{id:'run',jobId:'job',taskId:'task',agentId:'agent',agentName:'<script>fixture</script>',profileVersion:'0.1.2',profileChecksum:'a'.repeat(64),profileRevision:3,assignmentRevision:2,executionRevision:4,projectId:'p',projectName:'W3 Fixture',provider:'codex',requestedModel:null,resolvedModel:null,contextMode:'compact',retryCount:1,status:'timed_out',startedAt:'2026-10-22T00:00:00Z',completedAt:'2026-10-22T00:00:01Z',durationMs:1000,inputTokens:100,outputTokens:null,totalTokens:null,inputSource:'estimated',outputSource:'unavailable',estimatedCostUsd:null,inputRecordId:'input',contextRecordId:'sent',outputRecordId:null,errorCode:'PROVIDER_TIMEOUT'}],offset:0,limit:20,observedAt:'2026-10-22T00:00:01Z'};
function render(data=snapshot,error=null){
 const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity,gcTime:Infinity}}});
 const key=['forge-agent-metrics','limit=20&offset=0'];if(data)client.setQueryData(key,data);
 client.setQueryData(['forge-factory'],{projects:[{id:'p',name:'W3 Fixture'}]});
 if(error)client.getQueryCache().find({queryKey:key}).setState({status:'error',fetchStatus:'idle',error});
 const html=renderToString(React.createElement(QueryClientProvider,{client},React.createElement(Metrics,{agents:[{id:'agent',name:'Developer'}]}))).replaceAll('<!-- -->','');client.clear();return html;
}
test('metrics show nullable values, sources, filters, history and exact revisions',()=>{
 const html=render();for(const phrase of ['Agent execution metrics','All projects','All agents','All providers','From date','Through date','Unavailable','estimated','incomplete token pairs','Provider default (unresolved)','PROVIDER_TIMEOUT','Original input','Sent context','Profile 3','settings 4'])assert.ok(html.includes(phrase),phrase);
 assert.ok(html.includes('&lt;script&gt;fixture&lt;/script&gt;'));assert.ok(!html.includes('<script>fixture'));
 assert.equal(metricNumber(null),'Unavailable');assert.equal(metricNumber(0),'0');
});
test('failed refresh hides stale observations and current-looking totals',()=>{
 const html=render(snapshot,new Error('Metrics storage unavailable'));assert.match(html,/Metrics storage unavailable/);assert.doesNotMatch(html,/W3 Fixture:|PROVIDER_TIMEOUT|Known total tokens/);
});
test('empty and loading states give clear feedback',()=>{
 assert.match(render({...snapshot,totals:{...totals,executions:0},history:[],byProvider:[],byProject:[]}),/No agent executions match/);
 assert.match(render(null),/Loading execution metrics/);
});
test('settings retain bounded file tools and make governance visible',()=>{
 const html=renderToString(React.createElement(Settings,{value:defaultSettings,onChange:()=>{},disabled:false,provider:'codex',model:'model-fixture'}));
 for(const phrase of ['Context mode','Full','Structured','Compact','Summary','Provider retries','File context requests','Execution safeguards','Specification approval','owner release approval','Profiles cannot grant'])assert.ok(html.includes(phrase),phrase);
 assert.doesNotMatch(html,/Allow shell|Allow arbitrary/);
});
