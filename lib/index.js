/**
 * dsh-balance-peek — Host half.
 *
 * Reads the DeepSeek wallet balance through DSH's own credential services and
 * publishes a single read-only JSON route. The browser half (lib/client.js)
 * renders the readout in the sidebar foot.
 *
 * Design notes
 * ------------
 * - Balance only. Spend tracking was removed in 2.0.0: measuring it correctly
 *   needs the whole day's session logs (a day usually starts before DSH does),
 *   and the number still cannot include API calls made outside DSH. The wallet
 *   the official dashboard shows is the honest figure, so that is the one this
 *   plugin reports.
 * - Everything here is deliberately defensive. A cosmetic sidebar readout must
 *   never be able to break the harness, so services are resolved through
 *   `ctx.inject` / `ctx.get`, and every failure degrades to a status string the
 *   browser can show instead of throwing out of `apply`.
 * - The peak/off-peak marker is computed in the browser (same rules, below), so
 *   its countdown ticks every second without a request. The Host still reports
 *   it so the rules have one documented home and a client can cross-check.
 */
export const name = 'dsh-balance-peek'

// ---------------------------------------------------------------------------
// Peak / off-peak windows
// ---------------------------------------------------------------------------

/** Beijing-time peak windows: Monday-Friday 09:00-12:00 and 14:00-18:00. */
const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]

/**
 * Public holidays (Beijing calendar days) billed entirely at off-peak rates.
 * Only days actually OFF work are listed: every make-up workday falls on a
 * weekend, and weekends are off-peak anyway.
 *
 * ⚠️ Append the next year once the State Council publishes the arrangement
 * (usually each November). Until then an unlisted holiday reads as an ordinary
 * peak weekday here, which is a display-only inaccuracy.
 */
const HOLIDAY_VALLEY = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07',
])

const BEIJING_OFFSET_MS = 8 * 3600 * 1000

/** Beijing calendar parts for one instant (read through UTC on a shifted clock). */
function beijingParts(ms) {
  const d = new Date(ms + BEIJING_OFFSET_MS)
  return {
    day: d.toISOString().slice(0, 10),
    hour: d.getUTCHours(),
    weekday: d.getUTCDay(), // 0 Sunday .. 6 Saturday
  }
}

/** Whether one instant falls inside a peak window. */
export function isPeak(ms = Date.now()) {
  const { day, hour, weekday } = beijingParts(ms)
  if (weekday === 0 || weekday === 6) return false
  if (HOLIDAY_VALLEY.has(day)) return false
  return PEAK_HOURS.some(([start, end]) => hour >= start && hour < end)
}

/**
 * The next instant at which peak/off-peak flips, as epoch ms.
 * Walks minute by minute within an 8-day horizon: cheap, and immune to
 * off-by-one mistakes in a hand-written window table.
 */
export function nextSwitchAt(ms = Date.now()) {
  const current = isPeak(ms)
  const start = Math.floor(ms / 60000) * 60000
  for (let t = start + 60000; t <= start + 8 * 24 * 3600 * 1000; t += 60000) {
    if (isPeak(t) !== current) return t
  }
  return null
}

// ---------------------------------------------------------------------------
// Host plugin
// ---------------------------------------------------------------------------

/** How long a fetched balance stays fresh. */
const BALANCE_TTL_MS = 25_000
/** Balance refresh cadence while a browser is watching. */
const SAMPLE_INTERVAL_MS = 60_000
/** Stop background refreshes this long after the last browser poll. */
const SAMPLE_IDLE_MS = 10 * 60_000

function isLoopbackHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  if (Number(m[1]) !== 127) return false
  return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
}

/** Send one JSON body with the headers a polled readout wants. */
function sendJson(res, body, status = 200) {
  const text = JSON.stringify(body)
  if (res.headersSent) return
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(text)),
  })
  res.end(text)
}

