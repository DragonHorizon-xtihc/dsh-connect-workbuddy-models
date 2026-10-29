/**
 * 「交还给账户使用方式」必须真的可用（F11）。
 *
 * ## 缺陷形态
 *
 * 用户在输入框下方的读数面板里点过任意账号之后，同一区域的五种 distribution
 * （expiry / priority / round-robin / balanced / sticky）**全部变成空操作**，
 * 而且没有任何办法撤销。三个环节缺一不成缺陷：
 *
 * 1. `pick()` 里 preferred 的短路位于 `switch (distribution)` **之前**
 *    （`src/accounts.ts`）。这段本身是刻意设计——用户显式选号是一个明确指令，
 *    不该被当成一次采样——所以缺陷不在它，也不需要动它。
 * 2. 唯一能清除的 HTTP 面被自己的归一化堵死：`/accounts/select` 用 `accountIdOf`
 *    取参，而它走 `queryParamOf`，那里把空串归一化成 `undefined`。于是那句
 *    「传空字符串表示交还给账户使用方式」的错误文案必然命中，`?accountId=&region=cn`
 *    返回 400——**承诺的能力被上一层否决**。
 * 3. 客户端只发了「切到某个账号」，从没发过清除请求；而 `withAccountId` /
 *    `withAccountAndRegion` 在 `accountId === ''` 时会把参数整个丢掉，即使有人
 *    想发空串，拼出来的也是 `?region=cn`（参数没传），后端仍回 400。
 *
 * ## 这个文件钉住什么
 *
 * 1. 空串 → **200**（改前必然 400，这是判决性断言），且 config 里写成空串、
 *    池的 preferred 被清掉。
 * 2. 不传参数 → 仍 400（两种语义必须分得开，否则「清除」和「忘传」混为一谈）。
 * 3. 清除之后五种 distribution 各自恢复自己的选号结果：`expiry` 与 `priority`
 *    选出不同账号、`round-robin` 连续两次不同号。
 * 4. 未知 id → 404、跨区 → 409（回归锁：改这条路由不得顺手弄丢既有判定）。
 * 5. `rawQueryParamOf` 与 `queryParamOf` 的口径差异被显式断言，防止后人
 *    「顺手统一」又把缺陷带回来。
 *
 * 用的分派装置与 `tests/rank-reasons.test.ts` 同源（真路由、真池、真调度器，
 * 只替身 `client`），不 mock handler。
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
  WB_ACCOUNTS_SELECT_PATH,
  WB_STATUS_PATH,
  queryParamOf,
  rawQueryParamOf,
  withAccountAndRegion,
  withAccountCleared,
} from '../src/status-paths.ts'
import type { WbCredits, WbModelsConfig, WbRegion } from '../src/status-paths.ts'
import { registerWbStatusRoutes } from '../src/web-status.ts'
import type { WbStatusRouteOptions } from '../src/web-status.ts'

const DAY = 86_400_000
/**
 * 「现在」锚在真实时钟上，不写成固定日历日。写成某个日期之后，所有「十天后
 * 到期」的包都会变成已过期，`expiryFactsOf` 会按设计跳过它们，`expiry` 退化成
 * 按余额比较——于是本文件里「expiry 与 priority 选出不同账号」那条会以
 * 「两者相同」失败，看起来像分布没生效，其实是夹具过期了。
 */
const NOW = Date.now()

function accountFixture(id: string, region: WbRegion = 'cn'): WbDiscoveredAccount {
  return {
    id,
    label: id,
    region,
    sourcePath: `/fake/workbuddy-vault/${region}/${id}.json`,
    source: 'dsh',
    live: false,
    refreshExpired: false,
    tokenExpiresAtMs: NOW + 30 * DAY,
    credential: {
      accessToken: 'tok',
      refreshToken: 'ref',
      expiresAtMs: NOW + 30 * DAY,
      domain: region === 'cn' ? 'www.workbuddy.cn' : 'www.workbuddy.ai',
    },
  }
}

