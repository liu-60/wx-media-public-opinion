import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Collapse,
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
  Tooltip,
  Typography
} from 'antd'
import {
  CheckOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  DownOutlined,
  EyeOutlined,
  FileSearchOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  SaveOutlined,
  UpOutlined
} from '@ant-design/icons'
import { createApiClient, createTokenStore } from '../public/api-client.mjs'
import { formatArrayConfigForForm, parseArrayConfigFromForm } from './config-values.mjs'
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
  if (error?.code === 'SCRIPT_IN_USE') return error.message || '当前脚本已被工作流引用，不能删除。'
  if (error?.code === 'CANCEL_UNSUPPORTED') return error.message || '当前执行器不支持真实中断，运行状态未修改。'
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
        {['WXRANK_API_KEY', 'WXRANK_AUTHORIZATION', 'WXRANK_COOKIE', 'REDFOX_API_KEY', 'LLM_API_KEY'].includes(item.credential_ref)
          ? <Typography.Text type="secondary">该接口凭证统一在“配置信息”页面维护。</Typography.Text>
          : <Form.Item label="配置 key 值" name="credential_value" extra={`仅保存到本机服务端；${credentialMeta?.configured ? `当前已配置（${credentialMeta.masked}，留空保持不变）。` : '当前未检测到配置，请输入。'}`}><Input.Password autoComplete="new-password" placeholder={credentialMeta?.configured ? '留空保持不变' : '请输入配置 key'} /></Form.Item>}
      </> : null}
      <Form.Item label="默认配置 JSON" name="default_config"><Input.TextArea rows={3} placeholder="{}" /></Form.Item>
      <Form.Item label="输入 schema JSON" name="input_schema"><Input.TextArea rows={3} placeholder="{}" /></Form.Item>
      <Form.Item label="输出 schema JSON" name="output_schema"><Input.TextArea rows={3} placeholder="{}" /></Form.Item>
      <Form.Item label="启用" name="enabled" valuePropName="checked"><Switch /></Form.Item>
    </Form>
  </Modal>
}

const API_CREDENTIALS = Object.freeze([
  { credential_ref: 'WXRANK_API_KEY', platform: 'WxRank' },
  { credential_ref: 'REDFOX_API_KEY', platform: 'RedFox' }
])