export default {
  name,

  /**
   * Deliberately no object-level `inject`: that would hold `apply` back until
   * every service is up. The Web carrier is awaited in its own child scope
   * instead, so a host without a Web server simply mounts nothing.
   *
   * Note the single parameter: Cordis calls `apply(ctx)` unless a `Config`
   * schema is declared, so a second argument would silently never arrive.
   */
  apply(root) {
    const state = {
      balance: null, // { amount, currency, source, at }
      balanceError: null,
      lastPoll: 0,
      refreshing: false,
    }

    // -- credential resolution ---------------------------------------------
    const accountClient = () => ({
      version: process.env.DSH_CLIENT_VERSION || '0.2.0',
      locale: 'zh-CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    })

    /** The signed-in DeepSeek account's wallet, when there is one. */
    const accountBalance = async () => {
      try {
        const account = root.get('deepseekAccount')
        if (!account || typeof account.getBalance !== 'function') return null
        const result = await account.getBalance(accountClient())
        const wallets = result?.status === 'ready' ? result.value : null
        if (!Array.isArray(wallets) || wallets.length === 0) return null
        const pick = wallets.find((w) => w?.currency === 'CNY') ?? wallets[0]
        const amount = Number(pick?.balance)
        if (!Number.isFinite(amount)) return null
        return { amount, currency: String(pick?.currency || 'CNY'), source: 'account', at: Date.now() }
      } catch {
        return null
      }
    }

    /** Wallet balance: the API key first, then the signed-in account. */
    const fetchBalance = async () => {
      let key
      try {
        key = await root.get('credentials')?.resolve('DEEPSEEK_API_KEY')
      } catch {
        key = undefined
      }

      if (key?.value !== undefined) {
        try {
          const res = await fetch('https://api.deepseek.com/user/balance', {
            headers: { Authorization: `Bearer ${key.value}` },
            signal: AbortSignal.timeout(10_000),
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = await res.json()
          const info = Array.isArray(data?.balance_infos) ? data.balance_infos[0] : null
          const amount = Number(info?.total_balance ?? data?.total_balance)
          if (!Number.isFinite(amount)) throw new Error('余额接口返回结构异常')
          return { amount, currency: String(info?.currency || 'CNY'), source: 'apikey', at: Date.now() }
        } catch (err) {
          state.balanceError = `余额接口请求失败：${String(err?.message || err).slice(0, 160)}`
        }
      }

      const account = await accountBalance()
      if (account) {
        state.balanceError = null
        return account
      }
      if (key?.value === undefined && state.balanceError === null) {
        state.balanceError = '未配置 DEEPSEEK_API_KEY，且未登录 DeepSeek 账号'
      }
      return null
    }

    /** Refresh the cached balance, honouring the TTL unless forced. */
    const ensureBalance = async (force = false) => {
      if (!force && state.balance && Date.now() - state.balance.at < BALANCE_TTL_MS) return state.balance
      const next = await fetchBalance()
      if (next) state.balance = next
      return state.balance
    }

    // -- background refresh while a browser watches -------------------------
    const tick = async () => {
      if (Date.now() - state.lastPoll > SAMPLE_IDLE_MS) {
        state.refreshing = false
        return
      }
      try {
        await ensureBalance()
      } catch {
        /* keep refreshing */
      }
      const timer = setTimeout(() => void tick(), SAMPLE_INTERVAL_MS)
      if (typeof timer.unref === 'function') timer.unref()
    }

    const snapshot = async (force) => {
      state.lastPoll = Date.now()
      if (!state.refreshing) {
        state.refreshing = true
        void tick()
      }
      try {
        await ensureBalance(force)
      } catch (err) {
        state.balanceError = String(err?.message || err).slice(0, 160)
      }
      const now = Date.now()
      return {
        ok: true,
        balance: state.balance ? state.balance.amount : null,
        currency: state.balance?.currency ?? 'CNY',
        balanceSource: state.balance?.source ?? null,
        balanceAt: state.balance?.at ?? null,
        balanceError: state.balanceError,
        period: {
          peak: isPeak(now),
          nextSwitchAt: nextSwitchAt(now),
          peakHours: PEAK_HOURS,
        },
        serverTime: now,
      }
    }

    // -- the read-only route ------------------------------------------------
    root.inject(['webServer'], (ctx) => {
      /** Same-origin + loopback fence: the wallet is the operator's, not the LAN's. */
      const rejected = (req, res) => {
        try {
          const headers = req?.headers ?? {}
          const hostUrl = new URL(`http://${String(headers.host || '')}`)
          const trusted = String(process.env.DSH_BALANCE_TRUSTED_HOSTS || '')
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
          if (!isLoopbackHostname(hostUrl.hostname) && !trusted.includes(hostUrl.host.toLowerCase())) {
            sendJson(res, { ok: false, error: 'forbidden host' }, 403)
            return true
          }
          if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
            sendJson(res, { ok: false, error: 'cross-site request' }, 403)
            return true
          }
          const origin = headers.origin
          if (typeof origin === 'string' && origin && origin !== 'null') {
            if (new URL(origin).host.toLowerCase() !== hostUrl.host.toLowerCase()) {
              sendJson(res, { ok: false, error: 'origin mismatch' }, 403)
              return true
            }
          }
          // Defer to the host fence when it exists; keep working when it does not.
          const fence = ctx.get('connection')
          if (fence && typeof fence.requestRejection === 'function') {
            const code = fence.requestRejection(req)
            if (code) {
              sendJson(res, { ok: false, error: 'untrusted request' }, code)
              return true
            }
          }
          return false
        } catch {
          sendJson(res, { ok: false, error: 'bad request' }, 403)
          return true
        }
      }

      ctx.effect(
        () =>
          ctx.webServer.register({
            kind: 'exact',
            path: '/dsh-balance/state.json',
            handler: async (req, res) => {
              if (rejected(req, res)) return
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                sendJson(res, { ok: false, error: 'method not allowed' }, 405)
                return
              }
              const force = new URL(req.url || '/', 'http://localhost').searchParams.get('refresh') === '1'
              try {
                sendJson(res, await snapshot(force))
              } catch (err) {
                sendJson(res, { ok: false, error: String(err?.message || err).slice(0, 200) })
              }
            },
          }),
        'dsh-balance-peek: state route',
      )
    })
  },
}
