import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import dayjs from 'dayjs'
import {
  Alert,
  App as AntApp,
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  Col,
  Collapse,
  ConfigProvider,
  DatePicker,
  Descriptions,
  Divider,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Input,
  InputNumber,
  Layout,
  List,
  Menu,
  Modal,
  Popconfirm,
  Radio,
  Result,
  Row,
  Select,
  Skeleton,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  CheckOutlined,
  DeleteOutlined,
  DeploymentUnitOutlined,
  DownOutlined,
  EditOutlined,
  EyeOutlined,
  FileTextOutlined,
  FilterOutlined,
  FireOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined
} from '@ant-design/icons'

import { createApiClient, createTokenStore } from './public/api-client.mjs'
import { normalizeMultipleValue, normalizeRuleEditorValues, serializeDateValue } from './public/form-serializers.mjs'
import { getBodyPopupContainer } from './public/popup-containers.mjs'
import { StrategyPage } from './strategy/strategy-app.jsx'
import { CollectionPage } from './collection/CollectionPage.jsx'
import {
  ACCOUNT_FIELD_LABELS,
  ARTICLE_FIELD_LABELS,
  DECISION_SOURCE_LABELS,
  DECISION_STATUS_META,
  FIELD_FORMATTERS,
  RULE_FIELD_LABELS,
  RULE_OPERATOR_LABELS,
  RULE_SCOPE_LABELS,
  decisionSourceLabel,
  displayFieldValue,
  formatDate,
  formatDateTime,
  formatMetric,
  parseListValue,
  ruleValue
} from './public/field-maps.mjs'

const { Header, Sider, Content } = Layout
const tokenStore = createTokenStore()
const api = createApiClient({ getToken: tokenStore.get, cacheDefault: true })

const NAV_ITEMS = Object.freeze([
  { key: 'accounts', label: '账号管理', icon: <TeamOutlined /> },
  { key: 'articles', label: '文章管理', icon: <FileTextOutlined /> },
  { key: 'rules', label: '过滤规则', icon: <FilterOutlined /> },
  { key: 'hotwords', label: '热词管理', icon: <FireOutlined /> },
  { key: 'strategies', label: '采集策略', icon: <SettingOutlined /> },
  { key: 'collection', label: '采集编排', icon: <DeploymentUnitOutlined /> }
])

const VIEW_META = Object.freeze(Object.fromEntries(NAV_ITEMS.map(item => [item.key, item])))
const ACCOUNT_STATUS_OPTIONS = Object.entries(DECISION_STATUS_META).map(([value, meta]) => ({ value, label: meta.label }))
const OPERATOR_OPTIONS = Object.entries(RULE_OPERATOR_LABELS).map(([value, label]) => ({ value, label }))
const PAGE_SIZE_OPTIONS = ['20', '50', '100']
const ACCOUNT_STORAGE_KEY = 'management-center:account-columns'
const ACCOUNT_OPTIONAL_COLUMNS = [
  ['account.wx_biz', 'wx_biz'],
  ['account.description', 'description'],
  ['account.decision_source', 'decision_source'],
  ['profile.burst_count', 'burst_count'],
  ['profile.burst_rate', 'burst_rate'],
  ['profile.ori_count', 'ori_count'],
  ['profile.tags', 'tags'],
  ['profile.manual_tags', 'manual_tags'],
  ['profile.collected_at', 'collected_at']
]
const ACCOUNT_FIXED_COLUMNS = ['publisher', 'verify', 'decision_status', 'type_region', 'pub_count', 'active_days', 'read_avg', 'read_median', 'read_max', 'burst_rate', 'last_pub_time', 'updated_at', 'actions']
const RULE_KEYWORD_GROUPS = Object.freeze([
  { key: 'account|name|contains', field: 'name', label: '公众号名称' },
  { key: 'account|verification|contains', field: 'verification', label: '认证信息' },
  { key: 'account|description|contains', field: 'description', label: '简介' }
])

function errorMessage(error) {
  if (error?.status === 409) return '数据已被其他操作修改，请刷新后重试'
  if (error?.status === 401) return '本机令牌无效，请重新配置'
  if (error?.status === 501 || error?.code === 'CAPABILITY_UNAVAILABLE') return '执行器未接入/凭据未就绪'
  if (error?.status === 503) return '服务未就绪，请检查本机 Supabase 连接'
  return error?.message || '请求失败'
}

function safeImage(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const url = new URL(value.trim())
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}

function cleanParams(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== ''))
}

function rowSnapshot(row) {
  return { decision_status: row.decision_status ?? null, decision_source: row.decision_source ?? null, filter_rule_id: row.filter_rule_id ?? null, updated_at: row.updated_at }
}

function AccountAvatar({ row, size = 'default' }) {
  const name = row?.wx_name || row?.name || '公'
  return <Avatar size={size} src={safeImage(row?.avatar || row?.profile_avatar)} icon={!safeImage(row?.avatar || row?.profile_avatar) ? <UserOutlined /> : undefined}>{name.slice(0, 1)}</Avatar>
}

function StatusTag({ value }) {
  const meta = DECISION_STATUS_META[String(value)] || { label: '未知', color: 'default' }
  return <Tag color={meta.color}>{meta.label}</Tag>
}

function PageHeader({ title, description, actions, eyebrow = 'WECHAT MEDIA OPINION', compact = false, className = '' }) {
  const headingClassName = ['page-heading', compact ? 'page-heading-compact' : '', className].filter(Boolean).join(' ')
  return <div className={headingClassName}>
    <div className="page-heading-copy">{compact ? <div className="page-heading-inline"><Typography.Text strong className="page-title-compact">{title}</Typography.Text>{description ? <Typography.Text type="secondary" className="page-description-compact">{description}</Typography.Text> : null}</div> : <><Typography.Text className="page-eyebrow">{eyebrow}</Typography.Text><Typography.Title level={2}>{title}</Typography.Title>{description ? <Typography.Paragraph type="secondary">{description}</Typography.Paragraph> : null}</>}</div>
    {actions ? <Space wrap>{actions}</Space> : null}
  </div>
}

function ReadonlyAlert({ canWrite, className = '' }) {
  const alertClassName = ['readonly-alert', className].filter(Boolean).join(' ')
  return canWrite ? null : <Alert className={alertClassName} type="info" showIcon message="当前为只读状态，写操作需要本机令牌并通过健康检查。" />
}

function ErrorState({ title = '加载失败', error, onRetry }) {
  return <Result status="error" title={title} subTitle={error || '请稍后重试'} extra={<Button type="primary" onClick={onRetry}>重新加载</Button>} />
}

function PaginationConfig({ result, onChange }) {
  return {
    current: result?.page || 1,
    pageSize: result?.pageSize || 20,
    total: result?.total ?? 0,
    showSizeChanger: { getPopupContainer: getBodyPopupContainer },
    pageSizeOptions: PAGE_SIZE_OPTIONS,
    showQuickJumper: true,
    showTotal: total => `共 ${total} 条`,
    onChange
  }
}

function MetricRange({ label, minName, maxName, decimal = false }) {
  return <Form.Item label={label} className="range-form-item">
    <Space.Compact block><Form.Item name={minName} noStyle><InputNumber min={0} step={decimal ? 0.01 : 1} placeholder="最小" style={{ width: '50%' }} /></Form.Item><Form.Item name={maxName} noStyle><InputNumber min={0} step={decimal ? 0.01 : 1} placeholder="最大" style={{ width: '50%' }} /></Form.Item></Space.Compact>
  </Form.Item>
}

