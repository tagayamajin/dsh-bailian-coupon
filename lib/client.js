/**
 * dsh-bailian-coupon — browser half (served through exports["./client"]).
 *
 * 在 Web GUI 里显示阿里云百炼（通用财务）代金券余额：
 *   - sidebar.footer.action：常驻的紧凑徽标（¥ 余额），点击打开详情面板；
 *   - settings.section：插件设置页，填写 RAM AccessKey / 刷新间隔。
 *
 * 手写 CJS，无需构建工具：宿主会直接服务这个文件，由 window.__ModuleLoader__ 注册工厂。
 * 只用基线模块 react / react-dom/client（见 docs/plugin-arch.md）；数据来自宿主半边
 * 的 /api/dsh-bailian-coupon/{overview,refresh,config}。
 */
window.__ModuleLoader__.load({
  id: 'dsh-bailian-coupon',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const { createRoot } = require('react-dom/client')

    const BASE = window.location.origin + '/api/dsh-bailian-coupon'
    const OVERVIEW_URL = BASE + '/overview'
    const REFRESH_URL = BASE + '/refresh'
    const CONFIG_URL = BASE + '/config'
    const DEFAULT_REFRESH_MINUTES = 10
    const FETCH_TIMEOUT_MS = 20000

    const ZH = /^zh/i.test((typeof navigator !== 'undefined' && navigator.language) || '')

    const COPY = ZH
      ? {
          nav: '百炼代金券',
          title: '阿里云百炼代金券余额',
          loading: '查询中…',
          unconfigured: '未配置',
          failed: '查询失败',
          remaining: '剩余可用',
          couponSection: '代金券明细',
          empty: '当前没有可用的代金券。',
          emptyHint: '如果控制台里显示有券，可能是代金券之外的类型（满减券 / 折扣券 / 储值卡）。',
          faceValue: '面值',
          balance: '余额',
          expiry: '到期',
          status: '状态',
          refresh: '刷新',
          refreshing: '刷新中…',
          close: '关闭',
          settings: '设置',
          openConsole: '打开代金券控制台',
          openAk: '创建 RAM AccessKey',
          fetchedAt: '更新于',
          stale: '（缓存）',
          settingsTitle: '百炼代金券插件设置',
          akId: 'AccessKey ID',
          akSecret: 'AccessKey Secret',
          akSecretKeep: '留空表示保留已保存的 Secret',
          refreshMinutes: '自动刷新间隔（分钟）',
          includeCash: '同时读取账户现金余额（仅作附注）',
          save: '保存',
          saved: '已保存',
          saveFailed: '保存失败',
          saveAndTest: '保存并查询',
          sourceEnv: '凭据来自环境变量（会覆盖下面的设置）',
          sourceFile: '凭据来自本插件本地配置文件',
          sourceNone: '尚未配置 RAM AccessKey',
          modelKeyHint: '注意：模型 API Key（sk-… / sk-sp-…）没有查询余额的接口，这里需要 RAM 用户的 AccessKey（只读策略 AliyunBSSReadOnlyAccess 即可）。',
          needConfig: '请先填写 RAM AccessKey，然后再刷新。',
          enterKey: '在此填写 RAM AccessKey（只保存在本机插件配置里，不会上传）：',
          needBoth: 'AccessKey ID 和 AccessKey Secret 都要填写。',
          cash: '账户现金可用余额',
          network: '网络错误',
          statusLabels: { Available: '可用', Expired: '已过期', Cancelled: '已作废' },
          errors: {
            'not-configured': '尚未配置 AccessKey',
            'fix-credentials': 'AccessKeyId 无效或已删除',
            'fix-signature': 'AccessKeySecret 错误，或本机时间偏差过大',
            'fix-permission': 'RAM 用户缺少 bss:DescribeCoupons 权限',
            'rate-limited': '被阿里云限流，请稍后重试',
            network: '无法连接阿里云接口',
            'bad-response': '接口返回内容异常',
          },
        }
      : {
          nav: 'Bailian coupons',
          title: 'Alibaba Cloud Model Studio coupon balance',
          loading: 'Loading…',
          unconfigured: 'Not set up',
          failed: 'Failed',
          remaining: 'Remaining',
          couponSection: 'Coupons',
          empty: 'No available coupons right now.',
          emptyHint: 'If the console shows a coupon, it may be a different type (discount or stored-value card).',
          faceValue: 'Face value',
          balance: 'Balance',
          expiry: 'Expires',
          status: 'Status',
          refresh: 'Refresh',
          refreshing: 'Refreshing…',
          close: 'Close',
          settings: 'Settings',
          openConsole: 'Open coupon console',
          openAk: 'Create RAM AccessKey',
          fetchedAt: 'Updated',
          stale: '(cached)',
          settingsTitle: 'Bailian coupon plugin settings',
          akId: 'AccessKey ID',
          akSecret: 'AccessKey Secret',
          akSecretKeep: 'Leave empty to keep the saved secret',
          refreshMinutes: 'Auto refresh interval (minutes)',
          includeCash: 'Also read the cash balance (note only)',
          save: 'Save',
          saved: 'Saved',
          saveFailed: 'Save failed',
          saveAndTest: 'Save and query',
          sourceEnv: 'Credentials come from environment variables (they override these settings)',
          sourceFile: 'Credentials come from this plugin’s local config file',
          sourceNone: 'No RAM AccessKey configured yet',
          modelKeyHint: 'Note: model API keys (sk-… / sk-sp-…) cannot query balances; this needs a RAM user AccessKey (AliyunBSSReadOnlyAccess is enough).',
          needConfig: 'Enter a RAM AccessKey first, then refresh.',
          enterKey: 'Enter the RAM AccessKey here (stored locally, never uploaded):',
          needBoth: 'Both AccessKey ID and AccessKey Secret are required.',
          cash: 'Account cash balance',
          network: 'Network error',
          statusLabels: { Available: 'Available', Expired: 'Expired', Cancelled: 'Cancelled' },
          errors: {
            'not-configured': 'AccessKey not configured',
            'fix-credentials': 'AccessKeyId is invalid or deleted',
            'fix-signature': 'Wrong AccessKeySecret, or the system clock is far off',
            'fix-permission': 'The RAM user lacks bss:DescribeCoupons',
            'rate-limited': 'Rate limited by Alibaba Cloud, retry later',
            network: 'Cannot reach the Alibaba Cloud API',
            'bad-response': 'Unexpected API response',
          },
        }

    const THEME = {
      text: 'var(--dsw-alias-label-primary, #1f2328)',
      textDim: 'var(--dsw-alias-label-secondary, #6b7280)',
      bg: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      bgHover: 'var(--dsw-alias-bg-layer-2, #f3f4f6)',
      border: 'var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.12))',
      accent: 'var(--dsw-alias-state-info-primary, #2563eb)',
      danger: 'var(--dsw-alias-state-error-primary, #dc2626)',
      ok: 'var(--dsw-alias-state-success-primary, #15803d)',
      warn: 'var(--dsw-alias-state-warning-primary, #b45309)',
    }

    const money = (value) => {
      const n = Number(value)
      if (!Number.isFinite(n)) return '—'
      const fixed = Math.round(n * 100) / 100
      const [int, frac] = fixed.toFixed(2).split('.')
      return '¥' + int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + frac
    }

    const dateOnly = (iso) => {
      if (!iso) return '—'
      const parsed = new Date(iso)
      if (Number.isNaN(parsed.getTime())) return String(iso)
      const pad = (n) => String(n).padStart(2, '0')
      return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`
    }

    const statusLabel = (coupon) => {
      const raw = coupon && coupon.status ? String(coupon.status) : ''
      return COPY.statusLabels[raw] || (coupon && coupon.statusLabel) || raw || '—'
    }

    async function request(url, init) {
      const response = await fetch(url, {
        ...init,
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined,
        headers: { 'content-type': 'application/json', ...(init && init.headers) },
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok) {
        const message = (data && (data.error || data.message)) || `HTTP ${response.status}`
        throw new Error(typeof message === 'string' ? message : JSON.stringify(message))
      }
      if (!data) throw new Error(COPY.errors['bad-response'])
      return data
    }

    function errorText(error) {
      if (!error) return ''
      const code = error.code ? String(error.code) : ''
      return COPY.errors[code] || error.message || code || COPY.failed
    }

    // ── 数据层 ────────────────────────────────────────────────────────────
    function useCouponData() {
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const aliveRef = useRef(true)
      const timerRef = useRef(null)

      const load = useCallback(async (options = {}) => {
        setLoading(true)
        setError(null)
        try {
          const next = await request(options.force ? REFRESH_URL : OVERVIEW_URL, options.force ? { method: 'POST' } : undefined)
          if (aliveRef.current) setData(next)
        } catch (cause) {
          if (aliveRef.current) setError(cause)
        } finally {
          if (aliveRef.current) setLoading(false)
        }
      }, [])

      useEffect(() => {
        aliveRef.current = true
        load()
        return () => {
          aliveRef.current = false
        }
      }, [load])

      // 按后端返回的 refreshMinutes 轮询（默认 10 分钟），窗口重新获得焦点时也补一次
      const refreshMinutes = (data && Number.isFinite(Number(data.refreshMinutes)) && Number(data.refreshMinutes)) || DEFAULT_REFRESH_MINUTES
      useEffect(() => {
        if (timerRef.current) clearInterval(timerRef.current)
        timerRef.current = setInterval(() => load(), Math.max(60, refreshMinutes * 60) * 1000)
        const onFocus = () => load()
        window.addEventListener('focus', onFocus)
        return () => {
          if (timerRef.current) clearInterval(timerRef.current)
          window.removeEventListener('focus', onFocus)
        }
      }, [load, refreshMinutes])

      return { data, loading, error, reload: load }
    }

    function badgeText(data, loading, error) {
      if (loading && !data) return COPY.loading
      if (!data && error) return COPY.failed
      if (!data) return COPY.loading
      if (data.ok) return money(data.remaining)
      if (data.configured === false) return COPY.unconfigured
      if (data.error) return COPY.failed
      return COPY.loading
    }

    // ── 面板内联填写凭据（未配置时直接出现，免去找设置页）────────────────
    function InlineCredentials({ onSaved }) {
      const [akId, setAkId] = useState('')
      const [secret, setSecret] = useState('')
      const [busy, setBusy] = useState(false)
      const [status, setStatus] = useState(null)

      const submit = async () => {
        const nextId = akId.trim()
        const nextSecret = secret.trim()
        if (!nextId || !nextSecret) {
          setStatus({ ok: false, text: COPY.needBoth })
          return
        }
        setBusy(true)
        setStatus(null)
        try {
          await request(CONFIG_URL, {
            method: 'POST',
            body: JSON.stringify({ accessKeyId: nextId, accessKeySecret: nextSecret }),
          })
          setAkId('')
          setSecret('')
          setStatus({ ok: true, text: COPY.saved })
          if (onSaved) await onSaved()
        } catch (cause) {
          setStatus({ ok: false, text: `${COPY.saveFailed}：${errorText(cause)}` })
        } finally {
          setBusy(false)
        }
      }

      const inputStyle = {
        width: '100%',
        boxSizing: 'border-box',
        border: `1px solid ${THEME.border}`,
        borderRadius: '6px',
        background: THEME.bg,
        color: THEME.text,
        padding: '6px 9px',
        fontSize: '13px',
        fontFamily: 'inherit',
      }

      return React.createElement(
        'div',
        {
          'data-dsh-bailian-coupon': 'inline-credentials',
          style: { border: `1px solid ${THEME.border}`, borderRadius: '8px', padding: '10px 12px', margin: '8px 0', background: THEME.bgHover },
        },
        React.createElement('div', { style: { fontSize: '12px', color: THEME.textDim, marginBottom: '8px' } }, COPY.enterKey),
        React.createElement('input', {
          type: 'text',
          autoComplete: 'off',
          spellCheck: false,
          placeholder: 'AccessKey ID（LTAI…）',
          value: akId,
          onChange: (event) => setAkId(event.target.value),
          style: { ...inputStyle, marginBottom: '8px' },
        }),
        React.createElement('input', {
          type: 'password',
          autoComplete: 'new-password',
          spellCheck: false,
          placeholder: 'AccessKey Secret',
          value: secret,
          onChange: (event) => setSecret(event.target.value),
          style: { ...inputStyle, marginBottom: '10px' },
        }),
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
          React.createElement(
            'button',
            {
              type: 'button',
              disabled: busy,
              onClick: submit,
              style: { border: 'none', background: THEME.accent, color: '#ffffff', borderRadius: '6px', padding: '6px 14px', fontSize: '13px', cursor: busy ? 'default' : 'pointer' },
            },
            busy ? COPY.loading : COPY.saveAndTest,
          ),
          status
            ? React.createElement('span', { style: { fontSize: '12px', color: status.ok ? THEME.ok : THEME.danger } }, status.text)
            : null,
        ),
      )
    }

    // ── 详情面板（纯 DOM 挂载 + 独立 React root，不占用插槽）──────────────
    let panel = null

    function closePanel() {
      if (!panel) return
      const current = panel
      panel = null
      try {
        current.root.unmount()
      } catch {
        /* ignore */
      }
      document.removeEventListener('keydown', current.onKey)
      current.host.remove()
    }

    function openPanel(badge) {
      if (panel) {
        closePanel()
        return
      }
      const host = document.createElement('div')
      host.setAttribute('data-dsh-bailian-coupon', 'panel')
      host.style.position = 'fixed'
      host.style.inset = '0'
      host.style.zIndex = '2147483000'
      document.body.appendChild(host)
      const onKey = (event) => {
        if (event.key === 'Escape') closePanel()
      }
      document.addEventListener('keydown', onKey)
      const root = createRoot(host)
      root.render(React.createElement(DetailPanel, { initial: badge, onClose: closePanel }))
      panel = { host, root, onKey }
    }

    function DetailPanel({ initial, onClose }) {
      const { data, loading, error, reload } = useCouponData()
      const current = data || initial || {}
      const coupons = Array.isArray(current.coupons) ? current.coupons : []
      const available = coupons.filter((coupon) => String(coupon && coupon.status) === 'Available')
      const shown = available.length > 0 ? available : coupons
      const errorInfo = current.error || (error && { code: 'network', message: errorText(error) })
      const cash = current.cash && current.cash.availableAmount !== undefined ? current.cash : null
      const needCredentials = Boolean(
        current.configured === false ||
          (errorInfo &&
            (String(errorInfo.code) === 'not-configured' ||
              String(errorInfo.code) === 'missing-credentials' ||
              String(errorInfo.action) === 'fix-credentials')),
      )

      return React.createElement(
        'div',
        {
          style: {
            position: 'fixed',
            inset: '0',
            background: 'rgba(0, 0, 0, 0.45)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            paddingTop: '12vh',
          },
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        React.createElement(
          'div',
          {
            style: {
              width: 'min(560px, calc(100vw - 32px))',
              maxHeight: 'min(560px, 72vh)',
              overflow: 'auto',
              background: THEME.bg,
              color: THEME.text,
              border: `1px solid ${THEME.border}`,
              borderRadius: '12px',
              boxShadow: '0 18px 48px rgba(0, 0, 0, 0.24)',
              padding: '18px 20px 16px',
              fontSize: '13px',
              lineHeight: '1.55',
            },
          },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' } },
            React.createElement('div', { style: { fontWeight: 600, fontSize: '15px', flex: 1 } }, COPY.title),
            React.createElement(
              'a',
              { href: current.consoleCouponUrl || 'https://billing-cost.console.aliyun.com/coupons/coupon', target: '_blank', rel: 'noreferrer', style: { color: THEME.accent, textDecoration: 'none', fontSize: '12px' } },
              COPY.openConsole,
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                onClick: onClose,
                title: COPY.close,
                style: { marginLeft: '4px', border: 'none', background: 'transparent', color: THEME.textDim, cursor: 'pointer', fontSize: '16px', lineHeight: 1 },
              },
              '×',
            ),
          ),
          React.createElement('div', { style: { color: THEME.textDim, fontSize: '12px', marginBottom: '10px' } }, current.fetchedAt ? `${COPY.fetchedAt} ${new Date(current.fetchedAt).toLocaleString()}${current.stale ? ' ' + COPY.stale : ''}` : ''),

          current.ok
            ? React.createElement(
                'div',
                { style: { display: 'flex', alignItems: 'baseline', gap: '10px', margin: '2px 0 10px' } },
                React.createElement('div', { style: { fontSize: '28px', fontWeight: 650, letterSpacing: '0.5px' } }, money(current.remaining)),
                React.createElement('div', { style: { color: THEME.textDim, fontSize: '12px' } }, `${COPY.remaining} · ${current.availableCount || 0}/${current.couponCount || 0}`),
              )
            : null,

          errorInfo
            ? React.createElement(
                'div',
                { style: { background: THEME.bgHover, border: `1px solid ${THEME.border}`, borderRadius: '8px', padding: '10px 12px', margin: '8px 0' } },
                React.createElement('div', { style: { color: THEME.danger, fontWeight: 600, marginBottom: '2px' } }, errorText(errorInfo)),
                errorInfo.hint ? React.createElement('div', { style: { color: THEME.textDim, fontSize: '12px' } }, errorInfo.hint) : null,
                (current.configured === false || (errorInfo.code === 'not-configured' && current.accessKeyId === undefined))
                  ? React.createElement('div', { style: { color: THEME.textDim, fontSize: '12px', marginTop: '4px' } }, COPY.needConfig)
                  : null,
              )
            : null,

          needCredentials
            ? React.createElement(InlineCredentials, { onSaved: () => reload({ force: true }) })
            : null,

          cash
            ? React.createElement('div', { style: { color: THEME.textDim, fontSize: '12px', margin: '6px 0' } }, `${COPY.cash}：${money(cash.availableAmount)}${cash.currency ? ' ' + cash.currency : ''}`)
            : null,

          React.createElement('div', { style: { fontWeight: 600, margin: '12px 0 6px' } }, COPY.couponSection),
          shown.length === 0
            ? React.createElement(
                'div',
                { style: { color: THEME.textDim, fontSize: '12px' } },
                COPY.empty,
                React.createElement('div', { style: { marginTop: '2px' } }, COPY.emptyHint),
              )
            : React.createElement(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                shown.map((coupon) =>
                  React.createElement(
                    'div',
                    {
                      key: String(coupon.id || coupon.no || Math.random()),
                      style: { border: `1px solid ${THEME.border}`, borderRadius: '8px', padding: '8px 10px', display: 'flex', gap: '10px', alignItems: 'flex-start' },
                    },
                    React.createElement(
                      'div',
                      { style: { flex: 1, minWidth: 0 } },
                      React.createElement('div', { style: { fontWeight: 600 } }, money(coupon.balance)),
                      React.createElement(
                        'div',
                        { style: { color: THEME.textDim, fontSize: '12px' } },
                        `${COPY.faceValue} ${money(coupon.nominal)}` +
                          (coupon.expiryTime ? ` · ${COPY.expiry} ${dateOnly(coupon.expiryTime)}` : '') +
                          (coupon.products ? ` · ${coupon.products}` : ''),
                      ),
                      coupon.description ? React.createElement('div', { style: { color: THEME.textDim, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis' } }, coupon.description) : null,
                    ),
                    React.createElement(
                      'div',
                      { style: { fontSize: '12px', color: String(coupon.status) === 'Available' ? THEME.ok : THEME.textDim, whiteSpace: 'nowrap' } },
                      statusLabel(coupon),
                    ),
                  ),
                ),
              ),

          React.createElement(
            'div',
            { style: { display: 'flex', gap: '8px', marginTop: '14px', alignItems: 'center' } },
            React.createElement(
              'button',
              {
                type: 'button',
                disabled: loading,
                onClick: () => reload({ force: true }),
                style: { border: `1px solid ${THEME.border}`, background: THEME.bgHover, color: THEME.text, borderRadius: '6px', padding: '5px 12px', cursor: loading ? 'default' : 'pointer', fontSize: '12px' },
              },
              loading ? COPY.refreshing : COPY.refresh,
            ),
            React.createElement(
              'a',
              { href: current.consoleAkUrl || 'https://ram.console.aliyun.com/manage/ak', target: '_blank', rel: 'noreferrer', style: { color: THEME.accent, textDecoration: 'none', fontSize: '12px' } },
              COPY.openAk,
            ),
          ),
        ),
      )
    }

    // ── 侧栏徽标 ──────────────────────────────────────────────────────────
    function CouponBadge({ wide }) {
      const { data, loading, error } = useCouponData()
      const text = badgeText(data, loading, error)
      const ok = Boolean(data && data.ok)
      const failed = Boolean((data && data.error) || (error && !data))
      const color = ok ? THEME.ok : failed ? THEME.danger : THEME.textDim
      return React.createElement(
        'button',
        {
          type: 'button',
          'data-dsh-bailian-coupon': 'badge',
          title: `${COPY.title} — ${text}`,
          onClick: () => openPanel(data),
          style: {
            border: 'none',
            background: 'none',
            color,
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            width: '100%',
            padding: '5px 12px',
            cursor: 'pointer',
            fontSize: '12.5px',
            lineHeight: '1.4',
            borderRadius: '6px',
            textAlign: 'left',
            boxSizing: 'border-box',
          },
          onMouseEnter: (event) => {
            event.currentTarget.style.background = THEME.bgHover
          },
          onMouseLeave: (event) => {
            event.currentTarget.style.background = 'none'
          },
        },
        React.createElement('span', { style: { fontSize: '13px', opacity: 0.9 } }, '券'),
        React.createElement(
          'span',
          {
            style: {
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontWeight: ok ? 600 : 400,
              letterSpacing: ok ? '0.2px' : undefined,
            },
          },
          text,
        ),
        wide === false ? null : React.createElement('span', { style: { marginLeft: 'auto', fontSize: '11px', opacity: 0.55 } }, '百炼'),
      )
    }

    // ── 设置页 ────────────────────────────────────────────────────────────
    function SettingsSection() {
      const [state, setState] = useState({ loading: true, data: null, error: null })
      const [form, setForm] = useState({ accessKeyId: '', accessKeySecret: '', refreshMinutes: DEFAULT_REFRESH_MINUTES, includeCashNote: false })
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(false)

      const loadConfig = useCallback(async () => {
        try {
          const data = await request(CONFIG_URL)
          setState({ loading: false, data, error: null })
          setForm((prev) => ({
            ...prev,
            refreshMinutes: data.refreshMinutes || DEFAULT_REFRESH_MINUTES,
            includeCashNote: Boolean(data.includeCashNote),
          }))
        } catch (error) {
          setState({ loading: false, data: null, error })
        }
      }, [])

      useEffect(() => {
        loadConfig()
      }, [loadConfig])

      const save = async () => {
        setBusy(true)
        setStatus(null)
        try {
          const payload = {
            refreshMinutes: Number(form.refreshMinutes) || DEFAULT_REFRESH_MINUTES,
            includeCashNote: Boolean(form.includeCashNote),
          }
          if (form.accessKeyId.trim()) payload.accessKeyId = form.accessKeyId.trim()
          if (form.accessKeySecret.trim()) payload.accessKeySecret = form.accessKeySecret.trim()
          const data = await request(CONFIG_URL, { method: 'POST', body: JSON.stringify(payload) })
          setState({ loading: false, data, error: null })
          setForm((prev) => ({ ...prev, accessKeyId: '', accessKeySecret: '' }))
          setStatus({ ok: true, text: COPY.saved })
          try {
            await request(REFRESH_URL, { method: 'POST' })
          } catch {
            /* 查询失败已由详情面板/徽标展示 */
          }
        } catch (error) {
          setStatus({ ok: false, text: `${COPY.saveFailed}：${errorText(error)}` })
        } finally {
          setBusy(false)
        }
      }

      const config = state.data
      const sourceText = !config ? '' : config.source === 'env' ? COPY.sourceEnv : config.source === 'file' ? COPY.sourceFile : COPY.sourceNone
      const inputStyle = {
        width: '100%',
        boxSizing: 'border-box',
        border: `1px solid ${THEME.border}`,
        borderRadius: '6px',
        background: THEME.bg,
        color: THEME.text,
        padding: '6px 9px',
        fontSize: '13px',
        fontFamily: 'inherit',
      }
      const labelStyle = { display: 'block', fontSize: '12px', color: THEME.textDim, margin: '10px 0 4px' }

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '2px', maxWidth: '560px' } },
        React.createElement('div', { style: { fontWeight: 600, fontSize: '14px' } }, COPY.settingsTitle),
        React.createElement('div', { style: { fontSize: '12px', color: THEME.textDim, marginTop: '4px' } }, COPY.modelKeyHint),

        state.loading
          ? React.createElement('div', { style: { color: THEME.textDim, fontSize: '12px', marginTop: '10px' } }, COPY.loading)
          : null,
        state.error
          ? React.createElement('div', { style: { color: THEME.danger, fontSize: '12px', marginTop: '10px' } }, errorText(state.error))
          : null,

        config
          ? React.createElement(
              'div',
              { style: { fontSize: '12px', color: THEME.textDim, marginTop: '8px' } },
              sourceText,
              config.accessKeyId ? `：${config.accessKeyId}` : '',
              config.envLocked ? ` — ${COPY.sourceEnv}` : '',
            )
          : null,

        React.createElement('label', { style: labelStyle }, COPY.akId),
        React.createElement('input', {
          type: 'text',
          autoComplete: 'off',
          spellCheck: false,
          placeholder: config && config.accessKeyId ? config.accessKeyId : 'LTAI…',
          value: form.accessKeyId,
          onChange: (event) => setForm((prev) => ({ ...prev, accessKeyId: event.target.value })),
          style: inputStyle,
        }),

        React.createElement('label', { style: labelStyle }, COPY.akSecret),
        React.createElement('input', {
          type: 'password',
          autoComplete: 'new-password',
          spellCheck: false,
          placeholder: config && config.hasSecret ? COPY.akSecretKeep : '',
          value: form.accessKeySecret,
          onChange: (event) => setForm((prev) => ({ ...prev, accessKeySecret: event.target.value })),
          style: inputStyle,
        }),

        React.createElement('label', { style: labelStyle }, COPY.refreshMinutes),
        React.createElement('input', {
          type: 'number',
          min: 1,
          max: 1440,
          value: form.refreshMinutes,
          onChange: (event) => setForm((prev) => ({ ...prev, refreshMinutes: event.target.value })),
          style: { ...inputStyle, width: '120px' },
        }),

        React.createElement(
          'label',
          { style: { display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12px', color: THEME.textDim, marginTop: '12px', cursor: 'pointer' } },
          React.createElement('input', {
            type: 'checkbox',
            checked: Boolean(form.includeCashNote),
            onChange: (event) => setForm((prev) => ({ ...prev, includeCashNote: event.target.checked })),
          }),
          COPY.includeCash,
        ),

        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '14px' } },
          React.createElement(
            'button',
            {
              type: 'button',
              disabled: busy,
              onClick: save,
              style: { border: 'none', background: THEME.accent, color: '#ffffff', borderRadius: '6px', padding: '6px 14px', fontSize: '13px', cursor: busy ? 'default' : 'pointer' },
            },
            busy ? COPY.loading : COPY.saveAndTest,
          ),
          status
            ? React.createElement('span', { style: { fontSize: '12px', color: status.ok ? THEME.ok : THEME.danger } }, status.text)
            : null,
        ),

        config && config.statePath
          ? React.createElement('div', { style: { fontSize: '11px', color: THEME.textDim, marginTop: '12px', wordBreak: 'break-all' } }, config.statePath)
          : null,
      )
    }

    return {
      name: 'bailian-coupon',
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const dispose = ctx.slots.inject('sidebar.footer.action', () =>
            ctx.slots.register(
              { name: 'sidebar.footer.action', id: 'bailian-coupon', order: 40, label: COPY.nav },
              CouponBadge,
            ),
          )
          return () => {
            try {
              closePanel()
            } catch {
              /* ignore */
            }
            if (typeof dispose === 'function') dispose()
          }
        }, 'dsh-bailian-coupon: sidebar badge')

        ctx.effect(() => {
          const dispose = ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'bailian-coupon', order: 60, label: COPY.nav },
              SettingsSection,
            ),
          )
          return () => {
            if (typeof dispose === 'function') dispose()
          }
        }, 'dsh-bailian-coupon: settings section')
      },
    }
  },
})