function CredentialSettings({ canWrite, refreshKey }) {
  const { message } = AntApp.useApp()
  const [form] = Form.useForm()
  const [state, setState] = useState({ loading: true, error: null, items: [] })
  const [budgetState, setBudgetState] = useState({ loading: true, error: null, limits: {}, usage: {}, date: '', timezone: 'Asia/Singapore', max_limit: 100 })
  const [budgetDraft, setBudgetDraft] = useState({})
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const [budgetSaving, setBudgetSaving] = useState(false)
  const load = async () => {
    setState(current => ({ ...current, loading: true, error: null }))
    setBudgetState(current => ({ ...current, loading: true, error: null }))
    const [credentials, budget] = await Promise.allSettled([
      Promise.all(API_CREDENTIALS.map(item => api.get(`/api/collection/credentials/${encodeURIComponent(item.credential_ref)}`))),
      api.get('/api/collection/debug-api-budget')
    ])
    if (credentials.status === 'fulfilled') setState({ loading: false, error: null, items: credentials.value })
    else setState({ loading: false, error: credentials.reason, items: [] })
    if (budget.status === 'fulfilled') {
      setBudgetState({ loading: false, error: null, ...budget.value })
      setBudgetDraft(budget.value.limits || {})
    } else setBudgetState(current => ({ ...current, loading: false, error: budget.reason }))
  }
  useEffect(() => { load() }, [refreshKey])
  const openEdit = item => { setEditing(item); form.resetFields(); form.setFieldValue('value', '') }
  const save = async values => {
    if (!editing) return
    setSaving(true)
    try {
      const result = await api.mutate(`/api/collection/credentials/${encodeURIComponent(editing.credential_ref)}`, { method: 'PUT', body: { value: values.value } })
      setState(current => ({ ...current, items: current.items.map(item => item.credential_ref === result.credential_ref ? result : item) }))
      setEditing(null)
      form.resetFields()
      message.success(`${editing.platform} API Key 已保存；新建运行会立即使用新配置`)
    } catch (error) { message.error(apiError(error)) } finally { setSaving(false) }
  }
  const budgetIsValid = ['WxRank', 'Redfox'].every(platform => Number.isInteger(budgetDraft[platform]) && budgetDraft[platform] >= 0 && budgetDraft[platform] <= budgetState.max_limit)
  const saveBudget = async () => {
    if (!budgetIsValid) return
    setBudgetSaving(true)
    try {
      const result = await api.mutate('/api/collection/debug-api-budget', { method: 'PUT', body: { limits: { WxRank: budgetDraft.WxRank, Redfox: budgetDraft.Redfox } } })
      setBudgetState({ loading: false, error: null, ...result })
      setBudgetDraft(result.limits || {})
      message.success('调试请求额度已保存；之后启动的运行立即生效，当天已用次数不会清零')
    } catch (error) { message.error(apiError(error)) } finally { setBudgetSaving(false) }
  }
  const columns = [
    { title: '平台', dataIndex: 'platform' },
    { title: '配置状态', key: 'status', render: (_, row) => row.configured ? <Tag color="success">已配置</Tag> : <Tag>未配置</Tag> },
    { title: 'Key', key: 'masked', render: (_, row) => row.masked || '—' },
    { title: '操作', key: 'action', render: (_, row) => <Button type="link" disabled={!canWrite} onClick={() => openEdit(row)}>修改</Button> }
  ]
  const budgetColumns = [
    { title: '平台', dataIndex: 'platform' },
    { title: '今日已用 / 当前额度', key: 'usage', render: (_, row) => `${budgetState.usage?.[row.key] ?? 0} / ${budgetState.limits?.[row.key] ?? '—'} 次` },
    { title: '每日调试额度', key: 'limit', render: (_, row) => <InputNumber min={0} max={budgetState.max_limit} precision={0} step={1} disabled={!canWrite || budgetState.loading} value={budgetDraft[row.key]} onChange={value => setBudgetDraft(current => ({ ...current, [row.key]: value }))} addonAfter="次" aria-label={`${row.platform} 每日调试额度`} /> }
  ]
  const budgetRows = [{ key: 'WxRank', platform: 'WxRank' }, { key: 'Redfox', platform: 'RedFox' }]
  return <div>
    <PageTitle title="接口配置" description="凭证使用现有服务端 Credential Store；页面只读脱敏状态，完整 Key 不会通过查询接口返回。" actions={<Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>} />
    {state.error ? <CollectionError error={state.error} onRetry={load} /> : <Card size="small"><Table rowKey="credential_ref" size="small" loading={state.loading} dataSource={API_CREDENTIALS.map(definition => ({ ...definition, ...(state.items.find(item => item.credential_ref === definition.credential_ref) || {}) }))} columns={columns} pagination={false} /></Card>}
    <Card size="small" title="调试请求额度" extra={<Button type="primary" icon={<SaveOutlined />} disabled={!canWrite || !budgetIsValid || budgetState.loading} loading={budgetSaving} onClick={saveBudget}>保存额度</Button>} style={{ marginTop: 16 }}>
      {budgetState.error ? <CollectionError error={budgetState.error} onRetry={load} /> : <>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>按平台分别限制每天的真实调试请求数。额度范围 0–{budgetState.max_limit}；设为 0 会阻止该平台请求。计数按 {budgetState.timezone} 的 {budgetState.date || '今日'} 统计，修改额度不会清零已用次数，新启动的运行立即读取新额度。</Typography.Paragraph>
        <Table rowKey="key" size="small" loading={budgetState.loading} dataSource={budgetRows} columns={budgetColumns} pagination={false} />
      </>}
    </Card>
    <Modal title={`修改 ${editing?.platform || ''} API Key`} open={Boolean(editing)} onCancel={() => setEditing(null)} onOk={() => form.submit()} confirmLoading={saving} okText="保存" cancelText="取消" okButtonProps={{ disabled: !canWrite }}><Form form={form} layout="vertical" onFinish={save}><Form.Item name="value" label="新 API Key" rules={[{ required: true, whitespace: true, message: '请输入新的 API Key' }]} extra="仅写入本机服务端 Credential Store；保存后新运行无需重启即可读取。"><Input.Password autoComplete="new-password" placeholder="请输入新 Key" /></Form.Item></Form></Modal>
  </div>
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

function diagnoseStep(step, run) {
  const code = String(step?.error_code || run?.summary?.error_code || '').toUpperCase()
  const message = String(step?.error_message || run?.summary?.error_message || run?.summary?.message || '')
  const combined = `${code} ${message}`
  if (!code && !message) return null
  if (/ARTIFACT|SCHEMA|HASH_MISMATCH/u.test(code)) return { category: '产物校验失败', next: '检查该步骤的产物清单、类型、schema_version 和校验值；查看下方 stderr 日志。' }
  if (/PARSE|INVALID_JSON|SYNTAXERROR|UNEXPECTED TOKEN/u.test(`${code} ${message}`.toUpperCase())) return { category: '解析失败', next: '检查接口响应样例与解析字段；优先核对本次原始响应和异常产物。' }
  if (/AUTH|UNAUTHORIZED|CREDENTIAL|TOKEN|401|等待认证/iu.test(combined)) return { category: '认证问题', next: '核对本机对应平台凭证是否已配置、是否过期；仅重新发起验证前确认外部请求影响。' }
  if (/ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|FETCH FAILED|429|HTTP 5\d\d|网络|连接超时/iu.test(combined)) return { category: '网络或接口不可达', next: '先确认目标服务和网络状态；若是限流，等待平台额度窗口恢复后再试。' }
  if (/INVALID|REQUIRED|DATE|TIME VALUE|参数|必填|日期/iu.test(combined)) return { category: '参数校验', next: '对照脚本参数说明核对必填项、日期范围和当前参数快照。' }
  if (/WXRANK|REDFOX|BUSINESS|API_ERROR|HTTP_4\d\d/iu.test(code)) return { category: '接口业务错误', next: '以接口返回码和响应内容为准；检查该平台对日期、目标和请求额度的限制。' }
  return { category: '未分类错误', next: '查看失败步骤和标准错误日志，保留错误码与原始错误信息后再判断。' }
}

function logLevel(line) {
  let value = String(line || '')
  try {
    const parsed = JSON.parse(value)
    value = `${parsed.level || ''} ${parsed.severity || ''} ${value}`
  } catch {}
  const found = value.match(/\b(ERROR|ERR|FATAL|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/iu)?.[1]?.toLowerCase()
  if (!found) return null
  if (['error', 'err', 'fatal'].includes(found)) return 'error'
  if (found.startsWith('warn')) return 'warning'
  return 'info'
}

function redactParameters(value, key = '') {
  if (/(?:api[_-]?key|authorization|cookie|token|secret|password|credential)/iu.test(key)) return value ? '（已脱敏）' : value
  if (Array.isArray(value)) return value.map(item => redactParameters(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactParameters(childValue, childKey)]))
  return value
}

function StepLogPanel({ runId, step }) {
  const { message } = AntApp.useApp()
  const [expanded, setExpanded] = useState(false)
  const [retryKey, setRetryKey] = useState(0)
  const [search, setSearch] = useState('')
  const [level, setLevel] = useState('all')
  const [state, setState] = useState({ loading: false, error: null, item: null })
  useEffect(() => {
    if (!expanded || !runId || !step?.id || !step?.log_ref) return
    let active = true
    setState({ loading: true, error: null, item: null })
    api.get(`/api/collection/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(step.id)}/log`, { cache: false })
      .then(item => { if (active) setState({ loading: false, error: null, item }) })
      .catch(error => { if (active) setState({ loading: false, error, item: null }) })
    return () => { active = false }
  }, [expanded, runId, step?.id, step?.log_ref, retryKey])
  const allLines = String(state.item?.content || '').split(/\r?\n/u)
  const hasLevels = allLines.some(line => logLevel(line))
  const visibleLines = allLines.filter(line => {
    if (search && !line.toLocaleLowerCase().includes(search.toLocaleLowerCase())) return false
    return level === 'all' || (hasLevels && logLevel(line) === level)
  })
  const visibleText = visibleLines.join('\n')
  const copy = async () => {
    try { await navigator.clipboard.writeText(visibleText); message.success('当前筛选日志已复制') }
    catch { message.error('复制失败，请检查浏览器剪贴板权限') }
  }
  const download = () => {
    const blob = new Blob([visibleText], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    const safeName = `${runId}-${step?.step_key || 'step'}-${step?.attempt || 1}`.replace(/[^\w.-]/gu, '_')
    link.href = url
    link.download = `${safeName}.log`
    link.click()
    URL.revokeObjectURL(url)
  }
  return <Card size="small" style={{ marginTop: 12 }} title={`步骤日志 · ${step?.step_key || '未知步骤'} · 尝试 ${step?.attempt || '—'}`} extra={<Button type="link" onClick={() => setExpanded(value => !value)} disabled={!step?.log_ref}>{expanded ? '收起' : step?.log_ref ? '查看 stderr.log' : '无已保存日志'}</Button>}>
    {expanded ? state.loading ? <Spin /> : state.error ? <CollectionError error={state.error} onRetry={() => setRetryKey(value => value + 1)} /> : state.item ? <>
      {state.item.truncated ? <Alert style={{ marginBottom: 8 }} type="info" showIcon message="日志较长，当前展示末尾 200,000 个字符。" /> : null}
      {!hasLevels ? <Typography.Text type="secondary">该日志没有可识别的级别字段，级别筛选不可用。</Typography.Text> : null}
      <Space wrap style={{ display: 'flex', margin: '8px 0' }}>
        <Input.Search allowClear value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索日志文本" style={{ width: 260 }} />
        <Select value={level} onChange={setLevel} disabled={!hasLevels} options={[{ value: 'all', label: '全部级别' }, { value: 'error', label: '错误' }, { value: 'warning', label: '警告' }, { value: 'info', label: '信息 / 调试' }]} style={{ width: 150 }} />
        <Button icon={<CopyOutlined />} onClick={copy}>复制当前结果</Button>
        <Button icon={<DownloadOutlined />} onClick={download}>下载当前结果</Button>
      </Space>
      <Input.TextArea readOnly rows={14} value={visibleText} placeholder="没有匹配的日志行" style={{ fontFamily: 'Consolas, monospace' }} />
    </> : null : null}
  </Card>
}

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
  if (type === 'tags') {
    const options = schema.options || []
    return <Select mode="tags" tokenSeparators={schema.token_separators || [',', '，', ';', '；', '\n']} maxCount={maxCount ?? schema.max} options={options.map(value => typeof value === 'object' ? value : ({ value, label: value }))} allowClear placeholder={schema.placeholder || schema.label || name} />
  }
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
  if (type === 'array') return <Input.TextArea rows={5} placeholder={'JSON 数组，例如：\n["值1", "值2"]'} />
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

function articlePublishedTime(row) {
  const original = row.pub_time || row.raw?.pub_time || row.raw?.pubTime || row.raw?.publishTime || row.raw?.publish_time || row.raw?.publicTime
  if (original) return original
  if (!row.published_at) return '—'
  const date = new Date(row.published_at)
  if (Number.isNaN(date.getTime())) return row.published_at
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
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
    { title: '发布时间', key: 'pub_time', ellipsis: true, render: (_, row) => articlePublishedTime(row) },
    { title: '公众号', key: 'wx_name', ellipsis: true, render: (_, row) => row.wx_name || row.raw?.wx_name || row.raw?.wxName || row.raw?.userName || row.raw?.user_name || row.raw?.author || row.publisher || row.wx_biz || '—' },
    { title: '阅读量', key: 'read_num', render: (_, row) => row.raw?.read_num ?? row.raw?.readNum ?? row.raw?.read ?? row.raw?.readCount ?? row.raw?.clicksCount ?? row.raw?.click_count ?? (row.read_num_capped && Number(row.read_num) >= 100001 ? '10w+' : row.read_num ?? '—') },
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
    { title: '发布时间', key: 'published_at', ellipsis: true, render: (_, row) => articlePublishedTime(row) },
    { title: '公众号', key: 'wx_name', ellipsis: true, render: (_, row) => row.wx_name || row.publisher || row.wx_biz || '—' },
    { title: 'wx_type', dataIndex: 'wx_type', ellipsis: true },
    { title: '阅读量', dataIndex: 'read_num', render: (value, row) => row.read_num_capped && Number(value) >= 100001 ? '10w+' : value ?? '—' },
    { title: 'like_num', dataIndex: 'like_num', sorter: (left, right) => articleMetric(left.like_num) - articleMetric(right.like_num), sortOrder: likeSortOrder }
  ]
  if (isArticleArtifact && /hotword-expand-(?:manual-)?articles\.json/u.test(String(item.artifact_id || item.id || ''))) {
    articleColumns.splice(1, 0, { title: '来源平台', key: 'source_platforms', render: (_, row) => (row.source_platforms || [...new Set((row.source_refs || []).map(ref => ref.platform))]).join('、') || row.source_platform || '—' })
  }
  const columns = isArticleArtifact ? articleColumns : records.length ? Object.keys(records[0]).slice(0, 12).map(key => ({ title: key, dataIndex: key, ellipsis: true, render: value => typeof value === 'object' ? JSON.stringify(value) : value ?? '—' })) : []
  const reload = () => {
    setReloadKey(value => value + 1)
  }
  const changeCounts = item?.change_counts || data?.manifest?.change_counts || null
  const changeCountItems = changeCounts ? [
    { key: 'created', label: '新增', children: displayCount(changeCounts.created) },
    { key: 'updated', label: '更新', children: displayCount(changeCounts.updated) },
    { key: 'deleted', label: '删除', children: displayCount(changeCounts.deleted) },
    { key: 'total', label: '总数', children: displayCount(changeCounts.total) }
  ] : []
  return <Drawer title={`产物预览 · ${item.artifact_id || item.id}`} width={880} open onClose={onClose}>{state.loading ? <Spin /> : state.error ? <CollectionError error={state.error} onRetry={reload} /> : <><Descriptions size="small" column={3} items={[{ key: 'type', label: '类型', children: data?.manifest?.artifact_type || '—' }, { key: 'schema', label: 'schema', children: data?.manifest?.schema_version || '—' }, { key: 'hash', label: 'SHA-256', children: data?.manifest?.sha256 || '—' }, { key: 'count', label: '记录数', children: displayCount(data?.total ?? data?.manifest?.record_count) }, { key: 'format', label: '格式', children: data?.format || 'raw' }]} />{changeCountItems.length ? <Descriptions size="small" column={4} style={{ marginTop: 12 }} items={changeCountItems} /> : null}<Tabs items={[{ key: 'records', label: '业务列表', children: records.length ? <Table size="small" rowKey={(_, index) => index} dataSource={articleRecords} columns={columns} onChange={(pagination, __, sorter) => {
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
  const diagnosis = diagnoseStep(step, run)
  return <Drawer title={`脚本运行详情 · ${runId}`} width={920} open onClose={onClose}>
    {state.loading ? <Spin /> : state.error ? <CollectionError error={state.error} onRetry={load} /> : <>
      <Card size="small" title="执行概要">
        <Descriptions size="small" column={4} items={[
          { key: 'status', label: '状态', children: statusTag(run?.status, run) },
          { key: 'kind', label: '执行方式', children: run?.run_kind === 'single_script' ? '单脚本验证' : '工作流运行' },
          { key: 'duration', label: '已耗时', children: displayCount(step.duration_ms === null || step.duration_ms === undefined ? null : `${step.duration_ms} ms`) },
          { key: 'updated', label: '最近更新', children: runDate(run?.updated_at) },
          { key: 'input', label: '输入数', children: displayCount(step.input_count) },
          { key: 'output', label: '标准化输出数', children: displayCount(step.output_count) },
          { key: 'created', label: '脚本报告新增数', children: displayCount(step.created_count) },
          { key: 'updated_count', label: '脚本报告更新数', children: displayCount(step.updated_count) },
          { key: 'filtered', label: '脚本报告过滤数', children: displayCount(step.filtered_count) },
          { key: 'requests', label: '脚本记录请求数', children: displayCount(step.request_count) },
          { key: 'attempt', label: '重试次数', children: step.attempt ? Math.max(0, step.attempt - 1) : '—' },
          { key: 'error', label: '错误码', children: step.error_code || run?.summary?.error_code || '—' },
          { key: 'message', label: '错误摘要', span: 3, children: step.error_message || run?.summary?.error_message || '—' }
        ]} />
        {diagnosis ? <Alert style={{ marginTop: 8 }} type="warning" showIcon message={`错误分类：${diagnosis.category}`} description={diagnosis.next} /> : null}
        {businessSummaryText(businessSummary) ? <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>业务摘要：{businessSummaryText(businessSummary)}</Typography.Paragraph> : null}
      </Card>
      <StepLogPanel runId={runId} step={step} />
      <Card size="small" title="步骤记录" style={{ marginTop: 12 }}>
        <Table size="small" rowKey="id" dataSource={state.steps} pagination={false} columns={[
          { title: '步骤', dataIndex: 'step_key' },
          { title: '尝试', dataIndex: 'attempt' },
          { title: '状态', dataIndex: 'status', render: statusTag },
          { title: '脚本记录请求数', dataIndex: 'request_count', render: displayCount },
          { title: '错误', dataIndex: 'error_code', render: (value, row) => value ? `${value} · ${row.error_message || ''}` : '—' }
        ]} />
      </Card>
      <Card size="small" title="业务产物" style={{ marginTop: 12 }}>
        <Table size="small" rowKey={row => row.artifact_id || row.id} dataSource={active} pagination={{ pageSize: 8 }} columns={[
          { title: '产物', dataIndex: 'artifact_id' },
          { title: '类型', dataIndex: 'artifact_type', render: value => value || '—' },
          { title: 'schema', dataIndex: 'schema_version', render: value => value || '—' },
          { title: '记录数', dataIndex: 'record_count', render: displayCount },
          { title: 'hash', dataIndex: 'sha256', ellipsis: true },
          { title: '操作', key: 'actions', render: (_, item) => <Button type="link" icon={<EyeOutlined />} onClick={() => setPreview(item)}>预览</Button> }
        ]} locale={{ emptyText: <Empty description="暂无可用业务产物" /> }} />
      </Card>
    </>}
    {preview ? <ArtifactPreview runId={runId} item={preview} onClose={() => setPreview(null)} /> : null}
  </Drawer>
}

function ScriptRunDrawer({ script, canWrite, open, onClose, onCreated }) {
  const { message } = AntApp.useApp()
  const [form] = Form.useForm()
  const configDraft = Form.useWatch('config', form) || {}
  const advancedDraft = Form.useWatch('advanced', form)
  const [candidates, setCandidates] = useState({})
  const [loadingCandidates, setLoadingCandidates] = useState(false)
  const [redfoxDateRange, setRedfoxDateRange] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [requestBudget, setRequestBudget] = useState({ loading: false, error: null, limits: {}, usage: {}, date: '', timezone: '' })
  const [strategyEstimate, setStrategyEstimate] = useState({ loading: false, error: null, expectedRequests: null, total: null, itemCount: 0 })
  const isRedfoxScript = script?.script_key === 'redfox-gzh'
  const latestRedfoxDate = latestRedfoxAvailableDate()
  const previewConfig = useMemo(() => {
    let advanced = {}
    try { advanced = parseJson(advancedDraft, {}) } catch {}
    let result = { ...(script?.default_config || {}), ...configDraft, ...(advanced && typeof advanced === 'object' ? advanced : {}) }
    try { result = parseArrayConfigFromForm(result, script?.input_schema?.config || {}) } catch {}
    if (script?.script_key === 'redfox-gzh') {
      const range = normalizeDateRange(redfoxDateRange)
      if (range?.[0]?.format && range?.[1]?.format) {
        result.start_date = range[0].format('YYYY-MM-DD')
        result.end_date = range[1].format('YYYY-MM-DD')
      }
    }
    return result
  }, [script, configDraft, advancedDraft, redfoxDateRange])
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
    form.setFieldsValue({ config: formatArrayConfigForForm(defaultConfig, script.input_schema?.config || {}), advanced: '' })
    if (!requirements.length) { setCandidates({}); setLoadingCandidates(false); return }
    setLoadingCandidates(true)
    const query = new URLSearchParams({ requirements: JSON.stringify(requirements.map(({ artifact_type, schema_version }) => ({ artifact_type, schema_version }))), limit: '50' })
    api.get(`/api/collection/artifacts/candidates?${query}`).then(result => setCandidates(result.itemsByRequirement || {})).catch(() => setCandidates({})).finally(() => setLoadingCandidates(false))
  }, [open, script, form, requirements])
  useEffect(() => {
    if (!open || !script) return
    let active = true
    setRequestBudget(current => ({ ...current, loading: true, error: null }))
    api.get('/api/collection/debug-api-budget', { cache: false })
      .then(result => { if (active) setRequestBudget({ ...result, loading: false, error: null }) })
      .catch(error => { if (active) setRequestBudget(current => ({ ...current, loading: false, error: apiError(error) })) })
    return () => { active = false }
  }, [open, script?.id])
  useEffect(() => {
    const requestTypes = Array.isArray(configDraft.request_types) ? configDraft.request_types : []
    if (!open || script?.script_key !== 'wxrank-strategy' || !requestTypes.length) {
      setStrategyEstimate({ loading: false, error: null, expectedRequests: null, total: null, itemCount: 0 })
      return undefined
    }
    let active = true
    setStrategyEstimate({ loading: true, error: null, expectedRequests: null, total: null, itemCount: 0 })
    api.get('/api/strategies?page=1&pageSize=500', { cache: false })
      .then(result => {
        if (!active) return
        const items = (result.items || []).filter(item => requestTypes.includes(item.request_type))
        const complete = Number.isFinite(result.total) && result.items?.length >= result.total
        const known = items.every(item => Number.isFinite(item.expected_requests))
        setStrategyEstimate({ loading: false, error: null, expectedRequests: complete && known ? items.reduce((sum, item) => sum + item.expected_requests, 0) : null, total: result.total ?? null, itemCount: items.length })
      })
      .catch(error => { if (active) setStrategyEstimate({ loading: false, error: apiError(error), expectedRequests: null, total: null, itemCount: 0 }) })
    return () => { active = false }
  }, [open, script?.script_key, JSON.stringify(configDraft.request_types || [])])
  const submit = async values => {
    setSubmitting(true)
    try {
      const config = parseArrayConfigFromForm({ ...(values.config || {}), ...parseJson(values.advanced, {}) }, script.input_schema?.config || {})
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
      message.success(`验证 Run 已受理：${result.item?.id || '请到运行中心查看状态'}`)
      onCreated(result.item?.id)
      onClose()
    } catch (error) { message.error(error.code === 'INPUT_MISSING' ? error.message : apiError(error)) }
    finally { setSubmitting(false) }
  }
  if (!script) return null
  const hasExternalPlatform = /(wxrank|redfox|tophub)/iu.test(String(script.platform || ''))
  const persistenceEnabled = script.script_key === 'hotwords-update' && previewConfig.persist === true
  const budgetLabel = requestBudget.error
    ? `每日额度暂不可用：${requestBudget.error}`
    : requestBudget.loading
      ? '正在读取平台每日请求额度…'
      : `今日额度（${requestBudget.timezone || '时区未记录'} · ${requestBudget.date || '日期未记录'}）：WxRank ${displayCount(requestBudget.usage?.WxRank)} / ${displayCount(requestBudget.limits?.WxRank)} 次，RedFox ${displayCount(requestBudget.usage?.Redfox)} / ${displayCount(requestBudget.limits?.Redfox)} 次`
  const requestEstimateLabel = script.script_key === 'wxrank-strategy'
    ? strategyEstimate.loading ? '正在读取当前策略并计算预计请求数…'
      : strategyEstimate.expectedRequests === null ? `当前策略预计请求数未知${strategyEstimate.error ? `：${strategyEstimate.error}` : ''}`
        : `按当前已保存策略估算 ${strategyEstimate.expectedRequests} 次 WxRank 请求；单次验证硬上限为 4 次，执行前仍会由 Runner 校验。`
    : '当前脚本没有可安全计算的单次请求数；运行时仍受服务端每日平台额度约束。'
  return (
    <Drawer
      title={(canWrite ? '执行验证 · ' : '检查参数 · ') + (script.name || script.script_key)}
      width={620}
      open={open}
      onClose={onClose}
      destroyOnHidden
      footer={<Space><Button onClick={onClose}>取消</Button><Button type="primary" loading={submitting} disabled={!canWrite || script.enabled === false || submitting} onClick={() => form.submit()}>启动脚本验证</Button></Space>}
    >
      <Descriptions size="small" column={2} items={[
        { key: 'platform', label: '平台', children: script.platform },
        { key: 'description', label: '用途', span: 2, children: script.description || '未填写用途说明' },
        { key: 'version', label: '版本', children: script.version },
        { key: 'hash', label: '代码 hash', children: script.code_hash || '—' },
        { key: 'entrypoint', label: '入口', children: script.entrypoint },
        { key: 'timeout', label: '超时', children: script.timeout_seconds + 's' },
        { key: 'retry', label: '重试', children: script.retry_count },
        { key: 'mode', label: '执行方式', children: runModeTag(script.run_mode) },
        { key: 'publish', label: '发布模式', children: 'preview（不进入正式发布步骤）' }
      ]} />
      {!canWrite ? <Alert style={{ marginTop: 12 }} type="info" showIcon message="当前为只读状态" description="可以检查参数、校验规则和请求预算；本次编辑不会保存，也不会启动脚本。提交运行需本机令牌并通过服务健康检查。" /> : null}
      <Alert
        style={{ marginTop: 12 }}
        type="warning"
        showIcon
        message="验证会执行真实脚本"
        description={<Space direction="vertical" size={2}>
          <span>{hasExternalPlatform ? `平台标记为 ${script.platform}，会向对应外部接口发出真实请求。` : '当前脚本未标记 WxRank、RedFox 或 TopHub 等外部平台；未统一登记副作用，不能据此判断为无外部请求。'}</span>
          <span>{persistenceEnabled ? '当前 persist=true：脚本会执行持久化逻辑。' : '当前注册信息没有统一的业务写入/费用声明；preview 不代表脚本本身不会写数据，也不代表不会产生平台费用。'}</span>
        </Space>}
      />
      <Card size="small" title="请求预算" style={{ marginTop: 12 }}>
        <Typography.Paragraph style={{ marginBottom: 4 }}>{budgetLabel}</Typography.Paragraph>
        <Typography.Text type="secondary">{requestEstimateLabel}</Typography.Text>
      </Card>
      <Collapse style={{ marginTop: 12 }} items={[{ key: 'config', label: '检查本次参数（敏感字段已脱敏）', children: <Input.TextArea readOnly rows={8} value={JSON.stringify(redactParameters(previewConfig), null, 2)} /> }]} />
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
          .map(([name, schema]) => {
            const requiredFields = new Set(script.input_schema?.required || [])
            const required = schema.required === true || requiredFields.has(name)
            const rules = [
              ...(required && schema.type !== 'array' ? [{ required: true, message: `${schema.label || name}为必填项` }] : []),
              ...(schema.type === 'array' ? [{ validator: async (_rule, value) => { parseArrayConfigFromForm({ [name]: value }, { [name]: { ...schema, required } }) } }] : []),
              ...(name === 'request_types' ? [{ required: true, type: 'array', min: 1, max: 1, message: '单独验证请选择一个策略' }] : [])
            ]
            return <Form.Item
              key={name}
              name={['config', name]}
              label={schema.label || name}
              rules={rules.length ? rules : undefined}
              validateTrigger="onBlur"
              extra={[schema.description, schema.type === 'array' ? '请按 JSON 数组格式编辑；提交时会按数组类型传给脚本。' : ''].filter(Boolean).join(' · ') || undefined}
            >
              {configControl(name, schema, { maxCount: name === 'request_types' ? 1 : null })}
            </Form.Item>
          })}
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
      const result = await api.get(`/api/collection/scripts?page=${requestedPage}&pageSize=${SCRIPT_PAGE_SIZE}&includeUsage=true`)
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
    { title: '操作', key: 'actions', width: 280, render: (_, row) => <Space wrap>{row.run_mode === 'workflow_only' ? <Button type="link" size="small" onClick={() => { window.location.hash = 'collection-workflows'; message.info('该脚本依赖工作流上下文，请在工作流运行中验证。') }}>在工作流中验证</Button> : <Button type="link" size="small" disabled={row.enabled === false} onClick={() => setRunScript(row)}>{canWrite ? '执行验证' : '检查参数'}</Button>}<Button type="link" size="small" onClick={() => openDetail(row)}>详情</Button><Button type="link" size="small" disabled={!canWrite} onClick={() => setEditor({ open: true, item: row })}>编辑</Button>{row.usage?.is_used ? <Tooltip title="已被工作流引用，不能删除。"><Button type="link" size="small" disabled>已使用</Button></Tooltip> : <Popconfirm title="确认删除脚本？" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => remove(row)}><Button type="link" danger size="small" disabled={!canWrite} icon={<DeleteOutlined />}>删除</Button></Popconfirm>}</Space> }
  ]
  return <div><PageTitle title="脚本库" description="采集能力与验证中心；单脚本验证自动启动本机 Runner，默认只展示最终业务产物。" actions={<><Button icon={<ReloadOutlined />} onClick={() => load(page)}>刷新</Button><Button type="primary" icon={<PlusOutlined />} disabled={!canWrite} onClick={() => setEditor({ open: true, item: null })}>新增脚本</Button></>} />{state.error ? <CollectionError error={state.error} onRetry={() => load(page)} /> : <><Card size="small"><Table rowKey="id" loading={state.loading} dataSource={state.items} columns={columns} pagination={false} locale={{ emptyText: <Empty description="暂无脚本登记" /> }} /></Card>{state.total > SCRIPT_PAGE_SIZE ? <Pagination size="small" current={page} pageSize={SCRIPT_PAGE_SIZE} total={state.total} showSizeChanger={false} onChange={nextPage => load(nextPage)} style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }} /> : null}</>}<CollectorEditor open={editor.open} item={editor.item} canWrite={canWrite} onClose={() => setEditor({ open: false, item: null })} onSaved={async () => { setEditor({ open: false, item: null }); await load() }} /><ScriptRunDrawer script={runScript} canWrite={canWrite} open={Boolean(runScript)} onClose={() => setRunScript(null)} onCreated={setRunId} />{runId ? <ScriptRunResult runId={runId} onClose={() => setRunId(null)} /> : null}<Drawer title={`脚本详情 · ${detail?.name || ''}`} width={760} open={Boolean(detail)} onClose={() => setDetail(null)}>{detail ? <><Descriptions size="small" column={2} items={[{ key: 'name', label: '名称', children: detail.name }, { key: 'key', label: 'script_key', children: detail.script_key }, { key: 'platform', label: '平台', children: detail.platform }, { key: 'version', label: '版本', children: detail.version }, { key: 'entrypoint', label: '入口', children: detail.entrypoint }, { key: 'hash', label: '代码 hash', children: detail.code_hash || '—' }, { key: 'mode', label: '执行方式', children: runModeTag(detail.run_mode) }, { key: 'caps', label: '能力', children: (detail.capabilities || []).join('、') || '—' }]} /><Typography.Title level={5}>输入契约</Typography.Title><Input.TextArea value={JSON.stringify({ required_artifacts: detail.required_artifacts || [], input_schema: detail.input_schema || {} }, null, 2)} readOnly rows={8} /><Typography.Title level={5}>输出契约</Typography.Title><Input.TextArea value={JSON.stringify(detail.output_schema || {}, null, 2)} readOnly rows={6} /><Typography.Title level={5}>最近执行</Typography.Title><Table size="small" rowKey="id" dataSource={recentRuns} pagination={false} columns={[{ title: '状态', dataIndex: 'status', render: statusTag }, { title: '时间', dataIndex: 'created_at', render: value => value ? new Date(value).toLocaleString('zh-CN') : '—' }, { title: '输出数', dataIndex: 'summary', render: value => displayCount(value?.steps?.[detail.script_key]?.output_count) }, { title: '操作', key: 'action', render: (_, row) => <Button type="link" onClick={() => setRunId(row.id)}>查看详情</Button> }]} locale={{ emptyText: <Empty description="暂无单脚本运行" /> }} /></> : null}</Drawer></div>
}

function workflowStepScriptName(step, scripts) {
  const scriptId = Number(step?.script_id)
  const script = scripts.find(item => Number(item.id) === scriptId)
  return script?.name || script?.script_key || '未知脚本'
}
function WorkflowEditor({ canWrite, refreshKey }) {
  const { message } = AntApp.useApp()
  const [state, setState] = useState({ loading: true, error: null, items: [] })
  const [scripts, setScripts] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [workflowModal, setWorkflowModal] = useState({ open: false, item: null })
  const [stepModal, setStepModal] = useState({ open: false, item: null })
  const [stepRunModal, setStepRunModal] = useState(null)
  const [stepRunForm] = Form.useForm()
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
      const body = { ...values, config_override: configOverride, condition: parseJson(values.condition) }
      await api.mutate(stepModal.item ? `/api/collection/steps/${stepModal.item.id}` : `/api/collection/workflows/${detail.id}/steps`, { method: stepModal.item ? 'PATCH' : 'POST', body: stepModal.item ? { ...body, expected_updated_at: stepModal.item.updated_at } : body })
      message.success(stepModal.item ? '步骤配置已保存' : '步骤已添加'); setStepModal({ open: false, item: null }); stepForm.resetFields(); await loadDetail(detail.id)
    } catch (error) { message.error(apiError(error)) }
  }
  const patchStep = async (step, patch) => {
    try { await api.mutate(`/api/collection/steps/${step.id}`, { method: 'PATCH', body: { ...patch, expected_updated_at: step.updated_at } }); await loadDetail(detail.id) } catch (error) { message.error(apiError(error)) }
  }
  const deleteStep = async step => {
    try { await api.mutate(`/api/collection/steps/${step.id}`, { method: 'DELETE', body: { expected_updated_at: step.updated_at } }); message.success('步骤已删除'); await loadDetail(detail.id) } catch (error) { message.error(apiError(error)) }
  }
  const runStep = async (step, mode, values = {}) => {
    try {
      const path = mode === 'continue' ? `/api/collection/workflows/${detail.id}/continue-from/${step.id}` : `/api/collection/workflows/${detail.id}/steps/${step.id}/run`
      const result = await api.mutate(path, { method: 'POST', body: { parent_run_id: values.parent_run_id || undefined } })
      message.success(`步骤运行已创建：${result.run?.id || result.run_id || '请在运行中心查看'}`)
      setStepRunModal(null); stepRunForm.resetFields(); await loadDetail(detail.id)
    } catch (error) { message.error(apiError(error)) }
  }
  const moveStep = async (index, offset) => {
    const steps = [...(detail?.steps || [])].sort((a, b) => a.seq - b.seq)
    const target = index + offset
    if (target < 0 || target >= steps.length) return
    ;[steps[index], steps[target]] = [steps[target], steps[index]]
    try { await api.mutate(`/api/collection/workflows/${detail.id}/reorder`, { method: 'POST', body: { steps: steps.map((step, position) => ({ id: step.id, seq: (position + 1) * 10 })) } }); await loadDetail(detail.id) } catch (error) { message.error(apiError(error)) }
  }
  const openWorkflow = item => { setWorkflowModal({ open: true, item }); workflowForm.setFieldsValue({ name: item?.name || '', enabled: item?.enabled !== false, revision: item?.revision || 1, default_config: jsonText(item?.default_config), retention_config: jsonText(item?.retention_config) }) }
  const openStep = (item = null) => { stepForm.setFieldsValue({ step_key: item?.step_key || '', script_id: item?.script_id, seq: item?.seq ?? ((detail?.steps || []).length + 1) * 10, enabled: item?.enabled ?? true, continue_on_error: item?.continue_on_error ?? false, retry_count: item?.retry_count ?? 0, timeout_seconds: item?.timeout_seconds ?? null, request_types: undefined, config_override: jsonText(item?.config_override), condition: jsonText(item?.condition) }); setStepModal({ open: true, item }) }
  const workflowColumns = [{ title: '工作流', dataIndex: 'name', render: (value, row) => <Button type="link" className="table-link" onClick={() => setSelectedId(row.id)}>{value}</Button> }, { title: '修订', dataIndex: 'revision', width: 80 }, { title: '状态', dataIndex: 'enabled', width: 90, render: value => value ? <Tag color="success">启用</Tag> : <Tag>停用</Tag> }]
  const stepColumns = [{ title: '顺序', dataIndex: 'seq', width: 70 }, { title: '脚本名称', key: 'script_name', width: 260, ellipsis: true, render: (_, row) => workflowStepScriptName(row, scripts) }, { title: '状态', dataIndex: 'enabled', width: 90, render: value => value ? <Tag color="success">启用</Tag> : <Tag>停用</Tag> }, { title: '失败策略', dataIndex: 'continue_on_error', width: 110, render: value => value ? '继续' : '阻断' }, { title: '操作', key: 'actions', width: 350, render: (_, row, index) => <Space wrap><Button type="link" size="small" disabled={!canWrite || index === 0} icon={<UpOutlined />} onClick={() => moveStep(index, -1)} /><Button type="link" size="small" disabled={!canWrite || index === (detail?.steps?.length || 1) - 1} icon={<DownOutlined />} onClick={() => moveStep(index, 1)} /><Button type="link" size="small" disabled={!canWrite} onClick={() => openStep(row)}>配置</Button><Button type="link" size="small" disabled={!canWrite || !row.enabled} onClick={() => { setStepRunModal({ step: row, mode: 'single_step' }); stepRunForm.resetFields() }}>运行此步</Button><Button type="link" size="small" disabled={!canWrite || !row.enabled} onClick={() => { setStepRunModal({ step: row, mode: 'continue' }); stepRunForm.resetFields() }}>从此继续</Button><Button type="link" size="small" disabled={!canWrite} onClick={() => patchStep(row, { enabled: !row.enabled })}>{row.enabled ? '停用' : '启用'}</Button><Popconfirm title="确认删除步骤？" okText="删除" cancelText="取消" onConfirm={() => deleteStep(row)}><Button type="link" danger size="small" disabled={!canWrite}>删除</Button></Popconfirm></Space> }]
  return (
    <div>
      <PageTitle
        title="工作流"
        description="工作流步骤按执行顺序显示绑定的脚本名称；编辑只影响后续新运行。"
        actions={<><Button icon={<ReloadOutlined />} onClick={load}>刷新</Button><Button type="primary" icon={<PlusOutlined />} disabled={!canWrite} onClick={() => openWorkflow(null)}>新建工作流</Button></>}
      />
      {state.error ? <CollectionError error={state.error} onRetry={load} /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, .75fr) minmax(0, 2fr)', gap: 12 }}>
          <Card size="small" title="工作流列表" bodyStyle={{ padding: 0 }}>
            <Table
              rowKey="id"
              size="small"
              showHeader={false}
              loading={state.loading}
              dataSource={state.items}
              columns={workflowColumns}
              pagination={false}
              rowClassName={row => row.id === selectedId ? 'ant-table-row-selected' : ''}
              locale={{ emptyText: <Empty description="暂无工作流" /> }}
            />
          </Card>
          <Card
            size="small"
            title={detail ? detail.name : '选择工作流'}
            extra={detail ? <Space><Button size="small" disabled={!canWrite} onClick={() => openWorkflow(detail)}>编辑</Button><Popconfirm title="删除工作流将保留已有运行历史，且有运行记录时会被拒绝。" okText="删除" cancelText="取消" onConfirm={removeWorkflow}><Button size="small" danger disabled={!canWrite}>删除</Button></Popconfirm></Space> : null}
          >
            {detail ? <>
              <Descriptions size="small" column={3} items={[
                { key: 'status', label: '状态', children: detail.enabled ? '启用' : '停用' },
                { key: 'revision', label: '修订', children: detail.revision },
                { key: 'steps', label: '步骤数', children: detail.steps?.length || 0 }
              ]} />
              <Space style={{ margin: '12px 0' }}>
                <Button type="primary" size="small" icon={<PlusOutlined />} disabled={!canWrite} onClick={() => openStep()}>添加步骤</Button>
                <Typography.Text type="secondary">步骤列表按脚本名称展示</Typography.Text>
              </Space>
              <Table
                rowKey="id"
                size="small"
                dataSource={[...(detail.steps || [])].sort((a, b) => a.seq - b.seq)}
                columns={stepColumns}
                pagination={false}
                locale={{ emptyText: <Empty description="暂无步骤" /> }}
              />
            </> : <Empty description="请选择工作流" />}
          </Card>
        </div>
      )}
      <Modal title={workflowModal.item ? '编辑工作流' : '新建工作流'} open={workflowModal.open} onCancel={() => setWorkflowModal({ open: false, item: null })} onOk={() => workflowForm.submit()} okText="保存" cancelText="取消" okButtonProps={{ disabled: !canWrite }}>
        <Form form={workflowForm} layout="vertical" onFinish={saveWorkflow}>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Space.Compact block>
            <Form.Item name="revision" label="修订" style={{ width: '50%' }}><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="enabled" label="启用" valuePropName="checked" style={{ width: '50%' }}><Switch /></Form.Item>
          </Space.Compact>
          <Form.Item name="default_config" label="默认配置 JSON"><Input.TextArea rows={3} /></Form.Item>
          <Form.Item name="retention_config" label="保留配置 JSON"><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>
      <Modal title={stepModal.item ? '编辑工作流步骤' : '添加工作流步骤'} open={stepModal.open} onCancel={() => setStepModal({ open: false, item: null })} onOk={() => stepForm.submit()} okText={stepModal.item ? '保存' : '添加'} cancelText="取消" okButtonProps={{ disabled: !canWrite }}>
        <Form form={stepForm} layout="vertical" onFinish={saveStep}>
          <Space.Compact block>
            <Form.Item name="step_key" label="step_key" rules={[{ required: true }]} style={{ width: '50%' }}><Input disabled={Boolean(stepModal.item)} /></Form.Item>
            <Form.Item name="script_id" label="脚本名称" rules={[{ required: true }]} style={{ width: '50%' }}>
              <Select disabled={Boolean(stepModal.item)} options={scripts.map(script => ({ value: script.id, label: (script.name || script.script_key) + ' v' + script.version }))} />
            </Form.Item>
          </Space.Compact>
          {selectedStepScript?.script_key === 'wxrank-strategy' ? <Form.Item name="request_types" label="执行策略" rules={[{ required: true, type: 'array', min: 1, max: 4, message: '至少选择一个策略' }]} extra="工作流会按保存的策略执行，运行前校验总请求数最多 4 次"><Select mode="multiple" maxCount={4} options={[{ value: 'account', label: '账号策略' }, { value: 'wx_type', label: '类型策略' }, { value: 'month', label: '月份策略' }, { value: 'date', label: '日期策略' }]} /></Form.Item> : null}
          <Space.Compact block>
            <Form.Item name="seq" label="顺序" style={{ width: '33%' }}><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="retry_count" label="重试次数" style={{ width: '33%' }}><InputNumber min={0} max={selectedStepScript?.script_key === 'wxrank-strategy' ? 0 : 10} disabled={selectedStepScript?.script_key === 'wxrank-strategy'} /></Form.Item>
            <Form.Item name="timeout_seconds" label="超时秒数" style={{ width: '34%' }}><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
          </Space.Compact>
          <Space>
            <Form.Item name="enabled" valuePropName="checked"><Switch checkedChildren="启用" unCheckedChildren="停用" /></Form.Item>
            <Form.Item name="continue_on_error" valuePropName="checked"><Switch checkedChildren="失败继续" unCheckedChildren="失败阻断" /></Form.Item>
          </Space>
          <Form.Item name="condition" label="条件 JSON"><Input.TextArea rows={2} placeholder={'例如：{"all":[{"field":"config.enabled","eq":true}]}'}/></Form.Item>
          <Form.Item name="config_override" label="步骤配置 JSON"><Input.TextArea rows={2} placeholder="{}" /></Form.Item>
        </Form>
      </Modal>
      <Modal title={stepRunModal?.mode === 'continue' ? '从指定步骤继续' : '单步运行'} open={Boolean(stepRunModal)} onCancel={() => setStepRunModal(null)} onOk={() => stepRunForm.submit()} okText="创建运行" cancelText="取消" okButtonProps={{ disabled: !canWrite }}>
        <Form form={stepRunForm} layout="vertical" onFinish={values => runStep(stepRunModal.step, stepRunModal.mode, values)}>
          <Typography.Text>{stepRunModal?.mode === 'continue' ? '将从「' + workflowStepScriptName(stepRunModal?.step, scripts) + '」继续后续已启用步骤。' : '只运行「' + workflowStepScriptName(stepRunModal?.step, scripts) + '」这一步。'}</Typography.Text>
          <Form.Item name="parent_run_id" label="来源运行 ID" rules={stepRunModal?.mode === 'continue' ? [{ required: true, message: '从指定步骤继续需要来源运行 ID' }] : []} extra="系统会复用该运行已完成步骤的产物，不会重跑此前步骤"><Input /></Form.Item>
        </Form>
      </Modal>
    </div>
  )
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

function recordValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value === 'string') { try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {} } catch {} }
  return {}
}

function runStepSummaries(run) {
  const steps = recordValue(recordValue(run?.summary).steps)
  return Array.isArray(steps) ? steps : Object.values(steps)
}

function runCount(run, field) {
  const values = runStepSummaries(run).map(step => step?.[field] === null || step?.[field] === undefined || step?.[field] === '' ? null : Number(step[field])).filter(Number.isFinite)
  if (values.length) return values.reduce((total, value) => total + value, 0)
  const rawFallback = recordValue(run?.summary)?.[field]
  if (rawFallback === null || rawFallback === undefined || rawFallback === '') return null
  const fallback = Number(rawFallback)
  return Number.isFinite(fallback) ? fallback : null
}

function stepCount(steps, field) {
  const values = steps.map(step => step?.[field] === null || step?.[field] === undefined || step?.[field] === '' ? null : Number(step[field])).filter(Number.isFinite)
  return values.length ? values.reduce((total, value) => total + value, 0) : null
}

function runSummaryText(summary) {
  const entries = Object.entries(recordValue(summary)).filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value))
  return entries.map(([key, value]) => `${BUSINESS_SUMMARY_LABELS[key] || key}：${displayCount(value)}`).join(' · ') || '历史运行未保存摘要'
}

