-- Keep standalone run history when its collector script definition is removed.
-- Workflow steps remain RESTRICT so an actively configured workflow cannot lose
-- its script contract accidentally.
ALTER TABLE public.collection_runs
  DROP CONSTRAINT IF EXISTS collection_runs_script_fk;

ALTER TABLE public.collection_runs
  ADD CONSTRAINT collection_runs_script_fk
  FOREIGN KEY (script_id)
  REFERENCES public.collector_scripts(id)
  ON DELETE SET NULL;