function accountColumnPreference() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ACCOUNT_STORAGE_KEY) || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function AccountFilter({ form, filters, onSubmit, onReset, embedded = false }) {
  const [moreOpen, setMoreOpen] = useState(false)
  const range = filters.updatedStartDate && filters.updatedEndDate ? [dayjs(filters.updatedStartDate), dayjs(filters.updatedEndDate)] : undefined
  const initialValues = { ...filters, updatedRange: range }
  useEffect(() => { form.setFieldsValue(initialValues) }, [form, filters])
  const content = <Form form={form} layout="vertical" initialValues={initialValues} onFinish={values => {
    const { updatedRange, ...rest } = values
    onSubmit(cleanParams({ ...rest, updatedStartDate: updatedRange?.[0]?.format('YYYY-MM-DD'), updatedEndDate: updatedRange?.[1]?.format('YYYY-MM-DD') }))
  }}>
    <div className="account-filter-grid">
      <div className="account-filter-item account-filter-item-keyword"><Form.Item label="公众号名称 / wx_biz" name="keyword"><Input allowClear prefix={<SearchOutlined />} placeholder="模糊搜索，回车查询" /></Form.Item></div>
      <div className="account-filter-item"><Form.Item label="审核状态" name="status"><Select getPopupContainer={getBodyPopupContainer} allowClear options={ACCOUNT_STATUS_OPTIONS} placeholder="全部" /></Form.Item></div>
      <div className="account-filter-item"><Form.Item label="公众号分类" name="wxType"><Input allowClear placeholder="如：财经" /></Form.Item></div>
      <div className="account-filter-item"><Form.Item label="地区" name="region"><Input allowClear placeholder="如：北京" /></Form.Item></div>
      <div className="account-filter-item account-filter-item-metric"><Form.Item label="阅读指标" name="metricField"><Select getPopupContainer={getBodyPopupContainer} options={[{ value: 'account.read_median', label: '账号中位阅读' }, { value: 'account.read_max', label: '账号最高阅读' }, { value: 'profile.read_avg', label: '平均阅读' }, { value: 'profile.active_days', label: '活跃天数' }, { value: 'profile.burst_rate', label: '爆文率' }]} /></Form.Item></div>
      <div className="account-filter-item"><Form.Item label="指标条件" name="metricOp"><Select getPopupContainer={getBodyPopupContainer} allowClear options={[{ value: 'eq', label: '=' }, { value: 'gte', label: '≥' }, { value: 'lte', label: '≤' }, { value: 'range', label: '区间' }]} /></Form.Item></div>
      <div className="account-filter-item account-filter-item-number"><Form.Item label="指标值" name="metricValue"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></div>
      <div className="account-filter-item account-filter-item-number"><Form.Item label="上限" name="metricMax"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></div>
    </div>
    <div className="account-filter-actions">
      <Space size={8} wrap>
        <Button type="primary" htmlType="submit" icon={<SearchOutlined />}>查询</Button>
        <Button onClick={() => { form.resetFields(); onReset() }}>重置</Button>
        <Button type="link" onClick={() => setMoreOpen(value => !value)}>{moreOpen ? '收起更多筛选' : '更多筛选'} <DownOutlined rotate={moreOpen ? 180 : 0} /></Button>
      </Space>
    </div>
    {moreOpen ? <div className="filter-more-panel"><Row gutter={[12, 0]}>
      <Col xs={12} md={6}><Form.Item label="审核来源" name="decisionSource"><Select getPopupContainer={getBodyPopupContainer} allowClear options={Object.entries(DECISION_SOURCE_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item></Col>
      <Col xs={12} md={6}><Form.Item label="详情数据" name="profileExists"><Select getPopupContainer={getBodyPopupContainer} allowClear options={[{ value: 'yes', label: '有详情' }, { value: 'no', label: '无详情' }]} /></Form.Item></Col>
      <Col xs={12} md={6}><Form.Item label="认证信息" name="verified"><Select getPopupContainer={getBodyPopupContainer} allowClear options={[{ value: 'yes', label: '已认证' }, { value: 'no', label: '未认证' }]} /></Form.Item></Col>
      <Col xs={12} md={6}><Form.Item label="更新时间" name="updatedRange"><DatePicker.RangePicker getPopupContainer={getBodyPopupContainer} style={{ width: '100%' }} /></Form.Item></Col>
      <Col xs={12} md={6}><MetricRange label="发文数" minName="profilePubCountValue" maxName="profilePubCountMax" /></Col>
      <Col xs={12} md={6}><MetricRange label="活跃天数" minName="profileActiveDaysValue" maxName="profileActiveDaysMax" /></Col>
      <Col xs={12} md={6}><MetricRange label="爆文率" minName="profileBurstRateValue" maxName="profileBurstRateMax" decimal /></Col>
    </Row></div> : null}
  </Form>
  return embedded ? <div className="filter-card account-filter-embedded">{content}</div> : <Card size="small" className="filter-card">{content}</Card>
}

function AccountDetailDrawer({ open, accountId, canWrite, onClose, onDecision, onChanged }) {
  const [state, setState] = useState({ loading: false, error: null, item: null })
  const [savingTags, setSavingTags] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [form] = Form.useForm()
  const { message: appMessage } = AntApp.useApp()
  useEffect(() => {
    if (!open || !accountId) return
    let active = true
    setState({ loading: true, error: null, item: null })
    api.get(`/api/accounts/${encodeURIComponent(accountId)}`, { key: `account:${accountId}`, cache: false }).then(result => {
      if (!active) return
      setState({ loading: false, error: null, item: result.item })
      form.setFieldsValue({ manual_tags: parseListValue(result.item?.profile?.manual_tags) })
    }).catch(error => { if (active) setState({ loading: false, error: errorMessage(error), item: null }) })
    return () => { active = false }
  }, [open, accountId, reloadKey])

  const item = state.item
  const profile = item?.profile || {}
  const sections = item ? [
    { key: 'basic', label: '基础信息', children: <Descriptions size="small" column={2} colon={false} items={[
      { key: 'account_id', label: ACCOUNT_FIELD_LABELS.account_id, children: item.account_id },
      { key: 'wx_biz', label: ACCOUNT_FIELD_LABELS.wx_biz, children: item.wx_biz },
      { key: 'wx_user', label: ACCOUNT_FIELD_LABELS.wx_user, children: profile.wx_user || '—' },
      { key: 'verify', label: ACCOUNT_FIELD_LABELS.verify, children: item.verify || '—' },
      { key: 'wx_type', label: ACCOUNT_FIELD_LABELS.wx_type, children: profile.wx_type || '—' },
      { key: 'region', label: ACCOUNT_FIELD_LABELS.region, children: profile.region || '—' },
      { key: 'description', label: ACCOUNT_FIELD_LABELS.description, span: 2, children: item.description || '—' },
      { key: 'tags', label: ACCOUNT_FIELD_LABELS.tags, span: 2, children: <Space wrap>{parseListValue(profile.tags).map(tag => <Tag key={tag}>{tag}</Tag>) || '—'}</Space> }
    ]} /> },
    { key: 'activity', label: '活跃数据', children: <Descriptions size="small" column={2} colon={false} items={[
      { key: 'last_pub_time', label: ACCOUNT_FIELD_LABELS.last_pub_time, children: formatDateTime(profile.last_pub_time) },
      { key: 'pub_count', label: ACCOUNT_FIELD_LABELS.pub_count, children: formatMetric(profile.pub_count) },
      { key: 'active_days', label: ACCOUNT_FIELD_LABELS.active_days, children: formatMetric(profile.active_days) },
      { key: 'ori_count', label: ACCOUNT_FIELD_LABELS.ori_count, children: formatMetric(profile.ori_count) },
      { key: 'collected_at', label: ACCOUNT_FIELD_LABELS.collected_at, children: formatDateTime(profile.collected_at) }
    ]} /> },
    { key: 'metrics', label: '阅读与互动', children: <Descriptions size="small" column={2} colon={false} items={['read_avg', 'read_median', 'read_max', 'burst_count', 'burst_rate', 'like_avg', 'share_avg', 'comment_avg'].map(field => ({ key: field, label: ACCOUNT_FIELD_LABELS[field], children: displayFieldValue(field, profile[field] ?? item[field]) }))} /> },
    { key: 'system', label: '系统信息', children: <Descriptions size="small" column={2} colon={false} items={[
      { key: 'decision_status', label: ACCOUNT_FIELD_LABELS.decision_status, children: <StatusTag value={item.decision_status} /> },
      { key: 'decision_source', label: ACCOUNT_FIELD_LABELS.decision_source, children: decisionSourceLabel(item.decision_source) },
      { key: 'filter_rule_id', label: ACCOUNT_FIELD_LABELS.filter_rule_id, children: item.filter_rule_id || '—' },
      { key: 'updated_at', label: ACCOUNT_FIELD_LABELS.updated_at, children: formatDateTime(item.updated_at) }
    ]} /> }
  ] : []

  const saveTags = async values => {
    setSavingTags(true)
    try {
      await api.mutate(`/api/accounts/${encodeURIComponent(item.account_id)}/tags`, { method: 'PATCH', body: { manual_tags: values.manual_tags || [], expected_manual_tags: parseListValue(profile.manual_tags) } })
      appMessage.success('人工标签已保存')
      onChanged()
      const result = await api.get(`/api/accounts/${encodeURIComponent(item.account_id)}`, { key: `account:${item.account_id}`, cache: false })
      setState(current => ({ ...current, item: result.item }))
    } catch (error) {
      appMessage.error(errorMessage(error))
    } finally {
      setSavingTags(false)
    }
  }

  return <Drawer width={680} open={open} onClose={onClose} destroyOnHidden title={item ? <Space><AccountAvatar row={{ ...item, avatar: profile.avatar }} /><span>{item.wx_name || '账号详情'}</span></Space> : '账号详情'}>
    {state.loading ? <Skeleton active paragraph={{ rows: 12 }} /> : state.error ? <ErrorState title="账号详情加载失败" error={state.error} onRetry={() => setReloadKey(value => value + 1)} /> : item ? <>
      <Space className="detail-actions" wrap><Button size="small" type="primary" ghost disabled={!canWrite} icon={<CheckOutlined />} onClick={() => onDecision(item, 1)}>通过</Button><Button size="small" danger ghost disabled={!canWrite} onClick={() => onDecision(item, 2)}>过滤</Button><StatusTag value={item.decision_status} /></Space>
      <Tabs items={sections} />
      <Divider orientation="left" plain>人工标签</Divider>
      <Form form={form} layout="vertical" onFinish={saveTags} initialValues={{ manual_tags: parseListValue(profile.manual_tags) }}>
        <Form.Item label="人工标签" name="manual_tags"><Select getPopupContainer={getBodyPopupContainer} mode="tags" tokenSeparators={[',', '，']} placeholder="输入后回车添加" /></Form.Item>
        <Button type="primary" htmlType="submit" loading={savingTags} disabled={!canWrite}>保存人工标签</Button>
      </Form>
    </> : <Empty description="暂无详情" />}
  </Drawer>
}

function AccountsPage({ canWrite, refreshKey }) {
  const [form] = Form.useForm()
  const { message: appMessage } = AntApp.useApp()
  const [filters, setFilters] = useState({ metricField: 'account.read_median' })
  const [result, setResult] = useState({ items: [], total: 0, page: 1, pageSize: 20 })
  const [loadState, setLoadState] = useState({ loading: true, error: null })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [selectedRowKeys, setSelectedRowKeys] = useState([])
  const [detailId, setDetailId] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [columnsPreference, setColumnsPreference] = useState(accountColumnPreference)

  const query = useMemo(() => cleanParams({ ...filters, page, pageSize, search: filters.keyword, accountColumns: 'account_id,wx_biz,wx_name,verify,decision_status,decision_source,filter_rule_id,read_median,read_max,updated_at,description', profileColumns: 'account_id,avatar,wx_type,region,pub_count,active_days,read_avg,read_median,read_max,burst_count,burst_rate,last_pub_time,ori_count,tags,manual_tags,collected_at' }), [filters, page, pageSize])
  const loadAccounts = async () => {
    setLoadState({ loading: true, error: null })
    try {
      const resultValue = await api.get(`/api/accounts?${new URLSearchParams(query).toString()}`, { key: 'accounts:list', cache: false })
      setResult({ ...resultValue, items: resultValue.items || [] })
      setSelectedRowKeys([])
      setLoadState({ loading: false, error: null })
    } catch (error) {
      setLoadState({ loading: false, error: errorMessage(error) })
    }
  }
  useEffect(() => { loadAccounts() }, [query, refreshKey])

  const onFilterSubmit = values => { setFilters(values); setPage(1) }
  const updateDecision = async (row, status) => {
    setBusyId(row.account_id)
    try {
      await api.mutate(`/api/accounts/${encodeURIComponent(row.account_id)}/decision`, { method: 'PATCH', body: { decision_status: status, expected_decision: rowSnapshot(row), expected_decision_status: row.decision_status ?? null, expected_updated_at: row.updated_at } })
      appMessage.success(status === 1 ? '账号已通过' : '账号已过滤')
      setDetailId(null)
      await loadAccounts()
    } catch (error) {
      appMessage.error(errorMessage(error))
    } finally {
      setBusyId(null)
    }
  }
  const bulkDecision = async status => {
    const rows = result.items.filter(row => selectedRowKeys.includes(row.account_id))
    if (!rows.length) return
    try {
      const response = await api.mutate('/api/accounts/bulk-status', { method: 'POST', body: { ids: rows.map(row => row.account_id), decision_status: status, expected_decisions: Object.fromEntries(rows.map(row => [row.account_id, rowSnapshot(row)])) } })
      appMessage.success(`批量${status === 1 ? '通过' : '过滤'}完成：成功 ${response.count || 0} 个，失败 ${response.failed?.length || 0} 个`)
      await loadAccounts()
    } catch (error) {
      appMessage.error(errorMessage(error))
    }
  }
  const optionalOptions = ACCOUNT_OPTIONAL_COLUMNS.map(([value, field]) => ({ label: ACCOUNT_FIELD_LABELS[field] || field, value }))
  const columns = useMemo(() => {
    const field = (dataIndex, title, render, extra = {}) => ({ key: dataIndex, dataIndex, title, render, ...extra })
    const base = [
      { key: 'publisher', title: '公众号', fixed: 'left', width: 220, render: (_, row) => <Space><AccountAvatar row={row} /><div className="table-primary"><Button type="link" className="table-link" onClick={() => setDetailId(row.account_id)}>{row.wx_name || '未命名账号'}</Button><Typography.Text type="secondary" ellipsis>{row.wx_biz || '—'}</Typography.Text></div></Space> },
      field('verify', '认证信息', value => value ? <Tooltip getPopupContainer={getBodyPopupContainer} title={value}><Tag color="blue">已认证</Tag></Tooltip> : <Typography.Text type="secondary">—</Typography.Text>),
      field('decision_status', '审核状态', value => <StatusTag value={value} />),
      { key: 'type_region', title: '分类 / 地区', width: 130, render: (_, row) => `${row.profile_wx_type || row.wx_type || '—'} / ${row.profile_region || row.region || '—'}` },
      field('profile_pub_count', ACCOUNT_FIELD_LABELS.pub_count, value => formatMetric(value), { dataIndex: 'profile_pub_count', sorter: true, sortKey: 'profile.pub_count' }),
      field('profile_active_days', ACCOUNT_FIELD_LABELS.active_days, value => formatMetric(value), { dataIndex: 'profile_active_days', sorter: true, sortKey: 'profile.active_days' }),
      field('profile_read_avg', ACCOUNT_FIELD_LABELS.read_avg, value => formatMetric(value), { dataIndex: 'profile_read_avg', sorter: true, sortKey: 'profile.read_avg' }),
      field('read_median', ACCOUNT_FIELD_LABELS.read_median, value => formatMetric(value), { sorter: true, sortKey: 'account.read_median' }),
      field('read_max', ACCOUNT_FIELD_LABELS.read_max, value => formatMetric(value), { sorter: true, sortKey: 'account.read_max' }),
      field('profile_burst_rate', ACCOUNT_FIELD_LABELS.burst_rate, value => displayFieldValue('burst_rate', value), { dataIndex: 'profile_burst_rate', sorter: true, sortKey: 'profile.burst_rate' }),
      field('profile_last_pub_time', ACCOUNT_FIELD_LABELS.last_pub_time, value => formatDateTime(value), { dataIndex: 'profile_last_pub_time', sorter: true, sortKey: 'profile.last_pub_time' }),
      field('updated_at', ACCOUNT_FIELD_LABELS.updated_at, value => formatDateTime(value), { sorter: true, sortKey: 'updated_at' })
    ]
    const optional = columnsPreference.map(key => {
      const [, source, dataField] = key.match(/^(account|profile)\.(.+)$/u) || []
      if (!source) return null
      const dataIndex = source === 'account' ? dataField : `profile_${dataField}`
      return { key, dataIndex, title: ACCOUNT_FIELD_LABELS[dataField] || dataField, ellipsis: true, render: value => dataField === 'burst_rate' ? displayFieldValue(dataField, value) : ['tags', 'manual_tags'].includes(dataField) ? <Space wrap>{parseListValue(value).slice(0, 3).map(tag => <Tag key={tag}>{tag}</Tag>)}</Space> : ['updated_at', 'collected_at', 'last_pub_time'].includes(dataField) ? formatDateTime(value) : formatMetric(value) }
    }).filter(Boolean)
    return [...base.slice(0, 3), ...optional, ...base.slice(3), { key: 'actions', title: '操作', fixed: 'right', width: 160, render: (_, row) => <Space size={4}><Button type="link" size="small" icon={<EyeOutlined />} onClick={() => setDetailId(row.account_id)}>详情</Button><Popconfirm getPopupContainer={getBodyPopupContainer} title="确认将该账号标记为通过？" onConfirm={() => updateDecision(row, 1)} okText="确认" cancelText="取消"><Button type="link" size="small" disabled={!canWrite || busyId === row.account_id}>通过</Button></Popconfirm><Popconfirm getPopupContainer={getBodyPopupContainer} title="确认将该账号标记为过滤？" onConfirm={() => updateDecision(row, 2)} okText="确认" cancelText="取消"><Button type="link" danger size="small" disabled={!canWrite || busyId === row.account_id}>过滤</Button></Popconfirm></Space> }]
  }, [columnsPreference, canWrite, busyId, result.items])

  const selectedRows = result.items.filter(row => selectedRowKeys.includes(row.account_id))
  return <div className="management-page">
    <PageHeader compact className="account-page-heading" title="账号管理" description={`共 ${result.total || 0} 个公众号 · 筛选、排序和分页由服务端执行`} actions={<><Button icon={<ReloadOutlined />} onClick={loadAccounts}>刷新列表</Button><Dropdown getPopupContainer={getBodyPopupContainer} trigger={['click']} menu={{ items: optionalOptions.map(option => ({ key: option.value, label: <Checkbox checked={columnsPreference.includes(option.value)} onChange={event => { const next = event.target.checked ? [...new Set([...columnsPreference, option.value])] : columnsPreference.filter(value => value !== option.value); setColumnsPreference(next); localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(next)) }}>{option.label}</Checkbox> })) }}><Button>列设置 <DownOutlined /></Button></Dropdown></>} />
    <Card size="small" className="account-controls-card">
      <ReadonlyAlert canWrite={canWrite} className="account-readonly-alert" />
      <div className="account-status-tabs-row"><Radio.Group className="account-status-tabs" optionType="button" buttonStyle="solid" value={filters.status || ''} onChange={event => { setFilters(current => ({ ...current, status: event.target.value })); setPage(1) }} options={[{ value: '', label: '全部' }, ...ACCOUNT_STATUS_OPTIONS]} /></div>
      <AccountFilter embedded form={form} filters={filters} onSubmit={onFilterSubmit} onReset={() => { setFilters({ metricField: 'account.read_median' }); setPage(1) }} />
    </Card>
    {selectedRows.length ? <Alert className="batch-alert" type="info" showIcon message={<Space wrap><span>已选择 {selectedRows.length} 个账号</span><Popconfirm getPopupContainer={getBodyPopupContainer} title={`确认将 ${selectedRows.length} 个账号标记为通过？`} onConfirm={() => bulkDecision(1)} okText="确认" cancelText="取消"><Button size="small" type="primary" ghost disabled={!canWrite}>批量通过</Button></Popconfirm><Popconfirm getPopupContainer={getBodyPopupContainer} title={`确认将 ${selectedRows.length} 个账号标记为过滤？`} onConfirm={() => bulkDecision(2)} okText="确认" cancelText="取消"><Button size="small" danger ghost disabled={!canWrite}>批量过滤</Button></Popconfirm><Button size="small" onClick={() => setSelectedRowKeys([])}>取消选择</Button></Space>} /> : null}
    <Card className="table-card account-table-card" styles={{ body: { padding: 0 } }}>
      {loadState.error ? <ErrorState title="账号列表加载失败" error={loadState.error} onRetry={loadAccounts} /> : <Table rowKey="account_id" sticky size="middle" loading={loadState.loading} columns={columns} dataSource={result.items} rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }} scroll={{ x: 1500, y: 'calc(100vh - 360px)' }} pagination={PaginationConfig({ result, onChange: (nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize) } })} locale={{ emptyText: <Empty description="暂无符合条件的账号" /> }} onChange={(_, __, sorter) => { const item = Array.isArray(sorter) ? sorter[0] : sorter; if (item?.column?.sortKey) { setFilters(current => ({ ...current, sort: item.column.sortKey, sortDir: item.order === 'ascend' ? 'asc' : 'desc' })); setPage(1) } }} onRow={row => ({ onDoubleClick: () => setDetailId(row.account_id) })} />}
    </Card>
    <AccountDetailDrawer open={Boolean(detailId)} accountId={detailId} canWrite={canWrite} onClose={() => setDetailId(null)} onDecision={updateDecision} onChanged={loadAccounts} />
  </div>
}

