/**
 * 用户的临期提醒阈值（`expiryWarnDays`）是否真的贯通到三个判定点（F2 / F3 / F4）。
 *
 * ## 为什么这个文件存在
 *
 * `expiryWarnDays` 是设置页上的一个数字，但它必须同时决定三件互不相干的事：
 *
 * 1. **排序层**（`rankAccounts` 的第 5 个实参）——「谁排第一」；
 * 2. **请求路径的余额聚合**（`shim.ts` 的 `refreshBalance`）——聊天后写回池里的
 *    `expiringSoon`；
 * 3. **客户端读数的标红判据**（`ComposerCredits` 的 `warnDays`）——「还有 N 天」是否报警。
 *
 * 三处曾经各自写死 `DEFAULT_EXPIRY_WARN_DAYS`（3），于是「用户设 30 天」与「设 3 天」
 * 的**可观测结果完全相同**。这条缺陷不会让任何现有测试变红：所有既有断言都用默认
 * 3 天窗口的 fixture，两种设置下结果一致，测试当然通过。
 *
 * ## 判决性 fixture
 *
 * ```
 * A = now + 10 天到期，余额 500
 * B = now + 30 天到期，余额 9000
 * ```
 *
 * 两者都在 3 天窗口外，所以 `warnDays=3` 时都不 atRisk。把窗口改成 15 天后：
 * A 变 atRisk（10 ≤ 15）、B 仍不是（30 > 15）。这组数据能同时证明「窗口被读到了」
 * 与「窗口没有被无条件放大」。
 *
 * 修好前的缺陷形态是：`warnDays=3` 与 `warnDays=15` 给出**逐字节相同**的输出
 * （都 atRisk=0）。所以本文件每一条「两个窗口结果必须不同」的断言，都是那条缺陷的
 * 直接回归锁。
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXPIRY_WARN_DAYS,
  EXPIRY_WARN_DAYS_MAX,
  EXPIRY_WARN_DAYS_MIN,
  DAY_MS,
  rankAccounts,
  pickRankedAccount,
  type AccountDistribution,
  type WbCredits,
  type WbRankMember,
  type WbStatusSnapshot,
} from '../src/status-paths.ts'
import { WbAccountPool } from '../src/accounts.ts'
import type { WbDiscoveredAccount } from '../src/accounts.ts'
import { WbCatalog } from '../src/catalog.ts'
import { createWbShim } from '../src/shim.ts'
import { warnDaysOf } from '../src/client/ComposerCredits.tsx'

const NOW = 1_700_000_000_000

/** 一个最小账号（`tokenExpiresAtMs` 远在未来，凭据不会被判死）。 */
function account(id: string): WbDiscoveredAccount {
  return {
    id,
    label: id,
    region: 'cn',
    sourcePath: `/fake/${id}.info`,
    live: true,
    refreshExpired: false,
    tokenExpiresAtMs: NOW + 365 * DAY_MS,
    credential: { accessToken: 'tok', refreshToken: 'ref', expiresAtMs: NOW + 365 * DAY_MS, domain: '' },
  }
}

/** 一次性积分包：会过期，`expiringSoon` 留 0 让排序层自己按窗口推算。 */
function oneShot(total: number, expiresAtMs: number): WbCredits {
  return {
    total,
    packages: [{ packageName: 'one-shot', remain: total, size: total, monthly: false, expiresAtMs }],
    expiringSoon: 0,
    nearestExpiryMs: expiresAtMs,
  }
}

/** 纯月包：按周期刷新、没有到期信息。 */
function monthlyCredits(total: number): WbCredits {
  return {
    total,
    packages: [{ packageName: 'monthly', remain: total, size: total, monthly: true }],
    expiringSoon: 0,
  }
}

function member(id: string, credits: WbCredits | undefined): WbRankMember {
  return { account: { id }, ...credits === undefined ? {} : { credits } }
}

/**
 * 判决性 fixture：A 到期早、余额少；B 到期晚、余额多。
 *
 * 刻意让「最早到期」与「余额最多」指向**不同**账号，这样 `expiry` 与 `priority`
 * 两种分布必须选出不同的人；两个分布选出同一个就说明第一个排序键没起作用。
 */
