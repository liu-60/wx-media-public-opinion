import { aggregateHotwordsWithDiagnostics, DEFAULT_CANONICAL_HOTWORD_RULES, normalizeCanonicalHotwordRules } from '../../src/hotwords.mjs'
import { runCollectorMain, writeArtifact } from '../../src/runner/script-runtime.mjs'
import { loadHotwordFilterRules } from './hotword-filter-rules.mjs'

const DEFAULT_CATEGORY_URL = 'https://tophub.today/c/news'
const DEFAULT_WECHAT_NODE_URL = 'https://tophub.today/n/WnBe01o371'
const DEFAULT_ARTIFACT_ID = 'tophub-hotwords.json'
const DEFAULT_MAX_HOTWORDS = 5
const DEFAULT_MIN_PLATFORM_COUNT = 2
const DEFAULT_MERGE_CONSISTENCY_THRESHOLD = 0.8
const DEFAULT_MERGE_MIN_ARTICLE_COUNT = 3
const DEFAULT_TITLE_OVERLAP_THRESHOLD = 0.8
const DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' })

function collectorError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim()
}

function decodeHtml(value) {
  return String(value || '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (entity, code) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
    if (code[0] !== '#') return named[code.toLowerCase()] ?? entity
    const hex = code[1]?.toLowerCase() === 'x'
    const point = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10)
    try { return Number.isFinite(point) ? String.fromCodePoint(point) : entity } catch { return entity }
  })
}

function plainText(value) {
  return decodeHtml(String(value || '')
    .replace(/<br\s*\/?>/giu, ' ')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/<!--[\s\S]*?-->/gu, ' '))
    .replace(/\s+/gu, ' ')
    .trim()
}

function attributes(markup) {
  const result = {}
  for (const match of String(markup || '').matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gu)) {
    result[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '')
  }
  return result
}

