import { ConfigValidationError, createConfigValidation } from './config-validation.mjs'

const validation = createConfigValidation()
const WORKFLOW_FIELDS = ['id', 'name', 'enabled', 'system_generated', 'validation_only', 'revision', 'default_config', 'retention_config', 'created_at', 'updated_at']
const STEP_FIELDS = ['id', 'workflow_id', 'script_id', 'step_key', 'seq', 'enabled', 'config_override', 'condition', 'continue_on_error', 'retry_count', 'timeout_seconds', 'created_at', 'updated_at']
function rows(result) { return Array.isArray(result?.data) ? result.data : result?.data ? [result.data] : [] }
function item(result) { return rows(result)[0] || null }
function invalid(code) { throw new ConfigValidationError(code) }

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
  for (const field of ['workflow_id', 'script_id', 'seq', 'retry_count']) if (output[field] !== undefined) output[field] = validation.integer(output[field], { min: field === 'seq' ? 0 : 1, max: field === 'retry_count' ? 10 : Number.MAX_SAFE_INTEGER, required: true })
  for (const field of ['enabled', 'continue_on_error']) if (output[field] !== undefined && typeof output[field] !== 'boolean') invalid('INVALID_BOOLEAN')
  if (output.timeout_seconds !== undefined && output.timeout_seconds !== null) output.timeout_seconds = validation.integer(output.timeout_seconds, { min: 1, max: 86_400, required: true })
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
      return { item: item(await client.insert('collection_workflow_steps', payload)) }
    },
    async updateStep(id, input) {
      const stepId = validation.integer(id, { min: 1, required: true })
      const filters = [{ column: 'id', operator: 'eq', value: stepId }]
      if (input?.expected_updated_at) filters.push({ column: 'updated_at', operator: 'eq', value: input.expected_updated_at })
      const result = await client.patch('collection_workflow_steps', filters, stepPayload(input, { partial: true }))
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
