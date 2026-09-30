import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { readFile, rename, mkdir as mkdirAsync, writeFile as writeFileAsync } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSupabaseClient } from '../../management-center/services/supabase.mjs'
import { articleIdentity } from '../../src/article-filter.mjs'
import { DEFAULT_ENDPOINT, fetchWxRankArticleList } from '../../src/collector-adapters/wxrank-articles.mjs'
import { createWxRankStrategyRequest } from '../../src/collector-adapters/wxrank-strategy.mjs'
import { runCollectorMain, writeArtifact } from '../../src/runner/script-runtime.mjs'
import { validateWxRankRequestTypes } from '../../src/runner/wxrank-strategy-config.mjs'
import { normalizeRankedArticle } from './article-collect.mjs'
import { loadCollectorEnvironment } from '../../src/collector-config.mjs'

export const WXRANK_STRATEGY_REQUEST_LIMIT = 4
const STRATEGY_TYPES = new Set(['account', 'wx_type', 'month', 'date'])
const STRATEGY_COLUMNS = Object.freeze([
  'id', 'request_type', 'source_targets', 'active_targets', 'completed_items',
  'date', 'month', 'cursor', 'min_read', 'max_read', 'cycle_no', 'updated_at'
])
const PROGRESS_CAS_COLUMNS = Object.freeze(['id', 'updated_at'])
const OUTPUT_FIELDS = Object.freeze(['title', 'pub_time', 'wx_name', 'wx_type', 'read_num', 'like_num', 'wx_biz', 'article_sn', 'article_url'])

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim()
}

