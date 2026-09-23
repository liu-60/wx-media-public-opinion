import { nowIso } from './db.mjs'

const HAN_RUN = /[\p{Script=Han}]+/gu
const ENGLISH_WORD = /[A-Za-z][A-Za-z0-9]*/gu
const DEFAULT_STOP_WORDS = Object.freeze(['我们', '你们', '他们', '这个', '那个', '什么', '如何', '一个', '可以', '以及', '因为', '已经'])
export const DEFAULT_CANONICAL_HOTWORD_RULES = Object.freeze([
  Object.freeze({ canonical: '闲鱼', match_type: 'prefix', protected: true })
])

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
    const segmentStart = match.index
    for (let gram = minChineseGram; gram <= maxChineseGram; gram += 1) {
      if (gram > segment.length) continue
      for (let start = 0; start + gram <= segment.length; start += 1) {
        const word = segment.slice(start, start + gram)
        if (!stop.has(word)) tokens.push({ word, tokenType: 'zh', gram, start: segmentStart + start, end: segmentStart + start + gram })
      }
    }
  }
  for (const match of source.matchAll(ENGLISH_WORD)) {
    const word = match[0].toLowerCase()
    if (!stop.has(word)) tokens.push({ word, tokenType: 'en', gram: 1, start: match.index, end: match.index + match[0].length })
  }
  return tokens
}

function normalizeFilterText(value) {
  return text(value).normalize('NFKC')
}

function canonicalRuleText(value) {
  return text(value).normalize('NFKC').trim()
}

export function normalizeCanonicalHotwordRules(rules = DEFAULT_CANONICAL_HOTWORD_RULES) {
  if (!Array.isArray(rules)) throw new TypeError('canonical hotword rules must be an array')
  return rules.flatMap((rule, index) => {
    const source = typeof rule === 'string' ? { canonical: rule } : rule
    const canonical = canonicalRuleText(source?.canonical ?? source?.value ?? source?.word ?? source?.target)
    if (!canonical) throw new TypeError(`canonical hotword rule ${source?.id ?? index} requires canonical`)
    const aliases = Array.isArray(source?.aliases)
      ? source.aliases.map(canonicalRuleText).filter(Boolean)
      : []
    const matchType = text(source?.match_type ?? source?.matchType ?? source?.mode ?? (aliases.length ? 'alias' : 'exact')).toLowerCase()
    if (!['exact', 'prefix', 'alias'].includes(matchType)) throw new TypeError(`unsupported canonical hotword match type: ${matchType}`)
    return [{
      id: String(source?.id ?? `${matchType}:${canonical}`),
      canonical,
      match_type: matchType,
      aliases: [...new Set(aliases)],
      protected: source?.protected === true
    }]
  }).sort((left, right) => right.canonical.length - left.canonical.length || left.canonical.localeCompare(right.canonical, 'zh-CN'))
}

export function matchCanonicalHotword(value, rules = DEFAULT_CANONICAL_HOTWORD_RULES) {
  const word = canonicalRuleText(value)
  if (!word) return null
  const normalizedRules = Array.isArray(rules) && rules.every(rule => rule?.canonical && rule?.match_type && Array.isArray(rule.aliases))
    ? rules
    : normalizeCanonicalHotwordRules(rules)
  for (const rule of normalizedRules) {
    const matched = rule.match_type === 'prefix'
      ? word.startsWith(rule.canonical)
      : rule.match_type === 'alias'
      ? word === rule.canonical || rule.aliases.includes(word)
      : word === rule.canonical
    if (matched) return { ...rule, matched_term: word }
  }
  return null
}

function hotwordCandidateWords(row) {
  const aliases = Array.isArray(row?.aliases) ? row.aliases : []
  const matchedTerms = row?.matched_terms && typeof row.matched_terms === 'object' && !Array.isArray(row.matched_terms)
    ? Object.keys(row.matched_terms)
    : []
  return [...new Set([row?.word ?? row?.hotword, ...aliases, ...matchedTerms].map(normalizeFilterText).filter(Boolean))]
}

