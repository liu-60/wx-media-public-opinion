import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readArtifact, runCollectorMain, writeArtifact } from '../../src/runner/script-runtime.mjs'
import { fetchWxRankArticleList, fetchWxRankKeywordArticles } from '../../src/collector-adapters/wxrank-articles.mjs'
import { fetchRedfoxKeywordArticles } from '../../src/collector-adapters/redfox.mjs'
import { canonicalizeArticle, mergeCanonicalArticles } from '../../src/collection-canonical.mjs'
import { createSupabaseClient } from '../../management-center/services/supabase.mjs'
import { normalizeManualSearchConfig } from '../../src/runner/hotword-expand-config.mjs'
import { loadCollectorEnvironment } from '../../src/collector-config.mjs'
import { loadHotwordFilterRules } from './hotword-filter-rules.mjs'
import { cleanArticleTitle, loadHistoricalArticles } from './hotwords-update.mjs'
import { readDebugApiRequestBudgetSnapshot } from '../../src/runner/debug-api-request-budget.mjs'

function dateKey(value) {
  const raw = String(value || '').replaceAll('-', '').slice(0, 8)
  if (/^20\d{6}$/u.test(raw)) return raw
  return new Date().toISOString().slice(0, 10).replaceAll('-', '')
}

function fallbackDate(message, fallback) {
  const match = /(?:不能大于|大于)(20\d{6})/u.exec(String(message || ''))
  return match ? match[1] : fallback
}

const GARBAGE_HOTWORDS = new Set(['于是', '第一', '不会', '可以', '觉得', '一个', '这个', '那个', '什么', '如何', '我们', '你们', '他们'])
const COMMON_SURNAMES = new Set([...'赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳唐罗薛伍余米贝姚孟顾尹江钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣贲邓郁单杭洪包诸左石崔吉龚程邢裴陆荣翁荀羊於惠甄曲封储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴郁胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍郤璩桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东殴殳沃利蔚越夔隆师巩厍聂晁勾敖融冷訾辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公'])
const TOPIC_CUES = /(?:品牌|公司|产品|手机|婚礼|政策|事件|节|菜|病|药|城市|大学|明星|人物|诈骗|地震|台风|电影|游戏|汽车|iphone|ios|ai|国庆|春节|奥运|发布会|热搜)/iu

export function judgeHotwordLocally(value) {
  const word = cleanArticleTitle(value)
  const lowered = word.toLocaleLowerCase('zh-CN')
  if (!word || GARBAGE_HOTWORDS.has(lowered) || /^[\p{P}\p{S}\s]+$/u.test(word) || /^\d{1,4}$/u.test(word)) return { valid: false, type: 'noise', confidence: 0.99, reason: '常见功能词或无检索主体' }
  if (['闲鱼', 'iPhone', 'iOS', '预制菜'].some(topic => lowered.includes(topic.toLocaleLowerCase('zh-CN'))) || TOPIC_CUES.test(word)) return { valid: true, type: /iphone|ios|手机|产品/iu.test(word) ? 'product' : /婚礼|菜|政策|事件|节|现象|热搜/iu.test(word) ? 'phenomenon' : 'topic', confidence: 0.9, reason: '标题中包含明确主题线索' }
  if (/^[\u4e00-\u9fff]{3}$/u.test(word) && COMMON_SURNAMES.has([...word][0])) return { valid: true, type: 'person', confidence: 0.82, reason: '符合常见中文姓名主体形式' }
  if (/[A-Z\d]/u.test(word) && [...word].length >= 2) return { valid: true, type: 'product', confidence: 0.82, reason: '包含可检索的型号或英文主体' }
  if ([...word].length >= 5 && /[\u4e00-\u9fff]/u.test(word)) return { valid: true, type: 'topic', confidence: 0.78, reason: '具有明确的多字主题短语结构' }
  return null
}

