import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCollectionSchema } from './schema.mjs'
import { buildWorkflowSnapshot } from './workflow.mjs'
import { mergeCollectorConfig } from './config.mjs'
import { loadCollectorRegistry, resolveRegisteredEntrypoint } from './registry.mjs'
import { createRunStore } from './run-store.mjs'

function filePath(value) {
  return value instanceof URL ? fileURLToPath(value) : path.resolve(String(value))
}

function json(value, fallback = {}) {
  return JSON.stringify(value === undefined || value === null ? fallback : value)
}

function parseJsonRow(row) {
  if (!row) return null
  const result = { ...row }
  for (const field of ['default_config', 'input_schema', 'output_schema', 'capabilities', 'required_artifacts', 'retention_config', 'config_override', 'condition']) {
    if (typeof result[field] === 'string') {
      try { result[field] = JSON.parse(result[field]) } catch { result[field] = field === 'capabilities' ? [] : {} }
    }
  }
  return result
}

async function readJson(file) {
  return JSON.parse(await readFile(filePath(file), 'utf8'))
}

function resolveEntry(entry, { rootDir, allowUntrackedLocal }) {
  const resolved = resolveRegisteredEntrypoint(entry, {
    rootDir,
    gitLsFiles: allowUntrackedLocal ? relative => relative : null
  })
  if (entry.code_hash && entry.code_hash !== resolved.codeHash) throw new Error(`collector code hash drift: ${entry.script_key}`)
  return { ...entry, code_hash: resolved.codeHash, entrypoint: resolved.relativePath }
}

export async function registerLocalCollectors({ db, registryPath, rootDir = process.cwd(), allowUntrackedLocal = false, now = () => new Date().toISOString() } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('db is required')
  createCollectionSchema(db)
  const registry = await loadCollectorRegistry(filePath(registryPath))
  const root = filePath(rootDir)
  const registered = []
  for (const raw of registry) {
    const entry = resolveEntry(raw, { rootDir: root, allowUntrackedLocal })
    const timestamp = now()
    const existing = db.prepare('SELECT id FROM collector_scripts WHERE script_key=? AND version=?').get(entry.script_key, entry.version)
    const fields = [entry.name, entry.script_key, entry.platform, entry.description || '', entry.execution_type || 'node', entry.entrypoint, entry.enabled === false ? 0 : 1, entry.version, entry.timeout_seconds || 900, entry.retry_count || 0, json(entry.default_config), json(entry.input_schema), json(entry.output_schema), entry.code_hash, json(entry.capabilities || []), entry.run_mode || 'standalone', json(entry.required_artifacts || []), entry.credential_ref || null, timestamp]
    if (existing) {
      db.prepare(`UPDATE collector_scripts SET name=?,platform=?,description=?,execution_type=?,entrypoint=?,enabled=?,timeout_seconds=?,retry_count=?,default_config=?,input_schema=?,output_schema=?,code_hash=?,capabilities=?,run_mode=?,required_artifacts=?,credential_ref=?,updated_at=? WHERE id=?`).run(fields[0], fields[2], fields[3], fields[4], fields[5], fields[6], fields[8], fields[9], fields[10], fields[11], fields[12], fields[13], fields[14], fields[15], fields[16], fields[17], fields[18], existing.id)
    } else {
      db.prepare(`INSERT INTO collector_scripts(name,script_key,platform,description,execution_type,entrypoint,enabled,version,timeout_seconds,retry_count,default_config,input_schema,output_schema,code_hash,capabilities,run_mode,required_artifacts,credential_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...fields.slice(0, 18), timestamp, fields[18])
    }
    const row = db.prepare('SELECT * FROM collector_scripts WHERE script_key=? AND version=?').get(entry.script_key, entry.version)
    registered.push(parseJsonRow(row))
  }
  return registered
}

export async function bootstrapCollection({ db, registryPath, workflowPath, rootDir = process.cwd(), allowUntrackedLocal = false, runConfig = {}, runId = undefined, now = () => new Date().toISOString() } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('db is required')
  const scripts = await registerLocalCollectors({ db, registryPath, rootDir, allowUntrackedLocal, now })
  const workflowDefinition = await readJson(workflowPath)
  const scriptMap = new Map(scripts.map(script => [script.script_key, script]))
  const current = db.prepare('SELECT * FROM collection_workflows WHERE name=? ORDER BY id LIMIT 1').get(workflowDefinition.name)
  const timestamp = now()
  if (current) {
    db.prepare('UPDATE collection_workflows SET enabled=?,revision=?,default_config=?,retention_config=?,updated_at=? WHERE id=?').run(workflowDefinition.enabled === false ? 0 : 1, workflowDefinition.revision || 1, json(workflowDefinition.default_config), json(workflowDefinition.retention_config), timestamp, current.id)
  } else {
    db.prepare('INSERT INTO collection_workflows(name,enabled,revision,default_config,retention_config,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(workflowDefinition.name, workflowDefinition.enabled === false ? 0 : 1, workflowDefinition.revision || 1, json(workflowDefinition.default_config), json(workflowDefinition.retention_config), timestamp, timestamp)
  }
  const workflowRow = parseJsonRow(db.prepare('SELECT * FROM collection_workflows WHERE name=? ORDER BY id LIMIT 1').get(workflowDefinition.name))
  db.prepare('DELETE FROM collection_workflow_steps WHERE workflow_id=?').run(workflowRow.id)
  const stepRows = []
  for (const step of workflowDefinition.steps || []) {
    const script = scriptMap.get(step.script_key)
    if (!script) throw new Error(`workflow references unknown collector: ${step.script_key}`)
    const result = db.prepare(`INSERT INTO collection_workflow_steps(workflow_id,script_id,step_key,seq,enabled,config_override,condition,continue_on_error,retry_count,timeout_seconds,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(workflowRow.id, script.id, step.step_key, step.seq, step.enabled === false ? 0 : 1, json(step.config_override), step.condition === null || step.condition === undefined ? null : json(step.condition), step.continue_on_error === true ? 1 : 0, step.retry_count || 0, step.timeout_seconds || null, timestamp, timestamp)
    stepRows.push({ id: Number(result.lastInsertRowid), ...step, workflow_id: workflowRow.id, script_id: script.id, enabled: step.enabled !== false, continue_on_error: step.continue_on_error === true, script_snapshot: script })
  }
  const workflowSnapshot = buildWorkflowSnapshot({ workflow: workflowRow, steps: stepRows, scripts: scriptMap })
  const configSnapshot = mergeCollectorConfig({ scriptDefault: workflowRow.default_config || {}, runOverride: runConfig })
  const store = createRunStore({ db, now })
  const run = await store.createRun({ id: runId, workflowId: workflowRow.id, workflowSnapshot, configSnapshot, ruleSnapshot: runConfig.rule_snapshot || {}, strategySnapshot: runConfig.strategy_snapshot || {}, parentRunId: runConfig.parent_run_id || null, retentionUntil: null })
  return { run, workflow: workflowRow, scripts, steps: stepRows, workflowSnapshot }
}
