import { ConfigValidationError, createConfigValidation } from './config-validation.mjs'
import { SCRIPT_RUN_MODES } from '../../src/runner/workflow.mjs'

const validation = createConfigValidation()
const SCRIPT_FIELDS = ['id', 'name', 'script_key', 'platform', 'description', 'execution_type', 'entrypoint', 'enabled', 'version', 'timeout_seconds', 'retry_count', 'default_config', 'input_schema', 'output_schema', 'code_hash', 'capabilities', 'run_mode', 'required_artifacts', 'credential_ref', 'created_at', 'updated_at']

function item(result) { return Array.isArray(result?.data) ? result.data[0] || null : result?.data || null }
function rows(result) { return Array.isArray(result?.data) ? result.data : result?.data ? [result.data] : [] }
function invalid(code) { throw new ConfigValidationError(code) }

function scriptPayload(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('INVALID_PAYLOAD')
  const output = {}
  const required = ['name', 'script_key', 'platform', 'entrypoint', 'version', 'code_hash']
  for (const field of required) if (!partial || input[field] !== undefined) {
    if (input[field] === undefined || input[field] === null || input[field] === '') invalid(`INVALID_${field.toUpperCase()}`)
  }
  for (const field of SCRIPT_FIELDS.filter(field => field !== 'id' && field !== 'created_at' && field !== 'updated_at')) if (input[field] !== undefined) output[field] = input[field]
  if (output.execution_type !== undefined && output.execution_type !== 'node') invalid('INVALID_EXECUTION_TYPE')
  if (output.entrypoint !== undefined && (!/^[^\\/][^\r\n]*\.mjs$/u.test(output.entrypoint) || output.entrypoint.includes('..'))) invalid('INVALID_ENTRYPOINT')
  if (output.version !== undefined) output.version = validation.integer(output.version, { min: 1, max: 1_000_000, required: true })
  if (output.timeout_seconds !== undefined) output.timeout_seconds = validation.integer(output.timeout_seconds, { min: 1, max: 86_400, required: true })
  if (output.retry_count !== undefined) output.retry_count = validation.integer(output.retry_count, { min: 0, max: 10, required: true })
  if (output.capabilities !== undefined && !Array.isArray(output.capabilities)) invalid('INVALID_CAPABILITIES')
  if (output.run_mode !== undefined && !SCRIPT_RUN_MODES.includes(output.run_mode)) invalid('INVALID_RUN_MODE')
  if (output.required_artifacts !== undefined && (!Array.isArray(output.required_artifacts) || output.required_artifacts.some(item => !item || typeof item !== 'object' || Array.isArray(item)))) invalid('INVALID_REQUIRED_ARTIFACTS')
  return output
}

export function createCollectorService({ client } = {}) {
  if (!client) throw new TypeError('collection client is required')
  return Object.freeze({
    async list(query = {}) {
      const { page, pageSize, offset } = validation.parsePageQuery(query)
      const result = await client.list('collector_scripts', { columns: SCRIPT_FIELDS, order: [{ column: 'script_key', direction: 'asc' }, { column: 'version', direction: 'desc' }], limit: pageSize, offset, count: 'exact' })
      return { items: rows(result), total: result.total ?? null, page, pageSize }
    },
    async get(id) { return { item: item(await client.get('collector_scripts', validation.integer(id, { min: 1, required: true }), { columns: SCRIPT_FIELDS })) } },
    async create(input) { const result = await client.insert('collector_scripts', scriptPayload(input)); return { item: item(result) } },
    async update(id, input) {
      const scriptId = validation.integer(id, { min: 1, required: true })
      const payload = scriptPayload(input, { partial: true })
      const filters = [{ column: 'id', operator: 'eq', value: scriptId }]
      if (input?.expected_updated_at) filters.push({ column: 'updated_at', operator: 'eq', value: input.expected_updated_at })
      const result = await client.patch('collector_scripts', filters, payload)
      if (!rows(result).length) { const error = new Error('collector script changed'); error.status = 409; error.code = 'CAS_CONFLICT'; throw error }
      return { item: item(result) }
    },
    async remove(id, input = {}) {
      const scriptId = validation.integer(id, { min: 1, required: true })
      const filters = [{ column: 'id', operator: 'eq', value: scriptId }]
      if (input.expected_updated_at) filters.push({ column: 'updated_at', operator: 'eq', value: input.expected_updated_at })
      const result = await client.remove('collector_scripts', filters)
      return { id: scriptId, deleted: rows(result).length || result.status === 204 }
    }
  })
}

export { SCRIPT_FIELDS }
