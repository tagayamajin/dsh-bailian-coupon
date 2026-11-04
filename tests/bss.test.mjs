import assert from 'node:assert/strict'
import { enc, signRpcQuery, summarizeCoupons, normalizeCoupon } from '../lib/bss.js'

// ── 1. RFC3986 编码自测向量 ──────────────────────────────────────────────
assert.equal(enc('a b*c~d/e+='), 'a%20b%2Ac~d%2Fe%2B%3D')
assert.equal(enc('/'), '%2F')
assert.equal(enc('2017-12-14'), '2017-12-14')

// ── 2. 官方 worked example 对拍（权威向量）────────────────────────────────
// 来源：https://help.aliyun.com/zh/sdk/product-overview/rpc-mechanism
//   「签名示例代码」表：Endpoint=ecs.cn-beijing.aliyuncs.com、Action=DescribeDedicatedHosts、
//   Version=2014-05-26、Format=JSON、AccessKeyId=testid、AccessKeySecret=testsecret、
//   SignatureNonce=edb2b34af0af9a6d14deaf7c1a5315eb、Timestamp=2023-03-13T08:34:30Z、
//   RegionId=cn-beijing
//   文档给出的签名值：9NaGiOspFP5UPcwX8Iwt2YJXXuk=
const officialQuery = signRpcQuery(
  'DescribeDedicatedHosts',
  { RegionId: 'cn-beijing' },
  {
    accessKeyId: 'testid',
    accessKeySecret: 'testsecret',
    nonce: 'edb2b34af0af9a6d14deaf7c1a5315eb',
    timestamp: '2023-03-13T08:34:30Z',
  },
  { version: '2014-05-26' },
)
const [officialCanonical, officialSignaturePart] = officialQuery.split('&Signature=')
assert.equal(
  officialCanonical,
  'AccessKeyId=testid&Action=DescribeDedicatedHosts&Format=JSON&RegionId=cn-beijing&SignatureMethod=HMAC-SHA1&SignatureNonce=edb2b34af0af9a6d14deaf7c1a5315eb&SignatureVersion=1.0&Timestamp=2023-03-13T08%3A34%3A30Z&Version=2014-05-26',
)
assert.equal(decodeURIComponent(officialSignaturePart), '9NaGiOspFP5UPcwX8Iwt2YJXXuk=')

// ── 3. BSS QueryCashCoupons 的 canonical 逐字核对（字典序）──────────────
// 注意：docs/aliyun-api.md §7 里那个 dummy 示例的签名值 vWoX4yakSkMEsVjwf5Ut0ZK/KOI=
// 与它自己列出的 canonical/stringToSign 无法互推（用 testAccessKeySecret 算出来是
// C9mgkbdM5iV20YsoVY8mICtNWuo=），所以此处只断言可复现的 canonical，不断言那个签名值。
const query = signRpcQuery(
  'QueryCashCoupons',
  {},
  {
    accessKeyId: 'testAccessKeyId',
    accessKeySecret: 'testAccessKeySecret',
    nonce: '3ee8e2f7-1b0e-4b6f-9b7c-2f2d3a4b5c6d',
    timestamp: '2026-11-04T18:00:00Z',
  },
)
const canonical = query.split('&Signature=')[0]
assert.equal(
  canonical,
  'AccessKeyId=testAccessKeyId&Action=QueryCashCoupons&Format=JSON&SignatureMethod=HMAC-SHA1&SignatureNonce=3ee8e2f7-1b0e-4b6f-9b7c-2f2d3a4b5c6d&SignatureVersion=1.0&Timestamp=2026-11-04T18%3A00%3A00Z&Version=2017-12-14',
)

// ── 3. 汇总逻辑：只有 Available 的 Balance 计入剩余 ──────────────────────
const summary = summarizeCoupons({
  Success: true,
  Data: {
    CashCoupon: [
      {
        CashCouponId: '1',
        CashCouponNo: 'Q-aaa',
        NominalValue: '300.00',
        Balance: '250.50',
        Status: 'Available',
        ExpiryTime: '2027-03-31T23:59:59Z',
        ApplicableProducts: '通用',
      },
      {
        CashCouponId: '2',
        CashCouponNo: 'Q-bbb',
        NominalValue: '50.00',
        Balance: '50.00',
        Status: 'Expired',
        ExpiryTime: '2025-01-01T00:00:00Z',
      },
      {
        CashCouponId: '3',
        CashCouponNo: 'Q-ccc',
        NominalValue: '100.00',
        Balance: '100.00',
        Status: 'Available',
        ExpiryTime: '2026-06-30T23:59:59Z',
      },
    ],
  },
})
assert.equal(summary.remaining, 350.5)
assert.equal(summary.couponCount, 3)
assert.equal(summary.availableCount, 2)
assert.equal(summary.nearestExpiry, '2026-06-30T23:59:59Z')
assert.equal(summary.coupons[0].statusLabel, '可用')
assert.equal(summary.coupons[1].statusLabel, '已过期')

// 空响应（没有代金券）不能抛错
assert.deepEqual(summarizeCoupons({ Data: {} }), {
  remaining: 0,
  couponCount: 0,
  availableCount: 0,
  nearestExpiry: null,
  coupons: [],
})
assert.equal(normalizeCoupon({ Status: 'Cancelled' }).statusLabel, '已作废')

console.log('bss.test.mjs OK')