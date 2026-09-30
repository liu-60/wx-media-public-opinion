import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { aggregateHotwordsWithDiagnostics } from '../../src/hotwords.mjs'
import { runCollectorMain, writeArtifact } from '../../src/runner/script-runtime.mjs'
import { canonicalizeArticle, mergeCanonicalArticles } from '../../src/collection-canonical.mjs'
import { createSupabaseClient } from '../../management-center/services/supabase.mjs'
import { loadHotwordFilterRules } from './hotword-filter-rules.mjs'

function dateKey(value) {
  const raw = String(value || '').replaceAll('-', '').slice(0, 8)
  return /^20\d{6}$/u.test(raw) ? raw : new Date().toISOString().slice(0, 10).replaceAll('-', '')
}

function publishedDate(row) {
  const parsed = new Date(row.published_at || row.publish_time || row.pub_time || '')
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10).replaceAll('-', '')
}

function minusOne(value) {
  const date = new Date(`${String(value).slice(0, 4)}-${String(value).slice(4, 6)}-${String(value).slice(6, 8)}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10).replaceAll('-', '')
}

function ratio(value, fallback, name) {
  const parsed = value === undefined || value === null || value === '' ? fallback : Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    const error = new Error(`${name}必须是0到1之间的小数`)
    error.code = 'INVALID_CONFIG'
    throw error
  }
  return parsed
}

function positiveInteger(value, fallback, name, maximum = 100) {
  const parsed = value === undefined || value === null || value === '' ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    const error = new Error(`${name}必须是1到${maximum}之间的整数`)
    error.code = 'INVALID_CONFIG'
    throw error
  }
  return parsed
}

function dateLabel(value, fallback = new Date().toISOString().slice(0, 10)) {
  const raw = String(value || fallback).trim().replaceAll('-', '').slice(0, 8)
  return /^20\d{6}$/u.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : fallback
}

function minusOneDate(value) {
  const date = new Date(`${dateLabel(value)}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

function artifactRows(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.rows) ? value.rows : Array.isArray(value?.articles) ? value.articles : []
}

function articleStatDate(row, fallback) {
  const raw = row?.published_at || row?.publish_time || row?.pub_time || row?.publish_date || row?.created_at || row?.date
  if (raw === undefined || raw === null || raw === '') return dateLabel(fallback)
  const value = String(raw).trim()
  const parts = /^(20\d{2})[-/.年]?([01]?\d)[-/.月]?([0-3]?\d)/u.exec(value)
  if (parts) return dateLabel(`${parts[1]}-${String(parts[2]).padStart(2, '0')}-${String(parts[3]).padStart(2, '0')}`, dateLabel(fallback))
  const parsed = /^\d{10,13}$/u.test(value) ? new Date(Number(value) * (value.length === 10 ? 1000 : 1)) : new Date(value)
  if (Number.isNaN(parsed.getTime())) return dateLabel(fallback)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(parsed)
}

export function cleanArticleTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&(?:nbsp|amp|quot|lt|gt|#39);/giu, entity => ({ '&nbsp;': ' ', '&amp;': '&', '&quot;': '"', '&lt;': '<', '&gt;': '>', '&#39;': "'" })[entity.toLowerCase()] || ' ')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .replace(/[\t\r\n]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim()
}

export function scoreHotwordTrends(rows = []) {
  const byWord = new Map()
  for (const row of rows) {
    const word = rowHotword(row)
    if (!word) continue
    const group = byWord.get(word) || new Map()
    group.set(dateLabel(row.stat_date), row)
    byWord.set(word, group)
  }
  const output = []
  for (const [word, history] of byWord) {
    const dates = [...history.keys()].sort()
    for (const statDate of dates) {
      const current = history.get(statDate)
      const todayCount = Math.max(0, Number(current.article_count) || 0)
      const yesterdayDate = minusOneDate(statDate)
      const twoDaysAgoDate = minusOneDate(yesterdayDate)
      const yesterday = history.get(yesterdayDate)
      const twoDaysAgo = history.get(twoDaysAgoDate)
      const yesterdayCount = Math.max(0, Number(yesterday?.article_count) || 0)
      const twoDaysAgoCount = Math.max(0, Number(twoDaysAgo?.article_count) || 0)
      const hasPrior = dates.some(date => date < statDate)
      const delta = todayCount - yesterdayCount
      const growthRate = yesterdayCount > 0 ? Math.round((delta / yesterdayCount) * 10_000) / 10_000 : todayCount > 0 && !hasPrior ? 1 : null
      let trendState
      if (!hasPrior) trendState = 'new'
      else if (delta < 0) trendState = 'falling'
      else if (delta === 0) trendState = 'stable'
      else if ((yesterdayCount > 0 && yesterdayCount >= twoDaysAgoCount) || (yesterdayCount === 0 && twoDaysAgoCount === 0 && todayCount > 0)) trendState = 'rising'
      else trendState = 'stable'
      let consecutiveDays = 0
      let cursor = statDate
      while (history.has(cursor) && consecutiveDays < 60) { consecutiveDays += 1; cursor = minusOneDate(cursor) }
      const sevenDaysAgo = new Date(`${statDate}T00:00:00Z`)
      sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 6)
      const recentSevenStart = sevenDaysAgo.toISOString().slice(0, 10)
      const recentSevenCount = dates.filter(date => date <= statDate && date >= recentSevenStart).reduce((sum, date) => sum + (Number(history.get(date)?.article_count) || 0), 0)
      const platformCount = Math.max(Number(current.platform_count) || 0, rowPlatforms(current).length)
      const acceleration = delta - (yesterdayCount - twoDaysAgoCount)
      const trendScore = Math.round((
        Math.max(-4, Math.min(12, delta)) * 2 +
        Math.max(-6, Math.min(10, acceleration)) * 1.8 +
        Math.log1p(todayCount) * 4 + Math.log1p(recentSevenCount) * 1.5 +
        consecutiveDays * 1.75 + platformCount * 2 +
        (trendState === 'rising' ? 14 : trendState === 'new' ? 4 : trendState === 'falling' ? -10 : 0)
      ) * 100) / 100
      output.push({ ...current, hotword: word, trend_state: trendState, trend_score: trendScore, consecutive_days: consecutiveDays, daily_growth: delta, growth_rate: growthRate, is_rising: trendState === 'rising' })
    }
  }
  return output
}

function supabaseClient(dependencies = {}, env = process.env) {
  if (dependencies.supabaseClient) return dependencies.supabaseClient
  const url = env.SUPABASE_URL
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createSupabaseClient({ url, key, fetchImpl: dependencies.supabaseFetchImpl || globalThis.fetch })
}

