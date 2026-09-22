import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(
  process.env.REDFOX_AUDIT_OUTPUT ||
    path.join(process.cwd(), 'reports', 'redfox-api-audit-20260921'),
);
const responseDir = path.join(root, 'responses');
const summaryPath = path.join(root, 'summary.json');
const reportPath = path.join(root, 'data-usability.md');
const catalogPath = path.join(root, 'response-catalog.json');
const allResponsesPath = path.join(root, 'all-responses.json');

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function shortText(value, max = 220) {
  const text = value === null || value === undefined ? '' : String(value);
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isMeaningfulValue(value) {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return true;
}

function collectArrays(value, currentPath, out) {
  if (Array.isArray(value)) {
    const items = value;
    const objectItems = items.filter(isObject);
    const fields = {};
    for (const item of objectItems) {
      for (const [key, child] of Object.entries(item)) {
        const stat = (fields[key] ||= {
          count: 0,
          nullCount: 0,
          types: {},
        });
        stat.count += 1;
        if (child === null || child === undefined || child === '') {
          stat.nullCount += 1;
        }
        const type = valueType(child);
        stat.types[type] = (stat.types[type] || 0) + 1;
      }
    }
    out.push({
      path: currentPath,
      count: items.length,
      itemTypes: items.reduce((acc, item) => {
        const type = valueType(item);
        acc[type] = (acc[type] || 0) + 1;
        return acc;
      }, {}),
      fields: Object.fromEntries(
        Object.entries(fields)
          .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
          .map(([key, stat]) => [
            key,
            {
              count: stat.count,
              nullRate: Number((stat.nullCount / Math.max(1, stat.count)).toFixed(3)),
              types: stat.types,
            },
          ]),
      ),
    });
    for (const [index, item] of items.entries()) {
      if (isObject(item)) {
        for (const [key, child] of Object.entries(item)) {
          if (Array.isArray(child)) collectArrays(child, currentPath + '[' + index + '].' + key, out);
        }
      }
    }
    return;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (Array.isArray(child)) collectArrays(child, currentPath + '.' + key, out);
      else if (isObject(child)) collectArrays(child, currentPath + '.' + key, out);
    }
  }
}

function objectFieldStats(value) {
  if (!isObject(value)) return {};
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = {
      type: valueType(child),
      meaningful: isMeaningfulValue(child),
      arrayLength: Array.isArray(child) ? child.length : null,
      objectKeys: isObject(child) ? Object.keys(child).length : null,
    };
  }
  return output;
}

function findStatuses(value, out = []) {
  if (Array.isArray(value)) {
    for (const child of value) findStatuses(child, out);
  } else if (isObject(value)) {
    if (value.status !== undefined) out.push(String(value.status));
    for (const child of Object.values(value)) {
      if (isObject(child) || Array.isArray(child)) findStatuses(child, out);
    }
  }
  return [...new Set(out)];
}

function findTaskIds(value, out = []) {
  if (Array.isArray(value)) {
    for (const child of value) findTaskIds(child, out);
  } else if (isObject(value)) {
    for (const key of ['taskId', 'task_id']) {
      if (value[key] !== undefined && value[key] !== null && String(value[key]).trim()) {
        out.push(String(value[key]));
      }
    }
    for (const child of Object.values(value)) {
      if (isObject(child) || Array.isArray(child)) findTaskIds(child, out);
    }
  }
  return [...new Set(out)];
}

function classifyShape(response) {
  const data = response?.data;
  if (data === null || data === undefined) return 'data-null';
  if (Array.isArray(data)) return data.length ? 'data-array' : 'data-array-empty';
  if (!isObject(data)) return 'data-scalar';
  const arrays = [];
  collectArrays(data, 'data', arrays);
  if (arrays.some((item) => item.count > 0)) return 'data-object-with-arrays';
  const keys = Object.keys(data);
  if (keys.includes('taskId') || keys.includes('status')) return 'task-or-status-object';
  return keys.length ? 'detail-object' : 'data-object-empty';
}