export function applyHotwordFilterRules(rows = [], rules = []) {
  if (!Array.isArray(rows)) throw new TypeError('hotword rows must be an array')
  if (!Array.isArray(rules)) throw new TypeError('hotword filter rules must be an array')

  const activeRules = rules.flatMap((rule, index) => {
    if (rule?.scope !== 'hotword' && rule?.field_name !== 'hotword') return []
    if (rule?.scope !== 'hotword' || rule?.field_name !== 'hotword') throw new TypeError('hotword filter rule must use scope=hotword and field_name=hotword')
    if (rule.enabled === false) return []
    const operator = text(rule.operator)
    const value = normalizeFilterText(rule.value_text ?? rule.value)
    if (!['exact', 'contains'].includes(operator)) throw new TypeError(`unsupported hotword filter operator: ${operator}`)
    if (!value) throw new TypeError(`hotword filter rule ${rule.id ?? index} requires value_text`)
    return [{ id: String(rule.id ?? index), operator, value }]
  })

  const kept = []
  const filtered = []
  const ruleHitCounts = Object.fromEntries(activeRules.map(rule => [rule.id, 0]))
  for (const row of rows) {
    const matches = activeRules.filter(rule => {
      return hotwordCandidateWords(row).some(word => {
        if (rule.operator === 'exact') return word === rule.value
        return word.includes(rule.value) || rule.value.includes(word)
      })
    })
    if (!matches.length) {
      kept.push(row)
      continue
    }
    filtered.push(row)
    for (const rule of matches) ruleHitCounts[rule.id] += 1
  }
  return { rows: kept, filtered_rows: filtered, filtered_count: filtered.length, rule_hit_counts: ruleHitCounts }
}

function articleAccountKeys(article) {
  const configured = Array.isArray(article.account_ids) ? article.account_ids : []
  const fallback = article.account_id || article.wx_biz || article.publisher || article.article_id || 'unknown'
  const values = configured.length ? configured : [fallback]
  return [...new Set(values.map(value => text(value)).filter(Boolean))]
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
      articleUrls: [],
      articleEvidence: new Map()
    }
    map.set(key, state)
  }
  state.weightedCount += weight
  const articleId = text(article.article_id)
  let evidence = state.articleEvidence.get(articleId)
  if (!evidence) {
    evidence = {
      accountIds: articleAccountKeys(article),
      readNum: Math.max(0, numeric(article.read_num ?? article.readNum ?? article.read)),
      weightedCount: 0,
      articleUrl: text(article.article_url || article.articleUrl || article.url),
      example: '',
      spans: { title: [], content: [] }
    }
    state.articleEvidence.set(articleId, evidence)
  }
  for (const accountId of articleAccountKeys(article)) evidence.accountIds.push(accountId)
  evidence.accountIds = [...new Set(evidence.accountIds)]
  evidence.spans[title ? 'title' : 'content'].push({ start: token.start, end: token.end })
  evidence.weightedCount += weight
  if (title && text(article.title)) evidence.example = text(article.title)
  if (!state.articleIds.has(article.article_id)) {
    state.articleIds.add(article.article_id)
    for (const accountId of articleAccountKeys(article)) state.accountIds.add(accountId)
    state.readSum += Math.max(0, numeric(article.read_num ?? article.readNum ?? article.read))
    const articleUrl = text(article.article_url || article.articleUrl || article.url)
    if (articleUrl && !state.articleUrls.includes(articleUrl)) state.articleUrls.push(articleUrl)
    if (title && text(article.title) && !state.examples.includes(text(article.title))) state.examples.push(text(article.title))
  }
}

const DEFAULT_MERGE_CONSISTENCY_THRESHOLD = 0.8
const DEFAULT_MERGE_MIN_ARTICLE_COUNT = 3

function normalizeMergeWord(value) {
  return text(value)
    .normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLocaleLowerCase()
}

function rowEvidence(row) {
  const articleValues = Array.isArray(row?.merge_article_ids) && row.merge_article_ids.length
    ? row.merge_article_ids
    : Array.isArray(row?.article_ids)
    ? row.article_ids
    : Array.isArray(row?.article_keys) ? row.article_keys : []
  if (articleValues.length) return new Set(articleValues.map(value => text(value)).filter(Boolean))
  const accountValues = Array.isArray(row?.merge_account_ids) && row.merge_account_ids.length
    ? row.merge_account_ids
    : row?.account_ids
  return new Set(Array.isArray(accountValues) ? accountValues.map(value => text(value)).filter(Boolean) : [])
}

