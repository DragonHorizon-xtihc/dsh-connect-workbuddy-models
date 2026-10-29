/**
 * 名次与「为什么在这一位」（F4）。
 *
 * `rankReasonsOf` 早就写好了，注释也写明了它的用途（「用户改了『账户使用方式』
 * 之后，唯一能验证的设置真的生效的证据就是这张表」），但 `/status` 应答里从来没
 * 有它的位置——`buildStatus` 只把名次压成一个数字放进账号行，理由丢弃。于是
 * 设置页里「积分最先到期优先」选了跟没选一样：`expiry` 与 `priority` 在真实
 * 数据上会同时选中到期最早那个账号（本机四个 vault 账号就是这个情况），没有
 * 理由文案时用户完全看不出差别。
 *
 * ## 这个文件钉住什么
 *
 * 1. `buildStatus` 的应答里**真的有** `picks`，且与池内账号一一对应、不重不漏。
 * 2. 每个名次的 `accountId` 都能在 `accounts` 里找到（否则客户端按 id 查表会
 *    查空，理由一行静默消失——正是这次要修的故障形态）。
 * 3. `rank === 1` 的那位 `usable === true`：否则「当前在服务」的文案会盖在一个
 *    根本不能发请求的账号上。
 * 4. 未加入池的账号 `usable === false` 且 `reason` 非空——理由必须能让用户照着
 *    做（去「参与池的账号」里勾上它）。
 * 5. `expiry` 下先到期的那个账号名次更小：这是「设置生效」的直接读数。
 *
 * 用的 `/status` 分派装置与 `tests/account-source.test.ts` 同源（真路由、真池、
 * 真调度器，只替身 `client`），不 mock handler。
 */

import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { WbAccountPool } from '../src/accounts.ts'
import type { WbDiscoveredAccount, WbDiscoveryResult } from '../src/accounts.ts'
import { WbCatalogs } from '../src/catalog.ts'
import { WbScheduler } from '../src/scheduler.ts'
import { WB_STATUS_PATH, registerWbStatusRoutes } from '../src/web-status.ts'
import type { WbStatusRouteOptions } from '../src/web-status.ts'
import type { WbCredits, WbModelsConfig } from '../src/status-paths.ts'

const DAY = 86_400_000
/**
 * 「现在」必须锚在真实时钟上，不能写成固定的日历日。
 *
 * 写成 `new Date('2026-03-15…')` 那天之后，所有「十天后到期」的包都会变成
 * 「已过期」，而 `expiryFactsOf` 会按设计跳过 `at <= nowMs` 的包 —— 于是两个
 * 账号都没有到期信息，`expiry` 退化成按余额比较，这个文件里的名次断言会集体
 * 反过来（且失败信息看起来像产品坏了）。
 */
const NOW = Date.now()

function accountFixture(id: string, tokenExpiresAtMs = NOW + 30 * DAY): WbDiscoveredAccount {
  return {
    id,
    label: id,
    region: 'cn',
    sourcePath: `/fake/workbuddy-vault/cn/${id}.json`,
    source: 'dsh',
    live: false,
    refreshExpired: false,
    tokenExpiresAtMs,
    credential: {
      accessToken: 'tok',
      refreshToken: 'ref',
      expiresAtMs: tokenExpiresAtMs,
      domain: 'www.workbuddy.cn',
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
  body: any
  pool: WbAccountPool
}

/**
 * 装一遍 `/status` 路由并真分派一次 GET，返回解析后的应答。
 *
 * `credits` 走池的 `noteCredits` 而不是探针：探针是「读上游」，这里要验的是
 * 「排序与理由」这条纯本地链路。
 */
async function statusOf(options: {
  accounts: readonly WbDiscoveredAccount[]
  credits?: Readonly<Record<string, WbCredits>>
  config?: WbModelsConfig
}): Promise<Harness> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => unknown>()
  const pool = new WbAccountPool({})
  const discovery: WbDiscoveryResult = { accounts: options.accounts, skipped: [] }
  pool.applyDiscovery(discovery)
  for (const [id, credits] of Object.entries(options.credits ?? {})) pool.noteCredits(id, credits)

  const scheduler = new WbScheduler({
    pool,
    client: { fetchCredits: async () => ({ total: 0, packages: [] }) } as never,
    // 与 `nowMs` 对齐，避免两处时间源不一致导致名次在断言间漂移。
    now: () => new Date(NOW),
  })

  const config = options.config ?? baseConfig()
  // 配置必须真的进池。生产路径上 `apply()` 的 `applyConfigFromSource()` 做这件事；
  // 这里若只把配置交给 route 的 `readConfig`，池会一直用构造函数缺省（`expiry`、
  // 无 enabledIds 过滤），于是「切分布」与「未加入池」两组断言会看不出任何变化——
  // 那是夹具漏了一步，不是产品行为。
  pool.applyConfig({
    enabledIds: config.accountsEnabled ?? [],
    orderIds: config.orderAccountIds ?? [],
    distribution: config.distribution,
    expiryWarnDays: config.expiryWarnDays,
  })
  const deps: WbStatusRouteOptions = {
    pool,
    catalogs: new WbCatalogs(),
    client: {} as never,
    scheduler,
    readConfig: () => config,
    writeConfig: async () => {},
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
        return () => { routes.delete(route.path) }
      },
    },
  } as never

  registerWbStatusRoutes(ctx, deps)

  const handler = routes.get(WB_STATUS_PATH)
  if (handler === undefined) throw new Error('status route not registered')

  const req = new EventEmitter() as unknown as IncomingMessage & EventEmitter
  Object.assign(req, { method: 'GET', url: WB_STATUS_PATH, headers: {} })

  const res = new PassThrough() as unknown as ServerResponse
  const chunks: Buffer[] = []
  let status = 0
  Object.assign(res, {
    writeHead: (code: number) => { status = code; return res },
    end: (chunk?: unknown) => {
      if (chunk !== undefined) chunks.push(Buffer.from(String(chunk)))
      return res
    },
    headersSent: false,
  })
  res.on('data', (chunk: Buffer) => chunks.push(chunk))

  await handler(req, res)
  req.emit('end')
  await new Promise(resolve => { setImmediate(resolve) })

  expect(status).toBe(200)
  return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')), pool }
}

