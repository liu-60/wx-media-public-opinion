import { fetchRankedArticleSources } from '../../src/wxrank-client.mjs'
import { articleIdentity } from '../../src/article-filter.mjs'
import { runCollectorMain, writeArtifact } from '../../src/runner/script-runtime.mjs'
import { loadCollectorEnvironment } from '../../src/collector-config.mjs'
import { createSupabaseClient } from '../../management-center/services/supabase.mjs'
import { accountRowsFromArticles, runArticleFilterStage } from './article-filter-common.mjs'

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim()
}

function first(row, ...keys) {
  for (const key of keys) if (row?.[key] !== undefined && row?.[key] !== null && text(row[key])) return row[key]
  return ''
}

function normalizeRankedArticle(row, source) {
  const url = text(first(row, 'article_url', 'articleUrl', 'art_url', 'url', 'link'))
  let fromUrl = {}
  try {
    const parsed = new URL(url)
    fromUrl = { wx_biz: parsed.searchParams.get('__biz') || '', article_sn: parsed.searchParams.get('sn') || '' }
  } catch {}
  const readValue = first(row, 'read_num', 'readNum', 'read_count', 'read')
  const readCapped = typeof readValue === 'string' && /(?:\d+(?:\.\d+)?w\+|\d+(?:\.\d+)?万\+|100000\+)/iu.test(readValue)
  const articleSn = text(first(row, 'article_sn', 'articleSn', 'sn')) || fromUrl.article_sn
  const articleId = text(first(row, 'article_id', 'articleId', 'art_id')) || articleSn || text(first(row, 'id'))
  const wxName = text(first(row, 'wx_name', 'wxName', 'account_name', 'accountName', 'public_name', 'nickname', 'publisher'))
  return {
    ...row,
    ...(articleId ? { article_id: articleId } : {}),
    article_sn: articleSn || null,
    wx_biz: text(first(row, 'wx_biz', 'wxBiz', '__biz', 'biz')) || fromUrl.wx_biz || null,
    wx_name: wxName,
    title: text(first(row, 'title', 'article_title', 'art_title', 'name')),
    article_url: url || null,
    publish_time: first(row, 'publish_time', 'publishTime', 'pub_time', 'publish_date', 'published_at', 'created_at', 'date') || null,
    read_num: readCapped ? 100001 : readValue,
    read_num_capped: readCapped,
    like_num: first(row, 'like_num', 'likeNum', 'like_count', 'like'),
    look_num: first(row, 'look_num', 'lookNum', 'look_count', 'look'),
    share_num: first(row, 'share_num', 'shareNum', 'share_count', 'share'),
    comment_num: first(row, 'comment_num', 'commentNum', 'comment_count', 'comment'),
    publisher: text(first(row, 'publisher', 'wx_name', 'wxName', 'account_name', 'accountName', 'nickname')),
    source_platform: 'wxrank',
    collect_reasons: [source],
    raw: row
  }
}

function deduplicateArticles(rows) {
  const unique = new Map()
  for (const row of rows) {
    const key = row.wx_biz && row.article_sn ? `${row.wx_biz}\0${row.article_sn}` : `${row.wx_biz || ''}\0${articleIdentity(row).articleId}`
    const existing = unique.get(key)
    if (!existing) { unique.set(key, row); continue }
    for (const [field, value] of Object.entries(row)) {
      if ((existing[field] === undefined || existing[field] === null || existing[field] === '') && value !== undefined && value !== null && value !== '') existing[field] = value
    }
    existing.collect_reasons = [...new Set([...(existing.collect_reasons || []), ...(row.collect_reasons || [])])]
  }
  return { rows: [...unique.values()], duplicate_count: rows.length - unique.size }
}

function articleDisplay(rows, names) {
  const displayRows = rows.map(row => ({
    title: text(row.title),
    pub_time: row.publish_time ?? row.published_at ?? null,
    wx_name: text(row.wx_name || names.get(row.wx_biz) || row.publisher) || null,
    read_num: row.read_num ?? null,
    like_num: row.like_num ?? null,
    article_url: row.article_url ?? row.articleUrl ?? row.url ?? null
  }))
  const count = value => {
    const normalized = text(value).replace(/,/gu, '')
    const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(万|w)?\+?$/iu)
    if (!match) return 0
    return Number(match[1]) * (match[2] ? 10_000 : 1)
  }
  return displayRows.sort((left, right) => count(right.like_num) - count(left.like_num))
}

