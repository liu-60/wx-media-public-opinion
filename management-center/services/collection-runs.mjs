import { DEFAULT_RUN_OVERRIDE_KEYS, selectAllowedRunOverride } from '../../src/runner/config.mjs'
import { validateWxRankRequestTypes } from '../../src/runner/wxrank-strategy-config.mjs'
import { normalizeManualSearchConfig } from '../../src/runner/hotword-expand-config.mjs'
import { createConfigValidation } from './config-validation.mjs'
import { validateScriptRunRequest } from '../../src/runner/workflow.mjs'
import { SCRIPT_FIELDS } from './collectors.mjs'

const validation = createConfigValidation()
const RUN_FIELDS = ['id', 'workflow_id', 'run_kind', 'script_id', 'workflow_snapshot', 'status', 'config_snapshot', 'rule_snapshot', 'strategy_snapshot', 'started_at', 'finished_at', 'summary', 'parent_run_id', 'worker_id', 'lease_until', 'heartbeat_at', 'publish_status', 'artifact_manifest', 'retention_until', 'pinned', 'created_at', 'updated_at']
const RUN_LIST_FIELDS = ['id', 'workflow_id', 'run_kind', 'script_id', 'status', 'started_at', 'finished_at', 'lease_until', 'publish_status', 'summary']
const SCRIPT_RUN_FIELDS = ['id', 'run_kind', 'script_id', 'status', 'created_at', 'summary']
const CANDIDATE_RUN_FIELDS = ['id', 'status', 'artifact_manifest']
const STEP_RUN_FIELDS = ['id', 'run_id', 'workflow_run_id', 'step_id', 'script_id', 'step_key', 'script_snapshot', 'attempt', 'status', 'started_at', 'finished_at', 'duration_ms', 'input_count', 'output_count', 'created_count', 'updated_count', 'filtered_count', 'request_count', 'error_code', 'error_message', 'checkpoint', 'summary', 'artifact_manifest', 'log_ref', 'input_hash', 'created_at', 'updated_at']
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
    if (artifact.producer_step_key !== undefined && artifact.producer_step_key !== null) result.producer_step_key = String(artifact.producer_step_key)
    if (artifact.relative_path !== undefined && artifact.relative_path !== null) result.relative_path = String(artifact.relative_path)
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
  async function startCreatedRun(run) {
    if (!run?.id || typeof startValidationRun !== 'function') return run
    try {
      await startValidationRun({ runId: run.id, run })
      return run
    } catch (error) {
      const failure = {
        status: 'failed',
        summary: { recovery: 'worker_start_failed', error_code: 'WORKER_START_FAILED', error_message: error.message || 'worker start failed' },
        finished_at: new Date().toISOString()
      }
      let persisted = null
      try {
        const patched = await client.patch('collection_runs', [
          { column: 'id', operator: 'eq', value: String(run.id) },
          { column: 'status', operator: 'eq', value: 'queued' }
        ], failure)
        persisted = item(patched)
      } catch {}
      return persisted || { ...run, ...failure }
    }
  }
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
    async getStepRun(runId, stepRunId) {
      const runIdentifier = String(runId ?? '').trim()
      const stepIdentifier = String(stepRunId ?? '').trim()
      if (!runIdentifier || !stepIdentifier || runIdentifier.length > 128 || stepIdentifier.length > 128 || /[\u0000-\u001f\u007f]/u.test(runIdentifier + stepIdentifier)) {
        const error = new Error('运行或步骤标识格式无效')
        error.status = 400
        error.code = 'INVALID_ID'
        throw error
      }
      const result = await client.list('collection_step_runs', {
        columns: STEP_RUN_FIELDS,
        filters: [
          { column: 'run_id', operator: 'eq', value: runIdentifier },
          { column: 'id', operator: 'eq', value: stepIdentifier }
        ],
        limit: 1
      })
      const step = rows(result).find(row => String(row.run_id) === runIdentifier && String(row.id) === stepIdentifier)
      if (!step) {
        const error = new Error('未找到该运行下的步骤记录')
        error.status = 404
        error.code = 'STEP_RUN_NOT_FOUND'
        throw error
      }
      return { item: step }
    },
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
      return { item: await startCreatedRun(item(result)) }
    },
    async createFromStep(workflowIdValue, stepIdValue, mode, input = {}) {
      const workflowId = validation.integer(workflowIdValue, { min: 1, required: true, label: '工作流 ID' })
      const stepId = validation.integer(stepIdValue, { min: 1, required: true, label: '步骤 ID' })
      if (!['single_step', 'continue'].includes(mode)) { const error = new Error('运行模式必须是 single_step 或 continue'); error.status = 400; error.code = 'INVALID_RUN_MODE'; throw error }
      const workflow = (await client.get('collection_workflows', workflowId, { columns: ['id', 'enabled', 'default_config'] })).data
      if (!workflow.enabled) { const error = new Error('工作流已停用，不能创建运行'); error.status = 409; error.code = 'WORKFLOW_DISABLED'; throw error }
      const step = (await client.get('collection_workflow_steps', stepId, { columns: ['id', 'workflow_id', 'script_id', 'step_key', 'seq', 'config_override'] })).data
      if (Number(step.workflow_id) !== workflowId) { const error = new Error('步骤不属于指定工作流'); error.status = 400; error.code = 'STEP_WORKFLOW_MISMATCH'; throw error }
      const workflowSteps = rows(await client.list('collection_workflow_steps', { columns: ['id', 'step_key', 'seq', 'config_override'], filters: [{ column: 'workflow_id', operator: 'eq', value: workflowId }], order: [{ column: 'seq', direction: 'asc' }] }))
      const priorStepKeys = new Set(workflowSteps.filter(row => Number(row.seq) < Number(step.seq)).map(row => row.step_key))
      const configOverride = selectAllowedRunOverride(input.config_snapshot || input.config || {}, DEFAULT_RUN_OVERRIDE_KEYS)
      const parentRunId = input.parent_run_id || input.parentRunId || null
      if (mode === 'continue' && !parentRunId) { const error = new Error('从指定步骤继续必须提供失败或中断运行的 parent_run_id'); error.status = 400; error.code = 'PARENT_RUN_REQUIRED'; throw error }
      let inputArtifacts = []
      let ruleSnapshot = input.rule_snapshot ?? {}
      let strategySnapshot = input.strategy_snapshot ?? {}
      if (parentRunId) {
        const parent = (await client.get('collection_runs', String(parentRunId), { columns: RUN_FIELDS })).data
        if (Number(parent.workflow_id) !== workflowId) { const error = new Error('续跑来源运行不属于该工作流'); error.status = 400; error.code = 'PARENT_WORKFLOW_MISMATCH'; throw error }
        const frozenSteps = Array.isArray(parent.workflow_snapshot?.steps) && parent.workflow_snapshot.steps.length
          ? parent.workflow_snapshot.steps
          : workflowSteps
        const frozenStepByKey = new Map(frozenSteps.map(row => [String(row.step_key), row]))
        const startingStep = frozenSteps.find(row => Number(row.id) === stepId && String(row.step_key) === String(step.step_key))
          || frozenSteps.find(row => String(row.step_key) === String(step.step_key))
          || step
        const startingSeq = Number(startingStep.seq ?? step.seq)
        const remainingSteps = frozenSteps.filter(row => Number(row.seq) >= startingSeq).sort((left, right) => Number(left.seq) - Number(right.seq))
        const needed = []
        const neededKeys = new Set()
        const addNeeded = reference => {
          const sourceKey = typeof reference === 'string' ? reference : String(reference?.step_key || '').trim()
          const artifactType = typeof reference === 'object' ? String(reference?.artifact_type || '').trim() : ''
          const artifactId = typeof reference === 'object' ? String(reference?.artifact_id || reference?.id || '').trim() : ''
          const sourceStep = sourceKey ? frozenStepByKey.get(sourceKey) : null
          if (sourceStep && Number(sourceStep.seq) >= startingSeq) return
          const key = artifactId ? `artifact:${artifactId}` : `${sourceKey}\0${artifactType}`
          if (neededKeys.has(key)) return
          neededKeys.add(key)
          needed.push({ source_step_key: sourceKey, artifact_type: artifactType, artifact_id: artifactId })
        }
        for (const downstreamStep of remainingSteps) {
          const stepConfig = downstreamStep.config_override || {}
          for (const reference of Array.isArray(stepConfig.input_steps) ? stepConfig.input_steps : []) addNeeded(reference)
          for (const reference of Array.isArray(stepConfig.input_artifacts) ? stepConfig.input_artifacts : []) {
            const artifactId = typeof reference === 'string' ? reference : String(reference?.artifact_id || reference?.id || '').trim()
            if (artifactId) addNeeded({ ...(typeof reference === 'object' ? reference : {}), artifact_id: artifactId })
          }
          const requirements = downstreamStep.script_snapshot?.required_artifacts || []
          const configuredTypes = new Set((Array.isArray(stepConfig.input_steps) ? stepConfig.input_steps : []).map(reference => typeof reference === 'object' ? String(reference?.artifact_type || '') : ''))
          for (const requirement of requirements) {
            const artifactType = String(requirement?.artifact_type || '').trim()
            if (!artifactType || requirement.required === false || configuredTypes.has(artifactType)) continue
            const producedDuringContinuation = frozenSteps.some(producer => Number(producer.seq) >= startingSeq && (producer.script_snapshot?.output_schema?.artifacts || []).some(output => output.artifact_type === artifactType))
            if (!producedDuringContinuation) addNeeded({ artifact_type: artifactType })
          }
        }

        const lineage = []
        const visitedRuns = new Set()
        let cursor = parent
        while (cursor && lineage.length < 20) {
          const cursorId = String(cursor.id || '')
          if (!cursorId || visitedRuns.has(cursorId)) break
          visitedRuns.add(cursorId)
          const manifest = cursor.artifact_manifest || {}
          const entries = Array.isArray(manifest) ? manifest : Array.isArray(manifest.artifacts) ? manifest.artifacts : []
          for (const entry of entries) lineage.push({ ...entry, source_run_id: entry.source_run_id || cursorId })
          const inherited = cursor.config_snapshot?.input_artifacts
          if (Array.isArray(inherited)) for (const entry of inherited) lineage.push({ ...entry })
          if (!cursor.parent_run_id) break
          const next = (await client.get('collection_runs', String(cursor.parent_run_id), { columns: RUN_FIELDS })).data
          if (!next) break
          cursor = next
        }

        const selected = []
        const selectedKeys = new Set()
        for (const requirement of needed) {
          const entry = lineage.find(candidate => {
            if (candidate.availability && candidate.availability !== 'available') return false
            if (requirement.artifact_id && String(candidate.artifact_id || candidate.id || '') !== requirement.artifact_id) return false
            if (requirement.artifact_type && String(candidate.artifact_type || '') !== requirement.artifact_type) return false
            if (requirement.source_step_key && String(candidate.producer_step_key || candidate.step_key || '') !== requirement.source_step_key) return false
            return true
          })
          if (!entry) continue
          const normalized = {
            artifact_id: String(entry.artifact_id || entry.id || ''),
            sha256: String(entry.sha256 || ''),
            artifact_type: String(entry.artifact_type || ''),
            schema_version: String(entry.schema_version || '1'),
            source_run_id: String(entry.source_run_id || parentRunId),
            producer_step_key: String(entry.producer_step_key || entry.step_key || ''),
            ...(entry.relative_path ? { relative_path: String(entry.relative_path) } : {})
          }
          if (!normalized.artifact_id || !normalized.sha256 || !normalized.artifact_type) continue
          const key = `${normalized.source_run_id}\0${normalized.artifact_id}\0${normalized.sha256}`
          if (selectedKeys.has(key)) continue
          selectedKeys.add(key)
          selected.push(normalized)
        }
        const targetSnapshot = frozenSteps.find(row => Number(row.id) === stepId && String(row.step_key) === String(step.step_key))
          || frozenSteps.find(row => String(row.step_key) === String(step.step_key))
        const configuredSteps = Array.isArray(targetSnapshot?.config_override?.input_steps) ? targetSnapshot.config_override.input_steps : Array.isArray(step.config_override?.input_steps) ? step.config_override.input_steps : []
        const configuredArtifacts = Array.isArray(targetSnapshot?.config_override?.input_artifacts) ? targetSnapshot.config_override.input_artifacts : Array.isArray(step.config_override?.input_artifacts) ? step.config_override.input_artifacts : []
        const requirements = targetSnapshot?.script_snapshot?.required_artifacts || []
        inputArtifacts = selected.length ? selected : lineage.filter(entry => {
          if (entry.availability && entry.availability !== 'available') return false
          if (entry.step_key && !priorStepKeys.has(entry.step_key)) return false
          if (configuredSteps.length) return configuredSteps.some(source => {
            const sourceKey = typeof source === 'string' ? source : source?.step_key
            const sourceType = typeof source === 'object' ? source.artifact_type : null
            return sourceKey === (entry.producer_step_key || entry.step_key) && (!sourceType || sourceType === entry.artifact_type)
          })
          if (configuredArtifacts.length) return configuredArtifacts.some(reference => (reference?.artifact_id || reference?.id || reference) === entry.artifact_id)
          return !requirements.length || requirements.some(requirement => requirement.artifact_type === entry.artifact_type && String(requirement.schema_version || '1') === String(entry.schema_version || '1'))
        }).map(entry => ({
          artifact_id: String(entry.artifact_id || entry.id || ''),
          sha256: String(entry.sha256 || ''),
          artifact_type: String(entry.artifact_type || ''),
          schema_version: String(entry.schema_version || '1'),
          source_run_id: String(entry.source_run_id || parentRunId),
          producer_step_key: String(entry.producer_step_key || entry.step_key || ''),
          ...(entry.relative_path ? { relative_path: String(entry.relative_path) } : {})
        })).filter(entry => entry.artifact_id && entry.sha256 && entry.artifact_type)
        if (input.rule_snapshot === undefined) ruleSnapshot = parent.rule_snapshot || {}
        if (input.strategy_snapshot === undefined) strategySnapshot = parent.strategy_snapshot || {}
      }
      if (input.input_artifacts !== undefined) inputArtifacts = normalizeInputArtifacts(input.input_artifacts)
      else inputArtifacts = normalizeInputArtifacts(inputArtifacts)
      configOverride.input_artifacts = inputArtifacts
      const result = await client.rpc('create_collection_run_from_step', {
        p_workflow_id: workflowId,
        p_step_id: stepId,
        p_single_step: mode === 'single_step',
        p_config_override: configOverride,
        p_rule_snapshot: ruleSnapshot,
        p_strategy_snapshot: strategySnapshot,
        p_parent_run_id: parentRunId
      })
      const created = item(result)
      return { item: await startCreatedRun(created), mode, start_step: { id: step.id, step_key: step.step_key }, parent_run_id: parentRunId, input_artifact_count: inputArtifacts.length }
    },
    async createScriptRun(input = {}) {
      const scriptId = validation.integer(input.script_id ?? input.scriptId, { min: 1, required: true })
      const script = (await client.get('collector_scripts', scriptId, { columns: SCRIPT_FIELDS })).data
      const inputArtifacts = normalizeInputArtifacts(input.input_artifacts ?? input.inputArtifacts ?? [])
      const publishMode = input.publish_mode || input.publishMode || 'preview'
      validateScriptRunRequest(script, { inputArtifacts, publishMode })
      let configOverride = selectAllowedRunOverride(input.config_snapshot || input.config || {}, DEFAULT_RUN_OVERRIDE_KEYS)
      if (script?.script_key === 'hotword-expand' && (configOverride.search_mode || script.default_config?.search_mode) === 'manual_keywords') {
        configOverride = normalizeManualSearchConfig({ ...configOverride, search_mode: 'manual_keywords' })
        delete configOverride.hotwords
      }
      if (script?.script_key === 'wxrank-strategy') {
        configOverride.request_types = validateWxRankRequestTypes(configOverride, { mode: 'single_validation' })
        delete configOverride.request_type
      }
      configOverride.publish_mode = publishMode
      configOverride.input_artifacts = inputArtifacts
      const result = await client.rpc('create_collection_script_run', { p_script_id: scriptId, p_config_override: configOverride, p_input_artifacts: inputArtifacts, p_rule_snapshot: input.rule_snapshot || {}, p_strategy_snapshot: input.strategy_snapshot || {}, p_parent_run_id: input.parent_run_id || null })
      const created = item(result)
      return { item: await startCreatedRun(created), script }
    },
    async cancel(id) {
      const error = new Error('当前执行器未提供真实中断能力，运行状态未修改。')
      error.status = 409
      error.code = 'CANCEL_UNSUPPORTED'
      throw error
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
        return { item: await startCreatedRun(item(result)), parent_run_id: String(id) }
      }
      const result = await client.rpc('create_collection_run', { p_workflow_id: old.workflow_id, p_config_override: configOverride, p_rule_snapshot: old.rule_snapshot || {}, p_strategy_snapshot: old.strategy_snapshot || {}, p_parent_run_id: String(id) })
      return { item: await startCreatedRun(item(result)), parent_run_id: String(id) }
    }
  })
}

export { RUN_FIELDS, RUN_LIST_FIELDS, SCRIPT_RUN_FIELDS, CANDIDATE_RUN_FIELDS, STEP_RUN_FIELDS }
