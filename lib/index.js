/**
 * dsh-bailian-coupon —— 在 DSH 里查看阿里云百炼（通用财务）代金券余额。
 *
 * 宿主半边（Node）：
 *   - 注册只读 HTTP 路由供 Web GUI 的客户端半边调用；
 *   - 用 RAM AccessKey 调 BSS OpenAPI QueryCashCoupons；
 *   - 配置存本包内 .state/config.json（也可用环境变量覆盖）。
 *
 * 设计约束（刻意的）：
 *   - 零第三方依赖（只用 node: 内置 + global fetch），pnpm link 安装后一定可解析；
 *   - 不依赖 schemastery / configForms：设置页由客户端半边自绘，写回本插件的 config 路由。
 *
 * 为什么要 RAM AccessKey：模型 API Key（sk-… / sk-sp-…）根本没有查询余额的接口，
 * 只有 RAM 用户（只读策略 AliyunBSSReadOnlyAccess 或 bss:DescribeCoupons）才能调 BSS。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CONSOLE_AK_URL,
  CONSOLE_COUPON_URL,
  DEFAULT_ENDPOINT,
  enc,
  queryAccountBalance,
  queryCashCoupons,
  signRpcQuery,
} from './bss.js'

export const name = 'dsh-bailian-coupon'
export const inject = ['webServer']

const API_PREFIX = '/api/dsh-bailian-coupon'
const STATE_DIR = '.state'
const CONFIG_FILE = 'config.json'
const DEFAULT_REFRESH_MINUTES = 10
const MIN_REFRESH_MINUTES = 1
const MAX_REFRESH_MINUTES = 1440

/** 包目录：lib/index.js → 包的根。 */
function packageRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.dirname(here)
}

function stateDir() {
  const override = process.env.DSH_BAILIAN_COUPON_STATE_DIR
  return override && override.trim() ? path.resolve(override.trim()) : path.join(packageRoot(), STATE_DIR)
}

function statePath() {
  return path.join(stateDir(), CONFIG_FILE)
}

function readStoredConfig() {
  try {
    const text = fs.readFileSync(statePath(), 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeStoredConfig(next) {
  const file = statePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, file)
}

function envCredential() {
  const id = (process.env.ALIBABA_CLOUD_ACCESS_KEY_ID || '').trim()
  const secret = (process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || '').trim()
  return id && secret ? { accessKeyId: id, accessKeySecret: secret } : null
}

function clampRefreshMinutes(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_REFRESH_MINUTES
  return Math.min(MAX_REFRESH_MINUTES, Math.max(MIN_REFRESH_MINUTES, Math.round(n)))
}

/**
 * 汇总「凭据从哪来」：环境变量优先（方便 CI/一次性使用），否则读磁盘配置。
 */
function resolveCredentials() {
  const fromEnv = envCredential()
  if (fromEnv) return { ...fromEnv, source: 'env', endpoint: DEFAULT_ENDPOINT }
  const stored = readStoredConfig()
  const accessKeyId = typeof stored.accessKeyId === 'string' ? stored.accessKeyId.trim() : ''
  const accessKeySecret = typeof stored.accessKeySecret === 'string' ? stored.accessKeySecret.trim() : ''
  if (accessKeyId && accessKeySecret) {
    return {
      accessKeyId,
      accessKeySecret,
      source: 'file',
      endpoint: typeof stored.endpoint === 'string' && stored.endpoint ? stored.endpoint : DEFAULT_ENDPOINT,
    }
  }
  return null
}

function resolveSettings() {
  const stored = readStoredConfig()
  return {
    refreshMinutes: clampRefreshMinutes(stored.refreshMinutes ?? DEFAULT_REFRESH_MINUTES),
    includeCashNote: stored.includeCashNote === true,
    endpoint: typeof stored.endpoint === 'string' && stored.endpoint ? stored.endpoint : DEFAULT_ENDPOINT,
  }
}

function maskAccessKeyId(id) {
  if (!id) return ''
  if (id.length <= 8) return `${id.slice(0, 2)}****`
  return `${id.slice(0, 4)}****${id.slice(-4)}`
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress || req.connection?.remoteAddress || ''
  if (!address) return false
  if (address === '::1' || address === '127.0.0.1') return true
  if (address.startsWith('::ffff:')) return address.slice(7) === '127.0.0.1'
  return false
}

function writeJson(res, status, body, headers = {}) {
  if (res.writableEnded) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req, { maxBytes = 64 * 1024 } = {}) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      const error = new Error('request body too large')
      error.code = 'too-large'
      throw error
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const error = new Error('request body must be a JSON object')
      error.code = 'bad-body'
      throw error
    }
    return parsed
  } catch (error) {
    if (error.code === 'bad-body') throw error
    const bad = new Error('request body is not valid JSON')
    bad.code = 'bad-json'
    throw bad
  }
}