function classifyUsability(item) {
  const response = item.response;
  const code = response?.code;
  const data = response?.data;
  const message = shortText(response?.msg || response?.message || '');
  if (item.httpStatus < 200 || item.httpStatus >= 300 || item.errorType) {
    return { level: '不可用', score: 0, reason: item.error || 'HTTP/网络错误' };
  }
  if (code !== 2000) {
    if (code === 3201) return { level: '不可用', score: 0, reason: '余额不足，本次未执行' };
    if (code === 3203 && /仅支持付费|充值/.test(message)) {
      return { level: '不可用', score: 0, reason: '接口要求付费调用' };
    }
    return { level: '不可用', score: 0, reason: message || '业务 code 非 2000' };
  }
  const statuses = findStatuses(data);
  const hasTask = findTaskIds(data).length > 0 || statuses.some((status) => /pending|running|queued|completed|success|not_found|fail/i.test(status));
  if (hasTask) {
    if (statuses.some((status) => /not_found|fail|error|unauthor/i.test(status))) {
      return { level: '低', score: 1, reason: '任务状态不可查询或失败' };
    }
    if (statuses.some((status) => /pending|running|queued/i.test(status))) {
      return { level: '中', score: 2, reason: '任务已受理，但返回仍是异步处理中状态' };
    }
    if (statuses.some((status) => /completed|success/i.test(status)) && isMeaningfulValue(data)) {
      return { level: '高', score: 3, reason: '任务结果已完成并返回内容' };
    }
    return { level: '中', score: 2, reason: '返回任务状态/标识，可继续轮询' };
  }
  if (Array.isArray(data)) {
    return data.length ? { level: '高', score: 3, reason: '直接返回非空数组数据' } : { level: '低', score: 1, reason: '直接返回空数组' };
  }
  if (isObject(data)) {
    const keys = Object.keys(data);
    const arrays = [];
    collectArrays(data, 'data', arrays);
    const nonEmptyArrays = arrays.filter((array) => array.count > 0);
    if (nonEmptyArrays.length) return { level: '高', score: 3, reason: '返回结构化对象并含非空数组' };
    if (keys.length >= 2) return { level: '中', score: 2, reason: '返回结构化对象，但未发现可展开数组' };
    if (keys.length === 1) return { level: '低', score: 1, reason: '返回字段较少，需结合业务语义复核' };
    return { level: '低', score: 1, reason: 'data 为空对象' };
  }
  return { level: '低', score: 1, reason: '返回 data 类型不适合直接入库' };
}

function domainOf(item) {
  const text = (item.platform || '') + ' ' + (item.name || '');
  if (/评论/.test(text)) return '评论';
  if (/榜|热搜|热点|飙升|推荐/.test(text)) return '榜单/热点';
  if (/账号|用户|作者/.test(text)) return '账号/用户';
  if (/作品|文章|视频|帖子|内容|笔记|推文/.test(text)) return '作品/内容';
  if (/搜索|深度搜索|纯文字/.test(text)) return '搜索/问答';
  if (/上传|下载|生成|提文案|转写|字幕/.test(text)) return '工具/任务';
  return '其他';
}

const files = fs
  .readdirSync(responseDir)
  .filter((file) => file.endsWith('.json'))
  .sort((a, b) => Number(a.slice(0, 3)) - Number(b.slice(0, 3)));
const rows = files.map((file) => ({
  file,
  ...JSON.parse(fs.readFileSync(path.join(responseDir, file), 'utf8')),
}));

fs.writeFileSync(allResponsesPath, JSON.stringify(rows, null, 2) + '\n', 'utf8');

const catalog = [];
const fieldFrequency = {};
const shapeCounts = {};
const levelCounts = {};
const domainStats = {};
const platformStats = {};
let allArrayRows = 0;
let nonEmptyArrayApis = 0;
let taskApis = 0;