const fixture = (): WbRankMember[] => [
  member('A', oneShot(500, NOW + 10 * DAY_MS)),
  member('B', oneShot(9_000, NOW + 30 * DAY_MS)),
]

const idsOf = (rows: readonly { account: { id: string } }[]): string[] => rows.map(row => row.account.id)

describe('rankAccounts 的第 5 个实参：临期窗口真的被读到了', () => {
  it('默认 3 天窗口下 A / B 都还没临期（两者都在窗口外）', () => {
    const rows = rankAccounts(fixture(), NOW, [], 'expiry')
    expect(rows.map(row => row.atRisk)).toEqual([false, false])
    expect(rows.map(row => row.expiringAmount)).toEqual([0, 0])
  })

  it('把窗口放到 15 天，A 变临期、B 仍然不是（不是无条件放大）', () => {
    const rows = rankAccounts(fixture(), NOW, [], 'expiry', 15)
    const byId = new Map(rows.map(row => [row.account.id, row]))
    expect(byId.get('A')?.atRisk).toBe(true)
    expect(byId.get('A')?.expiringAmount).toBe(500)
    expect(byId.get('B')?.atRisk).toBe(false)
    expect(byId.get('B')?.expiringAmount).toBe(0)
  })

  it('两个窗口的结果必须不同——相同就是 F2 没修通的直接证据', () => {
    const narrow = rankAccounts(fixture(), NOW, [], 'expiry', 3)
    const wide = rankAccounts(fixture(), NOW, [], 'expiry', 15)
    expect(narrow.map(row => row.atRisk)).not.toEqual(wide.map(row => row.atRisk))
  })

  it('窗口 30 天时两个都临期（窗口上限确实可用）', () => {
    const rows = rankAccounts(fixture(), NOW, [], 'expiry', 30)
    expect(rows.map(row => row.atRisk)).toEqual([true, true])
    expect(rows.map(row => row.expiringAmount)).toEqual([500, 9_000])
  })

  it('缺省值就是 DEFAULT_EXPIRY_WARN_DAYS（老调用点不受影响）', () => {
    const explicit = rankAccounts(fixture(), NOW, [], 'expiry', DEFAULT_EXPIRY_WARN_DAYS)
    const omitted = rankAccounts(fixture(), NOW, [], 'expiry')
    expect(idsOf(omitted)).toEqual(idsOf(explicit))
    expect(omitted.map(row => row.atRisk)).toEqual(explicit.map(row => row.atRisk))
  })

  it('非法窗口被夹紧：0 走 1 天下界、99999 走 90 天上界、NaN 回落默认', () => {
    // 下界：1 天窗口下，10 天后到期的 A 不该临期。
    expect(rankAccounts(fixture(), NOW, [], 'expiry', 0).map(row => row.atRisk)).toEqual([false, false])
    // 上界：90 天窗口下，30 天后到期的 B 也进窗口。
    expect(rankAccounts(fixture(), NOW, [], 'expiry', 99_999).map(row => row.atRisk)).toEqual([true, true])
    // 非数字：回落默认 3 天，等价于不传。
    const nan = rankAccounts(fixture(), NOW, [], 'expiry', Number.NaN)
    expect(nan.map(row => row.atRisk)).toEqual([false, false])
  })

  it('夹具常量与本文件的窗口夹紧口径一致（防止两边各自漂移）', () => {
    expect(EXPIRY_WARN_DAYS_MIN).toBe(1)
    expect(EXPIRY_WARN_DAYS_MAX).toBe(90)
    expect(DEFAULT_EXPIRY_WARN_DAYS).toBe(3)
  })
})

