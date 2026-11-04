/**
 * 阿里云 BSS OpenAPI（通用财务 OpenAPI）最小客户端。
 *
 * 只用 Node 内置模块：node:crypto + global fetch。
 * 没有第三方依赖 —— 本文件可独立被测试（tests/bss.test.mjs）。
 *
 * 依据：https://help.aliyun.com/zh/user-center/developer-reference/api-bssopenapi-2017-12-14-querycashcoupons
 *       https://help.aliyun.com/zh/sdk/product-overview/rpc-mechanism（RPC 签名 V1）
 *
 * 关键事实：
 *   - 模型 API Key（sk-… / sk-sp-…）无法查询余额/代金券，必须用 RAM AccessKey。
 *   - QueryCashCoupons 返回 Data.CashCoupon[]，其中 Balance 就是「剩余金额」。
 */

import crypto from 'node:crypto'

export const BSS_VERSION = '2017-12-14'
export const DEFAULT_ENDPOINT = 'business.aliyuncs.com'
export const CONSOLE_COUPON_URL = 'https://billing-cost.console.aliyun.com/coupons/coupon'
export const CONSOLE_AK_URL = 'https://ram.console.aliyun.com/manage/ak'
export const CONSOLE_BILLING_OVERVIEW_URL = 'https://bailian.console.aliyun.com/cn-beijing/costing-balance/overview'

/** RFC 3986 编码（阿里云签名要求：保留 A-Za-z0-9 与 - _ . ~）。 */
export function enc(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
}

function timestampUtc(date = new Date()) {
  // yyyy-MM-ddTHH:mm:ssZ，不带毫秒
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * 计算 RPC V1 签名并返回完整的 query string（含 Signature）。
 * 所有参数按 key 字典序排序；canonical 再次编码后拼进 stringToSign。
 *
 * @param {string} action        例如 'QueryCashCoupons'
 * @param {Record<string, unknown>} params  业务参数
 * @param {{accessKeyId: string, accessKeySecret: string, nonce?: string, timestamp?: string}} creds
 * @param {{version?: string, format?: string}} [options] 仅用于测试对拍官方示例
 * @returns {string} 形如 `Action=...&Signature=...`（已 URL 编码，可直接拼在 ? 之后）
 */
export function signRpcQuery(action, params, creds, options = {}) {
  const p = {
    Format: options.format || 'JSON',
    Version: options.version || BSS_VERSION,
    AccessKeyId: creds.accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: creds.nonce || crypto.randomUUID(),
    Timestamp: creds.timestamp || timestampUtc(),
    Action: action,
  }
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue
    p[key] = String(value)
  }

  const canonical = Object.keys(p)
    .sort()
    .map((key) => `${enc(key)}=${enc(p[key])}`)
    .join('&')
  const stringToSign = `GET&${enc('/')}&${enc(canonical)}`
  const signature = crypto
    .createHmac('sha1', `${creds.accessKeySecret}&`)
    .update(stringToSign, 'utf8')
    .digest('base64')
  return `${canonical}&Signature=${enc(signature)}`
}

/**
 * 宿主环境里 global fetch 被 @deepseek-ai/dsh-http-proxy 换过 dispatcher，
 * 自动解压可能失效，会拿回 gzip 原始字节，因此必须显式要求 identity。
 */
export function withIdentityEncoding(init = {}) {
  const headers = new Headers(init.headers || {})
  headers.set('accept-encoding', 'identity')
  return { ...init, headers }
}

/**
 * 调用一个 BSS RPC 接口，返回解析后的 JSON。
 * @returns {Promise<Record<string, any>>}
 */
export async function callBss(action, params, creds, options = {}) {
  const endpoint = options.endpoint || DEFAULT_ENDPOINT
  const timeoutMs = options.timeoutMs || 15_000
  const query = signRpcQuery(action, params, creds, options)
  const url = `https://${endpoint}/?${query}`
  let response
  try {
    response = await fetch(
      url,
      withIdentityEncoding({
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json' },
      }),
    )
  } catch (error) {
    const wrapped = new Error(`无法连接阿里云 BSS（${endpoint}）：${error && error.message ? error.message : error}`)
    wrapped.code = 'network'
    throw wrapped
  }
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    const error = new Error(`BSS 返回了非 JSON 响应（HTTP ${response.status}）`)
    error.code = 'bad-response'
    error.detail = text.slice(0, 300)
    throw error
  }
  if (!response.ok) {
    const error = new Error(json.Message || `BSS HTTP ${response.status}`)
    error.code = json.Code || 'http-error'
    error.status = response.status
    error.detail = json
    throw error
  }
  if (json.Success === false) {
    const error = new Error(json.Message || `BSS 调用失败：${action}`)
    error.code = json.Code || 'bss-error'
    error.detail = json
    throw error
  }
  return json
}

function toNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 把 QueryCashCoupons 的一条记录归一化成插件内部结构。 */
export function normalizeCoupon(raw) {
  return {
    id: raw.CashCouponId || '',
    no: raw.CashCouponNo || '',
    nominal: toNumber(raw.NominalValue),
    balance: toNumber(raw.Balance),
    status: raw.Status || '',
    statusLabel: couponStatusLabel(raw.Status),
    effectiveTime: raw.EffectiveTime || null,
    grantedTime: raw.GrantedTime || null,
    expiryTime: raw.ExpiryTime || null,
    products: raw.ApplicableProducts || '',
    scenarios: raw.ApplicableScenarios || '',
    description: raw.Description || '',
  }
}

export function couponStatusLabel(status) {
  switch (status) {
    case 'Available':
      return '可用'
    case 'Expired':
      return '已过期'
    case 'Cancelled':
      return '已作废'
    default:
      return status || '未知'
  }
}

/**
 * 汇总 QueryCashCoupons 的响应：只累加 Status === 'Available' 的 Balance。
 */
export function summarizeCoupons(payload) {
  const list = Array.isArray(payload?.Data?.CashCoupon) ? payload.Data.CashCoupon : []
  const coupons = list.map(normalizeCoupon)
  const available = coupons.filter((coupon) => coupon.status === 'Available')
  const remaining = available.reduce((sum, coupon) => sum + coupon.balance, 0)
  const expiries = available
    .map((coupon) => coupon.expiryTime)
    .filter(Boolean)
    .sort()
  return {
    remaining: Math.round(remaining * 100) / 100,
    couponCount: coupons.length,
    availableCount: available.length,
    nearestExpiry: expiries.length > 0 ? expiries[0] : null,
    coupons,
  }
}

/** QueryCashCoupons 的具体调用。 */
export async function queryCashCoupons(creds, options = {}) {
  const payload = await callBss('QueryCashCoupons', {}, creds, options)
  return summarizeCoupons(payload)
}

/** QueryAccountBalance（现金余额，仅作附注；需要 bss:DescribeAcccount 权限）。 */
export async function queryAccountBalance(creds, options = {}) {
  const payload = await callBss('QueryAccountBalance', {}, creds, options)
  const data = payload?.Data || {}
  return {
    availableAmount: toNumber(data.AvailableAmount),
    cashAmount: toNumber(data.AvailableCashAmount),
    creditAmount: toNumber(data.CreditAmount),
    currency: data.Currency || 'CNY',
  }
}