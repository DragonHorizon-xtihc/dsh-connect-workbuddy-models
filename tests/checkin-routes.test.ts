/**
 * 签到路由的三条显式拒绝分支 + `runCheckinNow` 的 region 传参。
 *
 * 缺陷 C 的修法有两半：一半在 `scheduler.runCheckin` 入口把范围归一成
 * `CHECKIN_REGION`（`tests/checkin-region.test.ts` 锁着），另一半在
 * `src/web-status.ts` 的签到路由——整区拒绝（global→400）、跨区兜底（→409）、
 * 未知账号（→404），以及「`region` 必须真的往下传」。
 *
 * 改前这一半**一条测试都没有**，于是三件互不相同的拒绝可以互相改错而全绿：
 * 把 409 写成 400、把 `{ region, force: true }` 写成 `{ force: true }`，都只
 * 影响用户看到的文案与行为，不影响任何断言。这个文件就是补这个洞。
 *
 * ## 为什么在**新文件内**自建 harness
 *
 * `tests/routes.test.ts` 的 harness 直接 `new WbScheduler(...)`，没有注入口。
 * 本文件第 4 条要的正是「用 spy 换掉调度器、看它收到什么实参」，而往别人的
 * harness 里加注入点要改那个已通过的文件。所以这里只复制它的**请求分派形状**
 * （假 req 当流、假 res 收 writeHead/end），不复制它的依赖装配。
 *
 * ## 判据为什么必须带特征子串
 *
 * 三个分支都是 `400/409/404`，只断言「不是 200」等于什么都没锁：`checkin-unsupported-region`
 * 与 `account-region-mismatch` 是两种完全不同的原因（产品裁定 vs 参数用错），
 * 用户该做的事也不同（换区域 / 换账号）。所以每条都断言具体状态码 + 文案子串。
 */

import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { WbAccountPool } from '../src/accounts.ts'
import type { WbDiscoveredAccount } from '../src/accounts.ts'
import { WbCatalogs } from '../src/catalog.ts'
import type { WbScheduler } from '../src/scheduler.ts'
import { WB_CHECKIN_PATH } from '../src/status-paths.ts'
import type { WbModelsConfig, WbRegion } from '../src/status-paths.ts'
import { registerWbStatusRoutes } from '../src/web-status.ts'
import type { WbStatusRouteOptions } from '../src/web-status.ts'

const DAY = 86_400_000

/** 最小账号；`id` 取本机真实值，失败信息能直接和真机读数对上。 */
function account(id: string, region: WbRegion): WbDiscoveredAccount {
  return {
    id,
    label: id,
    region,
    sourcePath: `/fake/${id}.json`,
    live: false,
    refreshExpired: false,
    tokenExpiresAtMs: Date.now() + 30 * DAY,
    credential: {
      accessToken: `tok-${region}`,
      refreshToken: `ref-${region}`,
      expiresAtMs: Date.now() + 30 * DAY,
      domain: region === 'global' ? 'www.workbuddy.ai' : 'www.workbuddy.cn',
    },
  }
}

const CN_ID = '51c39655c9b6a363'
const GLOBAL_ID = '27e8f3bc23d65074'

function baseConfig(): WbModelsConfig {
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
  }
}

/** `runCheckinNow` 收到的实参原样留档——第 4 条的判据就是它。 */
interface RunCheckinNowArgs {
  region?: WbRegion
  force?: boolean
}

/**
 * 只实现签到路由真正会碰的三个方法的 spy 调度器。
 *
 * 不用 `vi.fn()` 起整个 `WbScheduler`：`runCheckinNow` 的**实参形状**是判据本身，
 * 而 `vi.fn()` 的 `mock.calls` 会把它埋在一层数组里；这里显式 `args.push({...})`
 * 让断言能写成「等于 `{ region: 'cn', force: true }`」这一句人话。
 */