function evidenceConsistency(left, right) {
  const leftEvidence = left instanceof Set ? left : rowEvidence(left)
  const rightEvidence = right instanceof Set ? right : rowEvidence(right)
  if (!leftEvidence.size || !rightEvidence.size) return 0
  let intersection = 0
  for (const value of leftEvidence) if (rightEvidence.has(value)) intersection += 1
  const union = new Set([...leftEvidence, ...rightEvidence]).size
  return union ? intersection / union : 0
}

function evidenceIntersectionCount(left, right) {
  const leftEvidence = left instanceof Set ? left : rowEvidence(left)
  const rightEvidence = right instanceof Set ? right : rowEvidence(right)
  if (!leftEvidence.size || !rightEvidence.size) return 0
  let intersection = 0
  for (const value of leftEvidence) if (rightEvidence.has(value)) intersection += 1
  return intersection
}

function evidenceConsistencyForWords(leftWord, leftEvidence, rightWord, rightEvidence) {
  const leftSet = leftEvidence instanceof Set ? leftEvidence : rowEvidence(leftEvidence)
  const rightSet = rightEvidence instanceof Set ? rightEvidence : rowEvidence(rightEvidence)
  if (!leftSet.size || !rightSet.size) return 0
  if (!leftWord || !rightWord || leftWord === rightWord || (!leftWord.includes(rightWord) && !rightWord.includes(leftWord))) {
    return evidenceConsistency(leftSet, rightSet)
  }
  let intersection = 0
  const smaller = leftSet.size <= rightSet.size ? leftSet : rightSet
  const larger = leftSet.size <= rightSet.size ? rightSet : leftSet
  for (const value of smaller) if (larger.has(value)) intersection += 1
  // For a lexical containment pair, require most long-phrase evidence to be
  // covered by the shorter phrase. This treats "亚运会" as part of "亚运"
  // even when the shorter word also appears in additional titles.
  const longerWordLength = Math.max(leftWord.length, rightWord.length)
  const longerEvidence = leftWord.length === longerWordLength ? leftSet : rightSet
  return longerEvidence.size ? intersection / longerEvidence.size : 0
}

function mergeWordsCompatible(left, right) {
  if (!left || !right || left.length < 2 || right.length < 2) return false
  return left === right || left.includes(right) || right.includes(left)
}

function roundedConsistency(value) {
  return Math.round(value * 1000) / 1000
}

