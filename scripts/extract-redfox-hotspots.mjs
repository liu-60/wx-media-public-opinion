import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(
  process.env.REDFOX_AUDIT_OUTPUT ||
    path.join(process.cwd(), 'reports', 'redfox-api-audit-20260921'),
);
const catalog = JSON.parse(
  fs.readFileSync(path.join(root, 'response-catalog.json'), 'utf8'),
);
const outputJson = path.join(root, 'hotspot-summary.json');
const outputReport = path.join(root, 'hotspot-summary.md');

const sourceDefinitions = [
  { no: 'S28Q6HUD', label: '抖音热点榜（platform=2）', group: '抖音热点' },
  { no: 'W94P1QH1', label: '全网关键词热搜（三星）', group: '跨平台关键词' },
  { no: 'HUCIASU', label: '抖音每日热门作品榜', group: '抖音热点' },
  { no: 'WD6UT8DQ', label: '抖音每日点赞飙升榜', group: '抖音热点' },
  { no: '0ZB9S2FW', label: '抖音七日点赞飙升榜', group: '抖音热点' },
  { no: '20060017', label: '抖音热门账号推荐', group: '热门账号' },
  { no: '3X8FGEEM', label: '小红书爆款笔记洞察', group: '小红书热点' },
  { no: 'P3W2W18P', label: '小红书黑马爆文榜', group: '小红书热点' },
  { no: 'AEA6YE0J', label: '小红书每日爆款笔记榜', group: '小红书热点' },
  { no: 'ZIGAGYYT', label: '公众号 10W+ 文章推荐', group: '公众号热点' },
  { no: 'OFFSPQ0U', label: '公众号原创爆款文章推荐', group: '公众号热点' },
  { no: 'DL4YNCTQ', label: '公众号阅读增长榜', group: '公众号热点' },
  { no: 'API_1789637464311', label: '公众号头条增长榜', group: '公众号热点' },
];

const clusterRules = [
  {
    name: '芯片/存储/三星',
    regex: /三星|海力士|美光|芯片|内存|折叠|手机布局|显示器|长鑫/i,
  },
  {
    name: '灾害/公共安全',
    regex: /泥石流|山洪|失联|遇难|安全|绑|特勤|灾情/i,
  },
  {
    name: 'AI/智能/Agent',
    regex: /AI|AIGC|Agent|智能|机器人|数字产业|投研/i,
  },
  {
    name: '动漫/游戏/明星娱乐',
    regex: /熊出没|白蛇传|许仙|妲己|动漫|二次元|漫威|王者|韩雪|明星|cos|世界杯/i,
  },
  {
    name: '生活/消费/健康',
    regex: /公积金|拉面|白菜|饮食|养脑|糖尿病|香香|育儿|消费观|五折|鞋|女装/i,
  },
  {
    name: '情绪/关系/职场',
    regex: /感动|浪漫|天赋|哭|婚恋|脆弱|面试|职场|真实|时间贫困/i,
  },
];

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value).trim().replaceAll(',', '');
  if (!text || text === '-' || text === 'null') return null;
  let multiplier = 1;
  if (/亿/i.test(text)) multiplier = 100000000;
  else if (/万|w/i.test(text)) multiplier = 10000;
  text = text.replace(/[^\d.+-]/g, '');
  const number = Number(text);
  return Number.isFinite(number) ? number * multiplier : null;
}