/** 所有响应都会附带的帮助链接（不覆盖 action/message）。 */
function helpLinks() {
  return {
    modelKeyHint: '模型 API Key（sk-… / sk-sp-…）不能查询余额，需要 RAM 用户 AccessKey。',
    consoleCouponUrl: CONSOLE_COUPON_URL,
    consoleAkUrl: CONSOLE_AK_URL,
    envHint: '也可用环境变量 ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET。',
  }
}

function helpFor(credentials) {
  const base = helpLinks()
  if (!credentials) {
    return { ...base, action: 'missing-credentials', message: '还没有配置 RAM AccessKey，请在插件设置里填写。' }
  }
  return base
}

function shapeError(error) {
  const code = error && error.code ? String(error.code) : 'unknown'
  const message = error && error.message ? String(error.message) : '未知错误'
  let action = 'retry'
  let hint = ''
  if (code === 'not-configured') {
    action = 'missing-credentials'
    hint = '请在插件设置里填写 RAM 用户的 AccessKey ID / Secret。'
  } else if (code === 'network') {
    action = 'network'
    hint = '检查本机网络/DNS，或稍后重试。'
  } else if (code === 'InvalidAccessKeyId' || code === 'InvalidAccessKeyId.NotFound') {
    action = 'fix-credentials'
    hint = 'AccessKeyId 不存在或已被删除，请重新生成。'
  } else if (code === 'SignatureDoesNotMatch') {
    action = 'fix-signature'
    hint = '通常是 AccessKeySecret 填错，或本机时间偏差过大（签名时间戳有效期 31 分钟）。'
  } else if (code === 'NotAuthorized' || code === 'Forbidden' || code === 'NoPermission') {
    action = 'fix-permission'
    hint = '该 RAM 用户缺少 bss:DescribeCoupons 权限，请附加只读策略 AliyunBSSReadOnlyAccess。'
  } else if (code === 'Throttling' || code === 'Throttling.User' || code === 'ServiceUnavailable') {
    action = 'rate-limited'
    hint = '被阿里云限流了，降低刷新频率或稍后再试。'
  } else if (code === 'bad-response') {
    action = 'bad-response'
    hint = '返回内容不是 JSON，可能被网关/代理改写。'
  }
  return { ok: false, code, message, action, hint, ...helpLinks() }
}

/**
 * 宿主插件入口。config 来自 cordis.patch.yml 里的 `config:`（我们不用，但允许覆盖刷新间隔）。
 */
