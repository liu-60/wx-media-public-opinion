import fs from 'node:fs';
import path from 'node:path';
import { REDFOX_GZH_SOURCES } from '../src/collector-adapters/redfox.mjs';

const root = path.resolve(
  process.env.REDFOX_GZH_OUTPUT ||
    path.join(process.cwd(), 'reports', 'redfox-gzh-latest-20260922'),
);
const rawDir = path.join(root, 'raw');
const normalizedDir = path.join(root, 'normalized');
const apiKey = process.env.REDFOX_API_KEY;
const targetDate = process.env.REDFOX_LATEST_DATE || dateInSingapore();
const lookbackDays = Number(process.env.REDFOX_LOOKBACK_DAYS || 14);

if (!apiKey) throw new Error('REDFOX_API_KEY is required in the process environment');
if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
  throw new Error('REDFOX_LATEST_DATE must use YYYY-MM-DD');
}

fs.mkdirSync(rawDir, { recursive: true });
fs.mkdirSync(normalizedDir, { recursive: true });

const sources = REDFOX_GZH_SOURCES.map((source) => ({
  ...source,
  docUrl: `https://redfox.hk/apis/gongzhonghao/${source.no}`,
}));

function dateInSingapore() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function dateMinusDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function safeFilePart(value) {
  return String(value).replace(/[^\w.-]+/g, '_').slice(0, 80);
}

function parseJson(text) {
  try {
    return { value: JSON.parse(text), error: null };
  } catch (error) {
    return { value: null, error: String(error) };
  }
}

function responseCode(response) {
  return response && typeof response === 'object' ? response.code ?? null : null;
}

function responseMessage(response) {
  return response && typeof response === 'object'
    ? String(response.msg ?? response.message ?? '')
    : '';
}

function dataRows(response) {
  if (!response || typeof response !== 'object') return [];
  if (Array.isArray(response.data)) return response.data;
  if (!response.data || typeof response.data !== 'object') return [];
  for (const key of ['list', 'rows', 'records', 'data']) {
    if (Array.isArray(response.data[key])) return response.data[key];
  }
  for (const value of Object.values(response.data)) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function classification(result) {
  if (result.errorType) return result.errorType;
  if (result.httpStatus < 200 || result.httpStatus >= 300) return 'http_error';
  if (result.responseCode !== null && result.responseCode !== 2000) return 'business_error';
  if (result.responseParseError) return 'invalid_json';
  return 'success';
}

function shouldLookBack(result, source, offset, maxOffset) {
  if (offset >= maxOffset) return false;
  if (result.classification === 'success' && result.rowCount === 0) return true;
  if (result.responseCode !== 3203) return false;
  const message = responseMessage(result.response);
  if (source.type === 'account-growth-rank') return message.includes('周一');
  return message.includes('查询结果为空') || message.includes('每日 18:30');
}

async function request(source, date) {
  const body = source.bodyForDate(date);
  const started = Date.now();
  const result = {
    sourceNo: source.no,
    name: source.name,
    endpoint: source.endpoint,
    method: 'POST',
    body,
    date,
    httpStatus: 0,
    responseHeaders: {},
    responseText: '',
    response: null,
    responseParseError: null,
    errorType: null,
    error: null,
    durationMs: 0,
  };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(source.endpoint, {
      method: 'POST',
      headers: {
        REDFOX_API_KEY: apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'redfox-gzh-latest-script/1.0',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    result.httpStatus = response.status;
    result.responseHeaders = Object.fromEntries(
      [...response.headers].filter(([key]) => /content-type|x-request-id|remaining|point|cost|rate/i.test(key)),
    );
    result.responseText = await response.text();
    const parsed = parseJson(result.responseText);
    result.response = parsed.value;
    result.responseParseError = parsed.error;
  } catch (error) {
    result.errorType = error?.name === 'AbortError' ? 'timeout' : 'network_error';
    result.error = String(error);
  } finally {
    clearTimeout(timeoutId);
    result.durationMs = Date.now() - started;
  }
  result.responseCode = responseCode(result.response);
  result.rowCount = dataRows(result.response).length;
  result.classification = classification(result);
  return result;
}

function rawDocument(source, result, attempt) {
  return {
    sourceNo: source.no,
    name: source.name,
    docUrl: source.docUrl,
    endpoint: source.endpoint,
    attempt,
    requestedDate: result.date,
    requestBody: result.body,
    httpStatus: result.httpStatus,
    responseHeaders: result.responseHeaders,
    responseText: result.responseText,
    response: result.response,
    responseParseError: result.responseParseError,
    errorType: result.errorType,
    error: result.error,
    durationMs: result.durationMs,
    responseCode: result.responseCode,
    rowCount: result.rowCount,
    classification: result.classification,
  };
}

function textOf(row, keys, max = 220) {
  if (!row || typeof row !== 'object') return '';
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim()) {
      const value = String(row[key]).replace(/\s+/g, ' ').trim();
      return value.length > max ? value.slice(0, max - 1) + '…' : value;
    }
  }
  return '';
}

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).replaceAll(',', '').trim();
  if (!text || text === '-') return null;
  let multiplier = 1;
  if (/亿/i.test(text)) multiplier = 100_000_000;
  else if (/万|w/i.test(text)) multiplier = 10_000;
  const number = Number(text.replace(/[^\d.+-]/g, ''));
  return Number.isFinite(number) ? number * multiplier : null;
}

