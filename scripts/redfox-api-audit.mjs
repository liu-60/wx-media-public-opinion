import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const baseDir = process.cwd();
const outputDir = path.resolve(
  process.env.REDFOX_AUDIT_OUTPUT ||
    path.join(baseDir, 'reports', 'redfox-api-audit-20260921'),
);
const responseDir = path.join(outputDir, 'responses');
const opencliPath =
  process.env.OPENCLI_PATH ||
  'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\opencli.cmd';
const browserName = process.env.REDFOX_BROWSER || 'redfox';
const apiKey = process.env.REDFOX_API_KEY;
const batchSize = Number(process.env.REDFOX_BATCH_SIZE || 4);

if (!apiKey) {
  throw new Error('REDFOX_API_KEY is required in the process environment');
}

fs.mkdirSync(responseDir, { recursive: true });

function parseCliJson(raw) {
  const text = String(raw).trim();
  for (let i = 0; i < text.length; i += 1) {
    if (!['{', '['].includes(text[i])) continue;
    try {
      return JSON.parse(text.slice(i));
    } catch {
      // opencli may append a status line; keep looking for the JSON start.
    }
  }
  throw new Error('Unable to parse opencli eval output: ' + text.slice(0, 500));
}

function openEval(expression) {
  const encoded = Buffer.from(expression, 'utf8').toString('base64');
  const decodedExpression =
    "eval(new TextDecoder().decode(Uint8Array.from(atob('" +
    encoded +
    "'),c=>c.charCodeAt(0))))";
  const command =
    '"' +
    opencliPath +
    '" browser ' +
    browserName +
    ' eval "' +
    decodedExpression +
    '"';
  const raw = execSync(command, {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
  return parseCliJson(raw);
}

function asTrimmed(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function fallbackValue(param) {
  const name = String(param.paramName || '').toLowerCase();
  const type = String(param.paramType || '').toLowerCase();
  if (type.includes('bool')) return false;
  if (
    type.includes('int') ||
    type.includes('long') ||
    type.includes('double') ||
    type.includes('float')
  ) {
    return 0;
  }
  if (type.includes('array') || type === 'object') return [];
  if (name.includes('date') || name.includes('time')) {
    return name.includes('time') ? '2026-09-20 00:00:00' : '2026-09-20';
  }
  if (name.includes('url') || name.includes('link')) return 'https://example.com/';
  if (name.includes('task')) return 'test-task-id';
  if (name.includes('keyword') || name.includes('inquiry') || name.includes('query')) {
    return 'AI';
  }
  return '示例值';
}

function coerceParamValue(param) {
  const example = asTrimmed(param.exampleValue);
  const defaultValue = asTrimmed(param.defaultValue);
  const type = String(param.paramType || '').toLowerCase();
  const raw = example || defaultValue;
  if (!raw) return param.required ? fallbackValue(param) : undefined;
  if (raw.toLowerCase() === 'null') return null;
  if (type.includes('bool')) return raw.toLowerCase() === 'true';
  if (type.includes('int') || type.includes('long')) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (type.includes('double') || type.includes('float')) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (
    type.includes('array') ||
    type === 'object' ||
    raw.startsWith('[') ||
    raw.startsWith('{')
  ) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function buildRequest(item, taskIdByPlatform) {
  const body = {};
  const query = {};
  const headers = {};
  const omittedOptional = [];
  let pathValue = item.path;
  for (const param of item.params || []) {
    let value = coerceParamValue(param);
    if (String(param.paramName).toLowerCase() === 'taskid') {
      const prior = taskIdByPlatform.get(item.platformCode);
      if (prior) value = prior;
    }
    if (value === undefined) {
      if (!param.required) omittedOptional.push(param.paramName);
      continue;
    }
    const location = String(param.paramLocation || 'body').toLowerCase();
    if (location === 'query') query[param.paramName] = value;
    else if (location === 'header') headers[param.paramName] = String(value);
    else if (location === 'path') {
      pathValue = pathValue.replace(
        '{' + param.paramName + '}',
        encodeURIComponent(String(value)),
      );
    } else body[param.paramName] = value;
  }
  const url = new URL((item.baseUrl || 'https://redfox.hk') + pathValue);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return {
    ...item,
    path: pathValue,
    url: url.toString(),
    body: Object.keys(body).length ? body : null,
    query,
    requestHeaders: headers,
    omittedOptional,
  };
}

function findTaskId(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findTaskId(child);
      if (found) return found;
    }
    return null;
  }
  for (const key of ['taskId', 'task_id']) {
    if (value[key] !== undefined && value[key] !== null && String(value[key]).trim()) {
      return String(value[key]);
    }
  }
  for (const child of Object.values(value)) {
    const found = findTaskId(child);
    if (found) return found;
  }
  return null;
}

function classify(result) {
  if (result.errorType === 'timeout') return 'timeout';
  if (result.errorType) return 'network_error';
  if (result.httpStatus < 200 || result.httpStatus >= 300) return 'http_error';
  if (result.response && typeof result.response === 'object' && result.response.code !== undefined) {
    return Number(result.response.code) === 2000 ? 'success' : 'business_error';
  }
  return result.responseParseError ? 'invalid_json' : 'success_without_code';
}

function responseMetrics(response) {
  const metrics = {
    arrayCounts: {},
    dataKeys: [],
    total: null,
    hasMore: null,
    taskId: null,
  };
  if (!response || typeof response !== 'object') return metrics;
  const data = response.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    metrics.dataKeys = Object.keys(data);
    if (data.total !== undefined) metrics.total = data.total;
    if (data.hasMore !== undefined) metrics.hasMore = data.hasMore;
    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value)) metrics.arrayCounts[key] = value.length;
    }
  }
  metrics.taskId = findTaskId(response);
  return metrics;
}

