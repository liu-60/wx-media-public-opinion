import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Descriptions,
  DatePicker,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Pagination,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography
} from 'antd'
import {
  CheckOutlined,
  DeleteOutlined,
  DownOutlined,
  EyeOutlined,
  FileSearchOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  SaveOutlined,
  StopOutlined,
  UpOutlined
} from '@ant-design/icons'
import { createApiClient, createTokenStore } from '../public/api-client.mjs'
import dayjs from 'dayjs'
import advancedFormat from 'dayjs/plugin/advancedFormat'
import customParseFormat from 'dayjs/plugin/customParseFormat'
import localeData from 'dayjs/plugin/localeData'
import weekOfYear from 'dayjs/plugin/weekOfYear'
import weekYear from 'dayjs/plugin/weekYear'
import weekday from 'dayjs/plugin/weekday'

dayjs.extend(customParseFormat)
dayjs.extend(advancedFormat)
dayjs.extend(weekday)
dayjs.extend(localeData)
dayjs.extend(weekOfYear)
dayjs.extend(weekYear)

const api = createApiClient({ getToken: createTokenStore().get, cacheDefault: false })
const PAGE_SIZE = 100
const SCRIPT_PAGE_SIZE = 10
const RUN_PAGE_SIZE = 20

function apiError(error) {
  if (error?.status === 401) return '本机令牌无效，请重新配置。'
  if (error?.status === 409) return '数据已被其他操作修改，请刷新后重试。'
  if (error?.status === 503) return '编排服务未就绪，请确认五张新表已应用且 Supabase 服务端密钥已配置。'
  return error?.message || '请求失败'
}

function statusTag(status, row = null) {
  if (status === 'queued' && row?.run_kind === 'single_script') {
    if (row.summary?.execution_state === 'waiting_for_slot') return <Tag color="warning">等待执行槽位</Tag>
    return <Tag color="processing">正在启动</Tag>
  }
  if (status === 'running' && row?.run_kind === 'single_script') return <Tag color="processing">执行中</Tag>
  const meta = {
    queued: ['排队中', 'default'], pending: ['待执行', 'default'], running: ['运行中', 'processing'], retrying: ['重试中', 'warning'],
    success: ['成功', 'success'], partial: ['部分成功', 'warning'], failed: ['失败', 'error'], skipped: ['已跳过', 'default'], waiting_auth: ['等待认证', 'warning'],
    timed_out: ['超时', 'error'], cancelled: ['已取消', 'default'], blocked: ['已阻塞', 'error'], interrupted: ['已中断', 'error']
  }[status] || [status || '未知', 'default']
  return <Tag color={meta[1]}>{meta[0]}</Tag>
}

function jsonText(value) {
  if (value === undefined || value === null || value === '') return ''
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function parseJson(value, fallback = {}) {
  if (value === undefined || value === null || value === '') return fallback
  try { return JSON.parse(value) } catch { throw new Error('JSON 配置格式不正确') }
}

function PageTitle({ title, description, actions }) {
  return <div className="page-heading page-heading-compact">
    <div className="page-heading-copy"><div className="page-heading-inline"><Typography.Text strong className="page-title-compact">{title}</Typography.Text><Typography.Text type="secondary" className="page-description-compact">{description}</Typography.Text></div></div>
    {actions ? <Space wrap>{actions}</Space> : null}
  </div>
}

function CollectionError({ error, onRetry }) {
  return <Alert type="error" showIcon message={apiError(error)} action={<Button size="small" onClick={onRetry}>重试</Button>} />
}

function CollectorEditor({ open, item, canWrite, onClose, onSaved }) {
  const [form] = Form.useForm()
  const { message } = AntApp.useApp()
  const [saving, setSaving] = useState(false)
  const [credentialMeta, setCredentialMeta] = useState(null)
  useEffect(() => {
    if (!open) return
    form.setFieldsValue({
      name: item?.name || '', script_key: item?.script_key || '', platform: item?.platform || 'wxrank', entrypoint: item?.entrypoint || '',
      version: item?.version || 1, code_hash: item?.code_hash || '', enabled: item?.enabled !== false, execution_type: item?.execution_type || 'node',
      timeout_seconds: item?.timeout_seconds || 900, retry_count: item?.retry_count || 0, capabilities: Array.isArray(item?.capabilities) ? item.capabilities.join(', ') : '',
      run_mode: item?.run_mode || 'standalone', required_artifacts: jsonText(item?.required_artifacts),
      default_config: jsonText(item?.default_config), input_schema: jsonText(item?.input_schema), output_schema: jsonText(item?.output_schema), credential_value: ''
    })
    setCredentialMeta(null)
    if (!item?.credential_ref) return
    let active = true
    api.get(`/api/collection/credentials/${encodeURIComponent(item.credential_ref)}`).then(result => {
      if (active) setCredentialMeta(result)
    }).catch(() => { if (active) setCredentialMeta(null) })
    return () => { active = false }
  }, [open, item, form])
  const submit = async values => {
    setSaving(true)
    try {
      const credentialValue = typeof values.credential_value === 'string' ? values.credential_value.trim() : ''
      const body = {
        ...values,
        capabilities: String(values.capabilities || '').split(/[,，]/u).map(value => value.trim()).filter(Boolean),
        required_artifacts: parseJson(values.required_artifacts, []),
        default_config: parseJson(values.default_config), input_schema: parseJson(values.input_schema), output_schema: parseJson(values.output_schema)
      }
      delete body.credential_value
      if (item?.id) body.expected_updated_at = item.updated_at
      await api.mutate(item?.id ? `/api/collection/scripts/${item.id}` : '/api/collection/scripts', { method: item?.id ? 'PATCH' : 'POST', body })
      if (item?.credential_ref && credentialValue) {
        await api.mutate(`/api/collection/credentials/${encodeURIComponent(item.credential_ref)}`, { method: 'PUT', body: { value: credentialValue } })
      }
      message.success(item?.credential_ref && credentialValue ? '脚本与配置 key 已保存' : (item?.id ? '脚本已更新' : '脚本已创建'))
      onSaved()
    } catch (error) { message.error(apiError(error)) } finally { setSaving(false) }
  }
  return <Modal title={item ? '编辑采集脚本' : '新增采集脚本'} open={open} onCancel={onClose} destroyOnHidden width={720} confirmLoading={saving} okText="保存" cancelText="取消" okButtonProps={{ disabled: !canWrite }} onOk={() => form.submit()}>
    <Form form={form} layout="vertical" onFinish={submit} preserve={false}>
      <Space.Compact block><Form.Item label="脚本名称" name="name" rules={[{ required: true }]} style={{ width: '50%' }}><Input /></Form.Item><Form.Item label="script_key" name="script_key" rules={[{ required: true }]} style={{ width: '50%' }}><Input disabled={Boolean(item)} /></Form.Item></Space.Compact>
      <Space.Compact block><Form.Item label="平台" name="platform" rules={[{ required: true }]} style={{ width: '33%' }}><Input /></Form.Item><Form.Item label="执行类型" name="execution_type" style={{ width: '33%' }}><Select options={[{ value: 'node', label: 'Node.js' }]} /></Form.Item><Form.Item label="版本" name="version" rules={[{ required: true }]} style={{ width: '34%' }}><InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Space.Compact>
      <Form.Item label="Git 注册入口" name="entrypoint" rules={[{ required: true }]}><Input placeholder="scripts/collectors/example.mjs" /></Form.Item>
      <Form.Item label="代码 hash" name="code_hash" rules={[{ required: true }]} extra="必须与注册器实际计算的 sha256 一致"><Input /></Form.Item>
      <Space.Compact block><Form.Item label="超时秒数" name="timeout_seconds" style={{ width: '50%' }}><InputNumber min={1} style={{ width: '100%' }} /></Form.Item><Form.Item label="重试次数" name="retry_count" style={{ width: '50%' }}><InputNumber min={0} max={10} style={{ width: '100%' }} /></Form.Item></Space.Compact>
      <Form.Item label="能力标签" name="capabilities"><Input placeholder="account_discovery, article_collection" /></Form.Item>
      <Space.Compact block><Form.Item label="执行方式" name="run_mode" style={{ width: '50%' }}><Select options={[{ value: 'standalone', label: '可单独执行' }, { value: 'requires_input', label: '需要输入' }, { value: 'workflow_only', label: '仅工作流执行' }]} /></Form.Item><Form.Item label="必需产物 JSON" name="required_artifacts" style={{ width: '50%' }}><Input.TextArea rows={1} placeholder="[]" /></Form.Item></Space.Compact>
      {item?.credential_ref ? <>
        <Form.Item label="服务端配置 key"><Input value={item.credential_ref} readOnly /></Form.Item>
        <Form.Item label="配置 key 值" name="credential_value" extra={`仅保存到本机服务端，执行脚本时注入；${credentialMeta?.configured ? `当前已配置（${credentialMeta.masked}，来源：${credentialMeta.source === 'saved' ? '页面保存' : '进程环境'}），留空保持不变。` : '当前未检测到配置，请输入后保存。'}`}>
          <Input.Password autoComplete="new-password" placeholder={credentialMeta?.configured ? '留空保持不变' : '请输入配置 key'} />
        </Form.Item>
      </> : null}
      <Form.Item label="默认配置 JSON" name="default_config"><Input.TextArea rows={3} placeholder="{}" /></Form.Item>
      <Form.Item label="输入 schema JSON" name="input_schema"><Input.TextArea rows={3} placeholder="{}" /></Form.Item>
      <Form.Item label="输出 schema JSON" name="output_schema"><Input.TextArea rows={3} placeholder="{}" /></Form.Item>
      <Form.Item label="启用" name="enabled" valuePropName="checked"><Switch /></Form.Item>
    </Form>
  </Modal>
}

const RUN_MODE_META = {
  standalone: { label: '可单独执行', color: 'success' },
  requires_input: { label: '需要输入', color: 'processing' },
  workflow_only: { label: '仅工作流执行', color: 'warning' }
}

function runModeTag(mode) {
  const meta = RUN_MODE_META[mode] || { label: mode || '未声明', color: 'default' }
  return <Tag color={meta.color}>{meta.label}</Tag>
}

function displayCount(value) { return value === null || value === undefined ? '—' : value }

const BUSINESS_SUMMARY_LABELS = { fetched: '获取', valid: '有效', invalid: '无效', duplicate: '重复', created: '新增', updated: '更新', unchanged: '未变化', selected: '选中', filtered: '过滤', requests: '请求', valid_articles: '有效文章', exceptions: '异常', input_articles: '输入文章', write_set_records: '写集记录' }

function businessSummaryText(summary = {}) {
  return Object.entries(summary).map(([key, value]) => `${BUSINESS_SUMMARY_LABELS[key] || key}：${displayCount(value)}`).join(' · ')
}

function configFields(script) {
  const fields = script?.input_schema?.config || {}
  return Object.entries(fields).map(([name, schema]) => [name, typeof schema === 'string' ? { type: schema } : (schema || {})])
}

function configControl(name, schema, { maxCount = null } = {}) {
  const type = String(schema.type || 'string')
  if (type === 'multi_enum' || type === 'multienum') {
    const options = schema.options || []
    return <Select mode="multiple" maxCount={maxCount ?? schema.max} options={options.map(value => typeof value === 'object' ? value : ({ value, label: value }))} allowClear />
  }
  if (type === 'enum' || type.startsWith('enum:')) {
    const options = schema.options || type.slice(5).split('|').filter(Boolean)
    return <Select options={options.map(value => typeof value === 'object' ? value : ({ value, label: value }))} allowClear />
  }
  if (type === 'boolean') return <Switch />
  if (type === 'integer' || type === 'number') return <InputNumber min={schema.min} max={schema.max} style={{ width: '100%' }} />
  if (type === 'date') return <Input type="date" />
  return <Input placeholder={schema.label || name} />
}

function artifactLabel(item) {
  const sourceLabel = item.source === 'local_test' ? `本地测试 · ${item.source_test_bundle_id}` : item.source_run_id ? `最近运行 · ${item.source_run_id}` : '本地'
  return `${item.artifact_type || '未分类'}@${item.schema_version || '?'} · ${item.artifact_id || item.id} · ${sourceLabel}`
}

async function loadArtifactRecords(runId, item) {
  const base = `/api/collection/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(item.artifact_id || item.id)}`
  const pageSize = 500
  const first = await api.get(`${base}?view=records&page=1&pageSize=${pageSize}`)
  const total = Number(first.total) || first.records?.length || 0
  const pageCount = Math.ceil(total / pageSize)
  if (pageCount <= 1) return first
  const remaining = await Promise.all(Array.from({ length: pageCount - 1 }, (_, index) =>
    api.get(`${base}?view=records&page=${index + 2}&pageSize=${pageSize}`)
  ))
  return { ...first, records: [ ...(first.records || []), ...remaining.flatMap(page => page.records || []) ] }
}

function articleMetric(value) {
  const normalized = String(value ?? '').trim().replace(/,/gu, '')
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(万|w)?\+?$/iu)
  return match ? Number(match[1]) * (match[2] ? 10_000 : 1) : 0
}