/** 一次性积分包（会过期，`expiry` 分布靠它排名次）。 */
function oneShot(total: number, expiresAtMs: number): WbCredits {
  return {
    total,
    packages: [{ packageName: 'one-shot', remain: total, size: total, monthly: false, expiresAtMs }],
    expiringSoon: 0,
    nearestExpiryMs: expiresAtMs,
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

interface Harness {
  /** 发一次真请求，返回 HTTP 码与 JSON 回执。 */
  dispatch: (path: string, method: 'GET' | 'POST') => Promise<{ status: number; json: any }>
  pool: WbAccountPool
  /** 写进 settings 的补丁（按调用顺序）。 */
  writes: Record<string, unknown>[]
  /** 宿主那份活配置；`writeConfig` 会把补丁合并进来，回执里看到的就是它。 */
  config: WbModelsConfig
}

/**
 * 装一遍 `/status` 全套路由，返回可用的分派器。
 *
 * 池的 `applyConfig` 必须真的调用：生产路径上由 `apply()` 的
 * `applyConfigFromSource()` 做，这里若只把配置交给 route 的 `readConfig`，
 * 池会一直用构造函数缺省（`expiry`、无 enabledIds 过滤），于是「切分布」那几条
 * 断言看不出任何变化——那是夹具漏了一步，不是产品行为。
 */
function harness(options: {
  accounts: readonly WbDiscoveredAccount[]
  credits?: Readonly<Record<string, WbCredits>>
  config?: WbModelsConfig
}): Harness {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => unknown>()
  const writes: Record<string, unknown>[] = []
  const config = options.config ?? baseConfig()

  const pool = new WbAccountPool({})
  const discovery: WbDiscoveryResult = { accounts: options.accounts, skipped: [] }
  pool.applyDiscovery(discovery)
  for (const [id, credits] of Object.entries(options.credits ?? {})) pool.noteCredits(id, credits)
  pool.applyConfig({
    enabledIds: config.accountsEnabled ?? [],
    orderIds: config.orderAccountIds ?? [],
    distribution: config.distribution,
    expiryWarnDays: config.expiryWarnDays,
  })

  const scheduler = new WbScheduler({
    pool,
    client: { fetchCredits: async () => ({ total: 0, packages: [] }) } as never,
    now: () => new Date(NOW),
  })

  const deps: WbStatusRouteOptions = {
    pool,
    catalogs: new WbCatalogs(),
    client: {} as never,
    scheduler,
    readConfig: () => config,
    writeConfig: async (patch) => {
      writes.push(patch)
      // 宿主的真实行为：写完活配置就读到新值。不模拟这一半，回执里的 `config`
      // 会一直是 apply 时的初值，与「写路由坏了」无法区分。
      Object.assign(config, patch)
      const accounts = patch['accounts']
      if (typeof accounts === 'object' && accounts !== null) {
        const region = 'cn'
        const selected = (accounts as Record<string, string>)[region]
        pool.setPreferred(region, selected === undefined || selected === '' ? undefined : selected)
      }
    },
    rescan: async () => {},
    probe: async () => [],
    refreshModels: async () => {},
    pickOf: region => pool.pick(region),
  }

  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    webServer: {
      register: (route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }) => {
        routes.set(route.path, route.handler)
        // `/status` 之外的路由用完整 path 注册，这里统一按 path 存，分派时取
        // `path.split('?')[0]`。
        return () => { routes.delete(route.path) }
      },
    },
  } as never

  registerWbStatusRoutes(ctx, deps)

  const dispatch = async (path: string, method: 'GET' | 'POST'): Promise<{ status: number; json: any }> => {
    const handler = routes.get(path.split('?')[0] ?? path)
    if (handler === undefined) throw new Error(`路由 ${path} 没有注册`)
    const req = new EventEmitter() as unknown as IncomingMessage & EventEmitter
    Object.assign(req, {
      method,
      url: path,
      // guard 第一关就是本机来源；loopbackOrigin 缺省放行，但显式给一个更像真实请求。
      headers: { origin: 'http://127.0.0.1:3080', 'content-type': 'application/json' },
    })
    const chunks: Buffer[] = []
    let status = 0
    const res = new PassThrough() as unknown as ServerResponse & PassThrough
    Object.assign(res, {
      writeHead: (code: number) => { status = code; return res },
      end: (chunk?: unknown) => {
        if (chunk !== undefined) chunks.push(Buffer.from(String(chunk)))
        return res
      },
      headersSent: false,
    })
    res.on('data', (chunk: Buffer) => chunks.push(chunk))
    const pending = Promise.resolve(handler(req, res))
    // POST 路由会读 body；这里没有 body，但要给 readJsonBody 一个 end 让它结算。
    req.emit('end')
    await pending
    await new Promise(resolve => { setImmediate(resolve) })
    const text = Buffer.concat(chunks).toString('utf8')
    return { status, json: text === '' ? {} : JSON.parse(text) }
  }

  return { dispatch, pool, writes, config }
}

