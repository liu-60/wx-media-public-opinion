BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.collection_workflows
  ADD COLUMN IF NOT EXISTS system_generated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS validation_only boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS collection_validation_workflow_name_idx
  ON public.collection_workflows (name)
  WHERE validation_only;

CREATE OR REPLACE FUNCTION public.collection_canonical_artifact_type(
  p_type text,
  p_artifact_id text DEFAULT NULL
)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE lower(btrim(COALESCE(NULLIF(p_type, ''), NULLIF(p_artifact_id, ''), '')))
    WHEN 'normalized_accounts' THEN 'accounts'
    WHEN 'normalized_articles' THEN 'articles'
    WHEN 'frozen_write_set' THEN 'write_set'
    WHEN 'publish_preview' THEN 'publish_result'
    WHEN 'collector_errors' THEN 'exceptions'
    WHEN 'filter_report' THEN 'debug_report'
    ELSE CASE
      WHEN lower(COALESCE(p_artifact_id, '')) ~ '^(wxrank-base-)?accounts(-updated)?\\.json$' THEN 'accounts'
      WHEN lower(COALESCE(p_artifact_id, '')) = 'redfox-gzh-normalized.json' THEN 'articles'
      WHEN lower(COALESCE(p_artifact_id, '')) = 'hotwords-updated.json' THEN 'hotwords'
      WHEN lower(COALESCE(p_artifact_id, '')) IN ('frozen-write-set.json', 'write-set.json') THEN 'write_set'
      WHEN lower(COALESCE(p_artifact_id, '')) IN ('publish-preview.json', 'publish-result.json') THEN 'publish_result'
      WHEN lower(COALESCE(p_artifact_id, '')) ~ '^(wxrank-base|redfox-gzh)-errors\\.json$' THEN 'exceptions'
      WHEN lower(COALESCE(p_artifact_id, '')) ~ '^(wxrank-base|redfox-gzh)-raw\\.json$' THEN 'raw_response'
      WHEN lower(COALESCE(p_artifact_id, '')) = 'articles-filter-report.json' THEN 'debug_report'
      ELSE NULLIF(btrim(COALESCE(p_type, '')), '')
    END
  END;
$$;

CREATE OR REPLACE FUNCTION public.ensure_collection_validation_workflow(
  p_script_id bigint
)
RETURNS public.collection_workflows
LANGUAGE plpgsql
AS $$
DECLARE
  script_row public.collector_scripts%ROWTYPE;
  workflow_row public.collection_workflows%ROWTYPE;
BEGIN
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

  INSERT INTO public.collection_workflows(
    name, enabled, system_generated, validation_only, revision, default_config, retention_config
  )
  VALUES(
    'validation:' || script_row.script_key || ':v' || script_row.version,
    true, true, true, 1, COALESCE(script_row.default_config, '{}'::jsonb), '{}'::jsonb
  )
  ON CONFLICT (name) WHERE validation_only
  DO UPDATE SET enabled = true, system_generated = true, validation_only = true,
                default_config = EXCLUDED.default_config, updated_at = now()
  RETURNING * INTO workflow_row;

  DELETE FROM public.collection_workflow_steps
  WHERE workflow_id = workflow_row.id
    AND script_id <> script_row.id
    AND NOT EXISTS (
      SELECT 1 FROM public.collection_runs r WHERE r.workflow_id = workflow_row.id
    );

  INSERT INTO public.collection_workflow_steps(
    workflow_id, script_id, step_key, seq, enabled, config_override,
    condition, continue_on_error, retry_count, timeout_seconds
  )
  VALUES(
    workflow_row.id, script_row.id, script_row.script_key, 10, true, '{}'::jsonb,
    NULL, false, script_row.retry_count, script_row.timeout_seconds
  )
  ON CONFLICT (workflow_id, step_key)
  DO UPDATE SET script_id = EXCLUDED.script_id, seq = 10, enabled = true,
                config_override = '{}'::jsonb, condition = NULL,
                continue_on_error = false, retry_count = EXCLUDED.retry_count,
                timeout_seconds = EXCLUDED.timeout_seconds, updated_at = now();

  SELECT * INTO workflow_row FROM public.collection_workflows WHERE id = workflow_row.id;
  RETURN workflow_row;
