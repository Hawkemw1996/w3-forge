-- Additive only: existing profiles, assignments, events and frozen contexts remain intact.
CREATE TABLE public.factory_agent_execution_settings (
 agent_id text NOT NULL REFERENCES public.factory_agents(id),
 revision integer NOT NULL CHECK(revision>0),
 config jsonb NOT NULL CHECK(jsonb_typeof(config)='object' AND octet_length(config::text)<=8192),
 created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(agent_id,revision)
);
INSERT INTO public.factory_agent_execution_settings(agent_id,revision,config,created_by)
 SELECT id,1,'{"contextMode":"structured","contextBudget":30000,"timeoutMs":600000,"maxRetries":0,"maxContextRequests":4,"allowedTools":["read_files"],"pricing":null}'::jsonb,'migration:005' FROM public.factory_agents;
ALTER TABLE public.factory_agents ADD COLUMN execution_revision integer NOT NULL DEFAULT 1 CHECK(execution_revision>0);
ALTER TABLE public.factory_agents ADD CONSTRAINT factory_agents_execution_revision_fk FOREIGN KEY(id,execution_revision) REFERENCES public.factory_agent_execution_settings(agent_id,revision) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER factory_agent_execution_settings_immutable BEFORE UPDATE OR DELETE ON public.factory_agent_execution_settings FOR EACH ROW EXECUTE FUNCTION public.forge_append_only();

CREATE TABLE public.factory_execution_records (
 id text PRIMARY KEY,
 job_id text NOT NULL REFERENCES public.factory_execution_jobs(id),
 kind text NOT NULL CHECK(kind IN ('model_input','model_output','test_output','context_view')),
 content text NOT NULL CHECK(octet_length(content)<=8388608),
 checksum text NOT NULL CHECK(checksum ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX factory_execution_records_job ON public.factory_execution_records(job_id,created_at,id);
CREATE TRIGGER factory_execution_records_immutable BEFORE UPDATE OR DELETE ON public.factory_execution_records FOR EACH ROW EXECUTE FUNCTION public.forge_append_only();

CREATE TABLE public.factory_agent_executions (
 id text PRIMARY KEY,
 job_id text NOT NULL REFERENCES public.factory_execution_jobs(id),
 project_id text NOT NULL REFERENCES public.factory_projects(id),
 agent_id text NOT NULL REFERENCES public.factory_agents(id),
 agent_name text NOT NULL, profile_version text NOT NULL, profile_checksum text NOT NULL,
 profile_revision integer NOT NULL, assignment_revision integer NOT NULL, execution_revision integer NOT NULL,
 provider text NOT NULL CHECK(provider IN ('ollama','codex','claude')),
 requested_model text, resolved_model text,
 context_mode text NOT NULL CHECK(context_mode IN ('full','structured','compact','summary')),
 settings jsonb NOT NULL,
 attempt integer NOT NULL CHECK(attempt BETWEEN 0 AND 2),
 status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','succeeded','failed','timed_out','cancelled','interrupted')),
 started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, duration_ms double precision CHECK(duration_ms>=0),
 input_tokens bigint CHECK(input_tokens>=0), output_tokens bigint CHECK(output_tokens>=0),
 input_source text NOT NULL DEFAULT 'unavailable' CHECK(input_source IN ('provider','estimated','unavailable')),
 output_source text NOT NULL DEFAULT 'unavailable' CHECK(output_source IN ('provider','estimated','unavailable')),
 estimated_cost_usd numeric(20,10) CHECK(estimated_cost_usd>=0),
 input_record_id text REFERENCES public.factory_execution_records(id),
 context_record_id text REFERENCES public.factory_execution_records(id),
 output_record_id text REFERENCES public.factory_execution_records(id),
 original_context_tokens bigint CHECK(original_context_tokens>=0),
 processed_context_tokens bigint CHECK(processed_context_tokens>=0),
 error_code text,
 CHECK((status='running')=(completed_at IS NULL)),
 CHECK((input_tokens IS NULL)=(input_source='unavailable')),
 CHECK((output_tokens IS NULL)=(output_source='unavailable'))
);
CREATE INDEX factory_agent_executions_filter ON public.factory_agent_executions(started_at DESC,id);
CREATE INDEX factory_agent_executions_job ON public.factory_agent_executions(job_id);
CREATE INDEX factory_agent_executions_agent ON public.factory_agent_executions(agent_id,started_at);
-- Inputs and completed observations cannot be rewritten. Only one completion of a running call is allowed.
CREATE FUNCTION public.forge_execution_observation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Execution observations cannot be deleted'; END IF;
 IF OLD.status<>'running' OR NEW.status='running' OR
  (to_jsonb(NEW)-ARRAY['status','completed_at','duration_ms','input_tokens','output_tokens','input_source','output_source','estimated_cost_usd','output_record_id','resolved_model','error_code'])
  IS DISTINCT FROM
  (to_jsonb(OLD)-ARRAY['status','completed_at','duration_ms','input_tokens','output_tokens','input_source','output_source','estimated_cost_usd','output_record_id','resolved_model','error_code'])
 THEN RAISE EXCEPTION 'Execution observation is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER factory_agent_executions_guard BEFORE UPDATE OR DELETE ON public.factory_agent_executions FOR EACH ROW EXECUTE FUNCTION public.forge_execution_observation_guard();

-- Compatibility with v0.4.7 writers: agents created after application rollback
-- still receive a valid default settings revision.
CREATE FUNCTION public.forge_seed_agent_execution_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO public.factory_agent_execution_settings(agent_id,revision,config,created_by)
 VALUES(NEW.id,1,'{"contextMode":"structured","contextBudget":30000,"timeoutMs":600000,"maxRetries":0,"maxContextRequests":4,"allowedTools":["read_files"],"pricing":null}'::jsonb,NEW.created_by);
 RETURN NEW;
END $$;
CREATE TRIGGER factory_agent_execution_settings_default AFTER INSERT ON public.factory_agents FOR EACH ROW EXECUTE FUNCTION public.forge_seed_agent_execution_settings();