function latestRedfoxAvailableDate(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now).map(part => [part.type, part.value]))
  const today = dayjs(parts.year + '-' + parts.month + '-' + parts.day)
  const afterUpdate = Number(parts.hour) > 18 || (Number(parts.hour) === 18 && Number(parts.minute) >= 30)
  return today.subtract(afterUpdate ? 1 : 2, 'day').startOf('day')
}

function normalizeDateRange(value) {
  if (!Array.isArray(value)) return value
  return value.map(item => {
    if (item === null || item === undefined || item === '') return null
    if (dayjs.isDayjs(item)) return item.isValid() ? item : null
    const parsed = dayjs(String(item))
    return parsed.isValid() ? parsed : null
  })
}

function safeArticleUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch { return null }
}

function isRedfoxRankArtifact(item, records = []) {
  const artifactId = String(item?.artifact_id || item?.id || '').toLowerCase()
  return /redfox-gzh-(?:filtered-)?articles\.json/u.test(artifactId)
    || records.some(record => record?.source_platform === 'redfox' || ['ZIGAGYYT', 'OFFSPQ0U'].includes(record?.source_no))
}

function ArtifactPreview({ runId, item, onClose }) {
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const [reloadKey, setReloadKey] = useState(0)
  const [tablePage, setTablePage] = useState(1)
  const [tablePageSize, setTablePageSize] = useState(10)
  const [likeSortOrder, setLikeSortOrder] = useState('descend')
  useEffect(() => {
    let active = true
    setState({ loading: true, error: null, data: null })
    setTablePage(1)
    setTablePageSize(isRedfoxRankArtifact(item) ? 200 : 10)
    setLikeSortOrder('descend')
    loadArtifactRecords(runId, item).then(data => { if (active) setState({ loading: false, error: null, data }) }).catch(error => { if (active) setState({ loading: false, error, data: null }) })
    return () => { active = false }
  }, [runId, item, reloadKey])
  const data = state.data
  const isArticleArtifact = ['articles', 'filtered_articles'].includes(data?.manifest?.artifact_type)
  const records = data?.records || []
  const isRedfoxArticleArtifact = isArticleArtifact && isRedfoxRankArtifact(item, records)
  const articleRecords = isArticleArtifact
    ? (isRedfoxArticleArtifact ? records : [...records].sort((left, right) => (articleMetric(left.like_num) - articleMetric(right.like_num)) * (likeSortOrder === 'ascend' ? 1 : -1))).map((record, index) => ({
      ...record,
      __display_number: isRedfoxArticleArtifact ? index + 1 : Number(record.order_num) > 0 ? Number(record.order_num) : index + 1
    }))
    : records
  const articleColumns = isRedfoxArticleArtifact ? [
    { title: '序号', dataIndex: '__display_number', width: 72 },
    { title: 'title', dataIndex: 'title', ellipsis: true, render: value => value ?? '—' },
    { title: 'pub_time', key: 'pub_time', ellipsis: true, render: (_, row) => row.pub_time || row.raw?.pub_time || row.raw?.pubTime || row.raw?.publishTime || row.raw?.publish_time || row.raw?.publicTime || row.published_at || '—' },
    { title: 'wx_name', key: 'wx_name', ellipsis: true, render: (_, row) => row.wx_name || row.raw?.wx_name || row.raw?.wxName || row.raw?.userName || row.raw?.user_name || row.publisher || '—' },
    { title: 'read_num', key: 'read_num', render: (_, row) => row.raw?.read_num ?? row.raw?.readNum ?? row.raw?.read ?? row.raw?.clicksCount ?? row.raw?.click_count ?? (row.read_num_capped && Number(row.read_num) >= 100001 ? '10w+' : row.read_num ?? '—') },
    { title: 'like_num', dataIndex: 'like_num', render: value => value ?? '—' },
    { title: '文章链接', key: 'article_url', render: (_, row) => {
      const href = safeArticleUrl(row.article_url || row.articleUrl || row.url || row.raw?.oriUrl || row.raw?.ori_url)
      return href ? <Typography.Link href={href} target="_blank" rel="noopener noreferrer">打开</Typography.Link> : '—'
    } }
  ] : [
    { title: '序号', dataIndex: '__display_number', width: 72 },
    { title: 'title', dataIndex: 'title', ellipsis: true, render: (value, row) => {
      const href = safeArticleUrl(row.article_url || row.articleUrl || row.url)
      return href ? <Typography.Link href={href} target="_blank" rel="noopener noreferrer">{value || '—'}</Typography.Link> : value ?? '—'
    } },
    { title: 'pub_time', dataIndex: 'pub_time', ellipsis: true },
    { title: 'wx_name', dataIndex: 'wx_name', ellipsis: true },
    { title: 'wx_type', dataIndex: 'wx_type', ellipsis: true },
    { title: 'read_num', dataIndex: 'read_num' },
    { title: 'like_num', dataIndex: 'like_num', sorter: (left, right) => articleMetric(left.like_num) - articleMetric(right.like_num), sortOrder: likeSortOrder }
  ]
  const columns = isArticleArtifact ? articleColumns : records.length ? Object.keys(records[0]).slice(0, 12).map(key => ({ title: key, dataIndex: key, ellipsis: true, render: value => typeof value === 'object' ? JSON.stringify(value) : value ?? '—' })) : []
  const reload = () => {
    setReloadKey(value => value + 1)
  }
  return <Drawer title={`产物预览 · ${item.artifact_id || item.id}`} width={880} open onClose={onClose}>{state.loading ? <Spin /> : state.error ? <CollectionError error={state.error} onRetry={reload} /> : <><Descriptions size="small" column={3} items={[{ key: 'type', label: '类型', children: data?.manifest?.artifact_type || '—' }, { key: 'schema', label: 'schema', children: data?.manifest?.schema_version || '—' }, { key: 'hash', label: 'SHA-256', children: data?.manifest?.sha256 || '—' }, { key: 'count', label: '记录数', children: displayCount(data?.total ?? data?.manifest?.record_count) }, { key: 'format', label: '格式', children: data?.format || 'raw' }]} /><Tabs items={[{ key: 'records', label: '标准/结构化数据', children: records.length ? <Table size="small" rowKey={(_, index) => index} dataSource={articleRecords} columns={columns} onChange={(pagination, __, sorter) => {
    const likeSorter = Array.isArray(sorter) ? sorter.find(value => value.columnKey === 'like_num') : sorter?.columnKey === 'like_num' ? sorter : null
    setLikeSortOrder(likeSorter?.order || 'descend')
    setTablePage(pagination.current || 1)
    setTablePageSize(pagination.pageSize || (isRedfoxArticleArtifact ? 200 : 10))
  }} pagination={{ current: tablePage, pageSize: tablePageSize, pageSizeOptions: isRedfoxArticleArtifact ? [50, 100, 200, 500] : undefined, showSizeChanger: true, showTotal: (total, range) => `${range[0]}-${range[1]} / ${total}`, onChange: (page, pageSize) => { setTablePage(page); setTablePageSize(pageSize) } }} scroll={{ x: isRedfoxArticleArtifact ? 960 : 760 }} /> : <Empty description="没有可解析记录" /> }, { key: 'raw', label: 'Raw / 原始响应', children: <Input.TextArea value={data?.content || ''} readOnly rows={24} /> }, { key: 'errors', label: '异常数据', children: item.artifact_type === 'collector_errors' || /error|异常/u.test(item.artifact_id || '') ? <Input.TextArea value={data?.content || ''} readOnly rows={24} /> : <Empty description="该产物不是异常集合" /> }]} /></>}</Drawer>
}