function dateMinusDays(value, days) {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

function normalizedStatDate(value) {
  const raw = String(value || '').trim()
  const iso = /^\d{8}$/u.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(iso)) return null
  const date = new Date(`${iso}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null
}

export function scoreHotwordSupplement(row, historyRows = [], { runDate = new Date().toISOString().slice(0, 10), targetSamples = 20 } = {}) {
  const word = String(row?.word || row?.hotword || '').trim()
  const normalizedRunDate = normalizedStatDate(runDate)
  const statDate = normalizedStatDate(row?.stat_date || runDate)
  if (!normalizedRunDate || !statDate) throw collectorError('INVALID_STAT_DATE', '热词统计日期格式无效')
  const countOn = date => {
    const match = historyRows.find(item => String(item?.word || item?.hotword || '').trim() === word && normalizedStatDate(item?.stat_date || statDate) === date)
    return Math.max(0, Number(match?.article_count) || 0)
  }
  const counts = [countOn(dateMinusDays(statDate, 2)), countOn(dateMinusDays(statDate, 1)), countOn(statDate)]
  const [twoDaysAgo, yesterday, today] = counts
  const dailyGrowth = today - yesterday
  const growthRate = yesterday > 0 ? dailyGrowth / yesterday : today > 0 ? 1 : 0
  const trendState = today === 0 ? 'falling' : !historyRows.some(item => String(item?.word || item?.hotword || '').trim() === word && (normalizedStatDate(item?.stat_date) || '') < statDate) ? 'new' : dailyGrowth < 0 ? 'falling' : dailyGrowth === 0 ? 'stable' : (yesterday >= twoDaysAgo ? 'rising' : 'stable')
  const recent7Count = historyRows.filter(item => String(item?.word || item?.hotword || '').trim() === word && (normalizedStatDate(item?.stat_date) || '') <= statDate && (normalizedStatDate(item?.stat_date) || '') >= dateMinusDays(statDate, 6)).reduce((sum, item) => sum + (Number(item.article_count) || 0), 0)
  const gap = Math.max(0, Number(targetSamples) - today)
  const platforms = Math.max(Number(row?.platform_count) || 0, new Set(row?.source_platforms || []).size)
  const consecutive = Math.max(0, Number(row?.consecutive_days) || 0)
  const trendScore = Math.max(0, (Number(row?.trend_score) || 0) + dailyGrowth * 3 + Math.log1p(recent7Count) * 2 + platforms * 2 + consecutive)
  const freshnessDays = Math.max(0, Math.floor((new Date(`${normalizedRunDate}T00:00:00Z`) - new Date(`${statDate}T00:00:00Z`)) / 86_400_000))
  const gapFactor = Math.min(1, gap / Math.max(1, targetSamples))
  const confidence = Number(row?.quality_confidence ?? 0.8)
  return { word, stat_date: statDate, today_count: today, yesterday_count: yesterday, two_days_ago_count: twoDaysAgo, recent_7day_count: recent7Count, platform_count: platforms, consecutive_days: consecutive, daily_growth: dailyGrowth, growth_rate: growthRate, trend_state: trendState, trend_score: trendScore, sample_gap: gap, freshness_days: freshnessDays, quality_factor: confidence, score: Math.round(trendScore * confidence * gapFactor * (freshnessDays <= 1 ? 1 : freshnessDays <= 3 ? 0.7 : 0.2) * 100) / 100 }
}

async function readJsonFile(filePath, fallback) {
  try { const value = JSON.parse(await readFile(filePath, 'utf8')); return value } catch { return fallback }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, filePath)
}

function parseLlmContent(value) {
  const raw = String(value || '').replace(/^```(?:json)?/iu, '').replace(/```$/u, '').trim()
  try { return JSON.parse(raw) } catch {}
  const start = raw.indexOf('{'); const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) { try { return JSON.parse(raw.slice(start, end + 1)) } catch {} }
  return null
}

async function judgeHotwordWithLlm(word, articleTitles, { env, fetchImpl = globalThis.fetch }) {
  const endpoint = String(env.LLM_BASE_URL || env.OPENAI_BASE_URL || '').replace(/\/+$/u, '')
  const apiKey = String(env.LLM_API_KEY || env.OPENAI_API_KEY || env.AI_GATEWAY_API_KEY || '').trim()
  if (String(env.LLM_ENABLED).toLowerCase() !== 'true' || !endpoint || !apiKey) return { valid: null, canonical_word: word, type: 'undetermined', confidence: 0, reason: '中央 LLM 配置未启用或缺少认证', status: 'waiting_auth', request_count: 0 }
  const response = await fetchImpl(`${endpoint}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: env.LLM_MODEL || 'gpt-4o-mini', temperature: 0, response_format: { type: 'json_object' }, messages: [
    { role: 'system', content: '你是公众号热点检索词质量审核器。仅当词语代表可独立检索的事件、人物、品牌、社会现象、产品、地点、政策或流行事件时判 valid=true。功能词、语气词、泛化词判 false。只返回 JSON: {"valid":true,"canonical_word":"标准词","type":"brand|person|event|phenomenon|product|place|policy|other|noise","confidence":0.0,"reason":"简短中文依据"}。' },
    { role: 'user', content: JSON.stringify({ word, article_titles: articleTitles.slice(0, 5) }) }
  ] }) })
  const body = await response.json().catch(() => null)
  if (!response.ok) { const error = new Error(`LLM 热词质量判断 HTTP ${response.status}`); error.code = response.status === 429 ? 'RATE_LIMIT' : 'LLM_ERROR'; throw error }
  const result = parseLlmContent(body?.choices?.[0]?.message?.content)
  if (typeof result?.valid !== 'boolean' || typeof result.canonical_word !== 'string' || typeof result.type !== 'string' || !Number.isFinite(Number(result.confidence)) || typeof result.reason !== 'string') { const error = new Error('LLM 热词质量结果字段无效'); error.code = 'OUTPUT_SCHEMA_INVALID'; throw error }
  return { valid: result.valid, canonical_word: cleanArticleTitle(result.canonical_word) || word, type: result.type.slice(0, 40), confidence: Math.max(0, Math.min(1, Number(result.confidence))), reason: result.reason.slice(0, 300), status: 'checked', request_count: 1 }
}

export function resolveWxRankSearchMonth(now = new Date(), timeZone = 'Asia/Singapore') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(part => [part.type, part.value]))
  const year = Number(parts.year)
  const month = Number(parts.month)
  const day = Number(parts.day)
  const target = day <= 7 ? new Date(Date.UTC(year, month - 2, 1)) : new Date(Date.UTC(year, month - 1, 1))
  return `${target.getUTCFullYear()}${String(target.getUTCMonth() + 1).padStart(2, '0')}`
}

