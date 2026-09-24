import crypto from 'node:crypto'

export const COLLECTOR_STATUSES = Object.freeze(['success', 'partial', 'failed', 'skipped', 'waiting_auth'])
export const RUNNER_STATUSES = Object.freeze(['pending', 'running', 'retrying', 'timed_out', 'cancelled', 'blocked', 'interrupted'])
const COUNT_FIELDS = Object.freeze(['input_count', 'output_count', 'created_count', 'updated_count', 'filtered_count', 'request_count'])

function invalid(message) {
  throw new TypeError(message)
}

function text(value, field, { required = true, max = 500 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) invalid(`${field} is required`)
    return ''
  }
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`${field} is invalid`)
  return value.trim()
}

function object(value, field, { nullable = false } = {}) {
  if (value === null && nullable) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${field} must be an object`)
  return value
}

function nonnegativeInteger(value, field, { nullable = true } = {}) {
  if (value === null && nullable) return null
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${field} must be a nonnegative integer or null`)
  return value
}

function artifactRef(value, field = 'artifact') {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return value.map((item, index) => artifactRef(item, `${field}[${index}]`))
  const ref = object(value, field)
  const artifactId = text(ref.artifact_id ?? ref.id, `${field}.artifact_id`)
  if (/[\\/]/u.test(artifactId) || artifactId === '.' || artifactId === '..') invalid(`${field}.artifact_id is unsafe`)
  const sha256 = text(ref.sha256 ?? ref.hash, `${field}.sha256`, { max: 128 })
  if (!/^[a-f0-9]{32,128}$/iu.test(sha256)) invalid(`${field}.sha256 is invalid`)
  const output = { artifact_id: artifactId, sha256 }
  for (const key of ['artifact_type', 'schema_version', 'source_run_id', 'relative_path', 'kind']) {
    if (ref[key] !== undefined && ref[key] !== null) output[key] = text(ref[key], `${field}.${key}`, { max: 256 })
  }
  if (ref.record_count !== undefined && ref.record_count !== null) output.record_count = nonnegativeInteger(ref.record_count, `${field}.record_count`)
  if (ref.bytes !== undefined && ref.bytes !== null) output.bytes = nonnegativeInteger(ref.bytes, `${field}.bytes`)
  return output
}

export function parseCollectorInput(value = {}) {
  const input = object(value, 'input')
  if (input.protocol_version !== '1.0') invalid('protocol_version must be 1.0')
  const attempt = input.attempt
  if (!Number.isSafeInteger(attempt) || attempt < 1) invalid('attempt must be a positive integer')
  const config = object(input.config, 'config')
  const inputArtifacts = input.input_artifacts ?? input.input_artifact_refs ?? []
  if (!Array.isArray(inputArtifacts)) invalid('input_artifacts must be an array')
  const executionMode = input.execution_mode ?? 'single_validation'
  if (!['single_validation', 'workflow'].includes(executionMode)) invalid('execution_mode is invalid')
  return Object.freeze({
    protocol_version: '1.0',
    run_id: text(input.run_id, 'run_id'),
    step_run_id: text(input.step_run_id, 'step_run_id'),
    attempt,
    config,
    workdir: text(input.workdir, 'workdir', { max: 2000 }),
    input_artifacts: inputArtifacts.map((item, index) => artifactRef(item, `input_artifacts[${index}]`)),
    rule_snapshot_ref: artifactRef(input.rule_snapshot_ref, 'rule_snapshot_ref'),
    strategy_snapshot_ref: artifactRef(input.strategy_snapshot_ref, 'strategy_snapshot_ref'),
    publish_mode: ['none', 'preview', 'commit'].includes(input.publish_mode) ? input.publish_mode : invalid('publish_mode is invalid'),
    execution_mode: executionMode
  })
}

export function parseCollectorFinalResult(value = {}) {
  const result = object(value, 'result')
  if (!COLLECTOR_STATUSES.includes(result.status)) invalid('result.status is invalid')
  const normalized = { status: result.status }
  for (const field of COUNT_FIELDS) normalized[field] = nonnegativeInteger(result[field], field)
  normalized.duration_ms = nonnegativeInteger(result.duration_ms, 'duration_ms', { nullable: false })
  normalized.request_count = nonnegativeInteger(result.request_count, 'request_count')
  normalized.artifact = artifactRef(result.artifact)
  normalized.debug_artifacts = artifactRef(result.debug_artifacts ?? []) || []
  if (result.business_summary !== undefined && result.business_summary !== null) normalized.business_summary = object(result.business_summary, 'business_summary')
  normalized.message = text(result.message ?? '', 'message', { required: false, max: 2000 })
  if (result.error_code !== undefined && result.error_code !== null) normalized.error_code = text(result.error_code, 'error_code', { max: 128 })
  return Object.freeze(normalized)
}

export function parseCollectorOutput(stdout = '', { exitCode = null } = {}) {
  if (typeof stdout !== 'string') invalid('stdout must be text')
  const events = []
  let terminal = null
  for (const [index, line] of stdout.split(/\r?\n/u).map(value => value.trim()).filter(Boolean).entries()) {
    let event
    try { event = JSON.parse(line) } catch { invalid(`stdout line ${index + 1} is not JSON`) }
    if (!event || typeof event !== 'object' || Array.isArray(event)) invalid(`stdout line ${index + 1} is not an event object`)
    if (event.type === 'result' || event.event === 'result' || COLLECTOR_STATUSES.includes(event.status)) {
      if (terminal) invalid('stdout must contain exactly one terminal result')
      terminal = parseCollectorFinalResult(event)
    } else if (typeof event.type !== 'string') {
      invalid(`stdout line ${index + 1} has no event type`)
    }
    events.push(event)
  }
  if (!terminal) invalid('stdout must contain exactly one terminal result')
  const businessFailure = terminal.status === 'failed' || terminal.status === 'partial' || terminal.status === 'waiting_auth'
  return { events, result: terminal, exitCode, businessFailure }
}

export function redactDiagnostic(value, secrets = []) {
  let output = String(value ?? '')
  for (const secret of [...secrets].filter(item => typeof item === 'string' && item).sort((a, b) => b.length - a.length)) output = output.split(secret).join('[REDACTED]')
  return output
    .replace(/(REDFOX_API_KEY|SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|API_KEY|authorization|token|password|secret)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/giu, '$1=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
}

export function inputHash(input) {
  return crypto.createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex')
}

export { COUNT_FIELDS }
