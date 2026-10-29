/**
 * web 路由（DESIGN.md §6 全部 9 条）。
 *
 * 用假 `ctx` 收集注册进来的 handler，然后直接以 Node 的
 * `IncomingMessage` / `ServerResponse` 形状调用它们 —— 不起真端口，但**走真的
 * 请求分派代码**。这样测的是「路由收到这种请求会怎么答」，而不是「我 mock 的
 * 那个函数被调用了几次」。
 *
 * ## 三道闸各自为什么必须单独钉一条
 *
 * 1. **方法**：`/checkin` 只接受 POST。用 GET 打它必须 405，否则任一网页用
 *    `<img src="...">` 就能代用户签到。
 * 2. **来源**：带跨站 `Origin` 的请求必须 403。没有这道闸，任意网站都能读走
 *    用户的账号列表与积分，还能触发签到与权益领取。
 * 3. **region 解析**：`region=xx` 这种不认识的值必须 400 而不是猜成 `cn` ——
 *    猜错会让国际版账号按国内版计价去请求。
 */

import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { WbAccountPool } from '../src/accounts.ts'
import type { WbDiscoveredAccount, WbDiscoveryResult } from '../src/accounts.ts'
import { WbCatalogs } from '../src/catalog.ts'
import { WbScheduler } from '../src/scheduler.ts'
import {
  WB_ACCOUNT_CREDITS_PATH,
  WB_ACCOUNTS_REFRESH_PATH,
  WB_ACCOUNTS_SELECT_PATH,
  WB_AUTOMATION_PATH,
  WB_BENEFIT_CLAIM_PATH,
  WB_CHECKIN_PATH,
  WB_MODELS_REFRESH_PATH,
  WB_MODELS_SAVE_PATH,
  WB_STATUS_PATH,
  registerWbStatusRoutes,
} from '../src/web-status.ts'
import type { WbStatusRouteOptions } from '../src/web-status.ts'
import type { WbModelsConfig } from '../src/status-paths.ts'

const DAY = 86_400_000

/** 一个最小账号。 */
function account(id: string, overrides: Partial<WbDiscoveredAccount> = {}): WbDiscoveredAccount {
  return {
    id,
    label: id,
    region: 'cn',
    sourcePath: `/fake/${id}.info`,
    live: true,
    refreshExpired: false,
    tokenExpiresAtMs: Date.now() + 30 * DAY,
    credential: {
      accessToken: 'tok',
      refreshToken: 'ref',
      expiresAtMs: Date.now() + 30 * DAY,
      domain: '',
    },
    ...overrides,
  }
}

function baseConfig(overrides: Partial<WbModelsConfig> = {}): WbModelsConfig {
  return {
    enabled: true,
    distribution: 'expiry',
    enabledModelIds: [],
    enabledModelIdsGlobal: [],
    accountsEnabled: [],
    orderAccountIds: [],
    showCreditsInComposer: true,
    expiryWarnDays: 3,
    automation: { enabled: false, checkinHours: [9], claimBenefits: false },
    accounts: {},
    ...overrides,
  }
}

/** 收集注册进来的 handler；`dispatch` 用于在测试里发一个请求。 */
interface Harness {
  routes: Map<string, (req: IncomingMessage, res: ServerResponse) => unknown>
  dispatch(method: string, path: string, options?: {
    body?: unknown
    origin?: string
  }): Promise<{ status: number; body: any; headers: Record<string, unknown> }>
  deps: WbStatusRouteOptions
  disposers: Array<() => void>
  config: WbModelsConfig
  writes: Record<string, unknown>[]
}