async function collect(input, dependencies = {}) {
  if (input.config.search_mode === 'manual_keywords') return collectManualKeywords(input, dependencies)
  if (input.config.search_mode === 'dual_platform') return collectDualPlatform(input, dependencies)
  const started = Date.now()
  const reference = input.input_artifacts?.[0]
  if (!reference) { const error = new Error('hotword snapshot input is missing'); error.code = 'INPUT_MISSING'; throw error }
  const snapshot = await readArtifact(input.workdir, reference)
  const candidates = [...(snapshot.new_hotwords_today || []), ...(snapshot.new_hotwords_yesterday || [])]
  const maxPerWord = Math.max(0, Number(input.config.max_requests_per_hotword ?? 2))
  const maxHotwords = Math.max(0, Number(input.config.max_hotwords ?? 20))
  const unique = [...new Map(candidates.filter(row => Number(row.article_count) >= 2).map(row => [row.word, row])).values()].slice(0, maxHotwords)
  const skippedHotwords = Math.max(0, new Set(candidates.filter(row => Number(row.article_count) >= 2).map(row => row.word)).size - unique.length)
  const maxTotalRequests = Math.max(0, Number(input.config.max_total_requests ?? maxHotwords * maxPerWord))
  const rows = []
  const raw = []
  const errors = []
  let requestCount = 0
  for (const hotword of unique) {
    if (requestCount >= maxTotalRequests) break
    let requestDate = dateKey(input.config.run_date)
    for (let attempt = 0; attempt < maxPerWord; attempt += 1) {
      if (requestCount >= maxTotalRequests) break
      const result = await fetchWxRankArticleList({ apiKey: loadCollectorEnvironment().WXRANK_API_KEY, date: requestDate, keyword: hotword.word })
      requestCount += result.request_count || 0
      raw.push({ hotword: hotword.word, attempt: attempt + 1, requested_date: requestDate, effective_data_date: requestDate, status: result.status, error_code: result.error_code, data: result.data })
      if (result.status === 'waiting_auth') { errors.push({ hotword: hotword.word, code: result.error_code, message: result.message }); break }
      if (result.status !== 'success') {
        const nextDate = fallbackDate(result.message, requestDate)
        if (result.error_code === 'API_BUSINESS_ERROR' && nextDate !== requestDate && attempt + 1 < maxPerWord) { requestDate = nextDate; continue }
        errors.push({ hotword: hotword.word, code: result.error_code, message: result.message }); break
      }
      for (const row of result.data?.list || []) rows.push({ ...row, source_platform: 'wxrank', collect_reasons: [`hotword:${hotword.word}`], hotword: hotword.word })
      break
    }
  }
  const artifact = await writeArtifact(input.workdir, 'hotword-articles.json', { source: 'wxrank', rows, generated_at: new Date().toISOString(), hotwords: unique.map(row => row.word), skipped_hotwords: skippedHotwords, request_count: requestCount })
  artifact.artifact_type = 'articles'; artifact.schema_version = '1'; artifact.record_count = rows.length
  const rawArtifact = await writeArtifact(input.workdir, 'hotword-expand-raw.json', { requests: raw, generated_at: new Date().toISOString() })
  rawArtifact.artifact_type = 'raw_response'; rawArtifact.schema_version = '1'; rawArtifact.record_count = raw.length
  const errorArtifact = await writeArtifact(input.workdir, 'hotword-expand-errors.json', { rows: errors })
  errorArtifact.artifact_type = 'exceptions'; errorArtifact.schema_version = '1'; errorArtifact.record_count = errors.length
  const waitingAuth = errors.some(error => error.code === 'AUTH_ERROR')
  const status = waitingAuth ? 'waiting_auth' : errors.length ? (rows.length ? 'partial' : 'failed') : 'success'
  return { status, input_count: unique.length, output_count: rows.length, created_count: null, updated_count: null, filtered_count: errors.length + skippedHotwords, request_count: requestCount, duration_ms: Date.now() - started, artifact, debug_artifacts: [rawArtifact, errorArtifact].map(item => ({ ...item, kind: 'debug', default_visible: false })), error_code: errors[0]?.code, message: errors.length ? `${errors.length} hotword request(s) were not usable` : 'hotword expansion completed', business_summary: { hotwords_selected: unique.length, hotwords_skipped: skippedHotwords, requests: requestCount, rows: rows.length, errors: errors.length, max_total_requests: maxTotalRequests } }
}