async function loadExistingHotwords(client, { pageSize = 1_000, maxRows = 100_000 } = {}) {
  if (!client) return { rows: [], request_count: 0 }
  const rows = []
  let offset = 0
  let requestCount = 0
  while (offset < maxRows) {
    requestCount += 1
    const result = await client.list('hotwords', { columns: ['id', 'hotword', 'aliases', 'stat_date', 'article_count', 'article_keys', 'article_url', 'platform_count', 'source_platforms', 'is_rising', 'growth_rate', 'trend_state', 'trend_score', 'consecutive_days', 'daily_growth', 'quality_valid', 'quality_type', 'quality_confidence', 'quality_reason', 'quality_checked_at', 'updated_at'], order: [{ column: 'stat_date', direction: 'desc' }], limit: Math.min(pageSize, maxRows - offset), offset, count: 'exact' })
    if (!Array.isArray(result?.data)) throw new Error('hotwords 表返回格式错误，无法读取别名')
    rows.push(...result.data)
    if ((Number.isSafeInteger(result.total) && rows.length >= result.total) || result.data.length < pageSize) return { rows, request_count: requestCount }
    offset += result.data.length
  }
  throw new Error(`hotwords 历史行数超过读取上限 ${maxRows}`)
}

async function loadAllRows(client, table, columns, { pageSize = 1_000, maxRows = 200_000 } = {}) {
  const rows = []
  let offset = 0
  let requestCount = 0
  while (offset < maxRows) {
    const result = await client.list(table, { columns, order: [{ column: 'id', direction: 'asc' }], limit: pageSize, offset, count: 'exact' })
    requestCount += 1
    if (!Array.isArray(result?.data)) throw new Error(`${table} 历史读取返回格式错误`)
    rows.push(...result.data)
    if ((Number.isSafeInteger(result.total) && rows.length >= result.total) || result.data.length < pageSize) return { rows, request_count: requestCount }
    offset += result.data.length
  }
  throw new Error(`${table} 历史行数超过读取上限 ${maxRows}`)
}

/** Full source-of-truth article load; hotword dates always come from articles.published_at. */
export async function loadHistoricalArticles(client) {
  if (!client) return { rows: [], request_count: 0 }
  const loaded = await loadAllRows(client, 'articles', ['id', 'account_id', 'article_key', 'article_sn', 'idx', 'title', 'article_url', 'published_at', 'read_num', 'like_num', 'source_code', 'updated_at'])
  const accountIds = [...new Set(loaded.rows.map(row => row.account_id).filter(value => value !== null && value !== undefined))]
  const accounts = new Map()
  let requestCount = loaded.request_count
  for (let offset = 0; offset < accountIds.length; offset += 200) {
    const batch = accountIds.slice(offset, offset + 200)
    const result = await client.list('accounts', { columns: ['account_id', 'wx_biz', 'wx_name'], filters: [{ column: 'account_id', operator: 'in', value: batch }], limit: 1_000 })
    requestCount += 1
    for (const row of result.data || []) accounts.set(String(row.account_id), row)
  }
  const links = await loadAllRows(client, 'hotword_articles', ['id', 'article_key', 'source_platforms'])
  requestCount += links.request_count
  const platformsByArticleKey = new Map()
  for (const link of links.rows) {
    const key = String(link.article_key || '')
    if (!key) continue
    const platforms = platformsByArticleKey.get(key) || new Set()
    for (const value of Array.isArray(link.source_platforms) ? link.source_platforms : []) {
      const platform = String(value || '').trim()
      if (platform && platform !== 'unknown') platforms.add(platform)
    }
    platformsByArticleKey.set(key, platforms)
  }
  const rows = loaded.rows.flatMap(row => {
    const account = accounts.get(String(row.account_id))
    if (!row.title || !row.published_at || !account?.wx_biz) return []
    const articleKey = String(row.article_key || `${account.wx_biz}:${row.article_sn}:${row.idx || 1}`)
    const sourcePlatforms = [...(platformsByArticleKey.get(articleKey) || [])]
    return [{
      ...row, database_article_id: row.id, article_id: row.id, article_key: articleKey,
      wx_biz: account.wx_biz, wx_name: account.wx_name || null,
      source_platform: sourcePlatforms[0] || null,
      source_refs: sourcePlatforms.map(platform => ({ platform, reason: 'historical-article' }))
    }]
  })
  return { rows, request_count: requestCount, article_rows_read: loaded.rows.length, article_rows_usable: rows.length }
}

function platformValues(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(value => typeof value === 'string' ? value : value?.platform || value?.name || '').map(value => String(value || '').trim()).filter(Boolean))]
}

function platformKey(value) { return String(value || '').normalize('NFKC').trim().toLocaleLowerCase() }

function numeric(value) {
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}

function rowHotword(row) { return String(row?.canonical_word || row?.hotword || row?.word || '').normalize('NFKC').trim() }

function rowPlatforms(row) {
  return platformValues([
    ...(Array.isArray(row?.source_platforms) ? row.source_platforms : []),
    ...(Array.isArray(row?.platforms) ? row.platforms : []),
    ...(row?.source_platform ? [row.source_platform] : [])
  ]).filter(value => value !== 'unknown')
}

function platformEvidence(row, platform) {
  const key = platformKey(platform)
  const values = Array.isArray(row?.platforms) ? row.platforms.filter(value => platformKey(typeof value === 'string' ? value : value?.platform || value?.name) === key) : []
  const rankValues = values.map(value => numeric(typeof value === 'object' ? value.rank ?? value.source_rank : null)).filter(value => value !== null)
  const scoreValues = values.map(value => numeric(typeof value === 'object' ? value.heat ?? value.score ?? value.match_count : null)).filter(value => value !== null)
  const sourceRank = numeric(row?.source_rank ?? row?.rank)
  const sourceScore = numeric(row?.platform_scores?.[platform] ?? row?.heat ?? row?.score ?? row?.match_score)
  return {
    rank: rankValues.length ? Math.min(...rankValues) : sourceRank,
    score: scoreValues.length ? Math.max(...scoreValues) : sourceScore
  }
}

function articleKeys(row) { return [...new Set([...(Array.isArray(row?.article_keys) ? row.article_keys : []), ...(Array.isArray(row?.article_ids) ? row.article_ids : [])].filter(Boolean).map(String))] }

function compareHotwordRows(left, right) {
  return (Number(right?.article_count) || 0) - (Number(left?.article_count) || 0)
    || (Number(right?.platform_count) || 0) - (Number(left?.platform_count) || 0)
    || (Number(right?.match_score ?? right?.score) || 0) - (Number(left?.match_score ?? left?.score) || 0)
    || rowHotword(left).localeCompare(rowHotword(right), 'zh-CN')
}