function spyScheduler(options: { enabled?: boolean } = {}) {
  const calls = {
    runCheckinNow: [] as RunCheckinNowArgs[],
    checkinOne: [] as string[],
  }
  const scheduler = {
    isEnabled: () => options.enabled ?? false,
    async runCheckinNow(args: RunCheckinNowArgs = {}) {
      calls.runCheckinNow.push({ ...args })
      return {}
    },
    async checkinOne(accountId: string) {
      calls.checkinOne.push(accountId)
      return {
        gain: { credit: 10, checkinCredit: 10 },
        detail: [`${accountId}：签到成功 +10 积分`],
      }
    },
  }
  return { scheduler: scheduler as unknown as WbScheduler, calls }
}

interface Harness {
  dispatch(
    method: string,
    path: string,
    options?: { origin?: string },
  ): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, unknown> }>
  calls: ReturnType<typeof spyScheduler>['calls']
}

/**
 * 装配一条真签到路由 + 一个 3 cn / 1 global 的池。
 *
 * 区域混装是刻意的：跨区分支只有在池里同时存在两种区域时才可达。
 */
function harness(): Harness {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => unknown>()
  const pool = new WbAccountPool({})
  pool.applyDiscovery({
    accounts: [
      account('33dc53cb024cbaed', 'cn'),
      account(CN_ID, 'cn'),
      account('bbf8054a7c091d65', 'cn'),
      account(GLOBAL_ID, 'global'),
    ],
    skipped: [],
  })

  const { scheduler, calls } = spyScheduler()

  const deps: WbStatusRouteOptions = {
    pool,
    catalogs: new WbCatalogs(),
    client: {} as never,
    scheduler,
    readConfig: () => baseConfig(),
    writeConfig: async () => {},
    rescan: async () => {},
    probe: async () => [],
    refreshModels: async () => {},
    pickOf: (region) => pool.pick(region),
  }

  const ctx = {
    effect: (fn: () => unknown) => { fn() },
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
    options: { origin?: string } = {},
  ): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, unknown> }> {
    // 与真 webServer 的 `kind: 'exact'` 一致：按 pathname 查表，查询串只进 `req.url`。
    const pathname = path.split('?')[0] ?? path
    const handler = routes.get(pathname)
    if (handler === undefined) throw new Error(`route not registered: ${pathname}`)

    const req = new EventEmitter() as unknown as IncomingMessage & EventEmitter
    Object.assign(req, {
      method,
      url: path,
      headers: options.origin === undefined ? {} : { origin: options.origin },
    })

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

    // 先启动 handler 再灌流：反了会让 `readJsonBody` 等不到 `end`。
    const result = handler(req, res)
    req.emit('end')
    await result
    await new Promise(resolve => { setImmediate(resolve) })

    const text = Buffer.concat(chunks).toString('utf8')
    let parsed: Record<string, unknown> = {}
    try { parsed = JSON.parse(text) as Record<string, unknown> } catch { parsed = { raw: text } }
    return { status, body: parsed, headers }
  }

  return { dispatch, calls }
}

describe('签到路由：整区拒绝（global）', () => {
  it('region=global 回 400 且文案点名 checkin-unsupported-region', async () => {
    const h = harness()
    const res = await h.dispatch('POST', `${WB_CHECKIN_PATH}?region=global`)
    // 必须是 400 而不是 200：静默成功会让卡片显示「今天已签过」，用户以为积分到账。
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('checkin-unsupported-region')
  })

  it('整区拒绝发生在任何调度器调用之前（不替国际版账号尝试）', async () => {
    const h = harness()
    await h.dispatch('POST', `${WB_CHECKIN_PATH}?region=global`)
    // 这两条看似与上一条重复，但锁的是不同东西：上一条锁「回了什么」，
    // 这条锁「**没有**去做那件事」。后者才是产品裁定的实质。
    expect(h.calls.runCheckinNow).toEqual([])
    expect(h.calls.checkinOne).toEqual([])
  })
})

