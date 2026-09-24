import { DEFAULT_RUN_OVERRIDE_KEYS, selectAllowedRunOverride } from '../../src/runner/config.mjs'
import { validateWxRankRequestTypes } from '../../src/runner/wxrank-strategy-config.mjs'
import { createConfigValidation } from './config-validation.mjs'
import { validateScriptRunRequest } from '../../src/runner/workflow.mjs'
import { SCRIPT_FIELDS } from './collectors.mjs'

const validation = createConfigValidation()
const RUN_FIELDS = ['id', 'workflow_id', 'run_kind', 'script_id', 'workflow_snapshot', 'status', 'config_snapshot', 'rule_snapshot', 'strategy_snapshot', 'started_at', 'finished_at', 'summary', 'parent_run_id', 'worker_id', 'lease_until', 'heartbeat_at', 'publish_status', 'artifact_manifest', 'retention_until', 'pinned', 'created_at', 'updated_at']
const RUN_LIST_FIELDS = ['id', 'workflow_id', 'run_kind', 'status', 'started_at', 'lease_until', 'publish_status']
const SCRIPT_RUN_FIELDS = ['id', 'run_kind', 'script_id', 'status', 'created_at', 'summary']
const CANDIDATE_RUN_FIELDS = ['id', 'status', 'artifact_manifest']
const STEP_RUN_FIELDS = ['id', 'run_id', 'step_key', 'script_snapshot', 'attempt', 'status', 'started_at', 'finished_at', 'duration_ms', 'input_count', 'output_count', 'created_count', 'updated_count', 'filtered_count', 'request_count', 'error_code', 'error_message', 'checkpoint', 'artifact_manifest', 'log_ref', 'input_hash', 'created_at', 'updated_at']
function rows(result) { return Array.isArray(result?.data) ? result.data : result?.data ? [result.data] : [] }
function item(result) { return rows(result)[0] || null }

function normalizeInputArtifacts(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) { const error = new Error('input_artifacts must be an array'); error.status = 400; error.code = 'INPUT_SCHEMA_INVALID'; throw error }
  return value.map((artifact, index) => {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) { const error = new Error(`input_artifacts[${index}] is invalid`); error.status = 400; error.code = 'INPUT_SCHEMA_INVALID'; throw error }
    const artifactId = String(artifact.artifact_id || artifact.id || '').trim()
    const sha256 = String(artifact.sha256 || artifact.hash || '').trim().toLowerCase()
    const artifactType = String(artifact.artifact_type || '').trim()
    const schemaVersion = String(artifact.schema_version || '').trim()
    if (!artifactId || /[\\/]/u.test(artifactId) || !/^[a-f0-9]{64}$/u.test(sha256) || !artifactType || !schemaVersion) { const error = new Error(`input_artifacts[${index}] is missing id, hash or contract`); error.status = 400; error.code = 'INPUT_SCHEMA_INVALID'; throw error }
    const result = { artifact_id: artifactId, sha256, artifact_type: artifactType, schema_version: schemaVersion }
    if (artifact.source_run_id !== undefined && artifact.source_run_id !== null) result.source_run_id = String(artifact.source_run_id)
    if (artifact.source === 'local_test') {
      const bundleId = String(artifact.source_test_bundle_id || '').trim()
      if (!bundleId || /[\\/]/u.test(bundleId)) { const error = new Error(`input_artifacts[${index}] local test bundle is invalid`); error.status = 400; error.code = 'INPUT_SCHEMA_INVALID'; throw error }
      result.source = 'local_test'
      result.source_test_bundle_id = bundleId
    }
    if (artifact.relative_path !== undefined && artifact.relative_path !== null) {
      const relativePath = String(artifact.relative_path).trim().replaceAll('\\', '/')
      if (!relativePath || relativePath.startsWith('/') || relativePath.split('/').some(part => !part || part === '.' || part === '..')) { const error = new Error(`input_artifacts[${index}] relative_path is unsafe`); error.status = 400; error.code = 'INPUT_SCHEMA_INVALID'; throw error }
      result.relative_path = relativePath
    }
    return result
  })
}

