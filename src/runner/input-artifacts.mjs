function manifestEntries(manifest) {
  if (Array.isArray(manifest)) return manifest
  return Array.isArray(manifest?.artifacts) ? manifest.artifacts : []
}

function inputError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function findManifestEntry(entries, reference) {
  return entries.find(entry => entry?.artifact_id === reference.artifact_id || entry?.id === reference.artifact_id || (reference.relative_path && entry?.relative_path === reference.relative_path))
}

function contractMatches(reference, entry) {
  return artifactTypeMatches(reference, entry)
}

/**
 * Resolve and copy typed input artifacts into the current run directory.
 * A source manifest and the source file hash are both required. The copied
 * artifact always uses its logical artifact_id in the current run so the
 * collector protocol never receives a cross-run path.
 */
export async function materializeInputArtifacts({ runId, references = [], artifacts, sourceArtifacts = artifacts, artifactEntries = [] } = {}) {
  if (!artifacts || typeof artifacts.readManifest !== 'function' || typeof artifacts.verifyPath !== 'function' || typeof artifacts.readPath !== 'function') {
    throw new TypeError('artifact store must support manifest and path verification')
  }
  if (!Array.isArray(references)) throw inputError('INPUT_SCHEMA_INVALID', 'input_artifacts must be an array')
  const copiedReferences = []
  const copiedEntries = []
  for (const reference of references) {
    const isLocalTest = reference.source === 'local_test'
    const sourceStore = isLocalTest ? sourceArtifacts : artifacts
    const sourceRunId = String(isLocalTest ? reference.source_test_bundle_id || '' : reference.source_run_id || reference.run_id || runId)
    if (!sourceRunId) throw inputError('INPUT_ARTIFACT_SOURCE_MISSING', `input artifact source is missing: ${reference.artifact_id}`)
    let manifest
    try {
      manifest = await sourceStore.readManifest(sourceRunId)
    } catch (error) {
      throw inputError('INPUT_ARTIFACT_MANIFEST_MISSING', `input artifact manifest is unavailable: ${reference.artifact_id}`)
    }
    const entry = findManifestEntry(manifestEntries(manifest), reference)
    if (!entry) throw inputError('INPUT_ARTIFACT_NOT_FOUND', `input artifact is not listed in manifest: ${reference.artifact_id}`)
    if (!contractMatches(reference, entry)) throw inputError('INPUT_SCHEMA_INVALID', `input artifact contract mismatch: ${reference.artifact_id}`)
    const relativePath = entry.relative_path || reference.relative_path || reference.artifact_id
    let verified
    let content
    try {
      verified = await sourceStore.verifyPath(sourceRunId, relativePath, reference.sha256)
      content = await sourceStore.readPath(sourceRunId, relativePath)
    } catch (error) {
      if (error?.code === 'ARTIFACT_HASH_MISMATCH') throw error
      throw inputError('INPUT_ARTIFACT_INVALID', `input artifact cannot be read: ${reference.artifact_id}`)
    }
    const copied = sourceRunId === String(runId) && relativePath === reference.artifact_id
      ? { artifact_id: reference.artifact_id, sha256: verified.sha256, bytes: verified.bytes }
      : await artifacts.writeText(runId, reference.artifact_id, content)
    const normalized = {
      ...reference,
      artifact_id: copied.artifact_id,
      sha256: copied.sha256,
      relative_path: copied.artifact_id,
      artifact_type: canonicalArtifactType(entry),
      schema_version: entry.schema_version
    }
    copiedReferences.push(normalized)
    copiedEntries.push({
      ...normalized,
      kind: 'input',
      step_key: '$run',
      source_run_id: isLocalTest ? undefined : sourceRunId === String(runId) ? undefined : sourceRunId,
      source_test_bundle_id: isLocalTest ? sourceRunId : undefined,
      source: isLocalTest ? 'local_test' : undefined,
      availability: 'available',
      bytes: copied.bytes,
      record_count: entry.record_count,
      default_visible: false
    })
  }
  artifactEntries.push(...copiedEntries)
  return { references: copiedReferences, entries: copiedEntries }
}
import { artifactTypeMatches, canonicalArtifactType } from './artifact-contract.mjs'