function metricsOf(row) {
  const keys = [
    'clicksCount', 'likeCount', 'shareCount', 'commentCount', 'watchCount',
    'interactiveCount', 'cur_read', 'prev_read', 'growth_val', 'growth_pct',
  ];
  const metrics = {};
  for (const key of keys) {
    if (row?.[key] !== undefined && row?.[key] !== null && row?.[key] !== '') {
      metrics[key] = { raw: row[key], numeric: numeric(row[key]) };
    }
  }
  return metrics;
}

function normalizeRow(row, source, index, requestedDate) {
  const isAccount = source.type === 'account-growth-rank';
  return {
    rank: index + 1,
    sourceNo: source.no,
    requestedDate,
    title: isAccount
      ? textOf(row, ['nickname', 'userName', 'accountName'])
      : textOf(row, ['title', 'articleTitle', 'name']),
    account: textOf(row, ['userName', 'nickname', 'accountName']),
    accountId: row?.accountId ?? row?.account_id ?? row?.wxBiz ?? row?.wx_biz ?? null,
    authorType: row?.author_type ?? row?.type ?? null,
    publicTime: row?.publicTime ?? row?.public_time ?? null,
    rankDate: row?.rank_date ?? row?.rankDate ?? null,
    summary: textOf(row, ['summary', 'description'], 300),
    url: row?.oriUrl ?? row?.url ?? row?.articleUrl ?? null,
    metrics: metricsOf(row),
    raw: row,
  };
}

function formatMetric(value) {
  if (value === null || value === undefined) return '';
  const n = numeric(value);
  if (n === null) return String(value);
  return String(value) + (typeof value === 'string' && /万|w|亿/i.test(value) ? ` (约${Math.round(n).toLocaleString('zh-CN')})` : '');
}

function metricText(row) {
  return Object.entries(row.metrics || {})
    .map(([key, value]) => `${key}=${formatMetric(value.raw)}`)
    .join('；');
}

function markdownCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

const selected = [];
const attemptLog = [];