function getManifest() {
  return openEval(
    '(()=>{const run=async()=>{const catalog=(await fetch("https://redfox.hk/story/web/api/doc/platforms").then(r=>r.json())).data||[];const platforms=[];const walk=p=>{platforms.push(p);(p.categories||[]).forEach(walk)};catalog.forEach(walk);const groups=await Promise.all(platforms.map(async p=>({p,items:(await fetch("https://redfox.hk/story/web/api/doc/platform/"+encodeURIComponent(p.platformCode)+"/interfaces").then(r=>r.json())).data||[]})));const entries=groups.flatMap(g=>g.items.map(item=>({p:g.p,item})));const details=await Promise.all(entries.map(async e=>{const d=(await fetch("https://redfox.hk/story/web/api/doc/detail/no/"+encodeURIComponent(e.item.interfaceNo)).then(r=>r.json())).data;const i=d.interfaceInfo;return {no:i.interfaceNo,platformCode:e.p.platformCode,platform:e.p.platformName,name:i.interfaceName,path:i.path,method:i.httpMethod,price:i.price,minPrice:i.minPrice,status:i.status,displayStatus:i.displayStatus,description:i.description,baseUrl:d.baseUrl||"https://redfox.hk",params:(d.parameters||[]).map(p=>({paramName:p.paramName,paramType:p.paramType,required:p.required,paramLocation:p.paramLocation,exampleValue:p.exampleValue,defaultValue:p.defaultValue,parentParam:p.parentParam}))}}));return JSON.stringify(details)};return run()})()',
  );
}

