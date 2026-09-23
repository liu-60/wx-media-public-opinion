const RUN_STATUSES = ['queued', 'pending', 'running', 'retrying', 'timed_out', 'cancelled', 'blocked', 'interrupted', 'success', 'partial', 'failed', 'waiting_auth']
const STEP_STATUSES = ['pending', 'running', 'retrying', 'timed_out', 'cancelled', 'blocked', 'interrupted', 'success', 'partial', 'failed', 'waiting_auth', 'skipped']

function jsonColumn(name, defaultValue = '{}') {
  return `${name} TEXT NOT NULL DEFAULT '${defaultValue}' CHECK(json_valid(${name}) AND json_type(${name}) IN ('object','array'))`
}

export function createCollectionSchema(db) {
  if (!db || typeof db.exec !== 'function') throw new TypeError('db must be a node:sqlite DatabaseSync')
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS collector_scripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      script_key TEXT NOT NULL,
      platform TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      execution_type TEXT NOT NULL DEFAULT 'node' CHECK(execution_type = 'node'),
      entrypoint TEXT NOT NULL CHECK(length(trim(entrypoint)) > 0),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
      timeout_seconds INTEGER NOT NULL DEFAULT 900 CHECK(timeout_seconds > 0),
      retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count BETWEEN 0 AND 10),
      ${jsonColumn('default_config')},
      ${jsonColumn('input_schema')},
      ${jsonColumn('output_schema')},
      code_hash TEXT NOT NULL CHECK(length(trim(code_hash)) > 0),
      ${jsonColumn('capabilities', '[]')},
      run_mode TEXT NOT NULL DEFAULT 'standalone' CHECK(run_mode IN ('standalone','requires_input','workflow_only')),
      ${jsonColumn('required_artifacts', '[]')},
      credential_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(script_key, version)
    );
    CREATE TABLE IF NOT EXISTS collection_workflows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      system_generated INTEGER NOT NULL DEFAULT 0 CHECK(system_generated IN (0,1)),
      validation_only INTEGER NOT NULL DEFAULT 0 CHECK(validation_only IN (0,1)),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
      ${jsonColumn('default_config')},
      ${jsonColumn('retention_config')},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collection_workflow_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id INTEGER NOT NULL REFERENCES collection_workflows(id) ON DELETE CASCADE,
      script_id INTEGER NOT NULL REFERENCES collector_scripts(id) ON DELETE RESTRICT,
      step_key TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK(seq >= 0),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      ${jsonColumn('config_override')},
      condition TEXT CHECK(condition IS NULL OR (json_valid(condition) AND json_type(condition) = 'object')),
      continue_on_error INTEGER NOT NULL DEFAULT 0 CHECK(continue_on_error IN (0,1)),
      retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count BETWEEN 0 AND 10),
      timeout_seconds INTEGER CHECK(timeout_seconds IS NULL OR timeout_seconds > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workflow_id, step_key),
      UNIQUE(workflow_id, seq)
    );
    CREATE TABLE IF NOT EXISTS collection_runs (
      id TEXT PRIMARY KEY,
      workflow_id INTEGER REFERENCES collection_workflows(id) ON DELETE RESTRICT,
      run_kind TEXT NOT NULL DEFAULT 'workflow' CHECK(run_kind IN ('workflow','single_script')),
      script_id INTEGER REFERENCES collector_scripts(id) ON DELETE RESTRICT,
      ${jsonColumn('workflow_snapshot')},
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (${RUN_STATUSES.map(value => `'${value}'`).join(',')})),
      ${jsonColumn('config_snapshot')},
      ${jsonColumn('rule_snapshot')},
      ${jsonColumn('strategy_snapshot')},
      started_at TEXT,
      finished_at TEXT,
      ${jsonColumn('summary')},
      parent_run_id TEXT REFERENCES collection_runs(id) ON DELETE SET NULL,
      worker_id TEXT,
      lease_until TEXT,
      heartbeat_at TEXT,
      publish_status TEXT NOT NULL DEFAULT 'not_requested' CHECK(publish_status IN ('not_requested','preview','queued','committing','partial','confirmed','failed','unknown','finalized')),
      ${jsonColumn('artifact_manifest')},
      retention_until TEXT,
      pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collection_step_runs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES collection_runs(id) ON DELETE CASCADE,
      step_key TEXT NOT NULL,
      ${jsonColumn('script_snapshot')},
      attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt >= 1),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (${STEP_STATUSES.map(value => `'${value}'`).join(',')})),
      started_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
      input_count INTEGER CHECK(input_count IS NULL OR input_count >= 0),
      output_count INTEGER CHECK(output_count IS NULL OR output_count >= 0),
      created_count INTEGER CHECK(created_count IS NULL OR created_count >= 0),
      updated_count INTEGER CHECK(updated_count IS NULL OR updated_count >= 0),
      filtered_count INTEGER CHECK(filtered_count IS NULL OR filtered_count >= 0),
      request_count INTEGER CHECK(request_count IS NULL OR request_count >= 0),
      error_code TEXT,
      error_message TEXT,
      ${jsonColumn('checkpoint')},
      ${jsonColumn('artifact_manifest')},
      log_ref TEXT,
      input_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(run_id, step_key, attempt)
    );
  `)
  const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name))
  const scriptColumns = columns('collector_scripts')
  if (!scriptColumns.has('run_mode')) db.exec("ALTER TABLE collector_scripts ADD COLUMN run_mode TEXT NOT NULL DEFAULT 'standalone' CHECK(run_mode IN ('standalone','requires_input','workflow_only'))")
  if (!scriptColumns.has('required_artifacts')) db.exec("ALTER TABLE collector_scripts ADD COLUMN required_artifacts TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(required_artifacts) AND json_type(required_artifacts) = 'array')")
  const runColumns = columns('collection_runs')
  if (!runColumns.has('run_kind')) db.exec("ALTER TABLE collection_runs ADD COLUMN run_kind TEXT NOT NULL DEFAULT 'workflow' CHECK(run_kind IN ('workflow','single_script'))")
  if (!runColumns.has('script_id')) db.exec('ALTER TABLE collection_runs ADD COLUMN script_id INTEGER')
  const workflowColumns = columns('collection_workflows')
  if (!workflowColumns.has('system_generated')) db.exec('ALTER TABLE collection_workflows ADD COLUMN system_generated INTEGER NOT NULL DEFAULT 0 CHECK(system_generated IN (0,1))')
  if (!workflowColumns.has('validation_only')) db.exec('ALTER TABLE collection_workflows ADD COLUMN validation_only INTEGER NOT NULL DEFAULT 0 CHECK(validation_only IN (0,1))')
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS collection_validation_workflow_name_idx ON collection_workflows(name) WHERE validation_only=1')
  db.exec(`
    CREATE INDEX IF NOT EXISTS collector_scripts_enabled_idx ON collector_scripts(enabled, script_key, version DESC);
    CREATE INDEX IF NOT EXISTS collection_workflow_steps_order_idx ON collection_workflow_steps(workflow_id, seq, id);
    CREATE INDEX IF NOT EXISTS collection_runs_queue_idx ON collection_runs(status, lease_until, created_at);
    CREATE INDEX IF NOT EXISTS collection_runs_script_idx ON collection_runs(script_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS collection_step_runs_run_idx ON collection_step_runs(run_id, step_key, attempt DESC);
  `)
  return db
}

export { RUN_STATUSES, STEP_STATUSES }