function ArticleFilter({ form, filters, onSubmit, onReset }) {
  const range = filters.from && filters.to ? [dayjs(filters.from), dayjs(filters.to)] : undefined
  return <Card size="small" className="filter-card">
    <Form form={form} layout="vertical" initialValues={{ ...filters, publishedRange: range }} onFinish={values => {
      const { publishedRange, ...rest } = values
      onSubmit(cleanParams({ ...rest, from: publishedRange?.[0]?.format('YYYY-MM-DD'), to: publishedRange?.[1]?.format('YYYY-MM-DD') }))
    }}>
      <Row gutter={[12, 0]}>
        <Col xs={24} xl={7}><Form.Item label="文章标题" name="keyword"><Input allowClear prefix={<SearchOutlined />} placeholder="标题关键词" /></Form.Item></Col>
        <Col xs={12} md={5} xl={4}><Form.Item label="公众号账号 ID" name="accountId"><InputNumber min={1} style={{ width: '100%' }} placeholder="可选" /></Form.Item></Col>
        <Col xs={12} md={5} xl={4}><Form.Item label="原创状态" name="isOriginal"><Select getPopupContainer={getBodyPopupContainer} allowClear options={[{ value: 'true', label: '原创' }, { value: 'false', label: '非原创' }, { value: 'unknown', label: '未知' }]} placeholder="全部" /></Form.Item></Col>
        <Col xs={24} md={8} xl={5}><Form.Item label="发布时间（UTC）" name="publishedRange"><DatePicker.RangePicker getPopupContainer={getBodyPopupContainer} style={{ width: '100%' }} /></Form.Item></Col>
      </Row>
      <Row gutter={[12, 0]}>
        <Col xs={12} md={6} xl={4}><MetricRange label="阅读量" minName="readMin" maxName="readMax" /></Col>
        <Col xs={12} md={6} xl={4}><MetricRange label="点赞数" minName="likeMin" maxName="likeMax" /></Col>
        <Col xs={12} md={6} xl={4}><MetricRange label="分享数" minName="shareMin" maxName="shareMax" /></Col>
        <Col xs={12} md={6} xl={4}><MetricRange label="留言数" minName="commentMin" maxName="commentMax" /></Col>
      </Row>
      <Space><Button type="primary" htmlType="submit" icon={<SearchOutlined />}>查询</Button><Button onClick={() => { form.resetFields(); onReset() }}>重置</Button></Space>
    </Form>
  </Card>
}

