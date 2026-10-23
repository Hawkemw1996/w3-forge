'use strict';
const {performance}=require('node:perf_hooks');
const {processContext}=require('../backend/dist/execution/contextGateway');
const os=require('node:os');
const workloads=[
 {name:'Successful dependency progress',failed:false,text:Array(1000).fill('progress: dependency completed').join('\n')+'\nConfigured checks passed.\n',required:['Configured checks passed.']},
 {name:'Failed checks with early diagnostics',failed:true,text:'FAIL backend/auth.test.ts\nAssertionError: unauthorized request accepted\n at auth.test.ts:44\n'+Array(1000).fill('progress: check completed').join('\n')+'\nTests: 1 failed, 1000 passed\n',required:['FAIL backend/auth.test.ts','AssertionError: unauthorized request accepted',' at auth.test.ts:44','Tests: 1 failed, 1000 passed']},
 {name:'Source code and candidate diff',failed:false,text:Array.from({length:250},(_,i)=>'+const field'+i+' = {value: '+i+', description: "source retained"};').join('\n'),required:['+const field0','+const field249']},
 {name:'Successful Unicode output with warning',failed:false,text:Array(1000).fill('progress: 同步 completed').join('\n')+'\nWARNING: dependency version mismatch\npackage @example/tool\nKeep investigation evidence.\nBuild completed.\n',required:['WARNING: dependency version mismatch','package @example/tool','Keep investigation evidence.','Build completed.']}
];
const percentile=(v,p)=>v.slice().sort((a,b)=>a-b)[Math.floor((v.length-1)*p)];
const results=workloads.map(w=>({workload:w.name,bytes:Buffer.byteLength(w.text),failed:w.failed,modes:['full','structured','compact','summary'].map(mode=>{
 for(let i=0;i<20;i++)processContext(w.text,{mode,evidenceRef:'fixture-original',failed:w.failed});
 const samples=[];let view;
 for(let i=0;i<200;i++){const start=performance.now();view=processContext(w.text,{mode,evidenceRef:'fixture-original',failed:w.failed});samples.push(performance.now()-start);}
 const output=mode==='full'?view.text:JSON.parse(view.text).output;
 const retained=w.required.filter(s=>output.includes(s)).length;
 if(retained!==w.required.length)throw Error('Required evidence lost in '+w.name+' / '+mode);
 return {mode,originalEstimatedTokens:view.originalTokens,processedEstimatedTokens:view.processedTokens,estimatedTokenReductionPercent:Number((100*(1-view.processedTokens/view.originalTokens)).toFixed(2)),p50ProcessingMs:Number(percentile(samples,0.5).toFixed(4)),p95ProcessingMs:Number(percentile(samples,0.95).toFixed(4)),omittedLines:view.omittedLines,requiredEvidenceRetained:retained,requiredEvidenceCount:w.required.length,failedOutputUnmodified:!w.failed||output===w.text};
 })}));
console.log(JSON.stringify({version:require('../package.json').version,node:process.version,platform:process.platform,cpu:os.cpus()[0]?.model,samplesPerMode:200,estimator:'utf8-bytes/4-v1',method:'Synthetic representative local processing only; no provider calls or measured model latency/API savings. Failed output remains intact.',results},null,2));
