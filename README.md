# dsh-bailian-coupon

在 DeepSeek Harness（DSH）侧边栏常驻显示**阿里云百炼优惠券（代金券）剩余余额**的插件。

- 侧边栏底部徽标：`券 ¥xxx.xx`，约 10 分钟自动刷新，点击打开详情面板。
- 详情面板：剩余总额、可用/全部张数、每张券的面值/余额/到期时间/状态、控制台链接。
- 设置页：填写 RAM AccessKey ID / Secret、刷新间隔，支持"保存并查询"。
- 面板内也能直接填：未配置时点开徽标，面板里出现 `AccessKey ID` / `AccessKey Secret` 两个输入框。

> 插件市场分类：**集成与连接** · English: Show Alibaba Cloud Bailian (Model Studio) cash-coupon balance in the DSH sidebar.

## 它是怎么工作的

模型 API Key（`sk-...` / `sk-sp-...`）**没有**查询余额的接口，控制台之外的唯一官方途径是
[BSS OpenAPI](https://help.aliyun.com/zh/user-center/developer-reference/api-bssopenapi-2017-12-14-querycashcoupons)
的 `QueryCashCoupons`（Version `2017-12-14`，RPC 风格，HMAC-SHA1 签名）：

```
GET https://business.aliyuncs.com/?Action=QueryCashCoupons&Version=2017-12-14&...
```

返回的 `Data.CashCoupon[]` 里 `Balance` 是该券剩余金额，`NominalValue` 是面值；
插件只把 `Status === "Available"` 的券计入"剩余可用"，并按 `nearestExpiry` 找出最近到期时间。

因为 BSS 需要 **RAM AccessKey**（不是模型 Key），所以首次使用要在插件设置里填一把**只读**的
RAM 用户 AK/SK，或改用环境变量（优先级更高）：

```powershell
$env:ALIBABA_CLOUD_ACCESS_KEY_ID = "LTAI..."
$env:ALIBABA_CLOUD_ACCESS_KEY_SECRET = "..."
```

### 最小权限

给该 RAM 用户附加只读策略 **`AliyunBSSReadOnlyAccess`**，或自定义策略：

```json
{
  "Version": "1",
  "Statement": [
    { "Effect": "Allow", "Action": ["bss:DescribeCoupons"], "Resource": "*" }
  ]
}
```

（设置里的"包含现金余额"开关会额外调用 `QueryAccountBalance`，需要 `bss:DescribeAcccount`；
不开也能正常看券余额。）

## 安装

### 方式一：从插件市场 / GitHub 安装（推荐）

```powershell
# 当前（尚未发布 npm 包）：直接从 GitHub 仓库安装
dsh plugin --profile web add github:tagayamajin/dsh-bailian-coupon

# NPM 包 dsh-bailian-coupon 发布后，可简写为：
# dsh plugin --profile web add dsh-bailian-coupon
```

装好后**重启 DSH**（宿主只在启动时扫描插件）。侧栏 Settings 上方出现 `券 未配置` 徽标，
点开徽标 → 在面板里直接填 RAM AccessKey ID / Secret → **保存并查询**；也可以在
**设置 → 插件 → 百炼优惠券** 里填。首次查询成功后徽标变成 `券 ¥300.00`（示例）。

### 方式二：从本地源码 link 安装（本地开发）

> 桌面版 profile 由桌面应用独占，命令行 `dsh plugin --profile desktop add` 会被拒绝，
> 必须从 GUI 安装。

1. 打开 DSH → **设置 → 插件市场 → 本地安装 / 从路径安装**，选择本仓库目录
   （link 安装即可，改代码后重启生效）。
2. **重启 DSH Desktop**（宿主只在启动时扫描插件）。
3. 同上：填 AK/SK → 保存并查询。

## 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `accessKeyId` | — | RAM AccessKey ID，形如 `LTAI...` |
| `accessKeySecret` | — | RAM AccessKey Secret（保存后只显示掩码；留空保存表示不修改） |
| `refreshMinutes` | `10` | 自动刷新间隔，1–1440 分钟 |
| `includeCashNote` | `false` | 是否附带查询现金余额 `QueryAccountBalance`（仅作附注） |
| `endpoint` | `business.aliyuncs.com` | BSS 端点，一般不用改 |

凭据保存在插件目录的 `.state/config.json`（权限 0600，不提交、不打印）；环境变量存在时以环境变量为准，
设置页会显示 `envLocked` 提示。

## HTTP 接口（本机回环，非回环返回 403）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET/HEAD` | `/api/dsh-bailian-coupon/overview` | 当前余额（TTL 缓存，正常 10 分钟内不重复请求） |
| `POST` | `/api/dsh-bailian-coupon/refresh` | 强制刷新 |
| `GET/HEAD` | `/api/dsh-bailian-coupon/config` | 配置状态（AK 已掩码） |
| `POST` | `/api/dsh-bailian-coupon/config` | 保存配置（`{accessKeyId, accessKeySecret, refreshMinutes, includeCashNote, endpoint}`，`{clear:true}` 清空凭据） |

所有响应带 `cache-control: no-store`，不含 Secret。

## 为什么模型 Key 不行

百炼的模型 API Key 只用于推理调用，阿里云没有开放「按模型 Key 查余额/券」的接口；
`QueryCashCoupons` 属于账号级 BSS 服务，必须用 RAM AK/SK 签名。插件不会读取 DSH 里保存的模型密钥。

## 测试

```powershell
& "C:\Users\w\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" tests\bss.test.mjs
& "...\node.exe" tests\routes.test.mjs
```

- `tests\bss.test.mjs`：签名算法（含官方示例对拍）、券汇总逻辑。
- `tests\routes.test.mjs`：stub 宿主上下文 + 本地 HTTP 端到端，覆盖无凭据/方法守卫/配置掩码与落盘/
  stub BSS 的刷新与缓存/错误映射。

## 故障排查

| 症状 | 处理 |
| --- | --- |
| `InvalidAccessKeyId` | AK ID 填错或已删除，重新生成（[AK 管理](https://ram.console.aliyun.com/manage/ak)） |
| `SignatureDoesNotMatch` | Secret 填错，或本机时间偏差过大（签名有效期 31 分钟） |
| `NotAuthorized`/`NoPermission` | RAM 用户缺 `bss:DescribeCoupons`，附加 `AliyunBSSReadOnlyAccess` |
| `Throttling` | 被限流，调大 `refreshMinutes` |
| 余额 `¥0.00` 且列表为空 | 该券可能不是代金券（储值卡等不在此接口），去[优惠券控制台](https://billing-cost.console.aliyun.com/coupons/coupon)筛选「代金券」确认 |
| 徽标一直是「未配置」 | 环境变量 / 设置页都没读到凭据；保存后点一次「保存并查询」 |

## 目录结构

```
package.json          # dsh.bundle.patch + dsh.client 声明
cordis.patch.yml      # 宿主侧插入点
lib/bss.js            # BSS 签名与查询（node:crypto + fetch，零依赖）
lib/index.js          # 宿主插件：4 条 /api/dsh-bailian-coupon/* 路由 + 配置持久化
lib/client.js         # 客户端 bundle（手写 CJS，仅依赖 react / react-dom/client）
tests/*.test.mjs      # 离线测试
```

## 隐私与权限

- 插件只做一件事：用你填的 RAM AccessKey 调阿里云 BSS `QueryCashCoupons`（可选附带 `QueryAccountBalance`）。
- 凭据只保存在本机插件目录 `.state/config.json`（权限 0600，已 gitignore），**不上传、不打印**；HTTP 接口返回的 Secret 一律掩码。
- 不读取 DSH 里保存的模型 API Key，不向任何第三方发送数据。
- 建议单独建一个只读 RAM 用户（附加 `AliyunBSSReadOnlyAccess`）专供本插件使用。

## 许可证

MIT © 2026 dsh-bailian-coupon contributors。见 [LICENSE](./LICENSE)。