for (let index = 0; index < rows.length; index += 1) {
  const item = rows[index];
  const response = item.response;
  const data = response?.data;
  const arrays = [];
  if (data !== null && data !== undefined) collectArrays(data, 'data', arrays);
  const arrayRows = arrays.reduce((sum, array) => sum + array.count, 0);
  const nonEmptyArrays = arrays.filter((array) => array.count > 0);
  const taskIds = findTaskIds(data);
  const statuses = findStatuses(data);
  const shape = classifyShape(response);
  const usability = classifyUsability(item);
  const fields = {};
  for (const array of arrays) {
    for (const [field, stats] of Object.entries(array.fields)) {
      fields[field] ||= { occurrences: 0, apiCount: 0, maxCount: 0, nullRates: [] };
      fields[field].occurrences += stats.count;
      fields[field].apiCount += 1;
      fields[field].maxCount = Math.max(fields[field].maxCount, stats.count);
      fields[field].nullRates.push(stats.nullRate);
      fieldFrequency[field] = (fieldFrequency[field] || 0) + 1;
    }
  }
  const fieldList = Object.entries(fields)
    .sort((a, b) => b[1].occurrences - a[1].occurrences || a[0].localeCompare(b[0]))
    .map(([field, stats]) => ({
      field,
      apiCount: stats.apiCount,
      occurrences: stats.occurrences,
      nullRate: Number(
        (stats.nullRates.reduce((sum, rate) => sum + rate, 0) / Math.max(1, stats.nullRates.length)).toFixed(3),
      ),
    }));
  const record = {
    seq: index + 1,
    no: item.no,
    platform: item.platform,
    name: item.name,
    method: item.method,
    path: item.url ? new URL(item.url).pathname : null,
    httpStatus: item.httpStatus,
    responseCode: response?.code ?? null,
    message: shortText(response?.msg || response?.message || ''),
    responseShape: shape,
    dataType: valueType(data),
    dataKeys: isObject(data) ? Object.keys(data) : [],
    objectFieldStats: isObject(data) ? objectFieldStats(data) : {},
    arrays,
    arrayRows,
    nonEmptyArrayCount: nonEmptyArrays.length,
    taskIds,
    statuses,
    domain: domainOf(item),
    usabilityLevel: usability.level,
    usabilityScore: usability.score,
    usabilityReason: usability.reason,
    durationMs: item.durationMs,
    responseFile: 'responses/' + item.file,
  };
  catalog.push(record);
  shapeCounts[shape] = (shapeCounts[shape] || 0) + 1;
  levelCounts[usability.level] = (levelCounts[usability.level] || 0) + 1;
  allArrayRows += arrayRows;
  if (nonEmptyArrays.length) nonEmptyArrayApis += 1;
  if (taskIds.length || statuses.length) taskApis += 1;
  const platform = item.platform || '未标注平台';
  platformStats[platform] ||= { total: 0, high: 0, medium: 0, low: 0, unavailable: 0, arrayRows: 0 };
  platformStats[platform].total += 1;
  platformStats[platform][
    usability.level === '高'
      ? 'high'
      : usability.level === '中'
        ? 'medium'
        : usability.level === '低'
          ? 'low'
          : 'unavailable'
  ] += 1;
  platformStats[platform].arrayRows += arrayRows;
  const domain = record.domain;
  domainStats[domain] ||= { total: 0, high: 0, medium: 0, low: 0, unavailable: 0, arrayRows: 0 };
  domainStats[domain].total += 1;
  domainStats[domain][
    usability.level === '高'
      ? 'high'
      : usability.level === '中'
        ? 'medium'
        : usability.level === '低'
          ? 'low'
          : 'unavailable'
  ] += 1;
  domainStats[domain].arrayRows += arrayRows;
}

const topFields = Object.entries(fieldFrequency)
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, 40);

fs.writeFileSync(
  catalogPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      sourceResponseCount: rows.length,
      totals: {
        allArrayRows,
        nonEmptyArrayApis,
        taskApis,
        shapeCounts,
        levelCounts,
      },
      platformStats,
      domainStats,
      topFields: Object.fromEntries(topFields),
      interfaces: catalog,
    },
    null,
    2,
  ) + '\n',
  'utf8',
);

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const failureRows = catalog.filter((item) => item.usabilityLevel === '不可用');
const sparseRows = catalog.filter((item) => item.usabilityLevel === '低');
const pendingRows = catalog.filter(
  (item) => item.usabilityLevel === '中' && item.statuses.some((status) => /pending|running|queued/i.test(status)),
);

const levelTable = [
  ['高', levelCounts['高'] || 0, '可直接用于入库、分析或下游处理'],
  ['中', levelCounts['中'] || 0, '已受理/结构可用，但需要轮询、补充解析或业务复核'],
  ['低', levelCounts['低'] || 0, '返回稀疏、空数据或任务不可见，暂不宜直接作为稳定数据源'],
  ['不可用', levelCounts['不可用'] || 0, '业务错误、权限/付费/余额限制或 HTTP/网络失败'],
];