function harness(options: {
  accounts?: readonly WbDiscoveredAccount[]
  config?: WbModelsConfig
  probe?: WbStatusRouteOptions['probe']
  rescan?: () => Promise<void>
  refreshModels?: (region: 'cn' | 'global') => Promise<void>
  pickOf?: WbStatusRouteOptions['pickOf']
  benefits?: readonly { kind: 'compensation' | 'gift'; active: boolean; claimed: boolean; creditNum: number }[]
} = {}): Harness {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => unknown>()
  const disposers: Array<() => void> = []
  const writes: Record<string, unknown>[] = []
  let config = options.config ?? baseConfig()

  const pool = new WbAccountPool({})
  const discovery: WbDiscoveryResult = { accounts: options.accounts ?? [], skipped: [] }
  pool.applyDiscovery(discovery)

  const catalogs = new WbCatalogs()
  const scheduler = new WbScheduler({
    pool,
    client: {
      fetchBenefits: async () => options.benefits ?? [],
      claimBenefit: async () => undefined,
      fetchCheckinStatus: async () => ({
        active: true,
        todayCheckedIn: false,
        streakDays: 0,
        dailyCredit: 10,
        todayCredit: 0,
        isStreakDay: false,
        nextStreakDay: 1,
        streakBonusDays: 7,
        streakBonusCredit: 100,
      }),
      claimDailyCheckin: async () => ({ credit: 10, streakDays: 1 }),
      fetchCredits: async () => ({ total: 0, packages: [] }),
    } as never,
    now: () => new Date('2026-03-15T09:30:00+08:00'),
  })

  const deps: WbStatusRouteOptions = {
    pool,
    catalogs,
    client: {} as never,
    scheduler,
    readConfig: () => config,
    writeConfig: async (patch) => {
      writes.push(patch)
      config = { ...config, ...patch } as WbModelsConfig
    },
    rescan: options.rescan ?? (async () => { pool.applyDiscovery(discovery) }),
    probe: options.probe ?? (async () => []),
    refreshModels: options.refreshModels ?? (async () => {}),
    pickOf: options.pickOf ?? ((region) => pool.pick(region)),
  }

  // 假 ctx：`effect` 立刻执行并收集清理函数；`webServer.register` 收下 handler。
  const ctx = {
    effect: (fn: () => unknown) => {
      const result = fn()
      if (typeof result === 'function') disposers.push(result as () => void)
    },
    webServer: {
      register: (route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }) => {
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    },
  } as never

  registerWbStatusRoutes(ctx, deps)

  async function dispatch(
    method: string,
    path: string,
    opts: { body?: unknown; origin?: string } = {},
  ): Promise<{ status: number; body: any; headers: Record<string, unknown> }> {
    // 按**路径名**查表，查询串只作为 `req.url` 传给 handler —— 与真 webServer 的
    // `kind: 'exact'` 语义一致（它匹配 pathname，不匹配整条 URL）。
    const pathname = path.split('?')[0] ?? path
    const handler = routes.get(pathname)
    if (handler === undefined) throw new Error(`route not registered: ${pathname}`)

    const req = new EventEmitter() as unknown as IncomingMessage & EventEmitter
    Object.assign(req, {
      method,
      url: path,
      headers: opts.origin === undefined ? {} : { origin: opts.origin },
    })
    // `readJsonBody` 用的是 `req.on('data')` / `req.on('end')`，所以这里必须让
    // req 自己当流：把 body 在 handler 执行之后 emit 出来。
    const bodyText = opts.body === undefined ? '' : JSON.stringify(opts.body)

    const res = new PassThrough() as unknown as ServerResponse
    let status = 0
    const headers: Record<string, unknown> = {}
    const chunks: Buffer[] = []
    Object.assign(res, {
      writeHead: (code: number, extra?: Record<string, unknown>) => {
        status = code
        if (extra !== undefined) Object.assign(headers, extra)
        return res
      },
      end: (chunk?: unknown) => {
        if (chunk !== undefined) chunks.push(Buffer.from(String(chunk)))
        return res
      },
      headersSent: false,
    })
    res.on('data', (chunk: Buffer) => chunks.push(chunk))

    // 先启动 handler（它会订阅 data/end），再把 body 灌进去 —— 顺序反过来会让
    // body 在没人监听时丢掉，`readJsonBody` 永远等不到 `end`。
    const result = handler(req, res)
    if (bodyText !== '') req.emit('data', Buffer.from(bodyText))
    req.emit('end')
    await result
    await new Promise(resolve => { setImmediate(resolve) })

    const text = Buffer.concat(chunks).toString('utf8')
    let parsed: unknown = text
    try { parsed = JSON.parse(text) } catch { /* 非 JSON 原样返回 */ }
    return { status, body: parsed, headers }
  }

  return { routes, dispatch, deps, disposers, config: config, writes }
}