const ACTIVE_COLLECTION_RUN_STATUSES = new Set(['queued', 'pending', 'running', 'retrying'])

function ScriptRunResult({ runId, onClose }) {
  const [state, setState] = useState({ loading: true, error: null, run: null, steps: [], artifacts: [] })
  const [preview, setPreview] = useState(null)
  const load = useCallback(async ({ background = false } = {}) => {
    if (!background) setState({ loading: true, error: null, run: null, steps: [], artifacts: [] })
    try {
      const [run, steps, artifacts] = await Promise.all([api.get(`/api/collection/runs/${encodeURIComponent(runId)}`), api.get(`/api/collection/runs/${encodeURIComponent(runId)}/steps?page=1&pageSize=100`), api.get(`/api/collection/runs/${encodeURIComponent(runId)}/artifacts`)]);
      setState({ loading: false, error: null, run: run.item, steps: steps.items || [], artifacts: artifacts.items || [] })
      return run.item
    } catch (error) {
      setState(current => ({ ...current, loading: false, error }))
      return null
    }
  }, [runId])
  useEffect(() => {
    let stopped = false
    let timer = null
    const poll = async () => {
      const run = await load({ background: true })
      if (stopped) return
      if (run === null || ACTIVE_COLLECTION_RUN_STATUSES.has(run?.status)) {
        timer = window.setTimeout(poll, 2000)
      }
    }
    void poll()
    return () => {
      stopped = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [load])
  const run = state.run
  const step = state.steps[0] || {}
  const businessSummary = run?.summary?.steps?.[step.step_key]?.business_summary || {}
  const active = state.artifacts.filter(item => item.availability === 'available' && item.default_visible !== false && !['raw_response', 'debug_report', 'collector_errors', 'exceptions', 'filter_report'].includes(item.artifact_type))
  return <Drawer title={`脚本运行详情 · ${runId}`} width={920} open onClose={onClose}>{state.loading ? <Spin /> : state.error ? <CollectionError error={state.error} onRetry={load} /> : <><Card size="small" title="执行概要"><Descriptions size="small" column={4} items={[{ key: 'status', label: '状态', children: statusTag(run?.status, run) }, { key: 'kind', label: '执行方式', children: run?.run_kind === 'single_script' ? '单脚本验证' : '工作流运行' }, { key: 'duration', label: '总耗时', children: displayCount(step.duration_ms === null || step.duration_ms === undefined ? null : `${step.duration_ms} ms`) }, { key: 'input', label: '输入数', children: displayCount(step.input_count) }, { key: 'output', label: '输出数', children: displayCount(step.output_count) }, { key: 'created', label: '新增数', children: displayCount(step.created_count) }, { key: 'updated', label: '更新数', children: displayCount(step.updated_count) }, { key: 'filtered', label: '过滤数', children: displayCount(step.filtered_count) }, { key: 'requests', label: '请求数', children: displayCount(step.request_count) }, { key: 'attempt', label: '重试次数', children: step.attempt ? Math.max(0, step.attempt - 1) : '—' }, { key: 'error', label: '错误码', children: step.error_code || run?.summary?.error_code || '—' }, { key: 'message', label: '错误摘要', children: step.error_message || run?.summary?.error_message || '—' }]} />{businessSummaryText(businessSummary) ? <Typography.Text type="secondary">业务摘要：{businessSummaryText(businessSummary)}</Typography.Text> : null}</Card><Card size="small" title="步骤记录" style={{ marginTop: 12 }}><Table size="small" rowKey="id" dataSource={state.steps} pagination={false} columns={[{ title: '步骤', dataIndex: 'step_key' }, { title: '尝试', dataIndex: 'attempt' }, { title: '状态', dataIndex: 'status', render: statusTag }, { title: '请求数', dataIndex: 'request_count', render: displayCount }, { title: '错误', dataIndex: 'error_code', render: (value, row) => value ? `${value} · ${row.error_message || ''}` : '—' }]} /></Card><Card size="small" title="最终业务产物" style={{ marginTop: 12 }}><Table size="small" rowKey={row => row.artifact_id || row.id} dataSource={active} pagination={{ pageSize: 8 }} columns={[{ title: '产物', dataIndex: 'artifact_id' }, { title: '类型', dataIndex: 'artifact_type', render: value => value || '—' }, { title: 'schema', dataIndex: 'schema_version', render: value => value || '—' }, { title: '记录数', dataIndex: 'record_count', render: displayCount }, { title: 'hash', dataIndex: 'sha256', ellipsis: true }, { title: '操作', key: 'actions', render: (_, item) => <Button type="link" icon={<EyeOutlined />} onClick={() => setPreview(item)}>预览</Button> }]} locale={{ emptyText: <Empty description="暂无最终业务产物" /> }} /></Card></>}{preview ? <ArtifactPreview runId={runId} item={preview} onClose={() => setPreview(null)} /> : null}</Drawer>
}

function ScriptRunDrawer({ script, canWrite, open, onClose, onCreated }) {
  const { message } = AntApp.useApp()
  const [form] = Form.useForm()
  const [candidates, setCandidates] = useState({})
  const [loadingCandidates, setLoadingCandidates] = useState(false)
  const [redfoxDateRange, setRedfoxDateRange] = useState([])
  const isRedfoxScript = script?.script_key === 'redfox-gzh'
  const latestRedfoxDate = latestRedfoxAvailableDate()
  const requirements = useMemo(() => (script?.required_artifacts || []).filter(item => item.required !== false), [script])
  const candidateOptions = useMemo(() => Object.fromEntries(requirements.map(requirement => {
    const key = JSON.stringify([requirement.artifact_type, requirement.schema_version])
    return [key, (candidates[key] || []).map(item => ({ value: JSON.stringify(item), label: artifactLabel(item) }))]
  })), [candidates, requirements])
  useEffect(() => {
    if (!open || !script) return
    const defaultConfig = { ...(script.default_config || {}) }
    if (!defaultConfig.request_types && defaultConfig.request_type) defaultConfig.request_types = [defaultConfig.request_type]
    if (script.script_key === 'redfox-gzh') {
      const latestDate = latestRedfoxAvailableDate().format('YYYY-MM-DD')
      const startDate = defaultConfig.start_date || defaultConfig.target_date || latestDate
      const endDate = defaultConfig.end_date || defaultConfig.target_date || latestDate
      delete defaultConfig.start_date
      delete defaultConfig.end_date
      delete defaultConfig.target_date
      setRedfoxDateRange(normalizeDateRange([startDate, endDate]))
    } else {
      setRedfoxDateRange([])
    }
    form.setFieldsValue({ config: defaultConfig, advanced: '' })
    if (!requirements.length) { setCandidates({}); setLoadingCandidates(false); return }
    setLoadingCandidates(true)
    const query = new URLSearchParams({ requirements: JSON.stringify(requirements.map(({ artifact_type, schema_version }) => ({ artifact_type, schema_version }))), limit: '50' })
    api.get(`/api/collection/artifacts/candidates?${query}`).then(result => setCandidates(result.itemsByRequirement || {})).catch(() => setCandidates({})).finally(() => setLoadingCandidates(false))
  }, [open, script, form, requirements])
  const submit = async values => {
    try {
      const config = { ...(values.config || {}), ...parseJson(values.advanced, {}) }
      if (script.script_key === 'redfox-gzh') {
        const range = normalizeDateRange(redfoxDateRange)
        const startDate = range?.[0]?.format?.('YYYY-MM-DD')
        const endDate = range?.[1]?.format?.('YYYY-MM-DD')
        const latestDate = latestRedfoxAvailableDate().format('YYYY-MM-DD')
        if (!startDate || !endDate || startDate > endDate) throw new Error('请选择有效的采集日期范围')
        if (endDate > latestDate) throw new Error('日期范围最晚可选 ' + latestDate + '（新加坡时间）')
        delete config.date_range
        config.start_date = startDate
        config.end_date = endDate
      }
      if (script.script_key === 'wxrank-strategy') {
        if (!Array.isArray(config.request_types) || config.request_types.length !== 1) throw Object.assign(new Error('单独验证只能选择一个策略'), { code: 'INVALID_REQUEST_TYPES' })
        delete config.request_type
      }
      const inputArtifacts = (script.required_artifacts || []).filter(item => item.required !== false).map((requirement, index) => {
        const selected = values[`input_${index}`]
        if (!selected) throw Object.assign(new Error(`缺少输入产物：${requirement.artifact_type}`), { code: 'INPUT_MISSING' })
        return JSON.parse(selected)
      })
      const result = await api.mutate(`/api/collection/scripts/${encodeURIComponent(script.id)}/runs`, { method: 'POST', body: { config, input_artifacts: inputArtifacts, publish_mode: 'preview' } })
      message.success(`验证已启动：${result.item?.id || '请到运行中心查看'}`)
      onCreated(result.item?.id)
      onClose()
    } catch (error) { message.error(error.code === 'INPUT_MISSING' ? error.message : apiError(error)) }
  }
  if (!script) return null
  return (
    <Drawer
      title={'执行验证 · ' + (script.name || script.script_key)}
      width={620}
      open={open}
      onClose={onClose}
      destroyOnHidden
      footer={<Space><Button onClick={onClose}>取消</Button><Button type="primary" disabled={!canWrite || script.enabled === false} onClick={() => form.submit()}>创建验证 Run</Button></Space>}
    >
      <Descriptions size="small" column={2} items={[
        { key: 'platform', label: '平台', children: script.platform },
        { key: 'version', label: '版本', children: script.version },
        { key: 'hash', label: '代码 hash', children: script.code_hash || '—' },
        { key: 'entrypoint', label: '入口', children: script.entrypoint },
        { key: 'timeout', label: '超时', children: script.timeout_seconds + 's' },
        { key: 'retry', label: '重试', children: script.retry_count },
        { key: 'mode', label: '执行方式', children: runModeTag(script.run_mode) },
        { key: 'publish', label: '发布模式', children: 'preview（验证模式，不写正式库）' }
      ]} />
      <Form form={form} layout="vertical" onFinish={submit} style={{ marginTop: 16 }}>
        <Typography.Title level={5}>本次参数</Typography.Title>
        {isRedfoxScript ? (
          <Form.Item
            label="采集日期范围"
            extra={'接口每日18:30更新昨日数据；当前最晚可选 ' + latestRedfoxDate.format('YYYY-MM-DD') + '（新加坡时间）'}
          >
            <DatePicker.RangePicker
              value={redfoxDateRange}
              onChange={value => setRedfoxDateRange(normalizeDateRange(value) || [])}
              style={{ width: '100%' }}
              format="YYYY-MM-DD"
              allowClear={false}
              disabledDate={current => current && current.isAfter(latestRedfoxDate, 'day')}
            />
          </Form.Item>
        ) : null}
        {configFields(script)
          .filter(([name]) => !(isRedfoxScript && ['start_date', 'end_date', 'target_date', 'lookback_days'].includes(name)))
          .map(([name, schema]) => (
            <Form.Item
              key={name}
              name={['config', name]}
              label={schema.label || name}
              rules={name === 'request_types' ? [{ required: true, type: 'array', min: 1, max: 1, message: '单独验证请选择一个策略' }] : undefined}
              extra={schema.description || undefined}
            >
              {configControl(name, schema, { maxCount: name === 'request_types' ? 1 : null })}
            </Form.Item>
          ))}
        {requirements.length ? (
          <>
            <Typography.Title level={5}>输入产物</Typography.Title>
            {requirements.map((requirement, index) => (
              <Form.Item
                key={requirement.artifact_type + '-' + index}
                name={'input_' + index}
                label={requirement.artifact_type + '@' + requirement.schema_version}
                rules={[{ required: true, message: '请选择兼容产物' }]}
              >
                <Select
                  loading={loadingCandidates}
                  placeholder="选择已有运行产物"
                  options={candidateOptions[JSON.stringify([requirement.artifact_type, requirement.schema_version])] || []}
                />
              </Form.Item>
            ))}
          </>
        ) : null}
        <Form.Item name="advanced" label="高级 JSON 覆盖">
          <Input.TextArea rows={4} placeholder="{}（可选，仅覆盖允许的本次参数）" />
        </Form.Item>
      </Form>
    </Drawer>
  )
}

function CollectorLibrary({ canWrite, refreshKey }) {
  const { message } = AntApp.useApp()
  const [state, setState] = useState({ loading: true, error: null, items: [], total: 0 })
  const [editor, setEditor] = useState({ open: false, item: null })
  const [page, setPage] = useState(1)
  const [runScript, setRunScript] = useState(null)
  const [runId, setRunId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [recentRuns, setRecentRuns] = useState([])
  const load = async (requestedPage = 1) => {
    setState(current => ({ ...current, loading: true, error: null }))
    try {
      const result = await api.get(`/api/collection/scripts?page=${requestedPage}&pageSize=${SCRIPT_PAGE_SIZE}`)
      setPage(requestedPage)
      setState({ loading: false, error: null, items: result.items || [], total: result.total ?? 0 })
    } catch (error) { setState({ loading: false, error, items: [], total: 0 }) }
  }
  useEffect(() => { load() }, [refreshKey])
  const remove = async item => {
    try { await api.mutate(`/api/collection/scripts/${item.id}`, { method: 'DELETE', body: { expected_updated_at: item.updated_at } }); message.success('脚本已删除'); await load() } catch (error) { message.error(apiError(error)) }
  }
  const openDetail = async item => {
    setDetail(item)
    try { const result = await api.get(`/api/collection/scripts/${item.id}/runs?page=1&pageSize=10`); setRecentRuns(result.items || []) } catch (error) { message.error(apiError(error)) }
  }
  const columns = [
    { title: '脚本', key: 'script', render: (_, row) => <Button type="link" className="table-link" onClick={() => openDetail(row)}><Space direction="vertical" size={0} align="start"><Typography.Text strong>{row.name || row.script_key}</Typography.Text><Typography.Text type="secondary">{row.script_key} · v{row.version}</Typography.Text></Space></Button> },
    { title: '平台', dataIndex: 'platform', width: 100 },
    { title: '能力', dataIndex: 'capabilities', render: value => <Space wrap>{(value || []).map(item => <Tag key={item}>{item}</Tag>)}</Space> },
    { title: '执行方式', dataIndex: 'run_mode', width: 120, render: runModeTag },
    { title: '状态', dataIndex: 'enabled', width: 90, render: value => value ? <Tag color="success">启用</Tag> : <Tag>停用</Tag> },
    { title: '最近运行', key: 'recent', width: 110, render: (_, row) => <Button type="link" size="small" onClick={() => openDetail(row)}>查看</Button> },
    { title: '操作', key: 'actions', width: 280, render: (_, row) => <Space wrap>{row.run_mode === 'workflow_only' ? <Button type="link" size="small" onClick={() => { window.location.hash = 'collection-workflows'; message.info('该脚本依赖工作流上下文，请在工作流运行中验证。') }}>在工作流中验证</Button> : <Button type="link" size="small" disabled={!canWrite || row.enabled === false} onClick={() => setRunScript(row)}>执行验证</Button>}<Button type="link" size="small" onClick={() => openDetail(row)}>详情</Button><Button type="link" size="small" disabled={!canWrite} onClick={() => setEditor({ open: true, item: row })}>编辑</Button><Popconfirm title="确认删除脚本？" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => remove(row)}><Button type="link" danger size="small" disabled={!canWrite} icon={<DeleteOutlined />}>删除</Button></Popconfirm></Space> }
  ]
  return <div><PageTitle title="脚本库" description="采集能力与验证中心；单脚本验证自动启动本机 Runner，默认只展示最终业务产物。" actions={<><Button icon={<ReloadOutlined />} onClick={() => load(page)}>刷新</Button><Button type="primary" icon={<PlusOutlined />} disabled={!canWrite} onClick={() => setEditor({ open: true, item: null })}>新增脚本</Button></>} />{state.error ? <CollectionError error={state.error} onRetry={() => load(page)} /> : <><Card size="small"><Table rowKey="id" loading={state.loading} dataSource={state.items} columns={columns} pagination={false} locale={{ emptyText: <Empty description="暂无脚本登记" /> }} /></Card>{state.total > SCRIPT_PAGE_SIZE ? <Pagination size="small" current={page} pageSize={SCRIPT_PAGE_SIZE} total={state.total} showSizeChanger={false} onChange={nextPage => load(nextPage)} style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }} /> : null}</>}<CollectorEditor open={editor.open} item={editor.item} canWrite={canWrite} onClose={() => setEditor({ open: false, item: null })} onSaved={async () => { setEditor({ open: false, item: null }); await load() }} /><ScriptRunDrawer script={runScript} canWrite={canWrite} open={Boolean(runScript)} onClose={() => setRunScript(null)} onCreated={setRunId} />{runId ? <ScriptRunResult runId={runId} onClose={() => setRunId(null)} /> : null}<Drawer title={`脚本详情 · ${detail?.name || ''}`} width={760} open={Boolean(detail)} onClose={() => setDetail(null)}>{detail ? <><Descriptions size="small" column={2} items={[{ key: 'name', label: '名称', children: detail.name }, { key: 'key', label: 'script_key', children: detail.script_key }, { key: 'platform', label: '平台', children: detail.platform }, { key: 'version', label: '版本', children: detail.version }, { key: 'entrypoint', label: '入口', children: detail.entrypoint }, { key: 'hash', label: '代码 hash', children: detail.code_hash || '—' }, { key: 'mode', label: '执行方式', children: runModeTag(detail.run_mode) }, { key: 'caps', label: '能力', children: (detail.capabilities || []).join('、') || '—' }]} /><Typography.Title level={5}>输入契约</Typography.Title><Input.TextArea value={JSON.stringify({ required_artifacts: detail.required_artifacts || [], input_schema: detail.input_schema || {} }, null, 2)} readOnly rows={8} /><Typography.Title level={5}>输出契约</Typography.Title><Input.TextArea value={JSON.stringify(detail.output_schema || {}, null, 2)} readOnly rows={6} /><Typography.Title level={5}>最近执行</Typography.Title><Table size="small" rowKey="id" dataSource={recentRuns} pagination={false} columns={[{ title: '状态', dataIndex: 'status', render: statusTag }, { title: '时间', dataIndex: 'created_at', render: value => value ? new Date(value).toLocaleString('zh-CN') : '—' }, { title: '输出数', dataIndex: 'summary', render: value => displayCount(value?.steps?.[detail.script_key]?.output_count) }, { title: '操作', key: 'action', render: (_, row) => <Button type="link" onClick={() => setRunId(row.id)}>查看详情</Button> }]} locale={{ emptyText: <Empty description="暂无单脚本运行" /> }} /></> : null}</Drawer></div>
}

