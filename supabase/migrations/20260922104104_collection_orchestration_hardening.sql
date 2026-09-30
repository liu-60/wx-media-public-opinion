BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE INDEX collection_runs_parent_run_idx
  ON public.collection_runs (parent_run_id);

CREATE INDEX collection_workflow_steps_script_idx
  ON public.collection_workflow_steps (script_id);

ALTER FUNCTION public.collection_orchestration_set_updated_at()
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.create_collection_run(bigint, jsonb, jsonb, jsonb, uuid)
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.claim_collection_run(text, integer)
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.heartbeat_collection_run(uuid, text, integer)
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.reorder_collection_workflow_steps(bigint, jsonb)
  SET search_path = pg_catalog, public;

COMMIT;
