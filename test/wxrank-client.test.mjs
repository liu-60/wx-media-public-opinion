import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchAccountSources } from '../src/wxrank-client.mjs'

test('WxRank client fetches rank and search account sources with HTTP/code validation', async () => {
  const calls = []
  const result = await fetchAccountSources({
    baseUrl: 'https://example.test',
    headers: { authorization: 'test-only' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      if (calls.length === 1) return { status: 200, json: async () => ({ code: 0, data: { list: [{ wx_biz: 'biz-1' }] } }) }
      return { status: 200, json: async () => ({ code: 0, data: { list: [{ wx_biz: 'biz-2' }] } }) }
    }
  })
  assert.equal(calls.length, 2)
  assert.match(calls[0].url, /\/api\/rank\/account\?range=30d&page=1/u)
  assert.equal(calls[0].options.method, 'GET')
  assert.equal(calls[1].options.method, 'POST')
  assert.equal(calls[1].options.body, JSON.stringify({ range: '30d' }))
  assert.deepEqual(result.rows.map(row => [row.wx_biz, row.source]), [['biz-1', 'rank'], ['biz-2', 'search']])
})

test('WxRank client rejects non-200 and non-zero API responses', async () => {
  await assert.rejects(
    fetchAccountSources({ fetchImpl: async () => ({ status: 403, json: async () => ({ code: 0 }) }) }),
    /HTTP 403/u
  )
  await assert.rejects(
    fetchAccountSources({ fetchImpl: async () => ({ status: 200, json: async () => ({ code: 1001 }) }) }),
    /code 1001/u
  )
})
