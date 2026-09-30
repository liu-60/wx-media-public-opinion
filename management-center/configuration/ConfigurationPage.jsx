import { useEffect, useState } from 'react'
import { App, Button, Card, Col, Form, Input, InputNumber, Row, Space, Spin, Switch, Typography } from 'antd'
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons'

const EMPTY = {
  apis: {
    wxrank: { base_url: '', search_url: '', account_base_url: '', key: { configured: false, masked: '', source: '未配置' }, authorization: { configured: false, masked: '', source: '未配置' }, cookie: { configured: false, masked: '', source: '未配置' } },
    redfox: { base_url: '', key: { configured: false, masked: '', source: '未配置' } }
  },
  llm: { provider: 'openai-compatible', model: 'gpt-4o-mini', base_url: '', enabled: false, api_key: { configured: false, masked: '', source: '未配置' } }
}

export function ConfigurationPage({ api, canWrite, refreshKey = 0 }) {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [state, setState] = useState({ loading: true, saving: false, error: '' })
  const [effective, setEffective] = useState(EMPTY)
  const [budget, setBudget] = useState({ loading: true, limits: {}, usage: {}, date: '', timezone: 'Asia/Singapore', max_limit: 100, error: '' })
  const [budgetDraft, setBudgetDraft] = useState({})

  const load = async () => {
    setState(value => ({ ...value, loading: true, error: '' }))
    try {
      const [result, budgetResult] = await Promise.all([
        api.get('/api/configuration', { cache: false }),
        api.get('/api/collection/debug-api-budget', { cache: false })
      ])
      setEffective(result)
      setBudget({ loading: false, ...budgetResult, error: '' })
      setBudgetDraft(budgetResult.limits || {})
      form.setFieldsValue({
        wxrank_url: result.apis?.wxrank?.base_url || '',
        wxrank_search_url: result.apis?.wxrank?.search_url || '',
        wxrank_account_url: result.apis?.wxrank?.account_base_url || '',
        redfox_url: result.apis?.redfox?.base_url || '',
        llm_provider: result.llm?.provider || 'openai-compatible',
        llm_model: result.llm?.model || '',
        llm_base_url: result.llm?.base_url || '',
        llm_enabled: result.llm?.enabled === true
      })
      setState({ loading: false, saving: false, error: '' })
    } catch (error) {
      setBudget(value => ({ ...value, loading: false, error: error?.message || '额度读取失败' }))
      setState({ loading: false, saving: false, error: error?.message || '配置读取失败' })
    }
  }

  useEffect(() => { load() }, [refreshKey])

  const save = async () => {
    const values = await form.validateFields()
    setState(value => ({ ...value, saving: true, error: '' }))
    try {
      const result = await api.mutate('/api/configuration', { method: 'PUT', body: {
        apis: {
          wxrank: { base_url: values.wxrank_url, search_url: values.wxrank_search_url, account_base_url: values.wxrank_account_url, api_key: values.wxrank_key || '', authorization: values.wxrank_authorization || '', cookie: values.wxrank_cookie || '' },
          redfox: { base_url: values.redfox_url, api_key: values.redfox_key || '' }
        },
        llm: { provider: values.llm_provider, model: values.llm_model, base_url: values.llm_base_url || '', api_key: values.llm_key || '', enabled: values.llm_enabled === true }
      } })
      setEffective(result)
      form.setFieldsValue({ wxrank_key: '', redfox_key: '', llm_key: '' })
      message.success('配置已保存；后续新请求立即读取')
      setState({ loading: false, saving: false, error: '' })
    } catch (error) {
      setState(value => ({ ...value, saving: false, error: error?.message || '配置保存失败' }))
    }
  }
  const saveBudget = async () => {
    if (!['WxRank', 'Redfox'].every(platform => Number.isInteger(budgetDraft[platform]) && budgetDraft[platform] >= 0 && budgetDraft[platform] <= budget.max_limit)) return
    setBudget(value => ({ ...value, saving: true, error: '' }))
    try {
      const result = await api.mutate('/api/collection/debug-api-budget', { method: 'PUT', body: { limits: { WxRank: budgetDraft.WxRank, Redfox: budgetDraft.Redfox } } })
      setBudget({ ...result, loading: false, saving: false, error: '' })
      setBudgetDraft(result.limits || {})
      message.success('每日请求额度已保存；当天已用次数保留')
    } catch (error) { setBudget(value => ({ ...value, saving: false, error: error?.message || '额度保存失败' })) }
  }

  const secretHint = value => value?.configured ? `已配置 ${value.masked} · ${value.source}` : `未配置 · ${value?.source || '未配置'}`
  return <div className="management-page configuration-page">
    <div className="management-page-heading"><div><Typography.Title level={2}>配置信息</Typography.Title><Typography.Paragraph type="secondary">统一维护采集 API 与可扩展的 LLM 配置。密钥只在服务端保存并脱敏展示。</Typography.Paragraph></div><Space><Button icon={<ReloadOutlined />} onClick={load}>刷新</Button><Button type="primary" icon={<SaveOutlined />} disabled={!canWrite} loading={state.saving} onClick={save}>保存配置</Button></Space></div>
    <Typography.Paragraph type="secondary">生效优先级：{(effective.priority || ['本地保存配置', '进程环境', '.env', '默认值']).join(' → ')}。</Typography.Paragraph>
    {state.error ? <Card size="small" style={{ marginBottom: 16 }}><Typography.Text type="danger">{state.error}</Typography.Text></Card> : null}
    {state.loading ? <Spin /> : <Form form={form} layout="vertical" disabled={!canWrite}>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}><Card title="WxRank API" extra={<Typography.Text type="secondary">{effective.apis?.wxrank?.source || '默认值'}</Typography.Text>}>
          <Form.Item name="wxrank_url" label="API 地址" rules={[{ required: true, type: 'url', message: '请输入有效的 API URL' }]}><Input /></Form.Item>
          <Form.Item name="wxrank_search_url" label="搜一搜地址" rules={[{ required: true, type: 'url', message: '请输入有效的 API URL' }]}><Input /></Form.Item>
          <Form.Item name="wxrank_account_url" label="账号/榜单 API 根地址" rules={[{ required: true, type: 'url', message: '请输入有效的 API URL' }]}><Input /></Form.Item>
          <Form.Item name="wxrank_key" label="API Key / Token" extra={secretHint(effective.apis?.wxrank?.key)}><Input.Password placeholder={effective.apis?.wxrank?.key?.masked ? `留空保持当前密钥 ${effective.apis.wxrank.key.masked}` : '未配置'} autoComplete="new-password" /></Form.Item>
          <Form.Item name="wxrank_authorization" label="账号接口 Authorization" extra={secretHint(effective.apis?.wxrank?.authorization)}><Input.Password placeholder={effective.apis?.wxrank?.authorization?.masked ? `留空保持当前值 ${effective.apis.wxrank.authorization.masked}` : '可选'} autoComplete="new-password" /></Form.Item>
          <Form.Item name="wxrank_cookie" label="账号接口 Cookie" extra={secretHint(effective.apis?.wxrank?.cookie)}><Input.Password placeholder={effective.apis?.wxrank?.cookie?.masked ? `留空保持当前值 ${effective.apis.wxrank.cookie.masked}` : '可选'} autoComplete="new-password" /></Form.Item>
        </Card></Col>
        <Col xs={24} xl={12}><Card title="RedFox API" extra={<Typography.Text type="secondary">{effective.apis?.redfox?.source || '默认值'}</Typography.Text>}>
          <Form.Item name="redfox_url" label="API 根地址" rules={[{ required: true, type: 'url', message: '请输入有效的 API URL' }]}><Input /></Form.Item>
          <Form.Item name="redfox_key" label="API Key" extra={secretHint(effective.apis?.redfox?.key)}><Input.Password placeholder={effective.apis?.redfox?.key?.masked ? `留空保持当前密钥 ${effective.apis.redfox.key.masked}` : '未配置'} autoComplete="new-password" /></Form.Item>
        </Card></Col>
        <Col xs={24}><Card title="LLM 配置" extra={<Typography.Text type="secondary">{effective.llm?.source || '默认值'}</Typography.Text>}>
          <Row gutter={16}><Col xs={24} md={8}><Form.Item name="llm_provider" label="Provider"><Input placeholder="openai-compatible" /></Form.Item></Col><Col xs={24} md={8}><Form.Item name="llm_model" label="Model"><Input placeholder="模型名称" /></Form.Item></Col><Col xs={24} md={8}><Form.Item name="llm_base_url" label="Base URL"><Input placeholder="可留空，使用 Provider 默认地址" /></Form.Item></Col></Row>
          <Row gutter={16} align="middle"><Col xs={24} md={8}><Form.Item name="llm_key" label="API Key" extra={secretHint(effective.llm?.api_key)}><Input.Password placeholder={effective.llm?.api_key?.masked ? `留空保持当前密钥 ${effective.llm.api_key.masked}` : '未配置'} autoComplete="new-password" /></Form.Item></Col><Col><Form.Item name="llm_enabled" label="启用"><Switch /></Form.Item></Col></Row>
        </Card></Col>
      </Row>
    </Form>}
    <Card title="每日 API 请求额度" extra={<Button type="primary" disabled={!canWrite || budget.loading} loading={budget.saving} onClick={saveBudget}>保存额度</Button>} style={{ marginTop: 16 }}>
      <Typography.Paragraph type="secondary">按平台限制真实请求。计数时区：{budget.timezone}；日期：{budget.date || '—'}。设为 0 会停止该平台补采请求，保存额度不会重置当天计数。</Typography.Paragraph>
      {budget.error ? <Typography.Text type="danger">{budget.error}</Typography.Text> : null}
      <Row gutter={16}>
        {['WxRank', 'Redfox'].map(platform => <Col xs={24} md={12} key={platform}><Card size="small" title={platform === 'Redfox' ? 'RedFox' : platform}><Space direction="vertical" style={{ width: '100%' }}><Typography.Text type="secondary">今日已用 / 当前额度：{budget.usage?.[platform] ?? 0} / {budget.limits?.[platform] ?? '—'} 次</Typography.Text><InputNumber min={0} max={budget.max_limit} precision={0} addonAfter="次" disabled={!canWrite || budget.loading} value={budgetDraft[platform]} onChange={value => setBudgetDraft(current => ({ ...current, [platform]: value }))} aria-label={`${platform} 每日请求额度`} /></Space></Card></Col>)}
      </Row>
    </Card>
  </div>
}
