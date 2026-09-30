import { inputHash } from './contract.mjs'
import { getRequiredArtifacts, resolveStepDecision, sortWorkflowSteps } from './workflow.mjs'
import { artifactTypeMatches, canonicalizeArtifactRefs, canonicalizeArtifactRef } from './artifact-contract.mjs'

export class LeaseLostError extends Error {
  constructor() { super('worker lease lost'); this.name = 'LeaseLostError'; this.code = 'LEASE_LOST' }
}

function countResult(result, field) { return result?.[field] ?? null }

export async function runWorkflow({ run, store, executeStep, manualSkips = {}, input = {}, now = () => new Date().toISOString() } = {}) {
  if (!run || !store || typeof executeStep !== 'function') throw new TypeError('run, store and executeStep are required')
  const steps = sortWorkflowSteps(run.workflow_snapshot?.steps || [])
  const context = { run: { ...run, publish_mode: run.config_snapshot?.publish_mode || 'preview' }, steps: {} }
  const initialArtifacts = Array.isArray(input?.input_artifacts) ? input.input_artifacts.filter(Boolean) : []
  let hadFailure = false
  let hadPartial = false
  const summary = { steps: {}, failure_count: 0, partial_count: 0 }

  const stopForLease = async () => {
    await store.markInterrupted(run.id, 'lease_lost')
    throw new LeaseLostError()
  }

  for (const step of steps) {
    if (!await store.assertLease(run.id)) await stopForLease()
    const decision = run.config_snapshot?.publish_only && step.step_key !== 'publish-results'
      ? { action: 'skipped', reason: 'publish_only' }
      : resolveStepDecision(step, context, manualSkips)
    if (decision.action === 'skipped') {
      const skipped = await store.createStepRun({ runId: run.id, stepId: step.id, scriptId: step.script_id, stepKey: step.step_key, scriptSnapshot: step.script_snapshot || {}, attempt: 1, status: 'skipped', inputHash: inputHash(input) })
      await store.finishStepRun(skipped.id, { status: 'skipped', error_code: `STEP_${decision.reason.toUpperCase()}`, error_message: decision.reason, finished_at: now(), duration_ms: 0 })
      context.steps[step.step_key] = { status: 'skipped', reason: decision.reason }
      summary.steps[step.step_key] = context.steps[step.step_key]
      continue
    }
    // Debug artifacts are still part of the declared Artifact Contract.  They
    // are hidden from the normal UI by `default_visible: false`, but downstream
    // steps (for example LLM filtering) may explicitly require them.
    const producedArtifacts = Object.entries(context.steps).flatMap(([producerStepKey, value]) => [
      ...(Array.isArray(value?.artifacts) ? value.artifacts.map(artifact => ({ ...artifact, producer_step_key: producerStepKey })) : []),
      ...(Array.isArray(value?.debug_artifacts) ? value.debug_artifacts.map(artifact => ({ ...artifact, producer_step_key: producerStepKey })) : [])
    ])
    const availableArtifacts = [...initialArtifacts, ...producedArtifacts].map(canonicalizeArtifactRef)
    const available = new Set(availableArtifacts.map(value => value?.artifact_id || value?.id).filter(Boolean))
    const requiredContracts = getRequiredArtifacts(step.script_snapshot || {}).filter(item => item.required)
    const missingContract = requiredContracts.find(requirement => !availableArtifacts.some(artifact => artifactTypeMatches(requirement, artifact) && (!requirement.artifact_id || (artifact.artifact_id || artifact.id) === requirement.artifact_id)))
    const declaredSteps = Array.isArray(step.input_steps) ? step.input_steps : (Array.isArray(step.config_override?.input_steps) ? step.config_override.input_steps : [])
    const declaredInputs = Array.isArray(step.input_artifacts) ? step.input_artifacts : (Array.isArray(step.config_override?.input_artifacts) ? step.config_override.input_artifacts : [])
    const required = Array.isArray(step.required_inputs) ? step.required_inputs : (Array.isArray(step.config_override?.required_inputs) ? step.config_override.required_inputs : declaredInputs)
    const findDeclared = value => availableArtifacts.find(artifact => (artifact?.artifact_id || artifact?.id) === value || (typeof value === 'string' && (artifactTypeMatches({ artifact_type: value, schema_version: '1' }, artifact) || artifactTypeMatches({ artifact_id: value, schema_version: '1' }, artifact))))
    if (missingContract || required.some(value => !findDeclared(value))) {
      const blocked = await store.createStepRun({ runId: run.id, stepId: step.id, scriptId: step.script_id, stepKey: step.step_key, scriptSnapshot: step.script_snapshot || {}, attempt: 1, status: 'blocked', inputHash: inputHash(input) })
      const errorCode = missingContract ? 'INPUT_SCHEMA_INVALID' : 'INPUT_MISSING'
      const detail = missingContract ? `${missingContract.artifact_type}@${missingContract.schema_version}` : required.find(value => !findDeclared(value))
      await store.finishStepRun(blocked.id, { status: 'blocked', error_code: errorCode, error_message: `required artifact missing or incompatible: ${detail}`, finished_at: now(), duration_ms: 0 })
      await store.finishRun(run.id, 'blocked', { ...summary, blocked_step: step.step_key })
      return { status: 'blocked', run: await store.getRun(run.id) }
    }
    const selectedByStep = declaredSteps.flatMap(source => {
      const sourceStepKey = typeof source === 'string' ? source : source?.step_key
      const sourceType = typeof source === 'object' ? source.artifact_type : null
      return availableArtifacts.filter(artifact => artifact?.producer_step_key === sourceStepKey && (!sourceType || artifactTypeMatches({ artifact_type: sourceType, schema_version: String(source.schema_version || '1') }, artifact)))
    })
    const selectedArtifacts = declaredSteps.length
      ? [...new Map(selectedByStep.map(artifact => [artifact.artifact_id || artifact.id, artifact])).values()]
      : declaredInputs.length
      ? declaredInputs.map(reference => findDeclared(reference)).filter(Boolean)
      : requiredContracts.length
        ? requiredContracts.map(requirement => availableArtifacts.find(value => artifactTypeMatches(requirement, value) && (!requirement.artifact_id || (value.artifact_id || value.id) === requirement.artifact_id))).filter(Boolean)
        : availableArtifacts
    const stepInput = { ...input, input_artifacts: selectedArtifacts }
    const maxAttempts = step.script_snapshot?.script_key === 'wxrank-strategy'
      ? 1
      : 1 + Math.max(0, Number(step.retry_count || 0))
    let finalResult = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (!await store.assertLease(run.id)) await stopForLease()
      const stepRun = await store.createStepRun({ runId: run.id, stepId: step.id, scriptId: step.script_id, stepKey: step.step_key, scriptSnapshot: step.script_snapshot || {}, attempt, status: 'running', inputHash: inputHash(stepInput) })
      let result
      try { result = await executeStep(step, { run, stepRun, attempt, input: stepInput, context }) } catch (error) { result = { status: 'failed', error_code: error.code || 'EXECUTOR_ERROR', message: error.message } }
      if (!await store.assertLease(run.id)) await stopForLease()
      const normalized = result || { status: 'failed', error_code: 'EMPTY_RESULT', message: 'collector returned no result' }
      const hideWorkflowIntermediates = run.run_kind !== 'single_script' && step.script_snapshot?.script_key !== 'workflow-results'
      const shouldRetry = normalized.status === 'failed' && attempt < maxAttempts && !['AUTH_FAILED', 'QUOTA_EXHAUSTED', 'INVALID_ARGUMENT'].includes(normalized.error_code)
      await store.finishStepRun(stepRun.id, {
        status: shouldRetry ? 'retrying' : normalized.status,
        finished_at: now(),
        duration_ms: countResult(normalized, 'duration_ms'),
        input_count: countResult(normalized, 'input_count'),
        output_count: countResult(normalized, 'output_count'),
        created_count: countResult(normalized, 'created_count'),
        updated_count: countResult(normalized, 'updated_count'),
        filtered_count: countResult(normalized, 'filtered_count'),
        request_count: countResult(normalized, 'request_count'),
        error_code: normalized.error_code || null,
        error_message: ['failed', 'partial', 'waiting_auth', 'timed_out', 'blocked', 'interrupted', 'cancelled'].includes(normalized.status) ? (normalized.message || normalized.error_message || null) : null,
        summary: { message: normalized.message || normalized.error_message || '', business_summary: normalized.business_summary || {}, error_code: normalized.error_code || null },
        log_ref: normalized.log_ref || null,
        artifact_manifest: {
          artifacts: canonicalizeArtifactRefs(normalized.artifact).map(artifact => hideWorkflowIntermediates ? { ...artifact, kind: 'debug', default_visible: false } : artifact),
          debug_artifacts: canonicalizeArtifactRefs(normalized.debug_artifacts)
        }
      })
      finalResult = normalized
      if (!shouldRetry) break
    }
    const hideWorkflowIntermediates = run.run_kind !== 'single_script' && step.script_snapshot?.script_key !== 'workflow-results'
    const resultArtifacts = canonicalizeArtifactRefs(finalResult.artifact).map(artifact => hideWorkflowIntermediates ? { ...artifact, kind: 'debug', default_visible: false } : artifact)
    const debugArtifacts = canonicalizeArtifactRefs(finalResult.debug_artifacts)
    context.steps[step.step_key] = { status: finalResult.status, output_count: finalResult.output_count ?? null, request_count: finalResult.request_count ?? null, artifacts: resultArtifacts.map(artifact => ({ ...artifact, producer_step_key: step.step_key })), debug_artifacts: debugArtifacts.map(artifact => ({ ...artifact, producer_step_key: step.step_key })) }
    if (finalResult.business_summary) context.steps[step.step_key].business_summary = finalResult.business_summary
    summary.steps[step.step_key] = context.steps[step.step_key]
    if (finalResult.status === 'waiting_auth') {
      hadFailure = true
      summary.failure_count += 1
      if (!step.continue_on_error) {
        await store.finishRun(run.id, 'waiting_auth', summary)
        return { status: 'waiting_auth', run: await store.getRun(run.id) }
      }
    }
    if (['failed', 'timed_out', 'blocked', 'interrupted', 'cancelled'].includes(finalResult.status)) {
      hadFailure = true
      summary.failure_count += 1
      if (!step.continue_on_error) {
        await store.finishRun(run.id, finalResult.status, summary)
        return { status: finalResult.status, run: await store.getRun(run.id) }
      }
    }
    if (finalResult.status === 'partial') { hadPartial = true; summary.partial_count += 1 }
  }
  const status = hadFailure || hadPartial ? 'partial' : 'success'
  await store.finishRun(run.id, status, summary)
  return { status, run: await store.getRun(run.id) }
}