function shortText(value, max = 180) {
  const text = value === null || value === undefined ? '' : String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function titleOf(item) {
  if (!item || typeof item !== 'object') return String(item ?? '');
  const keys = [
    'title',
    'topic',
    'aweme_desc',
    'articleTitle',
    'content',
    'summary',
    'accountName',
    'userName',
    'nickname',
    'authorName',
  ];
  for (const key of keys) {
    if (item[key] !== undefined && item[key] !== null && String(item[key]).trim()) {
      return shortText(item[key], 240);
    }
  }
  return '';
}

function urlOf(item) {
  if (!item || typeof item !== 'object') return null;
  for (const key of [
    'url',
    'workUrl',
    'share_url',
    'shareUrl',
    'oriUrl',
    'articleUrl',
    'opusUrl',
    'accountLink',
  ]) {
    if (item[key]) return item[key];
  }
  return null;
}

function metricsOf(item) {
  if (!item || typeof item !== 'object') return {};
  const keys = [
    'hotCount',
    'totalInteractiveCount',
    'interactiveCount',
    'likeCount',
    'like_count',
    'add_digg_count',
    'shareCount',
    'add_share_count',
    'commentCount',
    'commentsCount',
    'add_comment_count',
    'collectCount',
    'collectedCount',
    'add_collect_count',
    'clicksCount',
    'growthRate',
    'growth_pct',
    'growth_val',
    'cur_read',
    'viewCount',
    'playCount',
    'followerCount',
    'fansCount',
  ];
  const output = {};
  for (const key of keys) {
    if (item[key] !== undefined && item[key] !== null && item[key] !== '') {
      const value = parseNumber(item[key]);
      output[key] = { raw: item[key], numeric: value };
    }
  }
  return output;
}

function metricScore(metrics) {
  const priority = [
    'hotCount',
    'totalInteractiveCount',
    'interactiveCount',
    'add_digg_count',
    'likeCount',
    'like_count',
    'growth_val',
    'growthRate',
    'cur_read',
    'clicksCount',
  ];
  for (const key of priority) {
    if (metrics[key]?.numeric !== null && metrics[key]?.numeric !== undefined) {
      return metrics[key].numeric;
    }
  }
  return null;
}

function requestInfo(raw) {
  return raw.requestBody || raw.query || null;
}

function dateInfo(raw) {
  const input = requestInfo(raw);
  if (!input || typeof input !== 'object') return '';
  return Object.entries(input)
    .filter(([key]) => /date|time|rank/i.test(key))
    .map(([key, value]) => key + '=' + String(value))
    .join('; ');
}

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^\p{Script=Han}a-z0-9]+/giu, '');
}

function arraysFromResponse(def, raw) {
  const data = raw.response?.data;
  if (def.no === '3X8FGEEM' && data && typeof data === 'object') {
    return ['hotTopics', 'latestHotArticles', 'articles']
      .filter((key) => Array.isArray(data[key]))
      .map((key) => [key, data[key]]);
  }
  if (def.no === 'W94P1QH1' && data && typeof data === 'object') {
    return Object.entries(data).filter(([, value]) => Array.isArray(value));
  }
  if (Array.isArray(data)) return [['data', data]];
  if (data && typeof data === 'object') {
    const preferred = [
      'list',
      'workList',
      'accountList',
      'userList',
      'videos',
      'tweets',
      'comments',
      'items',
      'dataList',
    ];
    const selected = [];
    for (const key of preferred) {
      if (Array.isArray(data[key])) selected.push([key, data[key]]);
    }
    if (selected.length) return selected;
    return Object.entries(data).filter(([, value]) => Array.isArray(value));
  }
  return [];
}

function sourceRecords(def, raw) {
  const groups = arraysFromResponse(def, raw);
  const records = [];
  for (const [subgroup, items] of groups) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!item || typeof item !== 'object') continue;
      const metrics = metricsOf(item);
      records.push({
        sourceNo: def.no,
        source: def.label,
        group: def.group,
        subgroup,
        rank: item.index ?? item.rankPosition ?? index + 1,
        title: titleOf(item),
        category: item.category || item.author_type || item.type || null,
        metrics,
        metricScore: metricScore(metrics),
        date: item.rankDate || item.rank_date_str || item.gmtCreate || item.publicTime || item.createTime || null,
        url: urlOf(item),
        raw: item,
      });
    }
  }
  return records;
}

const byNo = new Map(catalog.interfaces.map((item) => [item.no, item]));
const sources = [];
const records = [];
for (const def of sourceDefinitions) {
  const catalogItem = byNo.get(def.no);
  if (!catalogItem) {
    sources.push({ ...def, status: 'missing' });
    continue;
  }
  const responsePath = path.join(root, catalogItem.responseFile.replaceAll('/', path.sep));
  const raw = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
  if (catalogItem.usabilityLevel !== '高') {
    sources.push({
      ...def,
      status: 'skipped',
      usabilityLevel: catalogItem.usabilityLevel,
      reason: catalogItem.usabilityReason,
    });
    continue;
  }
  const sourceRecordsValue = sourceRecords(def, raw);
  records.push(...sourceRecordsValue);
  sources.push({
    ...def,
    status: 'processed',
    usabilityLevel: catalogItem.usabilityLevel,
    request: requestInfo(raw),
    dateInfo: dateInfo(raw),
    recordCount: sourceRecordsValue.length,
    responseFile: catalogItem.responseFile,
  });
}

const topBySource = {};
for (const source of sources.filter((item) => item.status === 'processed')) {
  const sourceRows = records
    .filter((row) => row.sourceNo === source.no)
    .sort((a, b) => {
      const aScore = a.metricScore ?? -1;
      const bScore = b.metricScore ?? -1;
      return bScore - aScore || Number(a.rank) - Number(b.rank);
    });
  topBySource[source.no] = sourceRows.slice(0, 10);
}

