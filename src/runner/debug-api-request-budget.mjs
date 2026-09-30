import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const budgetFile = process.env.COLLECTION_DEBUG_API_BUDGET_FILE

function configuredLimit(platform, env = process.env) {
  const platformEnv = platform === 'WxRank'
    ? env.COLLECTION_DEBUG_API_REQUEST_LIMIT_WXRANK
    : env.COLLECTION_DEBUG_API_REQUEST_LIMIT_REDFOX
  const raw = platformEnv ?? env.COLLECTION_DEBUG_API_REQUEST_LIMIT ?? '10'
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : 10
}

function budgetDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export async function readDebugApiRequestBudgetSnapshot({ file = budgetFile, env = process.env, now = new Date() } = {}) {
  const used = { WxRank: 0, Redfox: 0 }
  if (file) {
    try {
      const value = JSON.parse(await readFile(path.resolve(file), 'utf8'))
      for (const platform of Object.keys(used)) {
        const count = Number(value?.[platform])
        if (Number.isSafeInteger(count) && count >= 0) used[platform] = count
      }
    } catch {}
  }
  const limits = { WxRank: configuredLimit('WxRank', env), Redfox: configuredLimit('Redfox', env) }
  const platforms = Object.fromEntries(Object.keys(used).map(platform => [platform, { limit: limits[platform], used: used[platform], remaining: Math.max(0, limits[platform] - used[platform]) }]))
  return { date: budgetDate(now), timezone: 'Asia/Singapore', file: file ? path.resolve(file) : null, platforms, total_limit: Object.values(limits).reduce((sum, value) => sum + value, 0), total_used: Object.values(used).reduce((sum, value) => sum + value, 0), total_remaining: Object.values(platforms).reduce((sum, value) => sum + value.remaining, 0) }
}

function platformFor(input) {
  let url
  try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url) } catch { return null }
  const host = url.hostname.toLowerCase()
  if (host === 'wxrank.com' || host.endsWith('.wxrank.com')) return 'WxRank'
  if (host === 'redfox.hk' || host.endsWith('.redfox.hk')) return 'Redfox'
  return null
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function withLock(file, callback) {
  await mkdir(path.dirname(file), { recursive: true })
  const lock = `${file}.lock`
  let handle
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try { handle = await open(lock, 'wx'); break } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const info = await stat(lock)
        if (Date.now() - info.mtimeMs > 120_000) await rm(lock, { force: true })
      } catch {}
      await delay(10)
    }
  }
  if (!handle) { const error = new Error('API 调试计数器锁定超时'); error.code = 'API_BUDGET_LOCK_TIMEOUT'; throw error }
  try { return await callback() } finally { await handle.close().catch(() => {}); await rm(lock, { force: true }).catch(() => {}) }
}

async function reserve(platform) {
  if (!budgetFile) return null
  const limit = configuredLimit(platform)
  return withLock(path.resolve(budgetFile), async () => {
    let state = { WxRank: 0, Redfox: 0 }
    try {
      const parsed = JSON.parse(await readFile(budgetFile, 'utf8'))
      state = { ...state, ...parsed }
    } catch {}
    const count = Number(state[platform] || 0)
    if (count >= limit) {
      const displayName = platform === 'Redfox' ? 'RedFox' : platform
      const error = new Error(`${displayName} 调试接口已达到每日 ${limit} 次额度，当前已用 ${count} 次，已阻止本次请求`)
      error.code = 'API_BUDGET_EXHAUSTED'
      throw error
    }
    state[platform] = count + 1
    await writeFile(budgetFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    return count + 1
  })
}

if (budgetFile && typeof globalThis.fetch === 'function') {
  const nativeFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (input, init) => {
    const platform = platformFor(input)
    if (!platform) return nativeFetch(input, init)
    const count = await reserve(platform)
    if (count !== null) {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      const method = String(init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase()
      process.stderr.write(`[${platform} ${count}/${configuredLimit(platform)}] ${method} ${url.hostname}${url.pathname}\n`)
    }
    return nativeFetch(input, init)
  }
}