/** 两个可服务账号：A 先到期但余额少，B 晚到期但余额多。 */
function twoAccounts(): { accounts: readonly WbDiscoveredAccount[]; credits: Record<string, WbCredits> } {
  return {
    accounts: [accountFixture('A'), accountFixture('B')],
    credits: { A: oneShot(500, NOW + 10 * DAY), B: oneShot(9_000, NOW + 30 * DAY) },
  }
}

describe('交还给账户使用方式（F11）', () => {
  it('空串 → 200，config 写成空串，池里的 preferred 被清掉', async () => {
    const { accounts, credits } = twoAccounts()
    const { dispatch, pool } = harness({ accounts, credits })

    // 先真的手动选一次，否则「清掉」这件事没有可观测的起点。
    const selected = await dispatch(`${WB_ACCOUNTS_SELECT_PATH}?accountId=B&region=cn`, 'POST')
    expect(selected.status).toBe(200)
    expect(pool.preferredOf('cn')).toBe('B')

    const cleared = await dispatch(`${WB_ACCOUNTS_SELECT_PATH}?accountId=&region=cn`, 'POST')
    // 改前这里是 400：`accountIdOf` 把空串归一化成 undefined，400 分支必然命中。
    expect(cleared.status).toBe(200)
    const config = cleared.json['config'] as { accounts?: Record<string, string> } | undefined
    expect(config?.accounts?.['cn']).toBe('')
    expect(pool.preferredOf('cn')).toBeUndefined()
  })

  it('参数根本没传 → 仍是 400（「忘传」与「显式交还」必须分得开）', async () => {
    const { accounts, credits } = twoAccounts()
    const { dispatch } = harness({ accounts, credits })

    const missing = await dispatch(`${WB_ACCOUNTS_SELECT_PATH}?region=cn`, 'POST')
    expect(missing.status).toBe(400)
    expect(String(missing.json['error'])).toContain('accountId')
  })

  it('清除之后 expiry 与 priority 各自选出自己的账号（改前两者都跟着 preferred 走）', async () => {
    const { accounts, credits } = twoAccounts()
    const { dispatch, pool } = harness({ accounts, credits })

    // 手动选 B（余额最大那个）：之后无论分布是什么都会选 B。
    const selected = await dispatch(`${WB_ACCOUNTS_SELECT_PATH}?accountId=B&region=cn`, 'POST')
    expect(selected.status).toBe(200)
    expect(pool.pick('cn').account?.id).toBe('B')
    pool.applyConfig({ distribution: 'expiry' })
    expect(pool.pick('cn').account?.id).toBe('B')
    pool.applyConfig({ distribution: 'priority' })
    expect(pool.pick('cn').account?.id).toBe('B')

    const cleared = await dispatch(`${WB_ACCOUNTS_SELECT_PATH}?accountId=&region=cn`, 'POST')
    expect(cleared.status).toBe(200)

    // 交还之后：A 的积分包 10 天后到期（最先到期），B 余额更多。
    pool.applyConfig({ distribution: 'expiry' })
    expect(pool.pick('cn').account?.id).toBe('A')
    pool.applyConfig({ distribution: 'priority' })
    expect(pool.pick('cn').account?.id).toBe('B')
    // 两者必须是不同账号，否则这条断言对「preferred 是否还在」不敏感。
    pool.applyConfig({ distribution: 'expiry' })
    const byExpiry = pool.pick('cn').account?.id
    pool.applyConfig({ distribution: 'priority' })
    const byPriority = pool.pick('cn').account?.id
    expect(byExpiry).not.toBe(byPriority)
  })

  it('清除之后 round-robin 连续两次选中不同账号', async () => {
    const { accounts, credits } = twoAccounts()
    const { dispatch, pool } = harness({ accounts, credits })

    const selected = await dispatch(`${WB_ACCOUNTS_SELECT_PATH}?accountId=B&region=cn`, 'POST')
    expect(selected.status).toBe(200)
    pool.applyConfig({ distribution: 'round-robin' })
    // preferred 还在时游标永远轮不到——两次都是 B。
    expect(pool.pick('cn').account?.id).toBe('B')
    expect(pool.pick('cn').account?.id).toBe('B')

    const cleared = await dispatch(`${WB_ACCOUNTS_SELECT_PATH}?accountId=&region=cn`, 'POST')
    expect(cleared.status).toBe(200)

    pool.applyConfig({ distribution: 'round-robin' })
    const first = pool.pick('cn').account?.id
    const second = pool.pick('cn').account?.id
    expect(first).not.toBe(second)
  })

  it('未知账号 404、跨区域 409（回归锁）', async () => {
    const { accounts, credits } = twoAccounts()
    const globalAccount = accountFixture('G', 'global')
    const { dispatch } = harness({ accounts: [...accounts, globalAccount], credits })

    const unknown = await dispatch(`${WB_ACCOUNTS_SELECT_PATH}?accountId=nope&region=cn`, 'POST')
    expect(unknown.status).toBe(404)
    expect(String(unknown.json['error'])).toContain('unknown account')

    const crossRegion = await dispatch(`${WB_ACCOUNTS_SELECT_PATH}?accountId=G&region=cn`, 'POST')
    expect(crossRegion.status).toBe(409)
    expect(String(crossRegion.json['error'])).toContain('account-region-mismatch')
  })

  it('清除请求真的带着空 accountId 参数出去（不是被 URL 拼装丢掉）', async () => {
    // `withAccountId` / `withAccountAndRegion` 在 `accountId === ''` 时会把参数整个
    // 丢掉，拼出 `?region=cn`——后端无法与「参数没传」区分，只能回 400。所以清除
    // 必须走 `withAccountCleared`。这条断言同时钉住客户端用的拼装函数。
    expect(withAccountAndRegion(WB_ACCOUNTS_SELECT_PATH, '', 'cn')).toBe(`${WB_ACCOUNTS_SELECT_PATH}?region=cn`)
    expect(withAccountCleared(WB_ACCOUNTS_SELECT_PATH, 'cn')).toBe(`${WB_ACCOUNTS_SELECT_PATH}?accountId=&region=cn`)
  })

  it('rawQueryParamOf 保留空串，queryParamOf 归一成 undefined（两个口径不能合并）', () => {
    const url = '/accounts/select?accountId=&region=cn'
    // 保空串的那一个给写路由用：空串是一条指令。
    expect(rawQueryParamOf(url, 'accountId')).toBe('')
    // 归一化的那一个给只读路由用：空串等于「没筛这个维度」。
    expect(queryParamOf(url, 'accountId')).toBeUndefined()
    // 参数真的没传时两者一致。
    expect(rawQueryParamOf('/x?region=cn', 'accountId')).toBeUndefined()
    expect(queryParamOf('/x?region=cn', 'accountId')).toBeUndefined()
  })

  it('清空之后 /status 的 selected 又回到分布选出的那个账号', async () => {
    const { accounts, credits } = twoAccounts()
    const { dispatch } = harness({ accounts, credits })

    await dispatch(`${WB_ACCOUNTS_SELECT_PATH}?accountId=B&region=cn`, 'POST')
    const selected = await dispatch(WB_STATUS_PATH, 'GET')
    const before = (selected.json['accounts'] as { id: string; selected: boolean }[]).find(row => row.selected)
    expect(before?.id).toBe('B')

    await dispatch(`${WB_ACCOUNTS_SELECT_PATH}?accountId=&region=cn`, 'POST')
    const after = await dispatch(WB_STATUS_PATH, 'GET')
    const rows = after.json['accounts'] as { id: string; selected: boolean }[]
    // 交还之后没有任何账号是「当前选用」——选择权在分布手里，而分布是按请求
    // 逐个决定的，界面上没有哪个账号可以自称当前。
    expect(rows.every(row => !row.selected)).toBe(true)
  })
})
