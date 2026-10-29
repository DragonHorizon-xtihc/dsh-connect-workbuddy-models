/**
 * 缺陷 B 的判决性测试：`/status` 必须按 region 过滤账号数组。
 *
 * 改前 `buildStatus` 用的是 `deps.pool.list()`（全量），于是 `?region=cn` 与
 * `?region=global` 返回**逐字节相同**的账号数组：国内版列表里混进 `region:"global"`
 * 的账号，点国际版看到的还是那三个国内账号。客户端信任服务端（`WbModelsCard`
 * 直接渲染 `status.accounts`，不再二次过滤），所以根因只能在这一层修。
 *
 * ## 三条反向锁为什么与两条正断言同等重要
 *
 * 把 `list()` 无脑换成 `listRegion()` 会顺手带走另外两份数据，而它们**本来就该是
 * 全量的**：
 *
 * - `skipped` 是**发现阶段**的产物（桌面端 auth 目录里扫到多少个打不开的加密信封）。
 *   按区域过滤会把「本区域 0 个跳过」显示成没事，恰恰抹掉唯一的诊断线索——用户需要
 *   知道「这台机器上有 4 个登录态但一个都用不了」，不需要按 Tab 各看一遍。
 * - `catalogs` 一直是两个区域都给，同理。
 * - `totalCredits` 走的是 `listRegion(region)`，改前**就是对的**。它正是「一半对
 *   一半错」的那一半：账号串台而积分正确，用户更容易以为是自己看错。这条断言钉住
 *   「只改了账号数组、没动积分口径」。
 */

import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { WbAccountPool } from '../src/accounts.ts'
import type { WbDiscoveredAccount } from '../src/accounts.ts'
import { WbCatalogs } from '../src/catalog.ts'
import { WbScheduler } from '../src/scheduler.ts'
import { WB_STATUS_PATH, registerWbStatusRoutes } from '../src/web-status.ts'
import type { WbStatusRouteOptions } from '../src/web-status.ts'
import type { WbModelsConfig, WbRegion } from '../src/status-paths.ts'

const DAY = 86_400_000
const NOW = Date.now()

/** 一个最小账号；region 与 credits 由调用方决定。 */
function account(id: string, region: WbRegion, total?: number): WbDiscoveredAccount {
  return {
    id,
    label: id,
    region,
    source: 'dsh',
    sourcePath: `/fake/workbuddy-vault/${region}/${id}.json`,
    live: false,
    refreshExpired: false,
    tokenExpiresAtMs: NOW + 365 * DAY,
    credential: {
      accessToken: 'tok',
      refreshToken: 'ref',
      expiresAtMs: NOW + 365 * DAY,
      domain: region === 'global' ? 'www.workbuddy.ai' : 'www.workbuddy.cn',
    },
  }
}