describe('签到路由：跨区兜底（cn 路由 + 国际版账号）', () => {
  it('点名一个 global 账号回 409 且文案点名 account-region-mismatch', async () => {
    const h = harness()
    const res = await h.dispatch('POST', `${WB_CHECKIN_PATH}?region=cn&accountId=${GLOBAL_ID}`)
    expect(res.status).toBe(409)
    expect(String(res.body.error)).toContain('account-region-mismatch')
  })

  it('跨区拒绝同样不落到 checkinOne（不拿国际版凭据去打国内签到端点）', async () => {
    const h = harness()
    await h.dispatch('POST', `${WB_CHECKIN_PATH}?region=cn&accountId=${GLOBAL_ID}`)
    expect(h.calls.checkinOne).toEqual([])
  })
})

describe('签到路由：未知账号', () => {
  it('accountId 不存在回 404（不能显示成「今天已签过」）', async () => {
    const h = harness()
    const res = await h.dispatch('POST', `${WB_CHECKIN_PATH}?region=cn&accountId=nope`)
    expect(res.status).toBe(404)
    expect(String(res.body.error)).toContain('unknown account')
  })

  it('404 与 409 是两个不同的码：同一个 cn 路由下，不存在的账号 404、别的区域的账号 409', async () => {
    const h = harness()
    const missing = await h.dispatch('POST', `${WB_CHECKIN_PATH}?region=cn&accountId=nope`)
    const mismatched = await h.dispatch('POST', `${WB_CHECKIN_PATH}?region=cn&accountId=${GLOBAL_ID}`)
    // 写成「都是 4xx」这种断言时，两个分支互换也照绿；这里显式要求不同。
    expect(missing.status).toBe(404)
    expect(mismatched.status).toBe(409)
    expect(missing.status).not.toBe(mismatched.status)
  })
})

describe('签到路由：region 必须真的往下传（判决性）', () => {
  it('全量签到走到 runCheckinNow 时实参恰为 { region: "cn", force: true }', async () => {
    const h = harness()
    const res = await h.dispatch('POST', `${WB_CHECKIN_PATH}?region=cn`)
    expect(res.status).toBe(200)
    // `toEqual` 是深比较：少一个 `region` 键、或 `force` 不是 `true`，这条都红。
    // 改坏了会怎样：`runCheckinNow({ force: true })` → scheduler 入口的归一虽然
    // 仍把范围收在 cn，但「路由到底把哪个区域交下去」这件事就再也无人验证，
    // 而这条路由将来支持别的区域时，漏传会让「全部账号」重新变成全池。
    expect(h.calls.runCheckinNow).toEqual([{ region: 'cn', force: true }])
  })
})

describe('签到路由：正向对照（拒绝分支不是把所有请求都拒了）', () => {
  it('点名一个 cn 账号回 200 且 checkinOne 收到该 id', async () => {
    const h = harness()
    const res = await h.dispatch('POST', `${WB_CHECKIN_PATH}?region=cn&accountId=${CN_ID}`)
    expect(res.status).toBe(200)
    expect(res.body.credit).toBe(10)
    expect(h.calls.checkinOne).toEqual([CN_ID])
  })

  it('region=xx 这种非法值回 400，但文案是 invalid region 而不是 checkin-unsupported-region', async () => {
    const h = harness()
    const res = await h.dispatch('POST', `${WB_CHECKIN_PATH}?region=xx`)
    // 两个 400 的来源不同（三道闸的 region 解析 vs 整区产品裁定），文案必须能分开：
    // 用户看到「国际版不提供签到」但实际是自己参数写错，就会去改不该改的东西。
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('invalid region')
    expect(String(res.body.error)).not.toContain('checkin-unsupported-region')
  })
})