describe('pickRankedAccount 必须与 rankAccounts 同源', () => {
  it('第 5 个实参同样被转发：15 天窗口下 A 因临期而排第一', () => {
    const narrow = pickRankedAccount(fixture(), NOW, [], 'expiry', 3)
    const wide = pickRankedAccount(fixture(), NOW, [], 'expiry', 15)
    // 两种窗口下 `expiry` 都选 A（A 的到期更早），但选择理由不同：
    // 窄窗口靠 `_expiring`，宽窗口靠 `atRisk`。这里钉住的是「窗口被传进去了」。
    expect(narrow?.id).toBe('A')
    expect(wide?.id).toBe('A')
    const rowsWide = rankAccounts(fixture(), NOW, [], 'expiry', 15)
    expect(rowsWide[0]?.atRisk).toBe(true)
  })

  it('priority 与 expiry 在同一份数据上必须选出**不同**账号', () => {
    const expiryPick = pickRankedAccount(fixture(), NOW, [], 'expiry')
    const priorityPick = pickRankedAccount(fixture(), NOW, [], 'priority')
    expect(expiryPick?.id).toBe('A')
    expect(priorityPick?.id).toBe('B')
    expect(expiryPick?.id).not.toBe(priorityPick?.id)
  })

  it('宽窗口下 priority 的首键变成 atRisk，于是它也会选 A（窗口真的进了比较器）', () => {
    const narrow = pickRankedAccount(fixture(), NOW, [], 'priority', 3)
    const wide = pickRankedAccount(fixture(), NOW, [], 'priority', 15)
    expect(narrow?.id).toBe('B')
    expect(wide?.id).toBe('A')
  })
})

describe('WbAccountPool 把用户的窗口转交给排序层', () => {
  function account(id: string): WbDiscoveredAccount {
    return {
      id,
      label: id,
      region: 'cn',
      sourcePath: `/fake/${id}.info`,
      live: true,
      refreshExpired: false,
      tokenExpiresAtMs: NOW + 30 * DAY_MS,
      credential: { accessToken: 'tok', refreshToken: 'ref', expiresAtMs: NOW + 30 * DAY_MS, domain: '' },
    }
  }

  function poolWith(expiryWarnDays?: number): WbAccountPool {
    const pool = new WbAccountPool(expiryWarnDays === undefined ? {} : { expiryWarnDays })
    pool.applyDiscovery({ accounts: [account('A'), account('B')], skipped: [] })
    pool.noteCredits('A', oneShot(500, NOW + 10 * DAY_MS))
    pool.noteCredits('B', oneShot(9_000, NOW + 30 * DAY_MS))
    return pool
  }

  it('构造时给 15 天 → rank() 里 A 临期', () => {
    const rows = poolWith(15).rank('cn', NOW)
    const byId = new Map(rows.map(row => [row.account.id, row]))
    expect(byId.get('A')?.atRisk).toBe(true)
    expect(byId.get('B')?.atRisk).toBe(false)
  })

  it('applyConfig 之后窗口立即生效（设置页改完不必重建池）', () => {
    const pool = poolWith()
    expect(pool.rank('cn', NOW).every(row => !row.atRisk)).toBe(true)
    pool.applyConfig({ expiryWarnDays: 15 })
    const byId = new Map(pool.rank('cn', NOW).map(row => [row.account.id, row]))
    expect(byId.get('A')?.atRisk).toBe(true)
  })

  it('applyConfig 收到 undefined 时保持原值（「这次配置没有这一项」不是「清空」）', () => {
    const pool = poolWith(15)
    pool.applyConfig({ expiryWarnDays: undefined })
    expect(pool.expiryWarnDays).toBe(15)
    expect(new Map(pool.rank('cn', NOW).map(row => [row.account.id, row])).get('A')?.atRisk).toBe(true)
  })

  it('expiryWarnDays getter 暴露当前值，未配置时是 undefined', () => {
    expect(poolWith().expiryWarnDays).toBeUndefined()
    expect(poolWith(30).expiryWarnDays).toBe(30)
  })

  it('pick() 也走同一个窗口：15 天窗口下 priority 的首键翻成 A', () => {
    const narrow = poolWith()
    narrow.applyConfig({ distribution: 'priority' })
    expect(narrow.pick('cn', { nowMs: NOW }).account?.id).toBe('B')
    narrow.applyConfig({ expiryWarnDays: 15 })
    expect(narrow.pick('cn', { nowMs: NOW }).account?.id).toBe('A')
  })
})