function ArticleDetailDrawer({ open, articleId, onClose }) {
  const [state, setState] = useState({ loading: false, error: null, item: null })
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    if (!open || !articleId) return
    let active = true
    setState({ loading: true, error: null, item: null })
    api.get(`/api/articles/${encodeURIComponent(articleId)}`, { key: `article:${articleId}`, cache: false }).then(result => { if (active) setState({ loading: false, error: null, item: result.item }) }).catch(error => { if (active) setState({ loading: false, error: errorMessage(error), item: null }) })
    return () => { active = false }
  }, [open, articleId, reloadKey])
  const item = state.item
  return <Drawer width={680} open={open} onClose={onClose} destroyOnHidden title={item?.title || '文章详情'}>
    {state.loading ? <Skeleton active paragraph={{ rows: 10 }} /> : state.error ? <ErrorState title="文章详情加载失败" error={state.error} onRetry={() => setReloadKey(value => value + 1)} /> : item ? <>
      <Descriptions size="small" column={2} colon={false} items={[
        { key: 'title', label: ARTICLE_FIELD_LABELS.title, span: 2, children: item.title || '—' },
        { key: 'publisher', label: ARTICLE_FIELD_LABELS.publisher, children: item.publisher || '—' },
        { key: 'published_at', label: ARTICLE_FIELD_LABELS.published_at, children: formatDateTime(item.published_at) },
        { key: 'read_num', label: ARTICLE_FIELD_LABELS.read_num, children: displayFieldValue('read_num', item.read_num, item) },
        { key: 'like_num', label: ARTICLE_FIELD_LABELS.like_num, children: displayFieldValue('like_num', item.like_num) },
        { key: 'share_num', label: ARTICLE_FIELD_LABELS.share_num, children: displayFieldValue('share_num', item.share_num) },
        { key: 'comment_num', label: ARTICLE_FIELD_LABELS.comment_num, children: displayFieldValue('comment_num', item.comment_num) },
        { key: 'is_original', label: ARTICLE_FIELD_LABELS.is_original, children: item.is_original === null ? <Tag>未知</Tag> : <Tag color={item.is_original ? 'success' : 'default'}>{item.is_original ? '原创' : '非原创'}</Tag> },
        { key: 'source_code', label: ARTICLE_FIELD_LABELS.source_code, children: item.source_code || '—' }
      ]} />
      <Divider orientation="left" plain>文章链接</Divider>
      {safeImage(item.article_url) ? <Button type="link" href={safeImage(item.article_url)} target="_blank" rel="noreferrer" icon={<EyeOutlined />}>打开原文</Button> : <Typography.Text type="secondary">暂无可用链接</Typography.Text>}
      <Collapse className="technical-collapse" items={[{ key: 'advanced', label: '高级信息', children: <Descriptions size="small" column={1} colon={false} items={[
        { key: 'id', label: ARTICLE_FIELD_LABELS.id, children: item.id },
        { key: 'account_id', label: ARTICLE_FIELD_LABELS.account_id, children: item.account_id },
        { key: 'article_sn', label: ARTICLE_FIELD_LABELS.article_sn, children: item.article_sn || '—' },
        { key: 'updated_at', label: ARTICLE_FIELD_LABELS.updated_at, children: formatDateTime(item.updated_at) }
      ]} /> }]} />
    </> : <Empty description="暂无文章详情" />}
  </Drawer>
}

function ArticlesPage({ canWrite, refreshKey }) {
  const [form] = Form.useForm()
  const { message: appMessage } = AntApp.useApp()
  const [filters, setFilters] = useState({})
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [result, setResult] = useState({ items: [], total: 0, page: 1, pageSize: 20 })
  const [loadState, setLoadState] = useState({ loading: true, error: null })
  const [selectedRowKeys, setSelectedRowKeys] = useState([])
  const [detailId, setDetailId] = useState(null)

  const query = useMemo(() => cleanParams({ ...filters, page, pageSize }), [filters, page, pageSize])
  const loadArticles = async () => {
    setLoadState({ loading: true, error: null })
    try {
      const value = await api.get(`/api/articles?${new URLSearchParams(query).toString()}`, { key: 'articles:list', cache: false })
      setResult({ ...value, items: value.items || [] })
      setSelectedRowKeys([])
      setLoadState({ loading: false, error: null })
    } catch (error) {
      setLoadState({ loading: false, error: errorMessage(error) })
    }
  }
  useEffect(() => { loadArticles() }, [query, refreshKey])

  const deleteRows = async rows => {
    if (!rows.length) return
    try {
      const response = await api.mutate('/api/articles', { method: 'DELETE', body: { ids: rows.map(row => row.id), expected_updated_atById: Object.fromEntries(rows.map(row => [row.id, row.updated_at])) } })
      appMessage.success(response.failed?.length ? `已删除 ${response.count} 条，${response.failed.length} 条失败` : `已删除 ${response.count} 条`)
      await loadArticles()
    } catch (error) {
      appMessage.error(errorMessage(error))
    }
  }
  const selectedRows = result.items.filter(row => selectedRowKeys.includes(row.id))
  const columns = [
    { title: '文章标题', dataIndex: 'title', key: 'title', width: 360, fixed: 'left', render: (value, row) => <Tooltip getPopupContainer={getBodyPopupContainer} title={value}><Button type="link" className="table-link table-title-link" onClick={() => setDetailId(row.id)}>{value || '—'}</Button></Tooltip> },
    { title: '公众号', dataIndex: 'publisher', key: 'publisher', width: 180, render: value => <Space><Avatar size="small" icon={<UserOutlined />} />{value || '—'}</Space> },
    { title: '发布时间', dataIndex: 'published_at', key: 'published_at', width: 150, render: value => formatDateTime(value) },
    { title: '阅读量', dataIndex: 'read_num', key: 'read_num', width: 110, render: (value, row) => displayFieldValue('read_num', value, row) },
    { title: '点赞数', dataIndex: 'like_num', key: 'like_num', width: 100, render: value => displayFieldValue('like_num', value) },
    { title: '分享数', dataIndex: 'share_num', key: 'share_num', width: 100, render: value => displayFieldValue('share_num', value) },
    { title: '留言数', dataIndex: 'comment_num', key: 'comment_num', width: 100, render: value => displayFieldValue('comment_num', value) },
    { title: '原创', dataIndex: 'is_original', key: 'is_original', width: 90, render: value => value === null ? <Tag>未知</Tag> : <Tag color={value ? 'success' : 'default'}>{value ? '原创' : '非原创'}</Tag> },
    { title: '来源', dataIndex: 'source_code', key: 'source_code', width: 110, render: value => value ? <Tag>{value}</Tag> : <Typography.Text type="secondary">—</Typography.Text> },
    { title: '操作', key: 'actions', fixed: 'right', width: 150, render: (_, row) => <Space size={4}><Button type="link" size="small" onClick={() => setDetailId(row.id)}>详情</Button><Popconfirm getPopupContainer={getBodyPopupContainer} title="确认删除这篇文章？" description="删除后无法恢复，热词来源索引不会自动清理。" okText="确认删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => deleteRows([row])}><Button danger type="link" size="small" disabled={!canWrite}>删除</Button></Popconfirm></Space> }
  ]
  return <div className="management-page">
    <PageHeader title="文章管理" description={`服务端分页加载文章，共 ${result.total || 0} 篇；长标题会截断并可悬停查看。`} actions={<Button icon={<ReloadOutlined />} onClick={loadArticles}>刷新</Button>} />
    <ReadonlyAlert canWrite={canWrite} />
    <ArticleFilter form={form} filters={filters} onSubmit={values => { setFilters(values); setPage(1) }} onReset={() => { setFilters({}); setPage(1) }} />
    {selectedRows.length ? <Alert className="batch-alert" type="info" showIcon message={<Space wrap><span>已选择 {selectedRows.length} 篇文章</span><Popconfirm getPopupContainer={getBodyPopupContainer} title={`确认删除 ${selectedRows.length} 篇文章？`} description="删除后无法恢复，热词来源索引不会自动清理。" okText="确认删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => deleteRows(selectedRows)}><Button size="small" danger disabled={!canWrite}>批量删除</Button></Popconfirm><Button size="small" onClick={() => setSelectedRowKeys([])}>取消选择</Button></Space>} /> : null}
    <Card className="table-card" styles={{ body: { padding: 0 } }}>
      {loadState.error ? <ErrorState title="文章列表加载失败" error={loadState.error} onRetry={loadArticles} /> : <Table rowKey="id" sticky size="middle" loading={loadState.loading} columns={columns} dataSource={result.items} rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }} scroll={{ x: 1400, y: 'calc(100vh - 450px)' }} pagination={PaginationConfig({ result, onChange: (nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize) } })} locale={{ emptyText: <Empty description="暂无符合条件的文章" /> }} />}
    </Card>
    <ArticleDetailDrawer open={Boolean(detailId)} articleId={detailId} onClose={() => setDetailId(null)} />
  </div>
}

