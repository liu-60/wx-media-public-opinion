import { ConfigValidationError, createConfigValidation } from './config-validation.mjs'

const validation = createConfigValidation()
const WORKFLOW_FIELDS = ['id', 'name', 'enabled', 'system_generated', 'validation_only', 'revision', 'default_config', 'retention_config', 'created_at', 'updated_at']
const STEP_FIELDS = ['id', 'workflow_id', 'script_id', 'step_key', 'seq', 'enabled', 'config_override', 'condition', 'continue_on_error', 'retry_count', 'timeout_seconds', 'created_at', 'updated_at']
function rows(result) { return Array.isArray(result?.data) ? result.data : result?.data ? [result.data] : [] }
function item(result) { return rows(result)[0] || null }
function invalid(code, message) { throw new ConfigValidationError(code, message) }

async function ensureStepTargets(client, payload, excludeStepId = null) {
  try { await client.get('collection_workflows', payload.workflow_id, { columns: ['id'] }) }
  catch (error) { if (error?.code === 'NOT_FOUND') invalid('WORKFLOW_NOT_FOUND'); throw error }
  try { await client.get('collector_scripts', payload.script_id, { columns: ['id', 'script_key', 'enabled'] }) }
  catch (error) { if (error?.code === 'NOT_FOUND') invalid('SCRIPT_NOT_FOUND'); throw error }
  const existing = rows(await client.list('collection_workflow_steps', { columns: ['id', 'step_key', 'seq'], filters: [{ column: 'workflow_id', operator: 'eq', value: payload.workflow_id }] }))
    .filter(row => Number(row.id) !== Number(excludeStepId))
  if (existing.some(row => row.step_key === payload.step_key)) invalid('STEP_KEY_DUPLICATE')
  if (existing.some(row => Number(row.seq) === Number(payload.seq))) invalid('STEP_SEQUENCE_DUPLICATE')
}

async function withStepConstraintMessage(operation) {
  try { return await operation() }
  catch (error) {
    if (error?.code === 'UPSTREAM_CONFLICT') {
      const conflict = new Error('步骤标识、顺序或脚本关联与数据库约束冲突，请刷新后重试。')
      conflict.status = 409
      conflict.code = 'STEP_CONSTRAINT_CONFLICT'
      throw conflict
    }
    throw error
  }
}

function workflowPayload(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('INVALID_PAYLOAD')
  if (!partial && !String(input.name || '').trim()) invalid('INVALID_NAME')
  const output = {}
  for (const field of ['name', 'enabled', 'revision', 'default_config', 'retention_config']) if (input[field] !== undefined) output[field] = input[field]
  if (output.revision !== undefined) output.revision = validation.integer(output.revision, { min: 1, max: 1_000_000, required: true })
  if (output.enabled !== undefined && typeof output.enabled !== 'boolean') invalid('INVALID_BOOLEAN')
  return output
}

function stepPayload(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('INVALID_PAYLOAD')
  if (!partial && (!String(input.step_key || '').trim() || input.script_id === undefined)) invalid('INVALID_STEP')
  const output = {}
  for (const field of ['workflow_id', 'script_id', 'step_key', 'seq', 'enabled', 'config_override', 'condition', 'continue_on_error', 'retry_count', 'timeout_seconds']) if (input[field] !== undefined) output[field] = input[field]
  if (!partial) {
    output.step_key = validation.text(input.step_key, { required: true, max: 128 })
    output.seq = validation.integer(input.seq, { min: 0, required: true, label: '步骤顺序' })
  }
  const integerLabels = { workflow_id: '工作流 ID', script_id: '脚本 ID', seq: '步骤顺序', retry_count: '重试次数' }
  for (const field of ['workflow_id', 'script_id', 'seq', 'retry_count']) {
    if (output[field] === undefined) continue
    const minimum = field === 'seq' || field === 'retry_count' ? 0 : 1
    const maximum = field === 'retry_count' ? 10 : Number.MAX_SAFE_INTEGER
    output[field] = validation.integer(output[field], { min: minimum, max: maximum, required: field === 'workflow_id' || field === 'script_id' || (!partial && field === 'seq'), label: integerLabels[field] })
  }
  for (const field of ['enabled', 'continue_on_error']) if (output[field] !== undefined && typeof output[field] !== 'boolean') invalid('INVALID_BOOLEAN')
  if (output.timeout_seconds !== undefined && output.timeout_seconds !== null) output.timeout_seconds = validation.integer(output.timeout_seconds, { min: 1, max: 86_400, required: true })
  for (const field of ['config_override', 'condition']) {
    if (output[field] !== undefined && output[field] !== null && (typeof output[field] !== 'object' || Array.isArray(output[field]))) {
      throw new ConfigValidationError('INVALID_PAYLOAD', `${field === 'condition' ? '条件' : '步骤配置'}必须是 JSON 对象。`)
    }
  }
  return output
}