const clusters = clusterRules.map((rule) => {
  const matches = records.filter((record) => rule.regex.test(record.title + ' ' + (record.category || '')));
  const sourceSet = new Set(matches.map((record) => record.sourceNo));
  const top = [...matches]
    .sort((a, b) => (b.metricScore ?? -1) - (a.metricScore ?? -1))
    .slice(0, 8)
    .map((record) => ({
      source: record.source,
      sourceNo: record.sourceNo,
      title: record.title,
      category: record.category,
      metricScore: record.metricScore,
      metrics: record.metrics,
      date: record.date,
      url: record.url,
    }));
  return {
    name: rule.name,
    evidenceCount: matches.length,
    sourceCount: sourceSet.size,
    sources: [...sourceSet],
    top,
  };
});

const duplicateGroups = Object.values(
  records.reduce((acc, record) => {
    const key = normalizeTitle(record.title);
    if (!key || key.length < 8) return acc;
    (acc[key] ||= []).push(record);
    return acc;
  }, {}),
)
  .filter((group) => new Set(group.map((record) => record.sourceNo)).size >= 2)
  .sort((a, b) => b.length - a.length)
  .slice(0, 20)
  .map((group) => ({
    title: group[0].title,
    sourceCount: new Set(group.map((record) => record.sourceNo)).size,
    evidence: group.map((record) => ({
      source: record.source,
      sourceNo: record.sourceNo,
      metricScore: record.metricScore,
      url: record.url,
    })),
  }));

const categoryCounts = {};
for (const record of records) {
  if (record.category) categoryCounts[record.category] = (categoryCounts[record.category] || 0) + 1;
}

const result = {
  generatedAt: new Date().toISOString(),
  sourceSnapshot: '2026-09-21 open-cli audit artifacts',
  highUsabilityOnly: true,
  processedSources: sources.filter((source) => source.status === 'processed').length,
  recordCount: records.length,
  note: '热点聚类根据本次真实返回的标题、话题和分类做规则归类；不同平台的 hotCount、点赞、互动量不可直接相加。',
  sources,
  records,
  topBySource,
  clusters,
  duplicateGroups,
  categoryCounts,
};

fs.writeFileSync(outputJson, JSON.stringify(result, null, 2) + '\n', 'utf8');

function displayMetric(record) {
  const entries = Object.entries(record.metrics || {}).filter(([, value]) => value?.raw !== undefined);
  if (!entries.length) return '';
  const preferred = entries.slice(0, 3).map(([key, value]) => key + '=' + value.raw);
  return preferred.join('；');
}

const clusterTable = clusters
  .filter((cluster) => cluster.evidenceCount)
  .sort((a, b) => b.sourceCount - a.sourceCount || b.evidenceCount - a.evidenceCount)
  .map(
    (cluster) =>
      '| ' +
      cluster.name +
      ' | ' +
      cluster.evidenceCount +
      ' | ' +
      cluster.sourceCount +
      ' | ' +
      cluster.top
        .slice(0, 3)
        .map((item) => shortText(item.title, 70))
        .join('；') +
      ' |',
  )
  .join('\n');

const sourceSections = sources
  .filter((source) => source.status === 'processed')
  .map((source) => {
    const rows = topBySource[source.no] || [];
    const table = rows
      .map(
        (record, index) =>
          '| ' +
          (index + 1) +
          ' | ' +
          shortText(record.title, 110) +
          ' | ' +
          (record.category || '') +
          ' | ' +
          displayMetric(record) +
          ' | ' +
          (record.date || '') +
          ' | ' +
          (record.url ? '[' + record.url.slice(0, 50) + '…](' + record.url + ')' : '') +
          ' |',
      )
      .join('\n');
    return (
      '### ' +
      source.label +
      '\n\n' +
      '接口：' +
      source.no +
      '；返回记录：' +
      source.recordCount +
      '；请求时间/参数：' +
      (source.dateInfo || JSON.stringify(source.request)) +
      '\n\n' +
      '| # | 标题/主题 | 分类 | 主要指标 | 数据时间 | 链接 |\n|---:|---|---|---|---|---|\n' +
      table +
      '\n'
    );
  })
  .join('\n');

const topClusterDetails = clusters
  .filter((cluster) => cluster.evidenceCount)
  .sort((a, b) => b.sourceCount - a.sourceCount || b.evidenceCount - a.evidenceCount)
  .map((cluster) => {
    const detail = cluster.top
      .slice(0, 5)
      .map(
        (item) =>
          '- ' +
          item.source +
          '：' +
          item.title +
          (item.metricScore !== null && item.metricScore !== undefined ? '（主指标约 ' + item.metricScore + '）' : ''),
      )
      .join('\n');
    return '### ' + cluster.name + '\n\n' + detail;
  })
  .join('\n\n');

