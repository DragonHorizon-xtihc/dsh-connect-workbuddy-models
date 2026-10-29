// @vitest-environment node
/**
 * TTL 自动刷新（契约 `t31`）。
 *
 * 这个文件里的每一条都在回答「如果不这么写会怎样」。逐条对应的真实故障：
 *
 * 1. 没有自动刷新 → 促销活动结束两小时了，界面还在说「夜间免费」。这是用户报的那个
 *    现象，也是本任务存在的理由。
 * 2. 过期判断挪进应答路径且 `await` → 上游慢的时候整个设置页跟着卡。
 * 3. 没有单飞 → 两个标签页 + 几秒一次轮询 = 一串并发请求，上游按 429 限流，
 *    **连带打挂真正要用的模型调用**。
 * 4. 失败也推进时钟 → TTL 永不到期，自动刷新被永久饿死，只剩重启才能恢复。
 * 5. 失败无上限重试 → 凭据过期时设置页变成不断打上游的循环。
 * 6. 拥挤度刷新重置目录时钟 → 倍率与促销条目再也不按时更新（正是用户报的现象）。
 */
import { describe, expect, it } from 'vitest'

import type { WbAccountPool } from '../src/accounts.ts'
import type { WbCatalog, WbCatalogs } from '../src/catalog.ts'
import type { WbScheduler } from '../src/scheduler.ts'
import type { WbUpstreamClient } from '../src/upstream.ts'
import { buildStatusForTest, refreshForTest } from '../src/web-status.ts'
import {
  WB_BUSY_TTL_MS,
  WB_CATALOG_TTL_MS,
  type WbBusyLevel,
  type WbModelInfo,
  type WbRegion,
} from '../src/status-paths.ts'

const NOW = 1_793_000_000_000

/** 一个受控的目录桩：只需要 TTL 判定读到的那几个成员。 */
function catalogOf(options: { fetchedAtMs?: number; models?: readonly WbModelInfo[] }): WbCatalog {
  const models = options.models ?? [{ id: 'hy3', name: 'HY3' }]
  const fetchedAtMs = options.fetchedAtMs
  return {
    all: () => models,
    visible: () => models,
    lastFetchedAtMs: fetchedAtMs,
    lastUpdatedAt: fetchedAtMs,
    lastFetchError: undefined,
    source: fetchedAtMs === undefined ? 'fallback' : 'live',
    isUsable: () => true,
    isEnabled: () => true,
    ageMs: (nowMs: number) => (fetchedAtMs === undefined ? undefined : Math.max(0, nowMs - fetchedAtMs)),
    applyBusy: () => false,
  } as unknown as WbCatalog
}

function harness(options: {
  cnFetchedAtMs?: number
  busyFetchedAtMs?: number
  autoRefresh?: boolean
  maxAutoFailures?: number
  refreshModels?: () => Promise<void>
  refreshBusy?: () => Promise<void>
}) {
  const counters = { models: 0, busy: 0 }
  const cn = catalogOf({ fetchedAtMs: options.cnFetchedAtMs })
  const global = catalogOf({ fetchedAtMs: undefined, models: [] })
  const catalogs = {
    of: (region: WbRegion): WbCatalog => (region === 'cn' ? cn : global),
  } as unknown as WbCatalogs

  const deps = {
    catalogs,
    // 闸门与失败计数由这里持有：`refreshForTest` 若自己用默认参数建容器，
    // 连续三次调用会各拿一份空 Map，「单飞」就永远测不出来。
    refreshState: {
      inFlight: { models: new Map<WbRegion, Promise<void>>(), busy: new Map<WbRegion, Promise<void>>() },
      failures: new Map<string, number>(),
    },
    // 下面这些成员本文件用不到，但 `WbStatusRouteOptions` 要求它们在场。
    // `buildStatus` 会摸到池上的五处：账号列表、跳过清单、扫描时刻、名次表、
    // 优先账号。本文件断言的是「数据有多新」，账号维度一律给空，避免它的空值
    // 语义干扰注意力。
    pool: {
      listRegion: () => [],
      lastScannedAtMs: NOW,
      skippedFiles: [],
      rank: () => [],
      find: () => undefined,
      exclusionReason: () => undefined,
      preferredOf: () => undefined,
    } as unknown as WbAccountPool,
    client: {} as WbUpstreamClient,
    scheduler: { status: () => ({ enabled: false, checkinHours: [9], claimBenefits: false }) } as unknown as WbScheduler,
    readConfig: () => ({ distribution: 'expiry' }),
    refreshModels: async () => {
      counters.models += 1
      await (options.refreshModels?.() ?? Promise.resolve())
    },
    refreshBusy: async () => {
      counters.busy += 1
      await (options.refreshBusy?.() ?? Promise.resolve())
    },
    busyFetchedAtMs: () => options.busyFetchedAtMs,
    autoRefresh: options.autoRefresh,
    maxAutoFailures: options.maxAutoFailures,
    pickOf: () => ({ account: undefined, ranked: [] }),
  } as unknown as Parameters<typeof buildStatusForTest>[0]

  return { deps, counters }
}

