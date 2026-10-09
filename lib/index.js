/**
 * dsh-balance-peek — Host half.
 *
 * Reads the DeepSeek wallet balance through DSH's own credential services,
 * accumulates today's spend from real per-step usage events, and publishes a
 * single read-only JSON route. The browser half (lib/client.js) renders the
 * two-line readout in the sidebar foot.
 *
 * Design notes
 * ------------
 * - Everything here is deliberately defensive. A cosmetic sidebar readout must
 *   never be able to break the harness, so services are resolved through
 *   `ctx.inject` / `ctx.get`, and every failure degrades to a status string the
 *   browser can show instead of throwing out of `apply`.
 * - Today's spend is measured from `session/event` usage, never from balance
 *   deltas: the balance endpoint sits behind a cache and can lag by minutes, so
 *   a delta-based number would be both late and wrong.
 * - All pricing is CNY per million tokens, off-peak first, peak second, as
 *   published on https://api-docs.deepseek.com/zh-cn/quick_start/pricing/.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-balance-peek'

// ---------------------------------------------------------------------------
// Pricing and the peak / off-peak windows
// ---------------------------------------------------------------------------

/**
 * [off-peak, peak] unit prices per million tokens, in CNY. Peak = 2x off-peak.
 * Source: official pricing table (deepseek-flash 0.02/1/4, deepseek-v4-pro
 * 0.15/4.5/13.5 off-peak).
 */
const PRICING = {
  'deepseek-flash': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  // Legacy names are served by DeepSeek-V4.1-Flash and billed at Flash prices.
  'deepseek-v4-flash': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  'deepseek-v4-flash-vision-exp': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  'deepseek-v4-pro': { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] },
  _default: { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
}

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
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(), // 0 Sunday .. 6 Saturday
  }
}

/** Beijing calendar day key (`YYYY-MM-DD`). */
export function beijingDay(ms = Date.now()) {
  return beijingParts(ms).day
}