function comparePlatformCandidates(left, right, platform) {
  const leftEvidence = left.evidence.map(row => platformEvidence(row, platform)).filter(value => value.rank !== null || value.score !== null)
  const rightEvidence = right.evidence.map(row => platformEvidence(row, platform)).filter(value => value.rank !== null || value.score !== null)
  const leftRank = leftEvidence.map(value => value.rank).filter(value => value !== null)
  const rightRank = rightEvidence.map(value => value.rank).filter(value => value !== null)
  if (leftRank.length || rightRank.length) {
    if (!leftRank.length) return 1
    if (!rightRank.length) return -1
    const rankDifference = Math.min(...leftRank) - Math.min(...rightRank)
    if (rankDifference) return rankDifference
  }
  const leftScore = leftEvidence.map(value => value.score).filter(value => value !== null)
  const rightScore = rightEvidence.map(value => value.score).filter(value => value !== null)
  if (leftScore.length || rightScore.length) {
    const scoreDifference = Math.max(0, ...rightScore) - Math.max(0, ...leftScore)
    if (scoreDifference) return scoreDifference
  }
  return compareHotwordRows(left.row, right.row)
}

const LOCAL_GARBAGE_HOTWORDS = new Set(['于是', '第一', '不会', '可以', '觉得', '一个', '这个', '那个', '什么', '如何', '我们', '你们', '他们'])
const TOPIC_MARKERS = /(?:品牌|公司|产品|手机|婚礼|政策|事件|节|菜|病|药|城市|大学|明星|人物|诈骗|地震|台风|电影|游戏|汽车|手机|iphone|ios|ai|国庆|春节|奥运|大赛|发布会)/iu

function hasTopicEvidence(word, row) {
  if (row?.quality_valid === false || LOCAL_GARBAGE_HOTWORDS.has(word.toLocaleLowerCase())) return false
  if (/^\d{1,4}$/u.test(word) || /^[\p{P}\p{S}\s]+$/u.test(word)) return false
  if (/[A-Z]/u.test(word) || /\d/u.test(word) || TOPIC_MARKERS.test(word) || word === '闲鱼') return true
  return [...word].length >= 3
}

function hotwordRankScore(row) {
  const count = Math.max(0, Number(row.article_count) || 0)
  const platforms = Math.max(Number(row.platform_count) || 0, rowPlatforms(row).length)
  const growth = Number(row.growth_rate)
  const growthPart = Number.isFinite(growth) ? Math.max(-2, Math.min(5, growth)) : 0
  const trend = Math.max(-30, Math.min(100, Number(row.trend_score) || 0))
  const consecutive = Math.max(0, Number(row.consecutive_days) || 0)
  const qualityPart = row.quality_valid === true ? 4 : 0
  const topicPart = hasTopicEvidence(rowHotword(row), row) ? 5 : -8
  return Math.round((Math.log1p(count) * 5 + platforms * 2.5 + growthPart * 2 + trend * 0.45 + consecutive * 1.25 + qualityPart + topicPart) * 100) / 100
}

/** Merge duplicate canonical rows, then retain at most ten topics per date. */
export function limitHotwordsPerPlatform(rows = [], limit = 10) {
  const requested = Number(limit)
  if (!Number.isSafeInteger(requested) || requested < 1) throw new TypeError('每日热词上限必须是正整数')
  const maximum = Math.min(10, requested)
  const merged = new Map()
  for (const raw of Array.isArray(rows) ? rows : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const hotword = rowHotword(raw)
    const statDate = dateLabel(raw.stat_date)
    if (!hotword) continue
    const key = `${hotword}\0${statDate}`
    const current = merged.get(key)
    if (!current) {
      const row = { ...raw, hotword, word: raw.word || hotword, stat_date: statDate }
      merged.set(key, { row, aliases: new Set(row.aliases || []), platforms: new Map(rowPlatforms(raw).map(platform => [platformKey(platform), platform])), keys: new Set(articleKeys(raw)) })
      continue
    }
    for (const alias of raw.aliases || []) if (alias && alias !== hotword) current.aliases.add(String(alias).trim())
    for (const platform of rowPlatforms(raw)) current.platforms.set(platformKey(platform), platform)
    for (const value of articleKeys(raw)) current.keys.add(value)
    if (compareHotwordRows(raw, current.row) < 0) current.row = { ...raw, hotword, word: raw.word || hotword, stat_date: statDate }
    for (const field of ['trend_score', 'consecutive_days', 'daily_growth', 'quality_confidence']) {
      if (Number(raw[field]) > Number(current.row[field] || 0)) current.row[field] = raw[field]
    }
    if (raw.quality_valid === true) current.row.quality_valid = true
    if (raw.quality_valid === false && current.row.quality_valid !== true) current.row.quality_valid = false
  }
  const byDate = new Map()
  for (const candidate of merged.values()) {
    const row = candidate.row
    const keys = [...candidate.keys].sort()
    row.aliases = [...candidate.aliases].filter(alias => alias && alias !== row.hotword).sort((a, b) => a.localeCompare(b, 'zh-CN'))
    row.article_keys = keys
    row.article_ids = keys
    if (keys.length) row.article_count = keys.length
    row.source_platforms = [...candidate.platforms.values()].sort((a, b) => a.localeCompare(b, 'zh-CN'))
    row.platform_count = row.source_platforms.length || Number(row.platform_count) || 0
    row.rank_score = hotwordRankScore(row)
    if (!hasTopicEvidence(row.hotword, row)) continue
    const group = byDate.get(row.stat_date) || []
    group.push(row)
    byDate.set(row.stat_date, group)
  }
  return [...byDate.entries()].flatMap(([statDate, values]) => values
    .sort((left, right) => Number(right.rank_score) - Number(left.rank_score) || compareHotwordRows(left, right))
    .slice(0, maximum)
    .map((row, index) => ({ ...row, rank: index + 1, stat_date: statDate })))
    .sort((left, right) => String(left.stat_date).localeCompare(String(right.stat_date)) || Number(left.rank) - Number(right.rank))
}

