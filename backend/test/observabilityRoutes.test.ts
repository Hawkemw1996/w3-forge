import {describe,it,expect} from 'vitest';
import express from 'express';
import request from 'supertest';
import type {Database} from '../src/db/database';
import {buildWorkspaceRouter} from '../src/workspace/routes';
import {createCoreFixture} from './coreFixture';
describe('new observability endpoints retain Core admin and origin boundaries',()=>{
 function fixture(){const core=createCoreFixture();let queries=0;const db:Database={query:async()=>{queries++;throw Error('private database secret');},transaction:async()=>{queries++;throw Error('private database secret');},ping:async()=>false};const app=express().use('/api/auth',core.auth.router).use('/api/forge',buildWorkspaceRouter(core.auth,{db}));return{...core,app,agent:request.agent(app),queries:()=>queries};}
 it('rejects anonymous, nonadmin, revoked and cross-origin callers before storage',async()=>{
  const f=fixture();for(const p of ['/metrics','/records/example','/jobs/example/records'])expect((await request(f.app).get('/api/forge/execution'+p)).status).toBe(401);
  await f.login(f.agent);f.state.role='viewer';expect((await f.agent.get('/api/forge/execution/metrics')).status).toBe(403);
  expect((await f.agent.post('/api/forge/agents/orchestrator/execution').send({expectedRevision:1,executionSettings:{}})).status).toBe(403);
  f.state.role='admin';expect((await f.agent.post('/api/forge/agents/orchestrator/execution').set('Origin','https://other.test').send({expectedRevision:1,executionSettings:{}})).status).toBe(403);
  f.state.revoked=true;expect((await f.agent.get('/api/forge/execution/records/example')).status).toBe(401);expect(f.queries()).toBe(0);
 });
 it('validates settings and filters and hides internal database failures',async()=>{
  const f=fixture();await f.login(f.agent);
  for(const p of ['/metrics?provider=unsupported','/metrics?from=bad','/metrics?limit=999','/records/not.valid'])expect((await f.agent.get('/api/forge/execution'+p)).status).toBe(400);
  expect((await f.agent.post('/api/forge/agents/orchestrator/execution').send({expectedRevision:1,executionSettings:{allowedTools:['shell']}})).status).toBe(400);
  expect(f.queries()).toBe(0);const r=await f.agent.get('/api/forge/execution/metrics');expect(r.status).toBe(503);expect(r.text).not.toContain('private database secret');
 });
});