/** 一次性积分包（`expiryFactsOf` 按它算到期）。 */
function oneShot(total: number, expiresAtMs: number): {
  total: number
  packages: { packageName: string; remain: number; size: number; monthly: boolean; expiresAtMs: number }[]
  expiringSoon: number
  nearestExpiryMs: number
} {
  return {
    total,
    packages: [{ packageName: 'p', remain: total, size: total, monthly: false, expiresAtMs }],
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
  status(region: WbRegion): Promise<any>
  pool: WbAccountPool
}

/**
 * 一套真路由装置：真 `WbAccountPool` + 真 `WbScheduler` + 真 `WbCatalogs`，
 * 只替身 `client`（不碰网络）。假 ctx 只收 handler，不起端口。
 */
function harness(options: {
  accounts: readonly WbDiscoveredAccount[]
  credits?: Readonly<Record<string, number>>
  skipped?: readonly { path: string; reason: 'encrypted' | 'unreadable' | 'malformed' }[]
  config?: WbModelsConfig
}): Harness {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => unknown>()
  const pool = new WbAccountPool({})
  pool.applyDiscovery({ accounts: options.accounts, skipped: options.skipped ?? [] })
  // 凭据有效期覆盖 credits 注入：`noteCredits` 只记读数，但池的排序要它。
  for (const [id, total] of Object.entries(options.credits ?? {})) {
    pool.noteCredits(id, oneShot(total, NOW + 20 * DAY))
  }

  const config = options.config ?? baseConfig()
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
    writeConfig: async () => {},
    rescan: async () => {},
    probe: async () => [],
    refreshModels: async () => {},
    pickOf: region => pool.pick(region, { nowMs: NOW }),
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

  async function status(region: WbRegion): Promise<any> {
    const handler = routes.get(WB_STATUS_PATH)
    if (handler === undefined) throw new Error('status route not registered')
    const req = new EventEmitter() as unknown as IncomingMessage & EventEmitter
    Object.assign(req, { method: 'GET', url: `${WB_STATUS_PATH}?region=${region}`, headers: {} })
    const res = new PassThrough() as unknown as ServerResponse
    let code = 0
    const chunks: Buffer[] = []
    Object.assign(res, {
      writeHead: (next: number) => { code = next; return res },
      end: (chunk?: unknown) => { if (chunk !== undefined) chunks.push(Buffer.from(String(chunk))); return res },
      headersSent: false,
    })
    res.on('data', (chunk: Buffer) => chunks.push(chunk))
    const pending = handler(req, res)
    req.emit('end')
    await pending
    await new Promise(resolve => { setImmediate(resolve) })
    expect(code).toBe(200)
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  return { status, pool }
}

/** 本机形态的 fixture：3 个国内 + 1 个国际，与国际版/国内版串台报告一致。 */
function machineLike(): Harness {
  return harness({
    accounts: [
      account('27e8f3bc23d65074', 'global'),
      account('33dc53cb024cbaed', 'cn'),
      account('51c39655c9b6a363', 'cn'),
      account('bbf8054a7c091d65', 'cn'),
    ],
    credits: {
      '27e8f3bc23d65074': 190,
      '33dc53cb024cbaed': 1312.84,
      '51c39655c9b6a363': 4266.71,
      'bbf8054a7c091d65': 8879.12,
    },
    skipped: [
      { path: '/auth/workbuddy-desktop.info', reason: 'encrypted' },
      { path: '/auth/workbuddy-desktop.2026-10-09T14-47-00-407Z.27932.info', reason: 'encrypted' },
      { path: '/auth/workbuddy-desktop.2026-09-26T16-11-11-294Z.31388.info', reason: 'encrypted' },
      { path: '/auth/workbuddy-desktop-ai.info', reason: 'encrypted' },
    ],
  })
}

describe('判决性：cn 应答里不得出现国际版账号', () => {
  it('?region=cn 的账号数组只有 cn 的 3 个，没有任何 region==="global" 条目', async () => {
    const body = await machineLike().status('cn')
    expect(body.region).toBe('cn')
    expect(body.accounts).toHaveLength(3)
    // 这条是判决性的：改前 `list()` 会把 27e8f3bc 一起端上来，长度是 4。
    expect(body.accounts.filter((row: any) => row.region === 'global')).toEqual([])
    expect(body.accounts.map((row: any) => row.account.region)).toEqual(['cn', 'cn', 'cn'])
    // 具体到那个串台账号：它在国内版列表里必须彻底消失。
    expect(body.accounts.map((row: any) => row.account.id)).not.toContain('27e8f3bc23d65074')
  })

  it('?region=global 的账号数组只有那个国际版账号', async () => {
    const body = await machineLike().status('global')
    expect(body.region).toBe('global')
    expect(body.accounts).toHaveLength(1)
    expect(body.accounts.map((row: any) => row.account.id)).toEqual(['27e8f3bc23d65074'])
    expect(body.accounts.filter((row: any) => row.account.region === 'cn')).toEqual([])
  })

  it('两个区域的账号数组必须不同（改前逐字节相同，是本缺陷的直接反证）', async () => {
    const h = machineLike()
    const cn = await h.status('cn')
    const global = await h.status('global')
    expect(cn.accounts.map((row: any) => row.account.id))
      .not.toEqual(global.accounts.map((row: any) => row.account.id))
  })
})

describe('反向锁：不该跟着过滤的三样东西必须保持全量/原口径', () => {
  it('skipped 保持全量 4 条（发现阶段产物，跨区域显示是合理的）', async () => {
    const h = machineLike()
    for (const region of ['cn', 'global'] as const) {
      const body = await h.status(region)
      expect(body.skipped, region).toHaveLength(4)
      expect(body.skipped.every((file: any) => file.reason === 'encrypted'), region).toBe(true)
    }
  })

  it('totalCredits 保持区域口径（cn=三个国内账号之和，global=190）', async () => {
    const h = machineLike()
    const cn = await h.status('cn')
    const global = await h.status('global')
    expect(cn.totalCredits).toBeCloseTo(1312.84 + 4266.71 + 8879.12, 5)
    expect(global.totalCredits).toBeCloseTo(190, 5)
  })

  it('catalogs 两个区域都给（不随 Tab 变）', async () => {
    const body = await machineLike().status('global')
    expect(Object.keys(body.catalogs).sort()).toEqual(['cn', 'global'])
  })

  it('picks 是区域口径：cn 的名次表里不含国际版账号', async () => {
    const body = await machineLike().status('cn')
    expect(Array.isArray(body.picks)).toBe(true)
    expect(body.picks.map((pick: any) => pick.accountId)).not.toContain('27e8f3bc23d65074')
  })
})
