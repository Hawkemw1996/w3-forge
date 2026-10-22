import {buildExecutionRouter} from '../execution/routes';
import {ExecutionEngine} from '../execution/engine';
import {ExecutionStore} from '../execution/store';
import { createProviderConnections } from './providerConnections';
import { Router, json } from 'express';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { CoreAuth } from '../auth/coreAuth';
import { adminGuard } from '../admin/adminGuard';
import { AdminError, respond, envelopeErrorHandler, envelopeNotFound } from '../admin/envelope';
import { snapshotCurrent } from '../console/controls/actionLock';
import { testDevResult } from '../console/testDev/progress';
import { createOllama, validateMessages } from './ollama';
import { createEnvironmentReader } from './environments';
import { createServiceInventory } from './services';
import { createHardwareReader } from './hardware';
import { buildAgentRouter } from '../agents/routes';
import { buildFactoryRouter } from '../factory/routes';
import type { Database } from '../db/database';

export function buildWorkspaceRouter(auth: CoreAuth, options: {
  ollama?: ReturnType<typeof createOllama>; environments?: ReturnType<typeof createEnvironmentReader>;
  connections?: ReturnType<typeof createProviderConnections>;
  execution?: ExecutionEngine; db?: Database; services?: ReturnType<typeof createServiceInventory>; hardware?: ReturnType<typeof createHardwareReader>;
} = {}) {
  const router = Router(), ollama = options.ollama ?? createOllama(), environments = options.environments ?? createEnvironmentReader();
  let generating = false;
  let activeGeneration: { requestId: string; actorId: string; controller: AbortController } | null = null;
  // Reuse the existing access boundary unchanged. Operational metadata/chat are app-admin only.
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.use(adminGuard, auth.requireAdmin, auth.sameOrigin, json({ limit: '64kb' }));
  const connections = options.connections ?? createProviderConnections();
  const services = options.services ?? createServiceInventory({ ollama, environments, connections });
  const hardware = options.hardware ?? createHardwareReader();
  router.get('/services', async (_req, res, next) => { try { respond.ok(res, await services()); } catch (error) { next(error); } });
  router.post('/services/:provider/test', async (req, res, next) => {
    try {
      if (req.params.provider !== 'codex' && req.params.provider !== 'claude') throw new AdminError(400, 'INVALID_AI_PROVIDER', 'Choose Codex or Claude.');
      if (!req.body || Array.isArray(req.body) || typeof req.body !== 'object' || Object.keys(req.body).length) throw new AdminError(400, 'INVALID_AI_TEST', 'Connection tests do not accept prompts or settings.');
      respond.ok(res, await connections.test(req.params.provider));
    } catch (error) { next(error); }
  });
  router.get('/hardware', async (_req, res, next) => { try { respond.ok(res, await hardware()); } catch (error) { next(error); } });
  if (options.db) router.use('/agents', buildAgentRouter(options.db, {
    validateModel: async (provider, model) => {
      if (provider !== 'ollama' || model === null) return;
      const inventory = await ollama.inventory();
      if (!inventory.models.some(item => item.name === model)) throw new AdminError(400, 'MODEL_NOT_INSTALLED', 'Choose a model installed on Forge, or use the provider default.');
    }
  }));
  if (options.db) router.use('/execution', buildExecutionRouter(options.execution ?? new ExecutionEngine(new ExecutionStore(options.db))));
  if (options.db) router.use('/factory', buildFactoryRouter(options.db, {
    draftPlan: async (model, prompt) => {
      if (generating) throw new AdminError(429, 'MODEL_BUSY', 'A model response is already running. Try again shortly.');
      if (prompt.length > 32000) throw new AdminError(400, 'PLAN_CONTEXT_TOO_LONG', 'Shorten the project rules or request before drafting.');
      generating = true;
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 120000);
      try {
        const available = await ollama.inventory(controller.signal);
        if (!available.models.some(item => item.name === model)) throw new AdminError(400, 'MODEL_NOT_INSTALLED', 'Choose a model installed on Forge.');
        let result = '';
        await ollama.chat(model, [{ role: 'user', content: prompt }], controller.signal, async ({ delta }) => {
          result += delta;
          if (result.length > 10000) throw new AdminError(502, 'PLAN_TOO_LONG', 'The draft exceeded the plan limit. Ask for a shorter plan.');
        });
        return result;
      } finally { controller.abort(); clearTimeout(deadline); generating = false; }
    }
  }));
  router.get('/models', async (_req, res, next) => { try { respond.ok(res, await ollama.inventory()); } catch (error) { next(error); } });
  router.get('/environments', async (_req, res, next) => {
    try {
      const active = snapshotCurrent();
      const pipeline = active?.controlId === 'pipeline-test-dev' ? testDevResult(active.requestId) : null;
      // Do not expose raw worker output. Progress is the existing sanitized protocol.
      respond.ok(res, { ...await environments(), pipeline: pipeline ? {
        requestId: pipeline.requestId, status: pipeline.runStatus, progress: pipeline.testDev
      } : null, activeControl: active });
    } catch (error) { next(error); }
  });
  router.post('/chat/:requestId/cancel', (req, res, next) => {
    const active = activeGeneration;
    if (!active || active.requestId !== req.params.requestId || active.actorId !== req.forgeUser?.coreUserId) {
      return next(new AdminError(409, 'CHAT_NOT_RUNNING', 'No active chat response matches this request.'));
    }
    active.controller.abort();
    respond.ok(res, { cancelRequested: true });
  });
  router.post('/chat', async (req, res, next) => {
    const controller = new AbortController();
    const close = () => controller.abort(); res.once('close', close);
    let acquired = false; let deadline: NodeJS.Timeout | undefined;
    try {
      const { model, messages } = validateMessages(req.body);
      if (generating) throw new AdminError(429, 'MODEL_BUSY', 'A model response is already running. Try again shortly.');
      generating = true; acquired = true;
      deadline = setTimeout(() => controller.abort(), 300000);
      const inventory = await ollama.inventory(controller.signal);
      if (!inventory.models.some(item => item.name === model)) throw new AdminError(400, 'MODEL_NOT_INSTALLED', 'Choose a model installed on Forge.');
      const requestId = randomUUID();
      activeGeneration = { requestId, actorId: req.forgeUser!.coreUserId, controller };
      res.status(200).setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('X-Accel-Buffering', 'no'); res.flushHeaders();
      res.write(JSON.stringify({ success: true, data: { requestId } }) + '\n');
      await ollama.chat(model, messages, controller.signal, async data => {
        if (controller.signal.aborted) throw Error('Aborted');
        if (!res.write(JSON.stringify({ success: true, data }) + '\n')) await once(res, 'drain', { signal: controller.signal });
      });
      activeGeneration = null; generating = false; acquired = false;
      res.end(JSON.stringify({ success: true, data: { done: true } }) + '\n');
    } catch (error) {
      if (!res.headersSent) next(error);
      else if (!res.destroyed) {
        res.end(JSON.stringify({ success: false, error: { code: 'OLLAMA_CHAT_FAILED', message: 'Generation stopped before completion. Retry your message.' } }) + '\n');
      }
    } finally { controller.abort(); if (deadline) clearTimeout(deadline); res.off('close', close); if (acquired) { activeGeneration = null; generating = false; } }
  });
  router.use(envelopeNotFound, envelopeErrorHandler);
  return router;
}