/** 让挂起的 promise 链跑完（不依赖真实计时器）。 */
async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

describe('目录 TTL 自动刷新（t31）', () => {
  it('从未成功抓取过：判定过期，会触发一次刷新', async () => {
    const { deps, counters } = harness({ cnFetchedAtMs: undefined })
    refreshForTest(deps, 'cn', NOW)
    await settle()
    expect(counters.models).toBe(1)
  })

  it('刚抓过（未到 TTL）：一个请求都不发', async () => {
    const { deps, counters } = harness({ cnFetchedAtMs: NOW - 1_000 })
    refreshForTest(deps, 'cn', NOW)
    await settle()
    expect(counters.models).toBe(0)
  })

  it('恰好到 TTL 边界：判定过期（>= 而不是 >）', async () => {
    const { deps, counters } = harness({ cnFetchedAtMs: NOW - WB_CATALOG_TTL_MS })
    refreshForTest(deps, 'cn', NOW)
    await settle()
    expect(counters.models).toBe(1)
  })

  it('时钟回拨（快照时间戳在未来）：判定过期，而不是「还很新」', async () => {
    const { deps, counters } = harness({ cnFetchedAtMs: NOW + 60_000 })
    refreshForTest(deps, 'cn', NOW)
    await settle()
    expect(counters.models).toBe(1)
  })

  it('单飞：同一刻三次过期判断只产生一次上游请求', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const { deps, counters } = harness({
      cnFetchedAtMs: undefined,
      refreshModels: async () => { await gate },
    })
    // 三次调用必须在**同一个 tick 内**背靠背发出，中间不能 await。
    // 这是单飞要挡的真实情形：两个标签页同时打开设置页，加上几秒一次的轮询，
    // 它们的请求落在同一条微任务链上。中间插一个 `await` 就等于换了一轮事件循环，
    // 那时第一次早就飞完了，「只发一次」自然不成立——那样测的就不是单飞。
    refreshForTest(deps, 'cn', NOW)
    refreshForTest(deps, 'cn', NOW)
    refreshForTest(deps, 'cn', NOW)
    await settle()
    expect(counters.models).toBe(1)
    release?.()
    await settle()
    // 放行之后闸门要清掉，下一次过期才能再发。
    refreshForTest(deps, 'cn', NOW)
    await settle()
    expect(counters.models).toBe(2)
  })

  it('失败不推进时钟：下一次过期判断仍会再试（否则 TTL 永不到期）', async () => {
    let attempts = 0
    const { deps, counters } = harness({
      cnFetchedAtMs: undefined,
      maxAutoFailures: 5,
      refreshModels: async () => {
        attempts += 1
        throw new Error('upstream down')
      },
    })
    refreshForTest(deps, 'cn', NOW)
    await settle()
    expect(counters.models).toBe(1)
    refreshForTest(deps, 'cn', NOW)
    await settle()
    expect(counters.models).toBe(2)
    expect(attempts).toBe(2)
  })

  it('连续失败到上限后停手：不再自己重试', async () => {
    const { deps, counters } = harness({
      cnFetchedAtMs: undefined,
      maxAutoFailures: 2,
      refreshModels: async () => { throw new Error('upstream down') },
    })
    // 每一轮都必须真的等到上一轮彻底结束（失败已计数、闸门已释放），
    // 否则测的是「同 tick 单飞」而不是「失败上限」——那两条性质要分开验。
    for (let round = 0; round < 5; round += 1) {
      refreshForTest(deps, 'cn', NOW)
      await settle()
    }
    expect(counters.models).toBe(2)
  })

  it('autoRefresh=false 时完全不动（测试与诊断用）', async () => {
    const { deps, counters } = harness({ cnFetchedAtMs: undefined, autoRefresh: false })
    refreshForTest(deps, 'cn', NOW)
    await settle()
    expect(counters.models).toBe(0)
    expect(counters.busy).toBe(0)
  })
})