describe('9 条路由全部注册', () => {
  it('DESIGN §6 列出的每一条都装上了', () => {
    const h = harness()
    expect([...h.routes.keys()].sort()).toEqual([
      WB_ACCOUNT_CREDITS_PATH,
      WB_ACCOUNTS_REFRESH_PATH,
      WB_ACCOUNTS_SELECT_PATH,
      WB_AUTOMATION_PATH,
      WB_BENEFIT_CLAIM_PATH,
      WB_CHECKIN_PATH,
      WB_MODELS_REFRESH_PATH,
      WB_MODELS_SAVE_PATH,
      WB_STATUS_PATH,
    ].sort())
  })

  it('disposer 能全部卸掉（宿主 dispose 后不该留悬挂路由）', () => {
    const h = harness()
    expect(h.routes.size).toBe(9)
    for (const dispose of h.disposers) dispose()
    expect(h.routes.size).toBe(0)
  })
})

describe('三道闸：方法 / 来源 / region', () => {
  it('POST-only 的路由收到 GET 回 405', async () => {
    const h = harness()
    for (const path of [WB_ACCOUNTS_REFRESH_PATH, WB_CHECKIN_PATH, WB_MODELS_REFRESH_PATH, WB_MODELS_SAVE_PATH]) {
      const res = await h.dispatch('GET', path)
      expect(res.status, path).toBe(405)
      expect(String(res.body.error)).toContain('method not allowed')
    }
  })

  it('GET-only 的路由收到 POST 回 405', async () => {
    const h = harness()
    const res = await h.dispatch('POST', WB_STATUS_PATH)
    expect(res.status).toBe(405)
  })

  it('跨站 Origin 一律 403（任意网页不能读走账号与积分）', async () => {
    const h = harness({ accounts: [account('a')] })
    const res = await h.dispatch('GET', WB_STATUS_PATH, { origin: 'https://evil.example.com' })
    expect(res.status).toBe(403)
    expect(String(res.body.error)).toContain('origin-not-trusted')
  })

  it('回环 Origin 放行（localhost / 127.0.0.1）', async () => {
    const h = harness({ accounts: [account('a')] })
    for (const origin of ['http://localhost:3080', 'http://127.0.0.1:3080']) {
      const res = await h.dispatch('GET', WB_STATUS_PATH, { origin })
      expect(res.status, origin).toBe(200)
    }
  })

  it('无 Origin 头放行（同源导航 / curl 本地诊断）', async () => {
    const h = harness({ accounts: [account('a')] })
    const res = await h.dispatch('GET', WB_STATUS_PATH)
    expect(res.status).toBe(200)
  })

  it('region=xx 这种不认识的值回 400，**不**猜成 cn', async () => {
    const h = harness()
    const res = await h.dispatch('GET', `${WB_STATUS_PATH}?region=xx`)
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('region')
  })

  it('region 缺省 = cn；region=global 生效', async () => {
    const h = harness()
    const cn = await h.dispatch('GET', WB_STATUS_PATH)
    expect(cn.body.region).toBe('cn')
    const global = await h.dispatch('GET', `${WB_STATUS_PATH}?region=global`)
    expect(global.body.region).toBe('global')
  })
})