/** The official price row for a model name. */
export function priceFor(model) {
  const m = String(model || '').toLowerCase()
  for (const key of Object.keys(PRICING)) {
    if (key === '_default') continue
    if (m.includes(key)) return PRICING[key]
  }
  return PRICING._default
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

/** Cost in CNY for one step's usage. */
export function costOf(model, usage, atMs = Date.now()) {
  const p = priceFor(model)
  const idx = isPeak(atMs) ? 1 : 0
  const cache = Number(usage?.cacheReadTokens) || 0
  const input = Number(usage?.inputTokens) || 0
  const output = Number(usage?.outputTokens) || 0 // DSH already folds reasoning tokens in
  return (cache / 1e6) * p.hit[idx] + (input / 1e6) * p.miss[idx] + (output / 1e6) * p.out[idx]
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/**
 * Durable per-day totals plus the last observed wallet balance.
 * Shape: `{ version, days: { 'YYYY-MM-DD': { cost, tokens, steps, topUps } },
 * lastBalance, updatedAt }`
 */
function createLedger(file) {
  const empty = () => ({ version: 1, days: {}, lastBalance: null, updatedAt: null })
  let data = empty()
  let flushTimer = null

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object') {
      data = { ...empty(), ...parsed }
    }
  } catch {
    /* absent or unreadable: start empty rather than refuse to run */
  }

  const prune = () => {
    const cutoff = beijingDay(Date.now() - 400 * 24 * 3600 * 1000)
    for (const day of Object.keys(data.days)) {
      if (day < cutoff) delete data.days[day]
    }
  }

  const flush = () => {
    flushTimer = null
    try {
      prune()
      data.updatedAt = new Date().toISOString()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp-${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8')
      fs.renameSync(tmp, file)
    } catch {
      /* a read-only home must not stop the readout from working in memory */
    }
  }

  return {
    /** Deferred write: usage events arrive in bursts, so coalesce them. */
    schedule() {
      if (flushTimer !== null) return
      flushTimer = setTimeout(flush, 2000)
      if (typeof flushTimer.unref === 'function') flushTimer.unref()
    },
    flushNow: flush,
    day(day = beijingDay()) {
      const row = data.days[day]
      return row ? { ...row } : { cost: 0, tokens: 0, steps: 0, topUps: 0 }
    },
    addStep(day, cost, tokens) {
      const row = data.days[day] ?? { cost: 0, tokens: 0, steps: 0, topUps: 0 }
      row.cost += cost
      row.tokens += tokens
      row.steps += 1
      data.days[day] = row
      this.schedule()
    },
    addTopUp(day) {
      const row = data.days[day] ?? { cost: 0, tokens: 0, steps: 0, topUps: 0 }
      row.topUps += 1
      data.days[day] = row
      this.schedule()
    },
    get lastBalance() {
      return data.lastBalance
    },
    set lastBalance(value) {
      data.lastBalance = value
      this.schedule()
    },
    snapshot() {
      return { days: { ...data.days }, lastBalance: data.lastBalance }
    },
  }
}

// ---------------------------------------------------------------------------
// Host plugin
// ---------------------------------------------------------------------------

/** How long a fetched balance stays fresh. */
const BALANCE_TTL_MS = 25_000
/** Balance sampling cadence while a browser is watching. */
const SAMPLE_INTERVAL_MS = 60_000
/** Stop background sampling this long after the last browser poll. */
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
   * every service is up. The two dependencies are awaited in their own child
   * scopes instead, so a host without a Web server simply mounts nothing.
   */
  apply(root) {
    const ledgerFile = path.join(
      process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
      'dsh-balance-peek',
      'ledger.json',
    )
    const ledger = createLedger(ledgerFile)
    root.effect(() => () => ledger.flushNow())

    const state = {
      balance: null, // { amount, currency, source, at }
      balanceError: null,
      lastPoll: 0,
      sampling: false,
    }

    // -- today's spend, measured from real usage events ---------------------
    root.inject(['sessions'], (ctx) => {
      ctx.effect(
        () =>
          ctx.on('session/event', (_session, event) => {
            try {
              if (!event || event.type !== 'assistant/message') return
              const usage = event.data?.usage
              if (!usage || typeof usage !== 'object') return
              const model = event.data?.message?.source?.model
              const tokens =
                (Number(usage.inputTokens) || 0) +
                (Number(usage.cacheReadTokens) || 0) +
                (Number(usage.outputTokens) || 0)
              const cost = costOf(model, usage)
              if (!(cost > 0)) return
              ledger.addStep(beijingDay(), cost, tokens)
            } catch {
              /* a malformed event must never escape into the session log path */
            }
          }),
        'dsh-balance-peek: usage ledger',
      )
    })

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
      if (!next) return state.balance
      // A wallet that grew is a top-up, not negative spend.
      if (state.balance && next.amount - state.balance.amount > 0.01) ledger.addTopUp(beijingDay())
      state.balance = next
      ledger.lastBalance = next.amount
      return next
    }

    // -- background sampling while a browser watches ------------------------
    const tick = async () => {
      if (Date.now() - state.lastPoll > SAMPLE_IDLE_MS) {
        state.sampling = false
        return
      }
      try {
        await ensureBalance()
      } catch {
        /* keep sampling */
      }
      const timer = setTimeout(() => void tick(), SAMPLE_INTERVAL_MS)
      if (typeof timer.unref === 'function') timer.unref()
    }

    const snapshot = async (force) => {
      state.lastPoll = Date.now()
      if (!state.sampling) {
        state.sampling = true
        void tick()
      }
      try {
        await ensureBalance(force)
      } catch (err) {
        state.balanceError = String(err?.message || err).slice(0, 160)
      }
      const now = Date.now()
      const today = ledger.day(beijingDay(now))
      return {
        ok: true,
        balance: state.balance ? state.balance.amount : null,
        currency: state.balance?.currency ?? 'CNY',
        balanceSource: state.balance?.source ?? null,
        balanceAt: state.balance?.at ?? null,
        balanceError: state.balanceError,
        today: { cost: today.cost, tokens: today.tokens, steps: today.steps, topUps: today.topUps },
        period: {
          peak: isPeak(now),
          nextSwitchAt: nextSwitchAt(now),
          peakHours: PEAK_HOURS,
        },
        ledger: ledger.snapshot(),
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