function WorkflowEditor({ canWrite, refreshKey }) {
  const { message } = AntApp.useApp()
  const [state, setState] = useState({ loading: true, error: null, items: [] })
  const [scripts, setScripts] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [workflowModal, setWorkflowModal] = useState({ open: false, item: null })
  const [stepModal, setStepModal] = useState(false)
  const [workflowForm] = Form.useForm()
  const [stepForm] = Form.useForm()
  const selectedStepScriptId = Form.useWatch('script_id', stepForm)
  const selectedStepScript = useMemo(() => scripts.find(script => String(script.id) === String(selectedStepScriptId)) || null, [scripts, selectedStepScriptId])
  const load = async () => {
    setState(current => ({ ...current, loading: true, error: null }))
    try {
      const [workflows, scriptResult] = await Promise.all([api.get(`/api/collection/workflows?page=1&pageSize=${PAGE_SIZE}`), api.get(`/api/collection/scripts?page=1&pageSize=${PAGE_SIZE}`)])
      const items = workflows.items || []
      setState({ loading: false, error: null, items }); setScripts(scriptResult.items || [])
      if (selectedId && items.some(item => item.id === selectedId)) await loadDetail(selectedId)
      else if (items[0]) setSelectedId(items[0].id)
      else { setSelectedId(null); setDetail(null) }
    } catch (error) { setState({ loading: false, error, items: [] }) }
  }
  const loadDetail = async id => { try { const result = await api.get(`/api/collection/workflows/${id}`); setDetail(result.item) } catch (error) { message.error(apiError(error)) } }
  useEffect(() => { load() }, [refreshKey])
  useEffect(() => { if (selectedId) loadDetail(selectedId) }, [selectedId])
  const saveWorkflow = async values => {
    try {
      const body = { ...values, default_config: parseJson(values.default_config), retention_config: parseJson(values.retention_config) }
      if (workflowModal.item) body.expected_updated_at = workflowModal.item.updated_at
      await api.mutate(workflowModal.item ? `/api/collection/workflows/${workflowModal.item.id}` : '/api/collection/workflows', { method: workflowModal.item ? 'PATCH' : 'POST', body })
      message.success(workflowModal.item ? '工作流已更新' : '工作流已创建'); setWorkflowModal({ open: false, item: null }); await load()
    } catch (error) { message.error(apiError(error)) }
  }
  const removeWorkflow = async () => {
    try { await api.mutate(`/api/collection/workflows/${detail.id}`, { method: 'DELETE', body: { expected_updated_at: detail.updated_at } }); message.success('工作流已删除'); setSelectedId(null); await load() } catch (error) { message.error(apiError(error)) }
  }
  const saveStep = async values => {
    try {
      const configOverride = parseJson(values.config_override)
      if (selectedStepScript?.script_key === 'wxrank-strategy') {
        if (!Array.isArray(values.request_types) || values.request_types.length < 1) throw Object.assign(new Error('工作流至少选择一个策略'), { code: 'INVALID_REQUEST_TYPES' })
        configOverride.request_types = values.request_types
        delete configOverride.request_type
      }
      await api.mutate(`/api/collection/workflows/${detail.id}/steps`, { method: 'POST', body: { ...values, config_override: configOverride, condition: parseJson(values.condition) } })
      message.success('步骤已添加'); setStepModal(false); stepForm.resetFields(); await loadDetail(detail.id)
    } catch (error) { message.error(apiError(error)) }
  }
  const patchStep = async (step, patch) => {
    try { await api.mutate(`/api/collection/steps/${step.id}`, { method: 'PATCH', body: { ...patch, expected_updated_at: step.updated_at } }); await loadDetail(detail.id) } catch (error) { message.error(apiError(error)) }
  }
  const deleteStep = async step => {
    try { await api.mutate(`/api/collection/steps/${step.id}`, { method: 'DELETE', body: { expected_updated_at: step.updated_at } }); message.success('步骤已删除'); await loadDetail(detail.id) } catch (error) { message.error(apiError(error)) }
  }
  const moveStep = async (index, offset) => {
    const steps = [...(detail?.steps || [])].sort((a, b) => a.seq - b.seq)
    const target = index + offset
    if (target < 0 || target >= steps.length) return
    ;[steps[index], steps[target]] = [steps[target], steps[index]]
    try { await api.mutate(`/api/collection/workflows/${detail.id}/reorder`, { method: 'POST', body: { steps: steps.map((step, position) => ({ id: step.id, seq: (position + 1) * 10 })) } }); await loadDetail(detail.id) } catch (error) { message.error(apiError(error)) }
  }
  const openWorkflow = item => { setWorkflowModal({ open: true, item }); workflowForm.setFieldsValue({ name: item?.name || '', enabled: item?.enabled !== false, revision: item?.revision || 1, default_config: jsonText(item?.default_config), retention_config: jsonText(item?.retention_config) }) }
  const openStep = () => { stepForm.setFieldsValue({ seq: ((detail?.steps || []).length + 1) * 10, enabled: true, continue_on_error: false, retry_count: 0, timeout_seconds: null, request_types: undefined, config_override: '', condition: '' }); setStepModal(true) }
  const workflowColumns = [{ title: '工作流', dataIndex: 'name', render: (value, row) => <Button type="link" className="table-link" onClick={() => setSelectedId(row.id)}>{value}</Button> }, { title: '修订', dataIndex: 'revision', width: 80 }, { title: '状态', dataIndex: 'enabled', width: 90, render: value => value ? <Tag color="success">启用</Tag> : <Tag>停用</Tag> }]
  const stepColumns = [{ title: '顺序', dataIndex: 'seq', width: 70 }, { title: 'step_key', dataIndex: 'step_key', width: 190 }, { title: '脚本', dataIndex: 'script_id', width: 90 }, { title: '状态', dataIndex: 'enabled', width: 90, render: value => value ? <Tag color="success">启用</Tag> : <Tag>停用</Tag> }, { title: '失败策略', dataIndex: 'continue_on_error', width: 110, render: value => value ? '继续' : '阻断' }, { title: '操作', key: 'actions', width: 220, render: (_, row, index) => <Space><Button type="link" size="small" disabled={!canWrite || index === 0} icon={<UpOutlined />} onClick={() => moveStep(index, -1)} /><Button type="link" size="small" disabled={!canWrite || index === (detail?.steps?.length || 1) - 1} icon={<DownOutlined />} onClick={() => moveStep(index, 1)} /><Button type="link" size="small" disabled={!canWrite} onClick={() => patchStep(row, { enabled: !row.enabled })}>{row.enabled ? '停用' : '启用'}</Button><Popconfirm title="确认删除步骤？" okText="删除" cancelText="取消" onConfirm={() => deleteStep(row)}><Button type="link" danger size="small" disabled={!canWrite}>删除</Button></Popconfirm></Space> }]
  return <div><PageTitle title="工作流" description="步骤按 seq 动态排序并通过事务 RPC 重排；编辑只影响后续新 run。" actions={<><Button icon={<ReloadOutlined />} onClick={load}>刷新</Button><Button type="primary" icon={<PlusOutlined />} disabled={!canWrite} onClick={() => openWorkflow(null)}>新建工作流</Button></>} />{state.error ? <CollectionError error={state.error} onRetry={load} /> : <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, .75fr) minmax(0, 2fr)', gap: 12 }}><Card size="small" title="工作流列表" bodyStyle={{ padding: 0 }}><Table rowKey="id" size="small" showHeader={false} loading={state.loading} dataSource={state.items} columns={workflowColumns} pagination={false} rowClassName={row => row.id === selectedId ? 'ant-table-row-selected' : ''} locale={{ emptyText: <Empty description="暂无工作流" /> }} /></Card><Card size="small" title={detail ? detail.name : '选择工作流'} extra={detail ? <Space><Button size="small" disabled={!canWrite} onClick={() => openWorkflow(detail)}>编辑</Button><Popconfirm title="删除工作流将保留已有运行历史，且有运行记录时会被拒绝。" okText="删除" cancelText="取消" onConfirm={removeWorkflow}><Button size="small" danger disabled={!canWrite}>删除</Button></Popconfirm></Space> : null}>{detail ? <><Descriptions size="small" column={3} items={[{ key: 'status', label: '状态', children: detail.enabled ? '启用' : '停用' }, { key: 'revision', label: '修订', children: detail.revision }, { key: 'steps', label: '步骤数', children: detail.steps?.length || 0 }]} /><Space style={{ margin: '12px 0' }}><Button type="primary" size="small" icon={<PlusOutlined />} disabled={!canWrite} onClick={openStep}>添加步骤</Button><Typography.Text type="secondary">步骤 key 稳定，seq 仅表示执行顺序</Typography.Text></Space><Table rowKey="id" size="small" dataSource={[...(detail.steps || [])].sort((a, b) => a.seq - b.seq)} columns={stepColumns} pagination={false} locale={{ emptyText: <Empty description="暂无步骤" /> }} /></> : <Empty description="请选择工作流" />}</Card></div>}<Modal title={workflowModal.item ? '编辑工作流' : '新建工作流'} open={workflowModal.open} onCancel={() => setWorkflowModal({ open: false, item: null })} onOk={() => workflowForm.submit()} okText="保存" cancelText="取消" okButtonProps={{ disabled: !canWrite }}><Form form={workflowForm} layout="vertical" onFinish={saveWorkflow}><Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item><Space.Compact block><Form.Item name="revision" label="修订" style={{ width: '50%' }}><InputNumber min={1} style={{ width: '100%' }} /></Form.Item><Form.Item name="enabled" label="启用" valuePropName="checked" style={{ width: '50%' }}><Switch /></Form.Item></Space.Compact><Form.Item name="default_config" label="默认配置 JSON"><Input.TextArea rows={3} /></Form.Item><Form.Item name="retention_config" label="保留配置 JSON"><Input.TextArea rows={3} /></Form.Item></Form></Modal><Modal title="添加工作流步骤" open={stepModal} onCancel={() => setStepModal(false)} onOk={() => stepForm.submit()} okText="添加" cancelText="取消" okButtonProps={{ disabled: !canWrite }}><Form form={stepForm} layout="vertical" onFinish={saveStep}><Space.Compact block><Form.Item name="step_key" label="step_key" rules={[{ required: true }]} style={{ width: '50%' }}><Input /></Form.Item><Form.Item name="script_id" label="脚本" rules={[{ required: true }]} style={{ width: '50%' }}><Select options={scripts.map(script => ({ value: script.id, label: `${script.script_key} v${script.version}` }))} /></Form.Item></Space.Compact>{selectedStepScript?.script_key === 'wxrank-strategy' ? <Form.Item name="request_types" label="执行策略" rules={[{ required: true, type: 'array', min: 1, max: 2, message: '至少选择一个策略' }]} extra="工作流会按保存的策略全部执行，运行前校验最多 4 次请求"><Select mode="multiple" maxCount={2} options={[{ value: 'account', label: '账号策略' }, { value: 'wx_type', label: '类型策略' }]} /></Form.Item> : null}<Space.Compact block><Form.Item name="seq" label="顺序" style={{ width: '33%' }}><InputNumber min={0} style={{ width: '100%' }} /></Form.Item><Form.Item name="retry_count" label="重试次数" style={{ width: '33%' }}><InputNumber min={0} max={selectedStepScript?.script_key === 'wxrank-strategy' ? 0 : 10} disabled={selectedStepScript?.script_key === 'wxrank-strategy'} /></Form.Item><Form.Item name="timeout_seconds" label="超时秒数" style={{ width: '34%' }}><InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Space.Compact><Space><Form.Item name="enabled" valuePropName="checked"><Switch checkedChildren="启用" unCheckedChildren="停用" /></Form.Item><Form.Item name="continue_on_error" valuePropName="checked"><Switch checkedChildren="失败继续" unCheckedChildren="失败阻断" /></Form.Item></Space><Form.Item name="condition" label="条件 JSON"><Input.TextArea rows={2} placeholder={'例如：{"all":[{"field":"config.enabled","eq":true}]}'}/></Form.Item><Form.Item name="config_override" label="步骤配置 JSON"><Input.TextArea rows={2} placeholder="{}" /></Form.Item></Form></Modal></div>
}