export function makeHotwordLinkage(articleRows, seeds = [], { statDate = '', canonicalRules, filterRules = [], minArticleCount = 2, mergeConsistencyThreshold = 0.8, mergeMinArticleCount = 3 } = {}) {
  const normalizedArticles = articleRows.map(row => {
    const canonical = row.article_key ? row : canonicalizeArticle(row)
    return { ...canonical, title: cleanArticleTitle(canonical.title), content: '', stat_date: articleStatDate(canonical, statDate), article_id: canonical.article_key, article_keys: [canonical.article_key] }
  })
  const articlesByKey = new Map(normalizedArticles.map(row => [row.article_key, row]))
  const groups = new Map()
  for (const article of normalizedArticles) {
    const group = groups.get(article.stat_date) || []
    group.push(article)
    groups.set(article.stat_date, group)
  }
  const dateAggregations = [...groups.entries()].map(([date, rows]) => aggregateHotwordsWithDiagnostics(rows, { statDate: date, now: new Date().toISOString(), minArticleCount, filterRules, canonicalRules, mergeConsistencyThreshold, mergeMinArticleCount }))
  const aggregatedRows = dateAggregations.flatMap(result => result.rows)
  const aggregateRowsByKey = new Map(aggregatedRows.map(row => [`${String(row.word || row.hotword || '').trim()}\0${dateLabel(row.stat_date)}`, row]))
  const aggregation = {
    rows: aggregatedRows,
    filtered_count: dateAggregations.reduce((total, result) => total + result.filtered_count, 0),
    rule_hit_counts: Object.assign({}, ...dateAggregations.map(result => result.rule_hit_counts)),
    canonical_merge_count: dateAggregations.reduce((total, result) => total + result.canonical_merge_count, 0),
    merged_count: dateAggregations.reduce((total, result) => total + result.merged_count, 0)
  }
  const dates = [...groups.keys()]
  const candidates = new Map()
  const defaultRules = [{ canonical: '闲鱼', match_type: 'prefix', protected: true }]
  const rules = canonicalRules || defaultRules
  const normalizeWord = term => {
    const raw = String(term || '').normalize('NFKC').trim()
    for (const rule of rules) {
      const canonical = String(rule?.canonical || '').normalize('NFKC').trim()
      if (canonical && (raw === canonical || (rule.match_type === 'prefix' && raw.startsWith(canonical)) || (rule.match_type === 'alias' && (raw === canonical || rule.aliases?.includes(raw))))) return canonical
    }
    return raw
  }
  const addCandidate = (wordValue, candidateDate, options = {}) => {
    const term = String(wordValue || '').normalize('NFKC').trim()
    if (!term) return
    const word = normalizeWord(term)
    const normalizedDate = dateLabel(candidateDate, dateLabel(statDate))
    const key = `${word}\0${normalizedDate}`
    const current = candidates.get(key) || { word, stat_date: normalizedDate, aliases: new Set(), platforms: new Set(), matches: new Map(), score: 0, token_type: options.token_type || 'zh', gram: options.gram || term.length, quality_valid: null, quality_type: null, quality_confidence: null, quality_reason: null, quality_checked_at: null }
    if (term !== word) current.aliases.add(term)
    for (const alias of options.aliases || []) if (alias && alias !== word) current.aliases.add(String(alias).trim())
    for (const platform of platformValues(options.platforms)) current.platforms.add(platform)
    current.score = Math.max(current.score, Number(options.score) || 0)
    if (options.quality_valid !== undefined && options.quality_valid !== null) current.quality_valid = options.quality_valid
    if (options.quality_type) current.quality_type = options.quality_type
    if (options.quality_confidence !== undefined && options.quality_confidence !== null) current.quality_confidence = Number(options.quality_confidence)
    if (options.quality_reason) current.quality_reason = options.quality_reason
    if (options.quality_checked_at) current.quality_checked_at = options.quality_checked_at
    candidates.set(key, current)
    return current
  }
  for (const row of aggregatedRows) {
    const candidate = addCandidate(row.word, row.stat_date, { aliases: row.aliases, score: row.score, token_type: row.token_type, gram: row.gram })
    if (!candidate) continue
    const terms = Object.keys(row.matched_terms || {}).filter(Boolean)
    for (const articleKey of row.article_ids || row.article_keys || []) {
      const article = articlesByKey.get(articleKey)
      if (!article) continue
      const entry = candidate.matches.get(articleKey) || new Set()
      for (const term of terms.length ? terms : [row.word]) entry.add(term)
      candidate.matches.set(articleKey, entry)
    }
  }
  const variants = new Map()
  const seededCandidates = new Set()
  for (const seed of seeds) {
    const rawWord = String(seed?.word || seed?.hotword || '').normalize('NFKC').trim()
    if (!rawWord) continue
    const seedDate = seed?.stat_date ? dateLabel(seed.stat_date) : null
    const seedDates = seedDate ? (dates.includes(seedDate) ? [seedDate] : []) : dates
    for (const candidateDate of seedDates) {
    const candidate = addCandidate(rawWord, candidateDate, { aliases: seed.aliases, platforms: seed.platforms || seed.source_platforms, score: seed.score, token_type: seed.token_type, gram: seed.gram, quality_valid: seed.quality_valid, quality_type: seed.quality_type, quality_confidence: seed.quality_confidence, quality_reason: seed.quality_reason, quality_checked_at: seed.quality_checked_at })
      if (!candidate) continue
      seededCandidates.add(candidate)
      const set = variants.get(candidate) || new Set()
      for (const phrase of [rawWord, ...(Array.isArray(seed.aliases) ? seed.aliases : [])]) {
        const normalizedPhrase = String(phrase || '').normalize('NFKC').trim()
        if (normalizedPhrase) set.add(normalizedPhrase)
      }
      variants.set(candidate, set)
    }
  }
  for (const [key, candidate] of candidates) {
    if (!variants.has(candidate)) variants.set(candidate, new Set())
    variants.get(candidate).add(key.split('\0')[0])
    for (const alias of candidate.aliases) variants.get(candidate).add(alias)
  }
  const searchableByDate = new Map()
  for (const article of normalizedArticles) {
    const group = searchableByDate.get(article.stat_date) || []
    group.push({ article, text: cleanArticleTitle(article.title).toLocaleLowerCase() })
    searchableByDate.set(article.stat_date, group)
  }
  // Match every calculated canonical phrase against its date's history on the
  // first run. Newly written hotwords then carry the same article links when
  // they reappear as existing seeds, so a repeated full-history recompute is
  // stable instead of growing links one run at a time.
  for (const candidate of candidates.values()) {
    const phrases = [...(variants.get(candidate) || [])].filter(Boolean).map(phrase => phrase.toLocaleLowerCase())
    for (const { article, text: searchable } of searchableByDate.get(candidate.stat_date) || []) {
      const matched = phrases.filter(phrase => searchable.includes(phrase))
      if (!matched.length) continue
      const entry = candidate.matches.get(article.article_key) || new Set()
      for (const term of matched) entry.add(term)
      candidate.matches.set(article.article_key, entry)
    }
  }
  const hotwords = []
  const links = []
  for (const candidate of candidates.values()) {
    const word = candidate.word
    const articleKeys = [...candidate.matches.keys()].sort()
    if (!articleKeys.length) continue
    const linkedPlatforms = new Set(candidate.platforms)
    const perArticlePlatforms = new Map()
    for (const articleKey of articleKeys) {
      const article = articlesByKey.get(articleKey)
      const platforms = platformValues((article?.source_refs || []).map(ref => ref.platform).concat(article?.source_platform || []))
      for (const platform of platforms) linkedPlatforms.add(platform)
      perArticlePlatforms.set(articleKey, platforms)
      links.push({ hotword: word, stat_date: candidate.stat_date, article_key: articleKey, source_platforms: platforms, matched_terms: [...candidate.matches.get(articleKey)].sort() })
    }
    const aggregateRow = aggregateRowsByKey.get(`${word}\0${candidate.stat_date}`) || {}
    const aliases = [...new Set([...candidate.aliases].filter(alias => alias && alias !== word))].sort()
    const articleUrl = articleKeys.map(key => articlesByKey.get(key)?.article_url).find(Boolean) || aggregateRow.article_url || null
    const articleIds = articleKeys.map(key => articlesByKey.get(key)?.id || articlesByKey.get(key)?.database_article_id || articlesByKey.get(key)?.article_id || key)
    hotwords.push({ ...aggregateRow, word, hotword: word, stat_date: candidate.stat_date, aliases, article_count: articleKeys.length, article_keys: articleKeys, article_ids: articleIds, source_platforms: [...linkedPlatforms].sort(), platform_count: linkedPlatforms.size, article_url: articleUrl, score: candidate.score || aggregateRow.score || 0, quality_valid: candidate.quality_valid, quality_type: candidate.quality_type, quality_confidence: candidate.quality_confidence, quality_reason: candidate.quality_reason, quality_checked_at: candidate.quality_checked_at, is_rising: false, growth_rate: null })
  }
  const trendedHotwords = scoreHotwordTrends(hotwords)
  const limitedHotwords = limitHotwordsPerPlatform(trendedHotwords, 10)
  const selectedHotwordKeys = new Set(limitedHotwords.map(row => `${row.hotword}\0${dateLabel(row.stat_date)}`))
  return { articles: normalizedArticles, hotwords: limitedHotwords, links: links.filter(link => selectedHotwordKeys.has(`${link.hotword}\0${dateLabel(link.stat_date)}`)), aggregation }
}