function RuleGroupDrawer({ open, group, canWrite, onClose, onSaved }) {
  const [form] = Form.useForm()
  const { message: appMessage, notification: appNotification } = AntApp.useApp()
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (open && group) form.setFieldsValue({ entries: (group.rows || []).map(row => ({ id: row.id, value: row.value_text ?? row.value_number, enabled: row.enabled !== false, remark: row.remark || '' })) })
  }, [open, group])
  const submit = async values => {
    setSaving(true)
    try {
      const response = await api.mutate('/api/rules/groups/save', { body: { groupKey: group.key, original_rows: group.rows || [], draft: { entries: (values.entries || []).map(entry => ({ ...entry, value: group.type === 'number' ? Number(entry.value) : String(entry.value ?? '').trim() })) } } })
      if (response.status === 'success') appMessage.success('规则分组已保存')
      else appNotification.warning({ message: '规则分组部分保存', description: '部分行未能更新，请重新加载后核对。' })
      onSaved()
    } catch (error) {
      appMessage.error(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }
  return <Drawer width={680} open={open} onClose={onClose} destroyOnHidden title={<Space><FilterOutlined />{group?.label || '规则分组'}</Space>} footer={<Space style={{ width: '100%', justifyContent: 'flex-end' }}><Button onClick={onClose}>取消</Button><Button type="primary" loading={saving} disabled={!canWrite} onClick={() => form.submit()}>保存分组</Button></Space>}>
    {group ? <>
      <Alert type="info" showIcon message="保存会基于当前原始行快照执行 CAS；不会修改规则表结构。" />
      <Typography.Paragraph type="secondary" className="drawer-subtitle">{RULE_SCOPE_LABELS[group.scope]} · {RULE_FIELD_LABELS[group.field_name] || group.label} · {RULE_OPERATOR_LABELS[group.operator] || group.operator}</Typography.Paragraph>
      <Form form={form} layout="vertical" onFinish={submit} initialValues={{ entries: (group.rows || []).map(row => ({ id: row.id, value: row.value_text ?? row.value_number, enabled: row.enabled !== false, remark: row.remark || '' })) }}>
        <Form.List name="entries">
          {(fields, { add, remove }) => <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {fields.map(field => <Card key={field.key} size="small" className="rule-entry-card">
              <Form.Item name={[field.name, 'id']} hidden><Input /></Form.Item>
              <Row gutter={12} align="middle">
                <Col flex="1"><Form.Item label={group.type === 'number' ? '阈值' : '规则值'} name={[field.name, 'value']} rules={[{ required: true, message: '请输入规则值' }]}>{group.type === 'number' ? <InputNumber style={{ width: '100%' }} min={0} /> : <Input />}</Form.Item></Col>
                <Col flex="0 0 86px"><Form.Item label="启用" name={[field.name, 'enabled']} valuePropName="checked"><Switch /></Form.Item></Col>
                <Col flex="0 0 40px"><Popconfirm getPopupContainer={getBodyPopupContainer} title="移除这条规则？" onConfirm={() => remove(field.name)} okText="移除" cancelText="取消"><Button danger type="text" icon={<DeleteOutlined />} /></Popconfirm></Col>
              </Row>
              <Form.Item label="备注" name={[field.name, 'remark']}><Input maxLength={255} /></Form.Item>
            </Card>)}
            <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add({ enabled: true, value: group.type === 'number' ? 0 : '', remark: '' })}>新增一行</Button>
          </Space>}
        </Form.List>
        <Button htmlType="submit" style={{ display: 'none' }} aria-hidden="true" />
      </Form>
    </> : <Empty description="暂无规则分组" />}
  </Drawer>
}