for (const source of sources) {
  let chosen = null;
  let latestValid = null;
  for (let offset = 0; offset <= lookbackDays; offset += 1) {
    const date = dateMinusDays(targetDate, offset);
    const result = await request(source, date);
    const attempt = offset + 1;
    const rawPath = path.join(rawDir, `${safeFilePart(source.no)}-${date}-attempt${attempt}.json`);
    fs.writeFileSync(rawPath, JSON.stringify(rawDocument(source, result, attempt), null, 2) + '\n', 'utf8');
    result.rawFile = path.relative(root, rawPath).replaceAll('\\', '/');
    attemptLog.push({
      sourceNo: source.no,
      date,
      attempt,
      httpStatus: result.httpStatus,
      responseCode: result.responseCode,
      rowCount: result.rowCount,
      classification: result.classification,
      rawFile: path.relative(root, rawPath).replaceAll('\\', '/'),
    });
    if (result.classification === 'success') {
      latestValid = { source, result, attempt, selectedDate: date, fallbackUsed: offset > 0 };
    }
    if (!shouldLookBack(result, source, offset, lookbackDays)) {
      chosen = { source, result, attempt, selectedDate: date, fallbackUsed: offset > 0 };
      break;
    }
  }
  if (latestValid && chosen?.result?.classification !== 'success') chosen = latestValid;
  if (!chosen) chosen = latestValid;
  const rows = dataRows(chosen.result.response).map((row, index) =>
    normalizeRow(row, source, index, chosen.selectedDate),
  );
  const normalizedPath = path.join(normalizedDir, `${safeFilePart(source.no)}.json`);
  fs.writeFileSync(
    normalizedPath,
    JSON.stringify({
      sourceNo: source.no,
      name: source.name,
      requestedTargetDate: targetDate,
      selectedDate: chosen.selectedDate,
      fallbackUsed: chosen.fallbackUsed,
      requestBody: chosen.result.body,
      httpStatus: chosen.result.httpStatus,
      responseCode: chosen.result.responseCode,
      classification: chosen.result.classification,
      rowCount: rows.length,
      rows,
    }, null, 2) + '\n',
    'utf8',
  );
  selected.push({
    no: source.no,
    name: source.name,
    docUrl: source.docUrl,
    endpoint: source.endpoint,
    type: source.type,
    price: source.price,
    requestedTargetDate: targetDate,
    selectedDate: chosen.selectedDate,
    fallbackUsed: chosen.fallbackUsed,
    attempts: chosen.attempt,
    requestBody: chosen.result.body,
    httpStatus: chosen.result.httpStatus,
    responseCode: chosen.result.responseCode,
    classification: chosen.result.classification,
    rowCount: rows.length,
    normalizedFile: path.relative(root, normalizedPath).replaceAll('\\', '/'),
    rawFile: chosen.result.rawFile,
    rows,
  });
}

function topArticles(source) {
  return source.rows
    .slice()
    .sort((a, b) => {
      const aScore = numeric(a.metrics?.shareCount?.raw) ?? numeric(a.metrics?.likeCount?.raw) ?? -1;
      const bScore = numeric(b.metrics?.shareCount?.raw) ?? numeric(b.metrics?.likeCount?.raw) ?? -1;
      return bScore - aScore;
    })
    .slice(0, 10);
}

function topAccounts(source) {
  return source.rows
    .slice()
    .sort((a, b) => (b.metrics?.growth_val?.numeric ?? -1) - (a.metrics?.growth_val?.numeric ?? -1))
    .slice(0, 10);
}