function classText(markup, tagName, className) {
  const pattern = new RegExp(`<${tagName}\\b[^>]*\\bclass=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'iu')
  const match = String(markup || '').match(pattern)
  return match ? plainText(match[1]) : ''
}

function normalizedPlatform(value) {
  return text(value).normalize('NFKC').toLocaleLowerCase().replace(/[\s·•‧_-]+/gu, '')
}

function parseCategoryPage(html, pageUrl) {
  const markers = [...String(html || '').matchAll(/<div\b[^>]*\bclass=["'][^"']*\bcc-cd\b[^"']*["'][^>]*\bid=["']node-[^"']+["'][^>]*>/giu)]
  const rows = []
  const platforms = []
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index]
    const block = String(html).slice(marker.index, markers[index + 1]?.index ?? String(html).length)
    const nodeId = marker[0].match(/\bid=["']node-([^"']+)["']/iu)?.[1] || ''
    const headerEnd = block.indexOf('<div class="cc-cd-cb')
    const header = headerEnd >= 0 ? block.slice(0, headerEnd) : block
    const platform = classText(header, 'div', 'cc-cd-lb')
    if (!platform) continue
    platforms.push({ platform, node_id: nodeId })

    for (const anchor of block.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/giu)) {
      const attrs = attributes(anchor[1])
      const inside = anchor[2]
      if (!attrs.itemid || !inside.includes('cc-cd-cb-ll')) continue
      const title = classText(inside, 'span', 't')
      if (!title) continue
      const rankText = classText(inside, 'span', 's')
      const parsedRank = Number.parseInt(rankText, 10)
      rows.push({
        title,
        platform,
        source_id: attrs.itemid,
        url: attrs.href || '',
        rank: Number.isSafeInteger(parsedRank) && parsedRank > 0 ? parsedRank : null,
        stat_value_raw: classText(inside, 'span', 'e') || null,
        source_page: pageUrl,
        node_id: nodeId,
      })
    }
  }
  if (!platforms.length || !rows.length) throw collectorError('OUTPUT_SCHEMA_INVALID', 'TopHub新闻分类页没有识别到平台榜单数据')
  return { rows, platforms }
}

function parseWechatNodePage(html, pageUrl, platform = '微信') {
  const rows = []
  for (const match of String(html || '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)) {
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/giu)].map(cell => cell[1])
    if (cells.length < 3) continue
    const titleCell = cells.find(cell => /<a\b[^>]*\bitemid=/iu.test(cell))
    if (!titleCell) continue
    const anchor = titleCell.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/iu)
    if (!anchor) continue
    const attrs = attributes(anchor[1])
    const title = plainText(anchor[2])
    if (!attrs.itemid || !title) continue
    const rankText = plainText(cells[0]).replace(/\D+/gu, '')
    const parsedRank = Number.parseInt(rankText, 10)
    rows.push({
      title,
      platform,
      source_id: attrs.itemid,
      url: attrs.href || '',
      rank: Number.isSafeInteger(parsedRank) && parsedRank > 0 ? parsedRank : null,
      stat_value_raw: plainText(cells[2]) || null,
      source_page: pageUrl,
      node_id: 'WnBe01o371',
    })
  }
  if (!rows.length) throw collectorError('OUTPUT_SCHEMA_INVALID', 'TopHub微信24h热文榜没有识别到文章标题')
  return rows
}

function deduplicatePlatformItems(rows, { titleOverlapThreshold = DEFAULT_TITLE_OVERLAP_THRESHOLD } = {}) {
  const threshold = Number(titleOverlapThreshold)
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw collectorError('INVALID_CONFIG', 'title_overlap_threshold必须是0到1之间的小数')

  const groups = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const platformKey = normalizedPlatform(row.platform)
    const title = normalizeTitleForOverlap(row.title)
    const group = groups.find(candidate => {
      if (candidate.platformKeys.has(platformKey)) return false
      return candidate.rows.some(item => titleOverlapRatio(title, item.normalizedTitle) >= threshold)
    })
    if (group) {
      group.rows.push({ ...row, normalizedTitle: title })
      group.platformKeys.add(platformKey)
      group.platformNames.set(platformKey, text(row.platform))
      const overlap = Math.max(...group.rows
        .slice(0, -1)
        .map(item => titleOverlapRatio(title, item.normalizedTitle)))
      group.titleOverlap = group.titleOverlap === null ? overlap : Math.min(group.titleOverlap, overlap)
      continue
    }
    groups.push({
      rows: [{ ...row, normalizedTitle: title }],
      platformKeys: new Set([platformKey]),
      platformNames: new Map([[platformKey, text(row.platform)]]),
      titleOverlap: null,
    })
  }

  return groups.map((group, index) => {
    const representative = group.rows[0]
    const sourcePlatformKeys = [...group.platformKeys]
    const sourcePlatforms = [...group.platformNames.values()]
    const sourceRefs = group.rows.map(item => ({
      platform: item.platform,
      platform_key: normalizedPlatform(item.platform),
      source_id: item.source_id || null,
      url: item.url || null,
      title: item.title,
      rank: item.rank ?? null,
      source_page: item.source_page || null,
      node_id: item.node_id || null,
    }))
    const { normalizedTitle: _normalizedTitle, ...base } = representative
    return {
      ...base,
      article_id: `tophub-title-group:${index + 1}`,
      source_platform_keys: sourcePlatformKeys,
      source_platforms: sourcePlatforms,
      source_refs: sourceRefs,
      title_overlap: Math.round((group.titleOverlap ?? 1) * 1000) / 1000,
      duplicate_count: Math.max(0, group.rows.length - 1),
    }
  })
}

function normalizeTitleForOverlap(value) {
  return [...text(value)
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')]
}

function titleOverlapRatio(left, right) {
  const leftChars = Array.isArray(left) ? left : normalizeTitleForOverlap(left)
  const rightChars = Array.isArray(right) ? right : normalizeTitleForOverlap(right)
  if (!leftChars.length || !rightChars.length) return 0
  const counts = new Map()
  for (const char of leftChars) counts.set(char, (counts.get(char) || 0) + 1)
  let intersection = 0
  for (const char of rightChars) {
    const count = counts.get(char) || 0
    if (count > 0) {
      intersection += 1
      counts.set(char, count - 1)
    }
  }
  return intersection / Math.max(leftChars.length, rightChars.length)
}

function dateKey(value) {
  const raw = text(value).replaceAll('-', '').slice(0, 8)
  if (/^20\d{6}$/u.test(raw)) return raw
  return DATE_FORMATTER.format(new Date()).replaceAll('-', '')
}

function countDistinct(values) {
  return new Set(values.filter(Boolean)).size
}

function compareHotwordRows(left, right) {
  return right.article_count - left.article_count
    || right.platform_count - left.platform_count
    || right.match_score - left.match_score
    || left.hotword.localeCompare(right.hotword, 'zh-CN')
}

function canonicalRules(value) {
  try {
    return normalizeCanonicalHotwordRules(value === undefined ? DEFAULT_CANONICAL_HOTWORD_RULES : value)
  } catch (error) {
    throw collectorError('INVALID_CONFIG', error?.message || 'canonical_hotwords配置无效')
  }
}

function buildCrossPlatformHotwords(items, {
  statDate,
  minPlatformCount,
  maxHotwords,
  filterRules = [],
  canonicalRules: configuredCanonicalRules = DEFAULT_CANONICAL_HOTWORD_RULES,
  maxChineseGram = 4,
  mergeConsistencyThreshold = DEFAULT_MERGE_CONSISTENCY_THRESHOLD,
  mergeMinArticleCount = DEFAULT_MERGE_MIN_ARTICLE_COUNT,
}) {
  const articleInputs = items.map(item => ({
    article_id: item.article_id,
    title: item.title,
    content: '',
    account_ids: item.source_platform_keys?.length ? item.source_platform_keys : [normalizedPlatform(item.platform)],
    article_url: item.url,
    read_num: 0,
  }))
  const diagnostics = aggregateHotwordsWithDiagnostics(articleInputs, { statDate, minArticleCount: 1, filterRules, canonicalRules: configuredCanonicalRules, maxChineseGram, mergeConsistencyThreshold, mergeMinArticleCount })
  const aggregated = diagnostics.rows
  const itemById = new Map(items.map(item => [item.article_id, item]))
  const matched = aggregated
    .filter(row => row.account_count >= minPlatformCount)
    .map(row => {
      const evidence = row.article_ids.map(id => itemById.get(id)).filter(Boolean)
      const occurrences = new Map()
      const platformNames = new Map()
      for (const item of evidence) {
        const platformKeys = item.source_platform_keys?.length ? item.source_platform_keys : [normalizedPlatform(item.platform)]
        const platformLabels = item.source_platforms?.length ? item.source_platforms : [item.platform]
        platformKeys.forEach((platformKey, index) => {
          occurrences.set(platformKey, (occurrences.get(platformKey) || 0) + 1)
          if (!platformNames.has(platformKey)) platformNames.set(platformKey, platformLabels[index] || item.platform)
        })
      }
      return {
        hotword: row.word,
        token_type: row.token_type,
        gram: row.gram,
        stat_date: row.stat_date,
        article_count: row.article_count,
        platform_count: row.account_count,
         match_score: row.score,
         weighted_count: row.weighted_count,
         canonical_word: row.canonical_word || row.word,
         aliases: row.aliases || [],
         matched_terms: row.matched_terms || { [row.word]: row.article_count },
         merged_from: row.merged_from || [],
        merge_consistency: row.merge_consistency ?? null,
        platforms: [...platformNames.entries()]
          .map(([key, platform]) => ({ platform, match_count: occurrences.get(key) }))
          .sort((left, right) => right.match_count - left.match_count || left.platform.localeCompare(right.platform, 'zh-CN')),
      }
    })
    .sort(compareHotwordRows)
  return {
    candidates: diagnostics.candidate_count,
    merged_count: diagnostics.merged_count,
    merge_group_count: diagnostics.merge_group_count,
    merge_consistency_threshold: diagnostics.merge_consistency_threshold,
    merge_min_article_count: diagnostics.merge_min_article_count,
    canonical_rule_count: diagnostics.canonical_rule_count,
    canonical_candidate_count: diagnostics.canonical_candidate_count,
    canonical_merge_count: diagnostics.canonical_merge_count,
    canonical_group_count: diagnostics.canonical_group_count,
    canonical_rule_hit_counts: diagnostics.canonical_rule_hit_counts,
    filtered_by_rules: diagnostics.filtered_count,
    rule_hit_counts: diagnostics.rule_hit_counts,
    matches: matched.length,
    rows: matched.slice(0, maxHotwords),
  }
}

function positiveInteger(value, fallback, name, maximum, minimum = 1) {
  const parsed = value === undefined || value === null || value === '' ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw collectorError('INVALID_CONFIG', `${name}必须是${minimum}到${maximum}之间的整数`)
  return parsed
}

function ratio(value, fallback, name) {
  const parsed = value === undefined || value === null || value === '' ? fallback : Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw collectorError('INVALID_CONFIG', `${name}必须是0到1之间的小数`)
  return parsed
}

async function fetchPage(fetchImpl, url) {
  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'Mozilla/5.0 (compatible; TopHubHotwordCollector/1.0)' },
    })
  } catch {
    throw collectorError('UPSTREAM_UNAVAILABLE', `TopHub页面请求失败：${url}`)
  }
  if (!response?.ok) {
    const status = Number(response?.status)
    const code = status === 401 || status === 403 ? 'AUTH_ERROR' : status === 429 ? 'RATE_LIMIT' : 'API_BUSINESS_ERROR'
    throw collectorError(code, `TopHub页面返回HTTP ${Number.isFinite(status) ? status : 'error'}：${url}`)
  }
  try { return await response.text() } catch { throw collectorError('OUTPUT_SCHEMA_INVALID', `TopHub页面内容无法读取：${url}`) }
}

async function collect(input, dependencies = {}) {
  const started = Date.now()
  const config = input?.config || {}
  let requestCount = 0
  let ruleRequestCount = 0
  try {
    const categoryUrl = text(config.category_url) || DEFAULT_CATEGORY_URL
    const wechatNodeUrl = text(config.wechat_node_url) || DEFAULT_WECHAT_NODE_URL
    const maxHotwords = positiveInteger(config.max_hotwords, DEFAULT_MAX_HOTWORDS, 'max_hotwords', 100)
    const minPlatformCount = positiveInteger(config.min_platform_count, DEFAULT_MIN_PLATFORM_COUNT, 'min_platform_count', 50, 2)
    const mergeConsistencyThreshold = ratio(config.merge_consistency_threshold, DEFAULT_MERGE_CONSISTENCY_THRESHOLD, 'merge_consistency_threshold')
    const mergeMinArticleCount = positiveInteger(config.merge_min_article_count, DEFAULT_MERGE_MIN_ARTICLE_COUNT, 'merge_min_article_count', 100)
    const titleOverlapThreshold = ratio(config.title_overlap_threshold, DEFAULT_TITLE_OVERLAP_THRESHOLD, 'title_overlap_threshold')
    const configuredCanonicalRules = canonicalRules(config.canonical_hotwords)
    const loadedRules = await (dependencies.loadHotwordFilterRules || (() => loadHotwordFilterRules({
      client: dependencies.supabaseClient,
      env: dependencies.env,
      fetchImpl: dependencies.supabaseFetchImpl
    })))()
    ruleRequestCount = loadedRules.request_count
    requestCount = ruleRequestCount
    let categoryParsed
    let wechatRows
    const fetchImpl = dependencies.fetchImpl || globalThis.fetch
    if (typeof fetchImpl !== 'function') throw collectorError('CAPABILITY_UNAVAILABLE', '当前Node运行时没有可用的fetch')
    requestCount += 2
    const [categoryHtml, wechatHtml] = await Promise.all([
      fetchPage(fetchImpl, categoryUrl),
      fetchPage(fetchImpl, wechatNodeUrl),
    ])
    categoryParsed = parseCategoryPage(categoryHtml, categoryUrl)
    wechatRows = parseWechatNodePage(wechatHtml, wechatNodeUrl, text(config.wechat_platform) || '微信')
    const items = deduplicatePlatformItems([...categoryParsed.rows, ...wechatRows], { titleOverlapThreshold })
    const crossPlatformTitleGroupCount = items.filter(item => item.source_platform_keys?.length > 1).length
    const samePlatformItemCount = items.filter(item => item.source_platform_keys?.length === 1).length
    const statDate = dateKey(config.stat_date)
    const aggregated = buildCrossPlatformHotwords(items, { statDate, minPlatformCount, maxHotwords, filterRules: loadedRules.rules, canonicalRules: configuredCanonicalRules, mergeConsistencyThreshold, mergeMinArticleCount })
    const sourceCounts = new Map()
    for (const item of items) sourceCounts.set(item.platform, (sourceCounts.get(item.platform) || 0) + 1)
    const stats = {
      request_count: requestCount,
      source_request_count: 2,
      filter_rule_request_count: ruleRequestCount,
      page_count: 2,
      category_platform_count: categoryParsed.platforms.length,
      platform_count: sourceCounts.size,
      platform_counts: Object.fromEntries(sourceCounts),
      raw_item_count: categoryParsed.rows.length + wechatRows.length,
      unique_item_count: items.length,
      duplicate_item_count: categoryParsed.rows.length + wechatRows.length - items.length,
      cross_platform_title_dedup_group_count: crossPlatformTitleGroupCount,
      same_platform_item_count: samePlatformItemCount,
      candidate_hotword_count: aggregated.candidates,
      filtered_by_rule_count: aggregated.filtered_by_rules,
      filter_rule_hit_counts: aggregated.rule_hit_counts,
      merged_hotword_count: aggregated.merged_count,
      merge_group_count: aggregated.merge_group_count,
      merge_consistency_threshold: aggregated.merge_consistency_threshold,
      merge_min_article_count: aggregated.merge_min_article_count,
      canonical_rule_count: aggregated.canonical_rule_count,
      canonical_candidate_count: aggregated.canonical_candidate_count,
      canonical_merge_count: aggregated.canonical_merge_count,
      canonical_group_count: aggregated.canonical_group_count,
      canonical_rule_hit_counts: aggregated.canonical_rule_hit_counts,
      title_overlap_threshold: titleOverlapThreshold,
      cross_platform_hotword_count: aggregated.matches,
      output_hotword_count: aggregated.rows.length,
      min_platform_count: minPlatformCount,
      max_hotwords: maxHotwords,
    }
    const artifactId = text(config.output_name) || DEFAULT_ARTIFACT_ID
    const artifact = await writeArtifact(input.workdir, artifactId, {
      source: 'tophub',
      stat_date: statDate,
      generated_at: new Date().toISOString(),
      criteria: { min_platform_count: minPlatformCount, max_hotwords: maxHotwords, merge_consistency_threshold: mergeConsistencyThreshold, merge_min_article_count: mergeMinArticleCount, title_overlap_threshold: titleOverlapThreshold, canonical_hotwords: configuredCanonicalRules, active_filter_rule_count: loadedRules.rules.length },
      pages: [categoryUrl, wechatNodeUrl],
      rows: aggregated.rows,
      stats,
    })
    Object.assign(artifact, { artifact_type: 'hotwords', schema_version: '1', record_count: aggregated.rows.length })
    return {
      status: 'success',
      input_count: categoryParsed.rows.length + wechatRows.length,
      output_count: aggregated.rows.length,
      created_count: aggregated.rows.length,
      updated_count: 0,
      filtered_count: aggregated.filtered_by_rules,
      request_count: requestCount,
      duration_ms: Date.now() - started,
      artifact,
      message: 'TopHub跨平台热词匹配完成',
      business_summary: { stat_date: statDate, ...stats, hotwords: aggregated.rows.map(row => ({ hotword: row.hotword, canonical_word: row.canonical_word, aliases: row.aliases, matched_terms: row.matched_terms, article_count: row.article_count, platform_count: row.platform_count })) },
    }
  } catch (error) {
    requestCount = Math.max(requestCount, Number(error?.request_count) || 0)
    return {
      status: 'failed',
      input_count: null,
      output_count: null,
      created_count: null,
      updated_count: null,
      filtered_count: null,
      request_count: requestCount,
      duration_ms: Date.now() - started,
      artifact: null,
      error_code: error?.code || 'COLLECTOR_ERROR',
      message: error?.message || 'TopHub采集失败',
    }
  }
}

if (import.meta.main) runCollectorMain(collect)

export { collect, parseCategoryPage, parseWechatNodePage, deduplicatePlatformItems, buildCrossPlatformHotwords }