const duplicateSection =
  duplicateGroups
    .slice(0, 10)
    .map(
      (group) =>
        '- ' +
        group.title +
        '：' +
        group.evidence.map((item) => item.source).join('、'),
    )
    .join('\n') || '无明显跨源重复标题。';

const report =
  '# 本次请求热点信息汇总\n\n' +
  '生成时间：' +
  new Date().toISOString() +
  '\n\n' +
  '## 口径说明\n\n' +
  '- 仅处理可用性评级为“高”的真实返回；没有重新请求接口。\n' +
  '- 数据来自 2026-08-11 至 2026-09-08 的多个请求快照，不等于 2026-09-22 当日实时热搜。\n' +
  '- 不同平台的热度、点赞、互动量口径不同，以下做平台内排序；跨平台只比较覆盖平台数和主题重复度，不直接相加数值。\n' +
  '- “热点聚类”依据标题、话题和分类的关键词规则归纳，适合选题发现，不替代事实核验。\n\n' +
  '## 核心热点判断\n\n' +
  '1. **公共安全/灾害信息是抖音热点榜的强热点**：抖音热点榜（platform=2）前列集中出现“西藏吉隆口岸泥石流”“西藏泥石流已致265人失联3人遇难”“尼泊尔山洪已致16死数百游客失联”等，榜单主指标约 1,164 万至 1,197 万。\n' +
  '2. **三星—海力士—内存/芯片是跨平台共振主题**：关键词热搜在百度、B站、快手、头条、微博、知乎均出现相关结果；但该结论受本次查询关键词“三星”强约束，不能直接当作无偏全网榜。\n' +
  '3. **动漫/IP/娱乐内容在抖音互动榜表现突出**：白蛇传、熊出没、妲己、漫威、韩雪等内容多次进入热门或点赞飙升结果；“熊出没”在抖音每日热门/七日飙升榜均出现，具备重复验证信号。\n' +
  '4. **AI/Agent 有内容机会，但热度证据偏专题化**：小红书 AIGC 创业洞察返回“Fable 5 搭投研 Agent”等内容，抖音点赞飙升榜出现 AI 短片；目前更适合做垂直选题，不宜据此判断为全网第一热点。\n' +
  '5. **知识、消费和生活问题在公众号爆款中持续出现**：公积金、健康、婚恋、区域消费差异、食品安全、旅行/育儿等题材具有较强点击和分享导向，适合做解释型、实用型内容。\n\n' +
  '## 主题聚类\n\n' +
  '| 主题 | 证据条数 | 覆盖接口数 | 代表内容 |\n|---|---:|---:|---|\n' +
  clusterTable +
  '\n\n' +
  topClusterDetails +
  '\n\n' +
  '## 跨接口重复信号\n\n' +
  duplicateSection +
  '\n\n' +
  '## 热点数据来源与代表榜单\n\n' +
  sourceSections +
  '\n' +
  '## 应用建议\n\n' +
  '- **优先跟进**：公共安全/灾害、芯片存储/三星、动漫 IP/怀旧、AI Agent、实用知识这五类主题。\n' +
  '- **选题策略**：公共安全类优先做事实梳理和进展跟踪；芯片类做影响解释；动漫/娱乐类做二创与情绪点；AI 类做工具实测和案例；公众号知识类做“问题—解释—行动建议”。\n' +
  '- **数据接入**：保存 sourceNo、rank、请求时间、原始热度字段和 URL；对同题跨平台结果去重，但保留平台证据，不把异构热度求和。\n' +
  '- **时效提醒**：当前快照最晚主要到 2026-09-08，若要发布“今日热点”，需重新请求实时榜单或补采当天数据。\n\n' +
  '## 机器可读产物\n\n' +
  '- hotspot-summary.json：全部热点来源、完整候选记录、主题聚类和跨源重复信号。\n' +
  '- 对应完整响应见 all-responses.json 或 responses/ 目录。\n';

fs.writeFileSync(outputReport, report, 'utf8');
console.log(
  JSON.stringify(
    {
      outputReport,
      outputJson,
      processedSources: sources.filter((source) => source.status === 'processed').length,
      recordCount: records.length,
      clusterSummary: clusters.map((cluster) => ({
        name: cluster.name,
        evidenceCount: cluster.evidenceCount,
        sourceCount: cluster.sourceCount,
      })),
    },
    null,
    2,
  ),
);