function runBatch(batch, key) {
  const wireBatch = batch.map(({ params, ...item }) => item);
  const itemsLiteral = JSON.stringify(wireBatch);
  const keyLiteral = JSON.stringify(key);
  const expression =
    '(async()=>{const items=' +
    itemsLiteral +
    ';const apiKey=' +
    keyLiteral +
    ';const out=[];for(const it of items){const started=Date.now();let timeoutId;try{const controller=new AbortController();timeoutId=setTimeout(()=>controller.abort(),45000);const headers={REDFOX_API_KEY:apiKey,...(it.requestHeaders||{})};if(it.body!==null)headers["Content-Type"]="application/json";const response=await fetch(it.url,{method:it.method,headers,body:it.body===null?undefined:JSON.stringify(it.body),signal:controller.signal});clearTimeout(timeoutId);const responseText=await response.text();let parsed=null;let responseParseError=null;try{parsed=JSON.parse(responseText)}catch(e){responseParseError=String(e)}out.push({...it,httpStatus:response.status,responseHeaders:Object.fromEntries([...response.headers].filter(([k])=>/content-type|x-request-id|remaining|point|cost|rate/i.test(k))),responseText,response:parsed,responseParseError,durationMs:Date.now()-started})}catch(e){clearTimeout(timeoutId);out.push({...it,httpStatus:0,responseHeaders:{},responseText:"",response:null,errorType:e&&e.name==="AbortError"?"timeout":"network_error",error:String(e),durationMs:Date.now()-started})}}return JSON.stringify(out)})()';
  return openEval(expression);
}

function safeFilePart(value) {
  return String(value).replace(/[^\w.-]+/g, '_').slice(0, 80);
}

const manifest = getManifest();
if (!Array.isArray(manifest)) {
  throw new Error('The browser did not return the API manifest');
}

const taskIdByPlatform = new Map();
const results = [];
const requestManifest = [];
const expectedCost = manifest.reduce((sum, item) => sum + Number(item.price || 0), 0);

for (let offset = 0; offset < manifest.length; offset += batchSize) {
  const rawBatch = manifest.slice(offset, offset + batchSize);
  const batch = rawBatch.map((item) => buildRequest(item, taskIdByPlatform));
  requestManifest.push(...batch);
  process.stdout.write(
    '请求 ' +
      (offset + 1) +
      '-' +
      (offset + batch.length) +
      '/' +
      manifest.length +
      ': ' +
      batch.map((item) => item.no).join(', ') +
      '\n',
  );
  const batchResults = runBatch(batch, apiKey);
  if (!Array.isArray(batchResults)) {
    throw new Error('Unexpected batch result at ' + offset);
  }
  for (const result of batchResults) {
    const source = batch.find((item) => item.no === result.no) || {};
    const normalized = {
      ...source,
      ...result,
      classification: classify(result),
      metrics: responseMetrics(result.response),
    };
    delete normalized.requestHeaders;
    results.push(normalized);
    const taskId = normalized.metrics.taskId;
    if (taskId) taskIdByPlatform.set(normalized.platformCode, taskId);
  }
}

const statusCounts = {};
const businessCodes = {};
const platformStats = {};
let responseRows = 0;
for (const result of results) {
  statusCounts[result.classification] = (statusCounts[result.classification] || 0) + 1;
  const code =
    result.response && typeof result.response === 'object'
      ? result.response.code
      : null;
  if (code !== null && code !== undefined) {
    businessCodes[code] = (businessCodes[code] || 0) + 1;
  }
  const platform = result.platform || '未标注平台';
  platformStats[platform] ||= { total: 0, success: 0, errors: 0, rows: 0 };
  platformStats[platform].total += 1;
  if (
    result.classification === 'success' ||
    result.classification === 'success_without_code'
  ) {
    platformStats[platform].success += 1;
  } else {
    platformStats[platform].errors += 1;
  }
  const arrayCounts = result.metrics?.arrayCounts || {};
  const rows = Object.values(arrayCounts).reduce(
    (sum, count) => sum + Number(count || 0),
    0,
  );
  responseRows += rows;
  platformStats[platform].rows += rows;
}

