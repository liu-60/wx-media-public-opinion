import { createHash } from 'node:crypto'

function text(value) { return value === undefined || value === null ? '' : String(value).trim() }

function parseUrl(value) {
  try {
    const url = new URL(text(value))
    return { wx_biz: text(url.searchParams.get('__biz')), article_sn: text(url.searchParams.get('sn')), mid: text(url.searchParams.get('mid')), idx: Number(url.searchParams.get('idx')) || 1 }
  } catch { return { wx_biz: '', article_sn: '', mid: '', idx: 1 } }
}

function identity(row) {
  const url = parseUrl(row.article_url || row.articleUrl || row.oriUrl || row.url)
  const wxBiz = text(row.wx_biz || row.wxBiz || url.wx_biz)
  const sn = text(row.article_sn || row.articleSn || row.sn || url.article_sn)
  const idxValue = Number(row.idx || url.idx)
  const idx = Number.isSafeInteger(idxValue) && idxValue > 0 ? idxValue : 1
  if (wxBiz && sn) return { key: `${wxBiz}:${sn}:${idx}`, kind: 'wx_biz_sn_idx', wx_biz: wxBiz, article_sn: sn, idx }
  const urlValue = text(row.article_url || row.articleUrl || row.oriUrl || row.url)
  if (urlValue) return { key: `url:${urlValue}`, kind: 'url', wx_biz: wxBiz, article_sn: sn, idx }
  const hash = createHash('sha256').update(JSON.stringify({ title: text(row.title), published_at: text(row.published_at || row.publicTime), content: text(row.content || row.summary) })).digest('hex')
  return { key: `hash:${hash}`, kind: 'content_hash', wx_biz: wxBiz, article_sn: sn, idx }
}

function sourceRefs(row) {
  const platforms = Array.isArray(row.source_refs) ? row.source_refs : []
  const platform = text(row.source_platform || row.platform || (text(row.source_no).startsWith('ZIG') || text(row.source_no).startsWith('OFF') ? 'redfox' : 'wxrank')) || 'unknown'
  const reasons = Array.isArray(row.collect_reasons) && row.collect_reasons.length ? row.collect_reasons : [text(row.collect_reason || row.reason) || 'unspecified']
  const refs = [...platforms]
  for (const reason of reasons) if (!refs.some(ref => ref?.platform === platform && ref?.reason === reason)) refs.push({ platform, reason })
  return refs.filter(ref => ref && text(ref.platform) && text(ref.reason)).map(ref => ({ platform: text(ref.platform), reason: text(ref.reason) }))
}

function mergeValues(left, right) {
  const result = { ...left }
  for (const [key, value] of Object.entries(right || {})) {
    if ((result[key] === undefined || result[key] === null || result[key] === '') && value !== undefined && value !== null && value !== '') result[key] = value
  }
  return result
}

export function canonicalizeArticle(row = {}) {
  const parsed = parseUrl(row.article_url || row.articleUrl || row.oriUrl || row.url)
  const articleIdentity = identity(row)
  const normalized = {
    ...row,
    article_key: articleIdentity.key,
    article_id: text(row.article_id || articleIdentity.key),
    identity_kind: articleIdentity.kind,
    wx_biz: articleIdentity.wx_biz || null,
    article_sn: articleIdentity.article_sn || null,
    idx: articleIdentity.idx,
    mid: text(row.mid || parsed.mid) || null,
    title: text(row.title || row.article_title || row.name),
    article_url: text(row.article_url || row.articleUrl || row.oriUrl || row.url) || null,
    source_refs: sourceRefs(row),
    collect_reasons: [...new Set(sourceRefs(row).map(ref => ref.reason))]
  }
  normalized.source_platform = normalized.source_refs[0]?.platform || normalized.source_platform || 'unknown'
  return normalized
}

export function mergeCanonicalArticles(inputRows = []) {
  if (!Array.isArray(inputRows)) throw new TypeError('articles must be an array')
  const byKey = new Map()
  const invalid = []
  const duplicateRows = []
  for (const [index, source] of inputRows.entries()) {
    try {
      const row = canonicalizeArticle(source)
      if (!row.article_key || !row.title || !row.wx_biz || !row.article_sn) {
        invalid.push({ index, code: 'IDENTITY_OR_TITLE_MISSING', row: source })
        continue
      }
      const existing = byKey.get(row.article_key)
      if (!existing) byKey.set(row.article_key, row)
      else {
        const merged = mergeValues(existing, row)
        merged.source_refs = [...existing.source_refs]
        for (const ref of row.source_refs) if (!merged.source_refs.some(item => item.platform === ref.platform && item.reason === ref.reason)) merged.source_refs.push(ref)
        merged.collect_reasons = [...new Set(merged.source_refs.map(ref => ref.reason))]
        merged.source_steps = [...new Set([...(existing.source_steps || []), ...(row.source_steps || [])].map(text).filter(Boolean))]
        byKey.set(row.article_key, merged)
        duplicateRows.push({ article_key: row.article_key, kept: existing, duplicate: row })
      }
    } catch (error) { invalid.push({ index, code: 'NORMALIZE_FAILED', message: error.message, row: source }) }
  }
  const rows = [...byKey.values()]
  return {
    rows,
    invalid,
    duplicate_report: { input_count: inputRows.length, normalized_count: rows.length + duplicateRows.length, output_count: rows.length, duplicate_count: duplicateRows.length, rows: duplicateRows },
    source_summary: Object.fromEntries([...new Set(rows.flatMap(row => row.source_refs.map(ref => ref.platform)))].map(platform => [platform, { rows: rows.filter(row => row.source_refs.some(ref => ref.platform === platform)).length }]))
  }
}

export { identity as articleIdentity }