/**
 * 缺省路径：**不传** `?region=` 时落到 `cn`。
 *
 * 上面 9 条锁的全是「显式传值」的情形（`?region=global` / `?region=cn` /
 * `?region=xx` / `?region=cn&accountId=…`）。而缺陷 C 的形态恰恰是「`undefined`
 * 被设计成全池」——若哪天有人为了兼容老调用方，把 `regionOfRequest` 的缺省语义
 * 改掉、或让 `runCheckin` 重新把 `undefined` 当成「全部区域」，上面 9 条**一条都
 * 不会红**：它们发的请求里 `region` 从来不是空的。
 *
 * 所以这一组刻意发**光秃秃的** `${WB_CHECKIN_PATH}`，一个查询参数都不带。写成
 * `?region=cn` 就完全失去意义——那只是把第 272 行那条用例重抄一遍。
 */
describe('签到路由：不传 region 时落到 cn（缺省路径，非显式传值）', () => {
  it('不带任何查询参数 → 200，且 runCheckinNow 实参恰为 { region: "cn", force: true }', async () => {
    const h = harness()
    // 注意这里没有 `?region=`。这不是笔误，也不是「省略了 ?region=cn」——
    // 它在 URL 层是另一个请求，正是缺陷 C 的回归入口。
    const res = await h.dispatch('POST', WB_CHECKIN_PATH)
    expect(res.status).toBe(200)
    // 深比较整元组：改成 `runCheckinNow({ force: true })`（丢掉 region）或
    // `runCheckinNow({ region: undefined, force: true })`（显式传 undefined）
    // 都会红，而前者正是缺陷 C 的形态。
    expect(h.calls.runCheckinNow).toEqual([{ region: 'cn', force: true }])
  })

  it('不传 region 走的是全量路径，checkinOne 一次都没被调用', async () => {
    const h = harness()
    await h.dispatch('POST', WB_CHECKIN_PATH)
    // 不传 accountId 就不该进单账号分支。这条与上一条锁的是两件事：上一条锁
    // 「交给调度器的区域是什么」，这条锁「根本没走单账号那条路」——
    // 若有人把缺省路径错接到 `checkinOne`（比如把 `accountId === undefined`
    // 的判断写反），上一条仍然绿（`runCheckinNow` 压根不会被调用，断言的是
    // 空数组 vs 期望数组……所以这条必须独立存在）。
    expect(h.calls.checkinOne).toEqual([])
  })

  it('池里同时有 cn 与 global 账号时，缺省路径交给调度器的区域仍只有 cn', async () => {
    const h = harness()
    await h.dispatch('POST', WB_CHECKIN_PATH)
    // 这条是「正向对照」：harness 的池是 3 cn + 1 global（见 `harness()` 的
    // `applyDiscovery`），因此 `{ region: 'cn' }` 不是「唯一可能的答案」——
    // 若缺省被改成全池，这里收到的会是 `undefined` 或 `'global'`。
    const regions = h.calls.runCheckinNow.map(args => args.region)
    expect(regions).toEqual(['cn'])
    // 反向确认这个池确实混装了两种区域，否则上一条是空断言。
    expect(regions).not.toContain('global')
  })
})

describe('签到路由：缺省 200 与整区 400 并存（两条相反断言的判决性）', () => {
  it('同一个文件里：不传 region → 200，region=global → 400，两个码必须不同', async () => {
    // 两条相反的结果放在一条用例里，是为了让「缺省语义被改成全池」与
    // 「global 被放行」两种回归至少有一个会红——但它们断言的是**具体的**
    // 200 与 **具体的** 400，不是「非 2xx 即过」这种和稀泥写法：
    // 若有人把缺省改成全池，noRegion 仍是 200（这条不红），但上面那组
    // `toEqual([{ region: 'cn', force: true }])` 会红；
    // 若有人给 global 放行，globalRegion 会变 200，这条立刻红。
    const h = harness()
    const noRegion = await h.dispatch('POST', WB_CHECKIN_PATH)
    const globalRegion = await h.dispatch('POST', `${WB_CHECKIN_PATH}?region=global`)
    expect(noRegion.status).toBe(200)
    expect(globalRegion.status).toBe(400)
    expect(noRegion.status).not.toBe(globalRegion.status)
  })
})
