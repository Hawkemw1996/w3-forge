CREATE TABLE public.factory_execution_jobs (
 id text PRIMARY KEY, request_id text NOT NULL REFERENCES public.factory_requests(id),project_id text NOT NULL REFERENCES public.factory_projects(id),parent_job_id text REFERENCES public.factory_execution_jobs(id),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','planning','awaiting_approval','developing','testing','reviewing','ready','blocked','cancelled')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),round integer NOT NULL DEFAULT 0 CHECK(round BETWEEN 0 AND 3),next_stage text NOT NULL DEFAULT 'planning' CHECK(next_stage IN ('planning','developing')),
 base_commit text CHECK(base_commit ~ '^[0-9a-f]{40}$'),candidate_commit text CHECK(candidate_commit ~ '^[0-9a-f]{40}$'),specification text NOT NULL DEFAULT '' CHECK(length(specification)<=24000),summary text NOT NULL DEFAULT '' CHECK(length(summary)<=2000),error_code text CHECK(error_code ~ '^[A-Z][A-Z0-9_]{0,79}$'),
 cancel_requested boolean NOT NULL DEFAULT false,reconciliation_required boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(NOT reconciliation_required OR status='blocked'),CHECK(next_stage<>'developing' OR length(specification)>0),CHECK(status NOT IN ('developing','testing','reviewing','ready') OR round BETWEEN 1 AND 3),CHECK(status NOT IN ('testing','reviewing','ready') OR candidate_commit IS NOT NULL),CHECK(status<>'ready' OR (NOT cancel_requested AND NOT reconciliation_required))
);
CREATE INDEX factory_execution_jobs_request ON public.factory_execution_jobs(request_id,created_at DESC,id);
CREATE UNIQUE INDEX factory_execution_one_inflight ON public.factory_execution_jobs((true)) WHERE status IN ('queued','planning','awaiting_approval','developing','testing','reviewing');
CREATE UNIQUE INDEX factory_execution_one_request_inflight ON public.factory_execution_jobs(request_id) WHERE status IN ('queued','planning','awaiting_approval','developing','testing','reviewing');
CREATE TABLE public.factory_execution_contexts(job_id text PRIMARY KEY REFERENCES public.factory_execution_jobs(id),content jsonb NOT NULL CHECK(jsonb_typeof(content)='object' AND octet_length(content::text)<=131072),checksum text NOT NULL CHECK(checksum ~ '^[0-9a-f]{64}$'),created_at timestamptz NOT NULL DEFAULT now());
CREATE TRIGGER factory_execution_contexts_immutable BEFORE UPDATE OR DELETE ON public.factory_execution_contexts FOR EACH ROW EXECUTE FUNCTION public.forge_append_only();
CREATE TABLE public.factory_execution_events(id text PRIMARY KEY,job_id text NOT NULL REFERENCES public.factory_execution_jobs(id),sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,kind text NOT NULL CHECK(kind ~ '^[a-z][a-z0-9_.-]{0,63}$'),data jsonb NOT NULL CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=32768),created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX factory_execution_events_job ON public.factory_execution_events(job_id,sequence);
CREATE TRIGGER factory_execution_events_immutable BEFORE UPDATE OR DELETE ON public.factory_execution_events FOR EACH ROW EXECUTE FUNCTION public.forge_append_only();
CREATE TABLE public.factory_execution_slot(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),job_id text UNIQUE REFERENCES public.factory_execution_jobs(id),owner_token text CHECK(length(owner_token) BETWEEN 32 AND 128),heartbeat_at timestamptz,CHECK((owner_token IS NULL)=(heartbeat_at IS NULL)),CHECK(job_id IS NOT NULL OR owner_token IS NULL));
INSERT INTO public.factory_execution_slot(singleton) VALUES(true);