async function queryExistingArticleIds(client, articleKeys) {
  const result = new Map()
  let requestCount = 0
  for (let offset = 0; offset < articleKeys.length; offset += 200) {
    const batch = articleKeys.slice(offset, offset + 200).filter(value => !/[\r\n(),]/u.test(value))
    if (!batch.length) continue
    requestCount += 1
    const response = await client.list('articles', { columns: ['id', 'article_key'], filters: [{ column: 'article_key', operator: 'in', value: batch }], limit: 1_000 })
    if (!Array.isArray(response?.data)) throw new Error('articles 表文章身份查询返回格式错误')
    for (const row of response.data) if (!result.has(row.article_key)) result.set(row.article_key, row.id)
  }
  return { ids: result, request_count: requestCount }
}

export async function persistHotwordLinkage({ client, hotwords = [], links = [], recomputedDates = [], now = new Date().toISOString(), minRisingCount = 3, minGrowthRate = 0.5 } = {}) {
  if (!client) { const error = new Error('缺少 Supabase 服务端凭据，无法写入 hotwords'); error.code = 'SUPABASE_CONFIG_MISSING'; throw error }
  const existing = await loadExistingHotwords(client)
  const existingRows = existing.rows
  let requestCount = existing.request_count
  const currentMap = new Map(existingRows.map(row => [`${row.hotword}\0${dateLabel(row.stat_date)}`, row]))
  const priorQuality = new Map()
  for (const row of [...existingRows].sort((a, b) => String(b.quality_checked_at || b.stat_date).localeCompare(String(a.quality_checked_at || a.stat_date)))) {
    if (!priorQuality.has(row.hotword) && row.quality_valid !== null && row.quality_valid !== undefined) priorQuality.set(row.hotword, row)
  }
  const linkGroups = new Map()
  for (const link of links) {
    const key = `${link.hotword}\0${dateLabel(link.stat_date)}`
    const group = linkGroups.get(key) || new Map()
    const current = group.get(link.article_key) || { source_platforms: new Set(), matched_terms: new Set() }
    for (const value of link.source_platforms || []) current.source_platforms.add(value)
    for (const value of link.matched_terms || []) current.matched_terms.add(value)
    group.set(link.article_key, current)
    linkGroups.set(key, group)
  }
  const rows = limitHotwordsPerPlatform(hotwords, 10).map(row => {
    const word = String(row.word || row.hotword || '').trim()
    const statDate = dateLabel(row.stat_date)
    const key = `${word}\0${statDate}`
    const storedCurrent = currentMap.get(key)
    const currentLinks = linkGroups.get(key) || new Map()
    const articleKeys = [...new Set([...(Array.isArray(row.article_keys) ? row.article_keys : []), ...currentLinks.keys()])].sort()
    const platforms = [...new Set([...(row.source_platforms || []), ...[...currentLinks.values()].flatMap(value => [...value.source_platforms])])].filter(value => value !== 'unknown').sort()
    const oldQuality = storedCurrent?.quality_valid !== null && storedCurrent?.quality_valid !== undefined ? storedCurrent : priorQuality.get(word)
    const qualityValid = row.quality_valid ?? oldQuality?.quality_valid ?? null
    const delta = Number(row.daily_growth) || 0
    const growthRate = row.growth_rate === undefined ? null : row.growth_rate
    const isRising = row.trend_state ? row.trend_state === 'rising' : articleKeys.length >= minRisingCount && delta >= 2 && Number(growthRate) >= minGrowthRate
    return {
      hotword: word,
      aliases: [...new Set([...(row.aliases || []), ...(storedCurrent?.aliases || [])].map(value => String(value || '').trim()).filter(value => value && value !== word))].sort(),
      stat_date: statDate,
      article_count: articleKeys.length,
      article_keys: articleKeys,
      article_url: row.article_url || storedCurrent?.article_url || null,
      platform_count: platforms.length,
      source_platforms: platforms,
      is_rising: isRising,
      growth_rate: growthRate,
      trend_state: row.trend_state || (isRising ? 'rising' : 'stable'),
      trend_score: Number(row.trend_score) || 0,
      consecutive_days: Math.max(0, Number(row.consecutive_days) || 0),
      daily_growth: Number(row.daily_growth) || 0,
      quality_valid: qualityValid,
      quality_type: row.quality_type ?? oldQuality?.quality_type ?? null,
      quality_confidence: row.quality_confidence ?? oldQuality?.quality_confidence ?? null,
      quality_reason: row.quality_reason ?? oldQuality?.quality_reason ?? null,
      quality_checked_at: row.quality_checked_at ?? oldQuality?.quality_checked_at ?? null,
      updated_at: now
    }
  }).filter(row => row.hotword && row.article_count > 0)
  const selectedKeys = new Set(rows.map(row => `${row.hotword}\0${row.stat_date}`))
  const affectedDates = recomputedDates.length
    ? [...existingRows.map(row => dateLabel(row.stat_date)), ...recomputedDates.map(value => dateLabel(value)), ...rows.map(row => row.stat_date)]
    : rows.map(row => row.stat_date)
  const dates = [...new Set(affectedDates)].filter(Boolean).sort()
  const affectedExisting = existingRows.filter(row => dates.includes(dateLabel(row.stat_date)))
  const deletedRows = affectedExisting.filter(row => !selectedKeys.has(`${row.hotword}\0${dateLabel(row.stat_date)}`)).map(row => ({ ...row, change_type: 'deleted' }))
  for (let offset = 0; offset < dates.length; offset += 100) {
    const result = await client.remove('hotword_articles', [{ column: 'stat_date', operator: 'in', value: dates.slice(offset, offset + 100) }])
    requestCount += 1
  }
  for (let offset = 0; offset < deletedRows.length; offset += 200) {
    const ids = deletedRows.slice(offset, offset + 200).map(row => row.id).filter(Boolean)
    if (!ids.length) continue
    await client.remove('hotwords', [{ column: 'id', operator: 'in', value: ids }])
    requestCount += 1
  }
  const articleLookups = await queryExistingArticleIds(client, [...new Set(links.map(link => link.article_key).filter(Boolean))])
  requestCount += articleLookups.request_count
  const savedRows = []
  const hotwordBatchSize = 100
  for (let offset = 0; offset < rows.length; offset += hotwordBatchSize) {
    const result = await client.upsert('hotwords', rows.slice(offset, offset + hotwordBatchSize), { onConflict: 'hotword,stat_date' })
    if (!Array.isArray(result?.data)) throw new Error('hotwords upsert 未返回可用于关联的数据库行')
    savedRows.push(...result.data)
  }
  const ids = new Map(savedRows.map(row => [`${row.hotword}\0${dateLabel(row.stat_date)}`, row.id]))
  const relations = links.flatMap(link => {
    const hotwordId = ids.get(`${link.hotword}\0${dateLabel(link.stat_date)}`) || currentMap.get(`${link.hotword}\0${dateLabel(link.stat_date)}`)?.id
    if (!hotwordId) return []
    return [{ hotword_id: hotwordId, article_id: articleLookups.ids.get(link.article_key) || null, article_key: link.article_key, stat_date: dateLabel(link.stat_date), source_platforms: link.source_platforms || [], matched_terms: link.matched_terms || [], updated_at: now }]
  })
  let relationWriteCount = 0
  for (let offset = 0; offset < relations.length; offset += 500) {
    const result = await client.upsert('hotword_articles', relations.slice(offset, offset + 500), { onConflict: 'hotword_id,article_key' })
    relationWriteCount += Array.isArray(result?.data) ? result.data.length : 0
  }
  const createdCount = savedRows.filter(row => !currentMap.has(`${row.hotword}\0${dateLabel(row.stat_date)}`)).length
  const changedFields = ['aliases', 'article_count', 'article_keys', 'article_url', 'platform_count', 'source_platforms', 'is_rising', 'growth_rate', 'trend_state', 'trend_score', 'consecutive_days', 'daily_growth', 'quality_valid', 'quality_type', 'quality_confidence', 'quality_reason', 'quality_checked_at']
  const createdRows = savedRows.filter(row => !currentMap.has(`${row.hotword}\0${dateLabel(row.stat_date)}`)).map(row => ({ ...row, change_type: 'created' }))
  const updatedRows = savedRows.filter(row => {
    const old = currentMap.get(`${row.hotword}\0${dateLabel(row.stat_date)}`)
    return old && changedFields.some(field => JSON.stringify(old[field] ?? null) !== JSON.stringify(row[field] ?? null))
  }).map(row => ({ ...row, change_type: 'updated' }))
  requestCount += Math.ceil(rows.length / hotwordBatchSize) + Math.ceil(relations.length / 500)
  return { hotwords: rows, saved_rows: savedRows, created_rows: createdRows, updated_rows: updatedRows, deleted_rows: deletedRows, relations_count: relationWriteCount, created_count: createdCount, updated_count: updatedRows.length, unchanged_count: savedRows.length - createdRows.length - updatedRows.length, deleted_count: deletedRows.length, is_rising_count: rows.filter(row => row.is_rising).length, request_count: requestCount }
}

