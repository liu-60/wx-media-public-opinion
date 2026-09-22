import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(
  process.env.REDFOX_GZH_OUTPUT ||
    path.join(process.cwd(), 'reports', 'redfox-gzh-latest-20260922'),
);
const normalizedDir = path.join(root, 'normalized');
const outputJson = path.join(root, 'db-fit-analysis.json');
const outputMd = path.join(root, 'db-fit-analysis.md');
const schemaEvidence = 'docs/config-center-prompt-pack-20260920/04-数据库事实与约束.md';

const articleSourceNos = ['ZIGAGYYT', 'OFFSPQ0U'];
const growthSourceNo = 'API_1789637464311';
const normalized = Object.fromEntries(
  [...articleSourceNos, growthSourceNo].map((no) => [
    no,
    JSON.parse(fs.readFileSync(path.join(normalizedDir, `${no}.json`), 'utf8')),
  ]),
);

const isPresent = (value) => value !== undefined && value !== null && String(value).trim() !== '';
const rawOf = (row, key) => row?.raw?.[key];
const ratio = (count, total) => (total ? Number((count / total * 100).toFixed(1)) : 0);

function urlParam(row, key) {
  try {
    return new URL(String(rawOf(row, 'oriUrl') || '')).searchParams.get(key) || '';
  } catch {
    return '';
  }
}

function articleKey(row) {
  const biz = urlParam(row, '__biz');
  const sn = urlParam(row, 'sn');
  return biz && sn ? `${biz}|${sn}` : '';
}

function exactNumeric(value) {
  return /^[0-9]+$/.test(String(value ?? '').trim());
}

function count(rows, predicate) {
  return rows.filter(predicate).length;
}

function coverage(rows, field, transform = (row) => rawOf(row, field)) {
  const present = count(rows, (row) => isPresent(transform(row)));
  return { present, total: rows.length, percent: ratio(present, rows.length) };
}

const articleRows = articleSourceNos.flatMap((no) => normalized[no].rows);
const uniqueArticles = new Map();
for (const row of articleRows) {
  const key = articleKey(row) || `${normalized[row.sourceNo]?.selectedDate || ''}|${row.rank}|${row.title}`;
  if (!uniqueArticles.has(key)) uniqueArticles.set(key, row);
}
const uniqueArticleRows = [...uniqueArticles.values()];
const uniqueArticleKeys = new Set(articleRows.map(articleKey).filter(Boolean));
const uniqueWxBiz = new Set(articleRows.map((row) => urlParam(row, '__biz')).filter(Boolean));
const duplicateGroups = Object.entries(
  articleRows.reduce((map, row) => {
    const key = articleKey(row);
    if (key) map[key] = (map[key] || 0) + 1;
    return map;
  }, {}),
).filter(([, countValue]) => countValue > 1);

