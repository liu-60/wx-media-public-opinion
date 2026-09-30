import crypto from 'node:crypto'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { redactDiagnostic } from './contract.mjs'

function safePart(value) {
  const part = String(value || '').trim()
  if (!part || part === '.' || part === '..' || /[\\/]/u.test(part) || !/^[A-Za-z0-9._:-]+$/u.test(part)) throw new TypeError('unsafe artifact path')
  return part
}

function safeRelative(value) {
  const relative = String(value || '').trim().replaceAll('\\', '/')
  if (!relative || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new TypeError('unsafe artifact path')
  return relative
}

function runFile(rootPath, runId, relativePath) {
  const runRoot = path.resolve(rootPath, safePart(runId))
  const target = path.resolve(runRoot, safeRelative(relativePath))
  if (!target.startsWith(`${runRoot}${path.sep}`)) throw new TypeError('unsafe artifact path')
  return target
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function safeStepPart(value) {
  const stepKey = String(value || '').trim()
  if (!stepKey || stepKey === '.' || stepKey === '..' || /[\\/]/u.test(stepKey)) throw new TypeError('unsafe artifact path')
  return /^[A-Za-z0-9._:-]+$/u.test(stepKey) ? stepKey : `step-${sha256(Buffer.from(stepKey)).slice(0,24)}`
}

export function createArtifactStore(root = path.resolve('data/collection-runs')) {
  const rootPath = path.resolve(root)
  const runPath = runId => path.join(rootPath, safePart(runId))
  const attemptPath = (runId, stepKey, attempt) => path.join(runPath(runId), 'attempts', safeStepPart(stepKey), safePart(attempt))
  const write = async (filePath, content) => {
    await mkdir(path.dirname(filePath), { recursive: true })
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
    await writeFile(filePath, buffer)
    return { path: filePath, bytes: buffer.length, sha256: sha256(buffer) }
  }
  return Object.freeze({
    root: rootPath,
    runPath,
    attemptPath,
    writeJson: async (runId, relativeName, value) => {
      const fileName = safePart(relativeName)
      return { artifact_id: fileName, ...(await write(path.join(runPath(runId), fileName), `${JSON.stringify(value, null, 2)}\n`)) }
    },
    writeText: async (runId, relativeName, value) => { const fileName = safePart(relativeName); return { artifact_id: fileName, ...(await write(path.join(runPath(runId), fileName), value)) } },
    writeLog: async (runId, stepKey, attempt, value) => {
      const relativePath = path.relative(rootPath, path.join(attemptPath(runId, stepKey, attempt), 'stderr.log')).replaceAll(path.sep, '/')
      return { artifact_id: `log-${safeStepPart(stepKey)}-${safePart(attempt)}`, relative_path: relativePath, ...(await write(path.join(rootPath, relativePath), redactDiagnostic(value))) }
    },
    manifest: async (runId, entries, metadata = {}) => {
      const normalized = entries.map(entry => ({ ...entry, sha256: entry.sha256 || sha256(Buffer.from(String(entry.content || ''), 'utf8')), content: undefined }))
      return write(path.join(runPath(runId), 'manifest.json'), `${JSON.stringify({ schema_version: 'collection-artifact-v1', run_id: safePart(runId), ...metadata, artifacts: normalized }, null, 2)}\n`)
    },
    readManifest: async runId => JSON.parse(await readFile(runFile(rootPath, runId, 'manifest.json'), 'utf8')),
    readPath: async (runId, relativePath) => readFile(runFile(rootPath, runId, relativePath)),
    verifyPath: async (runId, relativePath, expectedHash) => {
      const filePath = runFile(rootPath, runId, relativePath)
      const content = await readFile(filePath)
      const actual = sha256(content)
      if (expectedHash && actual !== expectedHash) {
        const error = new Error('artifact hash mismatch')
        error.code = 'ARTIFACT_HASH_MISMATCH'
        throw error
      }
      return { path: filePath, sha256: actual, bytes: (await stat(filePath)).size }
    },
    read: async (runId, relativeName) => readFile(path.join(runPath(runId), safePart(relativeName))),
    verify: async (runId, relativeName, expectedHash) => {
      const filePath = path.join(runPath(runId), safePart(relativeName))
      const content = await readFile(filePath)
      const actual = sha256(content)
      if (expectedHash && actual !== expectedHash) throw new Error('artifact hash mismatch')
      return { path: filePath, sha256: actual, bytes: (await stat(filePath)).size }
    }
  })
}