function chunks(rows, size = 200) {
  const parts = []
  for (let index = 0; index < rows.length; index += size) parts.push(rows.slice(index, index + size))
  return parts
}

async function loadExistingAccounts(accounts) {
  const wxBizes = [...new Set(accounts.map(row => row.wx_biz).filter(Boolean))]
  if (!wxBizes.length) return new Map()
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    const error = new Error('Supabase credentials are required to check existing WxRank accounts')
    error.code = 'AUTH_REQUIRED'
    throw error
  }
  const client = createSupabaseClient({ url, key })
  const rows = []
  for (const part of chunks(wxBizes)) {
    const result = await client.list('accounts', {
      columns: ['wx_biz', 'wx_name', 'updated_at'],
      filters: [{ column: 'wx_biz', operator: 'in', value: part }],
      limit: 5000
    })
    rows.push(...(Array.isArray(result.data) ? result.data : []))
  }
  return new Map(rows.map(row => [row.wx_biz, row]))
}

function accountStatus(accounts, existingByBiz, report) {
  const accountFiltered = new Set((report.articles?.decisions || [])
    .filter(row => ['ACCOUNT_FILTERED', 'ACCOUNT_UNDECIDED', 'ACCOUNT_UNMATCHED'].includes(row.status))
    .map(row => row.wx_biz))
  return accounts.map(({ wx_biz, account }) => {
    const existing = existingByBiz.get(wx_biz)
    const filtered = accountFiltered.has(wx_biz)
    return {
      wx_name: existing?.wx_name || account.wx_name || null,
      wx_biz,
      updated_at: existing?.updated_at || account.updated_at || null,
      exists_in_database: Boolean(existing),
      planned_action: existing ? 'skip_existing' : filtered ? 'skip_account_filter' : 'insert',
      fields: existing || filtered ? {} : account
    }
  })
}