async function collectManualKeywords(input, dependencies = {}) {
  const started = Date.now()
  const config = normalizeManualSearchConfig(input.config || {})
  const env = dependencies.env || loadCollectorEnvironment()
  const platforms = config.manual_platforms
  const keys = { wxrank: env.WXRANK_API_KEY, redfox: env.REDFOX_API_KEY }
  const searchMonth = resolveWxRankSearchMonth(dependencies.now || new Date())
  const rows = []
  const requests = []
  const errors = []
  const waitingAuth = new Set()
  const searchedTerms = new Set()
  let requestCount = 0
  let wxrankCount = 0
  let redfoxCount = 0
  let skippedPairs = 0

  for (const keyword of config.manual_hotwords) {
    for (const platform of platforms) {
      if (requestCount >= config.max_total_requests) {
        skippedPairs += 1
        continue
      }
      if (!keys[platform]) {
        waitingAuth.add(platform)
        errors.push({ platform, keyword, error_code: 'AUTH_REQUIRED', message: `${platform === 'wxrank' ? 'WxRank' : 'RedFox'} 搜索未配置认证` })
        continue
      }
      const result = platform === 'wxrank'
        ? await (dependencies.fetchWxRankKeywordArticles || fetchWxRankKeywordArticles)({ apiKey: keys.wxrank, keyword, month: searchMonth, fetchImpl: dependencies.wxrankFetchImpl || globalThis.fetch })
        : await (dependencies.fetchRedfoxKeywordArticles || fetchRedfoxKeywordArticles)({ apiKey: keys.redfox, keyword, offset: 0, sortType: '_4', exactMatch: true, fetchImpl: dependencies.redfoxFetchImpl || globalThis.fetch })
      const used = Number(result.request_count) || 0
      requestCount += used
      if (platform === 'wxrank') wxrankCount += used
      else redfoxCount += used
      searchedTerms.add(keyword)
      requests.push({ platform, keyword, status: result.status, error_code: result.error_code || null, request_count: used, total: result.total ?? null, has_more: result.has_more ?? null, raw: result.raw ?? null })
      if (result.status === 'success') {
        rows.push(...(result.rows || []).map(row => ({ ...row, source_platform: platform, collect_reasons: [`manual_hotword:${keyword}`], hotword: keyword, source_steps: ['hotword-expand-selftest'] })))
      } else {
        if (result.status === 'waiting_auth') waitingAuth.add(platform)
        errors.push({ platform, keyword, error_code: result.error_code || 'SEARCH_FAILED', message: result.message || `${platform} 搜索失败` })
      }
    }
  }

  const merged = mergeCanonicalArticles(rows)
  const matchesByArticle = new Map()
  for (const row of rows) {
    const key = canonicalizeArticle(row).article_key
    const matches = matchesByArticle.get(key) || new Set()
    matches.add(String(row.hotword || '').trim())
    matchesByArticle.set(key, matches)
  }
  const articlesRows = merged.rows.map(row => ({
    ...row,
    matched_hotwords: [...(matchesByArticle.get(row.article_key) || [])].sort(),
    source_platforms: [...new Set((row.source_refs || []).map(ref => ref.platform))].sort()
  }))
  const stats = {
    search_mode: 'manual_keywords',
    keywords_selected: config.manual_hotwords.length,
    keywords_searched: searchedTerms.size,
    keywords_skipped: skippedPairs,
    articles_raw: rows.length,
    articles_unique: articlesRows.length,
    duplicate_articles: merged.duplicate_report.duplicate_count,
    invalid_articles: merged.invalid.length,
    wxrank_requests: wxrankCount,
    redfox_requests: redfoxCount,
    wxrank_month: searchMonth,
    waiting_auth_platforms: [...waitingAuth],
    errors: errors.length,
    max_total_requests: config.max_total_requests,
    database_writes: 0,
    next_step: '单独检索结果仅供验证；确认后再由工作流补采与文章过滤步骤处理'
  }
  const generatedAt = new Date().toISOString()
  const articles = await writeArtifact(input.workdir, 'hotword-expand-manual-articles.json', { rows: articlesRows, hotwords: config.manual_hotwords, generated_at: generatedAt, summary: stats })
  articles.artifact_type = 'articles'
  articles.schema_version = '1'
  articles.record_count = articlesRows.length
  const rawArtifact = await writeArtifact(input.workdir, 'hotword-expand-manual-search-responses.json', { requests, generated_at: generatedAt })
  rawArtifact.artifact_type = 'raw_response'
  rawArtifact.schema_version = '1'
  rawArtifact.record_count = requests.length
  const errorArtifact = await writeArtifact(input.workdir, 'hotword-expand-manual-search-errors.json', { rows: errors, waiting_auth_platforms: [...waitingAuth], generated_at: generatedAt })
  errorArtifact.artifact_type = 'exceptions'
  errorArtifact.schema_version = '1'
  errorArtifact.record_count = errors.length
  const failed = requests.some(request => request.status !== 'success') || skippedPairs > 0
  return {
    status: waitingAuth.size ? 'waiting_auth' : failed ? (articlesRows.length ? 'partial' : 'failed') : 'success',
    input_count: config.manual_hotwords.length,
    output_count: articlesRows.length,
    created_count: 0,
    updated_count: 0,
    filtered_count: merged.duplicate_report.duplicate_count + merged.invalid.length + skippedPairs,
    request_count: requestCount,
    duration_ms: Date.now() - started,
    artifact: articles,
    debug_artifacts: [rawArtifact, errorArtifact].map(item => ({ ...item, kind: 'debug', default_visible: false })),
    error_code: waitingAuth.size ? 'AUTH_ERROR' : errors[0]?.error_code,
    message: waitingAuth.size ? `缺少手动热词检索平台认证：${[...waitingAuth].join('、')}` : failed ? '手动热词搜索有失败或超出本轮请求上限，已保留可用结果' : '手动热词搜索完成，仅输出验证结果，未写入热词数据库',
    business_summary: stats
  }
}