describe('GET /status', () => {
  it('返回账号、跳过文件、目录、总积分与配置', async () => {
    const h = harness({ accounts: [account('a'), account('b')] })
    const res = await h.dispatch('GET', WB_STATUS_PATH)
    expect(res.status).toBe(200)
    expect(res.body.accounts).toHaveLength(2)
    expect(res.body.totalCredits).toBe(0)
    expect(Array.isArray(res.body.skipped)).toBe(true)
    expect(Array.isArray(res.body.models)).toBe(true)
    expect(res.body.config.distribution).toBe('expiry')
  })

  it('应答带 no-store（否则用户会看到上一个账号的余额）', async () => {
    const h = harness()
    const res = await h.dispatch('GET', WB_STATUS_PATH)
    expect(res.headers['Cache-Control']).toBe('no-store')
  })

  it('余额读不到的账号 total 缺省，**不是** 0', async () => {
    const h = harness({ accounts: [account('a')] })
    const res = await h.dispatch('GET', WB_STATUS_PATH)
    const row = res.body.accounts[0]
    expect(row.total).toBeUndefined()
  })

  it('总积分只统计本区域参与池的账号', async () => {
    const h = harness({
      accounts: [account('cn-1', { region: 'cn' }), account('g-1', { region: 'global' })],
    })
    // 给两个账号都记上余额，然后分别看两个区域的读数。
    h.deps.pool.noteCredits('cn-1', { total: 100, packages: [], expiringSoon: 0 })
    h.deps.pool.noteCredits('g-1', { total: 900, packages: [], expiringSoon: 0 })

    const cn = await h.dispatch('GET', `${WB_STATUS_PATH}?region=cn`)
    expect(cn.body.totalCredits).toBe(100)
    const global = await h.dispatch('GET', `${WB_STATUS_PATH}?region=global`)
    expect(global.body.totalCredits).toBe(900)
  })
})

describe('POST /accounts/refresh', () => {
  it('触发 rescan 并回新状态', async () => {
    let called = 0
    const h = harness({
      accounts: [account('a')],
      rescan: async () => { called += 1 },
    })
    const res = await h.dispatch('POST', WB_ACCOUNTS_REFRESH_PATH)
    expect(res.status).toBe(200)
    expect(called).toBe(1)
    expect(res.body.accounts).toHaveLength(1)
  })

  it('rescan 抛错回 500，错误带可操作提示', async () => {
    const h = harness({
      rescan: async () => { throw new Error('磁盘读不了') },
    })
    const res = await h.dispatch('POST', WB_ACCOUNTS_REFRESH_PATH)
    expect(res.status).toBe(500)
    expect(String(res.body.error)).toContain('rescan-failed')
    expect(String(res.body.error)).toContain('重试')
  })
})

describe('GET /account/credits', () => {
  it('缺 accountId 回 400', async () => {
    const h = harness()
    const res = await h.dispatch('GET', WB_ACCOUNT_CREDITS_PATH)
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('accountId')
  })

  it('未知账号回 404 并提示重扫', async () => {
    const h = harness()
    const res = await h.dispatch('GET', `${WB_ACCOUNT_CREDITS_PATH}?accountId=nope`)
    expect(res.status).toBe(404)
    expect(String(res.body.error)).toContain('unknown account')
  })

  it('读到余额后写回池，并回该账号的读数', async () => {
    const h = harness({
      accounts: [account('a')],
      probe: async () => [{
        accountId: 'a',
        readAtMs: Date.now(),
        credits: { total: 321, packages: [], expiringSoon: 0 },
      }],
    })
    const res = await h.dispatch('GET', `${WB_ACCOUNT_CREDITS_PATH}?accountId=a`)
    expect(res.status).toBe(200)
    // 写回池之后 /status 也能看到 —— 两个入口共用同一份读数。
    const status = await h.dispatch('GET', WB_STATUS_PATH)
    expect(status.body.totalCredits).toBe(321)
  })
})

describe('POST /checkin', () => {
  it('未知 accountId 回 404（不能把「账号不存在」显示成「今天已签过」）', async () => {
    const h = harness()
    const res = await h.dispatch('POST', `${WB_CHECKIN_PATH}?accountId=nope`)
    expect(res.status).toBe(404)
    expect(String(res.body.error)).toContain('unknown account')
  })

  it('省略 accountId = 全量签到，立即返回 running', async () => {
    const h = harness({ accounts: [account('a')] })
    const res = await h.dispatch('POST', WB_CHECKIN_PATH)
    expect(res.status).toBe(200)
    expect(res.body.running).toBe(true)
    expect(Array.isArray(res.body.detail)).toBe(true)
  })

  it('指定账号并成功签到，回实际获得的积分', async () => {
    const h = harness({ accounts: [account('a')] })
    const res = await h.dispatch('POST', `${WB_CHECKIN_PATH}?accountId=a`)
    expect(res.status).toBe(200)
    expect(res.body.credit).toBe(10)
  })
})