function ArtifactBrowser({ runId, canWrite }) {
  const { message } = AntApp.useApp()
  const [state, setState] = useState({ loading: false, error: null, items: [] })
  const [preview, setPreview] = useState(null)
  const [publishPreview, setPublishPreview] = useState(null)
  const load = async () => {
    if (!runId) return
    setState({ loading: true, error: null, items: [] })
    try { const result = await api.get(`/api/collection/runs/${encodeURIComponent(runId)}/artifacts`); setState({ loading: false, error: null, items: result.items || [] }) } catch (error) { setState({ loading: false, error, items: [] }) }
  }
  useEffect(() => { load() }, [runId])
  const open = async item => { try { setPreview(await api.get(`/api/collection/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(item.artifact_id || item.id)}`)) } catch (error) { message.error(apiError(error)) } }
  const previewPublish = async item => { try { setPublishPreview(await api.mutate(`/api/collection/runs/${encodeURIComponent(runId)}/publish/preview`, { method: 'POST', body: { artifact_id: item.artifact_id || item.id } })) } catch (error) { message.error(apiError(error)) } }
  const commitPublish = async () => { try { const result = await api.mutate(`/api/collection/runs/${encodeURIComponent(runId)}/publish/commit`, { method: 'POST', body: { artifact_id: publishPreview.artifact_id, confirm_hash: publishPreview.write_set_hash } }); message.success(`发布运行已创建：${result.queued_run?.id || '请到运行中心查看'}`); setPublishPreview(null) } catch (error) { message.error(apiError(error)) } }
  const retain = async () => { try { await api.mutate(`/api/collection/runs/${encodeURIComponent(runId)}/retain`, { method: 'POST', body: { pinned: true } }); message.success('运行产物已保留') } catch (error) { message.error(apiError(error)) } }
  return <Card size="small" title={runId ? `运行 ${runId} 的最终业务产物` : '最终业务产物'} extra={runId ? <Space><Button size="small" disabled={!canWrite} onClick={retain}>保留</Button><Button size="small" icon={<ReloadOutlined />} onClick={load}>刷新</Button></Space> : null}>{!runId ? <Empty description="请在运行中心选择一个运行" /> : state.error ? <CollectionError error={state.error} onRetry={load} /> : state.loading ? <Spin /> : <Table size="small" rowKey={row => row.artifact_id || row.id} dataSource={state.items} pagination={false} columns={[{ title: '产物 ID', dataIndex: 'artifact_id' }, { title: '业务类型', dataIndex: 'artifact_type' }, { title: '来源步骤', dataIndex: 'step_key' }, { title: '记录数', dataIndex: 'record_count', render: value => value ?? '—' }, { title: '可用性', dataIndex: 'availability', render: value => <Tag color={value === 'available' ? 'success' : 'warning'}>{value || '未知'}</Tag> }, { title: '操作', key: 'actions', render: (_, row) => <Space><Button type="link" size="small" icon={<EyeOutlined />} onClick={() => open(row)}>预览</Button>{row.artifact_type === 'write_set' || row.artifact_id === 'frozen-write-set.json' ? <Button type="link" size="small" disabled={!canWrite} icon={<FileSearchOutlined />} onClick={() => previewPublish(row)}>发布预览</Button> : null}</Space> }]} locale={{ emptyText: <Empty description="暂无最终业务产物" /> }} />}{preview ? <Drawer title={`产物预览 · ${preview.artifact_id}`} width={720} open onClose={() => setPreview(null)}><Descriptions size="small" column={2} items={[{ key: 'hash', label: 'SHA-256', children: preview.manifest?.sha256 || '—' }, { key: 'truncated', label: '读取状态', children: preview.truncated ? '已截断' : '完整' }]} /><Input.TextArea value={preview.content} readOnly rows={24} /></Drawer> : null}<Modal title="Write-set 发布预览" open={Boolean(publishPreview)} onCancel={() => setPublishPreview(null)} okText="确认提交" cancelText="关闭" okButtonProps={{ danger: true, disabled: !canWrite }} onOk={commitPublish}>{publishPreview ? <Descriptions size="small" column={1} items={[{ key: 'hash', label: '确认 hash', children: publishPreview.write_set_hash }, { key: 'accounts', label: '账号写集', children: publishPreview.counts.accounts }, { key: 'articles', label: '文章写集', children: publishPreview.counts.articles }, { key: 'hotwords', label: '热词写集', children: publishPreview.counts.hotwords }, { key: 'status', label: '下一步', children: '提交只会排队 Runner；正式业务写入仍由 publish-results 子进程执行。' }]} /> : null}</Modal></Card>
}