const articleMapping = [
  { source: 'oriUrl.__biz', target: 'accounts.wx_biz / identity join', semantic: 'derived', coverage: coverage(articleRows, '__biz', (row) => urlParam(row, '__biz')), verdict: '可用，但必须先按精确 wx_biz 查找/创建账号' },
  { source: 'oriUrl.sn', target: 'articles.article_sn', semantic: 'derived', coverage: coverage(articleRows, 'sn', (row) => urlParam(row, 'sn')), verdict: '可用，需从 URL 提取' },
  { source: 'title', target: 'articles.title', semantic: 'direct', coverage: coverage(articleRows, 'title'), verdict: '可直接映射' },
  { source: 'oriUrl', target: 'articles.article_url', semantic: 'direct', coverage: coverage(articleRows, 'oriUrl'), verdict: '可直接映射' },
  { source: 'publicTime', target: 'articles.published_at', semantic: 'direct+normalize', coverage: coverage(articleRows, 'publicTime'), verdict: '可直接映射，需转 timestamptz' },
  { source: 'likeCount', target: 'articles.like_num', semantic: 'direct+integer', coverage: coverage(articleRows, 'likeCount'), verdict: '可直接映射' },
  { source: 'watchCount', target: 'articles.look_num', semantic: 'direct+integer', coverage: coverage(articleRows, 'watchCount'), verdict: '可直接映射' },
  { source: 'shareCount', target: 'articles.share_num', semantic: 'direct+integer', coverage: coverage(articleRows, 'shareCount'), verdict: '可直接映射' },
  { source: 'commentCount', target: 'articles.comment_num', semantic: 'direct+integer', coverage: coverage(articleRows, 'commentCount'), verdict: '缺失时保留 NULL' },
  { source: 'clicksCount', target: 'articles.read_num', semantic: 'mixed exact/capped', coverage: coverage(articleRows, 'clicksCount'), verdict: '必须区分精确值与 w+/万+ 截断值' },
  { source: 'clicksCount with digits', target: 'articles.read_num', semantic: 'exact subset', coverage: coverage(articleRows, 'clicksCount', (row) => exactNumeric(rawOf(row, 'clicksCount')) ? rawOf(row, 'clicksCount') : ''), verdict: '37 条可转整数' },
  { source: 'clicksCount with 万/w/亿', target: 'articles.read_num_capped', semantic: 'capped marker', coverage: coverage(articleRows, 'clicksCount', (row) => /万|w|亿/i.test(String(rawOf(row, 'clicksCount') ?? '')) ? rawOf(row, 'clicksCount') : ''), verdict: '16 条必须标记 capped，不得当精确阅读数' },
  { source: 'originalFlag', target: 'articles.is_original', semantic: '0/1 to boolean', coverage: coverage(articleRows, 'originalFlag'), verdict: '可映射为 false/true' },
  { source: 'orderNum', target: 'articles.idx', semantic: 'unsafe', coverage: coverage(articleRows, 'orderNum'), verdict: '返回值含 0；当前 CHECK 要求正数，不能原样写入' },
  { source: 'userName', target: 'accounts.wx_name', semantic: 'candidate', coverage: coverage(articleRows, 'userName'), verdict: '可作为名称候选，但不能替代 wx_biz' },
  { source: 'userHeadUrl', target: 'account_profiles.avatar', semantic: 'candidate', coverage: coverage(articleRows, 'userHeadUrl'), verdict: '48/53 有值；需按账号聚合后再写' },
  { source: 'type', target: 'account_profiles.wx_type', semantic: 'semantic mismatch', coverage: coverage(articleRows, 'type'), verdict: '这是文章分类“知识百科”，不能直接当账号类型' },
  { source: 'content / summary', target: 'current six tables', semantic: 'no target column', coverage: coverage(articleRows, 'content'), verdict: '当前 schema 无正文/摘要字段；保留原始响应或不入库' },
  { source: 'coverUrl / photoId', target: 'current six tables', semantic: 'no target column', coverage: coverage(articleRows, 'coverUrl'), verdict: '当前 schema 无封面/来源照片字段；不扩表时不入库' },
];

const growthRows = normalized[growthSourceNo].rows;
const metricKeys = ['likeCount', 'watchCount', 'shareCount', 'commentCount'];
const validation = {
  invalidPublicTime: count(articleRows, (row) => Number.isNaN(new Date(String(rawOf(row, 'publicTime') || '')).getTime())),
  negativeMetrics: Object.fromEntries(metricKeys.map((key) => [
    key,
    count(articleRows, (row) => isPresent(rawOf(row, key)) && Number(String(rawOf(row, key)).replaceAll(',', '')) < 0),
  ])),
  zeroOrderNum: count(articleRows, (row) => Number(rawOf(row, 'orderNum')) === 0),
  originalFlagValues: [...new Set(articleRows.map((row) => rawOf(row, 'originalFlag')))],
};
const growthMapping = [
  { source: 'nickname', target: 'accounts.wx_name', coverage: coverage(growthRows, 'nickname'), verdict: '名称可读，但无 wx_biz，不能安全 upsert' },
  { source: 'account_id', target: 'accounts.account_id', coverage: coverage(growthRows, 'account_id'), verdict: '外部榜单 ID 不应假定为当前库 identity 主键' },
  { source: 'author_type', target: 'account_profiles.wx_type', coverage: coverage(growthRows, 'author_type'), verdict: '人文资讯是榜单分类，不等同账号类型' },
  { source: 'cur_read / prev_read', target: 'current account/profile fields', coverage: coverage(growthRows, 'cur_read'), verdict: '当前 schema 无历史周期阅读字段；仅分析使用' },
  { source: 'growth_val / growth_pct', target: 'current account/profile fields', coverage: coverage(growthRows, 'growth_val'), verdict: '当前 schema 无增长值/增长率字段；仅分析使用' },
  { source: 'rank_date', target: 'account_profiles.collected_at', coverage: coverage(growthRows, 'rank_date'), verdict: '统计日期不等于采集时间，不应混写' },
];