for (let index = 0; index < results.length; index += 1) {
  const result = results[index];
  const responseFileName =
    String(index + 1).padStart(3, '0') +
    '-' +
    safeFilePart(result.no) +
    '-' +
    safeFilePart(result.name) +
    '.json';
  const responseFilePath = path.join(responseDir, responseFileName);
  const responseDocument = {
    no: result.no,
    platform: result.platform,
    name: result.name,
    method: result.method,
    url: result.url,
    requestBody: result.body,
    query: result.query,
    params: result.params,
    httpStatus: result.httpStatus,
    responseHeaders: result.responseHeaders,
    responseText: result.responseText,
    response: result.response,
    responseParseError: result.responseParseError || null,
    errorType: result.errorType || null,
    error: result.error || null,
    durationMs: result.durationMs,
    classification: result.classification,
    metrics: result.metrics,
  };
  fs.writeFileSync(
    responseFilePath,
    JSON.stringify(responseDocument, null, 2) + '\n',
    'utf8',
  );
  result.responseFile = path
    .relative(outputDir, responseFilePath)
    .replaceAll('\\', '/');
}

fs.writeFileSync(
  path.join(outputDir, 'request-manifest.json'),
  JSON.stringify(
    requestManifest.map((item, index) => ({
      seq: index + 1,
      no: item.no,
      platform: item.platform,
      name: item.name,
      method: item.method,
      url: item.url,
      requestBody: item.body,
      query: item.query,
      params: item.params,
      omittedOptional: item.omittedOptional,
      price: item.price,
    })),
    null,
    2,
  ) + '\n',
  'utf8',
);

const table = results
  .map((result, index) => {
    const code =
      result.response && typeof result.response === 'object'
        ? result.response.code ?? ''
        : '';
    const rows = Object.values(result.metrics?.arrayCounts || {}).reduce(
      (sum, value) => sum + Number(value || 0),
      0,
    );
    const tick = String.fromCharCode(96);
    return (
      '| ' +
      (index + 1) +
      ' | ' +
      (result.platform || '') +
      ' | ' +
      (result.name || '') +
      ' | ' +
      result.no +
      ' | ' +
      result.method +
      ' | ' +
      tick +
      result.path +
      tick +
      ' | ' +
      (result.price ?? '') +
      ' | ' +
      (result.httpStatus || '') +
      ' | ' +
      code +
      ' | ' +
      result.classification +
      ' | ' +
      rows +
      ' | [原始响应](' +
      result.responseFile +
      ') |'
    );
  })
  .join('\n');

const platformTable = Object.entries(platformStats)
  .map(
    ([platform, stats]) =>
      '| ' +
      platform +
      ' | ' +
      stats.total +
      ' | ' +
      stats.success +
      ' | ' +
      stats.errors +
      ' | ' +
      stats.rows +
      ' |',
  )
  .join('\n');

const codeTable =
  Object.entries(businessCodes)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([code, count]) => '| ' + code + ' | ' + count + ' |')
    .join('\n') || '| — | 0 |';

const statusText =
  Object.entries(statusCounts)
    .map(([key, value]) => key + '=' + value)
    .join('，') || '无';