describe('POST /benefit/claim', () => {
  it('缺 accountId 回 400', async () => {
    const h = harness()
    const res = await h.dispatch('POST', `${WB_BENEFIT_CLAIM_PATH}?kind=gift`)
    expect(res.status).toBe(400)
  })

  it('缺 kind 或 kind 非法回 400', async () => {
    const h = harness({ accounts: [account('a')] })
    expect((await h.dispatch('POST', `${WB_BENEFIT_CLAIM_PATH}?accountId=a`)).status).toBe(400)
    expect((await h.dispatch('POST', `${WB_BENEFIT_CLAIM_PATH}?accountId=a&kind=bogus`)).status).toBe(400)
  })

  it('合法 kind 走 scheduler.claimOne', async () => {
    // 上游确实报了一个可领的补偿；否则 claimOne 会抛「没有这个权益」，那是
    // 另一条路径（见下一条）。这里把可领状态给足，验证成功路径。
    const h = harness({ accounts: [account('a')], benefits: [{ kind: 'compensation', active: true, claimed: false, creditNum: 50 }] })
    const res = await h.dispatch('POST', `${WB_BENEFIT_CLAIM_PATH}?accountId=a&kind=compensation`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.claimed).toBe(true)
  })

  it('已领取的权益不再发第二次写请求（claimable = active && !claimed）', async () => {
    const h = harness({ accounts: [account('a')], benefits: [{ kind: 'gift', active: true, claimed: true, creditNum: 20 }] })
    const res = await h.dispatch('POST', `${WB_BENEFIT_CLAIM_PATH}?accountId=a&kind=gift`)
    expect(res.status).toBe(200)
    // 上游对已领取的赠礼仍报 active:true，只看 active 会发出必然被拒的第二个请求。
    expect(res.body.claimed).toBe(false)
  })
})

describe('POST /models/refresh', () => {
  it('调用 refreshModels 并按区域回状态', async () => {
    const seen: string[] = []
    const h = harness({
      refreshModels: async (region) => { seen.push(region) },
    })
    const res = await h.dispatch('POST', `${WB_MODELS_REFRESH_PATH}?region=global`)
    expect(res.status).toBe(200)
    expect(seen).toEqual(['global'])
    expect(res.body.region).toBe('global')
  })

  it('刷新失败回 502（上游故障不是本插件的错）', async () => {
    // 502 而不是 500：上游不可达时，把状态码记成 5xx 的「本端错误」会让用户去
    // 排查插件，而他真正该做的是检查网络或稍后重试。
    const h = harness({
      refreshModels: async () => { throw new Error('上游 502') },
    })
    const res = await h.dispatch('POST', WB_MODELS_REFRESH_PATH)
    expect(res.status).toBe(502)
    expect(String(res.body.error)).toContain('models-refresh-failed')
  })
})

describe('POST /models/save', () => {
  it('保存到正确的配置键并立刻作用到目录', async () => {
    const h = harness()
    const res = await h.dispatch('POST', WB_MODELS_SAVE_PATH, {
      body: { enabledModelIds: ['a', 'b'] },
    })
    expect(res.status).toBe(200)
    expect(h.writes.at(-1)).toEqual({ enabledModelIds: ['a', 'b'] })
    expect(res.body.enabledModelIds).toEqual(['a', 'b'])
  })

  it('body 里的 region 生效 —— 国际版保存必须写进 global 的键', async () => {
    const h = harness()
    const res = await h.dispatch('POST', WB_MODELS_SAVE_PATH, {
      body: { region: 'global', enabledModelIds: ['x'] },
    })
    expect(res.status).toBe(200)
    expect(h.writes.at(-1)).toEqual({ enabledModelIdsGlobal: ['x'] })
    expect(res.body.region).toBe('global')
  })

  it('query 里的 region 优先于 body', async () => {
    const h = harness()
    const res = await h.dispatch('POST', `${WB_MODELS_SAVE_PATH}?region=cn`, {
      body: { region: 'global', enabledModelIds: ['x'] },
    })
    expect(res.body.region).toBe('cn')
    expect(h.writes.at(-1)).toEqual({ enabledModelIds: ['x'] })
  })

  it('enabledModelIds 不是字符串数组回 400', async () => {
    const h = harness()
    const res = await h.dispatch('POST', WB_MODELS_SAVE_PATH, {
      body: { enabledModelIds: 'not-an-array' },
    })
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('enabledModelIds')
  })

  it('空数组是合法的（= 全部显示），不能被当成缺省拒掉', async () => {
    const h = harness()
    const res = await h.dispatch('POST', WB_MODELS_SAVE_PATH, {
      body: { enabledModelIds: [] },
    })
    expect(res.status).toBe(200)
    expect(h.writes.at(-1)).toEqual({ enabledModelIds: [] })
  })
})

