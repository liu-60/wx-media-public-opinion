import { buildNextRequestPreviewModel, formatMetric, formatReadingRange, formatStrategyUpdatedAt, strategyStatus } from '../../strategy-ui.mjs'

function avatarMarkup(target, esc, safeUrl) {
  const name = String(target?.name || '公')
  const url = safeUrl(target?.avatar)
  return url
    ? `<img class="strategy-avatar strategy-avatar-card" src="${esc(url)}" alt="" loading="lazy">`
    : `<span class="strategy-avatar strategy-avatar-card avatar-placeholder" aria-hidden="true">${esc(name.slice(0, 1))}</span>`
}

function targetMarkup(target, { esc, safeUrl }) {
  return `<span class="strategy-card-target">${avatarMarkup(target, esc, safeUrl)}<span>${esc(target?.name || '未命名对象')}</span></span>`
}

export function renderStrategyCard(item, {
  requestTypeConfig,
  requestTypeLabel,
  presentTarget,
  esc = value => String(value ?? ''),
  safeUrl = value => value,
  canWrite = false
} = {}) {
  const config = requestTypeConfig || {}
  const model = buildNextRequestPreviewModel({
    requestType: item.request_type,
    requestTypeLabel: requestTypeLabel || config.label,
    activeTargets: item.active_targets || [],
    presentTarget,
    date: item.date,
    month: item.month,
    minRead: item.min_read,
    maxRead: item.max_read,
    cursor: item.cursor,
    cycleNo: item.cycle_no
  })
  const status = strategyStatus(item)
  const targets = model.visibleTargets.map(target => targetMarkup(presentTarget(target.raw), { esc, safeUrl })).join('')
  const targetContent = model.targetCount
    ? `<div class="strategy-card-targets">${targets}${model.hiddenTargetCount ? `<span class="strategy-card-more">另外 ${model.hiddenTargetCount} 个</span>` : ''}</div><div class="strategy-card-target-count">${model.targetCount} 个${esc(config.targetUnit || '对象')}</div>`
    : `<div class="strategy-card-targets strategy-card-targets-empty">${model.date ? `采集日期 ${esc(model.date)}` : model.month ? `采集月份 ${esc(model.month)}` : '暂未设置下次请求对象'}</div>`
  const dateLine = model.date ? `<span>采集日期 ${esc(model.date)}</span>` : model.month ? `<span>采集月份 ${esc(model.month)}</span>` : ''
  return `<article class="card strategy-card"><div class="card-head"><div><div class="strategy-card-title"><span class="strategy-type-icon">${esc(config.icon || '◇')}</span><h3>${esc(config.label || requestTypeLabel || '采集策略')} · 策略 #${esc(item.id)}</h3></div><div class="card-meta">${dateLine}</div></div><span class="pill ${status.className}">${esc(status.label)}</span></div><div class="strategy-card-next"><div class="strategy-card-section-label">下一次采集</div>${targetContent}</div><div class="strategy-card-summary"><div><span>阅读量</span><strong>${esc(formatReadingRange(item.min_read, item.max_read))}</strong></div><div><span>请求页数</span><strong>${item.cursor > 0 ? esc(formatMetric(item.cursor)) : '暂不请求'}</strong></div><div><span>预计请求</span><strong>${esc(model.expectedRequestsLabel)}</strong></div><div><span>当前轮次</span><strong>第 ${esc(model.cycleNo)} 轮</strong></div></div><div class="strategy-card-updated">更新时间 ${esc(formatStrategyUpdatedAt(item.updated_at))}</div><div class="form-actions strategy-card-actions"><button class="button button-ghost button-small" data-edit-strategy="${esc(item.id)}" ${canWrite ? '' : 'disabled'}>编辑配置</button><button class="button button-ghost button-small" data-execute-strategy disabled title="采集执行器尚未接入，当前只能保存配置">执行</button><button class="button button-danger button-small" data-delete-strategy="${esc(item.id)}" ${canWrite ? '' : 'disabled'}>删除</button></div></article>`
}
