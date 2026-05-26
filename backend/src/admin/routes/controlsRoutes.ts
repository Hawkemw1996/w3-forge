import { Router } from 'express';
import { respond, AdminError } from '../envelope';
import { listControlsPublic } from '../controls/registry';
import { runControl } from '../controls/safeRunner';
import { RunBodySchema, ID_REGEX } from '../controls/validator';

export function buildAdminControlsRoutes(): Router {
  const router = Router();

  router.get('/controls', (_req, res) => {
    respond.ok(res, {
      controls: listControlsPublic(),
      counts: {
        total: listControlsPublic().length,
        riskLow: listControlsPublic().filter((c) => c.riskLevel === 'LOW').length
      }
    });
  });

  router.post('/controls/:id/run', async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!ID_REGEX.test(id)) {
        throw new AdminError(400, 'INVALID_CONTROL_ID', `Invalid control id: ${id}`);
      }

      // Strict body validation. .strict() rejects unknown keys (args, cwd,
      // env, command, extraArgs, …) with INVALID_REQUEST_BODY.
      let body: { controlId: string; appId: string; inputs?: Record<string, unknown> };
      try {
        body = RunBodySchema.parse(req.body ?? {});
      } catch (e) {
        throw new AdminError(
          400,
          'INVALID_REQUEST_BODY',
          (e as Error).message
        );
      }

      // URL :id must match body.controlId for defensive consistency.
      if (body.controlId !== id) {
        throw new AdminError(
          400,
          'CONTROL_ID_MISMATCH',
          `URL id (${id}) does not match body.controlId (${body.controlId})`
        );
      }

      const result = await runControl({
        controlId: body.controlId,
        appId: body.appId,
        inputs: body.inputs
      });

      respond.ok(res, result);
    } catch (e) {
      next(e);
    }
  });

  return router;
}