function runErrorMessage(run) {
  const summary = recordValue(run?.summary)
  if (summary.error_message || summary.message) return summary.error_message || summary.message
  const failedStep = runStepSummaries(run).find(step => step?.error_message || step?.message)
  return failedStep?.error_message || failedStep?.message || summary.error_code || '—'
}

function runDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN')
}

function runDisplayName(run, workflows, scripts, stepRuns = []) {
  if (run?.run_kind === 'single_script') {
    const script = scripts.find(item => String(item.id) === String(run.script_id))
      || stepRuns.map(item => recordValue(item.script_snapshot)).find(item => item.name || item.script_key)
    return script?.name || script?.script_key || `脚本 #${run.script_id ?? '未知'}`
  }
  const snapshot = recordValue(run?.workflow_snapshot)
  const workflow = workflows.find(item => String(item.id) === String(run?.workflow_id))
  return snapshot.name || workflow?.name || `工作流 #${run?.workflow_id ?? '未知'}`
}

const RunListTable = memo(function RunListTable({ items, loading, canWrite, busyRunId, workflows = [], scripts = [], onSelectRun, onMutateRun }) {
  const columns = useMemo(() => [
    { title: '脚本 / 工作流', key: 'name', width: 190, ellipsis: true, render: (_, row) => <Space direction="vertical" size={0}><Typography.Text strong>{runDisplayName(row, workflows, scripts)}</Typography.Text><Typography.Text type="secondary">{row.run_kind === 'single_script' ? '单脚本运行' : '工作流运行'}</Typography.Text></Space> },
    { title: '运行 ID', dataIndex: 'id', width: 205, ellipsis: true },
    { title: '状态', dataIndex: 'status', width: 105, render: (value, row) => statusTag(value, row) },
    { title: '开始 / 结束', key: 'time', width: 185, render: (_, row) => <Space direction="vertical" size={0}><span>{runDate(row.started_at)}</span><Typography.Text type="secondary">{runDate(row.finished_at)}</Typography.Text></Space> },
    { title: '输入 / 输出', key: 'counts', width: 105, render: (_, row) => `${displayCount(runCount(row, 'input_count'))} / ${displayCount(runCount(row, 'output_count'))}` },
    { title: '请求数', key: 'requests', width: 75, render: (_, row) => displayCount(runCount(row, 'request_count')) },
    { title: '错误原因', key: 'error', ellipsis: true, render: (_, row) => runErrorMessage(row) },
    { title: '操作', key: 'actions', width: 145, render: (_, row) => <Space>
      <Button type="link" size="small" onClick={event => { event.stopPropagation(); onSelectRun(row) }}>详情</Button>
      <Popconfirm title="按当前配置重跑？" description="复用原运行的参数、规则和策略快照；执行当前注册的脚本或工作流配置，可能再次请求外部接口或写业务数据。" okText="创建重跑" cancelText="返回" onConfirm={() => onMutateRun('rerun', row)}><Button type="link" size="small" loading={busyRunId === row.id} disabled={!canWrite || Boolean(busyRunId) || ['running', 'queued', 'pending', 'retrying'].includes(row.status)} onClick={event => event.stopPropagation()}>重跑</Button></Popconfirm>
    </Space> }
  ], [busyRunId, canWrite, onMutateRun, onSelectRun, scripts, workflows])
  const onRow = useCallback(row => ({ onClick: () => onSelectRun(row) }), [onSelectRun])
  return <Card size="small"><Table rowKey="id" loading={loading} dataSource={items} columns={columns} pagination={false} onRow={onRow} locale={{ emptyText: <Empty description="暂无运行" /> }} /></Card>
}, (previous, next) => {
  return previous.items === next.items
    && previous.loading === next.loading
    && previous.canWrite === next.canWrite
    && previous.busyRunId === next.busyRunId
    && previous.workflows === next.workflows
    && previous.scripts === next.scripts
    && previous.onSelectRun === next.onSelectRun
    && previous.onMutateRun === next.onMutateRun
})