/** `expiry` 分布下两个可服务账号：A 先到期但余额少，B 晚到期但余额多。 */
function twoAccounts(): { accounts: readonly WbDiscoveredAccount[]; credits: Record<string, WbCredits> } {
  return {
    accounts: [accountFixture('A'), accountFixture('B')],
    credits: { A: oneShot(500, NOW + 10 * DAY), B: oneShot(9_000, NOW + 30 * DAY) },
  }
}

describe('排序理由（F4）', () => {
  it('应答里真的有 picks，且与池内账号一一对应', async () => {
    const { accounts, credits } = twoAccounts()
    const { body, pool } = await statusOf({ accounts, credits })

    // 改前这里恒为 undefined —— 理由写好了却没人调用，就是 F4 的故障形态。
    expect(Array.isArray(body.picks)).toBe(true)
    expect(body.picks).toHaveLength(pool.listRegion('cn').length)

    const pickIds = (body.picks as any[]).map(row => String(row.accountId)).sort()
    const accountIds = (body.accounts as any[]).map(row => String(row.account.id)).sort()
    expect(pickIds).toEqual(accountIds)
  })

  it('第 1 位可服务，且它就是下一个请求会发去的账号', async () => {
    const { accounts, credits } = twoAccounts()
    const { body, pool } = await statusOf({ accounts, credits })

    const first = (body.picks as any[])[0]
    expect(first.rank).toBe(1)
    expect(first.usable).toBe(true)
    expect(first.reason).toBeUndefined()
    // 名次第 1 与 pick() 必须指同一个人，否则「当前在服务」的文案会说谎。
    expect(String(first.accountId)).toBe(pool.pick('cn').account?.id)
  })

  it('未加入池的账号 usable=false 且理由可照做', async () => {
    const { accounts, credits } = twoAccounts()
    const { body } = await statusOf({
      accounts,
      credits,
      config: baseConfig({ accountsEnabled: ['A'] }),
    })

    const rows = body.picks as any[]
    const b = rows.find(row => String(row.accountId) === 'B')
    expect(b).toBeDefined()
    expect(b.usable).toBe(false)
    // 「为什么不能用」必须能让用户动手（去勾选），不是只说「不可用」。
    expect(String(b.reason)).toContain('未加入池')
    // 未入池的账号即使余额更多也不该排在可服务账号前面。
    expect(rows[0].accountId).toBe('A')
  })

  it('expiry 分布下先到期者名次更小（设置真的生效）', async () => {
    const { accounts, credits } = twoAccounts()
    const { body } = await statusOf({ accounts, credits })

    const rows = body.picks as any[]
    const order = rows.map(row => String(row.accountId))
    // A 十天到期、B 三十天到期 —— `expiry` 必须先 A 后 B，尽管 B 余额多 18 倍。
    expect(order).toEqual(['A', 'B'])
    expect(rows[0].nearestExpiryMs).toBeLessThan(rows[1].nearestExpiryMs)
  })

  it('切换分布会改变名次，理由跟着变（不是恒定的装饰）', async () => {
    const { accounts, credits } = twoAccounts()
    const expiry = await statusOf({ accounts, credits })
    const priority = await statusOf({
      accounts,
      credits,
      config: baseConfig({ distribution: 'priority' }),
    })

    expect((expiry.body.picks as any[]).map(row => String(row.accountId))).toEqual(['A', 'B'])
    // `priority` 选余额最大的 —— 名次表必须跟着翻，否则理由是假的。
    expect((priority.body.picks as any[]).map(row => String(row.accountId))).toEqual(['B', 'A'])
  })

  it('每个名次都是 1..n 的排列，不重不漏', async () => {
    const accounts = [accountFixture('A'), accountFixture('B'), accountFixture('C')]
    const credits = {
      A: oneShot(500, NOW + 10 * DAY),
      B: oneShot(9_000, NOW + 30 * DAY),
      C: oneShot(300, NOW + 60 * DAY),
    }
    const { body } = await statusOf({ accounts, credits })

    const ranks = (body.picks as any[]).map(row => Number(row.rank)).sort((a, b) => a - b)
    expect(ranks).toEqual([1, 2, 3])
  })
})
