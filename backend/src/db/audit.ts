import type { Queryable } from './database';
export interface AuditActor { coreUserId: string; name: string }
export async function audit(q: Queryable, actor: AuditActor | null, action: string, entityType: string,
  entityId: string | null, projectId: string | null, reason: string | null, details: Record<string, unknown> = {}) {
  await q.query(`INSERT INTO public.audit_events (actor_core_user_id, actor_name, action, entity_type, entity_id, project_id, reason, details)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [actor?.coreUserId ?? null, actor?.name ?? '', action, entityType, entityId, projectId, reason, JSON.stringify(details)]);
}
export async function auditEvents(q: Queryable, limit: number) {
  const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 100;
  const result = await q.query('SELECT * FROM public.audit_events ORDER BY occurred_at DESC, id DESC LIMIT $1', [bounded]);
  return result.rows;
}