function updatePlan(writeSet, accountRows) {
  const names = new Map(accountRows.map(({ wx_biz, wx_name }) => [wx_biz, wx_name]))
  const accountsByBiz = new Map(writeSet.accounts.map(row => [row.wx_biz, row]))
  const without = (value, ...keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
  return {
    conflict_keys: {
      accounts: 'wx_biz',
      account_profiles: 'account_id（按 wx_biz 关联）',
      articles: 'account_id,article_sn（account_id 按 wx_biz 关联）',
      hotwords: 'hotword,stat_date'
    },
    note: '数据库已有账号跳过账号和画像更新；新增账号插入。未提供的账号和画像字段沿用现值，文章 account_id 在发布阶段按 wx_biz 解析。',
    accounts: accountRows,
    account_profiles: writeSet.accounts.map(({ wx_biz, profile }) => ({ wx_name: names.get(wx_biz), wx_biz, fields: without(profile, 'wx_biz') })),
    articles: writeSet.articles.map(article => ({ wx_name: names.get(article.wx_biz), title: article.title, article_sn: article.article_sn, wx_biz: article.wx_biz, fields: without(article, 'wx_biz', 'account_id') })),
    hotwords: writeSet.hotwords.map(row => ({ hotword: row.hotword, stat_date: row.stat_date, fields: row }))
  }
}

async function collect(input) {
  const started = Date.now()
  const env = loadCollectorEnvironment()
  const headers = Object.fromEntries([
    ['authorization', env.WXRANK_AUTHORIZATION],
    ['cookie', env.WXRANK_COOKIE]
  ].filter(([, value]) => value))
  const range = text(input.config.range) || '7d'
  const page = Number(input.config.page ?? 1)
  const source = await fetchRankedArticleSources({ baseUrl: input.config.base_url || env.WXRANK_ACCOUNT_API_URL, range, page, headers })

  if (source.status === 'failed') return {
    status: 'failed', input_count: null, output_count: 0, created_count: null, updated_count: null, filtered_count: null,
    request_count: source.request_count, duration_ms: Date.now() - started, artifact: null,
    error_code: source.errors[0]?.code || 'SOURCE_UNAVAILABLE',
    message: 'WxRank article ranking endpoints returned no usable article lists',
    business_summary: { range, page, source_errors: source.errors }
  }

  const generatedAt = new Date().toISOString()
  const rawArticleRows = source.rows.map(row => normalizeRankedArticle(row, row.rank_source || 'article'))
  const deduplicated = deduplicateArticles(rawArticleRows)
  const articleRows = deduplicated.rows
  const accountRows = accountRowsFromArticles(articleRows, { source: 'wxrank' })
  let stage
  try {
    stage = await runArticleFilterStage({
      input, accountRows, articleRows, source: 'wxrank',
      databaseName: 'wxrank-article-filter.sqlite', now: generatedAt
    })
  } catch (error) {
    error.request_count = source.request_count + (Number(error.request_count) || 0)
    throw error
  }

  let existingByBiz
  try {
    existingByBiz = await loadExistingAccounts(stage.writeSet.accounts)
  } catch (error) {
    error.request_count = source.request_count + stage.filter_rule_request_count + (Number(error.request_count) || 0)
    throw error
  }
  const accountRowsForDisplay = accountStatus(stage.writeSet.accounts, existingByBiz, stage.report)
  const allowedAccountBizes = new Set(accountRowsForDisplay.filter(row => row.planned_action === 'insert').map(row => row.wx_biz))
  const accountsToInsert = stage.writeSet.accounts.filter(row => allowedAccountBizes.has(row.wx_biz))
  const plannedSet = { ...stage.writeSet, accounts: accountsToInsert, account_insert_only: true }
  const writeSet = { ...plannedSet, planned_updates: updatePlan(plannedSet, accountRowsForDisplay) }
  const names = new Map(accountRows.map(row => [row.wx_biz, row.wx_name || null]))
  const articleCount = stage.filteredArticles.length
  const filteredCount = articleRows.length - articleCount
  const [writeArtifactResult, filteredArtifactResult, articlesArtifactResult] = await Promise.all([
    writeArtifact(input.workdir, 'wxrank-article-write-set.json', writeSet),
    writeArtifact(input.workdir, 'wxrank-filtered-articles.json', { source: 'wxrank', range, page, duplicate_count: deduplicated.duplicate_count, rows: articleDisplay(stage.filteredArticles, names), generated_at: generatedAt }),
    writeArtifact(input.workdir, 'wxrank-articles.json', { source: 'wxrank', range, page, duplicate_count: deduplicated.duplicate_count, rows: articleDisplay(stage.articles, names), generated_at: generatedAt })
  ])
  const artifacts = [
    Object.assign(writeArtifactResult, {
    artifact_type: 'write_set',
    schema_version: '1',
    record_count: (accountsToInsert.length || 0) + (stage.writeSet.articles?.length || 0) + (stage.writeSet.hotwords?.length || 0)
    }),
    Object.assign(filteredArtifactResult, { artifact_type: 'filtered_articles', schema_version: '1', record_count: articleCount }),
    Object.assign(articlesArtifactResult, { artifact_type: 'articles', schema_version: '1', record_count: articleRows.length })
  ]

  return {
    status: source.status === 'partial' ? 'partial' : 'success',
    input_count: rawArticleRows.length,
    output_count: articleCount,
    created_count: null,
    updated_count: null,
    filtered_count: filteredCount,
    request_count: source.request_count + stage.filter_rule_request_count + Math.ceil(stage.writeSet.accounts.length / 200),
    duration_ms: Date.now() - started,
    artifact: artifacts,
    ...(source.errors.length ? { error_code: source.errors[0].code } : {}),
    message: source.errors.length ? 'WxRank article collection completed with source errors' : 'WxRank article collection and shared filtering completed',
    business_summary: {
      range,
      page,
      source_rows: Object.fromEntries(source.sources.map(result => [result.source, result.rows.length])),
      source_errors: source.errors,
      fetched_articles: rawArticleRows.length,
      unique_articles: articleRows.length,
      duplicate_articles: deduplicated.duplicate_count,
      discovered_accounts: accountRows.length,
      existing_accounts: accountRowsForDisplay.filter(row => row.exists_in_database).length,
      planned_account_inserts: accountsToInsert.length,
      skipped_existing_accounts: accountRowsForDisplay.filter(row => row.planned_action === 'skip_existing').length,
      skipped_by_account_filter: accountRowsForDisplay.filter(row => row.planned_action === 'skip_account_filter').length,
      selected_articles: articleCount,
      filtered_articles: filteredCount,
      planned_account_updates: 0,
      planned_article_updates: stage.writeSet.articles.length,
      planned_hotword_updates: stage.writeSet.hotwords.length,
      filter_rules: stage.report.filterRules
    }
  }
}

if (import.meta.main) runCollectorMain(collect)

export { collect, normalizeRankedArticle }