describe('POST /accounts/select', () => {
  it('缺 accountId 回 400', async () => {
    const h = harness()
    const res = await h.dispatch('POST', WB_ACCOUNTS_SELECT_PATH)
    expect(res.status).toBe(400)
  })

  it('未知账号回 404', async () => {
    const h = harness()
    const res = await h.dispatch('POST', `${WB_ACCOUNTS_SELECT_PATH}?accountId=nope`)
    expect(res.status).toBe(404)
  })

  it('区域不匹配回 409（不能让国际账号走国内 provider）', async () => {
    const h = harness({ accounts: [account('g', { region: 'global' })] })
    const res = await h.dispatch('POST', `${WB_ACCOUNTS_SELECT_PATH}?accountId=g&region=cn`)
    expect(res.status).toBe(409)
    expect(String(res.body.error)).toContain('region-mismatch')
  })

  it('选中后 preferred 生效，状态里 selected 为 true', async () => {
    const h = harness({ accounts: [account('a'), account('b')] })
    const res = await h.dispatch('POST', `${WB_ACCOUNTS_SELECT_PATH}?accountId=b`)
    expect(res.status).toBe(200)
    const selected = res.body.accounts.filter((row: { selected: boolean }) => row.selected)
    expect(selected).toHaveLength(1)
    expect(selected[0].id).toBe('b')
    // 配置也被写回：重启后仍然是这个账号。
    expect((h.writes.at(-1) as { accounts: { cn?: string } }).accounts.cn).toBe('b')
  })
})

describe('GET|POST /automation', () => {
  it('GET 只读状态，不改开关', async () => {
    const h = harness()
    const res = await h.dispatch('GET', WB_AUTOMATION_PATH)
    expect(res.status).toBe(200)
    expect(res.body.config.enabled).toBe(false)
    expect(h.writes).toHaveLength(0)
  })

  it('POST enabled=true 写回配置', async () => {
    const h = harness()
    const res = await h.dispatch('POST', WB_AUTOMATION_PATH, { body: { enabled: true } })
    expect(res.status).toBe(200)
    expect(h.writes.at(-1)).toMatchObject({ automation: { enabled: true } })
  })

  it('enabled 非布尔回 400', async () => {
    const h = harness()
    const res = await h.dispatch('POST', WB_AUTOMATION_PATH, { body: { enabled: 'yes' } })
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('enabled')
  })

  it('claimBenefits 非布尔回 400', async () => {
    const h = harness()
    const res = await h.dispatch('POST', WB_AUTOMATION_PATH, { body: { claimBenefits: 1 } })
    expect(res.status).toBe(400)
  })

  it('PUT 之类的方法回 405', async () => {
    const h = harness()
    const res = await h.dispatch('PUT', WB_AUTOMATION_PATH)
    expect(res.status).toBe(405)
  })
})

describe('错误文案不泄漏 token', () => {
  it('错误消息里的 JWT 被抹成 [redacted token]', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl'
    const h = harness({
      accounts: [account('a')],
      probe: async () => { throw new Error(`凭据失效：${jwt}`) },
    })
    const res = await h.dispatch('GET', `${WB_ACCOUNT_CREDITS_PATH}?accountId=a`)
    const text = JSON.stringify(res.body)
    expect(text).not.toContain(jwt)
    expect(text).toContain('[redacted token]')
  })
})