export function apply(ctx, config = {}) {
  const log = (level, ...args) => {
    try {
      const fn = ctx && typeof ctx[level] === 'function' ? ctx[level] : null
      if (fn) fn.call(ctx, '[dsh-bailian-coupon]', ...args)
    } catch {
      /* 忽略日志失败 */
    }
  }

  /** @type {{fetchedAt:number, data:any}|null} */
  let cache = null
  let inflight = null
  let disposed = false

  const disposeAll = []

  ctx.effect(() => {
    return () => {
      disposed = true
      cache = null
      inflight = null
      for (const dispose of disposeAll) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    }
  }, 'dsh-bailian-coupon: runtime')

  function overviewBody() {
    const credentials = resolveCredentials()
    const settings = resolveSettings()
    const now = Date.now()
    if (cache) {
      const age = now - cache.fetchedAt
      const fresh = age < settings.refreshMinutes * 60_000
      if (cache.data.ok || !fresh) {
        return {
          ...cache.data,
          source: credentials ? credentials.source : 'none',
          fetchedAt: new Date(cache.fetchedAt).toISOString(),
          stale: !fresh,
          refreshMinutes: settings.refreshMinutes,
        }
      }
    }
    if (!credentials) {
      return {
        ok: false,
        configured: false,
        source: 'none',
        error: shapeError(Object.assign(new Error('未配置 RAM AccessKey'), { code: 'not-configured' })),
        refreshMinutes: settings.refreshMinutes,
        fetchedAt: null,
        stale: false,
        ...helpFor(null),
      }
    }
    return null
  }

  async function fetchOverview({ force = false } = {}) {
    const settings = resolveSettings()
    const credentials = resolveCredentials()
    if (!credentials) {
      const body = overviewBody()
      if (body) return body
    }
    const now = Date.now()
    if (!force && cache && now - cache.fetchedAt < settings.refreshMinutes * 60_000) {
      return overviewBody() || cache.data
    }
    if (inflight) return inflight
    const task = (async () => {
      try {
        const options = { endpoint: credentials.endpoint }
        const summary = await queryCashCoupons(credentials, options)
        let cash = null
        if (settings.includeCashNote) {
          try {
            cash = await queryAccountBalance(credentials, options)
          } catch (error) {
            cash = { error: error && error.message ? error.message : String(error) }
          }
        }
        const data = {
          ok: true,
          configured: true,
          remaining: summary.remaining,
          couponCount: summary.couponCount,
          availableCount: summary.availableCount,
          nearestExpiry: summary.nearestExpiry,
          coupons: summary.coupons,
          cash,
          ...helpFor(credentials),
        }
        cache = { fetchedAt: Date.now(), data }
        return { ...data, source: credentials.source, fetchedAt: new Date(cache.fetchedAt).toISOString(), stale: false, refreshMinutes: settings.refreshMinutes }
      } catch (error) {
        log('warn', 'queryCashCoupons failed:', error && error.code, error && error.message)
        // 失败不写入 cache 的 ok 数据；保留上次成功数据仅作为 stale 展示会更误导，直接报错。
        const data = {
          ok: false,
          configured: true,
          error: shapeError(error),
          refreshMinutes: settings.refreshMinutes,
          fetchedAt: null,
          stale: false,
        }
        cache = { fetchedAt: Date.now(), data }
        return { ...data, source: credentials.source }
      } finally {
        inflight = null
      }
    })()
    inflight = task
    return task
  }

  const routes = [
    {
      kind: 'exact',
      path: `${API_PREFIX}/overview`,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          writeJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!isLoopback(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
          return
        }
        const cached = overviewBody()
        if (cached) {
          writeJson(res, 200, cached)
          return
        }
        writeJson(res, 200, await fetchOverview())
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/refresh`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!isLoopback(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
          return
        }
        writeJson(res, 200, await fetchOverview({ force: true }))
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/config`,
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
          return
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
          const credentials = resolveCredentials()
          const settings = resolveSettings()
          writeJson(res, 200, {
            ok: true,
            configured: Boolean(credentials),
            accessKeyId: credentials ? maskAccessKeyId(credentials.accessKeyId) : '',
            hasSecret: Boolean(credentials),
            source: credentials ? credentials.source : 'none',
            refreshMinutes: settings.refreshMinutes,
            includeCashNote: settings.includeCashNote,
            endpoint: settings.endpoint,
            statePath: statePath(),
            envLocked: Boolean(envCredential()),
            ...helpFor(credentials),
          })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          writeJson(res, 400, { ok: false, error: error.message, code: error.code })
          return
        }
        const stored = readStoredConfig()
        const next = { ...stored }
        if (typeof body.accessKeyId === 'string') next.accessKeyId = body.accessKeyId.trim()
        if (typeof body.accessKeySecret === 'string' && body.accessKeySecret.trim()) {
          next.accessKeySecret = body.accessKeySecret.trim()
        }
        if (body.clear === true) {
          delete next.accessKeyId
          delete next.accessKeySecret
        }
        if (body.refreshMinutes !== undefined) next.refreshMinutes = clampRefreshMinutes(body.refreshMinutes)
        if (typeof body.includeCashNote === 'boolean') next.includeCashNote = body.includeCashNote
        if (typeof body.endpoint === 'string' && body.endpoint.trim()) next.endpoint = body.endpoint.trim()
        if (body.accessKeyId !== undefined && String(next.accessKeyId || '').length > 0) {
          if (!/^[A-Za-z0-9]{16,32}$/.test(String(next.accessKeyId))) {
            writeJson(res, 400, {
              ok: false,
              code: 'bad-access-key-id',
              error: 'AccessKeyId 格式不对：应为 16–32 位字母数字（通常以 LTAI 开头）。',
            })
            return
          }
        }
        try {
          writeStoredConfig(next)
        } catch (error) {
          writeJson(res, 500, { ok: false, code: 'write-failed', error: `写入配置失败：${error.message}` })
          return
        }
        cache = null
        inflight = null
        const credentials = resolveCredentials()
        const settings = resolveSettings()
        writeJson(res, 200, {
          ok: true,
          configured: Boolean(credentials),
          accessKeyId: credentials ? maskAccessKeyId(credentials.accessKeyId) : '',
          hasSecret: Boolean(credentials),
          source: credentials ? credentials.source : 'none',
          refreshMinutes: settings.refreshMinutes,
          includeCashNote: settings.includeCashNote,
          endpoint: settings.endpoint,
          statePath: statePath(),
          envLocked: Boolean(envCredential()),
          ...helpFor(credentials),
        })
      },
    },
  ]

  for (const route of routes) {
    const dispose = ctx.webServer.register(route)
    if (typeof dispose === 'function') disposeAll.push(dispose)
  }
  log('info', `mounted ${routes.length} routes under ${API_PREFIX}`)
}

// 保留给测试与调试：不依赖 ctx 也能算签名/汇总
export { enc, signRpcQuery, queryCashCoupons, queryAccountBalance }