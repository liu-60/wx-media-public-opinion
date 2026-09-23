import { canonicalArtifactType, artifactTypeMatches } from './artifact-contract.mjs'

function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]))
  return value
}

export const SCRIPT_RUN_MODES = Object.freeze(['standalone', 'requires_input', 'workflow_only'])

function capabilityError(code, message, status = 400) {
  const error = new Error(message || code)
  error.code = code
  error.status = status
  return error
}

export function getScriptRunMode(script = {}) {
  const mode = script.run_mode || (Array.isArray(script.required_artifacts) && script.required_artifacts.length ? 'requires_input' : 'standalone')
  if (!SCRIPT_RUN_MODES.includes(mode)) throw capabilityError('INVALID_RUN_MODE', 'collector run mode is invalid')
  return mode
}

export function getRequiredArtifacts(script = {}) {
  if (script.required_artifacts === undefined || script.required_artifacts === null) return []
  if (!Array.isArray(script.required_artifacts)) throw capabilityError('INVALID_REQUIRED_ARTIFACTS', 'required_artifacts must be an array')
  return script.required_artifacts.map((requirement, index) => {
    if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement)) throw capabilityError('INVALID_REQUIRED_ARTIFACTS', `required_artifacts[${index}] is invalid`)
    const artifactType = canonicalArtifactType(requirement)
    const schemaVersion = String(requirement.schema_version || '').trim()
    if (!artifactType || !schemaVersion) throw capabilityError('INVALID_REQUIRED_ARTIFACTS', `required_artifacts[${index}] needs artifact_type and schema_version`)
    return { ...clone(requirement), artifact_type: artifactType, schema_version: schemaVersion, required: requirement.required !== false }
  })
}

function matchesArtifact(requirement, artifact) {
  if (!artifact || typeof artifact !== 'object') return false
  if (requirement.artifact_id && (artifact.artifact_id || artifact.id) !== requirement.artifact_id) return false
  return artifactTypeMatches(requirement, artifact)
}

export function validateScriptRunRequest(script = {}, { inputArtifacts = [], publishMode = 'preview' } = {}) {
  const mode = getScriptRunMode(script)
  if (mode === 'workflow_only') throw capabilityError('WORKFLOW_ONLY', 'collector script requires workflow context', 409)
  if (script.enabled === false) throw capabilityError('SCRIPT_DISABLED', 'collector script is disabled', 409)
  if (!['none', 'preview'].includes(publishMode)) throw capabilityError('PUBLISH_COMMIT_REQUIRES_WORKFLOW', 'standalone validation cannot commit business writes', 409)
  if (!Array.isArray(inputArtifacts)) throw capabilityError('INPUT_SCHEMA_INVALID', 'input_artifacts must be an array')
  const requirements = getRequiredArtifacts(script).filter(item => item.required)
  for (const requirement of requirements) {
    if (!inputArtifacts.some(artifact => matchesArtifact(requirement, artifact))) {
      const allowedTypes = new Set(requirements.map(item => item.artifact_type))
      const errorCode = inputArtifacts.some(artifact => !allowedTypes.has(canonicalArtifactType(artifact))) ? 'INPUT_SCHEMA_INVALID' : 'INPUT_MISSING'
      throw capabilityError(errorCode, `required artifact is missing or incompatible: ${requirement.artifact_type}@${requirement.schema_version}`)
    }
  }
  return { mode, requiredArtifacts: requirements }
}

export function validateOutputArtifacts(schema = {}, artifacts = [], { status = 'success' } = {}) {
  if (!['success', 'partial'].includes(status)) return true
  const refs = Array.isArray(artifacts) ? artifacts : []
  const matches = (requirement, ref) => artifactTypeMatches(requirement, ref)
  const required = Array.isArray(schema?.artifacts) ? schema.artifacts.filter(item => item?.required !== false) : []
  if (required.some(requirement => !refs.some(ref => matches(requirement, ref)))) throw capabilityError('OUTPUT_SCHEMA_INVALID', `required output artifact is missing: ${required.find(requirement => !refs.some(ref => matches(requirement, ref)))?.artifact_type || 'unknown'}`)
  if (Array.isArray(schema?.any_of) && schema.any_of.length && !schema.any_of.some(requirement => refs.some(ref => matches(requirement, ref)))) throw capabilityError('OUTPUT_SCHEMA_INVALID', 'no output artifact matches the registered output contract')
  return true
}