describe('拥挤度 TTL 与目录 TTL 互相独立（t31）', () => {
  it('目录新鲜、拥挤度过期：只刷拥挤度，不重读大文档', async () => {
    const { deps, counters } = harness({ cnFetchedAtMs: NOW - 1_000, busyFetchedAtMs: NOW - WB_BUSY_TTL_MS - 1 })
    refreshForTest(deps, 'cn', NOW)
    await settle()
    expect(counters.models).toBe(0)
    expect(counters.busy).toBe(1)
  })

  it('目录过期、拥挤度新鲜：只重读目录', async () => {
    const { deps, counters } = harness({ cnFetchedAtMs: NOW - WB_CATALOG_TTL_MS - 1, busyFetchedAtMs: NOW - 1_000 })
    refreshForTest(deps, 'cn', NOW)
    await settle()
    expect(counters.models).toBe(1)
    expect(counters.busy).toBe(0)
  })

  it('两条 TTL 都过期：两条各发一次，互不吞并', async () => {
    const { deps, counters } = harness({ cnFetchedAtMs: undefined, busyFetchedAtMs: undefined })
    refreshForTest(deps, 'cn', NOW)
    await settle()
    expect(counters.models).toBe(1)
    expect(counters.busy).toBe(1)
  })

  it('拥挤度从未取到、且刷新器缺席：不发空请求', async () => {
    const { deps, counters } = harness({ cnFetchedAtMs: NOW - 1_000, busyFetchedAtMs: undefined })
    // 显式去掉 refreshBusy，模拟老调用方。
    ;(deps as unknown as Record<string, unknown>)['refreshBusy'] = undefined
    refreshForTest(deps, 'cn', NOW)
    await settle()
    expect(counters.busy).toBe(0)
  })
})

describe('/status 上报的数据新鲜度（t31）', () => {
  it('从没抓过：不报 modelsFetchedAtMs，也不编一个 age', () => {
    const { deps } = harness({ cnFetchedAtMs: undefined })
    const status = buildStatusForTest(deps, 'cn', NOW)
    expect(status.modelsFetchedAtMs).toBeUndefined()
    expect(status.modelsAgeMs).toBeUndefined()
  })

  it('抓过：绝对时刻与年龄都报出来，且年龄用同一个时钟算', () => {
    const { deps } = harness({ cnFetchedAtMs: NOW - 90_000, busyFetchedAtMs: NOW - 30_000 })
    const status = buildStatusForTest(deps, 'cn', NOW)
    expect(status.modelsFetchedAtMs).toBe(NOW - 90_000)
    expect(status.modelsAgeMs).toBe(90_000)
    expect(status.busyFetchedAtMs).toBe(NOW - 30_000)
  })

  it('时钟回拨时年龄报 0，报负数会让界面显示成「-1 分钟前」', () => {
    const { deps } = harness({ cnFetchedAtMs: NOW + 60_000 })
    const status = buildStatusForTest(deps, 'cn', NOW)
    expect(status.modelsAgeMs).toBe(0)
  })
})

describe('拥挤度等级的类型面（t31 回归）', () => {
  it('六态齐备，unknown 与 normal 必须是两个值', () => {
    const levels: WbBusyLevel[] = ['idle', 'normal', 'busy', 'congested', 'unavailable', 'unknown']
    expect(new Set(levels).size).toBe(6)
  })
})