const RunListTable = memo(function RunListTable({ items, loading, canWrite, onSelectRun, onMutateRun }) {
  const columns = useMemo(() => [
    { title: '运行 ID', dataIndex: 'id', width: 250, ellipsis: true },
    { title: '工作流', dataIndex: 'workflow_id', width: 100 },
    { title: '状态', dataIndex: 'status', width: 110, render: statusTag },
    { title: '开始时间', dataIndex: 'started_at', render: value => value ? new Date(value).toLocaleString('zh-CN') : '—' },
    { title: '操作', key: 'actions', width: 220, render: (_, row) => <Space>
      <Button type="link" size="small" onClick={event => { event.stopPropagation(); onSelectRun(row) }}>详情</Button>
      {['queued', 'pending', 'running', 'retrying'].includes(row.status) ? <Button type="link" danger size="small" disabled={!canWrite} icon={<StopOutlined />} onClick={event => { event.stopPropagation(); onMutateRun('cancel', row) }}>取消</Button> : null}
      <Button type="link" size="small" disabled={!canWrite || ['running', 'queued', 'pending', 'retrying'].includes(row.status)} onClick={event => { event.stopPropagation(); onMutateRun('rerun', row) }}>重跑</Button>
    </Space> }
  ], [canWrite, onMutateRun, onSelectRun])
  const onRow = useCallback(row => ({ onClick: () => onSelectRun(row) }), [onSelectRun])
  return <Card size="small"><Table rowKey="id" loading={loading} dataSource={items} columns={columns} pagination={false} onRow={onRow} locale={{ emptyText: <Empty description="暂无运行" /> }} /></Card>
}, (previous, next) => {
  return previous.items === next.items
    && previous.loading === next.loading
    && previous.canWrite === next.canWrite
    && previous.onSelectRun === next.onSelectRun
    && previous.onMutateRun === next.onMutateRun
})