function populated(value) {
  return value !== undefined && value !== null && value !== ''
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function copy(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function safeRequestLimit(value) {
  const requested = Number(value)
  if (!Number.isSafeInteger(requested) || requested < 0) return WXRANK_STRATEGY_REQUEST_LIMIT
  return Math.min(WXRANK_STRATEGY_REQUEST_LIMIT, requested)
}

export function strategyTargetKey(requestType, target) {
  if (requestType === 'account') {
    const identity = target?.account_id ?? target?.wx_biz ?? target?.wxBiz
    return `account:${text(identity)}`
  }
  if (requestType === 'date') return `date:${text(typeof target === 'string' ? target : target?.date)}`
  if (requestType === 'month') return `month:${text(typeof target === 'string' ? target : target?.month)}`
  return `${requestType === 'wx_type' ? 'type' : requestType}:${text(typeof target === 'string' ? target : target?.wx_type)}`
}

function strategyTargetLabel(requestType, target) {
  if (requestType === 'account') return text(target?.wx_name) || text(target?.wx_biz) || text(target?.account_id) || '公众号'
  if (requestType === 'date') return text(typeof target === 'string' ? target : target?.date) || '采集日期'
  if (requestType === 'month') return text(typeof target === 'string' ? target : target?.month) || '采集月份'
  return text(typeof target === 'string' ? target : target?.wx_type) || '采集对象'
}

function strategyTargets(row) {
  const targets = Array.isArray(row.active_targets) ? row.active_targets : []
  return row.request_type === 'month' && !targets.length && row.month ? [String(row.month)] : targets
}

function strategyRequestParameters(strategy, target, cursor) {
  const request = createWxRankStrategyRequest({
    requestType: strategy.request_type,
    strategy,
    target,
    cursor
  })
  const parameters = {}
  for (const [from, to] of [
    ['date', 'date'], ['month', 'month'], ['wxBiz', 'wx_biz'],
    ['minReadNum', 'min_read_num'], ['maxReadNum', 'max_read_num'],
    ['wxType', 'wx_type'], ['cursor', 'cursor']
  ]) {
    if (Object.hasOwn(request, from)) parameters[to] = request[from]
  }
  return parameters
}

export function buildWxRankStrategyPlan(strategyRows = [], { maxRequests = WXRANK_STRATEGY_REQUEST_LIMIT } = {}) {
  const requestLimit = safeRequestLimit(maxRequests)
  const strategies = []
  let expectedRequests = 0
  const requestPreview = []
  const previewLimit = requestLimit + 1

  for (const row of strategyRows.filter(item => STRATEGY_TYPES.has(item?.request_type))) {
    const cursor = Number(row.cursor)
    const activeTargets = strategyTargets(row)
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError(`strategy ${row.id} has an invalid cursor budget`)
    const datePages = (target, page) => (row.completed_items || []).find(item => item?.request_type === 'date' && item?.target_key === strategyTargetKey('date', target) && Number(item?.page_no) === page && ['reserved', 'success', 'failed'].includes(item?.status))
    const dateRemainingPages = target => {
      const pageOne = datePages(target, 1)
      if (!pageOne) return cursor > 1 ? cursor : 1
      if (pageOne.status !== 'success' || !hasCursor(pageOne.next_cursor)) return 0
      return cursor > 1 && !datePages(target, 2) ? 1 : 0
    }
    const targetPlans = activeTargets.map(target => {
      const completedPages = row.request_type === 'date' ? Array.from({ length: cursor }, (_, index) => index + 1).filter(page => ['success', 'failed'].includes(datePages(target, page)?.status)).length : 0
      const reservedPages = row.request_type === 'date' ? Array.from({ length: cursor }, (_, index) => index + 1).filter(page => datePages(target, page)?.status === 'reserved').length : 0
      return {
        target_key: strategyTargetKey(row.request_type, target),
        target: copy(target),
        page_budget: cursor,
        ...(row.request_type === 'date' ? { completed_pages: completedPages, reserved_pages: reservedPages, remaining_pages: dateRemainingPages(target) } : {})
      }
    })
    const groupExpected = row.request_type === 'date' ? targetPlans.reduce((sum, item) => sum + item.remaining_pages, 0) : activeTargets.length * cursor
    expectedRequests += groupExpected
    strategies.push({
      strategy_id: row.id,
      request_type: row.request_type,
      active_targets: targetPlans,
      cursor_budget: cursor,
      expected_requests: groupExpected,
      status: cursor === 0 ? 'disabled_cursor_zero' : activeTargets.length ? 'planned' : 'no_active_targets'
    })

    for (const target of activeTargets) {
      for (let page = 1; page <= cursor; page += 1) {
        const savedPage = row.request_type === 'date' ? datePages(target, page) : null
        if (savedPage) continue
        if (requestPreview.length >= previewLimit) break
        const priorPage = page > 1 && row.request_type === 'date' ? datePages(target, page - 1) : null
        const cursorValue = page === 1 ? undefined : (priorPage?.next_cursor ?? '上一请求返回的 data.cursor')
        requestPreview.push({
          strategy_id: row.id,
          request_type: row.request_type,
          target: copy(target),
          page,
          page_budget: cursor,
          page_cursor: page === 1 ? null : cursorValue,
          parameters: strategyRequestParameters(row, target, cursorValue)
        })
      }
      if (requestPreview.length >= previewLimit) break
    }
  }

  return {
    request_limit: requestLimit,
    configured_hard_limit: WXRANK_STRATEGY_REQUEST_LIMIT,
    expected_requests: expectedRequests,
    expectedRequests,
    within_limit: expectedRequests <= requestLimit,
    withinLimit: expectedRequests <= requestLimit,
    strategies,
    request_preview: requestPreview.slice(0, previewLimit)
  }
}

export function normalizeWxRankStrategyArticle(sourceRow, { requestType, target } = {}) {
  const normalized = normalizeRankedArticle(sourceRow || {}, 'wxrank-strategy')
  const wxType = requestType === 'wx_type'
    ? text(typeof target === 'string' ? target : target?.wx_type) || null
    : null
  const row = {
    title: populated(normalized.title) ? normalized.title : null,
    pub_time: populated(normalized.publish_time) ? normalized.publish_time : null,
    wx_name: null,
    wx_type: wxType,
    read_num: populated(normalized.read_num) ? normalized.read_num : null,
    like_num: populated(normalized.like_num) ? normalized.like_num : null,
    wx_biz: populated(normalized.wx_biz) ? normalized.wx_biz : null,
    article_sn: populated(normalized.article_sn) ? normalized.article_sn : null,
    article_url: populated(normalized.article_url) ? normalized.article_url : null
  }
  return row
}

export function deduplicateWxRankStrategyArticles(rows = []) {
  const unique = new Map()
  for (const row of rows) {
    const identity = articleIdentity(row).articleId
    const key = `${text(row.wx_biz)}\0${identity}`
    const existing = unique.get(key)
    if (!existing) {
      unique.set(key, { ...row })
      continue
    }
    for (const field of OUTPUT_FIELDS) {
      if (!populated(existing[field]) && populated(row[field])) existing[field] = row[field]
    }
  }
  return { rows: [...unique.values()], duplicate_count: rows.length - unique.size }
}

function completedTargetKey(item, requestType, cycleNo) {
  if (item?.cycle_no !== undefined && Number(item.cycle_no) !== cycleNo) return ''
  if (item?.target_key) return String(item.target_key)
  if (item?.target !== undefined) return strategyTargetKey(item.request_type || requestType, item.target)
  if (requestType === 'account' && (item?.account_id !== undefined || item?.wx_biz)) return strategyTargetKey('account', item)
  if (requestType === 'wx_type' && (item?.wx_type || item?.type)) return strategyTargetKey('wx_type', item.wx_type || item.type)
  if (requestType === 'month' && (item?.month || item?.target)) return strategyTargetKey('month', item.month || item.target)
  return ''
}

export function rotateCompletedStrategy(strategy, newlyCompleted = []) {
  const sourceTargets = Array.isArray(strategy.source_targets) ? strategy.source_targets : []
  const activeTargets = Array.isArray(strategy.active_targets) ? strategy.active_targets : []
  const cycleNo = Number(strategy.cycle_no || 1)
  const batchSize = Math.min(sourceTargets.length, activeTargets.length)
  const oldItems = Array.isArray(strategy.completed_items) ? strategy.completed_items : []
  const completedItems = [...oldItems]
  const existingKeys = new Set(oldItems.map(item => item?.idempotency_key).filter(Boolean))
  for (const item of newlyCompleted) {
    if (!existingKeys.has(item.idempotency_key)) {
      completedItems.push(copy(item))
      existingKeys.add(item.idempotency_key)
    }
  }

  if (batchSize === 0) {
    return { activeTargets: copy(activeTargets), completedItems, cycleNo, cursor: Number(strategy.cursor || 0), sourceTargets: copy(sourceTargets) }
  }

  const sourceKeys = sourceTargets.map(target => strategyTargetKey(strategy.request_type, target))
  if (new Set(sourceKeys).size !== sourceKeys.length || activeTargets.some(target => !sourceKeys.includes(strategyTargetKey(strategy.request_type, target)))) {
    throw new Error('STRATEGY_TARGET_POOL_INVALID')
  }
  const completedKeys = new Set(completedItems
    .filter(item => Number(item?.cycle_no) === cycleNo)
    .map(item => completedTargetKey(item, strategy.request_type, cycleNo))
    .filter(Boolean))
  const remaining = activeTargets.filter(target => !completedKeys.has(strategyTargetKey(strategy.request_type, target)))
  const cycleComplete = sourceKeys.every(key => completedKeys.has(key))

  let nextCycleNo = cycleNo
  let nextActiveTargets
  if (cycleComplete && remaining.length === 0) {
    nextCycleNo += 1
    nextActiveTargets = sourceTargets.slice(0, batchSize)
  } else {
    const anchorKey = strategyTargetKey(strategy.request_type, activeTargets.at(-1))
    const anchorIndex = sourceKeys.indexOf(anchorKey)
    const selectedKeys = new Set(remaining.map(target => strategyTargetKey(strategy.request_type, target)))
    const candidates = []
    for (let offset = 1; offset <= sourceTargets.length && remaining.length + candidates.length < batchSize; offset += 1) {
      const target = sourceTargets[(anchorIndex + offset) % sourceTargets.length]
      const key = sourceKeys[(anchorIndex + offset) % sourceTargets.length]
      if (completedKeys.has(key) || selectedKeys.has(key)) continue
      selectedKeys.add(key)
      candidates.push(target)
    }
    nextActiveTargets = [...remaining, ...candidates]
  }

  return {
    activeTargets: copy(nextActiveTargets),
    completedItems,
    cycleNo: nextCycleNo,
    cursor: Number(strategy.cursor || 0),
    sourceTargets: copy(sourceTargets)
  }
}

function emptyStats(plan) {
  const byStrategy = Object.fromEntries(plan.strategies.map(item => [item.request_type, { planned: 0, requests: 0, success: 0, failed: 0 }]))
  for (const item of plan.strategies) byStrategy[item.request_type].planned += item.expected_requests
  return { limit: plan.request_limit, planned: plan.expected_requests, total: 0, success: 0, failed: 0, by_strategy: byStrategy }
}

function initialStrategyResults(plan, strategyRows) {
  const rowsById = new Map(strategyRows.map(row => [String(row.id), row]))
  return plan.strategies.map(item => {
    const row = rowsById.get(String(item.strategy_id))
    return {
      strategy_id: item.strategy_id,
      strategy_type: item.request_type,
      planned_objects: item.active_targets.map(target => copy(target.target)),
      expected_requests: item.expected_requests,
      completed_objects: [],
      completed_count: 0,
      next_active_targets: copy(row?.active_targets || []),
      next_cursor: Number(row?.cursor || 0),
      next_expected_requests: item.expected_requests,
      progress_status: 'unchanged'
    }
  })
}

export function normalizeWorkflowStrategyStatus(status) {
  if (['skipped_cursor_zero', 'skipped_no_active_targets'].includes(status)) return 'success'
  return ['success', 'partial', 'waiting_auth'].includes(status) ? status : 'failed'
}

function safeKeyLabel(apiKey) {
  const key = text(apiKey)
  return key ? `已加载 ****${key.slice(-4)}` : '未加载'
}

function safeRequestPayload(apiKey, parameters) {
  return { key: safeKeyLabel(apiKey), ...parameters }
}

function actualCallResult({ strategy, target, page, pageCursor, parameters, response, error, apiKey }) {
  const data = response?.data || {}
  const requestCount = Number(response?.request_count) > 0 ? 1 : 0
  const list = Array.isArray(data.list) ? data.list : []
  return {
    strategy_id: strategy.id,
    strategy_type: strategy.request_type,
    target: copy(target),
    target_key: strategyTargetKey(strategy.request_type, target),
    page,
    page_cursor: pageCursor ?? null,
    request_count: requestCount,
    request: safeRequestPayload(apiKey, parameters),
    status: error ? 'failed' : response?.status || 'failed',
    error_code: error?.code || response?.error_code || null,
    message: error?.message || response?.message || null,
    returned_article_count: list.length,
    reported_total: data.total ?? null,
    response_cursor: data.cursor ?? null
  }
}

function hasCursor(value) {
  return value !== undefined && value !== null && value !== ''
}

function summarizeNextTargets(row, nextTargets) {
  const next = { ...row, active_targets: nextTargets }
  return {
    active_targets: copy(nextTargets),
    cursor: Number(row.cursor || 0),
    expected_requests: nextTargets.length * Number(row.cursor || 0)
  }
}

function singaporeDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value)
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function shiftDate(date, offset) {
  const [year, month, day] = date.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day + offset))
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`
}

export function currentWxRankDateTargets(now = new Date()) {
  const today = singaporeDate(now)
  return [shiftDate(today, -1), shiftDate(today, -2)]
}

export async function ensureWxRankDateStrategy(client, { now = new Date() } = {}) {
  const targets = currentWxRankDateTargets(now)
  const [yesterday] = targets
  const existing = rowsOf(await client.list('collection_strategy_groups', {
    columns: STRATEGY_COLUMNS,
    filters: [{ column: 'request_type', operator: 'eq', value: 'date' }],
    order: [{ column: 'id', direction: 'asc' }],
    limit: 10
  }))
  const cutoff = shiftDate(singaporeDate(now), -31)
  const completedItems = (existing[0]?.completed_items || []).filter(item => {
    if (item?.request_type !== 'date') return false
    const target = String(item.target_key || '').replace(/^date:/u, '')
    return target >= cutoff
  })
  const payload = {
    request_type: 'date', source_targets: targets, active_targets: targets,
    completed_items: completedItems, date: yesterday, month: null,
    cursor: 2, min_read: null, max_read: null,
    cycle_no: 1, updated_at: new Date(now).toISOString()
  }
  const current = existing[0]
  if (!current) {
    try {
      return rowsOf(await client.insert('collection_strategy_groups', payload))[0] || payload
    } catch (error) {
      const raced = rowsOf(await client.list('collection_strategy_groups', {
        columns: STRATEGY_COLUMNS,
        filters: [{ column: 'request_type', operator: 'eq', value: 'date' }],
        order: [{ column: 'id', direction: 'asc' }], limit: 10
      }))[0]
      if (!raced) throw error
      return raced
    }
  }
  const same = ['source_targets', 'active_targets', 'date', 'cursor'].every(key => stableJson(current[key] ?? null) === stableJson(payload[key] ?? null))
  if (same && stableJson(current.completed_items || []) === stableJson(completedItems)) return current
  const updated = await client.patch('collection_strategy_groups', [
    { column: 'id', operator: 'eq', value: current.id },
    { column: 'updated_at', operator: 'eq', value: current.updated_at }
  ], payload)
  const row = rowsOf(updated)[0]
  if (row) return row
  return (await client.get('collection_strategy_groups', current.id, { columns: STRATEGY_COLUMNS }))?.data || current
}

function datePageId(date, page) { return `${date}:page:${page}` }
function pageRecord(strategy, target, page) {
  const date = strategyTargetLabel('date', target)
  return (strategy.completed_items || []).find(item => item?.request_type === 'date' && item?.idempotency_key === datePageId(date, page)) || null
}

async function updateDatePageCheckpoint(client, strategyId, checkpoint, { onlyIfAbsent = false } = {}) {
  const now = new Date().toISOString()
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = (await client.get('collection_strategy_groups', strategyId, { columns: STRATEGY_COLUMNS }))?.data
    if (!current) throw new Error('DATE_STRATEGY_NOT_FOUND')
    const items = Array.isArray(current.completed_items) ? [...current.completed_items] : []
    const index = items.findIndex(item => item?.idempotency_key === checkpoint.idempotency_key)
    if (index >= 0 && onlyIfAbsent) return { item: items[index], claimed: false }
    if (index >= 0 && ['success', 'failed'].includes(items[index]?.status)) return { item: items[index], claimed: false }
    if (index >= 0) items[index] = { ...items[index], ...checkpoint }
    else items.push(checkpoint)
    const updated = await client.patch('collection_strategy_groups', [
      { column: 'id', operator: 'eq', value: strategyId },
      { column: 'updated_at', operator: 'eq', value: current.updated_at }
    ], { completed_items: items, updated_at: now })
    const row = rowsOf(updated)[0]
    if (row) return { item: checkpoint, row, claimed: true }
  }
  const error = new Error('DATE_STRATEGY_PROGRESS_CONFLICT')
  error.code = 'DATE_STRATEGY_PROGRESS_CONFLICT'
  throw error
}

function datePageCachePath(date, page) {
  return path.resolve('data', 'wxrank-date-pages', date, `page-${page}.json`)
}

async function readDatePageCache(date, page) {
  const file = datePageCachePath(date, page)
  if (!existsSync(file)) return null
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return null }
}

async function writeDatePageCache(date, page, value) {
  const file = datePageCachePath(date, page)
  await mkdirAsync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFileAsync(temporary, `${JSON.stringify(value)}\n`, 'utf8')
  await rename(temporary, file)
  return file
}

export async function executeWxRankStrategyPlan({
  strategies = [],
  apiKey = loadCollectorEnvironment().WXRANK_API_KEY,
  endpoint = DEFAULT_ENDPOINT,
  maxRequests = WXRANK_STRATEGY_REQUEST_LIMIT,
  fetchArticleList = fetchWxRankArticleList,
  lookupWxNames = async () => new Map(),
  updateProgress,
  reserveDatePage,
  finishDatePage,
  loadDatePage = readDatePageCache,
  saveDatePage = writeDatePageCache,
  verifySnapshot,
  onPlan
} = {}) {
  const plan = buildWxRankStrategyPlan(strategies, { maxRequests })
  onPlan?.(plan)
  const requestStats = emptyStats(plan)
  const strategyResults = initialStrategyResults(plan, strategies)
  const result = {
    status: 'planned',
    request_plan: plan,
    request_stats: requestStats,
    requests: [],
    articles: [],
    duplicate_count: 0,
    strategies: strategyResults,
    warnings: []
  }

  if (!plan.withinLimit) {
    result.status = 'request_budget_exceeded'
    return result
  }
  if (plan.expectedRequests === 0) {
    result.status = plan.strategies.length && plan.strategies.every(item => item.cursor_budget === 0)
      ? 'skipped_cursor_zero'
      : 'skipped_no_active_targets'
    return result
  }
  if (!text(apiKey)) {
    result.status = 'waiting_auth'
    result.warnings.push({ code: 'AUTH_ERROR', message: 'WXRANK_API_KEY is required; no request was sent' })
    for (const item of result.strategies) item.progress_status = 'waiting_auth'
    return result
  }
  if (verifySnapshot && !(await verifySnapshot(strategies))) {
    result.status = 'strategy_changed'
    result.warnings.push({ code: 'STRATEGY_CHANGED', message: '策略在执行前已变化；未发送请求' })
    for (const item of result.strategies) item.progress_status = 'strategy_changed'
    return result
  }

  let requestCounter = 0
  const allArticleRows = []
  const resultById = new Map(strategyResults.map(item => [String(item.strategy_id), item]))
  for (const strategy of strategies.filter(row => STRATEGY_TYPES.has(row.request_type))) {
    const strategyResult = resultById.get(String(strategy.id))
    if (strategy.request_type === 'date') {
      const completedThisStrategy = []
      const localLedger = Array.isArray(strategy.completed_items) ? copy(strategy.completed_items) : []
      for (const target of strategyTargets(strategy)) {
        const date = strategyTargetLabel('date', target)
        const targetKey = strategyTargetKey('date', target)
        const targetRequests = []
        const targetArticles = []
        let pageCursor
        let targetComplete = false
        let targetFailed = false
        let targetFailure = null
        for (let page = 1; page <= Number(strategy.cursor); page += 1) {
          const idempotencyKey = datePageId(date, page)
          let saved = localLedger.find(item => item?.idempotency_key === idempotencyKey)
          if (saved) {
            const cached = await loadDatePage(date, page)
            if (!cached) {
              targetFailure = { code: saved.status === 'reserved' ? 'REQUEST_OUTCOME_UNCERTAIN' : (saved.error_code || 'DATE_PAGE_ALREADY_CONSUMED'), message: '此日期页已有请求账本且无可恢复结果；为避免超额请求已跳过重试' }
              targetFailed = true
              targetComplete = true
              break
            }
            if (cached.rows?.length) targetArticles.push(...cached.rows)
            if (cached.rows?.length) allArticleRows.push(...cached.rows)
            pageCursor = cached.next_cursor ?? saved.next_cursor
            if (saved.status === 'reserved') {
              const finalized = { ...saved, status: 'success', next_cursor: pageCursor ?? null, returned_article_count: cached.rows?.length || 0, completed_at: new Date().toISOString() }
              const finish = await finishDatePage?.(strategy, finalized)
              if (finish?.item) saved = finish.item
              const index = localLedger.findIndex(item => item?.idempotency_key === idempotencyKey)
              if (index >= 0) localLedger[index] = saved
            }
            if (saved.status === 'failed') {
              targetFailed = true
              targetFailure = { code: saved.error_code || 'WXRANK_REQUEST_FAILED', message: saved.message || '历史日期页请求失败' }
              targetComplete = true
              break
            }
            if (!hasCursor(pageCursor) || page === Number(strategy.cursor)) targetComplete = true
            continue
          }
          if (page > 1 && !hasCursor(pageCursor)) {
            targetComplete = true
            break
          }
          if (requestCounter >= WXRANK_STRATEGY_REQUEST_LIMIT) {
            targetFailure = { code: 'REQUEST_BUDGET_EXCEEDED', message: 'global WxRank request cap reached' }
            targetFailed = true
            break
          }
          const reserveItem = {
            idempotency_key: idempotencyKey, request_type: 'date', target_key: targetKey,
            target: copy(target), page_no: page, status: 'reserved',
            page_cursor: pageCursor ?? null, reserved_at: new Date().toISOString()
          }
          const reservation = reserveDatePage
            ? await reserveDatePage(strategy, reserveItem)
            : { item: reserveItem, claimed: true }
          saved = reservation?.item || reserveItem
          if (!reservation?.claimed) {
            const cached = await loadDatePage(date, page)
            if (!cached) {
              targetFailure = { code: 'DATE_PAGE_ALREADY_RESERVED', message: '另一工作流已预留此日期页；本轮不重复请求' }
              targetFailed = true
              targetComplete = true
              break
            }
            if (cached.rows?.length) { targetArticles.push(...cached.rows); allArticleRows.push(...cached.rows) }
            pageCursor = cached.next_cursor ?? saved.next_cursor
            continue
          }
          localLedger.push(saved)
          const request = createWxRankStrategyRequest({ requestType: 'date', strategy, target, cursor: pageCursor })
          const parameters = strategyRequestParameters(strategy, target, pageCursor)
          requestCounter += 1
          let response
          let error
          try { response = await fetchArticleList({ apiKey, endpoint, ...request }) } catch (caught) { error = caught }
          if (Number(response?.request_count) === 0) requestCounter -= 1
          const callResult = actualCallResult({ strategy, target, page, pageCursor, parameters, response, error, apiKey })
          result.requests.push(callResult)
          targetRequests.push(callResult)
          if (callResult.request_count > 0) {
            requestStats.total += 1
            const groupStats = requestStats.by_strategy.date
            groupStats.requests += 1
            if (callResult.status === 'success') { requestStats.success += 1; groupStats.success += 1 }
            else { requestStats.failed += 1; groupStats.failed += 1 }
          }
          const responseRows = Array.isArray(response?.data?.list) ? response.data.list : []
          const normalizedRows = responseRows.map(row => normalizeWxRankStrategyArticle(row, { requestType: 'date', target }))
          const nextCursor = response?.data?.cursor ?? null
          let cacheFile = null
          try {
            cacheFile = await saveDatePage(date, page, { rows: normalizedRows, next_cursor: nextCursor, generated_at: new Date().toISOString() })
          } catch (cacheError) {
            error ||= cacheError
          }
          if (callResult.status === 'success' && !error) {
            targetArticles.push(...normalizedRows)
            allArticleRows.push(...normalizedRows)
          } else {
            targetFailed = true
            targetFailure = { code: callResult.error_code || error?.code || 'WXRANK_REQUEST_FAILED', message: callResult.message || error?.message || 'WxRank 日期页请求失败' }
          }
          const finalPage = {
            ...reserveItem, status: targetFailed ? 'failed' : 'success',
            next_cursor: nextCursor, request_count: callResult.request_count,
            returned_article_count: normalizedRows.length, error_code: targetFailure?.code || null,
            message: targetFailure?.message || null, cache_file: cacheFile || null,
            completed_at: new Date().toISOString()
          }
          const finished = await finishDatePage?.(strategy, finalPage)
          const savedFinal = finished?.item || finalPage
          const localIndex = localLedger.findIndex(item => item?.idempotency_key === idempotencyKey)
          if (localIndex >= 0) localLedger[localIndex] = savedFinal
          else localLedger.push(savedFinal)
          pageCursor = nextCursor
          if (targetFailed || !hasCursor(pageCursor) || page === Number(strategy.cursor)) {
            targetComplete = true
            break
          }
        }
        if (targetComplete && !targetFailed) {
          strategyResult.completed_objects.push(copy(target))
          strategyResult.completed_count += 1
          completedThisStrategy.push({ target_key: targetKey, target: copy(target), request_type: 'date', status: 'success', page_count: targetRequests.length, article_count: deduplicateWxRankStrategyArticles(targetArticles).rows.length })
        } else if (targetFailed) {
          strategyResult.failed_objects ??= []
          strategyResult.failed_objects.push({ target: copy(target), error_code: targetFailure?.code || 'WXRANK_REQUEST_FAILED' })
        }
      }
      strategyResult.completed_items = completedThisStrategy
      strategyResult.next_active_targets = copy(strategy.active_targets || [])
      strategyResult.next_cursor = Number(strategy.cursor || 0)
      strategyResult.next_expected_requests = buildWxRankStrategyPlan([{ ...strategy, completed_items: localLedger }]).expected_requests
      strategyResult.progress_status = 'updated'
      strategyResult.actual_requests = result.requests.filter(item => item.strategy_id === strategy.id && item.request_count > 0).length
      continue
    }
    const completedThisStrategy = []
    for (const target of strategyTargets(strategy)) {
      const targetRequests = []
      const targetArticles = []
      const seenCursors = new Set()
      let pageCursor
      let targetComplete = false
      let targetFailed = false
      let targetFailure = null

      for (let page = 1; page <= Number(strategy.cursor); page += 1) {
        if (page > 1 && !hasCursor(pageCursor)) {
          targetComplete = true
          break
        }
        if (page > 1) {
          const cursorIdentity = stableJson(pageCursor)
          if (seenCursors.has(cursorIdentity)) {
            targetFailure = { code: 'PAGINATION_CURSOR_STALLED', message: 'WxRank cursor repeated; stopped without an extra request' }
            targetFailed = true
            break
          }
          seenCursors.add(cursorIdentity)
        }
        if (requestCounter >= WXRANK_STRATEGY_REQUEST_LIMIT) {
          targetFailure = { code: 'REQUEST_BUDGET_EXCEEDED', message: 'global WxRank request cap reached' }
          targetFailed = true
          break
        }

        const request = createWxRankStrategyRequest({
          requestType: strategy.request_type,
          strategy,
          target,
          cursor: pageCursor
        })
        const parameters = strategyRequestParameters(strategy, target, pageCursor)
        requestCounter += 1
        let response
        let error
        try {
          response = await fetchArticleList({ apiKey, endpoint, ...request })
        } catch (caught) {
          error = caught
        }
        if (Number(response?.request_count) === 0) requestCounter -= 1
        const callResult = actualCallResult({ strategy, target, page, pageCursor, parameters, response, error, apiKey })
        result.requests.push(callResult)
        targetRequests.push(callResult)
        if (callResult.request_count > 0) {
          requestStats.total += 1
          const groupStats = requestStats.by_strategy[strategy.request_type]
          groupStats.requests += 1
          if (callResult.status === 'success') {
            requestStats.success += 1
            groupStats.success += 1
          } else {
            requestStats.failed += 1
            groupStats.failed += 1
          }
        }

        const rows = Array.isArray(response?.data?.list) ? response.data.list : []
        if (callResult.status !== 'success') {
          targetFailed = true
          targetFailure = { code: callResult.error_code || 'WXRANK_REQUEST_FAILED', message: callResult.message }
          break
        }
        const normalizedRows = rows.map(row => normalizeWxRankStrategyArticle(row, { requestType: strategy.request_type, target }))
        targetArticles.push(...normalizedRows)
        allArticleRows.push(...normalizedRows)
        pageCursor = response?.data?.cursor
        if (!hasCursor(pageCursor) || page === Number(strategy.cursor)) {
          targetComplete = true
          break
        }
      }

      if (targetComplete && !targetFailed) {
        const uniqueTargetArticles = deduplicateWxRankStrategyArticles(targetArticles)
        const cycleNo = Number(strategy.cycle_no || 1)
        const targetKey = strategyTargetKey(strategy.request_type, target)
        const requestResults = targetRequests.map(({ strategy_id, strategy_type, target: requestTarget, target_key, ...item }) => item)
        completedThisStrategy.push({
          idempotency_key: `${strategy.id}:${cycleNo}:${targetKey}`,
          target_key: targetKey,
          request_type: strategy.request_type,
          target: copy(target),
          name: strategyTargetLabel(strategy.request_type, target),
          ...(strategy.request_type === 'account' ? { wx_name: strategyTargetLabel(strategy.request_type, target) } : {}),
          status: 'success',
          cycle_no: cycleNo,
          completed_at: new Date().toISOString(),
          request_count: targetRequests.reduce((count, item) => count + item.request_count, 0),
          article_count: uniqueTargetArticles.rows.length,
          request_results: requestResults
        })
        strategyResult.completed_objects.push(copy(target))
        strategyResult.completed_count += 1
      } else if (targetFailed) {
        strategyResult.failed_objects ??= []
        strategyResult.failed_objects.push({ target: copy(target), error_code: targetFailure?.code || 'WXRANK_REQUEST_FAILED' })
      }
    }

    if (completedThisStrategy.length) {
      strategyResult.completed_items = copy(completedThisStrategy)
      const nextState = rotateCompletedStrategy(strategy, completedThisStrategy)
      if (typeof updateProgress !== 'function') {
        const next = summarizeNextTargets(strategy, nextState.activeTargets)
        strategyResult.next_active_targets = next.active_targets
        strategyResult.next_cursor = next.cursor
        strategyResult.next_expected_requests = next.expected_requests
        strategyResult.progress_status = 'not_configured'
        result.warnings.push({ strategy_id: strategy.id, code: 'STRATEGY_PROGRESS_WRITER_MISSING', message: 'collection result was not written to collection_strategy_groups' })
      } else {
        try {
          const update = await updateProgress(strategy, nextState, completedThisStrategy)
          const updatedRow = update?.row || update
          const next = summarizeNextTargets(strategy, updatedRow?.active_targets || nextState.activeTargets)
          strategyResult.next_active_targets = next.active_targets
          strategyResult.next_cursor = next.cursor
          strategyResult.next_expected_requests = next.expected_requests
          strategyResult.progress_status = update?.already_applied ? 'already_applied' : 'updated'
        } catch (error) {
          strategyResult.progress_status = 'failed'
          strategyResult.progress_error = error?.code || error?.message || 'STRATEGY_PROGRESS_UPDATE_FAILED'
          result.warnings.push({ strategy_id: strategy.id, code: 'STRATEGY_PROGRESS_UPDATE_FAILED', message: strategyResult.progress_error })
        }
      }
    }
    strategyResult.actual_requests = result.requests.filter(item => item.strategy_id === strategy.id && item.request_count > 0).length
  }

  requestStats.total = requestCounter
  const deduplicated = deduplicateWxRankStrategyArticles(allArticleRows)
  result.duplicate_count = deduplicated.duplicate_count
  if (deduplicated.rows.length) {
    try {
      const bizes = [...new Set(deduplicated.rows.map(row => text(row.wx_biz)).filter(Boolean))]
      const names = await lookupWxNames(bizes)
      result.articles = deduplicated.rows.map(row => ({
        ...row,
        wx_name: names instanceof Map ? (names.get(row.wx_biz) ?? null) : (names?.[row.wx_biz] ?? null)
      }))
    } catch (error) {
      result.articles = deduplicated.rows.map(row => ({ ...row, wx_name: null }))
      result.warnings.push({ code: 'ACCOUNT_NAME_LOOKUP_FAILED', message: error?.code || error?.message || 'batch lookup failed' })
    }
  }

  const progressFailed = strategyResults.some(item => ['failed', 'not_configured'].includes(item.progress_status))
  const incomplete = strategyResults.some(item => (item.failed_objects?.length || 0) > 0)
  result.status = progressFailed || incomplete
    ? (requestStats.success > 0 ? 'partial' : 'failed')
    : requestStats.failed > 0 ? (requestStats.success > 0 ? 'partial' : 'failed') : 'success'
  return result
}

function rowsOf(result) {
  return Array.isArray(result?.data) ? result.data : []
}

async function readStrategies(client) {
  const result = await client.list('collection_strategy_groups', {
    columns: STRATEGY_COLUMNS,
    order: [{ column: 'id', direction: 'asc' }],
    limit: 1000
  })
  return rowsOf(result).filter(row => STRATEGY_TYPES.has(row.request_type))
}

function strategySnapshotsMatch(before, after) {
  const beforeById = new Map(before.map(row => [String(row.id), row]))
  const afterById = new Map(after.map(row => [String(row.id), row]))
  if (beforeById.size !== afterById.size) return false
  for (const [id, expected] of beforeById) {
    const current = afterById.get(id)
    if (!current || STRATEGY_COLUMNS.some(column => stableJson(current[column] ?? null) !== stableJson(expected[column] ?? null))) return false
  }
  return true
}

function compareFilter(column, value) {
  return { column, operator: value === undefined || value === null ? 'is' : 'eq', value: value ?? null }
}

export async function persistWxRankStrategyProgress(client, strategy, nextState, newItems, { now = () => new Date().toISOString() } = {}) {
  const payload = {
    completed_items: nextState.completedItems,
    active_targets: nextState.activeTargets,
    cursor: nextState.cursor,
    cycle_no: nextState.cycleNo,
    updated_at: now()
  }
  const filters = PROGRESS_CAS_COLUMNS.map(column => compareFilter(column, strategy[column]))
  let updated
  try {
    updated = await client.patch('collection_strategy_groups', filters, payload)
  } catch (error) {
    try {
      const current = (await client.get('collection_strategy_groups', strategy.id, { columns: STRATEGY_COLUMNS })).data
      const recorded = new Set((current.completed_items || []).map(item => item?.idempotency_key).filter(Boolean))
      if (newItems.every(item => recorded.has(item.idempotency_key))) return { row: current, already_applied: true }
    } catch {}
    throw error
  }
  const updatedRows = rowsOf(updated)
  if (updatedRows.length === 1) return { row: updatedRows[0], already_applied: false }

  const current = (await client.get('collection_strategy_groups', strategy.id, { columns: STRATEGY_COLUMNS })).data
  const recorded = new Set((current.completed_items || []).map(item => item?.idempotency_key).filter(Boolean))
  if (newItems.every(item => recorded.has(item.idempotency_key))) return { row: current, already_applied: true }
  const error = new Error('STRATEGY_PROGRESS_CONFLICT: row changed before atomic progress update')
  error.code = 'STRATEGY_PROGRESS_CONFLICT'
  throw error
}

export async function batchLookupWxNames(client, wxBizes) {
  const names = new Map()
  for (let offset = 0; offset < wxBizes.length; offset += 200) {
    const chunk = wxBizes.slice(offset, offset + 200)
    const response = await client.list('accounts', {
      columns: ['wx_biz', 'wx_name'],
      filters: [{ column: 'wx_biz', operator: 'in', value: chunk }],
      limit: 5000
    })
    for (const row of rowsOf(response)) names.set(row.wx_biz, populated(row.wx_name) ? row.wx_name : null)
  }
  return names
}

function strategyConfigIssue(rows, requiredTypes = STRATEGY_TYPES) {
  const counts = Object.fromEntries([...requiredTypes].map(type => [type, rows.filter(row => row.request_type === type).length]))
  const missing = Object.entries(counts).filter(([, count]) => count !== 1).map(([type, count]) => `${type}=${count}`)
  if (missing.length) return `expected one configured strategy for each selected type; found ${missing.join(', ')}`
  const invalidMonth = rows.find(row => row.request_type === 'month' && !/^20\d{4}$/u.test(String(row.month || '')))
  return invalidMonth ? `strategy ${invalidMonth.id} requires month in YYYYMM format` : null
}

export async function runWxRankStrategy({
  client,
  apiKey = loadCollectorEnvironment().WXRANK_API_KEY,
  endpoint,
  fetchArticleList = fetchWxRankArticleList,
  requestTypes,
  onPlan
} = {}) {
  endpoint = endpoint || loadCollectorEnvironment().WXRANK_API_URL || DEFAULT_ENDPOINT
  const liveClient = client || createSupabaseClient({
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  })
  const selectedTypes = requestTypes === undefined
    ? ['account', 'wx_type']
    : validateWxRankRequestTypes({ request_types: requestTypes }, { mode: 'workflow' })
  if (selectedTypes.includes('date')) await ensureWxRankDateStrategy(liveClient)
  const strategies = await readStrategies(liveClient)
  const selectedTypeSet = new Set(selectedTypes)
  const selectedStrategies = strategies.filter(row => selectedTypeSet.has(row.request_type))
  const configIssue = strategyConfigIssue(selectedStrategies, selectedTypeSet)
  if (configIssue) {
    const requestPlan = buildWxRankStrategyPlan(selectedStrategies)
    onPlan?.(requestPlan)
    return {
      status: 'strategy_config_invalid',
      request_types: selectedTypes,
      request_plan: requestPlan,
      request_stats: emptyStats(requestPlan),
      requests: [],
      articles: [],
      duplicate_count: 0,
      strategies: initialStrategyResults(requestPlan, selectedStrategies),
      warnings: [{ code: 'STRATEGY_CONFIG_INVALID', message: configIssue }],
      next_round_plan: requestPlan
    }
  }

  const result = await executeWxRankStrategyPlan({
    strategies: selectedStrategies,
    apiKey,
    endpoint,
    fetchArticleList,
    lookupWxNames: bizes => batchLookupWxNames(liveClient, bizes),
    updateProgress: (strategy, next, items) => persistWxRankStrategyProgress(liveClient, strategy, next, items),
    reserveDatePage: (strategy, item) => updateDatePageCheckpoint(liveClient, strategy.id, item, { onlyIfAbsent: true }),
    finishDatePage: (strategy, item) => updateDatePageCheckpoint(liveClient, strategy.id, item),
    verifySnapshot: async before => strategySnapshotsMatch(before, (await readStrategies(liveClient)).filter(row => selectedTypeSet.has(row.request_type))),
    onPlan
  })
  result.request_types = selectedTypes
  const nextStrategies = await readStrategies(liveClient)
  const nextSelectedStrategies = nextStrategies.filter(row => selectedTypeSet.has(row.request_type))
  const nextPlan = buildWxRankStrategyPlan(nextSelectedStrategies)
  result.next_round_plan = nextPlan
  result.database_strategies = nextStrategies.map(row => ({
    id: row.id,
    request_type: row.request_type,
    active_targets: copy(row.active_targets || []),
    completed_items: copy(row.completed_items || []),
    cursor: Number(row.cursor || 0),
    cycle_no: Number(row.cycle_no || 1),
    next_expected_requests: buildWxRankStrategyPlan([row]).expected_requests
  }))
  return result
}

export async function collect(input, {
  client,
  apiKey = loadCollectorEnvironment().WXRANK_API_KEY,
  endpoint,
  fetchArticleList = fetchWxRankArticleList,
  artifactWriter = writeArtifact
} = {}) {
  const started = Date.now()
  const executionMode = input?.execution_mode || 'single_validation'
  const requestTypes = validateWxRankRequestTypes(input?.config || {}, { mode: executionMode })
  if (executionMode === 'workflow') {
    const result = await runWxRankStrategy({
      client,
      apiKey,
      endpoint,
      fetchArticleList,
      requestTypes
    })
    return formatCollectorResult(result, input, { started, requestTypes, artifactWriter, message: 'WxRank strategy workflow completed' })
  }

  const requestType = requestTypes[0]

  const liveClient = client || createSupabaseClient({
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  })
  const strategies = await readStrategies(liveClient)
  const selected = strategies.find(row => row.request_type === requestType)
  if (!selected) {
    const error = new Error(`no configured ${requestType} strategy was found`)
    error.code = 'STRATEGY_CONFIG_INVALID'
    throw error
  }

  const target = (Array.isArray(selected.active_targets) ? selected.active_targets[0] : null)
    ?? (requestType === 'month' ? selected.month : null)
  const cursor = Number(selected.cursor)
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    const error = new TypeError(`strategy ${selected.id} has an invalid cursor`)
    error.code = 'STRATEGY_CONFIG_INVALID'
    throw error
  }
  if (!target || cursor === 0) {
    return {
      status: 'skipped',
      input_count: null,
      output_count: 0,
      created_count: null,
      updated_count: null,
      filtered_count: null,
      request_count: 0,
      duration_ms: Date.now() - started,
      artifact: null,
      message: !target ? 'selected strategy has no active target' : 'selected strategy cursor is zero',
      business_summary: { request_type: requestType, target: target ?? null, article_count: 0 }
    }
  }

  const oneRequestStrategy = { ...selected, active_targets: [copy(target)], cursor: 1 }
  const result = await executeWxRankStrategyPlan({
    strategies: [oneRequestStrategy],
    apiKey,
    endpoint,
    maxRequests: 1,
    fetchArticleList,
    lookupWxNames: bizes => batchLookupWxNames(liveClient, bizes),
    updateProgress: async (strategy, next) => ({ row: {
      ...strategy,
      active_targets: next.activeTargets,
      completed_items: next.completedItems,
      cursor: next.cursor,
      cycle_no: next.cycleNo
    } })
  })

  const requestCount = result.request_stats.total
  const outputCount = result.articles.length
  const returnedArticleCount = Number(result.requests[0]?.returned_article_count) || 0
  const status = ['success', 'partial', 'failed', 'waiting_auth'].includes(result.status) ? result.status : 'failed'
  let artifact = null
  if (status === 'success' || status === 'partial') {
    artifact = await artifactWriter(input.workdir, 'wxrank-strategy-articles.json', {
      source: 'wxrank',
      schema_version: '1',
      request_type: requestType,
      target: copy(target),
      request_plan: result.request_plan,
      request: result.requests[0]?.request || null,
      duplicate_count: result.duplicate_count,
      rows: result.articles,
      generated_at: new Date().toISOString()
    })
    Object.assign(artifact, { artifact_type: 'articles', schema_version: '1', record_count: outputCount })
  }

  return {
    status,
    input_count: returnedArticleCount,
    output_count: outputCount,
    created_count: null,
    updated_count: null,
    filtered_count: result.duplicate_count,
    request_count: requestCount,
    duration_ms: Date.now() - started,
    artifact,
    ...(status === 'failed' ? { error_code: result.requests[0]?.error_code || result.warnings[0]?.code || 'WXRANK_REQUEST_FAILED' } : {}),
    message: status === 'success' ? 'WxRank strategy validation completed' : (result.requests[0]?.message || result.warnings[0]?.message || result.status),
    business_summary: {
      request_type: requestType,
      target: copy(target),
      request_plan: result.request_plan,
      request: result.requests[0] || null,
      request_count: requestCount,
      returned_article_count: returnedArticleCount,
      article_count: outputCount,
      duplicate_count: result.duplicate_count
    }
  }
}

async function formatCollectorResult(result, input, { started, requestTypes, artifactWriter, message }) {
  const outputCount = result.articles.length
  const requestCount = result.request_stats.total
  const returnedArticleCount = result.requests.reduce((count, request) => count + (Number(request.returned_article_count) || 0), 0)
  const status = normalizeWorkflowStrategyStatus(result.status)
  const noWork = ['skipped_cursor_zero', 'skipped_no_active_targets'].includes(result.status)
  let artifact = null
  if (status === 'success' || status === 'partial') {
    artifact = await artifactWriter(input.workdir, 'wxrank-strategy-articles.json', {
      source: 'wxrank',
      schema_version: '1',
      request_types: requestTypes,
      request_plan: result.request_plan,
      requests: result.requests,
      duplicate_count: result.duplicate_count,
      rows: result.articles,
      generated_at: new Date().toISOString()
    })
    Object.assign(artifact, { artifact_type: 'articles', schema_version: '1', record_count: outputCount })
  }
  return {
    status,
    input_count: returnedArticleCount,
    output_count: outputCount,
    created_count: null,
    updated_count: null,
    filtered_count: result.duplicate_count,
    request_count: requestCount,
    duration_ms: Date.now() - started,
    artifact,
    ...(status === 'failed' ? { error_code: result.requests[0]?.error_code || result.warnings[0]?.code || 'WXRANK_REQUEST_FAILED' } : {}),
    message: status === 'success' ? (noWork ? '策略没有待采集对象，本轮未发送请求' : message) : (result.requests[0]?.message || result.warnings[0]?.message || result.status),
    business_summary: {
      request_types: requestTypes,
      request_plan: result.request_plan,
      requests: result.requests,
      strategies: result.strategies,
      request_count: requestCount,
      returned_article_count: returnedArticleCount,
      article_count: outputCount,
      duplicate_count: result.duplicate_count,
      next_round_plan: result.next_round_plan || null
    }
  }
}

function artifactFilename(runId, date) {
  const timestamp = date.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}/u, '')
  return `wxrank-strategy-${timestamp}-${runId.slice(0, 8)}.json`
}

async function writeRunArtifact(result) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const reportsDir = path.join(projectRoot, 'reports')
  await mkdir(reportsDir, { recursive: true })
  const runId = result.run_id || randomUUID()
  const target = path.join(reportsDir, artifactFilename(runId, new Date()))
  const artifact = { ...result, run_id: runId, artifact_path: target }
  await writeFile(target, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' })
  return { path: target, data: artifact }
}

function printRun(result, artifactPath) {
  console.log('\n请求统计')
  console.log(JSON.stringify(result.request_stats, null, 2))
  console.log('\n策略结果')
  console.log(JSON.stringify(result.strategies, null, 2))
  console.log('\n文章结果')
  if (result.articles.length) {
    console.table(result.articles.map(row => ({
      title: row.title,
      pub_time: row.pub_time,
      wx_name: row.wx_name,
      wx_type: row.wx_type,
      read_num: row.read_num,
      like_num: row.like_num
    })))
  } else {
    console.log('（0 篇）')
  }
  console.log('\n下一轮计划')
  console.log(JSON.stringify(result.next_round_plan, null, 2))
  console.log(`\nJSON 产物：${artifactPath}`)
}

export function parseWxRankCliRequestTypes(args = []) {
  const values = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = String(args[index] || '')
    const inline = argument.match(/^--request-types?=(.*)$/u)
    if (inline) {
      if (!inline[1].trim()) throw new Error(`${argument.split('=')[0]} requires a value`)
      values.push(...inline[1].split(','))
      continue
    }
    if (argument !== '--request-type' && argument !== '--request-types') continue
    const value = args[index + 1]
    if (value === undefined || String(value).startsWith('--')) throw new Error(`${argument} requires a value`)
    values.push(...String(value).split(','))
    index += 1
  }
  if (!values.length) return undefined
  return validateWxRankRequestTypes({ request_types: values }, { mode: 'workflow' })
}

export async function main({ requestTypes } = {}) {
  const result = await runWxRankStrategy({
    ...(requestTypes ? { requestTypes } : {}),
    onPlan: plan => {
      console.log('请求计划（发送请求前）')
      console.log(JSON.stringify(plan, null, 2))
    }
  })
  result.run_id = randomUUID()
  const artifact = await writeRunArtifact(result)
  printRun(artifact.data, artifact.path)
  return artifact.data
}

function isDirectExecution(moduleUrl, entryPath) {
  if (!entryPath) return false
  try {
    return path.resolve(fileURLToPath(moduleUrl)) === path.resolve(entryPath)
  } catch {
    return false
  }
}

function printUsage() {
  console.log('用法：node scripts/collectors/wxrank-strategy.mjs [--standalone] [--request-type account|wx_type]')
  console.log('独立执行一轮 WxRank 策略采集；不会进入采集任务队列。')
  console.log('可用 --request-type account 或 --request-type wx_type 选择一个策略；也支持 --request-types account,wx_type。')
  console.log('安全查看帮助：node scripts/collectors/wxrank-strategy.mjs --help')
}

async function readOptionalStdinText() {
  if (process.stdin.isTTY) return null
  let text = ''
  for await (const chunk of process.stdin) text += chunk.toString('utf8')
  return text.trim() ? text : null
}

async function runDirectEntrypoint() {
  const args = process.argv.slice(2)
  if (args.some(argument => argument === '--help' || argument === '-h')) return printUsage()
  const requestTypes = parseWxRankCliRequestTypes(args)
  if (args.includes('--standalone')) return main({ requestTypes })
  const inputText = await readOptionalStdinText()
  if (inputText) return runCollectorMain(collect, { inputText })
  return main({ requestTypes })
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  runDirectEntrypoint().catch(error => {
    console.error(`wxrank-strategy failed: ${error?.code || 'COLLECTOR_ERROR'} ${error?.message || ''}`.trim())
    process.exitCode = 1
  })
}