const domainTable = Object.entries(domainStats)
  .sort((a, b) => b[1].total - a[1].total)
  .map(
    ([domain, stats]) =>
      '| ' +
      domain +
      ' | ' +
      stats.total +
      ' | ' +
      stats.high +
      ' | ' +
      stats.medium +
      ' | ' +
      stats.low +
      ' | ' +
      stats.unavailable +
      ' | ' +
      stats.arrayRows +
      ' |',
  )
  .join('\n');

const platformTable = Object.entries(platformStats)
  .sort((a, b) => b[1].total - a[1].total)
  .map(
    ([platform, stats]) =>
      '| ' +
      platform +
      ' | ' +
      stats.total +
      ' | ' +
      stats.high +
      ' | ' +
      stats.medium +
      ' | ' +
      stats.low +
      ' | ' +
      stats.unavailable +
      ' | ' +
      stats.arrayRows +
      ' |',
  )
  .join('\n');

const fieldTable = topFields
  .map(([field, count]) => '| ' + field + ' | ' + count + ' |')
  .join('\n');

const detailTable = catalog
  .map((item) => {
    const tick = String.fromCharCode(96);
    return (
      '| ' +
      item.seq +
      ' | ' +
      (item.platform || '') +
      ' | ' +
      (item.name || '') +
      ' | ' +
      item.no +
      ' | ' +
      (item.responseCode ?? '') +
      ' | ' +
      item.responseShape +
      ' | ' +
      item.arrayRows +
      ' | ' +
      (item.dataKeys.join(', ') || '') +
      ' | ' +
      item.usabilityLevel +
      ' | ' +
      shortText(item.usabilityReason, 100) +
      ' | [' +
      tick +
      'JSON' +
      tick +
      '](' +
      item.responseFile +
      ') |'
    );
  })
  .join('\n');

const failureTable = failureRows
  .map(
    (item) =>
      '| ' +
      item.seq +
      ' | ' +
      item.platform +
      ' | ' +
      item.name +
      ' | ' +
      item.responseCode +
      ' | ' +
      shortText(item.message || item.usabilityReason, 180) +
      ' |',
  )
  .join('\n') || '| — | — | — | — | 无 |';

const sparseTable = [...sparseRows, ...pendingRows.filter((item) => !sparseRows.includes(item))]
  .map(
    (item) =>
      '| ' +
      item.seq +
      ' | ' +
      item.platform +
      ' | ' +
      item.name +
      ' | ' +
      item.responseCode +
      ' | ' +
      item.responseShape +
      ' | ' +
      shortText(item.usabilityReason, 160) +
      ' |',
  )
  .join('\n') || '| — | — | — | — | 无 |';

