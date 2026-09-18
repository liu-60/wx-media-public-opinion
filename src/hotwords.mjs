import { nowIso } from './db.mjs'

const HAN_RUN = /[\p{Script=Han}]+/gu
const ENGLISH_WORD = /[A-Za-z][A-Za-z0-9]*/gu
const DEFAULT_STOP_WORDS = Object.freeze(['我们', '你们', '他们', '这个', '那个', '什么', '如何', '一个', '可以', '以及', '因为', '已经'])

function text(value) {
  if (value === undefined || value === null) return ''
  return String(value)
}

function canonicalStatDate(value) {
  const raw = text(value).replaceAll('-', '').slice(0, 8)
  if (/^20\d{6}$/u.test(raw)) return raw
  return new Date().toISOString().slice(0, 10).replaceAll('-', '')
}

function numeric(value) {
  if (value === undefined || value === null || value === '') return 0
  const parsed = Number(String(value).replaceAll(',', ''))
  return Number.isFinite(parsed) ? parsed : 0
}

export function tokenizeHotwords(value, {
  minChineseGram = 2,
  maxChineseGram = 4,
  stopWords = DEFAULT_STOP_WORDS
} = {}) {
  const source = text(value)
  const stop = new Set(stopWords.map(item => text(item).trim()).filter(Boolean))
  const tokens = []
  for (const match of source.matchAll(HAN_RUN)) {
    const segment = match[0]
    for (let gram = minChineseGram; gram <= maxChineseGram; gram += 1) {
      if (gram > segment.length) continue
      for (let start = 0; start + gram <= segment.length; start += 1) {
        const word = segment.slice(start, start + gram)
        if (!stop.has(word)) tokens.push({ word, tokenType: 'zh', gram })
      }
    }
  }
  for (const match of source.matchAll(ENGLISH_WORD)) {
    const word = match[0].toLowerCase()
    if (!stop.has(word)) tokens.push({ word, tokenType: 'en', gram: 1 })
  }
  return tokens
}

function articleAccountKey(article) {
  return text(article.account_id || article.wx_biz || article.publisher || article.article_id || 'unknown')
}

function articleDate(article, fallback) {
  const raw = text(article.stat_date || article.publish_time || fallback).replaceAll('-', '')
  return /^20\d{6}$/u.test(raw) ? raw : canonicalStatDate(fallback)
}

function addToken(map, token, weight, article, title) {
  const key = `${token.tokenType}:${token.word}`
  let state = map.get(key)
  if (!state) {
    state = {
      word: token.word,
      token_type: token.tokenType,
      gram: token.gram,
      articleIds: new Set(),
      accountIds: new Set(),
      readSum: 0,
      weightedCount: 0,
      examples: [],
      articleUrls: []
    }
    map.set(key, state)
  }
  state.weightedCount += weight
  if (!state.articleIds.has(article.article_id)) {
    state.articleIds.add(article.article_id)
    state.accountIds.add(articleAccountKey(article))
    state.readSum += Math.max(0, numeric(article.read_num ?? article.readNum ?? article.read))
    const articleUrl = text(article.article_url || article.articleUrl || article.url)
    if (articleUrl && !state.articleUrls.includes(articleUrl)) state.articleUrls.push(articleUrl)
    if (title && text(article.title) && !state.examples.includes(text(article.title))) state.examples.push(text(article.title))
  }
}

export function aggregateHotwords(articles = [], {
  statDate = '',
  titleWeight = 2,
  minChineseGram = 2,
  maxChineseGram = 4,
  stopWords = DEFAULT_STOP_WORDS,
  minArticleCount = 1,
  now = nowIso()
} = {}) {
  const fallbackDate = canonicalStatDate(statDate || now)
  const states = new Map()
  for (const article of articles) {
    const articleId = text(article.article_id || article.article_url || article.title || cryptoRandomId(article))
    const workingArticle = { ...article, article_id: articleId }
    const titleTokens = tokenizeHotwords(article.title, { minChineseGram, maxChineseGram, stopWords })
    const contentTokens = tokenizeHotwords(article.content, { minChineseGram, maxChineseGram, stopWords })
    for (const token of titleTokens) addToken(states, token, titleWeight, workingArticle, true)
    for (const token of contentTokens) addToken(states, token, 1, workingArticle, false)
  }
  return [...states.values()]
    .filter(state => state.articleIds.size >= minArticleCount)
    .map(state => ({
      word: state.word,
      token_type: state.token_type,
      gram: state.gram,
      stat_date: canonicalStatDate(statDate || articles[0]?.stat_date || articles[0]?.publish_time || now),
      article_count: state.articleIds.size,
      account_count: state.accountIds.size,
      read_sum: Math.trunc(state.readSum),
      weighted_count: state.weightedCount,
      score: state.weightedCount + Math.log1p(state.readSum),
      examples: state.examples.slice(0, 3),
      article_ids: [...state.articleIds],
      article_url: state.articleUrls[0] || null
    }))
    .sort((left, right) => right.score - left.score || left.word.localeCompare(right.word, 'zh-CN'))
}

function cryptoRandomId(article) {
  return `${text(article.title)}:${text(article.content).slice(0, 32)}`
}

export function persistHotwords(db, rows = [], { now = nowIso() } = {}) {
  const statement = db.prepare(`INSERT INTO hotwords(
    word,token_type,gram,stat_date,article_count,account_count,read_sum,weighted_count,score,examples_json,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(word,stat_date) DO UPDATE SET
    token_type=excluded.token_type,gram=excluded.gram,article_count=excluded.article_count,
    account_count=excluded.account_count,read_sum=excluded.read_sum,weighted_count=excluded.weighted_count,
    score=excluded.score,examples_json=excluded.examples_json,updated_at=excluded.updated_at`)
  for (const row of rows) {
    statement.run(
      row.word, row.token_type, row.gram, row.stat_date, row.article_count, row.account_count,
      row.read_sum, row.weighted_count, row.score, JSON.stringify(row.examples || []), now, now
    )
  }
  return rows.length
}