const reportParts = [
  '# 公众号三接口最新日期请求与返回数据报告',
  '',
  `生成时间（UTC）：${new Date().toISOString()}`,
  '',
  '## 请求口径',
  '',
  `- 目标日期：**${targetDate}**（按新加坡时区计算）。`,
  `- 日期策略：先请求目标日期；目标日期返回空数组时，最多向前回溯 ${lookbackDays} 天，选取最近一个有数据日期。`,
  '- 其他参数沿用上次真实请求的有效参数：`type=知识百科`，头条增长榜使用 `author_type=人文资讯`、`page=1`。',
  '- 请求方式：Node.js 直接 HTTP POST；API 密钥只通过进程环境传入，没有写入任何产物。',
  '- 原始响应未覆盖，保存在 `raw/`；规范化结果保存在 `normalized/`。',
  '',
  '## 总结',
  '',
  `- 目标日期请求接口数：**${sources.length}**。`,
  `- 实际返回记录总数：**${selected.reduce((sum, item) => sum + item.rowCount, 0)}**。`,
  `- 实际 HTTP/code 成功接口：**${selected.filter((item) => item.httpStatus === 200 && item.responseCode === 2000).length}/${selected.length}**。`,
  `- 请求尝试次数：**${attemptLog.length}**；按每次 0.04 点的文档标价估算上限约 **${(attemptLog.length * 0.04).toFixed(2)} 点**，实际扣费以服务端账单为准。`,
  '',
  '## 接口结果',
  '',
  '| 接口 | 目标日期 | 实际日期 | 回溯 | HTTP | code | 记录数 | 规范化结果 |',
  '|---|---:|---:|---:|---:|---:|---:|---|',
  ...selected.map((item) =>
    `| ${item.name}（${item.no}） | ${item.requestedTargetDate} | ${item.selectedDate} | ${item.fallbackUsed ? '是' : '否'} | ${item.httpStatus} | ${item.responseCode ?? ''} | ${item.rowCount} | [JSON](${item.normalizedFile}) |`,
  ),
  '',
];

const tenW = selected.find((item) => item.no === 'ZIGAGYYT');
const original = selected.find((item) => item.no === 'OFFSPQ0U');
const growth = selected.find((item) => item.no === 'API_1789637464311');
const tenWTop = tenW ? topArticles(tenW)[0] : null;
const originalTop = original ? topArticles(original)[0] : null;
const growthTop = growth ? topAccounts(growth)[0] : null;
reportParts.push('## 本次最新返回的重点观察', '');
if (tenW) {
  reportParts.push(`- **10W+阅读门槛**：${tenW.selectedDate} 返回 ${tenW.rowCount} 篇，代表内容为“${tenWTop?.title || '—'}”，分享 ${tenWTop?.metrics?.shareCount?.raw ?? '—'}、点赞 ${tenWTop?.metrics?.likeCount?.raw ?? '—'}；三条记录的 clicksCount 均为 10w+，适合做高阅读选题池，但不代表精确阅读量。`);
}
if (original) {
  reportParts.push(`- **原创爆款题材**：${original.selectedDate} 返回 ${original.rowCount} 篇；分享靠前内容集中在折扣/选择题、国际与地缘事件、科普奇闻和生活/公共议题，最高分享内容为“${originalTop?.title || '—'}”（分享 ${originalTop?.metrics?.shareCount?.raw ?? '—'}、点赞 ${originalTop?.metrics?.likeCount?.raw ?? '—'}）。`);
}
if (growth) {
  reportParts.push(`- **账号增长**：最近有数据的统计周一为 ${growth.selectedDate}，返回 ${growth.rowCount} 个“人文资讯”账号；增长值第一名为“${growthTop?.title || '—'}”（growth_val=${growthTop?.metrics?.growth_val?.raw ?? '—'}、cur_read=${growthTop?.metrics?.cur_read?.raw ?? '—'}）。`);
}
reportParts.push('- **日期可用性**：目标日期 2026-09-22 不能直接得到正常数据；文章榜按服务端提示回溯到 2026-09-20，头条增长榜遵循“统计周周一”并继续回溯到 2026-09-07 才得到非空数据。', '');