END;
$$;

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
  workflow_row public.collection_workflows%ROWTYPE;
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
        WHERE public.collection_canonical_artifact_type(input_ref.value->>'artifact_type', input_ref.value->>'artifact_id') = public.collection_canonical_artifact_type(requirement->>'artifact_type', NULL)
          AND COALESCE(input_ref.value->>'schema_version', '1') = COALESCE(requirement->>'schema_version', '1')
      ) THEN
        RAISE EXCEPTION 'required input artifact is missing: %', requirement->>'artifact_type' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  workflow_row := public.ensure_collection_validation_workflow(script_row.id);
  snapshot := jsonb_build_object(
    'kind', 'single_script',
    'id', workflow_row.id,
    'name', workflow_row.name,
    'enabled', true,
    'revision', workflow_row.revision,
    'system_generated', true,
    'validation_only', true,
    'default_config', workflow_row.default_config,
    'retention_config', workflow_row.retention_config,
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
    workflow_row.id, 'single_script', script_row.id, snapshot, 'queued',
    COALESCE(workflow_row.default_config, '{}'::jsonb)
      || COALESCE(p_config_override, '{}'::jsonb)
      || jsonb_build_object('input_artifacts', p_input_artifacts, 'publish_mode', COALESCE(p_config_override->>'publish_mode', 'preview')),
    COALESCE(p_rule_snapshot, '{}'::jsonb), COALESCE(p_strategy_snapshot, '{}'::jsonb), p_parent_run_id
  )
  RETURNING *;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_collection_run(
  p_worker_id text,
  p_lease_seconds integer DEFAULT 120
)
RETURNS SETOF public.collection_runs
LANGUAGE plpgsql
AS $$
BEGIN
  IF btrim(COALESCE(p_worker_id, '')) = '' OR p_lease_seconds <= 0 OR p_lease_seconds > 86400 THEN
    RAISE EXCEPTION 'invalid worker lease' USING ERRCODE = '22023';
  END IF;
  UPDATE public.collection_runs
  SET status = 'interrupted', finished_at = now(), lease_until = NULL,
      summary = COALESCE(summary, '{}'::jsonb) || jsonb_build_object('recovery', 'lease_expired')
  WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until <= now();
  IF EXISTS (SELECT 1 FROM public.collection_runs WHERE status = 'running' AND lease_until > now()) THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH candidate AS (
    SELECT id
    FROM public.collection_runs
    WHERE status IN ('queued', 'retrying')
    ORDER BY created_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE public.collection_runs r
  SET status = 'running', worker_id = p_worker_id,
      lease_until = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(), started_at = COALESCE(started_at, now())
  FROM candidate
  WHERE r.id = candidate.id
  RETURNING r.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_collection_run_by_id(
  p_run_id uuid,
  p_worker_id text,
  p_lease_seconds integer DEFAULT 120
)
RETURNS SETOF public.collection_runs
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_run_id IS NULL OR btrim(COALESCE(p_worker_id, '')) = '' OR p_lease_seconds <= 0 OR p_lease_seconds > 86400 THEN
    RAISE EXCEPTION 'invalid worker lease' USING ERRCODE = '22023';
  END IF;
  UPDATE public.collection_runs
  SET status = 'interrupted', finished_at = now(), lease_until = NULL,
      summary = COALESCE(summary, '{}'::jsonb) || jsonb_build_object('recovery', 'lease_expired')
  WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until <= now();
  IF EXISTS (SELECT 1 FROM public.collection_runs WHERE status = 'running' AND lease_until > now()) THEN
    RETURN;
  END IF;
  RETURN QUERY
  UPDATE public.collection_runs
  SET status = 'running', worker_id = p_worker_id,
      lease_until = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(), started_at = COALESCE(started_at, now())
  WHERE id = p_run_id AND status IN ('queued', 'retrying')
  RETURNING *;
END;
$$;

ALTER FUNCTION public.collection_canonical_artifact_type(text, text) SET search_path = pg_catalog, public;
ALTER FUNCTION public.ensure_collection_validation_workflow(bigint) SET search_path = pg_catalog, public;
ALTER FUNCTION public.create_collection_script_run(bigint, jsonb, jsonb, jsonb, jsonb, uuid) SET search_path = pg_catalog, public;
ALTER FUNCTION public.claim_collection_run(text, integer) SET search_path = pg_catalog, public;
ALTER FUNCTION public.claim_collection_run_by_id(uuid, text, integer) SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.collection_canonical_artifact_type(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_collection_validation_workflow(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_collection_run_by_id(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_collection_validation_workflow(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_collection_run_by_id(uuid, text, integer) TO service_role;

COMMIT;