async function collectDualPlatform(input, dependencies = {}) {
  const started = Date.now()
  const refs = Array.isArray(input.input_artifacts) ? input.input_artifacts : []
  const articlesRef = refs.find(ref => ref.artifact_type === 'articles')
  const hotwordsRef = refs.find(ref => ref.artifact_type === 'hotwords')
  if (!articlesRef || !hotwordsRef) { const error = new Error('上升热词补采需要文章和热词两份输入'); error.code = 'INPUT_MISSING'; throw error }
  const articleValue = await readArtifact(input.workdir, articlesRef)
  const hotwordValue = await readArtifact(input.workdir, hotwordsRef)
  const linksRef = refs.find(ref => ref.artifact_type === 'hotword_links')
  const linksValue = linksRef ? await readArtifact(input.workdir, linksRef) : { rows: [] }
  const existingArticles = Array.isArray(articleValue) ? articleValue : articleValue.rows || articleValue.articles || []
  const existingHotwords = Array.isArray(hotwordValue) ? hotwordValue : hotwordValue.rows || hotwordValue.hotwords || []
  const existingLinks = Array.isArray(linksValue) ? linksValue : linksValue.rows || linksValue.links || []
  const configInteger = (value, fallback, name, minimum, maximum) => {
    const parsed = value === undefined || value === null || value === '' ? fallback : Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
      const error = new Error(`${name}必须是${minimum}到${maximum}之间的整数`)
      error.code = 'INVALID_CONFIG'
      throw error
    }
    return parsed
  }
  const maxHotwords = configInteger(input.config.max_hotwords, 3, 'max_hotwords', 0, 20)
  const maxTotalRequests = configInteger(input.config.max_total_requests, 6, 'max_total_requests', 0, 10)
  const minArticleCount = configInteger(input.config.min_rising_article_count, 3, 'min_rising_article_count', 1, 100_000)
  const targetSamples = configInteger(input.config.target_article_samples, 20, 'target_article_samples', 1, 100_000)
  const maxQualityRequests = configInteger(input.config.max_llm_quality_requests, 10, 'max_llm_quality_requests', 0, 50)
  const maxRequestsPerHotword = configInteger(input.config.max_requests_per_hotword, 2, 'max_requests_per_hotword', 1, 2)
  const maxTrendAgeDays = configInteger(input.config.max_trend_age_days, 3, 'max_trend_age_days', 0, 30)
  const cooldownDays = configInteger(input.config.no_new_cooldown_days, 7, 'no_new_cooldown_days', 1, 60)
  const runDate = String(input.config.run_date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(dependencies.now || new Date())).slice(0, 10)
  const env = dependencies.env || loadCollectorEnvironment()
  const now = dependencies.now || new Date()
  const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString()
  const stateDir = path.resolve(dependencies.stateDir || env.COLLECTOR_STATE_DIR || path.resolve('data', 'collector-state'))
  const qualityPath = path.join(stateDir, 'hotword-quality-cache.json')
  const ledgerPath = path.join(stateDir, 'hotword-expansion-ledger.json')
  const qualityCache = await readJsonFile(qualityPath, { rows: {} })
  const ledger = await readJsonFile(ledgerPath, { rows: {} })
  qualityCache.rows ||= {}
  ledger.rows ||= {}
  const existingQuality = new Map()
  for (const row of [...existingHotwords].sort((left, right) => String(right.quality_checked_at || right.stat_date).localeCompare(String(left.quality_checked_at || left.stat_date)))) {
    const word = String(row.word || row.hotword || '').trim()
    if (word && row.quality_valid !== null && row.quality_valid !== undefined && !existingQuality.has(word)) existingQuality.set(word, { valid: row.quality_valid, canonical_word: word, type: row.quality_type || 'other', confidence: Number(row.quality_confidence) || 0.8, reason: row.quality_reason || '历史审核结果', status: 'cached', checked_at: row.quality_checked_at || null })
  }
  const latestByWord = new Map()
  for (const row of existingHotwords) {
    const word = String(row.word || row.hotword || '').trim()
    if (!word) continue
    const datedRow = row.stat_date ? row : { ...row, stat_date: runDate }
    const current = latestByWord.get(word)
    if (!current || String(datedRow.stat_date) > String(current.stat_date)) latestByWord.set(word, datedRow)
  }
  const preliminary = [...latestByWord.values()].map(row => ({ row, score: scoreHotwordSupplement(row, existingHotwords, { runDate, targetSamples }) }))
    .filter(item => item.score.today_count >= minArticleCount && item.score.sample_gap > 0 && item.score.freshness_days <= maxTrendAgeDays && ['rising', 'new'].includes(item.score.trend_state))
    .sort((left, right) => right.score.score - left.score.score || right.score.trend_score - left.score.trend_score || left.score.word.localeCompare(right.score.word, 'zh-CN'))
  const priorTitles = new Map(existingArticles.map(row => [String(row.article_key || canonicalizeArticle(row).article_key), cleanArticleTitle(row.title)]))
  const client = dependencies.supabaseClient || (() => {
    const url = env.SUPABASE_URL
    const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY
    return url && key ? createSupabaseClient({ url, key, fetchImpl: dependencies.supabaseFetchImpl || globalThis.fetch }) : null
  })()
  let historyCount = 0
  const qualityRows = []
  const qualityErrors = []
  const qualityDecisions = new Map()
  let llmRequestCount = 0
  let unresolved = 0
  let judged = 0
  const dueQuality = []
  for (const item of preliminary) {
    const word = item.score.word
    const cached = existingQuality.get(word) || qualityCache.rows[word]
    if (cached && typeof cached.valid === 'boolean') {
      const decision = { ...cached, canonical_word: cached.canonical_word || word, status: 'cached', checked_at: cached.checked_at || null }
      qualityDecisions.set(word, decision); qualityRows.push({ word, ...decision }); continue
    }
    const local = judgeHotwordLocally(word)
    if (local) {
      const decision = { ...local, canonical_word: word, status: 'local', checked_at: nowIso }
      qualityCache.rows[word] = decision; qualityDecisions.set(word, decision); qualityRows.push({ word, ...decision }); continue
    }
    dueQuality.push(item)
  }
  for (const item of dueQuality.slice(0, maxQualityRequests)) {
    const word = item.score.word
    const sampleTitles = existingArticles.filter(article => String(article.title || '').includes(word)).slice(0, 5).map(article => cleanArticleTitle(article.title))
    try {
      const decision = await judgeHotwordWithLlm(word, sampleTitles, { env, fetchImpl: dependencies.llmFetchImpl || globalThis.fetch })
      llmRequestCount += decision.request_count
      judged += decision.status === 'checked' ? 1 : 0
      if (decision.status === 'checked') qualityCache.rows[word] = { ...decision, checked_at: nowIso }
      if (decision.status === 'waiting_auth') unresolved += 1
      qualityDecisions.set(word, { ...decision, checked_at: decision.status === 'checked' ? nowIso : null })
      qualityRows.push({ word, ...decision, checked_at: decision.status === 'checked' ? nowIso : null })
    } catch (error) {
      llmRequestCount += 1
      qualityErrors.push({ word, code: error.code || 'LLM_ERROR', message: error.message })
      unresolved += 1
      qualityRows.push({ word, valid: null, canonical_word: word, type: 'undetermined', confidence: 0, reason: error.message, status: 'error', checked_at: null })
    }
  }
  for (const item of dueQuality.slice(maxQualityRequests)) {
    unresolved += 1
    qualityRows.push({ word: item.score.word, valid: null, canonical_word: item.score.word, type: 'undetermined', confidence: 0, reason: '本轮 LLM 判断额度已用完', status: 'deferred', checked_at: null })
  }
  await writeJsonAtomic(qualityPath, { rows: Object.fromEntries(Object.entries(qualityCache.rows).slice(-5_000)), updated_at: nowIso })
  const qualityEligible = preliminary.map(item => ({ ...item, quality: qualityDecisions.get(item.score.word) || qualityRows.find(row => row.word === item.score.word) }))
    .filter(item => item.quality?.valid === true && Number(item.quality.confidence) >= 0.65)
    .map(item => ({ ...item, score: { ...item.score, quality_factor: Number(item.quality.confidence) || 0.8, score: Math.round(item.score.score * (Number(item.quality.confidence) || 0.8) * 100) / 100 } }))
    .filter(item => item.score.score > 0)
    .sort((left, right) => right.score.score - left.score.score || right.score.trend_score - left.score.trend_score)
  const candidates = qualityEligible.slice(0, maxHotwords)
  const budget = await readDebugApiRequestBudgetSnapshot({ file: process.env.COLLECTION_DEBUG_API_BUDGET_FILE, env, now: now instanceof Date ? now : new Date(now) })
  const maxRoundRequests = Math.min(maxTotalRequests, budget.total_remaining)
  const available = { wxrank: budget.platforms.WxRank.remaining, redfox: budget.platforms.Redfox.remaining }
  const keys = { wxrank: env.WXRANK_API_KEY, redfox: env.REDFOX_API_KEY }
  const platforms = ['wxrank', 'redfox']
  const requestPlan = []
  for (const item of candidates) {
    let perWord = 0
    for (const platform of platforms) {
      if (perWord >= maxRequestsPerHotword || requestPlan.length >= maxRoundRequests) break
      if (!keys[platform] || available[platform] <= 0) continue
      requestPlan.push({ item, platform })
      available[platform] -= 1
      perWord += 1
    }
  }
  if (requestPlan.length && client) {
    const historical = await loadHistoricalArticles(client)
    historyCount = historical.rows.length
    for (const row of historical.rows) {
      const key = String(row.article_key || canonicalizeArticle(row).article_key)
      if (!priorTitles.has(key)) priorTitles.set(key, cleanArticleTitle(row.title))
    }
  }
  const rows = []
  const requests = []
  const errors = []
  const waitingAuth = new Set()
  for (const platform of platforms) if (!keys[platform] && candidates.length && maxRoundRequests > 0 && budget.platforms[platform === 'wxrank' ? 'WxRank' : 'Redfox'].remaining > 0) waitingAuth.add(platform)
  let wxrankCount = 0
  let redfoxCount = 0
  let searchRequestCount = 0
  const searchMonth = resolveWxRankSearchMonth(dependencies.now || new Date())
  const knownKeys = new Set(priorTitles.keys())
  const ledgerKey = (date, word, platform) => `${date}\0${word}\0${platform}`
  let ledgerChanged = false
  for (const { item, platform } of requestPlan) {
    const keyword = item.quality.canonical_word || item.score.word
    const key = ledgerKey(runDate, keyword, platform)
    const previous = ledger.rows[key]
    if (previous) {
      if (previous.status === 'success') rows.push(...(previous.rows || []).map(row => ({ ...row, source_platform: platform, collect_reasons: [`rising_hotword:${keyword}`], hotword: keyword, source_steps: ['hotword-expand'] })))
      requests.push({ platform, keyword, status: previous.status, request_count: 0, cached: previous.status === 'success', error_code: previous.error_code || null, message: previous.message || null })
      continue
    }
    const earlier = Object.values(ledger.rows).filter(entry => entry.word === keyword && entry.platform === platform && entry.date < runDate).sort((a, b) => String(b.date).localeCompare(String(a.date)))
    const recent = earlier.find(entry => Math.floor((new Date(`${runDate}T00:00:00Z`) - new Date(`${entry.date}T00:00:00Z`)) / 86_400_000) <= cooldownDays)
    if (recent?.no_new_streak >= 2) { requests.push({ platform, keyword, status: 'skipped_no_new_cooldown', request_count: 0 }); continue }
    ledger.rows[key] = { date: runDate, word: keyword, platform, status: 'reserved', reserved_at: nowIso, rows: [] }
    ledgerChanged = true
    await writeJsonAtomic(ledgerPath, { rows: ledger.rows, updated_at: nowIso })
    let result
    try {
      result = platform === 'wxrank'
        ? await (dependencies.fetchWxRankKeywordArticles || fetchWxRankKeywordArticles)({ apiKey: keys.wxrank, keyword, month: searchMonth, fetchImpl: dependencies.wxrankFetchImpl || globalThis.fetch })
        : await (dependencies.fetchRedfoxKeywordArticles || fetchRedfoxKeywordArticles)({ apiKey: keys.redfox, keyword, offset: 0, sortType: '_4', exactMatch: true, fetchImpl: dependencies.redfoxFetchImpl || globalThis.fetch })
    } catch (error) { result = { status: 'failed', error_code: error.code || 'SEARCH_FAILED', message: error.message, request_count: 1, rows: [] } }
    const used = Number(result.request_count) || 0
    searchRequestCount += used
    if (platform === 'wxrank') wxrankCount += used; else redfoxCount += used
    const resultRows = result.status === 'success' ? (result.rows || []) : []
    const novelCount = resultRows.filter(row => !knownKeys.has(String(row.article_key || canonicalizeArticle(row).article_key))).length
    for (const row of resultRows) knownKeys.add(String(row.article_key || canonicalizeArticle(row).article_key))
    const priorNoNew = recent?.no_new_streak || 0
    const noNewStreak = novelCount ? 0 : priorNoNew + 1
    ledger.rows[key] = { date: runDate, word: keyword, platform, status: result.status === 'success' ? 'success' : 'failed', completed_at: nowIso, no_new_streak: noNewStreak, new_article_count: novelCount, error_code: result.error_code || null, message: result.message || null, rows: resultRows }
    await writeJsonAtomic(ledgerPath, { rows: Object.fromEntries(Object.entries(ledger.rows).slice(-10_000)), updated_at: nowIso })
    requests.push({ platform, keyword, status: result.status, error_code: result.error_code || null, request_count: used, total: result.total ?? null, has_more: result.has_more ?? null, new_article_count: novelCount, raw: result.raw ?? null })
    if (result.status === 'success') rows.push(...resultRows.map(row => ({ ...row, source_platform: platform, collect_reasons: [`rising_hotword:${keyword}`], hotword: keyword, source_steps: ['hotword-expand'] })))
    else { if (result.status === 'waiting_auth') waitingAuth.add(platform); errors.push({ platform, keyword, error_code: result.error_code || 'SEARCH_FAILED', message: result.message || `${platform} 搜索失败` }) }
  }
  const supplemental = rows.length ? mergeCanonicalArticles(rows) : { rows: [], invalid: [], duplicate_report: { duplicate_count: 0 } }
  const articleArtifact = await writeArtifact(input.workdir, input.config.output_name || 'hotword-expand-articles.json', { rows: supplemental.rows, generated_at: nowIso, selected_hotwords: candidates.map(({ score, quality }) => ({ ...score, canonical_word: quality.canonical_word, quality_type: quality.type, quality_confidence: quality.confidence })), budget: { date: budget.date, total_limit: Math.min(maxTotalRequests, budget.total_limit), used_before_round: budget.total_used, remaining_before_round: budget.total_remaining, planned_this_round: requestPlan.length, used_this_round: searchRequestCount, remaining_after_round: Math.max(0, budget.total_remaining - searchRequestCount) } })
  articleArtifact.artifact_type = 'articles'; articleArtifact.schema_version = '1'; articleArtifact.record_count = supplemental.rows.length
  const hotwordArtifact = await writeArtifact(input.workdir, 'hotword-expand-hotwords.json', { rows: existingHotwords, generated_at: nowIso })
  hotwordArtifact.artifact_type = 'hotwords'; hotwordArtifact.schema_version = '1'; hotwordArtifact.record_count = existingHotwords.length
  const linksArtifact = await writeArtifact(input.workdir, 'hotword-expand-links.json', { rows: existingLinks, generated_at: nowIso })
  linksArtifact.artifact_type = 'hotword_links'; linksArtifact.schema_version = '1'; linksArtifact.record_count = existingLinks.length
  const rawArtifact = await writeArtifact(input.workdir, 'hotword-expand-search-responses.json', { requests, generated_at: nowIso })
  rawArtifact.artifact_type = 'raw_response'; rawArtifact.schema_version = '1'; rawArtifact.record_count = requests.length
  const errorArtifact = await writeArtifact(input.workdir, 'hotword-expand-errors.json', { rows: errors, quality_errors: qualityErrors, waiting_auth_platforms: [...waitingAuth], generated_at: nowIso })
  errorArtifact.artifact_type = 'exceptions'; errorArtifact.schema_version = '1'; errorArtifact.record_count = errors.length + qualityErrors.length
  const qualityArtifact = await writeArtifact(input.workdir, 'hotword-quality-review.json', { rows: qualityRows, rejected_local: preliminary.filter(item => judgeHotwordLocally(item.score.word)?.valid === false).map(item => ({ word: item.score.word, valid: false, type: 'noise', reason: '本地垃圾词规则已过滤' })), generated_at: nowIso })
  qualityArtifact.artifact_type = 'debug_report'; qualityArtifact.schema_version = '1'; qualityArtifact.record_count = qualityRows.length
  const failed = errors.length > 0 || qualityErrors.length > 0
  const output = [articleArtifact, hotwordArtifact, linksArtifact]
  const requestCount = searchRequestCount + llmRequestCount
  const generatedAt = new Date().toISOString()
  if (ledgerChanged && Object.keys(ledger.rows).length > 10_000) ledger.rows = Object.fromEntries(Object.entries(ledger.rows).slice(-10_000))
  const apiFailure = failed || waitingAuth.size > 0
  return { status: waitingAuth.size && !requestCount ? 'waiting_auth' : apiFailure ? 'partial' : 'success', input_count: preliminary.length, output_count: supplemental.rows.length, created_count: null, updated_count: null, filtered_count: supplemental.duplicate_report.duplicate_count + supplemental.invalid.length, request_count: requestCount, duration_ms: Date.now() - started, artifact: output, debug_artifacts: [rawArtifact, errorArtifact, qualityArtifact].map(item => ({ ...item, kind: 'debug', default_visible: false })), error_code: waitingAuth.size && !requestCount ? 'AUTH_ERROR' : failed ? (errors[0]?.error_code || qualityErrors[0]?.code) : undefined, message: waitingAuth.size && !requestCount ? `热词趋势与质量已计算，但缺少平台认证：${[...waitingAuth].join('、')}` : failed ? '热词补采有失败；请查看隐藏的请求诊断，后续步骤仍会处理已取得文章' : '趋势、质量、本轮 API 预算筛选及热词补采完成；文章将返回统一过滤和热词重算', business_summary: { hotwords_considered: preliminary.length, locally_rejected: preliminary.filter(item => judgeHotwordLocally(item.score.word)?.valid === false).length, llm_quality_checked: judged, llm_quality_unresolved: unresolved, llm_quality_errors: qualityErrors.length, trend_quality_eligible: qualityEligible.length, selected_hotwords: candidates.map(item => ({ word: item.score.word, canonical_word: item.quality.canonical_word, trend: item.score.trend_state, trend_score: item.score.trend_score, quality: item.quality.confidence, sample_gap: item.score.sample_gap, priority_score: item.score.score })), budget: { date: budget.date, timezone: budget.timezone, total_limit: budget.total_limit, used_before_round: budget.total_used, remaining_before_round: budget.total_remaining, planned_this_round: requestPlan.length, used_this_round: searchRequestCount, remaining_after_round: Math.max(0, budget.total_remaining - searchRequestCount), wxrank: budget.platforms.WxRank, redfox: budget.platforms.Redfox }, wxrank_requests: wxrankCount, redfox_requests: redfoxCount, waiting_auth_platforms: [...waitingAuth], api_errors: errors.length, new_articles_detected: Object.values(ledger.rows).filter(row => row.date === runDate && row.new_article_count > 0).reduce((sum, row) => sum + row.new_article_count, 0), historical_articles_read_for_dedup: historyCount, supplemental_articles_raw: rows.length, articles_raw: rows.length, articles_unique: supplemental.rows.length, duplicate_articles: supplemental.duplicate_report.duplicate_count, data_gap_target_articles: targetSamples, no_new_cooldown_days: cooldownDays, next_step: '合并补采文章，重复执行确定性过滤和 LLM 审核，随后重算并持久化热词' } }
}

if (import.meta.main) runCollectorMain(collect)

export { collect, collectDualPlatform }
