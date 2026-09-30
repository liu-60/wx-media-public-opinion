import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const COLLECTION_DEBUG_API_BUDGET_TIMEZONE = 'Asia/Singapore'
export const COLLECTION_DEBUG_API_BUDGET_MAX = 100

const PLATFORMS = Object.freeze(['WxRank', 'Redfox'])
const DEFAULT_LIMIT = 10
const DEFAULT_SETTINGS_FILE = path.resolve('data', 'collection-debug-api-budget.json')
const LIMIT_ENV_KEYS = Object.freeze({
  WxRank: 'COLLECTION_DEBUG_API_REQUEST_LIMIT_WXRANK',
  Redfox: 'COLLECTION_DEBUG_API_REQUEST_LIMIT_REDFOX'
})

function parseLimit(value, fallback = null) {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0 || number > COLLECTION_DEBUG_API_BUDGET_MAX) return fallback
  return number
}

function configuredDefault(platform, env) {
  const shared = parseLimit(env.COLLECTION_DEBUG_API_REQUEST_LIMIT, DEFAULT_LIMIT)
  return parseLimit(env[LIMIT_ENV_KEYS[platform]], shared)
}

function dateStamp(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: COLLECTION_DEBUG_API_BUDGET_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date)
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
  return `${values.year}${values.month}${values.day}`
}

export function resolveCollectionDebugApiBudgetFile({ artifactRoot = path.resolve('data', 'collection-runs'), env = process.env, now = new Date() } = {}) {
  const configured = String(env.COLLECTION_DEBUG_API_BUDGET_FILE || '').trim()
  if (configured) return path.resolve(configured)
  return path.join(path.resolve(artifactRoot), `.debug-api-request-budget-${dateStamp(now)}.json`)
}

function settingsFilePath(filePath, env) {
  return path.resolve(filePath || env.COLLECTION_DEBUG_API_BUDGET_SETTINGS_FILE || DEFAULT_SETTINGS_FILE)
}

function readLimits(filePath, env) {
  const defaults = Object.fromEntries(PLATFORMS.map(platform => [platform, configuredDefault(platform, env)]))
  if (!existsSync(filePath)) return defaults
  try {
    const stored = JSON.parse(readFileSync(filePath, 'utf8'))
    if (!stored || typeof stored !== 'object' || Array.isArray(stored) || !stored.limits || typeof stored.limits !== 'object') return defaults
    return Object.fromEntries(PLATFORMS.map(platform => [platform, parseLimit(stored.limits[platform], defaults[platform])]))
  } catch {
    return defaults
  }
}

function readUsage(counterFilePath) {
  try {
    const state = JSON.parse(readFileSync(counterFilePath, 'utf8'))
    return Object.fromEntries(PLATFORMS.map(platform => {
      const count = Number(state?.[platform])
      return [platform, Number.isSafeInteger(count) && count >= 0 ? count : 0]
    }))
  } catch {
    return Object.fromEntries(PLATFORMS.map(platform => [platform, 0]))
  }
}

function invalidLimit(message) {
  const error = new Error(message)
  error.status = 400
  error.code = 'INVALID_DEBUG_API_LIMIT'
  return error
}

function validateLimits(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidLimit('请为 WxRank 和 RedFox 分别设置每日额度。')
  }
  const limits = {}
  for (const platform of Object.keys(LIMIT_ENV_KEYS)) {
    const value = input[platform]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > COLLECTION_DEBUG_API_BUDGET_MAX) {
      const displayName = platform === 'Redfox' ? 'RedFox' : platform
      throw invalidLimit(`${displayName} 每日额度必须是 0 到 ${COLLECTION_DEBUG_API_BUDGET_MAX} 之间的整数。`)
    }
    limits[platform] = value
  }
  return limits
}

export function createCollectionDebugBudgetSettings({ settingsFilePath: configuredSettingsFile, counterFilePath: configuredCounterFile, artifactRoot = path.resolve('data', 'collection-runs'), env = process.env, nowProvider = () => new Date() } = {}) {
  const target = settingsFilePath(configuredSettingsFile, env)
  const getCounterFile = now => configuredCounterFile
    ? path.resolve(configuredCounterFile)
    : resolveCollectionDebugApiBudgetFile({ artifactRoot, env, now })

  const get = () => {
    const now = nowProvider()
    return {
      limits: readLimits(target, env),
      usage: readUsage(getCounterFile(now)),
      date: dateStamp(now),
      timezone: COLLECTION_DEBUG_API_BUDGET_TIMEZONE,
      max_limit: COLLECTION_DEBUG_API_BUDGET_MAX
    }
  }

  const set = input => {
    const limits = validateLimits(input?.limits)
    const directory = path.dirname(target)
    mkdirSync(directory, { recursive: true })
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ limits }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(temporary, 0o600) } catch { /* Windows may not expose POSIX modes. */ }
    renameSync(temporary, target)
    try { chmodSync(target, 0o600) } catch { /* Windows may not expose POSIX modes. */ }
    return get()
  }

  const toEnvironment = () => Object.fromEntries(PLATFORMS.map(platform => [LIMIT_ENV_KEYS[platform], String(readLimits(target, env)[platform])]))
  return Object.freeze({ filePath: target, get, set, toEnvironment })
}

export function createCollectionDebugBudgetEnvironmentProvider({ baseEnvironmentProvider = () => process.env, settings } = {}) {
  return () => ({
    ...(typeof baseEnvironmentProvider === 'function' ? baseEnvironmentProvider() : {}),
    ...(typeof settings?.toEnvironment === 'function' ? settings.toEnvironment() : {})
  })
}