describe('expiry 分布下的理由必须可读（F4）', () => {
  const fixtureWithMonthly = (): WbRankMember[] => [
    member('A', oneShot(500, NOW + 10 * DAY_MS)),
    member('B', oneShot(9_000, NOW + 30 * DAY_MS)),
    member('C', monthlyCredits(3_000)),
  ]

  it('被选中的账号在最前，且它的 nearestExpiryMs 就是那个「最早到期」', () => {
    const rows = rankAccounts(fixtureWithMonthly(), NOW, [], 'expiry')
    expect(rows[0]?.account.id).toBe('A')
    expect(rows[0]?.nearestExpiryMs).toBe(NOW + 10 * DAY_MS)
  })

  it('纯月包账号沉底，且 nearestExpiryMs 缺省（不编假时间）', () => {
    const rows = rankAccounts(fixtureWithMonthly(), NOW, [], 'expiry')
    const last = rows.at(-1)
    expect(last?.account.id).toBe('C')
    expect(last?.nearestExpiryMs).toBeUndefined()
  })

  it('到期更晚的画在后面，两者的 nearestExpiryMs 严格递增', () => {
    const rows = rankAccounts(fixtureWithMonthly(), NOW, [], 'expiry')
    const expiryOf = (id: string): number | undefined =>
      rows.find(row => row.account.id === id)?.nearestExpiryMs
    expect(expiryOf('A')).toBeDefined()
    expect(expiryOf('B')).toBeDefined()
    expect(expiryOf('A') as number).toBeLessThan(expiryOf('B') as number)
  })
})

describe('客户端读数的窗口取自 /status 的配置回显（F4 客户端侧）', () => {
  function snapshotWith(config: Record<string, unknown> | undefined): WbStatusSnapshot {
    const base = {
      scannedAtMs: NOW,
      region: 'cn',
      accounts: [],
      skipped: [],
      models: [],
      totalCredits: 0,
      creditsReadout: { total: 0, accounts: [] },
      catalogs: {},
      automation: {},
    } as unknown as WbStatusSnapshot
    return config === undefined
      ? base
      : { ...base, config } as unknown as WbStatusSnapshot
  }

  it('读得到 config.expiryWarnDays 时用它', () => {
    expect(warnDaysOf(snapshotWith({ expiryWarnDays: 15 }))).toBe(15)
    expect(warnDaysOf(snapshotWith({ expiryWarnDays: 30 }))).toBe(30)
  })

  it('读不到 snapshot / config / 字段时回落默认 3 天（退化而不是隐藏）', () => {
    expect(warnDaysOf(undefined)).toBe(DEFAULT_EXPIRY_WARN_DAYS)
    expect(warnDaysOf(snapshotWith(undefined))).toBe(DEFAULT_EXPIRY_WARN_DAYS)
    expect(warnDaysOf(snapshotWith({}))).toBe(DEFAULT_EXPIRY_WARN_DAYS)
    expect(warnDaysOf(snapshotWith({ expiryWarnDays: 'abc' }))).toBe(DEFAULT_EXPIRY_WARN_DAYS)
    expect(warnDaysOf(snapshotWith({ expiryWarnDays: Number.NaN }))).toBe(DEFAULT_EXPIRY_WARN_DAYS)
  })

  it('越界值被夹进 [1, 90]，与宿主排序层同一口径', () => {
    expect(warnDaysOf(snapshotWith({ expiryWarnDays: 0 }))).toBe(EXPIRY_WARN_DAYS_MIN)
    expect(warnDaysOf(snapshotWith({ expiryWarnDays: 9_999 }))).toBe(EXPIRY_WARN_DAYS_MAX)
    expect(warnDaysOf(snapshotWith({ expiryWarnDays: 15.4 }))).toBe(15)
  })

  it('客户端窗口与宿主窗口对同一个配置值给出同一个数字', () => {
    for (const value of [1, 3, 15, 30, 90]) {
      const clientSide = warnDaysOf(snapshotWith({ expiryWarnDays: value }))
      // 宿主侧：同一份 fixture 在客户端算出的窗口下必须与显式传参一致。
      const hostSide = rankAccounts(fixture(), NOW, [], 'expiry', clientSide)
      const explicit = rankAccounts(fixture(), NOW, [], 'expiry', value)
      expect(hostSide.map(row => row.atRisk), String(value)).toEqual(explicit.map(row => row.atRisk))
    }
  })
})