async function collect(input, dependencies = {}) {
  const started = Date.now()
  if (input.config.mode === 'link_articles') return collectArticleLinkage(input, dependencies, started)
  if (input.config.mode === 'persist') return collectHotwordPersistence(input, dependencies, started)
  let ruleRequestCount = 0
  const reference = input.input_artifacts[0]
  if (!reference) { const error = new Error('article input artifact is missing'); error.code = 'INPUT_MISSING'; throw error }
  const value = JSON.parse(await readFile(path.resolve(input.workdir, reference.artifact_id), 'utf8'))
  const rows = Array.isArray(value) ? value : value.rows || value.articles || []
  const statDate = input.config.stat_date || new Date().toISOString().slice(0, 10)
  const minArticleCount = Math.max(1, Number(input.config.min_article_count ?? 2))
  const mergeConsistencyThreshold = ratio(input.config.merge_consistency_threshold, 0.8, 'merge_consistency_threshold')
  const mergeMinArticleCount = positiveInteger(input.config.merge_min_article_count, 3, 'merge_min_article_count')
  let loadedRules
  try {
    loadedRules = await (dependencies.loadHotwordFilterRules || (() => loadHotwordFilterRules({
      client: dependencies.supabaseClient,
      env: dependencies.env,
      fetchImpl: dependencies.supabaseFetchImpl
    })))()
    ruleRequestCount = loadedRules.request_count
  } catch (error) {
    error.request_count = Math.max(Number(error.request_count) || 0, ruleRequestCount)
    throw error
  }
  const aggregation = aggregateHotwordsWithDiagnostics(rows, {
    statDate,
    now: new Date().toISOString(),
    minArticleCount,
    filterRules: loadedRules.rules,
    canonicalRules: input.config.canonical_hotwords,
    mergeConsistencyThreshold,
    mergeMinArticleCount
  })
  const hotwords = aggregation.rows
  const strategy = input.strategy_snapshot_ref ? await (await import('../../src/runner/script-runtime.mjs')).readArtifact(input.workdir, input.strategy_snapshot_ref) : {}
  const existing = new Set((strategy.existing_hotwords || []).map(row => String(row.word || row.hotword || '').trim()).filter(Boolean))
  const today = dateKey(statDate)
  const yesterday = minusOne(today)
  const newHotwordsToday = hotwords.filter(row => !existing.has(row.word) && row.article_ids?.some(id => rows.find(article => (article.article_id || article.article_url || article.title) === id && publishedDate(article) === today)))
  const newHotwordsYesterday = hotwords.filter(row => !existing.has(row.word) && row.article_ids?.some(id => rows.find(article => (article.article_id || article.article_url || article.title) === id && publishedDate(article) === yesterday)))
  const outputName = input.config.output_name || (input.config.stage === 'final' ? 'hotwords-final.json' : 'hotword-snapshot-v1.json')
  const filterSummary = {
    loaded_rule_count: loadedRules.rules.length,
    filtered_count: aggregation.filtered_count,
    rule_hit_counts: aggregation.rule_hit_counts,
    merged_count: aggregation.merged_count,
    merge_group_count: aggregation.merge_group_count,
    merge_consistency_threshold: aggregation.merge_consistency_threshold,
    merge_min_article_count: aggregation.merge_min_article_count,
    canonical_rule_count: aggregation.canonical_rule_count,
    canonical_candidate_count: aggregation.canonical_candidate_count,
    canonical_merge_count: aggregation.canonical_merge_count,
    canonical_group_count: aggregation.canonical_group_count,
    canonical_rule_hit_counts: aggregation.canonical_rule_hit_counts
  }
  const artifact = await writeArtifact(input.workdir, outputName, { stat_date: statDate, rows: hotwords, new_hotwords_today: newHotwordsToday, new_hotwords_yesterday: newHotwordsYesterday, filter_summary: filterSummary, generated_at: new Date().toISOString() })
  artifact.artifact_type = 'hotwords'; artifact.schema_version = '1'; artifact.record_count = hotwords.length
  const newArtifact = await writeArtifact(input.workdir, input.config.new_hotwords_name || 'new-hotwords.json', { stat_date: statDate, new_hotwords_today: newHotwordsToday, new_hotwords_yesterday: newHotwordsYesterday })
  newArtifact.artifact_type = 'debug_report'; newArtifact.schema_version = '1'; newArtifact.record_count = newHotwordsToday.length + newHotwordsYesterday.length
  return { status: 'success', input_count: rows.length, output_count: hotwords.length, created_count: null, updated_count: null, filtered_count: aggregation.filtered_count, request_count: ruleRequestCount, duration_ms: Date.now() - started, artifact, debug_artifacts: [{ ...newArtifact, kind: 'debug', default_visible: false }], message: 'hotwords stage completed', business_summary: { total: hotwords.length, new_today: newHotwordsToday.length, new_yesterday: newHotwordsYesterday.length, filter_rules: filterSummary, merged_count: aggregation.merged_count } }
}

