BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.collector_scripts
  ADD COLUMN IF NOT EXISTS run_mode varchar(32) NOT NULL DEFAULT 'standalone',
  ADD COLUMN IF NOT EXISTS required_artifacts jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collector_scripts_run_mode_check') THEN
    ALTER TABLE public.collector_scripts
      ADD CONSTRAINT collector_scripts_run_mode_check CHECK (run_mode IN ('standalone', 'requires_input', 'workflow_only'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collector_scripts_required_artifacts_check') THEN
    ALTER TABLE public.collector_scripts
      ADD CONSTRAINT collector_scripts_required_artifacts_check CHECK (jsonb_typeof(required_artifacts) = 'array');
  END IF;
END;
$$;

ALTER TABLE public.collection_runs
  ADD COLUMN IF NOT EXISTS run_kind varchar(32) NOT NULL DEFAULT 'workflow',
  ADD COLUMN IF NOT EXISTS script_id bigint;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collection_runs_run_kind_check') THEN
    ALTER TABLE public.collection_runs
      ADD CONSTRAINT collection_runs_run_kind_check CHECK (run_kind IN ('workflow', 'single_script'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collection_runs_script_fk') THEN
    ALTER TABLE public.collection_runs
      ADD CONSTRAINT collection_runs_script_fk FOREIGN KEY (script_id) REFERENCES public.collector_scripts(id) ON DELETE RESTRICT;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS collector_scripts_run_mode_idx
  ON public.collector_scripts (run_mode, enabled, script_key, version DESC);
CREATE INDEX IF NOT EXISTS collection_runs_script_idx
  ON public.collection_runs (script_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.create_collection_script_run(
  p_script_id bigint,
  p_config_override jsonb DEFAULT '{}'::jsonb,
  p_input_artifacts jsonb DEFAULT '[]'::jsonb,
  p_rule_snapshot jsonb DEFAULT '{}'::jsonb,
  p_strategy_snapshot jsonb DEFAULT '{}'::jsonb,
  p_parent_run_id uuid DEFAULT NULL
)
RETURNS SETOF public.collection_runs
LANGUAGE plpgsql
AS $$
DECLARE
  script_row public.collector_scripts%ROWTYPE;
  snapshot jsonb;
  requirement jsonb;
BEGIN
  IF jsonb_typeof(COALESCE(p_config_override, '{}'::jsonb)) <> 'object'
     OR jsonb_typeof(COALESCE(p_input_artifacts, '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(COALESCE(p_rule_snapshot, '{}'::jsonb)) <> 'object'
     OR jsonb_typeof(COALESCE(p_strategy_snapshot, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'single script run payload must contain JSON objects and an input array' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO script_row
  FROM public.collector_scripts
  WHERE id = p_script_id AND enabled
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'collector script is not enabled or does not exist' USING ERRCODE = 'P0002';
  END IF;
  IF script_row.run_mode = 'workflow_only' THEN
    RAISE EXCEPTION 'collector script requires workflow context' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(p_config_override->>'publish_mode', 'preview') = 'commit' THEN
    RAISE EXCEPTION 'standalone validation cannot commit business writes' USING ERRCODE = 'P0001';
  END IF;
  IF script_row.run_mode = 'requires_input' THEN
    FOR requirement IN SELECT value FROM jsonb_array_elements(script_row.required_artifacts)
    LOOP
      IF COALESCE(requirement->>'required', 'true') <> 'false' AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_input_artifacts) AS input_ref(value)
        WHERE input_ref.value->>'artifact_type' = requirement->>'artifact_type'
          AND input_ref.value->>'schema_version' = requirement->>'schema_version'
      ) THEN
        RAISE EXCEPTION 'required input artifact is missing: %', requirement->>'artifact_type' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  snapshot := jsonb_build_object(
    'kind', 'single_script',
    'id', NULL,
    'name', '脚本验证 · ' || script_row.name,
    'enabled', true,
    'revision', script_row.version,
    'default_config', script_row.default_config,
    'retention_config', '{}'::jsonb,
    'steps', jsonb_build_array(jsonb_build_object(
      'id', NULL,
      'script_id', script_row.id,
      'step_key', script_row.script_key,
      'seq', 10,
      'enabled', true,
      'config_override', '{}'::jsonb,
      'condition', NULL,
      'continue_on_error', false,
      'retry_count', script_row.retry_count,
      'timeout_seconds', script_row.timeout_seconds,
      'script_snapshot', to_jsonb(script_row)
    ))
  );

  RETURN QUERY
  INSERT INTO public.collection_runs(
    workflow_id, run_kind, script_id, workflow_snapshot, status, config_snapshot,
    rule_snapshot, strategy_snapshot, parent_run_id
  )
  VALUES (
    NULL, 'single_script', script_row.id, snapshot, 'queued',
    COALESCE(script_row.default_config, '{}'::jsonb)
      || COALESCE(p_config_override, '{}'::jsonb)
      || jsonb_build_object('input_artifacts', p_input_artifacts, 'publish_mode', COALESCE(p_config_override->>'publish_mode', 'preview')),
    COALESCE(p_rule_snapshot, '{}'::jsonb), COALESCE(p_strategy_snapshot, '{}'::jsonb), p_parent_run_id
  )
  RETURNING *;
END;
$$;

ALTER FUNCTION public.create_collection_script_run(bigint, jsonb, jsonb, jsonb, jsonb, uuid)
  SET search_path = pg_catalog, public;
REVOKE EXECUTE ON FUNCTION public.create_collection_script_run(bigint, jsonb, jsonb, jsonb, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_collection_script_run(bigint, jsonb, jsonb, jsonb, jsonb, uuid) TO service_role;

COMMIT;