export function createCollectionRunService({ client, startValidationRun = null } = {}) {
  if (!client) throw new TypeError('collection client is required')
  async function listRows(query, selectedFields, { exactCount = false, lookAhead = false } = {}) {
    const { page, pageSize, offset } = validation.parsePageQuery(query)
    const filters = query.status ? [{ column: 'status', operator: 'eq', value: query.status }] : []
    const result = await client.list('collection_runs', { columns: selectedFields, filters, order: [{ column: 'created_at', direction: 'desc' }], limit: pageSize + (lookAhead ? 1 : 0), offset, ...(exactCount ? { count: 'exact' } : {}) })
    const resultRows = rows(result)
    const hasMore = lookAhead && resultRows.length > pageSize
    return { items: lookAhead ? resultRows.slice(0, pageSize) : resultRows, total: result.total ?? null, page, pageSize, ...(lookAhead ? { hasMore } : {}) }
  }
  return Object.freeze({
    async list(query = {}) { return listRows(query, RUN_LIST_FIELDS, { lookAhead: true }) },
    async listCandidates(query = {}) { return listRows(query, CANDIDATE_RUN_FIELDS) },
    async get(id) { return { item: (await client.get('collection_runs', String(id), { columns: RUN_FIELDS })).data } },
    async scriptRuns(scriptId, query = {}) {
      const id = validation.integer(scriptId, { min: 1, required: true })
      const { page, pageSize, offset } = validation.parsePageQuery(query)
      const result = await client.list('collection_runs', { columns: SCRIPT_RUN_FIELDS, filters: [{ column: 'run_kind', operator: 'eq', value: 'single_script' }, { column: 'script_id', operator: 'eq', value: id }], order: [{ column: 'created_at', direction: 'desc' }], limit: pageSize, offset })
      return { items: rows(result), total: result.total ?? null, page, pageSize }
    },
    async steps(id, query = {}) {
      const { page, pageSize, offset } = validation.parsePageQuery(query)
      const result = await client.list('collection_step_runs', { columns: STEP_RUN_FIELDS, filters: [{ column: 'run_id', operator: 'eq', value: String(id) }], order: [{ column: 'created_at', direction: 'asc' }], limit: pageSize, offset, count: 'exact' })
      return { items: rows(result), total: result.total ?? null, page, pageSize }
    },
    async create(input = {}) {
      const workflowId = validation.integer(input.workflow_id, { min: 1, required: true })
      const configOverride = selectAllowedRunOverride(input.config_snapshot || input.config || {}, DEFAULT_RUN_OVERRIDE_KEYS)
      const result = await client.rpc('create_collection_run', { p_workflow_id: workflowId, p_config_override: configOverride, p_rule_snapshot: input.rule_snapshot || {}, p_strategy_snapshot: input.strategy_snapshot || {}, p_parent_run_id: input.parent_run_id || null })
      return { item: item(result) }
    },
    async createScriptRun(input = {}) {
      const scriptId = validation.integer(input.script_id ?? input.scriptId, { min: 1, required: true })
      const script = (await client.get('collector_scripts', scriptId, { columns: SCRIPT_FIELDS })).data
      const inputArtifacts = normalizeInputArtifacts(input.input_artifacts ?? input.inputArtifacts ?? [])
      const publishMode = input.publish_mode || input.publishMode || 'preview'
      validateScriptRunRequest(script, { inputArtifacts, publishMode })
      const configOverride = selectAllowedRunOverride(input.config_snapshot || input.config || {}, DEFAULT_RUN_OVERRIDE_KEYS)
      if (script?.script_key === 'wxrank-strategy') {
        configOverride.request_types = validateWxRankRequestTypes(configOverride, { mode: 'single_validation' })
        delete configOverride.request_type
      }
      configOverride.publish_mode = publishMode
      configOverride.input_artifacts = inputArtifacts
      const result = await client.rpc('create_collection_script_run', { p_script_id: scriptId, p_config_override: configOverride, p_input_artifacts: inputArtifacts, p_rule_snapshot: input.rule_snapshot || {}, p_strategy_snapshot: input.strategy_snapshot || {}, p_parent_run_id: input.parent_run_id || null })
      const created = item(result)
      if (created?.id && typeof startValidationRun === 'function') {
        try {
          await startValidationRun({ runId: created.id, script, run: created })
        } catch (error) {
          const failure = { status: 'failed', summary: { recovery: 'worker_start_failed', error_code: 'WORKER_START_FAILED', error_message: error.message || 'worker start failed' }, finished_at: new Date().toISOString() }
          let persisted = null
          try {
            const patched = await client.patch('collection_runs', [{ column: 'id', operator: 'eq', value: String(created.id) }, { column: 'status', operator: 'eq', value: 'queued' }], failure)
            persisted = item(patched)
          } catch {}
          return { item: persisted || { ...created, ...failure }, script }
        }
      }
      return { item: created, script }
    },
    async cancel(id) {
      const result = await client.patch('collection_runs', [{ column: 'id', operator: 'eq', value: String(id) }, { column: 'status', operator: 'in', value: ['queued', 'pending', 'running', 'retrying'] }], { status: 'cancelled', finished_at: new Date().toISOString() })
      return { item: item(result), cancelled: rows(result).length > 0 }
    },
    async setPublishStatus(id, status) {
      const allowed = new Set(['not_requested', 'preview', 'queued', 'committing', 'partial', 'confirmed', 'failed', 'unknown', 'finalized'])
      if (!allowed.has(status)) { const error = new Error('invalid publish status'); error.status = 400; error.code = 'INVALID_PUBLISH_STATUS'; throw error }
      const result = await client.patch('collection_runs', [{ column: 'id', operator: 'eq', value: String(id) }], { publish_status: status })
      return { item: item(result) }
    },
    async retain(id, input = {}) {
      const result = await client.patch('collection_runs', [{ column: 'id', operator: 'eq', value: String(id) }], { pinned: input.pinned !== false })
      return { item: item(result), pinned: input.pinned !== false }
    },
    async skipStep(id, input = {}) {
      const stepId = String(id)
      const result = await client.patch('collection_step_runs', [{ column: 'id', operator: 'eq', value: stepId }, { column: 'status', operator: 'in', value: ['pending', 'running'] }], { status: 'skipped', error_code: 'MANUAL_SKIP', error_message: input.reason || 'manual skip', finished_at: new Date().toISOString() })
      return { item: item(result), skipped: rows(result).length > 0 }
    },
    async rerun(id, input = {}) {
      const old = (await client.get('collection_runs', String(id), { columns: RUN_FIELDS })).data
      const configOverride = selectAllowedRunOverride(input.config_snapshot || old.config_snapshot || {}, DEFAULT_RUN_OVERRIDE_KEYS)
      if (old.run_kind === 'single_script' || old.script_id) {
        const inputArtifacts = normalizeInputArtifacts(configOverride.input_artifacts || old.config_snapshot?.input_artifacts || [])
        const result = await client.rpc('create_collection_script_run', { p_script_id: Number(old.script_id), p_config_override: { ...configOverride, input_artifacts: inputArtifacts }, p_input_artifacts: inputArtifacts, p_rule_snapshot: old.rule_snapshot || {}, p_strategy_snapshot: old.strategy_snapshot || {}, p_parent_run_id: String(id) })
        return { item: item(result), parent_run_id: String(id) }
      }
      const result = await client.rpc('create_collection_run', { p_workflow_id: old.workflow_id, p_config_override: configOverride, p_rule_snapshot: old.rule_snapshot || {}, p_strategy_snapshot: old.strategy_snapshot || {}, p_parent_run_id: String(id) })
      return { item: item(result), parent_run_id: String(id) }
    }
  })
}

export { RUN_FIELDS, RUN_LIST_FIELDS, SCRIPT_RUN_FIELDS, CANDIDATE_RUN_FIELDS, STEP_RUN_FIELDS }