function numericOrZero(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function mergeArrayValues(rows, field) {
  return [...new Set(rows.flatMap(row => Array.isArray(row?.[field]) ? row[field].map(value => text(value)).filter(Boolean) : []))]
}

function mergeEvidenceValues(rows, preferredField, fallbackField) {
  return [...new Set(rows.flatMap(row => {
    const preferred = Array.isArray(row?.[preferredField]) && row[preferredField].length ? row[preferredField] : row?.[fallbackField]
    return Array.isArray(preferred) ? preferred.map(value => text(value)).filter(Boolean) : []
  }))]
}

function withoutMergeEvidence(row) {
  if (!row || typeof row !== 'object') return row
  const { merge_article_ids: _mergeArticleIds, merge_account_ids: _mergeAccountIds, ...visible } = row
  return visible
}

function rowEvidenceValues(row, article = true) {
  const preferred = article
    ? (Array.isArray(row?.merge_article_ids) && row.merge_article_ids.length ? row.merge_article_ids : row?.article_ids)
    : (Array.isArray(row?.merge_account_ids) && row.merge_account_ids.length ? row.merge_account_ids : row?.account_ids)
  return Array.isArray(preferred) ? [...new Set(preferred.map(value => text(value)).filter(Boolean))] : []
}

function matchedTermCounts(row) {
  if (row?.matched_terms && typeof row.matched_terms === 'object' && !Array.isArray(row.matched_terms)) {
    return Object.fromEntries(Object.entries(row.matched_terms)
      .map(([word, count]) => [text(word), Math.max(0, numericOrZero(count))])
      .filter(([word]) => Boolean(word)))
  }
  const word = text(row?.word ?? row?.hotword)
  if (!word) return {}
  return { [word]: rowEvidenceValues(row).length || numericOrZero(row?.article_count) }
}

function mergeMatchedTermCounts(rows) {
  const counts = {}
  for (const row of rows) {
    for (const [word, count] of Object.entries(matchedTermCounts(row))) {
      counts[word] = Math.max(counts[word] || 0, numericOrZero(count))
    }
  }
  return counts
}

function canonicalRepresentative(members, canonical) {
  return [...members].sort((left, right) => {
    const leftIsCanonical = text(left.word ?? left.hotword) === canonical ? 1 : 0
    const rightIsCanonical = text(right.word ?? right.hotword) === canonical ? 1 : 0
    return rightIsCanonical - leftIsCanonical
      || numericOrZero(right.article_count) - numericOrZero(left.article_count)
      || numericOrZero(right.score) - numericOrZero(left.score)
      || text(left.word ?? left.hotword).localeCompare(text(right.word ?? right.hotword), 'zh-CN')
  })[0]
}

/**
 * Map raw candidate terms to configured canonical words while retaining every
 * matched term and its distinct article evidence. This runs before the normal
 * evidence-consistency merge, so a protected fixed word is not lost to the
 * generic bigram-overlap suppression.
 */
export function canonicalizeHotwordRows(rows = [], rules = DEFAULT_CANONICAL_HOTWORD_RULES) {
  if (!Array.isArray(rows)) throw new TypeError('hotword rows must be an array')
  const normalizedRules = normalizeCanonicalHotwordRules(rules)
  const passthrough = []
  const groups = new Map()
  const ruleHitCounts = Object.fromEntries(normalizedRules.map(rule => [rule.id, 0]))

  for (const row of rows) {
    const rawWord = text(row?.word ?? row?.hotword)
    const matched = matchCanonicalHotword(rawWord, normalizedRules)
    const withMatchedTerms = { ...row, matched_terms: matchedTermCounts(row) }
    if (!matched) {
      passthrough.push(withMatchedTerms)
      continue
    }
    ruleHitCounts[matched.id] = (ruleHitCounts[matched.id] || 0) + 1
    const key = `${text(row?.stat_date)}\u0000${text(row?.token_type ?? row?.tokenType)}\u0000${matched.canonical}`
    let group = groups.get(key)
    if (!group) {
      group = { canonical: matched.canonical, rule: matched, members: [] }
      groups.set(key, group)
    }
    group.members.push(withMatchedTerms)
  }

  const canonicalRows = [...groups.values()].map(group => {
    const members = group.members
    const representative = canonicalRepresentative(members, group.canonical)
    const articleIds = mergeEvidenceValues(members, 'merge_article_ids', 'article_ids')
    const accountIds = mergeEvidenceValues(members, 'merge_account_ids', 'account_ids')
    const articleKeys = mergeArrayValues(members, 'article_keys')
    const aliases = mergeArrayValues(members, 'aliases')
    const matchedTerms = mergeMatchedTermCounts(members)
    const rawWords = members.map(row => text(row.word ?? row.hotword)).filter(Boolean)
    for (const word of rawWords) if (word !== group.canonical) aliases.push(word)
    const examples = mergeArrayValues(members, 'examples').slice(0, 3)
    const articleUrls = mergeArrayValues(members, 'article_urls')
    const articleUrl = text(representative.article_url) || articleUrls[0] || members.map(row => text(row.article_url)).find(Boolean) || null
    const merged = {
      ...withoutMergeEvidence(representative),
      word: group.canonical,
      canonical_word: group.canonical,
      canonical_match_type: group.rule.match_type,
      canonical_protected: group.rule.protected,
      aliases: [...new Set(aliases)].filter(value => value && value !== group.canonical),
      matched_terms: matchedTerms,
      article_count: articleIds.length || Math.max(...members.map(row => numericOrZero(row.article_count))),
      account_count: accountIds.length || Math.max(...members.map(row => numericOrZero(row.account_count))),
      read_sum: Math.trunc(Math.max(...members.map(row => numericOrZero(row.read_sum)))),
      weighted_count: Math.max(...members.map(row => numericOrZero(row.weighted_count))),
      score: Math.max(...members.map(row => numericOrZero(row.score))),
      examples,
      article_ids: articleIds,
      article_url: articleUrl,
      merged_from: [...new Set(members.flatMap(row => [ ...(Array.isArray(row.merged_from) ? row.merged_from : []), text(row.word ?? row.hotword) ].filter(Boolean)))]
    }
    if (accountIds.length) merged.account_ids = accountIds
    if (articleKeys.length) merged.article_keys = articleKeys
    return merged
  })

  return {
    rows: [...passthrough, ...canonicalRows],
    canonical_merge_count: rows.length - passthrough.length - canonicalRows.length,
    canonical_group_count: [...groups.values()].filter(group => group.members.length > 1).length,
    canonical_rule_count: normalizedRules.length,
    canonical_rule_hit_counts: ruleHitCounts,
    canonical_rules: normalizedRules
  }
}

/**
 * Merge lexical hotword variants only after their article evidence is similar
 * enough. For lexical containment pairs, the consistency score is the share
 * of longer-phrase evidence covered by the shorter phrase, so "亚运会" inside
 * "亚运" can merge even when "亚运" has additional articles. Non-containment
 * rows retain the Jaccard fallback. The most recurrent compatible variant is
 * the deterministic canonical word and the other variants are retained as
 * aliases.
 */
export function mergeSimilarHotwordRows(rows = [], {
  consistencyThreshold = DEFAULT_MERGE_CONSISTENCY_THRESHOLD,
  minCrossArticleCount = DEFAULT_MERGE_MIN_ARTICLE_COUNT
} = {}) {
  if (!Array.isArray(rows)) throw new TypeError('hotword rows must be an array')
  const threshold = Number(consistencyThreshold)
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new TypeError('consistencyThreshold must be between 0 and 1')
  const minimumCrossArticleCount = Number(minCrossArticleCount)
  if (!Number.isSafeInteger(minimumCrossArticleCount) || minimumCrossArticleCount < 1) throw new TypeError('minCrossArticleCount must be a positive integer')
  if (!rows.length) return { rows: [], merged_count: 0, merge_group_count: 0, merge_consistency_threshold: threshold, merge_min_article_count: minimumCrossArticleCount }

  const ordered = rows
    .map((row, index) => ({ row, index, normalizedWord: normalizeMergeWord(row?.word ?? row?.hotword), evidence: rowEvidence(row) }))
    .sort((left, right) => numericOrZero(right.row?.article_count) - numericOrZero(left.row?.article_count) || right.normalizedWord.length - left.normalizedWord.length || numericOrZero(right.row?.score) - numericOrZero(left.row?.score) || left.index - right.index)
  const clusters = []

  for (const candidate of ordered) {
    const statDate = text(candidate.row?.stat_date)
    const tokenType = text(candidate.row?.token_type || candidate.row?.tokenType)
    let matchedMember = null
    const cluster = clusters.find(item => {
      if (text(item.representative.row?.stat_date) !== statDate) return false
      if (text(item.representative.row?.token_type || item.representative.row?.tokenType) !== tokenType) return false
      const member = item.members.find(existing => {
        if (!mergeWordsCompatible(existing.normalizedWord, candidate.normalizedWord)) return false
        if (existing.normalizedWord === candidate.normalizedWord) return true
        // A one-off long n-gram is usually title context, not a stable
        // hotword. Require recurring evidence before it can absorb a shorter
        // contained word and create a transitive merge chain.
        const longerEvidence = existing.normalizedWord.length >= candidate.normalizedWord.length ? existing.evidence : candidate.evidence
        if (longerEvidence.size < 2) return false
        if (evidenceIntersectionCount(existing.evidence, candidate.evidence) < minimumCrossArticleCount) return false
        return evidenceConsistencyForWords(candidate.normalizedWord, candidate.evidence, existing.normalizedWord, existing.evidence) >= threshold
      })
      if (!member) return false
      matchedMember = member
      return true
    })
    if (cluster) {
      cluster.members.push(candidate)
      for (const value of candidate.evidence) cluster.evidence.add(value)
      if (matchedMember && matchedMember.normalizedWord !== candidate.normalizedWord) {
        cluster.consistencies.push(evidenceConsistencyForWords(candidate.normalizedWord, candidate.evidence, matchedMember.normalizedWord, matchedMember.evidence))
      }
      continue
    }
    clusters.push({ representative: candidate, members: [candidate], evidence: new Set(candidate.evidence), consistencies: [] })
  }

  const mergedRows = clusters.map(cluster => {
    const members = cluster.members.map(item => item.row)
    if (members.length === 1) return withoutMergeEvidence(cluster.representative.row)

    const minimumConsistency = Math.min(...cluster.consistencies, 1)
    // A lone, partial-overlap extension is commonly a context character
    // captured by a four-gram (for example "钦孙颖莎"). Prefer the shorter
    // evidence-backed word only when both variants are phrase-sized; a
    // two-character root such as "亚运" must not replace a recurring
    // three-character phrase such as "亚运会". Conversely, a one-off
    // context fragment such as "热点新" should not replace the shorter
    // recurring word "热点". A three-way cluster such as
    // "体操男团/体操男/操男团" still keeps the full phrase as canonical.
    const canonicalCandidate = members.length === 2
      && (cluster.representative.evidence.size < 2 || (minimumConsistency < 1 && cluster.members.every(item => item.normalizedWord.length >= 3)))
      ? [...cluster.members].sort((left, right) => left.normalizedWord.length - right.normalizedWord.length || left.index - right.index)[0]
      : cluster.representative
    const representative = withoutMergeEvidence(canonicalCandidate.row)

    const canonicalWord = text(representative.word ?? representative.hotword)
    const aliases = mergeArrayValues(members, 'aliases')
    for (const row of members) {
      const word = text(row.word ?? row.hotword)
      if (word && word !== canonicalWord) aliases.push(word)
    }
    const articleIds = [...cluster.evidence]
    const accountIds = mergeEvidenceValues(members, 'merge_account_ids', 'account_ids')
    const articleKeys = mergeArrayValues(members, 'article_keys')
    const examples = mergeArrayValues(members, 'examples').slice(0, 3)
    const articleUrls = mergeArrayValues(members, 'article_urls')
    const articleUrl = text(representative.article_url) || articleUrls[0] || members.map(row => text(row.article_url)).find(Boolean) || null
    const merged = {
      ...representative,
      word: canonicalWord,
      aliases: [...new Set(aliases)].filter(value => value !== canonicalWord),
      article_count: articleIds.length || Math.max(...members.map(row => numericOrZero(row.article_count))),
      account_count: accountIds.length || Math.max(...members.map(row => numericOrZero(row.account_count))),
      read_sum: Math.trunc(Math.max(...members.map(row => numericOrZero(row.read_sum)))),
      weighted_count: Math.max(...members.map(row => numericOrZero(row.weighted_count))),
      score: Math.max(...members.map(row => numericOrZero(row.score))),
      examples,
      matched_terms: mergeMatchedTermCounts(members),
      article_ids: articleIds,
      article_url: articleUrl,
      merged_from: members.map(row => text(row.word ?? row.hotword)).filter(Boolean),
      merge_consistency: roundedConsistency(minimumConsistency),
      merge_consistency_threshold: threshold
    }
    if (accountIds.length) merged.account_ids = accountIds
    if (articleKeys.length) merged.article_keys = articleKeys
    return merged
  })

  return {
    rows: mergedRows,
    merged_count: rows.length - mergedRows.length,
    merge_group_count: clusters.filter(cluster => cluster.members.length > 1).length,
    merge_consistency_threshold: threshold,
    merge_min_article_count: minimumCrossArticleCount
  }
}

export function aggregateHotwordsWithDiagnostics(articles = [], {
  statDate = '',
  titleWeight = 2,
  minChineseGram = 2,
  maxChineseGram = 4,
  stopWords = DEFAULT_STOP_WORDS,
  minArticleCount = 1,
  filterRules = [],
  canonicalRules = DEFAULT_CANONICAL_HOTWORD_RULES,
  mergeConsistencyThreshold = null,
  mergeMinArticleCount = DEFAULT_MERGE_MIN_ARTICLE_COUNT,
  now = nowIso()
} = {}) {
  const fallbackDate = canonicalStatDate(statDate || now)
  const normalizedCanonicalRules = normalizeCanonicalHotwordRules(canonicalRules)
  const states = new Map()
  for (const article of articles) {
    const articleId = text(article.article_id || article.article_url || article.title || cryptoRandomId(article))
    const workingArticle = { ...article, article_id: articleId }
    const titleTokens = tokenizeHotwords(article.title, { minChineseGram, maxChineseGram, stopWords })
    const contentTokens = tokenizeHotwords(article.content, { minChineseGram, maxChineseGram, stopWords })
    for (const token of titleTokens) addToken(states, token, titleWeight, workingArticle, true)
    for (const token of contentTokens) addToken(states, token, 1, workingArticle, false)
  }

  const qualifyingTrigramsByArticle = new Map()
  const phraseMinimumArticleCount = Math.max(2, minArticleCount)
  for (const state of states.values()) {
    if (state.token_type !== 'zh' || state.gram !== 3 || state.articleEvidence.size < phraseMinimumArticleCount) continue
    for (const [articleId, evidence] of state.articleEvidence) {
      const phrases = qualifyingTrigramsByArticle.get(articleId) || { title: [], content: [] }
      for (const source of ['title', 'content']) {
        phrases[source].push(...evidence.spans[source].map(span => ({ ...span, word: state.word })))
      }
      qualifyingTrigramsByArticle.set(articleId, phrases)
    }
  }

  const rows = []
  for (const state of states.values()) {
    const allEvidence = [...state.articleEvidence.entries()]
    const canonicalMatch = matchCanonicalHotword(state.word, normalizedCanonicalRules)
    const protectedCandidate = canonicalMatch?.protected === true
    const evidence = protectedCandidate
      ? allEvidence
      : allEvidence.filter(([articleId]) => {
      if (state.token_type !== 'zh' || state.gram !== 2) return true
      const articlePhrases = qualifyingTrigramsByArticle.get(articleId)
      if (!articlePhrases) return true
      const articleEvidence = state.articleEvidence.get(articleId)
      const spans = ['title', 'content'].flatMap(source => articleEvidence.spans[source].map(span => ({ ...span, source })))
      if (!spans.length) return true
      return !spans.every(span => articlePhrases[span.source].some(phrase => span.start >= phrase.start && span.end <= phrase.end))
      })
    if (evidence.length < minArticleCount) continue
    const accountIds = new Set(evidence.flatMap(([, item]) => item.accountIds))
    const readSum = evidence.reduce((sum, [, item]) => sum + item.readNum, 0)
    const weightedCount = evidence.reduce((sum, [, item]) => sum + item.weightedCount, 0)
    const examples = [...new Set(evidence.map(([, item]) => item.example).filter(Boolean))].slice(0, 3)
    const articleUrls = [...new Set(evidence.map(([, item]) => item.articleUrl).filter(Boolean))]
    const row = {
      word: state.word,
      token_type: state.token_type,
      gram: state.gram,
      stat_date: canonicalStatDate(statDate || articles[0]?.stat_date || articles[0]?.publish_time || now),
      article_count: evidence.length,
      account_count: accountIds.size,
      read_sum: Math.trunc(readSum),
      weighted_count: weightedCount,
      score: weightedCount + Math.log1p(readSum),
      examples,
      account_ids: [...accountIds],
      article_ids: evidence.map(([articleId]) => articleId),
      article_url: articleUrls[0] || null
    }
    // Bigram evidence covered by a qualifying trigram is hidden from the
    // standalone result, but retained as internal evidence when tolerant
    // variant merging is enabled. This lets "亚运" merge into "亚运会"
    // using the same 0.8 article-evidence threshold without making every
    // overlapping bigram a visible hotword.
    if (!protectedCandidate && mergeConsistencyThreshold !== null && mergeConsistencyThreshold !== undefined && state.gram === 2 && allEvidence.length > evidence.length) {
      row.merge_article_ids = allEvidence.map(([articleId]) => articleId)
      row.merge_account_ids = [...new Set(allEvidence.flatMap(([, item]) => item.accountIds))]
    }
    rows.push(row)
  }
  const canonicalized = canonicalizeHotwordRows(rows, normalizedCanonicalRules)
  const merged = mergeConsistencyThreshold === null || mergeConsistencyThreshold === undefined
    ? { rows: canonicalized.rows, merged_count: 0, merge_group_count: 0, merge_consistency_threshold: null, merge_min_article_count: null }
    : mergeSimilarHotwordRows(canonicalized.rows, { consistencyThreshold: mergeConsistencyThreshold, minCrossArticleCount: mergeMinArticleCount })
  const filtered = applyHotwordFilterRules(merged.rows, filterRules)
  return {
    rows: filtered.rows.sort((left, right) => right.score - left.score || left.word.localeCompare(right.word, 'zh-CN')),
    candidate_count: rows.length,
    canonical_candidate_count: canonicalized.rows.length,
    canonical_merge_count: canonicalized.canonical_merge_count,
    canonical_group_count: canonicalized.canonical_group_count,
    canonical_rule_count: canonicalized.canonical_rule_count,
    canonical_rule_hit_counts: canonicalized.canonical_rule_hit_counts,
    merged_count: merged.merged_count,
    merge_group_count: merged.merge_group_count,
    merge_consistency_threshold: merged.merge_consistency_threshold,
    merge_min_article_count: merged.merge_min_article_count,
    filtered_count: filtered.filtered_count,
    filtered_rows: filtered.filtered_rows,
    rule_hit_counts: filtered.rule_hit_counts
  }
}

export function aggregateHotwords(articles = [], options = {}) {
  return aggregateHotwordsWithDiagnostics(articles, options).rows
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

class HotwordMergeError extends Error {
  constructor(code, message = code) {
    super(message)
    this.name = 'HotwordMergeError'
    this.code = code
    this.status = 400
  }
}

function mergeId(value) {
  const id = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isSafeInteger(id) || id < 1) throw new HotwordMergeError('HOTWORD_ID_INVALID')
  return id
}

function mergeArray(value) {
  return Array.isArray(value) ? value.filter(item => item !== undefined && item !== null).map(item => String(item)) : []
}

function validArticleUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function dedupeExact(values) {
  return [...new Set(values)]
}

/**
 * Merge already-read hotword rows. This function deliberately has no database
 * dependency: article_keys are opaque source keys, not article table IDs.
 */
export function canonicalHotwordMerge({ rows, targetId } = {}) {
  if (!Array.isArray(rows) || rows.length < 1) throw new HotwordMergeError('HOTWORD_ROWS_REQUIRED')
  if (targetId === undefined || targetId === null || targetId === '') throw new HotwordMergeError('HOTWORD_TARGET_REQUIRED')
  const normalizedTargetId = mergeId(targetId)
  const target = rows.find(row => mergeId(row?.id) === normalizedTargetId)
  if (!target) throw new HotwordMergeError('HOTWORD_TARGET_REQUIRED')
  const dates = new Set(rows.map(row => String(row?.stat_date ?? '')))
  if (dates.size !== 1 || !dates.values().next().value) throw new HotwordMergeError('HOTWORD_DATE_MISMATCH')

  const aliases = []
  for (const row of rows) {
    if (row !== target && row.hotword !== undefined && row.hotword !== null) aliases.push(String(row.hotword))
    aliases.push(...mergeArray(row.aliases))
  }
  const canonicalHotword = String(target.hotword ?? '')
  const mergedAliases = dedupeExact(aliases).filter(alias => alias !== canonicalHotword)
  const articleKeys = dedupeExact(rows.flatMap(row => mergeArray(row.article_keys)))
  if (articleKeys.length < 2 || articleKeys.length > 32767) throw new HotwordMergeError('HOTWORD_COUNT_OUT_OF_RANGE')

  const candidateUrls = [target, ...rows.filter(row => row !== target)]
    .map(row => row.article_url)
    .find(validArticleUrl)
  const merged = {
    ...target,
    aliases: mergedAliases,
    article_count: articleKeys.length,
    article_keys: articleKeys,
    article_url: candidateUrls ? String(candidateUrls) : null
  }
  return {
    target: merged,
    removedIds: rows.filter(row => mergeId(row.id) !== normalizedTargetId).map(row => row.id)
  }
}

export function mergeHotwordRow(input = {}) {
  return canonicalHotwordMerge(input)
}
