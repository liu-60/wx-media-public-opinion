export function createApiClient({ fetchImpl = globalThis.fetch, getToken = () => '', cacheDefault = false } = {}) {
  const cacheStore = new Map()
  const inflight = new Map()
  const generations = new Map()
  const generationOf = key => generations.get(key) || 0

  const get = (url, { key = url, signal, cache: useCache = cacheDefault } = {}) => {
    const generation = generationOf(key)
    const requestKey = `${generation}:${key}:${url}`
    if (useCache && cacheStore.has(requestKey)) return Promise.resolve(cacheStore.get(requestKey))
    if (inflight.has(requestKey)) return inflight.get(requestKey)
    const promise = fetchImpl(url, { headers: { Accept: 'application/json' }, signal }).then(async response => {
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        const error = new Error(body.error || '请求失败')
        error.status = response.status
        error.code = body.code
        throw error
      }
      if (useCache && generation === generationOf(key)) cacheStore.set(requestKey, body)
      return body
    }).finally(() => {
      if (inflight.get(requestKey) === promise) inflight.delete(requestKey)
    })
    inflight.set(requestKey, promise)
    return promise
  }

  const invalidate = key => {
    generations.set(key, generationOf(key) + 1)
    for (const cacheKey of cacheStore.keys()) if (cacheKey.includes(`:${key}:`)) cacheStore.delete(cacheKey)
  }

  const mutate = (url, { method = 'POST', body = {}, signal } = {}) => fetchImpl(url, {
    method,
    signal,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-management-token': getToken()
    },
    body: JSON.stringify(body)
  }).then(async response => {
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error = new Error(data.error || '写入失败')
      error.status = response.status
      error.code = data.code
      throw error
    }
    return data
  })

  return Object.freeze({
    get,
    mutate,
    invalidate,
    clear: () => {
      cacheStore.clear()
      inflight.clear()
    }
  })
}

export function createTokenStore(storageKey = 'managementToken', storage = null) {
  const getStorage = () => {
    try { return storage || globalThis.localStorage } catch { return null }
  }
  const getLegacyStorage = () => {
    try { return storage ? null : globalThis.sessionStorage } catch { return null }
  }
  return Object.freeze({
    get: () => {
      try {
        const target = getStorage()
        const current = target?.getItem(storageKey) || ''
        if (current) return current
        const legacy = getLegacyStorage()?.getItem(storageKey) || ''
        if (legacy && target) target.setItem(storageKey, legacy)
        return legacy
      } catch { return '' }
    },
    set: value => {
      try {
        const target = getStorage()
        if (!target) return
        if (value) target.setItem(storageKey, value)
        else target.removeItem(storageKey)
      } catch {}
    }
  })
}