/**
 * 请求路径上的余额写回（F2 的根因位置）。
 *
 * 这一组必须走**真端口**：`refreshBalance` 在 `chatCompletions` 里是 `void` 调用
 * （响应头已发出，不能阻塞），所以只有真的发一次 HTTP 请求、等流结束、再读池里的
 * 读数，才能证明「聊天后写回的 `expiringSoon` 用了用户的窗口」。
 *
 * 用替身替换的只有 `WbUpstreamClient`（网络边界）。它的 `fetchCredits` 返回**真实
 * 契约**的 `WbRawCredits`：`total` 与一串包，包上带 `monthly` / `expiresAtMs`。
 * 替身不参与任何窗口判断——窗口判断必须发生在 `shim.ts` 里，否则这组测试测的是替身。
 *
 * 缺陷形态（改前）：`pool.noteCredits(id, { total, packages, expiringSoon: 0 })`，
 * 于是无论窗口设成几，读回的 `expiringSoon` 恒 0，排序层只能落回 3 天兜底。
 */
describe('shim 的余额写回按用户窗口聚合（F2 根因）', () => {
  /** 真端口 + 真请求；返回聊天结束**之后**池里的 `WbCredits`。 */
  async function creditsAfterOneChat(
    warnDays: number | undefined,
    packages: readonly { remain: number; monthly: boolean; expiresInDays?: number }[],
  ): Promise<{ total: number; expiringSoon: number; nearestExpiryMs?: number } | undefined> {
    const pool = new WbAccountPool(warnDays === undefined ? {} : { expiryWarnDays: warnDays })
    pool.applyDiscovery({ accounts: [account('A')], skipped: [] })
    const shim = createWbShim({
      pool,
      catalog: new WbCatalog('cn'),
      region: 'cn',
      // getter 而不是数字：shim 只在 apply() 构造一次，设置页改完必须立即生效。
      ...warnDays === undefined ? {} : { expiryWarnDays: () => warnDays },
      client: {
        chatStream: async () => ({
          ok: true as const,
          response: new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        }),
        fetchCredits: async () => {
          const nowMs = Date.now()
          return {
            total: packages.reduce((sum, pack) => sum + pack.remain, 0),
            packages: packages.map((pack, index) => ({
              packageName: `p${index}`,
              remain: pack.remain,
              size: pack.remain,
              monthly: pack.monthly,
              ...pack.expiresInDays === undefined
                ? {}
                : { expiresAtMs: nowMs + pack.expiresInDays * DAY_MS },
            })),
          }
        },
      } as never,
    })
    try {
      await shim.ready
      const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${shim.token()}`,
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      })
      // 必须把流读干：`refreshBalance` 在 `res.end()` 之后才 `void` 出去。
      await res.text()
      // 轮询而不是固定 sleep：写回是异步的，但通常几毫秒内就完成。
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const credits = pool.find('A')?.credits
        if (credits !== undefined) return credits
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      return undefined
    } finally {
      await shim.close()
    }
  }

  /** 判决性数据：10 天后到期 500（默认窗口外、15 天窗口内）。 */
  const nearExpiry = [{ remain: 500, monthly: false, expiresInDays: 10 }] as const

  it('窗口 3 天时 10 天后到期的包不计入 expiringSoon', async () => {
    const credits = await creditsAfterOneChat(3, nearExpiry)
    expect(credits?.total).toBe(500)
    expect(credits?.expiringSoon).toBe(0)
  })

  it('窗口 15 天时同一批包计入 500——两个窗口的读数必须不同（改前恒 0）', async () => {
    const narrow = await creditsAfterOneChat(3, nearExpiry)
    const wide = await creditsAfterOneChat(15, nearExpiry)
    expect(wide?.expiringSoon).toBe(500)
    expect(narrow?.expiringSoon).not.toBe(wide?.expiringSoon)
  })

  it('写回的 expiringSoon 就是用户窗口算出来的，且排序层立刻按它判定', async () => {
    // 同一份池数据、同一份包，只改窗口：宽窗口下 A 必须进 atRisk。
    const credits = await creditsAfterOneChat(15, nearExpiry)
    expect(credits).toBeDefined()
    const rows = rankAccounts(
      [{ account: { id: 'A' }, credits }],
      Date.now(),
      [],
      'expiry',
      // 排序层这里用默认 3 天：能得出 atRisk=true 说明它采信了写回的**显式**
      // expiringSoon（500 > 0），而不是自己按 3 天窗口重算成 0。
      DEFAULT_EXPIRY_WARN_DAYS,
    )
    expect(rows[0]?.atRisk).toBe(true)
    expect(rows[0]?.expiringAmount).toBe(500)
  })

  it('月包不进临期统计（会刷新，不存在过期）', async () => {
    const credits = await creditsAfterOneChat(90, [{ remain: 3_000, monthly: true }])
    expect(credits?.expiringSoon).toBe(0)
    expect(credits?.nearestExpiryMs).toBeUndefined()
  })

  it('已过期与余额为 0 的包都不计入（否则零余额账号永远 atRisk）', async () => {
    const credits = await creditsAfterOneChat(90, [
      { remain: 400, monthly: false, expiresInDays: -1 },
      { remain: 0, monthly: false, expiresInDays: 10 },
      { remain: 100, monthly: false, expiresInDays: 5 },
    ])
    expect(credits?.expiringSoon).toBe(100)
    expect(credits?.total).toBe(500)
  })

  it('没给 getter 时落回默认 3 天（不传配置的调用点行为不变）', async () => {
    const credits = await creditsAfterOneChat(undefined, nearExpiry)
    expect(credits?.expiringSoon).toBe(0)
    const wide = await creditsAfterOneChat(undefined, [
      { remain: 200, monthly: false, expiresInDays: 1 },
    ])
    expect(wide?.expiringSoon).toBe(200)
  })

  it('getter 抛错时余额刷新照常完成（一次配置抖动不能吞掉余额）', async () => {
    const pool = new WbAccountPool({})
    pool.applyDiscovery({ accounts: [account('A')], skipped: [] })
    const shim = createWbShim({
      pool,
      catalog: new WbCatalog('cn'),
      region: 'cn',
      expiryWarnDays: () => { throw new Error('config exploded') },
      client: {
        chatStream: async () => ({
          ok: true as const,
          response: new Response('data: [DONE]\n\n', {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        }),
        fetchCredits: async () => ({
          total: 200,
          packages: [{ packageName: 'p', remain: 200, size: 200, monthly: false, expiresAtMs: Date.now() + DAY_MS }],
        }),
      } as never,
    })
    try {
      await shim.ready
      const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${shim.token()}`,
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      })
      await res.text()
      let credits: { total: number } | undefined
      for (let attempt = 0; attempt < 200; attempt += 1) {
        credits = pool.find('A')?.credits
        if (credits !== undefined) break
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      // 落回默认 3 天：1 天后到期 → 在窗口内。
      expect(credits?.total).toBe(200)
      expect(pool.find('A')?.credits?.expiringSoon).toBe(200)
    } finally {
      await shim.close()
    }
  })
})

describe('分布的语义没有因为加参数而改变', () => {
  it('五种分布都能跑，且 expiry 与 priority 是唯一会因窗口改判的两个', () => {
    const all: AccountDistribution[] = ['priority', 'round-robin', 'balanced', 'sticky', 'expiry']
    for (const distribution of all) {
      const rows = rankAccounts(fixture(), NOW, [], distribution, 15)
      expect(rows).toHaveLength(2)
      // 排序层对四种非 expiry 分布用同一份顺序，所以 atRisk 集合必须一致。
      expect(rows.filter(row => row.atRisk).map(row => row.account.id), distribution).toEqual(['A'])
    }
  })
})
