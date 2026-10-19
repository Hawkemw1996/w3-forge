CREATE TABLE public.factory_projects (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  app_id text NOT NULL UNIQUE,
  repository_url text NOT NULL UNIQUE,
  branch text NOT NULL CHECK (branch ~ '^dev/v[0-9]+\.[0-9]+\.[0-9]+$'),
  description text NOT NULL DEFAULT '',
  rules_version integer NOT NULL DEFAULT 1 CHECK (rules_version > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.factory_rules (
  project_id text NOT NULL REFERENCES public.factory_projects(id),
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL,
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 12000),
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, version)
);
CREATE TABLE public.factory_requests (
  id text PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  project_id text NOT NULL REFERENCES public.factory_projects(id),
  title text NOT NULL,
  description text NOT NULL CHECK (length(description) <= 4000),
  acceptance_criteria text NOT NULL CHECK (length(acceptance_criteria) BETWEEN 1 AND 4000),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','planning','awaiting_approval','development','testing','review','update_ready','blocked','cancelled')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  rules_version integer NOT NULL,
  rules_checksum text NOT NULL,
  repository_url text NOT NULL,
  branch text NOT NULL,
  plan_version integer NOT NULL DEFAULT 0,
  approved_plan_version integer,
  development_commit text,
  blocked_from text,
  block_reason text,
  created_by text NOT NULL,
  created_by_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, rules_version) REFERENCES public.factory_rules(project_id, version)
);
CREATE INDEX factory_requests_queue ON public.factory_requests(project_id,sequence);
CREATE TABLE public.factory_plans (
  request_id text NOT NULL REFERENCES public.factory_requests(id),
  version integer NOT NULL CHECK (version > 0),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 10000),
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id,version)
);
CREATE TABLE public.factory_runs (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES public.factory_requests(id),
  project_id text NOT NULL REFERENCES public.factory_projects(id),
  stage text NOT NULL CHECK (stage IN ('planning','development','testing','review')),
  provider text NOT NULL,
  status text NOT NULL CHECK (status IN ('passed','failed')),
  commit_sha text,
  command text,
  exit_code integer,
  summary text NOT NULL,
  tests_passed integer CHECK (tests_passed >= 0),
  tests_failed integer CHECK (tests_failed >= 0),
  artifact_reference text,
  artifact_checksum text,
  request_revision integer NOT NULL,
  actor_id text NOT NULL,
  actor_name text NOT NULL,
  source text NOT NULL DEFAULT 'administrator_reported' CHECK (source IN ('administrator_reported','ollama')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX factory_runs_request ON public.factory_runs(request_id,created_at DESC);
CREATE TABLE public.factory_notifications (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES public.factory_requests(id),
  recipient_id text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX factory_notifications_recipient ON public.factory_notifications(recipient_id,created_at DESC);
CREATE TRIGGER factory_rules_immutable BEFORE UPDATE OR DELETE ON public.factory_rules FOR EACH ROW EXECUTE FUNCTION public.forge_append_only();
CREATE TRIGGER factory_plans_immutable BEFORE UPDATE OR DELETE ON public.factory_plans FOR EACH ROW EXECUTE FUNCTION public.forge_append_only();
CREATE TRIGGER factory_runs_immutable BEFORE UPDATE OR DELETE ON public.factory_runs FOR EACH ROW EXECUTE FUNCTION public.forge_append_only();
