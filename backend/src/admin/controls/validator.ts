// =============================================================================
// Control request validator — Zod schema for POST /controls/:id/run.
// =============================================================================
//
// v0.4.0 lockdown: the body schema is EXACTLY:
//
//   { controlId: string, appId: string, inputs?: Record<string, ...> }
//
// `.strict()` rejects any unknown key (args, command, extraArgs, cwd, env, etc.)
// with a Zod failure that the route maps to 400 INVALID_REQUEST_BODY.

import { z } from 'zod';

export const ID_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const InputsValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export const InputsSchema = z.record(z.string(), InputsValueSchema);

export const RunBodySchema = z
  .object({
    controlId: z.string().regex(ID_REGEX),
    appId: z.string().regex(ID_REGEX),
    inputs: InputsSchema.optional()
  })
  .strict();

export type RunBody = z.infer<typeof RunBodySchema>;
