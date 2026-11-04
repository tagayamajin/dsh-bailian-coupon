/**
 * 端到端路由测试：不需要 DSH 宿主，也不需要阿里云凭据。
 *
 * 做法：用一个最小的 stub ctx 接住 apply() 注册的路由，把它们挂在本地 node:http
 * server 上，再用真实 fetch 请求，验证：
 *   - 注册了哪几个路由；
 *   - 没配凭据时 /overview 返回 not-configured（不会去访问网络）；
 *   - 方法守卫 405、/config 的掩码与校验、写入/清除配置；
 *   - 配好（假的）凭据后 /refresh 能走通整条链路：签名 → 请求 URL → 汇总余额，
 *     其中 fetch 被 stub 成返回一份 QueryCashCoupons 假响应。
 *
 * 运行：<node 绝对路径> tests\routes.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

// 配置目录必须隔离到临时目录。否则测试会写穿到包内 .state/config.json，
// 覆盖用户真实保存的 AccessKey（甚至把凭据清掉）。
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bailian-coupon-test-'))
process.env.DSH_BAILIAN_COUPON_STATE_DIR = stateDir
const stateFile = path.join(stateDir, 'config.json')

const savedEnv = {
  ALIBABA_CLOUD_ACCESS_KEY_ID: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID,
  ALIBABA_CLOUD_ACCESS_KEY_SECRET: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
}
delete process.env.ALIBABA_CLOUD_ACCESS_KEY_ID
delete process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET

// 先设好环境变量，再加载插件。
const { apply, inject, name } = await import('../lib/index.js')

function cleanup() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  delete process.env.DSH_BAILIAN_COUPON_STATE_DIR
  fs.rmSync(stateDir, { recursive: true, force: true })
}

// ── 1. 注册路由 ─────────────────────────────────────────────────────────
const registered = new Map()
const ctx = {
  effect(body) {
    const dispose = body()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  webServer: {
    register(route) {
      registered.set(route.path, route)
      return () => registered.delete(route.path)
    },
  },
  info() {},
  warn() {},
  error() {},
}

assert.equal(name, 'dsh-bailian-coupon')
assert.deepEqual(inject, ['webServer'])
apply(ctx, {})

const expectedPaths = [
  '/api/dsh-bailian-coupon/overview',
  '/api/dsh-bailian-coupon/refresh',
  '/api/dsh-bailian-coupon/config',
]
assert.deepEqual([...registered.keys()].sort(), expectedPaths.sort())
for (const [routePath, route] of registered) {
  assert.equal(route.kind, 'exact', `${routePath} 应为 exact 路由`)
  assert.equal(typeof route.handler, 'function', `${routePath} 应有 handler`)
}
console.log('routes: OK')

// ── 2. 本地 http server（模拟宿主 webServer）────────────────────────────
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname
  const route = registered.get(pathname)
  if (!route) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
    return
  }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    if (!res.writableEnded) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(String(error && error.message ? error.message : error))
    }
  })
})

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const base = `http://127.0.0.1:${server.address().port}`
const realFetch = globalThis.fetch.bind(globalThis)

async function call(method, urlPath, body) {
  const init = { method, headers: {} }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const response = await realFetch(base + urlPath, init)
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: response.status, headers: response.headers, json, text }
}

try {
  // ── 3. 无凭据：overview 不发网络请求，返回 not-configured ──────────────
  let networkCalls = 0
  globalThis.fetch = async (url, ...rest) => {
    if (!String(url).startsWith(base)) networkCalls += 1
    return realFetch(url, ...rest)
  }
  const overview = await call('GET', '/api/dsh-bailian-coupon/overview')
  globalThis.fetch = realFetch
  assert.equal(overview.status, 200)
  assert.equal(overview.json.ok, false)
  assert.equal(overview.json.configured, false)
  assert.equal(overview.json.error.code, 'not-configured')
  assert.equal(overview.json.error.action, 'missing-credentials')
  assert.match(overview.json.error.message || '', /AccessKey/)
  assert.match(overview.json.modelKeyHint || '', /RAM/)
  assert.match(overview.json.consoleCouponUrl, /^https:\/\/billing-cost\.console\.aliyun\.com\//)
  assert.match(overview.json.consoleAkUrl, /^https:\/\/ram\.console\.aliyun\.com\//)
  assert.equal(overview.headers.get('cache-control'), 'no-store')
  assert.match(overview.headers.get('content-type') || '', /application\/json/)
  assert.equal(networkCalls, 0, '没有凭据时不应发起出站请求')
  console.log('overview (unconfigured): OK')

  // ── 4. 方法守卫 ───────────────────────────────────────────────────────
  const postOverview = await call('POST', '/api/dsh-bailian-coupon/overview')
  assert.equal(postOverview.status, 405)
  const getRefresh = await call('GET', '/api/dsh-bailian-coupon/refresh')
  assert.equal(getRefresh.status, 405)
  const putConfig = await call('PUT', '/api/dsh-bailian-coupon/config')
  assert.equal(putConfig.status, 405)
  console.log('method guards: OK')

  // ── 5. config GET：空配置 ─────────────────────────────────────────────
  const emptyConfig = await call('GET', '/api/dsh-bailian-coupon/config')
  assert.equal(emptyConfig.status, 200)
  assert.equal(emptyConfig.json.ok, true)
  assert.equal(emptyConfig.json.configured, false)
  assert.equal(emptyConfig.json.source, 'none')
  assert.equal(emptyConfig.json.accessKeyId, '')
  assert.equal(emptyConfig.json.hasSecret, false)
  assert.equal(emptyConfig.json.refreshMinutes, 10)
  assert.equal(emptyConfig.json.includeCashNote, false)
  assert.equal(emptyConfig.json.envLocked, false)
  assert.equal(emptyConfig.json.statePath, stateFile)
  console.log('config (empty): OK')

  // ── 6. config POST：校验与掩码 ────────────────────────────────────────
  const badAk = await call('POST', '/api/dsh-bailian-coupon/config', { accessKeyId: 'abc' })
  assert.equal(badAk.status, 400)
  assert.equal(badAk.json.code, 'bad-access-key-id')

  const badJson = await fetch(base + '/api/dsh-bailian-coupon/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  })
  assert.equal(badJson.status, 400)

  const saved = await call('POST', '/api/dsh-bailian-coupon/config', {
    accessKeyId: 'LTAI5tTestTestTestTest',
    accessKeySecret: 'test-secret-value',
    refreshMinutes: 0,
    includeCashNote: true,
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.configured, true)
  assert.equal(saved.json.source, 'file')
  assert.equal(saved.json.accessKeyId, 'LTAI****Test')
  assert.equal(saved.json.hasSecret, true)
  assert.equal(saved.json.refreshMinutes, 1, 'refreshMinutes 应被 clamp 到 1')
  assert.equal(saved.json.includeCashNote, true)
  assert.ok(fs.existsSync(stateFile), '应写入 .state/config.json')
  const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(onDisk.accessKeySecret, 'test-secret-value')

  const maskedAgain = await call('GET', '/api/dsh-bailian-coupon/config')
  assert.equal(maskedAgain.json.configured, true)
  assert.equal(maskedAgain.json.accessKeyId, 'LTAI****Test')
  assert.equal(maskedAgain.json.refreshMinutes, 1)
  console.log('config (save + mask): OK')

  // ── 7. 清掉凭据，避免后续步骤真的访问阿里云 ───────────────────────────
  const cleared = await call('POST', '/api/dsh-bailian-coupon/config', { clear: true })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.json.configured, false)
  assert.equal(cleared.json.source, 'none')
  console.log('config (clear): OK')

  // ── 8. 假的凭据 + stub fetch：跑通 overview/refresh 全链路 ────────────
  const fakeCoupons = {
    RequestId: 'fake-request-id',
    Success: true,
    Code: 'Success',
    Message: 'Successful!',
    Data: {
      CashCoupon: [
        {
          CashCouponId: 1001,
          CashCouponNo: 'Q-fake-0001',
          NominalValue: '300.00',
          Balance: '300.00',
          Status: 'Available',
          EffectiveTime: '2026-01-01T00:00:00Z',
          GrantedTime: '2026-01-01T00:00:00Z',
          ExpiryTime: '2027-01-01T00:00:00Z',
          ApplicableProducts: '通用',
          Description: '云工开物 300 元抵扣金',
        },
        {
          CashCouponId: 1002,
          CashCouponNo: 'Q-fake-0002',
          NominalValue: '100.00',
          Balance: '40.00',
          Status: 'Available',
          EffectiveTime: '2026-01-01T00:00:00Z',
          GrantedTime: '2026-01-01T00:00:00Z',
          ExpiryTime: '2026-12-01T00:00:00Z',
          ApplicableProducts: '人工智能平台 PAI',
          Description: '另一张券',
        },
        {
          CashCouponId: 1003,
          CashCouponNo: 'Q-fake-0003',
          NominalValue: '50.00',
          Balance: '50.00',
          Status: 'Expired',
          ExpiryTime: '2025-01-01T00:00:00Z',
        },
      ],
    },
  }

  const fakeBalance = {
    RequestId: 'fake-balance-id',
    Success: true,
    Code: 'Success',
    Data: { AvailableAmount: '12.34', AvailableCashAmount: '12.34', CreditAmount: '0.00', Currency: 'CNY' },
  }

  const outbound = []
  globalThis.fetch = async (url, init) => {
    outbound.push({ url: String(url), init })
    const action = new URL(String(url)).searchParams.get('Action')
    const payload = action === 'QueryAccountBalance' ? fakeBalance : fakeCoupons
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = 'LTAI5tFakeFakeFakeFake'
  process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = 'fake-secret'

  const refreshed = await call('POST', '/api/dsh-bailian-coupon/refresh')
  assert.equal(refreshed.status, 200)
  assert.equal(refreshed.json.ok, true)
  assert.equal(refreshed.json.source, 'env')
  assert.equal(refreshed.json.remaining, 340, '只累加 Available 的 Balance：300 + 40')
  assert.equal(refreshed.json.couponCount, 3)
  assert.equal(refreshed.json.availableCount, 2)
  assert.equal(refreshed.json.nearestExpiry, '2026-12-01T00:00:00Z')
  assert.equal(refreshed.json.coupons.length, 3)
  assert.equal(refreshed.json.coupons[0].no, 'Q-fake-0001')

  // includeCashNote 在第 6 节已打开，所以会多查一次现金余额（仅作附注）
  assert.equal(outbound.length, 2, 'refresh 应发出 QueryCashCoupons + QueryAccountBalance 两次请求')
  const couponCall = outbound.find((item) => item.url.includes('Action=QueryCashCoupons'))
  const balanceCall = outbound.find((item) => item.url.includes('Action=QueryAccountBalance'))
  assert.ok(couponCall && balanceCall)
  assert.deepEqual(refreshed.json.cash, { availableAmount: 12.34, cashAmount: 12.34, creditAmount: 0, currency: 'CNY' })

  const sentUrl = new URL(couponCall.url)
  assert.equal(sentUrl.host, 'business.aliyuncs.com')
  assert.equal(sentUrl.searchParams.get('Action'), 'QueryCashCoupons')
  assert.equal(sentUrl.searchParams.get('Version'), '2017-12-14')
  assert.equal(sentUrl.searchParams.get('Format'), 'JSON')
  assert.equal(sentUrl.searchParams.get('SignatureMethod'), 'HMAC-SHA1')
  assert.equal(sentUrl.searchParams.get('SignatureVersion'), '1.0')
  assert.equal(sentUrl.searchParams.get('AccessKeyId'), 'LTAI5tFakeFakeFakeFake')
  assert.ok(sentUrl.searchParams.get('Signature'), 'URL 里应带 Signature')
  assert.match(sentUrl.searchParams.get('Timestamp') || '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  const headers = couponCall.init && couponCall.init.headers
  const acceptEncoding = headers && typeof headers.get === 'function' ? headers.get('accept-encoding') : headers && headers['accept-encoding']
  assert.equal(acceptEncoding, 'identity', '必须显式要求 identity，宿主代理会破坏自动解压')

  // 缓存生效：TTL 内再请求 overview 不应再发出站请求
  const cachedOverview = await call('GET', '/api/dsh-bailian-coupon/overview')
  assert.equal(cachedOverview.json.ok, true)
  assert.equal(cachedOverview.json.remaining, 340)
  assert.equal(cachedOverview.json.stale, false)
  assert.equal(outbound.length, 2, 'TTL 内应复用缓存')
  console.log('overview/refresh (stubbed BSS): OK')

  // ── 9. BSS 报错映射 ───────────────────────────────────────────────────
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ RequestId: 'r', Success: false, Code: 'SignatureDoesNotMatch', Message: 'Specified signature is not matched with our calculation.' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )
  const denied = await call('POST', '/api/dsh-bailian-coupon/refresh')
  assert.equal(denied.status, 200)
  assert.equal(denied.json.ok, false)
  assert.equal(denied.json.error.code, 'SignatureDoesNotMatch')
  assert.equal(denied.json.error.action, 'fix-signature')
  assert.match(denied.json.error.hint, /31 分钟|AccessKeySecret/)

  globalThis.fetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND business.aliyuncs.com')
  }
  const offline = await call('POST', '/api/dsh-bailian-coupon/refresh')
  assert.equal(offline.json.ok, false)
  assert.equal(offline.json.error.code, 'network')
  assert.equal(offline.json.error.action, 'network')
  console.log('error shaping: OK')

  delete process.env.ALIBABA_CLOUD_ACCESS_KEY_ID
  delete process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET
  globalThis.fetch = realFetch

  console.log('routes.test.mjs OK')
} finally {
  await new Promise((resolve) => server.close(resolve))
  cleanup()
}