const RunDetailsDrawer = memo(function RunDetailsDrawer({ run, workflows = [], scripts = [], onClose }) {
  const [state, setState] = useState({ loading: false, error: null, detail: null, steps: [], artifacts: [], artifactError: null })
  const [preview, setPreview] = useState(null)
  const [logStepId, setLogStepId] = useState(null)
  const load = useCallback(async ({ background = false } = {}) => {
    if (!run?.id) return
    if (!background) setState(current => ({ ...current, loading: true, error: null }))
    const [detailResult, stepResult, artifactResult] = await Promise.allSettled([
      api.get(`/api/collection/runs/${encodeURIComponent(run.id)}`),
      api.get(`/api/collection/runs/${encodeURIComponent(run.id)}/steps?page=1&pageSize=200`),
      api.get(`/api/collection/runs/${encodeURIComponent(run.id)}/artifacts`)
    ])
    const detail = detailResult.status === 'fulfilled' ? detailResult.value?.item || null : null
    setState(current => ({
      loading: false,
      error: detailResult.status === 'rejected' ? detailResult.reason : null,
      detail: detail || current.detail,
      steps: stepResult.status === 'fulfilled' && Array.isArray(stepResult.value?.items) ? stepResult.value.items : current.steps,
      artifacts: artifactResult.status === 'fulfilled' && Array.isArray(artifactResult.value?.items) ? artifactResult.value.items : current.artifacts,
      artifactError: artifactResult.status === 'rejected' ? artifactResult.reason : null
    }))
    return detail
  }, [run?.id])
  useEffect(() => {
    if (!run?.id) return undefined
    let stopped = false
    let timer = null
    let firstLoad = true
    setPreview(null)
    setLogStepId(null)
    setState({ loading: true, error: null, detail: null, steps: [], artifacts: [], artifactError: null })
    const poll = async () => {
      const detail = await load({ background: !firstLoad })
      firstLoad = false
      if (!stopped && (!detail || ACTIVE_COLLECTION_RUN_STATUSES.has(detail.status) || detail.status === 'waiting_auth')) timer = window.setTimeout(poll, 2500)
    }
    void poll()
    return () => {
      stopped = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [run?.id, load])
  const current = state.detail || run
  const detailSummary = recordValue(current?.summary)
  const inputCount = stepCount(state.steps, 'input_count')
  const outputCount = stepCount(state.steps, 'output_count')
  const requestCount = stepCount(state.steps, 'request_count')
  const errorText = state.steps.find(step => step.error_message)?.error_message || runErrorMessage(current)
  const activeStep = state.steps.find(step => ['running', 'retrying', 'waiting_auth'].includes(step.status))
  const failedStep = [...state.steps].reverse().find(step => step.error_code || step.error_message) || { error_code: current?.summary?.error_code, error_message: current?.summary?.error_message }
  const diagnosis = diagnoseStep(failedStep, current)
  const logStep = state.steps.find(step => String(step.id) === String(logStepId))
  const elapsedMs = activeStep?.started_at && !activeStep.finished_at
    ? Math.max(0, Date.now() - Date.parse(activeStep.started_at))
    : stepCount(state.steps, 'duration_ms')
  const workflowName = runDisplayName(current, workflows, scripts, state.steps)
  return <Drawer title={run ? `运行详情 · ${run.id}` : '运行详情'} width={920} open={Boolean(run)} onClose={onClose}>
    {!run ? null : state.loading ? <Spin /> : <>
      {state.error ? <CollectionError error={state.error} onRetry={load} /> : null}
      <Descriptions size="small" column={3} items={[
        { key: 'name', label: '脚本 / 工作流', children: workflowName },
        { key: 'type', label: '运行类型', children: current.run_kind === 'single_script' ? '单脚本运行' : '工作流运行' },
        { key: 'status', label: '状态', children: statusTag(current.status, current) },
        { key: 'started', label: '开始时间', children: runDate(current.started_at) },
        { key: 'finished', label: '结束时间', children: runDate(current.finished_at) },
        { key: 'current_step', label: '当前步骤', children: activeStep?.step_key || (ACTIVE_COLLECTION_RUN_STATUSES.has(current.status) ? '尚未记录' : '无执行中的步骤') },
        { key: 'duration', label: '已耗时', children: elapsedMs === null ? '—' : `${elapsedMs} ms` },
        { key: 'updated_at', label: '最近更新', children: runDate(current.updated_at) },
        { key: 'counts', label: '输入 / 输出 / 脚本记录请求', children: state.steps.length ? `${displayCount(inputCount)} / ${displayCount(outputCount)} / ${displayCount(requestCount)}` : `${displayCount(runCount(current, 'input_count'))} / ${displayCount(runCount(current, 'output_count'))} / ${displayCount(runCount(current, 'request_count'))}` },
        { key: 'error', label: '错误原因', children: errorText },
        { key: 'error_category', label: '错误分类', children: diagnosis?.category || '—' },
        { key: 'next', label: '建议检查', span: 3, children: diagnosis?.next || '—' },
        { key: 'publish', label: '发布状态', children: current.publish_status || '—' },
        { key: 'lease', label: '租约', children: current.lease_until || '—' },
        { key: 'summary', label: '执行摘要', span: 3, children: runSummaryText(detailSummary) }
      ]} />
      {ACTIVE_COLLECTION_RUN_STATUSES.has(current.status) || current.status === 'waiting_auth' ? <Alert style={{ marginTop: 8 }} type="info" showIcon message="运行仍由 Runner 执行" description="当前执行器未提供真实中断信号；页面不会把运行标记为已取消。" /> : null}
      <Typography.Title level={5} style={{ marginTop: 18 }}>步骤记录</Typography.Title>
      <Table size="small" rowKey={row => row.id || `${row.step_key}-${row.attempt}`} dataSource={state.steps} pagination={false} scroll={{ x: 800 }} columns={[
        { title: '步骤', dataIndex: 'step_key', render: (value, row) => value || recordValue(row.script_snapshot).name || `脚本 #${row.script_id ?? '未知'}` },
        { title: '尝试', dataIndex: 'attempt', render: displayCount },
        { title: '状态', dataIndex: 'status', render: (value, row) => statusTag(value, row) },
        { title: '开始 / 结束', key: 'times', render: (_, row) => `${runDate(row.started_at)} / ${runDate(row.finished_at)}` },
        { title: '输入 / 输出', key: 'counts', render: (_, row) => `${displayCount(row.input_count)} / ${displayCount(row.output_count)}` },
        { title: '脚本记录请求数', dataIndex: 'request_count', render: displayCount },
        { title: '错误', dataIndex: 'error_message', ellipsis: true, render: value => value || '—' },
        { title: '日志', key: 'log', render: (_, row) => row.log_ref ? <Button type="link" size="small" onClick={() => setLogStepId(row.id)}>查看日志</Button> : <Typography.Text type="secondary">无</Typography.Text> }
      ]} locale={{ emptyText: <Empty description="暂无步骤记录" /> }} />
      {logStep ? <StepLogPanel key={`${run.id}-${logStep.id}`} runId={run.id} step={logStep} /> : null}
      <Typography.Title level={5} style={{ marginTop: 18 }}>运行产物</Typography.Title>
      {state.artifactError ? <Alert type="warning" showIcon message={`产物列表暂不可用：${apiError(state.artifactError)}`} /> : <Table size="small" rowKey={row => row.artifact_id || row.id} dataSource={state.artifacts} pagination={false} columns={[
        { title: '产物', dataIndex: 'artifact_id', render: (value, row) => value || row.id || '—' },
        { title: '类型', dataIndex: 'artifact_type', render: value => value || '—' },
        { title: '来源步骤', dataIndex: 'step_key', render: value => value || '—' },
        { title: '记录数', dataIndex: 'record_count', render: displayCount },
        { title: '新增 / 更新 / 删除 / 总数', key: 'changes', render: (_, row) => row.change_counts ? `${displayCount(row.change_counts.created)} / ${displayCount(row.change_counts.updated)} / ${displayCount(row.change_counts.deleted)} / ${displayCount(row.change_counts.total)}` : '—' },
        { title: '操作', key: 'actions', render: (_, row) => <Button type="link" size="small" onClick={() => setPreview(row)}>预览</Button> }
      ]} locale={{ emptyText: <Empty description="无产物，或历史记录未保存产物清单" /> }} />}
    </>}
    {preview ? <ArtifactPreview runId={run.id} item={preview} onClose={() => setPreview(null)} /> : null}
  </Drawer>
})

const RunCenter = memo(function RunCenter({ canWrite, refreshKey, onSelectRun, onMetadata }) {
  const { message } = AntApp.useApp()
  const messageRef = useRef(message)
  messageRef.current = message
  const [state, setState] = useState({ loading: true, error: null, items: [] })
  const [workflows, setWorkflows] = useState([])
  const [scripts, setScripts] = useState([])
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createLoading, setCreateLoading] = useState(false)
  const [busyRunId, setBusyRunId] = useState(null)
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
    try {
      const [result, scriptResult] = await Promise.all([api.get(`/api/collection/workflows?page=1&pageSize=${PAGE_SIZE}`), api.get(`/api/collection/scripts?page=1&pageSize=${PAGE_SIZE}`)])
      setWorkflows(result.items || [])
      setScripts(scriptResult.items || [])
      onMetadata?.({ workflows: result.items || [], scripts: scriptResult.items || [] })
    }
    catch (error) { messageRef.current.error(apiError(error)) }
  }, [onMetadata])
  useEffect(() => { load(); loadWorkflows() }, [load, loadWorkflows, refreshKey])
  const selectRun = useCallback(run => { onSelectRun(run || null) }, [onSelectRun])
  const create = async values => {
    setCreateLoading(true)
    try {
      const result = await api.mutate('/api/collection/runs', { method: 'POST', body: { workflow_id: values.workflow_id, config: parseJson(values.config), rule_snapshot: parseJson(values.rule_snapshot), strategy_snapshot: parseJson(values.strategy_snapshot) } })
      message.success(`运行已受理：${result.item?.id || '请查看运行状态'}`)
      setCreateOpen(false)
      form.resetFields()
      await load()
    } catch (error) { message.error(apiError(error)) }
    finally { setCreateLoading(false) }
  }
  const mutateRun = useCallback(async (action, run) => {
    setBusyRunId(run.id)
    try {
      const response = await api.mutate(`/api/collection/runs/${run.id}/${action}`, { method: 'POST', body: {} })
      messageRef.current.success(`重跑 Run 已受理：${response.item?.id || '请到运行中心查看'}`)
      await load()
      await selectRun(null)
    } catch (error) { messageRef.current.error(apiError(error)) }
    finally { setBusyRunId(null) }
  }, [load, selectRun])
  return <div><PageTitle title="运行中心" description="创建工作流后，服务端会启动 Worker；状态和步骤由真实运行记录更新。" actions={<><Button icon={<ReloadOutlined />} onClick={() => { load(page); loadWorkflows() }}>刷新</Button><Button type="primary" icon={<PlusOutlined />} disabled={!canWrite || !workflows.length || createLoading} loading={createLoading} onClick={() => setCreateOpen(true)}>创建运行</Button></>} />{state.error ? <CollectionError error={state.error} onRetry={() => load(page)} /> : <><RunListTable items={state.items} loading={state.loading} canWrite={canWrite} busyRunId={busyRunId} workflows={workflows} scripts={scripts} onSelectRun={selectRun} onMutateRun={mutateRun} /><Space style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}><Button size="small" disabled={page <= 1 || state.loading} onClick={() => load(page - 1)}>上一页</Button><Typography.Text type="secondary">第 {page} 页</Typography.Text><Button size="small" disabled={!hasMore || state.loading} onClick={() => load(page + 1)}>下一页</Button></Space></>}<Modal title="创建运行" open={createOpen} confirmLoading={createLoading} onCancel={() => setCreateOpen(false)} onOk={() => form.submit()} okText="创建运行" cancelText="取消" okButtonProps={{ disabled: !canWrite || createLoading }}><Form form={form} layout="vertical" onFinish={create}><Form.Item name="workflow_id" label="工作流" rules={[{ required: true }]}><Select options={workflows.map(item => ({ value: item.id, label: `${item.name} · #${item.id}` }))} /></Form.Item><Form.Item name="config" label="本次配置覆盖 JSON"><Input.TextArea rows={3} placeholder="{}" /></Form.Item><Form.Item name="rule_snapshot" label="规则快照 JSON"><Input.TextArea rows={3} placeholder="{}" /></Form.Item><Form.Item name="strategy_snapshot" label="策略快照 JSON"><Input.TextArea rows={3} placeholder="{}" /></Form.Item></Form></Modal></div>
})