async function collectArticleLinkage(input, dependencies, started) {
  const refs = Array.isArray(input.input_artifacts) ? input.input_artifacts.filter(Boolean) : []
  if (!refs.length) { const error = new Error('热词归属步骤缺少文章或候选热词产物'); error.code = 'INPUT_MISSING'; throw error }
  const client = supabaseClient(dependencies, dependencies.env || process.env)
  let loadedRules = { rules: [], request_count: 0 }
  if (client) loadedRules = await (dependencies.loadHotwordFilterRules || (() => loadHotwordFilterRules({ client, env: dependencies.env || process.env, fetchImpl: dependencies.supabaseFetchImpl })))()
  const rows = []
  const sourceHotwords = []
  let qualityRows = []
  let inputArticleCount = 0
  for (const ref of refs) {
    const value = JSON.parse(await readFile(path.resolve(input.workdir, ref.artifact_id), 'utf8'))
    if (ref.artifact_type === 'write_set') {
      const articles = Array.isArray(value?.articles) ? value.articles : []
      inputArticleCount += articles.length
      rows.push(...articles.map(row => ({ ...row, source_steps: [...new Set([...(row.source_steps || []), ref.producer_step_key].filter(Boolean))] })))
    } else if (ref.artifact_type === 'articles') {
      const articles = artifactRows(value)
      inputArticleCount += articles.length
      rows.push(...articles.map(row => ({ ...row, source_steps: [...new Set([...(row.source_steps || []), ref.producer_step_key].filter(Boolean))] })))
    } else if (ref.artifact_type === 'hotwords') sourceHotwords.push(...artifactRows(value))
    else if (String(ref.artifact_id || '').includes('hotword-quality')) qualityRows.push(...artifactRows(value))
  }
  const current = mergeCanonicalArticles(rows)
  let historical = { rows: [], request_count: 0, article_rows_read: 0, article_rows_usable: 0 }
  if (client) historical = await loadHistoricalArticles(client)
  const merged = mergeCanonicalArticles([...current.rows, ...historical.rows])
  const sourceStepsByKey = new Map()
  for (const row of rows) {
    const key = row.article_key || canonicalizeArticle(row).article_key
    if (!key) continue
    const steps = sourceStepsByKey.get(key) || new Set()
    for (const value of row.source_steps || []) if (value) steps.add(value)
    sourceStepsByKey.set(key, steps)
  }
  for (const row of merged.rows) {
    const steps = sourceStepsByKey.get(row.article_key)
    if (steps?.size) row.source_steps = [...steps].sort()
  }
  const statDate = dateLabel(input.config.stat_date || input.config.run_date || new Date().toISOString().slice(0, 10))
  let existingHotwords = []
  let existingHotwordRequestCount = 0
  if (client) {
    const result = await loadExistingHotwords(client)
    existingHotwords = result.rows
    existingHotwordRequestCount = result.request_count
  }
  const existingAliasSeeds = existingHotwords.map(row => ({ hotword: row.hotword, aliases: Array.isArray(row.aliases) ? row.aliases : [], source_platforms: row.source_platforms || [], stat_date: row.stat_date, quality_valid: row.quality_valid, quality_type: row.quality_type, quality_confidence: row.quality_confidence, quality_reason: row.quality_reason, quality_checked_at: row.quality_checked_at }))
  const qualitySeeds = qualityRows.filter(row => row?.canonical_word && row?.word && row.canonical_word !== row.word).map(row => ({ hotword: row.canonical_word, aliases: [row.word] }))
  const seeds = [...sourceHotwords, ...existingAliasSeeds, ...qualitySeeds]
  const canonicalRules = input.config.canonical_hotwords || [{ canonical: '闲鱼', match_type: 'prefix', protected: true }]
  const linkage = makeHotwordLinkage(merged.rows, seeds, { statDate, canonicalRules, filterRules: loadedRules.rules, minArticleCount: Math.max(1, Number(input.config.min_article_count ?? 2)), mergeConsistencyThreshold: Object.hasOwn(input.config, 'merge_consistency_threshold') ? input.config.merge_consistency_threshold : 0.8, mergeMinArticleCount: Number(input.config.merge_min_article_count ?? 3) })
  const generatedAt = new Date().toISOString()
  const qualityByWord = new Map()
  for (const row of qualityRows) {
    if (row?.word) qualityByWord.set(String(row.word).trim(), row)
    if (row?.canonical_word) qualityByWord.set(String(row.canonical_word).trim(), row)
  }
  for (const row of linkage.hotwords) {
    const quality = qualityByWord.get(row.hotword) || row.aliases.map(alias => qualityByWord.get(alias)).find(Boolean)
    if (!quality) continue
    row.quality_valid = quality.valid === true || quality.quality_valid === true ? true : quality.valid === false || quality.quality_valid === false ? false : null
    row.quality_type = quality.type || quality.quality_type || null
    row.quality_confidence = Number(quality.confidence ?? quality.quality_confidence) || null
    row.quality_reason = quality.reason || quality.quality_reason || null
    row.quality_checked_at = quality.checked_at || generatedAt
  }
  const currentKeys = new Set(current.rows.map(row => row.article_key))
  const currentArticles = linkage.articles.filter(row => currentKeys.has(row.article_key))
  const currentLinks = linkage.links.filter(row => currentKeys.has(row.article_key))
  let persistence = null
  if (input.config.persist === true) {
    persistence = await persistHotwordLinkage({
      client,
      hotwords: linkage.hotwords,
      links: linkage.links,
      recomputedDates: [...new Set(merged.rows.map(row => articleStatDate(row, statDate)))],
      now: generatedAt,
      minRisingCount: Number(input.config.min_rising_count ?? 3),
      minGrowthRate: Number(input.config.min_growth_rate ?? 0.5)
    })
  }
  const articles = await writeArtifact(input.workdir, input.config.articles_output_name || 'hotword-linked-articles.json', { rows: currentArticles, generated_at: generatedAt, input_count: inputArticleCount, historical_article_count: historical.rows.length, duplicate_count: merged.duplicate_report.duplicate_count })
  articles.artifact_type = 'articles'; articles.schema_version = '1'; articles.record_count = currentArticles.length
  const hotwordPayload = { stat_date: statDate, rows: persistence?.hotwords || linkage.hotwords, generated_at: generatedAt, filter_summary: { loaded_rule_count: loadedRules.rules.length, filtered_count: linkage.aggregation.filtered_count, rule_hit_counts: linkage.aggregation.rule_hit_counts, canonical_merge_count: linkage.aggregation.canonical_merge_count, merged_count: linkage.aggregation.merged_count, history_articles_read: historical.article_rows_read, history_articles_used: historical.rows.length }, ...(persistence ? { changes: { created: persistence.created_rows, updated: persistence.updated_rows, deleted: persistence.deleted_rows, counts: { created: persistence.created_count, updated: persistence.updated_count, deleted: persistence.deleted_count, unchanged: persistence.unchanged_count, total: persistence.created_count + persistence.updated_count + persistence.deleted_count } } } : {}) }
  const hotwords = await writeArtifact(input.workdir, input.config.hotwords_output_name || 'hotword-linked-hotwords.json', hotwordPayload)
  hotwords.artifact_type = 'hotwords'; hotwords.schema_version = '1'; hotwords.record_count = linkage.hotwords.length
  const links = await writeArtifact(input.workdir, input.config.links_output_name || 'hotword-article-links.json', { rows: currentLinks, generated_at: generatedAt })
  links.artifact_type = 'hotword_links'; links.schema_version = '1'; links.record_count = currentLinks.length
  const duplicateReport = await writeArtifact(input.workdir, 'hotword-linkage-dedup-report.json', { input_articles: inputArticleCount, unique_articles: linkage.articles.length, duplicate_count: merged.duplicate_report.duplicate_count, invalid_count: merged.invalid.length, invalid: merged.invalid })
  duplicateReport.artifact_type = 'debug_report'; duplicateReport.schema_version = '1'; duplicateReport.record_count = merged.duplicate_report.duplicate_count + merged.invalid.length
  const requestCount = (loadedRules.request_count || 0) + existingHotwordRequestCount + historical.request_count + (persistence?.request_count || 0)
  return { status: current.invalid.length ? 'partial' : 'success', input_count: inputArticleCount, output_count: linkage.hotwords.length, created_count: persistence?.created_count ?? null, updated_count: persistence?.updated_count ?? null, filtered_count: linkage.aggregation.filtered_count + current.duplicate_report.duplicate_count + current.invalid.length, request_count: requestCount, duration_ms: Date.now() - started, artifact: [articles, hotwords, links], debug_artifacts: [{ ...duplicateReport, kind: 'debug', default_visible: false }], error_code: current.invalid.length ? 'ARTICLE_IDENTITY_INCOMPLETE' : undefined, message: input.config.persist === true ? '历史文章热词已重算并幂等写入数据库' : '历史文章热词已重算，按 pub_time 生成每日 Top10', business_summary: { input_articles: inputArticleCount, historical_articles_read: historical.article_rows_read, historical_articles_used: historical.rows.length, current_articles: currentArticles.length, duplicate_articles: current.duplicate_report.duplicate_count, invalid_articles: current.invalid.length, hotwords: linkage.hotwords.length, hotword_article_links: linkage.links.length, requests: requestCount, persistence: persistence ? { created: persistence.created_count, updated: persistence.updated_count, deleted: persistence.deleted_count, unchanged: persistence.unchanged_count, relations: persistence.relations_count } : null, next_step: input.config.persist === true ? '工作流变化产物已准备' : '判断趋势与质量后执行热词补采' } }
}

