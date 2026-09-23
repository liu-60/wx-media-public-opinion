import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/u

export function defaultManagementTokenFile() {
  const base = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), '.config')
  return path.join(base, 'wx-media-opinion', 'management-token')
}

function normalizeToken(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function protectFile(filePath) {
  try { chmodSync(filePath, 0o600) } catch {}
}

export function resolveManagementToken({ token = process.env.MANAGEMENT_TOKEN, filePath = process.env.MANAGEMENT_TOKEN_FILE || defaultManagementTokenFile() } = {}) {
  const explicit = normalizeToken(token)
  if (explicit) return Object.freeze({ token: explicit, source: 'explicit_token', filePath: null })

  const target = path.resolve(filePath)
  mkdirSync(path.dirname(target), { recursive: true })
  try {
    const existing = normalizeToken(readFileSync(target, 'utf8'))
    if (TOKEN_PATTERN.test(existing)) {
      protectFile(target)
      return Object.freeze({ token: existing, source: 'persistent_file', filePath: target })
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const generated = randomBytes(32).toString('base64url')
  try {
    writeFileSync(target, `${generated}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  protectFile(target)
  const persisted = normalizeToken(readFileSync(target, 'utf8'))
  if (!TOKEN_PATTERN.test(persisted)) throw new Error('Persistent management token file is invalid')
  return Object.freeze({ token: persisted, source: 'persistent_file', filePath: target })
}