const RunDetailsDrawer = memo(function RunDetailsDrawer({ run, onClose }) {
  const { message } = AntApp.useApp()
  const messageRef = useRef(message)
  messageRef.current = message
  const [stepState, setStepState] = useState({ runId: null, items: [] })
  const steps = stepState.runId === run?.id ? stepState.items : []

  useEffect(() => {
    if (!run?.id) {
      setStepState({ runId: null, items: [] })
      return undefined
    }
    let active = true
    setStepState({ runId: run.id, items: [] })
    api.get(`/api/collection/runs/${encodeURIComponent(run.id)}/steps`)
      .then(result => { if (active) setStepState({ runId: run.id, items: result.items || [] }) })
      .catch(error => { if (active) messageRef.current.error(apiError(error)) })
    return () => { active = false }
  }, [run?.id])

  return <Drawer title={run ? `运行详情 · ${run.id}` : '运行详情'} width={720} open={Boolean(run)} onClose={onClose}>{run ? <><Descriptions size="small" column={2} items={[{ key: 'status', label: '状态', children: statusTag(run.status, run) }, { key: 'workflow', label: '工作流 ID', children: run.workflow_id }, { key: 'lease', label: '租约', children: run.lease_until || '—' }, { key: 'publish', label: '发布状态', children: run.publish_status || '—' }]} /><Typography.Title level={5}>步骤记录</Typography.Title><Table size="small" rowKey="id" dataSource={steps} pagination={false} columns={[{ title: '步骤', dataIndex: 'step_key' }, { title: '尝试', dataIndex: 'attempt' }, { title: '状态', dataIndex: 'status', render: statusTag }, { title: '请求数', dataIndex: 'request_count', render: value => value ?? '—' }, { title: '错误', dataIndex: 'error_message', ellipsis: true }]} locale={{ emptyText: <Empty description="暂无步骤记录" /> }} /></> : null}</Drawer>
})