export function createWorkflowService({ client } = {}) {
  if (!client) throw new TypeError('collection client is required')
  return Object.freeze({
    async list(query = {}) {
      const { page, pageSize, offset } = validation.parsePageQuery(query)
      const filters = query.include_validation === 'true' || query.include_validation === true ? [] : [{ column: 'validation_only', operator: 'eq', value: false }]
      const result = await client.list('collection_workflows', { columns: WORKFLOW_FIELDS, filters, order: [{ column: 'updated_at', direction: 'desc' }], limit: pageSize, offset, count: 'exact' })
      return { items: rows(result), total: result.total ?? null, page, pageSize }
    },
    async get(id) {
      const workflowId = validation.integer(id, { min: 1, required: true })
      const [workflow, steps] = await Promise.all([
        client.get('collection_workflows', workflowId, { columns: WORKFLOW_FIELDS }),
        client.list('collection_workflow_steps', { columns: STEP_FIELDS, filters: [{ column: 'workflow_id', operator: 'eq', value: workflowId }], order: [{ column: 'seq', direction: 'asc' }] })
      ])
      return { item: { ...workflow.data, steps: rows(steps) } }
    },
    async create(input) {
      const result = await client.insert('collection_workflows', workflowPayload(input))
      return { item: item(result) }
    },
    async update(id, input) {
      const workflowId = validation.integer(id, { min: 1, required: true })
      const filters = [{ column: 'id', operator: 'eq', value: workflowId }]
      if (input?.expected_updated_at) filters.push({ column: 'updated_at', operator: 'eq', value: input.expected_updated_at })
      const result = await client.patch('collection_workflows', filters, workflowPayload(input, { partial: true }))
      if (!rows(result).length) { const error = new Error('workflow changed'); error.status = 409; error.code = 'CAS_CONFLICT'; throw error }
      return { item: item(result) }
    },
    async remove(id, input = {}) {
      const workflowId = validation.integer(id, { min: 1, required: true })
      const filters = [{ column: 'id', operator: 'eq', value: workflowId }]
      if (input.expected_updated_at) filters.push({ column: 'updated_at', operator: 'eq', value: input.expected_updated_at })
      const result = await client.remove('collection_workflows', filters)
      return { id: workflowId, deleted: rows(result).length || result.status === 204 }
    },
    async listSteps(workflowId) {
      const id = validation.integer(workflowId, { min: 1, required: true })
      return { items: rows(await client.list('collection_workflow_steps', { columns: STEP_FIELDS, filters: [{ column: 'workflow_id', operator: 'eq', value: id }], order: [{ column: 'seq', direction: 'asc' }] })) }
    },
    async createStep(workflowId, input) {
      const payload = stepPayload({ ...input, workflow_id: workflowId })
      await ensureStepTargets(client, payload)
      return { item: item(await withStepConstraintMessage(() => client.insert('collection_workflow_steps', payload))) }
    },
    async updateStep(id, input) {
      const stepId = validation.integer(id, { min: 1, required: true })
      let current
      try { current = (await client.get('collection_workflow_steps', stepId, { columns: STEP_FIELDS })).data }
      catch (error) { if (error?.code === 'NOT_FOUND') invalid('STEP_NOT_FOUND', '指定的工作流步骤不存在。'); throw error }
      const payload = stepPayload(input, { partial: true })
      if (payload.workflow_id !== undefined && Number(payload.workflow_id) !== Number(current.workflow_id)) invalid('STEP_WORKFLOW_IMMUTABLE', '步骤不能移动到其他工作流，请在目标工作流中重新添加。')
      if (payload.script_id !== undefined || payload.step_key !== undefined || payload.seq !== undefined) {
        await ensureStepTargets(client, { ...current, ...payload, workflow_id: current.workflow_id }, stepId)
      }
      const filters = [{ column: 'id', operator: 'eq', value: stepId }]
      if (input?.expected_updated_at) filters.push({ column: 'updated_at', operator: 'eq', value: input.expected_updated_at })
      const result = await withStepConstraintMessage(() => client.patch('collection_workflow_steps', filters, payload))
      if (!rows(result).length) { const error = new Error('workflow step changed'); error.status = 409; error.code = 'CAS_CONFLICT'; throw error }
      return { item: item(result) }
    },
    async removeStep(id, input = {}) {
      const stepId = validation.integer(id, { min: 1, required: true })
      const filters = [{ column: 'id', operator: 'eq', value: stepId }]
      if (input.expected_updated_at) filters.push({ column: 'updated_at', operator: 'eq', value: input.expected_updated_at })
      const result = await client.remove('collection_workflow_steps', filters)
      return { id: stepId, deleted: rows(result).length || result.status === 204 }
    },
    async reorder(workflowId, steps) {
      const id = validation.integer(workflowId, { min: 1, required: true })
      if (!Array.isArray(steps) || !steps.length) invalid('INVALID_STEPS')
      const normalized = steps.map(step => ({ id: validation.integer(step.id, { min: 1, required: true }), seq: validation.integer(step.seq, { min: 0, required: true }) }))
      return { items: rows(await client.rpc('reorder_collection_workflow_steps', { p_workflow_id: id, p_steps: normalized })) }
    }
  })
}

export { WORKFLOW_FIELDS, STEP_FIELDS }
