import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

function normalizeRoot(rootDir) {
  return realpathSync(path.resolve(rootDir))
}

function relativeSafe(rootDir, candidate) {
  const relative = path.relative(rootDir, candidate)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('entrypoint is outside the repository root')
  return relative.replaceAll(path.sep, '/')
}

export async function loadCollectorRegistry(filePath) {
  const value = JSON.parse(await readFile(filePath, 'utf8'))
  const scripts = Array.isArray(value) ? value : value.scripts
  if (!Array.isArray(scripts)) throw new TypeError('collector registry scripts must be an array')
  return Object.freeze(scripts.map(entry => Object.freeze({ ...entry })))
}

export function hashFile(filePath) {
  const content = readFileSync(filePath)
  return crypto.createHash('sha256').update(content).digest('hex')
}

export function resolveRegisteredEntrypoint(entry, { rootDir = process.cwd(), gitLsFiles = null } = {}) {
  if (!entry || typeof entry.entrypoint !== 'string') throw new TypeError('registry entrypoint is required')
  const root = normalizeRoot(rootDir)
  const candidate = path.resolve(root, entry.entrypoint)
  relativeSafe(root, candidate)
  const target = realpathSync(candidate)
  const relative = relativeSafe(root, target)
  if (path.extname(target) !== '.mjs') throw new Error('collector entrypoint must be an ESM .mjs file')
  if (!statSync(target).isFile()) throw new Error('collector entrypoint is not a file')
  const registered = gitLsFiles
    ? gitLsFiles(relative)
    : execFileSync('git', ['ls-files', '--error-unmatch', '--', relative], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim()
  if (!registered) throw new Error('collector entrypoint is not Git-registered')
  return { absolutePath: target, relativePath: relative, codeHash: hashFile(target) }
}

export function validateScriptSnapshot(entry, resolved) {
  if (!entry || !resolved) throw new TypeError('script entry and resolved file are required')
  if (Number(entry.version) < 1 || (resolved.version !== undefined && Number(entry.version) !== Number(resolved.version))) throw new Error('collector version drift')
  if (entry.code_hash && entry.code_hash !== resolved.codeHash) throw new Error('collector code hash drift')
  return true
}