async function collectHotwordPersistence(input, dependencies, started) {
  const refs = Array.isArray(input.input_artifacts) ? input.input_artifacts : []
  const hotwordRef = refs.find(ref => ref.artifact_type === 'hotwords')
  const linkRef = refs.find(ref => ref.artifact_type === 'hotword_links')
  if (!hotwordRef || !linkRef) { const error = new Error('热词数据库更新需要 hotwords 和 hotword_links 两份输入'); error.code = 'INPUT_MISSING'; throw error }
  const hotwordValue = JSON.parse(await readFile(path.resolve(input.workdir, hotwordRef.artifact_id), 'utf8'))
  const linkValue = JSON.parse(await readFile(path.resolve(input.workdir, linkRef.artifact_id), 'utf8'))
  const client = supabaseClient(dependencies, dependencies.env || process.env)
  const result = await persistHotwordLinkage({ client, hotwords: artifactRows(hotwordValue), links: artifactRows(linkValue), now: new Date().toISOString(), minRisingCount: Number(input.config.min_rising_count ?? 3), minGrowthRate: Number(input.config.min_growth_rate ?? 0.5) })
  const idByKey = new Map(result.saved_rows.map(row => [`${row.hotword}\0${dateLabel(row.stat_date)}`, row.id]))
  const persistedHotwords = result.hotwords.map(row => ({ ...row, id: idByKey.get(`${row.hotword}\0${dateLabel(row.stat_date)}`) || null }))
  const persistedLinks = artifactRows(linkValue).map(row => ({ ...row, hotword_id: idByKey.get(`${row.hotword}\0${dateLabel(row.stat_date)}`) || null }))
  const generatedAt = new Date().toISOString()
  const hotwords = await writeArtifact(input.workdir, input.config.hotwords_output_name || 'hotwords-persisted.json', { rows: persistedHotwords, generated_at: generatedAt })
  hotwords.artifact_type = 'hotwords'; hotwords.schema_version = '1'; hotwords.record_count = persistedHotwords.length
  const links = await writeArtifact(input.workdir, input.config.links_output_name || 'hotword-article-links-persisted.json', { rows: persistedLinks, generated_at: generatedAt })
  links.artifact_type = 'hotword_links'; links.schema_version = '1'; links.record_count = persistedLinks.length
  return { status: 'success', input_count: artifactRows(hotwordValue).length, output_count: result.relations_count, created_count: result.created_count, updated_count: result.updated_count, filtered_count: 0, request_count: result.request_count, duration_ms: Date.now() - started, artifact: [hotwords, links], message: 'hotwords 与文章关系已幂等写入 Supabase', business_summary: { hotwords_written: result.saved_rows.length, hotword_article_relations: result.relations_count, created: result.created_count, updated: result.updated_count, rising_hotwords: result.is_rising_count, next_step: '对上升热词执行 WxRank/RedFox 双平台补采' } }
}

if (import.meta.main) runCollectorMain(collect)

export { collect }