const tableFit = {
  accounts: {
    directResponseWritableRows: 0,
    afterWxBizDerivation: uniqueWxBiz.size,
    evidence: '文章 URL 可提取 wx_biz；最终仍需现有 accounts 精确查找，account_id 由数据库/现有 sink 管理',
    missingOrUnsafe: ['verify', 'description', 'read_median', 'read_max', 'decision_status', 'decision_source', 'filter_rule_id'],
  },
  account_profiles: {
    directResponseWritableRows: 0,
    candidateAvatarRows: count(articleRows, (row) => isPresent(rawOf(row, 'userHeadUrl'))),
    evidence: '返回为文章级数据，画像统计字段不全；需按 wx_biz 聚合后再写',
    missingOrUnsafe: ['account_id', 'wx_user', 'wx_type semantic check', 'region', 'pub_count', 'active_days', 'read_avg/read_median/read_max', 'like/share/comment aggregates'],
  },
  articles: {
    returnedRows: articleRows.length,
    uniqueRows: uniqueArticleRows.length,
    directWritableRows: 0,
    afterIdentityResolutionRows: uniqueArticleRows.length,
    duplicateRows: articleRows.length - uniqueArticleRows.length,
    evidence: '核心身份字段需要从 oriUrl 派生，并通过 wx_biz 解析当前库 account_id；本报告未执行生产写入',
    missingOrUnsafe: ['account_id direct missing', 'read_num partly capped', 'idx orderNum often 0', 'source_code absent'],
  },
  hotwords: {
    directResponseWritableRows: 0,
    candidateArticleRows: uniqueArticleRows.length,
    evidence: '接口没有返回 hotword/article_count/article_keys；可在文章去重并验收后复用现有 hotwords 聚合逻辑',
    constraint: 'hotwords.article_count >= 2 and unique(hotword, stat_date)',
  },
  filter_rules: { directResponseWritableRows: 0, evidence: '配置表，不是这三个接口的返回数据目标' },
  collection_strategy_groups: { directResponseWritableRows: 0, evidence: '策略配置表，不是这三个接口的返回数据目标' },
};

const utilization = [
  {
    no: 'ZIGAGYYT',
    name: normalized.ZIGAGYYT.name,
    returnedRows: normalized.ZIGAGYYT.rowCount,
    actualDate: normalized.ZIGAGYYT.selectedDate,
    useLevel: '中高',
    directUse: '小规模文章/选题发现；文章核心字段完整，但阅读数全部为 10w+ 截断值',
    limitation: '只有 3 条；不能提供精确 read_num；仍需 wx_biz→account_id 解析',
  },
  {
    no: 'OFFSPQ0U',
    name: normalized.OFFSPQ0U.name,
    returnedRows: normalized.OFFSPQ0U.rowCount,
    actualDate: normalized.OFFSPQ0U.selectedDate,
    useLevel: '高',
    directUse: '主力文章候选池、互动指标分析、后续热词聚合',
    limitation: '评论字段缺失 14/50；阅读值 13/50 为万级截断；需去重和身份解析',
  },
  {
    no: growthSourceNo,
    name: normalized[growthSourceNo].name,
    returnedRows: normalized[growthSourceNo].rowCount,
    actualDate: normalized[growthSourceNo].selectedDate,
    useLevel: '中（分析）/低（入库）',
    directUse: '账号增长监测、账号发现、榜单趋势分析',
    limitation: '没有 wx_biz；增长值/增长率/统计日期在当前六表没有专用存储字段',
  },
];