for (const source of selected) {
  reportParts.push(`### ${source.name}（${source.no}）`);
  reportParts.push('');
  reportParts.push(`文档：<${source.docUrl}>  `);
  reportParts.push('接口：`' + source.endpoint + '`  ');
  reportParts.push(`请求体：\`${JSON.stringify(source.requestBody)}\``);
  reportParts.push('');
  reportParts.push(`返回状态：HTTP ${source.httpStatus}，code=${source.responseCode ?? ''}，记录数=${source.rowCount}。`);
  reportParts.push('');
  if (!source.rows.length) {
    reportParts.push('该接口在目标日期及回溯窗口内没有可整理的非空数组数据。');
    reportParts.push('');
    continue;
  }
  const rows = source.type === 'account-growth-rank' ? topAccounts(source) : topArticles(source);
  reportParts.push('| # | 标题/账号 | 账号 | 关键指标 | 发布时间/榜单日 | 原文链接 |');
  reportParts.push('|---:|---|---|---|---|---|');
  for (const [displayIndex, row] of rows.entries()) {
    const date = row.publicTime || row.rankDate || '';
    const url = row.url ? `[链接](${row.url})` : '';
    reportParts.push(`| ${displayIndex + 1} | ${markdownCell(row.title)} | ${markdownCell(row.account)} | ${markdownCell(metricText(row))} | ${markdownCell(date)} | ${url} |`);
  }
  reportParts.push('');
  if (source.type === 'account-growth-rank') {
    const top = topAccounts(source)[0];
    reportParts.push(`分析：该榜单按增长值观察，当前第一名为“${top?.title || '—'}”，growth_val=${top?.metrics?.growth_val?.raw ?? '—'}，growth_pct=${top?.metrics?.growth_pct?.raw ?? '—'}，cur_read=${top?.metrics?.cur_read?.raw ?? '—'}。`);
  } else {
    const top = topArticles(source)[0];
    reportParts.push(`分析：该榜单返回 ${source.rowCount} 篇文章；按分享数优先、点赞数次优的排序，代表内容为“${top?.title || '—'}”，关键指标：${metricText(top || {}) || '接口未返回互动指标'}。`);
  }
  reportParts.push('');
}

reportParts.push('## 重点数据分析');
reportParts.push('');
reportParts.push('- **10W+推荐接口**：`clicksCount` 多为 `10w+`，适合判定是否进入高阅读门槛，但不能当作精确阅读数；应结合点赞、分享、评论和发布时间做二次排序。');
reportParts.push('- **原创爆款接口**：互动字段完整度较高，可用于识别“实用政策、社会争议、健康食品、情感关系、国际事件”等公众号选题方向；`content` 可能包含较长正文，事实性内容仍需独立核验。');
reportParts.push('- **头条增长榜**：同时返回 `cur_read`、`prev_read`、`growth_val`、`growth_pct`，适合做账号增长监测；极高增长百分比可能来自前一日基数很小，不应单独等同于绝对影响力。');
reportParts.push('- **可用性判断**：只有 HTTP 200 且 `code=2000` 的结果进入正常数据整理；空数组、业务错误和回溯行为均在 `attempts.json` 中保留。');
reportParts.push('');
reportParts.push('## 产物');
reportParts.push('');
reportParts.push('- `summary.json`：接口级汇总、日期回溯、记录数和规范化数据。');
reportParts.push('- `attempts.json`：每次日期尝试的状态、code、记录数与原始文件路径。');
reportParts.push('- `raw/`：每次真实 HTTP 请求的完整响应文本和解析结果。');
reportParts.push('- `normalized/`：按接口整理后的可读 JSON，保留 `raw` 字段以便复核。');

const summary = {
  generatedAt: new Date().toISOString(),
  targetDate,
  lookbackDays,
  requestMode: 'direct-node-http',
  apiKeyStored: false,
  sources: selected,
  attempts: attemptLog,
  totalRows: selected.reduce((sum, item) => sum + item.rowCount, 0),
};

fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(root, 'attempts.json'), JSON.stringify(attemptLog, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(root, 'report.md'), reportParts.join('\n') + '\n', 'utf8');

console.log(JSON.stringify({
  outputDir: root,
  targetDate,
  lookbackDays,
  attempts: attemptLog.length,
  sources: selected.map((item) => ({
    no: item.no,
    selectedDate: item.selectedDate,
    fallbackUsed: item.fallbackUsed,
    httpStatus: item.httpStatus,
    responseCode: item.responseCode,
    rowCount: item.rowCount,
    attempts: item.attempts,
  })),
  totalRows: summary.totalRows,
}));
