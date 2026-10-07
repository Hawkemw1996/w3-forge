-- =============================================================================
-- W3 Forge 001_foundation — audit trail, platform config and production cutover.
-- =============================================================================
-- Applied by scripts/_w3forge-migration-ledger.sh (or the equivalent
-- backend runner used by the test suite) inside a single transaction together
-- with its schema_migrations ledger row. Released migrations are immutable;
-- schema changes go in a new forward migration.
--
-- Identity and active sessions remain managed by the existing Core-bound authentication.

-- Shared trigger: append-only tables reject UPDATE and DELETE.
CREATE OR REPLACE FUNCTION public.forge_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'W3 Forge: % is append-only (% refused)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- Domain audit trail: every create/change with who (Core user id), what, why.
CREATE TABLE public.audit_events (
  id                  BIGSERIAL PRIMARY KEY,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_core_user_id  TEXT,
  actor_name          TEXT        NOT NULL DEFAULT '',
  action              TEXT        NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  entity_type         TEXT        NOT NULL,
  entity_id           TEXT,
  project_id          TEXT,
  reason              TEXT,
  details             JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object')
);
CREATE INDEX audit_events_entity_idx ON public.audit_events (entity_type, entity_id);
CREATE INDEX audit_events_project_idx ON public.audit_events (project_id, occurred_at DESC);
CREATE INDEX audit_events_occurred_idx ON public.audit_events (occurred_at DESC);
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION public.forge_append_only();

-- Admin Console production configuration (key/value), as in the W3 Core pattern.
CREATE TABLE public.platform_config (
  key         TEXT        PRIMARY KEY CHECK (key ~ '^[A-Za-z0-9_.-]{1,100}$'),
  value       TEXT        NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  TEXT
);

-- Admin Console production cut-over record (first enable wins), as in W3 Core.
CREATE TABLE public.production_cutover_record (
  id                      BIGSERIAL   PRIMARY KEY,
  enabled_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enabled_by_core_user_id TEXT,
  enabled_version         VARCHAR(50) NOT NULL DEFAULT '0.0.0',
  notes                   TEXT
);