const result = {
  generatedAt: new Date().toISOString(),
  sourceReport: 'reports/redfox-gzh-latest-20260922',
  schemaEvidence,
  articleRows: articleRows.length,
  uniqueArticleRows: uniqueArticleRows.length,
  duplicateRows: articleRows.length - uniqueArticleRows.length,
  uniqueWxBiz: uniqueWxBiz.size,
  duplicateGroups,
  articleMapping,
  growthMapping,
  tableFit,
  validation,
  utilization,
  conclusions: {
    directWrite: '三个接口均不适合把原始返回直接 POST 到当前数据库；articles 至少需要 URL 身份解析、去重、account_id 查找和数值归一化。',
    bestIngestionSource: 'OFFSPQ0U',
    bestMonitoringSource: 'API_1789637464311',
    bestSmallSampleSource: 'ZIGAGYYT',
    hotwordsPath: 'articles accepted -> title/content normalization -> existing hotwords aggregation -> article_count>=2 check -> merge',
  },
};

function cell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

const md = [
  '# 三个公众号接口与当前数据库字段适配及利用率分析',
  '',
  `生成时间：${result.generatedAt}`,
  '',
  `数据库 schema 依据：\`${schemaEvidence}\`。本分析只读使用已保存的 73 条真实返回，不执行数据库写入。`,
  '',
  '## 结论',
  '',
  '- **不能直接入库**：三个接口的原始返回都不能直接写入当前六表；`articles.account_id` 是非空外键，接口未直接返回当前库的内部 `account_id`。',
  '- **文章数据可适配**：两个文章接口合计 53 条，按公众号文章 URL 的 `__biz + sn` 去重后为 52 条，48 个公众号身份；完成身份解析后，文章核心字段具备入库基础。',
  '- **OFFSPQ0U 利用率最高**：50 条文章且互动字段较完整，适合作为文章候选池和热词聚合输入；`ZIGAGYYT` 更适合小规模高阅读选题发现。',
  '- **API_1789637464311 主要是分析接口**：20 条增长榜数据字段完整，但当前 schema 没有增长值/增长率/统计周期专用字段，且缺 `wx_biz`，不适合直接持久化。',
  '',
  '## 量化结果',
  '',
  '| 指标 | 结果 | 说明 |',
  '|---|---:|---|',
  `| 文章接口返回行数 | ${articleRows.length} | ZIGAGYYT 3 + OFFSPQ0U 50 |`,
  `| 去重后文章数 | ${uniqueArticleRows.length} | 按 URL 的 __biz + sn 去重；重复 ${articleRows.length - uniqueArticleRows.length} 条 |`,
  `| 可提取 wx_biz 的文章行 | ${count(articleRows, (row) => isPresent(urlParam(row, '__biz')))} / ${articleRows.length} | 100%，但仍需查当前 accounts |`,
  `| 可提取 article_sn 的文章行 | ${count(articleRows, (row) => isPresent(urlParam(row, 'sn')))} / ${articleRows.length} | 100%，来源为 URL sn |`,
  `| 精确数字阅读值 | ${count(articleRows, (row) => exactNumeric(rawOf(row, 'clicksCount')))} / ${articleRows.length} | 37 条；其余为万/w/亿截断表达 |`,
  `| 截断阅读值 | ${count(articleRows, (row) => /万|w|亿/i.test(String(rawOf(row, 'clicksCount') ?? '')))} / ${articleRows.length} | 16 条；必须设置 read_num_capped 语义 |`,
  `| 评论字段非空 | ${count(articleRows, (row) => isPresent(rawOf(row, 'commentCount')))} / ${articleRows.length} | 39 条；14 条缺失 |`,
  `| 头条增长榜记录 | ${growthRows.length} | 20 条，字段完整但无当前表对应历史增长存储 |`,
  `| publicTime 无效值 | ${validation.invalidPublicTime} | 文章 published_at 转换预检 |`,
  `| like/watch/share/comment 负数 | ${Object.values(validation.negativeMetrics).reduce((sum, value) => sum + value, 0)} | 当前样本未发现负数 |`,
  `| orderNum=0 | ${validation.zeroOrderNum} | articles.idx CHECK 要求正数或 NULL |`,
  '',
  '## 文章接口字段映射',
  '',
  '| 返回字段/派生字段 | 当前数据库目标 | 覆盖 | 结论 |',
  '|---|---|---:|---|',
  ...articleMapping.map((item) => `| ${cell(item.source)} | ${cell(item.target)} | ${item.coverage.present}/${item.coverage.total}（${item.coverage.percent}%） | ${cell(item.verdict)} |`),
  '',
  '## 增长榜字段映射',
  '',
  '| 返回字段 | 当前数据库目标 | 覆盖 | 结论 |',
  '|---|---|---:|---|',
  ...growthMapping.map((item) => `| ${cell(item.source)} | ${cell(item.target)} | ${item.coverage.present}/${item.coverage.total}（${item.coverage.percent}%） | ${cell(item.verdict)} |`),
  '',
  '## 按表判断',
  '',
  '| 表 | 直接写入 | 适配后用途 | 关键阻塞 |',
  '|---|---|---|---|',
  `| accounts | 0 条直接可写 | 从文章 URL 派生 wx_biz，精确查找/创建账号；名称可作为候选 | 接口没有当前库 account_id；增长榜没有 wx_biz |`,
  `| account_profiles | 0 条直接可写 | 聚合头像、最近发文时间等候选信息 | 缺画像统计字段；文章级 userHeadUrl 需按账号聚合 |`,
  `| articles | 0 条原始直写；${uniqueArticleRows.length}/${uniqueArticleRows.length} 条去重后具备适配基础 | 文章候选池、互动分析、后续热词输入 | account_id 查找、article_sn 派生、阅读截断、评论缺失 |`,
  '| hotwords | 0 条直接可写 | 文章验收后调用现有热词聚合逻辑 | 返回没有 hotword/article_count/article_keys；需满足 article_count>=2 |',
  '| filter_rules | 0 | 配置表，不是接口数据目标 | 不应把榜单字段写入规则表 |',
  '| collection_strategy_groups | 0 | 配置/调度表，不是接口数据目标 | 不应把返回记录当策略配置 |',
  '',
  '## 接口利用率',
  '',
  '| 接口 | 利用等级 | 最适合用途 | 不适合用途 |',
  '|---|---|---|---|',
  ...utilization.map((item) => `| ${item.name}（${item.no}） | ${item.useLevel} | ${cell(item.directUse)} | ${cell(item.limitation)} |`),
  '',
  '## 建议接入链路',
  '',
  '1. 只把 `OFFSPQ0U` 和 `ZIGAGYYT` 作为文章候选源：提取 `oriUrl` 的 `__biz`、`sn`，按 `(wx_biz, article_sn)` 去重。',
  '2. 通过现有 `accounts.wx_biz` 精确解析 `account_id`；找不到账号时走现有文章发现账号逻辑，不伪造内部主键。',
  '3. 将 `publicTime` 转换为 `published_at`，互动字段转整数；`clicksCount=10w+` 等值保留下限/标记，不当精确阅读数。',
  '4. 文章入库前保留 `comment_num=NULL`、`source_code=NULL` 等允许缺失字段；不要把 `orderNum=0` 原样写入 `articles.idx`。',
  '5. `API_1789637464311` 先作为只读增长监测源；若要长期保存增长历史，应先设计独立历史存储或明确复用现有表的业务语义，不直接覆盖 `read_max/read_median`。',
  '',
  '## 限制',
  '',
  '- 本次只做 schema 对照和离线计算，没有向 Supabase 生产表写入，也没有验证每一个 `wx_biz` 在当前数据库中是否已存在。',
  '- “适配后具备入库基础”不等于写入成功；最终仍需在隔离/可回滚流程中做账号查找、唯一键冲突、触发器和读回验证。',
  '',
].join('\n');

fs.writeFileSync(outputJson, JSON.stringify(result, null, 2) + '\n', 'utf8');
fs.writeFileSync(outputMd, md, 'utf8');
console.log(JSON.stringify({ outputJson, outputMd, articleRows: articleRows.length, uniqueArticleRows: uniqueArticleRows.length, uniqueWxBiz: uniqueWxBiz.size, growthRows: growthRows.length }));
