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

export function buildWorkspaceRouter(auth: CoreAuth, options: {
  ollama?: ReturnType<typeof createOllama>; environments?: ReturnType<typeof createEnvironmentReader>;
} = {}) {
  const router = Router(), ollama = options.ollama ?? createOllama(), environments = options.environments ?? createEnvironmentReader();
  let generating = false;
  let activeGeneration: { requestId: string; actorId: string; controller: AbortController } | null = null;
  // Reuse the existing access boundary unchanged. Operational metadata/chat are app-admin only.
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.use(adminGuard, auth.requireAdmin, auth.sameOrigin, json({ limit: '64kb' }));
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