const report =
  '# RedFox 左侧 API 菜单全量请求报告\n\n' +
  '生成时间：' +
  new Date().toISOString() +
  '  \n' +
  '文档入口：<https://redfox.hk/apis/douyin/P5CHB3BZ>  \n' +
  '执行方式：open-cli 浏览器会话中的真实文档读取与真实 HTTP 请求  \n' +
  '认证：已使用用户提供的 API Key；本报告、请求清单和响应文件均不记录密钥值。\n\n' +
  '## 结论\n\n' +
  '- 文档目录读取到 **' +
  manifest.length +
  ' 个接口**，覆盖 **' +
  Object.keys(platformStats).length +
  ' 个平台/分类**。\n' +
  '- 本次审计对每个接口各发起 **1 次真实请求**；另有入口接口在批量审计前做过 1 次预检，因此该接口合计 2 次调用。\n' +
  '- 按接口文档标价计算，批量审计预计消耗 **' +
  expectedCost.toFixed(2) +
  ' 点**；预检接口另计其文档标价。服务端未在响应头中返回可核验的实际扣费字段，因此不把标价冒充实际扣费。\n' +
  '- 返回中同时保留了成功、业务错误、HTTP 错误、超时和网络错误边界；示例响应没有被当作真实数据。\n\n' +
  '## 请求结果汇总\n\n' +
  '状态计数：' +
  statusText +
  '  \n' +
  '响应中提取到的数组元素总数：**' +
  responseRows +
  '**  \n' +
  '业务码分布：\n\n' +
  '| code | 次数 |\n|---:|---:|\n' +
  codeTable +
  '\n\n' +
  '## 按平台/分类\n\n' +
  '| 平台/分类 | 接口数 | 成功 | 错误 | 数组元素 |\n|---|---:|---:|---:|---:|\n' +
  platformTable +
  '\n\n' +
  '## 可用性与系统支持分析\n\n' +
  '1. **数据覆盖面**：菜单同时覆盖短视频账号、作品、评论/榜单、公众号文章、图文平台、视频平台、汽车内容、热点聚合和 AI 搜索/生成工具，可支撑“账号发现 → 内容检索 → 详情 → 榜单/热点 → 任务型处理”的链路。\n' +
  '2. **优质库与广域库**：优质库接口通常面向清洗后的高活跃数据；标记为“广域库/限时开放”的接口要以本次真实返回的权限或业务码为准，不能仅根据文档状态判定可用。\n' +
  '3. **实时性**：带 T+1 的接口是前一日定时更新，不适合作为实时监控源；榜单、搜索、详情和工具接口的实时性需要结合各自返回时间字段与本报告原始响应复核。\n' +
  '4. **任务型接口**：提交任务类接口需要后续查询；本次请求清单记录了提交响应中的 taskId（如服务端返回），查询接口使用已获得的同平台 taskId，否则使用文档示例值并将结果标记为真实业务返回。\n' +
  '5. **生产接入建议**：将 code、HTTP 状态、msg/message、分页字段（offset/pageNum/pageSize/cursor）、hasMore 和任务状态统一封装；对广域库权限失败、T+1 延迟和限流分别重试/降级，不要把空列表直接等同于系统故障。\n\n' +
  '## 完整接口明细\n\n' +
  '| # | 平台 | 接口 | 编号 | 方法 | 路径 | 标价 | HTTP | code | 判定 | 数组行数 | 原始响应 |\n|---:|---|---|---|---|---|---:|---:|---:|---|---:|---|\n' +
  table +
  '\n\n' +
  '## 产物\n\n' +
  '- request-manifest.json：逐接口实际请求方法、URL、请求参数和文档参数定义，不含密钥。\n' +
  '- responses/：逐接口完整真实响应、响应头白名单、耗时、状态判定和提取指标。\n' +
  '- 本报告中的链接均指向本目录下的本地审计产物。\n';

fs.writeFileSync(path.join(outputDir, 'report.md'), report, 'utf8');
fs.writeFileSync(
  path.join(outputDir, 'summary.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      manifestCount: manifest.length,
      resultCount: results.length,
      platformStats,
      statusCounts,
      businessCodes,
      expectedCost: Number(expectedCost.toFixed(2)),
      responseRows,
      results: results.map((result, index) => ({
        seq: index + 1,
        no: result.no,
        platform: result.platform,
        name: result.name,
        path: result.path,
        httpStatus: result.httpStatus,
        classification: result.classification,
        responseCode: result.response?.code ?? null,
        msg: result.response?.msg ?? result.response?.message ?? null,
        metrics: result.metrics,
        durationMs: result.durationMs,
        responseFile: result.responseFile,
      })),
    },
    null,
    2,
  ) + '\n',
  'utf8',
);

process.stdout.write(
  '完成：' +
    manifest.length +
    ' 个接口；报告：' +
    path.join(outputDir, 'report.md') +
    '\n',
);