function RuleEditorDrawer({ open, item, groups, canWrite, onClose, onSaved }) {
  const [form] = Form.useForm()
  const { message: appMessage } = AntApp.useApp()
  const [saving, setSaving] = useState(false)
  const scope = Form.useWatch('scope', form)
  const fieldName = Form.useWatch('field_name', form)
  const operator = Form.useWatch('operator', form)
  const availableGroups = groups.filter(group => !scope || group.scope === scope)
  const fieldGroups = groups.filter(group => group.scope === scope && group.field_name === fieldName)
  const selectedGroup = fieldGroups.find(group => group.operator === operator) || fieldGroups[0]
  useEffect(() => {
    if (!open) return
    form.setFieldsValue(item ? { scope: item.scope, field_name: item.field_name, operator: item.operator, value: item.value_text ?? item.value_number, enabled: item.enabled !== false, remark: item.remark || '' } : { scope: 'article', field_name: 'title', operator: 'contains', value: '', enabled: true, remark: '' })
  }, [open, item])
  useEffect(() => {
    if (!open || !scope) return
    const current = form.getFieldsValue(['scope', 'field_name', 'operator', 'value'])
    const normalized = normalizeRuleEditorValues(current, groups)
    if (normalized.field_name !== current.field_name || normalized.operator !== current.operator) {
      form.setFieldsValue({ field_name: normalized.field_name, operator: normalized.operator, value: normalized.value })
    }
  }, [open, scope, fieldName, groups])
  const submit = async values => {
    setSaving(true)
    try {
      const payload = { scope: values.scope, field_name: values.field_name, operator: values.operator, value: selectedGroup?.type === 'number' ? Number(values.value) : String(values.value ?? '').trim(), enabled: values.enabled !== false, remark: values.remark || '' }
      if (item) {
        await api.mutate(`/api/rules/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: { ...payload, expected_updated_at: item.updated_at } })
        appMessage.success('规则已更新')
      } else {
        await api.mutate('/api/rules', { body: payload })
        appMessage.success('规则已创建')
      }
      onSaved()
    } catch (error) {
      appMessage.error(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }
  return <Drawer width={520} open={open} onClose={onClose} destroyOnHidden title={item ? '编辑规则' : '新增规则'} footer={<Space style={{ width: '100%', justifyContent: 'flex-end' }}><Button onClick={onClose}>取消</Button><Button type="primary" loading={saving} disabled={!canWrite} onClick={() => form.submit()}>保存规则</Button></Space>}>
    <Form form={form} layout="vertical" onFinish={submit}>
      <Form.Item label="规则对象" name="scope" rules={[{ required: true }]}><Select getPopupContainer={getBodyPopupContainer} options={Object.entries(RULE_SCOPE_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item>
      <Form.Item label="业务字段" name="field_name" rules={[{ required: true }]}><Select getPopupContainer={getBodyPopupContainer} options={[...new Map(availableGroups.map(group => [group.field_name, { value: group.field_name, label: RULE_FIELD_LABELS[group.field_name] || group.label }])).values()]} /></Form.Item>
      <Form.Item label="条件" name="operator" rules={[{ required: true }]}><Select getPopupContainer={getBodyPopupContainer} options={OPERATOR_OPTIONS.filter(option => fieldGroups.some(group => group.operator === option.value))} /></Form.Item>
      <Form.Item label={selectedGroup?.type === 'number' ? '数值' : '规则值'} name="value" rules={[{ required: true, message: '请输入规则值' }]}>{selectedGroup?.type === 'number' ? <InputNumber style={{ width: '100%' }} min={0} /> : <Input />}</Form.Item>
      <Form.Item label="是否启用" name="enabled" valuePropName="checked"><Switch /></Form.Item>
      <Form.Item label="备注" name="remark"><Input.TextArea rows={3} maxLength={255} /></Form.Item>
    </Form>
  </Drawer>
}

function KeywordFilterCard({ groups, canWrite, onSaved }) {
  const { message: appMessage } = AntApp.useApp()
  const [selectedFields, setSelectedFields] = useState([])
  const [drafts, setDrafts] = useState({})
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    const byKey = new Map(groups.map(group => [group.key, group]))
    setSelectedFields(RULE_KEYWORD_GROUPS.filter(definition => (byKey.get(definition.key)?.rows || []).length).map(definition => definition.key))
    setDrafts(Object.fromEntries(RULE_KEYWORD_GROUPS.map(definition => [definition.key, (byKey.get(definition.key)?.rows || []).map(row => String(ruleValue(row)))])))
  }, [groups])
  const save = async () => {
    setSaving(true)
    try {
      const byKey = new Map(groups.map(group => [group.key, group]))
      for (const definition of RULE_KEYWORD_GROUPS) {
        const group = byKey.get(definition.key) || { key: definition.key, rows: [] }
        const oldRows = group.rows || []
        const values = selectedFields.includes(definition.key) ? drafts[definition.key] || [] : []
        const entries = values.map(value => {
          const old = oldRows.find(row => String(ruleValue(row)) === String(value))
          return old ? { id: old.id, value, enabled: old.enabled !== false, remark: old.remark || '' } : { value, enabled: true, remark: '' }
        })
        await api.mutate('/api/rules/groups/save', { body: { groupKey: definition.key, original_rows: oldRows, draft: { entries } } })
      }
      appMessage.success('账号关键词过滤已保存')
      onSaved()
    } catch (error) {
      appMessage.error(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }
  return <Card title={<Space><FilterOutlined />账号关键词过滤</Space>} extra={<Button type="primary" size="small" loading={saving} disabled={!canWrite} onClick={save}>保存关键词</Button>} className="keyword-filter-card">
    <Typography.Paragraph type="secondary">页面统一管理账号名称、认证信息和简介中的关键词，保存时仍写回原有三类 filter_rules 分组。</Typography.Paragraph>
    <Checkbox.Group value={selectedFields} onChange={setSelectedFields} options={RULE_KEYWORD_GROUPS.map(definition => ({ label: definition.label, value: definition.key }))} />
    <Divider />
    <Row gutter={[16, 0]}>{RULE_KEYWORD_GROUPS.filter(definition => selectedFields.includes(definition.key)).map(definition => <Col xs={24} md={8} key={definition.key}><Typography.Text strong>{definition.label}</Typography.Text><Select getPopupContainer={getBodyPopupContainer} mode="tags" value={drafts[definition.key] || []} onChange={value => setDrafts(current => ({ ...current, [definition.key]: value }))} tokenSeparators={[',', '，']} style={{ width: '100%', marginTop: 8 }} placeholder="输入关键词后回车" /></Col>)}</Row>
  </Card>
}

function RulesPage({ canWrite, refreshKey }) {
  const [groups, setGroups] = useState([])
  const [loadState, setLoadState] = useState({ loading: true, error: null })
  const [groupEditor, setGroupEditor] = useState({ open: false, group: null })
  const [rowEditor, setRowEditor] = useState({ open: false, item: null })
  const [scopeFilter, setScopeFilter] = useState('')
  const [keywordFilter, setKeywordFilter] = useState('')
  const loadRules = async () => {
    setLoadState({ loading: true, error: null })
    try {
      const value = await api.get('/api/rules/groups', { key: 'rules:groups', cache: false })
      setGroups(value.groups || [])
      setLoadState({ loading: false, error: null })
    } catch (error) {
      setLoadState({ loading: false, error: errorMessage(error) })
    }
  }
  useEffect(() => { loadRules() }, [refreshKey])
  const allRuleRows = groups.flatMap(group => (group.rows || []).map(row => ({ ...row, groupKey: group.key, group })))
  const visibleRows = allRuleRows.filter(row => !RULE_KEYWORD_GROUPS.some(definition => definition.key === row.groupKey))
  const filteredRows = visibleRows.filter(row => (!scopeFilter || row.scope === scopeFilter) && (!keywordFilter || `${ruleValue(row)} ${row.remark || ''} ${row.group.label}`.toLowerCase().includes(keywordFilter.toLowerCase())))
  const enabledCount = allRuleRows.filter(row => row.enabled !== false).length
  const hitCount = allRuleRows.reduce((sum, row) => sum + Number(row.hit_count || 0), 0)
  const groupOptions = groups.filter(group => group.key && group.scope && group.field_name && group.operator)
  const refreshAfterSave = async () => { setGroupEditor({ open: false, group: null }); setRowEditor({ open: false, item: null }); await loadRules() }
  const columns = [
    { title: '规则名称', key: 'label', width: 180, render: (_, row) => row.group.label || RULE_FIELD_LABELS[row.field_name] || row.field_name },
    { title: '对象', dataIndex: 'scope', width: 90, render: value => RULE_SCOPE_LABELS[value] || value },
    { title: '字段', dataIndex: 'field_name', width: 120, render: value => RULE_FIELD_LABELS[value] || value },
    { title: '条件', dataIndex: 'operator', width: 120, render: value => RULE_OPERATOR_LABELS[value] || value },
    { title: '值', key: 'value', width: 220, render: (_, row) => <Typography.Text ellipsis={{ tooltip: String(ruleValue(row)) }}>{String(ruleValue(row))}</Typography.Text> },
    { title: '状态', dataIndex: 'enabled', width: 90, render: value => <Tag color={value === false ? 'default' : 'success'}>{value === false ? '已停用' : '已启用'}</Tag> },
    { title: '命中次数', dataIndex: 'hit_count', width: 110, render: value => formatMetric(value || 0) },
    { title: '操作', key: 'actions', width: 170, render: (_, row) => <Space><Button type="link" size="small" icon={<EditOutlined />} disabled={!canWrite} onClick={() => setRowEditor({ open: true, item: row })}>编辑</Button><Button type="link" size="small" disabled={!canWrite} onClick={() => setGroupEditor({ open: true, group: row.group })}>编辑分组</Button></Space> }
  ]
  return <div className="management-page">
    <PageHeader title="过滤规则" description="将数据库规则按业务对象、字段和条件展示；账号关键词在页面统一管理，底层仍兼容现有 filter_rules。" actions={<><Button icon={<ReloadOutlined />} onClick={loadRules}>刷新</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => setRowEditor({ open: true, item: null })} disabled={!canWrite}>新增规则</Button></>} />
    <ReadonlyAlert canWrite={canWrite} />
    {loadState.error ? <Card><ErrorState title="规则加载失败" error={loadState.error} onRetry={loadRules} /></Card> : loadState.loading ? <Card><Skeleton active paragraph={{ rows: 8 }} /></Card> : <>
      <Row gutter={12} className="summary-row"><Col xs={24} md={8}><Card size="small"><Statistic title="已启用规则" value={enabledCount} suffix={`/ ${allRuleRows.length}`} /></Card></Col><Col xs={24} md={8}><Card size="small"><Statistic title="已停用规则" value={Math.max(0, allRuleRows.length - enabledCount)} /></Card></Col><Col xs={24} md={8}><Card size="small"><Statistic title="累计命中" value={hitCount} /></Card></Col></Row>
      <KeywordFilterCard groups={groups} canWrite={canWrite} onSaved={loadRules} />
      <Card title="其他业务规则" className="table-card rules-table-card" extra={<Space><Input allowClear prefix={<SearchOutlined />} placeholder="搜索规则值 / 备注" value={keywordFilter} onChange={event => setKeywordFilter(event.target.value)} /><Select getPopupContainer={getBodyPopupContainer} allowClear placeholder="规则对象" value={scopeFilter || undefined} onChange={value => setScopeFilter(value || '')} options={Object.entries(RULE_SCOPE_LABELS).map(([value, label]) => ({ value, label }))} style={{ width: 120 }} /></Space>} styles={{ body: { padding: 0 } }}><Table rowKey={row => `${row.groupKey}-${row.id}`} size="middle" dataSource={filteredRows} columns={columns} pagination={{ pageSize: 20, showSizeChanger: { getPopupContainer: getBodyPopupContainer }, pageSizeOptions: PAGE_SIZE_OPTIONS, showTotal: total => `共 ${total} 条` }} locale={{ emptyText: <Empty description="暂无符合条件的规则" /> }} scroll={{ x: 1100 }} /></Card>
    </>}
    <RuleGroupDrawer open={groupEditor.open} group={groupEditor.group} canWrite={canWrite} onClose={() => setGroupEditor({ open: false, group: null })} onSaved={refreshAfterSave} />
    <RuleEditorDrawer open={rowEditor.open} item={rowEditor.item} groups={groupOptions} canWrite={canWrite} onClose={() => setRowEditor({ open: false, item: null })} onSaved={refreshAfterSave} />
  </div>
}

function HotwordEditorDrawer({ open, hotwordId, canWrite, onClose, onSaved }) {
  const [state, setState] = useState({ loading: false, error: null, item: null })
  const [form] = Form.useForm()
  const { message: appMessage } = AntApp.useApp()
  const [saving, setSaving] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    if (!open || !hotwordId) return
    let active = true
    setState({ loading: true, error: null, item: null })
    api.get(`/api/hotwords/${encodeURIComponent(hotwordId)}`, { key: `hotword:${hotwordId}`, cache: false }).then(result => { if (active) { setState({ loading: false, error: null, item: result.item }); form.setFieldsValue({ hotword: result.item.hotword, aliases: parseListValue(result.item.aliases), article_url: result.item.article_url || null }) } }).catch(error => { if (active) setState({ loading: false, error: errorMessage(error), item: null }) })
    return () => { active = false }
  }, [open, hotwordId, reloadKey])
  const save = async values => {
    setSaving(true)
    try {
      await api.mutate(`/api/hotwords/${encodeURIComponent(state.item.id)}`, { method: 'PATCH', body: { hotword: values.hotword.trim(), aliases: normalizeMultipleValue(values.aliases), article_url: values.article_url || null, expected_snapshot: state.item } })
      appMessage.success('热词配置已保存')
      onSaved()
    } catch (error) {
      appMessage.error(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }
  return <Drawer width={560} open={open} onClose={onClose} destroyOnHidden title="编辑热词" footer={<Space style={{ width: '100%', justifyContent: 'flex-end' }}><Button onClick={onClose}>取消</Button><Button type="primary" loading={saving} disabled={!canWrite || !state.item} onClick={() => form.submit()}>保存配置</Button></Space>}>
    {state.loading ? <Skeleton active paragraph={{ rows: 8 }} /> : state.error ? <ErrorState title="热词详情加载失败" error={state.error} onRetry={() => setReloadKey(value => value + 1)} /> : state.item ? <Form form={form} layout="vertical" onFinish={save} initialValues={{ hotword: state.item.hotword, aliases: parseListValue(state.item.aliases), article_url: state.item.article_url || null }}>
      <Form.Item label="标准热词" name="hotword" rules={[{ required: true, message: '请输入标准热词' }]}><Input maxLength={50} /></Form.Item>
      <Form.Item label="别名" name="aliases" extra="输入后回车添加，标准词不会重复写入别名"><Select getPopupContainer={getBodyPopupContainer} mode="tags" tokenSeparators={[',', '，']} /></Form.Item>
      <Form.Item label="代表文章链接" name="article_url" rules={[{ type: 'url', warningOnly: true, message: '请输入有效链接' }]}><Input placeholder="https://…" /></Form.Item>
      <Descriptions size="small" column={2} colon={false} items={[{ key: 'stat_date', label: '统计日期', children: state.item.stat_date }, { key: 'article_count', label: '文章数量', children: formatMetric(state.item.article_count) }, { key: 'source', label: '来源索引', children: `${parseListValue(state.item.article_keys).length} 篇（服务端维护）` }]} />
    </Form> : <Empty description="暂无热词详情" />}
  </Drawer>
}

function HotwordSourceDrawer({ open, hotwordId, onClose }) {
  const [state, setState] = useState({ loading: false, item: null, error: null })
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    if (!open || !hotwordId) return
    let active = true
    setState({ loading: true, item: null, error: null })
    api.get(`/api/hotwords/${encodeURIComponent(hotwordId)}`, { key: `hotword:${hotwordId}`, cache: false }).then(result => { if (active) setState({ loading: false, item: result.item, error: null }) }).catch(error => { if (active) setState({ loading: false, item: null, error: errorMessage(error) }) })
    return () => { active = false }
  }, [open, hotwordId, reloadKey])
  const item = state.item
  return <Drawer width={560} open={open} onClose={onClose} destroyOnHidden title={item ? `${item.hotword} · 来源文章` : '来源文章'}>
    {state.loading ? <Skeleton active paragraph={{ rows: 6 }} /> : state.error ? <ErrorState title="来源信息加载失败" error={state.error} onRetry={() => setReloadKey(value => value + 1)} /> : item ? <>
      <Alert type="info" showIcon message={`共 ${formatMetric(item.article_count)} 篇文章`} description="当前 API 仅返回热词的代表链接和服务端维护的来源索引；页面不直接暴露 article_keys 原始值。" />
      <List className="source-article-list" dataSource={[{ title: `代表文章（${item.stat_date || '未标注日期'}）`, publisher: '热词来源', date: item.stat_date, url: item.article_url }]} locale={{ emptyText: <Empty description="暂无来源文章" /> }} renderItem={row => <List.Item actions={safeImage(row.url) ? [<Button key="open" type="link" href={safeImage(row.url)} target="_blank" rel="noreferrer">打开</Button>] : []}><List.Item.Meta avatar={<Avatar icon={<FileTextOutlined />} />} title={row.title} description={`${row.publisher} · ${row.date || '—'}`} /></List.Item>} />
    </> : <Empty description="暂无来源文章" />}
  </Drawer>
}

function HotwordsPage({ canWrite, refreshKey }) {
  const [form] = Form.useForm()
  const { message: appMessage, notification: appNotification } = AntApp.useApp()
  const [filters, setFilters] = useState({})
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [result, setResult] = useState({ items: [], total: 0, page: 1, pageSize: 20 })
  const [loadState, setLoadState] = useState({ loading: true, error: null })
  const [selectedRowKeys, setSelectedRowKeys] = useState([])
  const [editorId, setEditorId] = useState(null)
  const [sourceId, setSourceId] = useState(null)
  const [mergeState, setMergeState] = useState({ open: false, loading: false, preview: null, targetId: null })
  const query = useMemo(() => cleanParams({ ...filters, page, pageSize }), [filters, page, pageSize])
  const loadHotwords = async () => {
    setLoadState({ loading: true, error: null })
    try {
      const value = await api.get(`/api/hotwords?${new URLSearchParams(query).toString()}`, { key: 'hotwords:list', cache: false })
      setResult({ ...value, items: value.items || [] })
      setSelectedRowKeys([])
      setLoadState({ loading: false, error: null })
    } catch (error) {
      setLoadState({ loading: false, error: errorMessage(error) })
    }
  }
  useEffect(() => { loadHotwords() }, [query, refreshKey])
  const deleteHotword = async row => {
    try {
      await api.mutate(`/api/hotwords/${encodeURIComponent(row.id)}`, { method: 'DELETE', body: { expected_snapshot: row } })
      appMessage.success('热词已删除')
      await loadHotwords()
    } catch (error) {
      appMessage.error(errorMessage(error))
    }
  }
  const selectedRows = result.items.filter(row => selectedRowKeys.includes(row.id))
  const prepareMerge = async () => {
    if (selectedRows.length < 2) return
    setMergeState({ open: true, loading: true, preview: null, targetId: selectedRows[0].id })
    try {
      const preview = await api.mutate('/api/hotwords/merge-preview', { method: 'POST', body: { ids: selectedRows.map(row => row.id), target_id: selectedRows[0].id } })
      setMergeState({ open: true, loading: false, preview, targetId: preview.targetId })
    } catch (error) {
      setMergeState({ open: false, loading: false, preview: null, targetId: null })
      appMessage.error(errorMessage(error))
    }
  }
  const confirmMerge = async () => {
    if (!mergeState.preview) return
    setMergeState(current => ({ ...current, loading: true }))
    try {
      const response = await api.mutate('/api/hotwords/merge', { method: 'POST', body: { ids: selectedRows.map(row => row.id), target_id: mergeState.targetId, expected_snapshots: mergeState.preview.snapshots } })
      if (response.status === 'success') appMessage.success('热词合并完成')
      else appNotification.warning({ message: '热词合并部分完成', description: '请重新加载并核对合并结果。' })
      setMergeState({ open: false, loading: false, preview: null, targetId: null })
      await loadHotwords()
    } catch (error) {
      setMergeState(current => ({ ...current, loading: false }))
      appMessage.error(errorMessage(error))
    }
  }
  const columns = [
    { title: '标准热词', dataIndex: 'hotword', key: 'hotword', width: 180, render: value => <Typography.Text strong>{value || '—'}</Typography.Text> },
    { title: '别名', dataIndex: 'aliases', key: 'aliases', width: 280, render: value => { const aliases = parseListValue(value); return <Space wrap>{aliases.slice(0, 4).map(alias => <Tag key={alias}>{alias}</Tag>)}{aliases.length > 4 ? <Tooltip getPopupContainer={getBodyPopupContainer} title={aliases.slice(4).join('、')}><Tag>+{aliases.length - 4}</Tag></Tooltip> : null}</Space> } },
    { title: '统计日期', dataIndex: 'stat_date', key: 'stat_date', width: 130, render: value => formatDate(value) },
    { title: '文章数量', dataIndex: 'article_count', key: 'article_count', width: 120, render: (value, row) => <Button type="link" onClick={() => setSourceId(row.id)}>{formatMetric(value)}</Button> },
    { title: '代表文章', dataIndex: 'article_url', key: 'article_url', width: 130, render: value => safeImage(value) ? <Button type="link" href={safeImage(value)} target="_blank" rel="noreferrer">打开原文</Button> : <Typography.Text type="secondary">—</Typography.Text> },
    { title: '操作', key: 'actions', fixed: 'right', width: 170, render: (_, row) => <Space><Button type="link" size="small" icon={<EditOutlined />} disabled={!canWrite} onClick={() => setEditorId(row.id)}>编辑</Button><Popconfirm getPopupContainer={getBodyPopupContainer} title="确认删除该热词？" description="删除后无法恢复，来源文章不会被自动删除。" okText="确认删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => deleteHotword(row)}><Button type="link" danger size="small" disabled={!canWrite}>删除</Button></Popconfirm></Space> }
  ]
  return <div className="management-page">
    <PageHeader title="热词管理" description="维护标准热词、别名和来源统计；合并流程会先预览目标词与别名，再执行服务端 CAS 操作。" actions={<><Button icon={<ReloadOutlined />} onClick={loadHotwords}>刷新</Button><Button type="primary" icon={<CheckOutlined />} disabled={!canWrite || selectedRows.length < 2} onClick={prepareMerge}>合并选中项{selectedRows.length >= 2 ? `（${selectedRows.length}）` : ''}</Button></>} />
    <ReadonlyAlert canWrite={canWrite} />
    <Card size="small" className="filter-card"><Form form={form} layout="inline" initialValues={filters} onFinish={values => { setFilters(cleanParams({ ...values, statDate: serializeDateValue(values.statDate) })); setPage(1) }}><Form.Item label="标准热词" name="keyword"><Input allowClear prefix={<SearchOutlined />} /></Form.Item><Form.Item label="统计日期" name="statDate"><DatePicker getPopupContainer={getBodyPopupContainer} /></Form.Item><Form.Item><Button type="primary" htmlType="submit">查询</Button></Form.Item><Form.Item><Button onClick={() => { form.resetFields(); setFilters({}); setPage(1) }}>重置</Button></Form.Item></Form></Card>
    {selectedRows.length ? <Alert className="batch-alert" type="info" showIcon message={`已选择 ${selectedRows.length} 个热词，选择至少 2 个后可合并。`} /> : null}
    <Card className="table-card" styles={{ body: { padding: 0 } }}>
      {loadState.error ? <ErrorState title="热词列表加载失败" error={loadState.error} onRetry={loadHotwords} /> : <Table rowKey="id" sticky size="middle" loading={loadState.loading} columns={columns} dataSource={result.items} rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }} scroll={{ x: 1050, y: 'calc(100vh - 390px)' }} pagination={PaginationConfig({ result, onChange: (nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize) } })} locale={{ emptyText: <Empty description="暂无符合条件的热词" /> }} />}
    </Card>
    <HotwordEditorDrawer open={Boolean(editorId)} hotwordId={editorId} canWrite={canWrite} onClose={() => setEditorId(null)} onSaved={async () => { setEditorId(null); await loadHotwords() }} />
    <HotwordSourceDrawer open={Boolean(sourceId)} hotwordId={sourceId} onClose={() => setSourceId(null)} />
    <Modal title="确认合并热词" open={mergeState.open} confirmLoading={mergeState.loading} okText="确认合并" cancelText="取消" onCancel={() => setMergeState({ open: false, loading: false, preview: null, targetId: null })} onOk={confirmMerge} okButtonProps={{ danger: true }}>
      {mergeState.loading && !mergeState.preview ? <Spin /> : mergeState.preview ? <Space direction="vertical" style={{ width: '100%' }}>
        <Typography.Paragraph>请选择合并后的标准词，其他选中项将转为别名并删除来源热词记录。</Typography.Paragraph>
        <Radio.Group value={mergeState.targetId} onChange={event => setMergeState(current => ({ ...current, targetId: event.target.value }))}><Space direction="vertical">{selectedRows.map(row => <Radio key={row.id} value={row.id}>{row.hotword} <Typography.Text type="secondary">· {formatMetric(row.article_count)} 篇文章</Typography.Text></Radio>)}</Space></Radio.Group>
        <Card size="small" title="合并后预览"><Descriptions size="small" column={1} colon={false} items={[{ key: 'hotword', label: '标准词', children: mergeState.preview.computed?.hotword }, { key: 'aliases', label: '别名', children: <Space wrap>{parseListValue(mergeState.preview.computed?.aliases).map(value => <Tag key={value}>{value}</Tag>)}</Space> }, { key: 'date', label: '统计日期', children: mergeState.preview.date || '—' }]} /></Card>
      </Space> : null}
    </Modal>
  </div>
}

function ManagementApp() {
  const [view, setView] = useState(() => new URL(window.location.href).searchParams.get('view') || 'accounts')
  const [token, setToken] = useState(tokenStore.get())
  const [persistentSession, setPersistentSession] = useState(false)
  const [health, setHealth] = useState({ loading: true, ready: false, label: '连接检查中' })
  const [refreshKey, setRefreshKey] = useState(0)
  const canWrite = health.ready && (Boolean(token.trim()) || persistentSession)

  const bootstrapSession = async () => {
    try {
      const response = await fetch('/api/session', { headers: { Accept: 'application/json' } })
      const result = await response.json().catch(() => ({}))
      setPersistentSession(response.ok && result.authMode === 'persistent_dev_token' && result.writable === true)
    } catch {
      setPersistentSession(false)
    }
  }

  const refreshHealth = async () => {
    setHealth({ loading: true, ready: false, label: '连接检查中' })
    try {
      const result = await api.get('/api/health', { key: 'health', cache: false })
      setHealth({ loading: false, ready: result.ready === true, label: result.ready === true ? '已连接' : '未就绪' })
    } catch {
      setHealth({ loading: false, ready: false, label: '连接失败' })
    }
  }
  const navigate = nextView => {
    if (!VIEW_META[nextView]) return
    const url = new URL(window.location.href)
    url.searchParams.set('view', nextView)
    window.history.pushState({ view: nextView }, '', url)
    setView(nextView)
  }
  const refreshAll = () => {
    api.clear()
    setRefreshKey(value => value + 1)
    bootstrapSession()
    refreshHealth()
  }
  useEffect(() => {
    const onPopState = () => setView(new URL(window.location.href).searchParams.get('view') || 'accounts')
    window.addEventListener('popstate', onPopState)
    bootstrapSession()
    refreshHealth()
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const page = view === 'accounts' ? <AccountsPage canWrite={canWrite} refreshKey={refreshKey} /> : view === 'articles' ? <ArticlesPage canWrite={canWrite} refreshKey={refreshKey} /> : view === 'rules' ? <RulesPage canWrite={canWrite} refreshKey={refreshKey} /> : view === 'hotwords' ? <HotwordsPage canWrite={canWrite} refreshKey={refreshKey} /> : view === 'strategies' ? <StrategyPage canWrite={canWrite} refreshKey={refreshKey} /> : view === 'collection' ? <CollectionPage canWrite={canWrite} refreshKey={refreshKey} /> : <AccountsPage canWrite={canWrite} refreshKey={refreshKey} />
  return <Layout className="management-layout">
    <Sider width={224} theme="dark" className="management-sider">
      <div className="management-brand"><span className="management-brand-mark">W</span><span>配置管理中心</span></div>
      <Menu mode="inline" theme="dark" selectedKeys={[view]} items={NAV_ITEMS} onClick={({ key }) => navigate(key)} />
      <div className="management-sider-note">仅本机回环服务<br /><Typography.Text>Supabase 密钥仅在服务端</Typography.Text></div>
    </Sider>
    <Layout>
      <Header className="management-header">
        <div><Typography.Text className="page-eyebrow">WECHAT MEDIA OPINION</Typography.Text><Typography.Title level={4}>{VIEW_META[view]?.label || '配置管理中心'}</Typography.Title></div>
    <Space size={12} wrap><Tag color={health.loading ? 'processing' : health.ready ? 'success' : 'error'} icon={<Badge status={health.ready ? 'success' : health.loading ? 'processing' : 'error'} />}>{health.label}</Tag>{persistentSession ? <Tag color="blue">本机持久令牌已启用</Tag> : null}<Input.Password value={token} onChange={event => { const value = event.target.value; setToken(value); tokenStore.set(value) }} placeholder={persistentSession ? '已自动启用本机令牌' : '本机令牌'} aria-label="本机令牌" autoComplete="off" className="management-token-input" /><Tooltip getPopupContainer={getBodyPopupContainer} title="刷新连接状态和当前页面"><Button icon={<ReloadOutlined />} onClick={refreshAll}>刷新</Button></Tooltip></Space>
      </Header>
      <Content className="management-content"><div key={view} className="management-content-inner">{page}</div></Content>
    </Layout>
  </Layout>
}

const theme = {
  token: {
    colorPrimary: '#316FEA',
    colorBgLayout: '#F5F7FA',
    colorBgContainer: '#FFFFFF',
    colorText: '#172033',
    colorTextSecondary: '#667085',
    colorBorder: '#E5EAF2',
    borderRadius: 8,
    borderRadiusLG: 10,
    controlHeight: 34,
    motionDurationMid: '0.18s'
  },
  components: {
    Layout: { headerBg: '#FFFFFF', siderBg: '#27456F', bodyBg: '#F5F7FA' },
    Table: { headerBg: '#F8FAFD', headerColor: '#475467', rowHoverBg: '#F7FAFF', cellPaddingBlock: 9 },
    Card: { headerBg: '#FFFFFF', paddingLG: 18 },
    Button: { borderRadius: 7 },
    Menu: { darkItemBg: '#27456F', darkItemSelectedBg: '#316FEA', darkItemHoverBg: 'rgba(255,255,255,.10)', itemBorderRadius: 7 },
    Input: { activeShadow: '0 0 0 2px rgba(49,111,234,.12)' },
    Select: { optionSelectedBg: '#EEF4FF' }
  }
}

const rootNode = typeof document !== 'undefined' ? document.getElementById('management-root') : null
if (rootNode) createRoot(rootNode).render(<ConfigProvider theme={theme}><AntApp><ManagementApp /></AntApp></ConfigProvider>)