const report =
  '# RedFox 全部接口返回内容与数据可用性分析\n\n' +
  '生成时间：' +
  new Date().toISOString() +
  '  \n' +
  '分析范围：' +
  rows.length +
  ' 份 open-cli 真实响应文件；没有重新请求接口。  \n' +
  '原始响应目录：responses/  \n\n' +
  '## 总体结论\n\n' +
  '- 147 个接口均有对应的真实响应文件；返回包装基本统一为 code、msg/message、data。\n' +
  '- code=2000 的接口 127 个，业务错误 20 个；原始审计中没有 HTTP/网络层错误。\n' +
  '- 直接或间接提取到数组元素 **' +
  allArrayRows +
  '** 条；其中 ' +
  nonEmptyArrayApis +
  ' 个接口含非空数组。数组元素是跨接口的结构计数，不等于统一口径的账号/作品总数。\n' +
  '- 检测到任务/状态型返回 ' +
  taskApis +
  ' 个；其中 ' +
  pendingRows.length +
  ' 个处于 pending/running/queued，说明这些接口需要异步轮询后才能形成最终数据。\n' +
  '- 数据可用性评级：高 ' +
  (levelCounts['高'] || 0) +
  '，中 ' +
  (levelCounts['中'] || 0) +
  '，低 ' +
  (levelCounts['低'] || 0) +
  '，不可用 ' +
  (levelCounts['不可用'] || 0) +
  '。\n\n' +
  '评级不是对平台永久能力的判断，而是对本次请求参数和本次真实返回的可用性判断。\n\n' +
  '## 可用性评级\n\n' +
  '| 等级 | 接口数 | 解释 |\n|---|---:|---|\n' +
  levelTable.map((row) => '| ' + row[0] + ' | ' + row[1] + ' | ' + row[2] + ' |').join('\n') +
  '\n\n' +
  '## 统一返回结构与入库建议\n\n' +
  '1. **统一外层协议**：先判断 HTTP 状态，再判断 code，最后解析 data；不能只以 HTTP 200 作为成功。\n' +
  '2. **列表类接口**：优先识别 data.list、data.items、data.results、data.transcript 等数组；同时保存 total、hasMore、offset/pageNum/pageSize/cursor 等分页字段。\n' +
  '3. **详情类接口**：data 往往是对象，字段名按平台变化明显；应使用接口编号维护 schema 映射，不建议跨平台直接强行共用字段。\n' +
  '4. **任务类接口**：提交响应中的 taskId、状态、失败原因必须单独落库；查询返回 pending/running/queued 时不能写成最终完成，completed 后再写结果。\n' +
  '5. **错误类接口**：3203 通常表示参数、数据覆盖、付费策略或上游执行问题；500 既可能是任务不可见，也可能是上传参数错误；3201 表示余额不足。本次响应中这些状态都不应进入正常数据表。\n\n' +
  '## 按数据域\n\n' +
  '| 数据域 | 接口数 | 高 | 中 | 低 | 不可用 | 数组元素 |\n|---|---:|---:|---:|---:|---:|---:|\n' +
  domainTable +
  '\n\n' +
  '## 按平台/分类\n\n' +
  '| 平台/分类 | 接口数 | 高 | 中 | 低 | 不可用 | 数组元素 |\n|---|---:|---:|---:|---:|---:|---:|\n' +
  platformTable +
  '\n\n' +
  '## 常见数组字段\n\n' +
  '以下频次按“接口中出现过该字段”统计，不代表所有平台字段含义完全一致：\n\n' +
  '| 字段 | 出现接口数 |\n|---|---:|\n' +
  fieldTable +
  '\n\n' +
  '## 不可用或需处理的返回\n\n' +
  '| # | 平台 | 接口 | code | 真实返回摘要 |\n|---:|---|---|---:|---|\n' +
  failureTable +
  '\n\n' +
  '## 低可用/异步处理中返回\n\n' +
  '| # | 平台 | 接口 | code | 返回形态 | 处理建议 |\n|---:|---|---|---:|---|---|\n' +
  sparseTable +
  '\n\n' +
  '## 全接口返回目录\n\n' +
  '每行给出本次真实返回的结构摘要；完整 responseText 和解析后的 response 位于对应 JSON 文件。\n\n' +
  '| # | 平台 | 接口 | 编号 | code | 返回形态 | 数组元素 | data 字段 | 可用性 | 判定依据 | 原始响应 |\n|---:|---|---|---|---:|---|---:|---|---|---|---|\n' +
  detailTable +
  '\n\n' +
  '## 系统支持结论\n\n' +
  '- **适合直接接入**：账号/作品搜索、详情、榜单、评论、跨平台检索等 code=2000 且含非空数组或详情对象的接口，可先接入统一采集层。\n' +
  '- **适合异步接入**：视频提文案、评论提交、AI 搜索、图片/视频生成等接口必须拆成 submit/result 两阶段，并保存 taskId 和状态变更。\n' +
  '- **需要降级或人工配置**：广域库、优质库覆盖差异、限时开放、付费生成、上传和下载接口需要按业务码做能力开关，不能把空数据或失败当作平台没有内容。\n' +
  '- **跨平台分析前需标准化**：至少统一 contentId、authorId、title/text、publishTime、like/comment/share/follower、url、platform、crawlTime；原始平台字段必须保留，避免信息损失。\n\n' +
  '## 产物\n\n' +
  '- response-catalog.json：147 个接口的结构、字段、数组、任务状态和可用性评级。\n' +
  '- all-responses.json：合并后的 147 份完整真实响应，便于一次性读取。\n' +
  '- responses/：147 份完整真实响应。\n' +
  '- 原始请求参数和接口目录见同目录下的 request-manifest.json 与 report.md。\n';

fs.writeFileSync(reportPath, report, 'utf8');
console.log(
  JSON.stringify(
    {
      reportPath,
      catalogPath,
      responseCount: rows.length,
      allArrayRows,
      levelCounts,
      shapeCounts,
      topFields: Object.fromEntries(topFields.slice(0, 15)),
    },
    null,
    2,
  ),
);
