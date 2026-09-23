import crypto from 'node:crypto'

const WRITE_SET_TABLES = ['accounts', 'articles', 'hotwords']

function invalid(code, status = 400) { const error = new Error(code); error.code = code; error.status = status; throw error }

function parseWriteSet(content) {
  let value
  try { value = JSON.parse(content) } catch { invalid('WRITE_SET_INVALID_JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('WRITE_SET_INVALID')
  for (const table of WRITE_SET_TABLES) if (!Array.isArray(value[table])) invalid('WRITE_SET_TABLE_MISSING')
  return value
}

export function createCollectionPublishService({ artifactService, runService } = {}) {
  if (!artifactService || typeof artifactService.get !== 'function') throw new TypeError('artifact service is required')
  if (!runService || typeof runService.rerun !== 'function') throw new TypeError('run service is required')
  async function preview(runId, input = {}) {
    let artifactId = String(input.artifact_id || 'write-set.json')
    let artifact
    try {
      artifact = await artifactService.get(runId, artifactId, { limit: 4_000_000 })
    } catch (error) {
      if (input.artifact_id || artifactId !== 'write-set.json') throw error
      artifactId = 'frozen-write-set.json'
      artifact = await artifactService.get(runId, artifactId, { limit: 4_000_000 })
    }
    if (artifact.truncated) invalid('WRITE_SET_TOO_LARGE')
    const writeSet = parseWriteSet(artifact.content)
    const writeSetHash = artifact.manifest?.sha256 || crypto.createHash('sha256').update(artifact.content, 'utf8').digest('hex')
    return {
      status: 'preview',
      run_id: String(runId),
      artifact_id: artifactId,
      write_set_hash: writeSetHash,
      counts: Object.fromEntries(WRITE_SET_TABLES.map(table => [table, writeSet[table].length])),
      metadata: writeSet.metadata || {},
      tables: WRITE_SET_TABLES,
      commit_allowed: true
    }
  }
  return Object.freeze({
    preview,
    async commit(runId, input = {}) {
      const checked = await preview(runId, input)
      if (!input.confirm_hash || input.confirm_hash !== checked.write_set_hash) invalid('WRITE_SET_CONFIRMATION_REQUIRED', 409)
      const queued = await runService.rerun(runId, {
        config_snapshot: {
          publish_mode: 'commit',
          publish_only: true,
          publish_artifact_run_id: String(runId),
          publish_artifact_id: checked.artifact_id,
          publish_write_set_hash: checked.write_set_hash
        }
      })
      if (typeof runService.setPublishStatus === 'function') await runService.setPublishStatus(runId, 'queued')
      return { ...checked, status: 'queued', queued_run: queued.item, parent_run_id: String(runId) }
    }
  })
}

export { WRITE_SET_TABLES }