export function sortWorkflowSteps(steps = []) {
  if (!Array.isArray(steps)) throw new TypeError('workflow steps must be an array')
  return steps.map(clone).sort((left, right) => Number(left.seq) - Number(right.seq) || String(left.id ?? '').localeCompare(String(right.id ?? ''), 'en', { numeric: true }))
}

function readPath(context, path) {
  if (typeof path !== 'string' || !/^(run|steps)(\.[A-Za-z0-9_:-]+)+$/u.test(path)) throw new TypeError('condition path is invalid')
  return path.split('.').slice(1).reduce((current, key) => current?.[key], context[path.split('.')[0]])
}

function compare(left, op, right) {
  if (op === 'eq') return left === right
  if (op === 'neq') return left !== right
  if (op === 'in') return Array.isArray(right) && right.includes(left)
  if (op === 'exists') return right === true ? left !== undefined && left !== null : left === undefined || left === null
  if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
    if (typeof left !== 'number' || typeof right !== 'number') return false
    return ({ gt: left > right, gte: left >= right, lt: left < right, lte: left <= right })[op]
  }
  throw new TypeError('condition operator is unsupported')
}

export function evaluateCondition(condition, context = {}) {
  if (condition === undefined || condition === null) return true
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) throw new TypeError('condition must be an object')
  if (Object.hasOwn(condition, 'all')) {
    if (!Array.isArray(condition.all)) throw new TypeError('condition.all must be an array')
    return condition.all.every(item => evaluateCondition(item, context))
  }
  if (Object.hasOwn(condition, 'any')) {
    if (!Array.isArray(condition.any)) throw new TypeError('condition.any must be an array')
    return condition.any.some(item => evaluateCondition(item, context))
  }
  if (Object.hasOwn(condition, 'not')) return !evaluateCondition(condition.not, context)
  if (typeof condition.path !== 'string' || typeof condition.op !== 'string' || !Object.hasOwn(condition, 'value')) throw new TypeError('condition expression is unsupported')
  return compare(readPath(context, condition.path), condition.op, condition.value)
}

export function resolveStepDecision(step = {}, context = {}, manualSkips = {}) {
  if (step.enabled === false) return { action: 'skipped', reason: 'disabled' }
  if (manualSkips?.[step.step_key] === true || (Array.isArray(manualSkips) && manualSkips.includes(step.step_key))) return { action: 'skipped', reason: 'manual' }
  return evaluateCondition(step.condition, context) ? { action: 'run', reason: '' } : { action: 'skipped', reason: 'condition_false' }
}

export function buildWorkflowSnapshot({ workflow = {}, steps = [], scripts = new Map() } = {}) {
  return {
    id: workflow.id,
    name: workflow.name,
    enabled: workflow.enabled !== false,
    revision: workflow.revision,
    default_config: clone(workflow.default_config || {}),
    retention_config: clone(workflow.retention_config || {}),
    steps: sortWorkflowSteps(steps).map(step => ({
      ...clone(step),
      script_snapshot: clone(step.script_snapshot || scripts.get(step.script_id) || null)
    }))
  }
}

export function buildSingleScriptSnapshot(script = {}) {
  if (!script || typeof script !== 'object' || !script.script_key) throw new TypeError('script snapshot is required')
  return {
    kind: 'single_script',
    id: null,
    name: `脚本验证 · ${script.name || script.script_key}`,
    enabled: true,
    revision: Number(script.version || 1),
    default_config: clone(script.default_config || {}),
    retention_config: {},
    steps: [{
      id: null,
      script_id: script.id ?? null,
      step_key: script.script_key,
      seq: 10,
      enabled: true,
      config_override: {},
      condition: null,
      continue_on_error: false,
      retry_count: Number(script.retry_count || 0),
      timeout_seconds: script.timeout_seconds ?? null,
      script_snapshot: clone(script)
    }]
  }
}