const RunCenter = memo(function RunCenter({ canWrite, refreshKey, onSelectRun }) {
  const { message } = AntApp.useApp()
  const messageRef = useRef(message)
  messageRef.current = message
  const [state, setState] = useState({ loading: true, error: null, items: [] })
  const [workflows, setWorkflows] = useState([])
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [form] = Form.useForm()
  const load = useCallback(async (requestedPage = 1) => {
    setState(current => ({ ...current, loading: true, error: null }))
    try {
      const runs = await api.get(`/api/collection/runs?page=${requestedPage}&pageSize=${RUN_PAGE_SIZE}`)
      setState({ loading: false, error: null, items: runs.items || [] })
      setPage(requestedPage)
      setHasMore(Boolean(runs.hasMore))
    } catch (error) { setState({ loading: false, error, items: [] }) }
  }, [])
  const loadWorkflows = useCallback(async () => {
    try { const result = await api.get(`/api/collection/workflows?page=1&pageSize=${PAGE_SIZE}`); setWorkflows(result.items || []) }
    catch (error) { messageRef.current.error(apiError(error)) }
  }, [])
  useEffect(() => { load(); loadWorkflows() }, [load, loadWorkflows, refreshKey])
  const selectRun = useCallback(run => { onSelectRun(run || null) }, [onSelectRun])
  const create = async values => { try { await api.mutate('/api/collection/runs', { method: 'POST', body: { workflow_id: values.workflow_id, config: parseJson(values.config), rule_snapshot: parseJson(values.rule_snapshot), strategy_snapshot: parseJson(values.strategy_snapshot) } }); message.success('工作流运行已创建，等待 Worker 领取'); setCreateOpen(false); form.resetFields(); await load() } catch (error) { message.error(apiError(error)) } }
  const mutateRun = useCallback(async (action, run) => { try { await api.mutate(`/api/collection/runs/${run.id}/${action}`, { method: 'POST', body: {} }); messageRef.current.success(action === 'cancel' ? '运行已取消' : '已创建重跑'); await load(); if (action === 'rerun') await selectRun(null) } catch (error) { messageRef.current.error(apiError(error)) } }, [load, selectRun])
  return <div><PageTitle title="运行中心" description="正式工作流仍由 Worker 领取、续租、执行和恢复；单脚本验证由 one-shot Runner 自动领取。状态来自真实运行记录。" actions={<><Button icon={<ReloadOutlined />} onClick={() => { load(page); loadWorkflows() }}>刷新</Button><Button type="primary" icon={<PlusOutlined />} disabled={!canWrite || !workflows.length} onClick={() => setCreateOpen(true)}>创建运行</Button></>} />{state.error ? <CollectionError error={state.error} onRetry={() => load(page)} /> : <><RunListTable items={state.items} loading={state.loading} canWrite={canWrite} onSelectRun={selectRun} onMutateRun={mutateRun} /><Space style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}><Button size="small" disabled={page <= 1 || state.loading} onClick={() => load(page - 1)}>上一页</Button><Typography.Text type="secondary">第 {page} 页</Typography.Text><Button size="small" disabled={!hasMore || state.loading} onClick={() => load(page + 1)}>下一页</Button></Space></>}<Modal title="创建运行" open={createOpen} onCancel={() => setCreateOpen(false)} onOk={() => form.submit()} okText="创建" cancelText="取消" okButtonProps={{ disabled: !canWrite }}><Form form={form} layout="vertical" onFinish={create}><Form.Item name="workflow_id" label="工作流" rules={[{ required: true }]}><Select options={workflows.map(item => ({ value: item.id, label: `${item.name} · #${item.id}` }))} /></Form.Item><Form.Item name="config" label="本次配置覆盖 JSON"><Input.TextArea rows={3} placeholder="{}" /></Form.Item><Form.Item name="rule_snapshot" label="规则快照 JSON"><Input.TextArea rows={3} placeholder="{}" /></Form.Item><Form.Item name="strategy_snapshot" label="策略快照 JSON"><Input.TextArea rows={3} placeholder="{}" /></Form.Item></Form></Modal></div>
})

export const CollectionPage = memo(function CollectionPage({ canWrite, refreshKey }) {
  const [selectedRun, setSelectedRun] = useState(null)
  const selectedRunId = selectedRun?.id || null
  const staticItems = useMemo(() => [
    { key: 'scripts', label: '脚本库', children: <CollectorLibrary canWrite={canWrite} refreshKey={refreshKey} /> },
    { key: 'workflows', label: '工作流', children: <WorkflowEditor canWrite={canWrite} refreshKey={refreshKey} /> },
    { key: 'runs', label: '运行中心', children: <RunCenter canWrite={canWrite} refreshKey={refreshKey} onSelectRun={setSelectedRun} /> },
    { key: 'publish', label: '发布预览', children: <Card size="small"><Alert type="info" showIcon message="发布预览使用冻结 write-set 产物" description="只有 publish-results 步骤生成并校验 write-set 后，才允许进入预览与显式提交；当前页面不会绕过 Runner 直接写入正式业务表。" /></Card> }
  ], [canWrite, refreshKey])
  const artifactItem = useMemo(() => ({ key: 'artifacts', label: '临时数据', children: <ArtifactBrowser runId={selectedRunId} canWrite={canWrite} /> }), [canWrite, selectedRunId])
  const items = useMemo(() => [staticItems[0], staticItems[1], staticItems[2], artifactItem, staticItems[3]], [artifactItem, staticItems])
  return <div className="management-page"><PageTitle title="采集编排" description="脚本、工作流、运行、临时产物和发布边界统一管理。" /><Alert className="readonly-alert" type="info" showIcon message={canWrite ? '已具备本机写权限，变更会经过服务端校验。' : '当前为只读状态；浏览、日志和产物预览不需要令牌，写操作需要本机令牌。'} /><Tabs items={items} /><RunDetailsDrawer run={selectedRun} onClose={() => setSelectedRun(null)} /></div>
})