export const CollectionPage = memo(function CollectionPage({ canWrite, refreshKey }) {
  const [selectedRun, setSelectedRun] = useState(null)
  const [runMetadata, setRunMetadata] = useState({ workflows: [], scripts: [] })
  const selectedRunId = selectedRun?.id || null
  const staticItems = useMemo(() => [
    { key: 'scripts', label: '脚本库', children: <CollectorLibrary canWrite={canWrite} refreshKey={refreshKey} /> },
    { key: 'workflows', label: '工作流', children: <WorkflowEditor canWrite={canWrite} refreshKey={refreshKey} /> },
    { key: 'runs', label: '运行中心', children: <RunCenter canWrite={canWrite} refreshKey={refreshKey} onSelectRun={setSelectedRun} onMetadata={setRunMetadata} /> },
    { key: 'publish', label: '发布预览', children: <Card size="small"><Alert type="info" showIcon message="发布预览使用冻结 write-set 产物" description="只有 publish-results 步骤生成并校验 write-set 后，才允许进入预览与显式提交；当前页面不会绕过 Runner 直接写入正式业务表。" /></Card> }
  ], [canWrite, refreshKey])
  const artifactItem = useMemo(() => ({ key: 'artifacts', label: '临时数据', children: <ArtifactBrowser runId={selectedRunId} canWrite={canWrite} /> }), [canWrite, selectedRunId])
  const items = useMemo(() => [staticItems[0], staticItems[1], staticItems[2], artifactItem, staticItems[3]], [artifactItem, staticItems])
  return <div className="management-page"><PageTitle title="采集编排" description="脚本、工作流、运行、临时产物和发布边界统一管理。" /><Alert className="readonly-alert" type="info" showIcon message={canWrite ? '已具备本机写权限，变更会经过服务端校验。' : '当前为只读状态；浏览、日志和产物预览不需要令牌，写操作需要本机令牌。'} /><Tabs items={items} /><RunDetailsDrawer run={selectedRun} workflows={runMetadata.workflows} scripts={runMetadata.scripts} onClose={() => setSelectedRun(null)} /></div>
})
