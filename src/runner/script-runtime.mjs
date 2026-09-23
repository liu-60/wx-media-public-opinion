import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseCollectorInput, parseCollectorFinalResult, redactDiagnostic } from './contract.mjs'

export async function readCollectorInput() {
  let data = ''
  for await (const chunk of process.stdin) data += chunk.toString('utf8')
  return parseCollectorInput(JSON.parse(data || '{}'))
}

export function emitEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

export async function writeArtifact(workdir, artifactId, value) {
  const name = String(artifactId || '').trim()
  if (!name || name === '.' || name === '..' || /[\\/]/u.test(name)) throw new TypeError('unsafe artifact id')
  const root = path.resolve(workdir)
  const target = path.resolve(root, name)
  if (!target.startsWith(`${root}${path.sep}`)) throw new TypeError('artifact is outside workdir')
  await mkdir(root, { recursive: true })
  const content = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await writeFile(target, content)
  return { artifact_id: name, sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length }
}

export async function readArtifact(workdir, reference) {
  const name = String(reference?.artifact_id || reference?.id || '').trim()
  if (!name || name === '.' || name === '..' || /[\\/]/u.test(name)) throw new TypeError('unsafe artifact id')
  const root = path.resolve(workdir)
  const target = path.resolve(root, name)
  if (!target.startsWith(`${root}${path.sep}`)) throw new TypeError('artifact is outside workdir')
  const content = await readFile(target)
  const hash = createHash('sha256').update(content).digest('hex')
  if (reference?.sha256 && reference.sha256 !== hash) throw new Error('artifact hash mismatch')
  return JSON.parse(content.toString('utf8'))
}

export async function runCollectorMain(handler) {
  try {
    const input = await readCollectorInput()
    const result = await handler(input)
    emitEvent({ type: 'result', ...parseCollectorFinalResult(result) })
  } catch (error) {
    process.stderr.write(`${redactDiagnostic(error?.stack || error?.message || error)}\n`)
    const requestCount = Number.isSafeInteger(error?.request_count) && error.request_count >= 0 ? error.request_count : null
    emitEvent({ type: 'result', status: 'failed', input_count: null, output_count: null, created_count: null, updated_count: null, filtered_count: null, request_count: requestCount, duration_ms: 0, artifact: null, error_code: error?.code || 'COLLECTOR_ERROR', message: redactDiagnostic(error?.message || 'collector failed') })
    process.exitCode = 1
  }
}
