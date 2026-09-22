import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import dayjs from 'dayjs'
import {
  Alert,
  App as AntApp,
  Avatar,
  Button,
  Card,
  Col,
  ConfigProvider,
  DatePicker,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Layout,
  List,
  Menu,
  Popconfirm,
  Row,
  Select,
  Skeleton,
  Space,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import {
  AppstoreOutlined,
  CalendarOutlined,
  ClockCircleOutlined,
  FileTextOutlined,
  FireOutlined,
  FilterOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
  TeamOutlined
} from '@ant-design/icons'

import { createApiClient, createTokenStore } from '../public/api-client.mjs'
import { createRequestGeneration } from '../public/components/strategy/StrategyTargetSelector.mjs'
import { getStrategyTypeConfig, STRATEGY_TYPE_CONFIG, WX_TYPE_OPTIONS } from '../public/constants/strategyFields.ts'
import { getBodyPopupContainer } from '../public/popup-containers.mjs'
import {
  buildNextRequestPreviewModel,
  completedItemViewModel,
  filterActiveTargets,
  formatMetric
} from '../public/strategy-ui.mjs'
import { buildStrategyCardModel, strategyAccountIdBatches, strategyFormPayload, strategyTargetKey } from '../public/strategy-model.mjs'

const { Header, Sider, Content } = Layout
const tokenStore = createTokenStore()
const api = createApiClient({ getToken: tokenStore.get, cacheDefault: true })
const STRATEGY_ENDPOINTS = Object.freeze({ account: '/api/strategy-options/accounts', keyword: '/api/strategy-options/keywords' })
const NAV_ITEMS = Object.freeze([
  { key: 'accounts', label: '账号管理', icon: <TeamOutlined /> },
  { key: 'articles', label: '文章管理', icon: <FileTextOutlined /> },
  { key: 'rules', label: '过滤规则', icon: <FilterOutlined /> },
  { key: 'hotwords', label: '热词管理', icon: <FireOutlined /> },
  { key: 'strategies', label: '采集策略', icon: <SettingOutlined /> }
])
const TYPE_ICONS = Object.freeze({
  date: <ClockCircleOutlined />,
  month: <CalendarOutlined />,
  account: <TeamOutlined />,
  keyword: <FireOutlined />,
  wx_type: <AppstoreOutlined />
})

function errorMessage(error) {
  if (error?.status === 409) return '数据已被其他操作修改，请刷新后重试'
  if (error?.status === 501 || error?.code === 'CAPABILITY_UNAVAILABLE') return '采集执行器尚未接入，当前只能保存配置'
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

function avatarFor(target, size = 'default') {
  const name = String(target?.name || target?.wx_name || '公')
  return <Avatar size={size} src={safeImage(target?.avatar)}>{name.slice(0, 1)}</Avatar>
}

function accountOption(item) {
  return {
    value: String(item.id),
    label: item.name || '未命名公众号',
    id: item.id,
    key: item.key,
    name: item.name || '未命名公众号',
    avatar: item.avatar || null,
    averageReading: item.averageReading ?? null,
    target: {
      account_id: Number(item.id),
      wx_biz: item.key,
      wx_name: item.name,
      avatar: item.avatar || null,
      ...(item.averageReading === null || item.averageReading === undefined ? {} : { read_avg: Number(item.averageReading) })
    }
  }
}

function keywordOption(item) {
  const name = item.name || item.hotword || '未命名热词'
  return { value: name, label: name, name, target: name, articleCount: item.articleCount }
}

function typeOption(value) {
  return { value, label: value, name: value, target: value }
}

function optionValue(target, requestType) {
  return strategyTargetKey(requestType, target)
}

function formDraft(item = null) {
  return {
    id: item?.id ?? null,
    requestType: item?.request_type || 'account',
    sourceTargets: structuredClone(item?.source_targets || []),
    activeTargets: structuredClone(item?.active_targets || []),
    date: item?.date || '',
    month: item?.month || '',
    cursor: item?.cursor ?? 0,
    minRead: item?.min_read ?? null,
    maxRead: item?.max_read ?? null,
    cycleNo: item?.cycle_no ?? 1,
    completedItems: structuredClone(item?.completed_items || []),
    updatedAt: item?.updated_at || null
  }
}

function formInitialValues(draft) {
  return {
    requestType: draft.requestType,
    date: draft.date ? dayjs(draft.date) : null,
    month: draft.month ? dayjs(draft.month.length === 6 ? `${draft.month.slice(0, 4)}-${draft.month.slice(4)}` : draft.month) : null,
    minRead: draft.minRead,
    maxRead: draft.maxRead,
    cursor: draft.cursor
  }
}

function scheduleText(item) {
  if (item.date) return `采集日期 ${item.date}`
  if (item.month) {
    const value = String(item.month)
    return `采集月份 ${value.length === 6 ? `${value.slice(0, 4)}-${value.slice(4)}` : value}`
  }
  return '暂未设置下次请求对象'
}

function navigateManagementView(view) {
  const url = new URL(window.location.href)
  url.searchParams.set('view', view)
  window.history.pushState({ view }, '', url)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function AvatarTargets({ targets, hiddenCount, targetUnit }) {
  if (targetUnit !== '公众号') {
    return <Space wrap size={[6, 6]}>{targets.map(target => <Tag key={String(target.raw)}>{target.name}</Tag>)}{hiddenCount > 0 ? <Tag>+{hiddenCount}</Tag> : null}</Space>
  }
  return <Space direction="vertical" size={8} style={{ width: '100%' }}>
    <Avatar.Group>
      {targets.map(target => <Tooltip getPopupContainer={getBodyPopupContainer} key={String(target.raw?.account_id || target.name)} title={target.name}>{avatarFor(target)}</Tooltip>)}
      {hiddenCount > 0 ? <Tooltip getPopupContainer={getBodyPopupContainer} title={`还有 ${hiddenCount} 个公众号`}><Avatar>+{hiddenCount}</Avatar></Tooltip> : null}
    </Avatar.Group>
    <Space wrap size={[6, 4]}>
      {targets.map(target => <Tooltip getPopupContainer={getBodyPopupContainer} key={`name-${String(target.raw?.account_id || target.name)}`} title={target.name}><Typography.Text ellipsis style={{ maxWidth: 150 }}>{target.name}</Typography.Text></Tooltip>)}
      {hiddenCount > 0 ? <Typography.Text type="secondary">+{hiddenCount}</Typography.Text> : null}
    </Space>
  </Space>
}

function StrategyCard({ item, config, accountOptions, canWrite, onEdit, onDelete, deleting }) {
  const model = buildStrategyCardModel(item, config, accountOptions)
  const executeReason = item.capability?.reason || '采集执行器尚未接入，当前只能保存配置'
  return <Card
    className="strategy-antd-card"
    title={<Space size={10}><span className="strategy-card-icon">{TYPE_ICONS[item.request_type] || <SettingOutlined />}</span><Typography.Text strong>{model.typeLabel}</Typography.Text><Typography.Text type="secondary">#{item.id}</Typography.Text></Space>}
    extra={<Tag color={model.status.color}>{model.status.label}</Tag>}
    style={{ height: '100%' }}
  >
    <Space direction="vertical" size={0} style={{ width: '100%', height: '100%' }}>
      <Typography.Text type="secondary" className="strategy-section-label">下一次采集</Typography.Text>
      <Typography.Text className="strategy-schedule-text">{scheduleText(item)}</Typography.Text>
      {model.targetCount > 0 ? <AvatarTargets targets={model.visibleTargets} hiddenCount={model.hiddenTargetCount} targetUnit={model.targetUnit} /> : <Typography.Text type="secondary">{scheduleText(item)}</Typography.Text>}
      <Divider className="strategy-card-divider" />
      <Descriptions size="small" column={{ xs: 2, sm: 4 }} colon={false} className="strategy-descriptions">
        <Descriptions.Item label="阅读量"><Typography.Text strong>{model.readingRange}</Typography.Text></Descriptions.Item>
        <Descriptions.Item label="请求页数"><Typography.Text strong>{model.pagesLabel}</Typography.Text></Descriptions.Item>
        <Descriptions.Item label="预计请求"><Typography.Text strong>{model.expectedRequestsLabel}</Typography.Text></Descriptions.Item>
        <Descriptions.Item label="当前轮次"><Typography.Text strong>{model.cycleLabel}</Typography.Text></Descriptions.Item>
      </Descriptions>
      <Typography.Text type="secondary" className="strategy-updated">更新时间 {model.updatedAtLabel}</Typography.Text>
      {!canWrite ? <Typography.Text type="secondary" className="strategy-readonly-note">连接未就绪或未配置本机令牌，当前只读</Typography.Text> : null}
      <div className="strategy-card-actions"><Space size={8}>
        <Button onClick={() => onEdit(item.id)} disabled={!canWrite}>编辑配置</Button>
      <Tooltip getPopupContainer={getBodyPopupContainer} title={executeReason}><span><Button disabled>执行</Button></span></Tooltip>
      <Popconfirm
        getPopupContainer={getBodyPopupContainer}
          title="确认删除该采集策略？"
          description="删除后无法恢复。"
          okText="确认删除"
          cancelText="取消"
          okButtonProps={{ danger: true, loading: deleting }}
          onConfirm={() => onDelete(item)}
        >
          <Button danger disabled={!canWrite || deleting}>删除</Button>
        </Popconfirm>
      </Space></div>
    </Space>
  </Card>
}

function TargetSelector({ kind, field, label, hint, selected, sourceTargets, options, loading, onSearch, onChange }) {
  const isAccount = kind === 'account'
  const allowedKeys = new Set((sourceTargets || []).map(target => optionValue(target, kind === 'account' ? 'account' : kind)))
  const filteredOptions = field === 'activeTargets' && sourceTargets ? options.filter(option => allowedKeys.has(String(option.value))) : options
  const selectedOptions = selected.map(target => {
    const value = optionValue(target, kind === 'account' ? 'account' : kind)
    return options.find(option => String(option.value) === value) || (isAccount ? accountOption({ id: target.account_id, key: target.wx_biz, name: target.wx_name, avatar: target.avatar, averageReading: target.read_avg }) : typeOption(String(target)))
  })
  const mergedOptions = [...selectedOptions, ...filteredOptions].filter((option, index, all) => all.findIndex(item => String(item.value) === String(option.value)) === index)
  const optionMap = new Map(mergedOptions.map(option => [String(option.value), option]))
  return <Form.Item label={<Space size={6}><span>{label}</span><Typography.Text type="secondary">{hint}</Typography.Text></Space>}>
      <Select
        getPopupContainer={getBodyPopupContainer}
      mode="multiple"
      allowClear
      showSearch
      filterOption={false}
      loading={loading}
      placeholder={isAccount ? '搜索公众号名称' : '请选择'}
      maxTagCount="responsive"
      maxTagPlaceholder={omittedValues => <Tooltip getPopupContainer={getBodyPopupContainer} title={`还有 ${omittedValues.length} 个已选${isAccount ? '公众号' : '对象'}`}>+{omittedValues.length}</Tooltip>}
      value={selected.map(target => optionValue(target, kind === 'account' ? 'account' : kind))}
      options={mergedOptions}
      onSearch={onSearch}
      onChange={values => onChange(values.map(value => optionMap.get(String(value))?.target ?? value))}
      optionRender={option => isAccount ? <Space><Avatar size="small" src={safeImage(option.data.avatar)}>{String(option.data.label || '公').slice(0, 1)}</Avatar><span><strong>{option.data.label}</strong>{option.data.averageReading !== undefined ? <Typography.Text type="secondary"> · 平均阅读 {formatMetric(option.data.averageReading)}</Typography.Text> : null}</span></Space> : <Space>{TYPE_ICONS[kind] || <FireOutlined />}<span>{option.data.label}</span></Space>}
      tagRender={props => isAccount ? <Tag bordered={false} icon={avatarFor(optionMap.get(String(props.value)) || { name: props.label }, 'small')}>{props.label}</Tag> : <Tag bordered={false}>{props.label}</Tag>}
    />
  </Form.Item>
}

function StrategyForm({ item, isCreate, accountOptions, canWrite, onClose, onSaved }) {
  const [form] = Form.useForm()
  const { message: appMessage } = AntApp.useApp()
  const [draft, setDraft] = useState(() => formDraft(item))
  const [remoteOptions, setRemoteOptions] = useState({ account: [], keyword: [] })
  const [optionLoading, setOptionLoading] = useState({ account: false, keyword: false })
  const searchTimers = useRef(new Map())
  const searchGenerations = useRef(new Map())
  const [saving, setSaving] = useState(false)
  const config = getStrategyTypeConfig(draft.requestType)

  const loadOptions = async (kind, search, token) => {
    if (!STRATEGY_ENDPOINTS[kind]) return
    const generation = searchGenerations.current.get(kind)
    if (!generation || !generation.isCurrent(token)) return
    setOptionLoading(state => ({ ...state, [kind]: true }))
    try {
      const result = await api.get(`${STRATEGY_ENDPOINTS[kind]}?search=${encodeURIComponent(search)}&page=1&pageSize=50`, { key: `strategy-options:${kind}:${search}`, cache: true })
      if (!generation.isCurrent(token)) return
      const next = (result.items || []).map(kind === 'account' ? accountOption : keywordOption)
      setRemoteOptions(state => ({ ...state, [kind]: next }))
    } catch (error) {
      if (generation.isCurrent(token)) appMessage.error(errorMessage(error))
    } finally {
      if (generation.isCurrent(token)) setOptionLoading(state => ({ ...state, [kind]: false }))
    }
  }

  const scheduleSearch = (kind, value) => {
    const oldTimer = searchTimers.current.get(kind)
    if (oldTimer) window.clearTimeout(oldTimer)
    const generation = searchGenerations.current.get(kind) || createRequestGeneration()
    searchGenerations.current.set(kind, generation)
    const token = generation.next()
    const timer = window.setTimeout(() => loadOptions(kind, value, token), 250)
    searchTimers.current.set(kind, timer)
  }

  const selectorOptions = useMemo(() => {
    if (config.targetSelector === 'wxType') return WX_TYPE_OPTIONS.map(typeOption)
    return remoteOptions[config.targetSelector] || []
  }, [config.targetSelector, remoteOptions])

  const handleValuesChange = (_, values) => {
    setDraft(current => ({
      ...current,
      date: values.date?.format('YYYY-MM-DD') || '',
      month: values.month?.format('YYYY-MM') || '',
      minRead: values.minRead ?? null,
      maxRead: values.maxRead ?? null,
      cursor: values.cursor ?? 0
    }))
  }

  const updateSourceTargets = targets => {
    setDraft(current => ({ ...current, sourceTargets: targets, activeTargets: filterActiveTargets(current.requestType, targets, current.activeTargets) }))
  }

  const updateActiveTargets = targets => {
    setDraft(current => ({ ...current, activeTargets: filterActiveTargets(current.requestType, current.sourceTargets, targets) }))
  }

  const changeType = requestType => {
    setDraft(current => ({ ...current, requestType, sourceTargets: [], activeTargets: [], date: '', month: '' }))
    form.setFieldsValue({ requestType, sourceTargets: [], activeTargets: [], date: null, month: null })
  }

  const submit = async () => {
    if (!canWrite) {
      appMessage.warning('当前连接未就绪或未配置本机令牌')
      return
    }
    const minRead = draft.minRead === '' || draft.minRead === null ? null : Number(draft.minRead)
    const maxRead = draft.maxRead === '' || draft.maxRead === null ? null : Number(draft.maxRead)
    if (minRead !== null && maxRead !== null && minRead > maxRead) {
      appMessage.error('最低阅读量不能高于最高阅读量')
      return
    }
    setSaving(true)
    try {
      const url = isCreate ? '/api/strategies' : `/api/strategies/${encodeURIComponent(draft.id)}`
      await api.mutate(url, { method: isCreate ? 'POST' : 'PATCH', body: strategyFormPayload(draft, isCreate) })
      appMessage.success('策略已保存，未发起采集')
      onSaved()
    } catch (error) {
      appMessage.error(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const completed = (Array.isArray(draft.completedItems) ? draft.completedItems : []).map((value, index) => completedItemViewModel(value, index))
  return <Form
    key={`${isCreate ? 'create' : 'edit'}-${draft.id || 'new'}`}
    form={form}
    layout="vertical"
    initialValues={formInitialValues(draft)}
    onValuesChange={handleValuesChange}
    onFinish={submit}
    className="strategy-antd-form"
  >
    <Typography.Paragraph type="secondary" className="strategy-form-tip">只保存配置，不会立即发起采集。</Typography.Paragraph>
    <Form.Item label="采集方式" name="requestType">
      <Select getPopupContainer={getBodyPopupContainer} disabled={!isCreate} onChange={changeType} options={Object.entries(STRATEGY_TYPE_CONFIG).map(([value, itemConfig]) => ({ value, label: <Space>{TYPE_ICONS[value]}<span>{itemConfig.label}</span></Space> }))} />
    </Form.Item>
    {config.targetSelector ? <>
      <Divider orientation="left" plain>目标范围</Divider>
      <TargetSelector kind={config.targetSelector} field="sourceTargets" label={config.sourceLabel} hint="可搜索、全选或清空" selected={draft.sourceTargets} sourceTargets={null} options={selectorOptions} loading={optionLoading[config.targetSelector] || false} onSearch={value => scheduleSearch(config.targetSelector, value)} onChange={updateSourceTargets} />
      <TargetSelector kind={config.targetSelector} field="activeTargets" label={config.activeLabel} hint="仅能从目标范围中选择" selected={draft.activeTargets} sourceTargets={draft.sourceTargets} options={selectorOptions} loading={optionLoading[config.targetSelector] || false} onSearch={value => scheduleSearch(config.targetSelector, value)} onChange={updateActiveTargets} />
    </> : <Alert type="info" showIcon message="当前采集方式按时间条件请求，无需选择目标。" />}
    <Divider orientation="left" plain>请求条件</Divider>
    {config.dateField === 'date' ? <Form.Item label="采集日期" name="date"><DatePicker getPopupContainer={getBodyPopupContainer} style={{ width: '100%' }} /></Form.Item> : null}
    {config.dateField === 'month' ? <Form.Item label="采集月份" name="month"><DatePicker getPopupContainer={getBodyPopupContainer} picker="month" style={{ width: '100%' }} /></Form.Item> : null}
    <Row gutter={12}>
      <Col span={12}><Form.Item label="最低阅读量" name="minRead"><InputNumber min={0} precision={0} style={{ width: '100%' }} placeholder="不限" /></Form.Item></Col>
      <Col span={12}><Form.Item label="最高阅读量" name="maxRead"><InputNumber min={0} precision={0} style={{ width: '100%' }} placeholder="不限" /></Form.Item></Col>
    </Row>
    <Form.Item label="请求页数" name="cursor" extra="设为 0 表示暂不请求"><InputNumber min={0} max={32767} precision={0} style={{ width: '100%' }} /></Form.Item>
    <Divider orientation="left" plain>采集进度</Divider>
    <Descriptions size="small" column={2} colon={false}>
      <Descriptions.Item label="当前轮次"><Typography.Text strong>第 {draft.cycleNo} 轮</Typography.Text></Descriptions.Item>
      <Descriptions.Item label="本轮已完成"><Typography.Text strong>{completed.length} 个</Typography.Text></Descriptions.Item>
    </Descriptions>
    {completed.length ? <List size="small" bordered dataSource={completed} renderItem={row => <List.Item><Space direction="vertical" size={0}><Typography.Text strong>{row.order}. {row.name}</Typography.Text><Typography.Text type="secondary">{row.status}{row.articleCount === null ? '' : ` · 已获取文章 ${formatMetric(row.articleCount)} 篇`}</Typography.Text></Space></List.Item>} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本轮还没有完成对象" />}
    <Divider orientation="left" plain>下次请求预览</Divider>
    <Card size="small" className="strategy-preview-card">
      <Typography.Text type="secondary">{config.label}</Typography.Text>
      <Typography.Paragraph strong>{scheduleText({ date: draft.date, month: draft.month })}</Typography.Paragraph>
      {draft.activeTargets.length ? <Typography.Text>{draft.activeTargets.length} 个{config.targetUnit}</Typography.Text> : <Typography.Text type="secondary">暂未选择下次请求对象</Typography.Text>}
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>预计请求 {buildNextRequestPreviewModel({ requestType: draft.requestType, activeTargets: draft.activeTargets, cursor: draft.cursor }).expectedRequestsLabel}</Typography.Paragraph>
    </Card>
    <Button htmlType="submit" style={{ display: 'none' }} aria-hidden="true" />
  </Form>
}

function StrategyDrawer({ editor, canWrite, onClose, onSaved }) {
  const [accountOptions, setAccountOptions] = useState(editor.accountOptions || new Map())
  const [loading, setLoading] = useState(Boolean(editor.loading))
  useEffect(() => {
    setAccountOptions(editor.accountOptions || new Map())
    setLoading(Boolean(editor.loading))
  }, [editor])
  return <Drawer
    title={<Space>{editor.isCreate ? <PlusOutlined /> : <SettingOutlined />}<span>{editor.isCreate ? '新建采集策略' : editor.loading ? '编辑采集策略' : `编辑采集策略 #${editor.item?.id}`}</span></Space>}
    open={editor.open}
    onClose={onClose}
    width={600}
    destroyOnHidden
    maskClosable={false}
    footer={<Space style={{ width: '100%', justifyContent: 'flex-end' }}><Button onClick={onClose}>取消</Button><Button type="primary" onClick={() => document.querySelector('.strategy-antd-form button[type="submit"]')?.click()} disabled={!canWrite}>保存配置</Button></Space>}
    className="strategy-antd-drawer"
  >
    {loading ? <Skeleton active paragraph={{ rows: 10 }} /> : <StrategyForm item={editor.item} isCreate={editor.isCreate} accountOptions={accountOptions} canWrite={canWrite} onClose={onClose} onSaved={onSaved} />}
  </Drawer>
}

export function StrategyPage({ canWrite, refreshKey = 0 }) {
  const { message: appMessage } = AntApp.useApp()
  const [items, setItems] = useState([])
  const [accountOptions, setAccountOptions] = useState(new Map())
  const [listState, setListState] = useState({ loading: true, error: null })
  const [editor, setEditor] = useState({ open: false, isCreate: false, item: null, accountOptions: new Map(), loading: false })
  const [deletingId, setDeletingId] = useState(null)

  const loadAccountsByIds = async ids => {
    const batches = strategyAccountIdBatches(ids)
    if (!batches.length) return new Map()
    const results = await Promise.all(batches.map(batch => api.get(`${STRATEGY_ENDPOINTS.account}?ids=${batch.join(',')}&page=1&pageSize=100`, { key: `strategy-options:accounts:ids:${batch.join(',')}`, cache: true })))
    return new Map(results.flatMap(result => result.items || []).map(item => [String(item.id), item]))
  }

  const loadStrategies = async () => {
    setListState({ loading: true, error: null })
    try {
      const result = await api.get('/api/strategies?page=1&pageSize=100', { key: 'strategies:list', cache: false })
      const ids = (result.items || []).flatMap(item => getStrategyTypeConfig(item.request_type).targetSelector === 'account' ? (item.active_targets || []).slice(0, 3).map(target => target.account_id) : [])
      setAccountOptions(await loadAccountsByIds(ids))
      setItems(result.items || [])
      setListState({ loading: false, error: null })
    } catch (error) {
      setListState({ loading: false, error: errorMessage(error) })
    }
  }

  const openCreate = () => setEditor({ open: true, isCreate: true, item: null, accountOptions: new Map(), loading: false })

  const openEdit = async id => {
    setEditor({ open: true, isCreate: false, item: null, accountOptions: new Map(), loading: true })
    try {
      const item = (await api.get(`/api/strategies/${encodeURIComponent(id)}`, { key: `strategy:${id}`, cache: false })).item
      const ids = [...(item.source_targets || []), ...(item.active_targets || [])].map(target => target.account_id).filter(Boolean)
      const options = getStrategyTypeConfig(item.request_type).targetSelector === 'account' ? await loadAccountsByIds(ids) : new Map()
      setEditor({ open: true, isCreate: false, item, accountOptions: options, loading: false })
    } catch (error) {
      setEditor({ open: false, isCreate: false, item: null, accountOptions: new Map(), loading: false })
      appMessage.error(errorMessage(error))
    }
  }

  const deleteStrategy = async item => {
    setDeletingId(item.id)
    try {
      await api.mutate(`/api/strategies/${encodeURIComponent(item.id)}`, { method: 'DELETE', body: { expected_updated_at: item.updated_at } })
      appMessage.success('策略已删除')
      await loadStrategies()
    } catch (error) {
      appMessage.error(errorMessage(error))
    } finally {
      setDeletingId(null)
    }
  }

  useEffect(() => {
    loadStrategies()
  }, [refreshKey])

  return <div className="management-page strategy-page">
    <div className="strategy-react-page-heading">
      <div><Typography.Title level={2}>采集策略</Typography.Title><Typography.Paragraph type="secondary">用户定义业务条件配置下一次采集范围；保存只更新配置，不会立即发起采集。</Typography.Paragraph></div>
      <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={!canWrite}>新建策略</Button>
    </div>
    {!canWrite ? <Alert className="strategy-react-readonly" type="info" showIcon message="当前为只读或连接未就绪。写操作需要先配置本机令牌，并通过真实 health 检查。" /> : null}
    {listState.loading ? <Row gutter={[16, 16]}>{[1, 2].map(key => <Col xs={24} xl={12} key={key}><Card><Skeleton active paragraph={{ rows: 7 }} /></Card></Col>)}</Row> : null}
    {!listState.loading && listState.error ? <Alert type="error" showIcon message="策略加载失败" description={listState.error} action={<Button size="small" onClick={loadStrategies}>重试</Button>} /> : null}
    {!listState.loading && !listState.error && !items.length ? <Card><Empty description="暂无采集策略" /></Card> : null}
    {!listState.loading && !listState.error && items.length ? <Row gutter={[16, 16]}>{items.map(item => <Col xs={24} xl={12} key={item.id}><StrategyCard item={item} config={getStrategyTypeConfig(item.request_type)} accountOptions={accountOptions} canWrite={canWrite} onEdit={openEdit} onDelete={deleteStrategy} deleting={deletingId === item.id} /></Col>)}</Row> : null}
    {editor.open ? <StrategyDrawer editor={editor} canWrite={canWrite} onClose={() => setEditor(current => ({ ...current, open: false }))} onSaved={async () => { setEditor(current => ({ ...current, open: false })); await loadStrategies() }} /> : null}
  </div>
}

function StrategyAppContent() {
  const { message: appMessage } = AntApp.useApp()
  const [items, setItems] = useState([])
  const [accountOptions, setAccountOptions] = useState(new Map())
  const [listState, setListState] = useState({ loading: true, error: null })
  const [health, setHealth] = useState({ loading: true, ready: false, label: '连接检查中' })
  const [token, setToken] = useState(tokenStore.get())
  const [editor, setEditor] = useState({ open: false, isCreate: false, item: null, accountOptions: new Map(), loading: false })
  const [deletingId, setDeletingId] = useState(null)
  const canWrite = health.ready && Boolean(token.trim())

  const refreshHealth = async () => {
    setHealth(current => ({ ...current, loading: true, label: '连接检查中' }))
    try {
      const result = await api.get('/api/health', { key: 'health', cache: false })
      setHealth({ loading: false, ready: result.ready === true, label: result.ready === true ? '已连接' : '未就绪' })
    } catch (error) {
      setHealth({ loading: false, ready: false, label: '连接失败' })
    }
  }

  const loadAccountsByIds = async ids => {
    const batches = strategyAccountIdBatches(ids)
    if (!batches.length) return new Map()
    const results = await Promise.all(batches.map(batch => api.get(`/api/strategy-options/accounts?ids=${batch.join(',')}&page=1&pageSize=100`, { key: `strategy-options:accounts:ids:${batch.join(',')}`, cache: true })))
    return new Map(results.flatMap(result => result.items || []).map(item => [String(item.id), item]))
  }

  const loadStrategies = async () => {
    setListState({ loading: true, error: null })
    try {
      const result = await api.get('/api/strategies?page=1&pageSize=100', { key: 'strategies:list', cache: false })
      const ids = (result.items || []).flatMap(item => getStrategyTypeConfig(item.request_type).targetSelector === 'account' ? (item.active_targets || []).slice(0, 3).map(target => target.account_id) : [])
      const options = await loadAccountsByIds(ids)
      setAccountOptions(options)
      setItems(result.items || [])
      setListState({ loading: false, error: null })
    } catch (error) {
      setListState({ loading: false, error: errorMessage(error) })
    }
  }

  const refreshAll = async () => {
    api.invalidate('strategies:list')
    await Promise.all([refreshHealth(), loadStrategies()])
  }

  const openCreate = () => setEditor({ open: true, isCreate: true, item: null, accountOptions: new Map(), loading: false })

  const openEdit = async id => {
    setEditor({ open: true, isCreate: false, item: null, accountOptions: new Map(), loading: true })
    try {
      const item = (await api.get(`/api/strategies/${encodeURIComponent(id)}`, { key: `strategy:${id}`, cache: false })).item
      const ids = [...(item.source_targets || []), ...(item.active_targets || [])].map(target => target.account_id).filter(Boolean)
      const options = getStrategyTypeConfig(item.request_type).targetSelector === 'account' ? await loadAccountsByIds(ids) : new Map()
      setEditor({ open: true, isCreate: false, item, accountOptions: options, loading: false })
    } catch (error) {
      setEditor({ open: false, isCreate: false, item: null, accountOptions: new Map(), loading: false })
      appMessage.error(errorMessage(error))
    }
  }

  const deleteStrategy = async item => {
    setDeletingId(item.id)
    try {
      await api.mutate(`/api/strategies/${encodeURIComponent(item.id)}`, { method: 'DELETE', body: { expected_updated_at: item.updated_at } })
      appMessage.success('策略已删除')
      await loadStrategies()
    } catch (error) {
      appMessage.error(errorMessage(error))
    } finally {
      setDeletingId(null)
    }
  }

  useEffect(() => {
    refreshHealth()
    loadStrategies()
  }, [])

  const statusColor = health.loading ? 'processing' : health.ready ? 'success' : 'warning'
  return <ConfigProvider theme={{ token: { colorPrimary: '#316FEA', colorBgLayout: '#F5F7FA', colorBgContainer: '#FFFFFF', colorText: '#172033', colorTextSecondary: '#667085', colorBorder: '#E5EAF2', borderRadius: 8, borderRadiusLG: 10, controlHeight: 34, motionDurationMid: '0.18s' } }}>
    <Layout className="strategy-react-layout">
      <Sider width={224} theme="dark" className="strategy-react-sider">
        <div className="strategy-react-brand"><span className="strategy-react-brand-mark">W</span><span>配置管理中心</span></div>
        <Menu mode="inline" theme="dark" selectedKeys={['strategies']} items={NAV_ITEMS} onClick={({ key }) => navigateManagementView(key)} />
        <div className="strategy-react-sider-note">仅本机回环服务<br /><span>Supabase 密钥仅在服务端</span></div>
      </Sider>
      <Layout>
        <Header className="strategy-react-header">
          <div><Typography.Text className="strategy-react-eyebrow">WECHAT MEDIA OPINION</Typography.Text><Typography.Title level={4} style={{ margin: 0 }}>采集策略</Typography.Title></div>
          <Space size={12} wrap>
            <Tag color={statusColor}>{health.label}</Tag>
            <Input.Password value={token} onChange={event => { const value = event.target.value; setToken(value); tokenStore.set(value) }} placeholder="本机令牌" aria-label="本机令牌" style={{ width: 170 }} />
        <Tooltip getPopupContainer={getBodyPopupContainer} title="刷新连接状态和策略列表"><Button icon={<ReloadOutlined />} onClick={refreshAll}>刷新</Button></Tooltip>
          </Space>
        </Header>
        <Content className="strategy-react-content">
          <div className="strategy-react-page-heading"><div><Typography.Title level={2}>采集策略</Typography.Title><Typography.Paragraph type="secondary">用户定义业务条件配置下一次采集范围；保存只更新配置，不会立即发起采集。</Typography.Paragraph></div><Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={!canWrite}>新建策略</Button></div>
          {!canWrite ? <Alert className="strategy-react-readonly" type="info" showIcon message="当前为只读或连接未就绪。写操作需要先配置本机令牌，并通过真实 health 检查。" /> : null}
          {listState.loading ? <Row gutter={[16, 16]}>{[1, 2].map(key => <Col xs={24} xl={12} key={key}><Card><Skeleton active paragraph={{ rows: 7 }} /></Card></Col>)}</Row> : null}
          {!listState.loading && listState.error ? <Alert type="error" showIcon message="策略加载失败" description={listState.error} action={<Button size="small" onClick={loadStrategies}>重试</Button>} /> : null}
          {!listState.loading && !listState.error && !items.length ? <Card><Empty description="暂无采集策略" /></Card> : null}
          {!listState.loading && !listState.error && items.length ? <Row gutter={[16, 16]}>{items.map(item => <Col xs={24} xl={12} key={item.id}><StrategyCard item={item} config={getStrategyTypeConfig(item.request_type)} accountOptions={accountOptions} canWrite={canWrite} onEdit={openEdit} onDelete={deleteStrategy} deleting={deletingId === item.id} /></Col>)}</Row> : null}
        </Content>
      </Layout>
    </Layout>
    {editor.open ? <StrategyDrawer editor={editor} canWrite={canWrite} onClose={() => setEditor(current => ({ ...current, open: false }))} onSaved={async () => { setEditor(current => ({ ...current, open: false })); await loadStrategies() }} /> : null}
  </ConfigProvider>
}

function StrategyApp() {
  return <AntApp><StrategyAppContent /></AntApp>
}

let mountedRoot = null
let mountedNode = null

function mountStrategyApp(node) {
  if (mountedRoot && mountedNode === node) return
  if (mountedRoot) mountedRoot.unmount()
  mountedNode = node
  mountedRoot = createRoot(node)
  mountedRoot.render(<StrategyApp />)
}

function unmountStrategyApp() {
  if (mountedRoot) mountedRoot.unmount()
  mountedRoot = null
  mountedNode = null
}

if (typeof window !== 'undefined') {
  window.mountStrategyApp = mountStrategyApp
  window.unmountStrategyApp = unmountStrategyApp
}
