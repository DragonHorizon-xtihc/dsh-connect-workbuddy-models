/**
 * 自动签到与积分任务（需求 R1-e）。
 *
 * 调度器真正会出错的地方不是「有没有调对端点」，而是**什么时候该跑、什么时候绝
 * 不能跑**。本文件钉住四条不变量：
 *
 * 1. **默认停摆**。`enabled` 的初值是 `false`，用户没在设置页打开之前，插件不
 *    应该替任何人做写操作。
 * 2. **北京时间切日**。用户在 UTC 机器上装插件，「早 9 点」仍然按北京时间算。
 * 3. **日界先滚再消费**。跨零点时昨天的已消费时段必须先作废，否则新的一天会被
 *    「今天已经跑过了」误拦——而那个拦截没有任何日志。
 * 4. **幂等跨重启**。账本持久化在磁盘上，重启后同一天的同一时段不能重跑。
 *
 * 「已经过去」而不是「正好等于」这条判定单独测：DSH 关闭期间错过的时段要能自愈
 * （09:00 的签到在 10:00 启动时补上），这是笔记本合盖场景需要的。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WbAccountPool } from '../src/accounts.ts'
import type { WbDiscoveredAccount } from '../src/accounts.ts'
import { WbScheduler, dayKey, slotKey } from '../src/scheduler.ts'
import type { AutomationLedger } from '../src/scheduler.ts'
import type { WbCheckinClaim, WbUpstreamCheckin } from '../src/upstream.ts'

const DAY = 86_400_000

function account(id: string): WbDiscoveredAccount {
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
  }
}

function poolOf(...ids: readonly string[]): WbAccountPool {
  const pool = new WbAccountPool({})
  pool.applyDiscovery({ accounts: ids.map(account), skipped: [] })
  return pool
}

function status(overrides: Partial<WbUpstreamCheckin> = {}): WbUpstreamCheckin {
  return {
    active: true,
    todayCheckedIn: false,
    streakDays: 1,
    dailyCredit: 10,
    todayCredit: 10,
    isStreakDay: false,
    nextStreakDay: 2,
    streakBonusDays: 7,
    streakBonusCredit: 50,
    ...overrides,
  }
}

/** 记数用的假上游。 */
function fakeClient(state: { status?: WbUpstreamCheckin } = {}) {
  const calls = { status: 0, claimDaily: 0 }
  return {
    calls,
    client: {
      async fetchCheckinStatus(): Promise<WbUpstreamCheckin> {
        calls.status += 1
        return state.status ?? status()
      },
      async claimDailyCheckin(): Promise<WbCheckinClaim> {
        calls.claimDaily += 1
        return { credit: 10, streakDays: 2, isStreakDay: false }
      },
      async fetchBenefits(): Promise<readonly never[]> {
        return []
      },
      async claimBenefit(): Promise<void> {},
    },
  }
}

/** 北京时间某日某时的时间戳。 */
function beijing(day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 2, day, hour - 8, minute, 0))
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── 停摆 ─────────────────────────────────────────────────────────────────

describe('关闭时完全停摆', () => {
  it('默认 disabled，定时器跑一整轮也不发任何请求', async () => {
    const { client, calls } = fakeClient()
    const scheduler = new WbScheduler({
      pool: poolOf('a1'),
      client: client as never,
      now: () => new Date(),
    })
    scheduler.start()
    // 把定时器推进到 09:00 之后的一整个小时里（tick 每 60s 一次）。
    vi.setSystemTime(beijing(15, 10))
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(calls.status).toBe(0)
    expect(calls.claimDaily).toBe(0)
    scheduler.dispose()
  })

  it('applyConfig(enabled: false) 会把已经开着的调度器停下写操作', async () => {
    const { client, calls } = fakeClient()
    const scheduler = new WbScheduler({
      pool: poolOf('a1'),
      client: client as never,
      now: () => new Date(),
      config: { enabled: true, checkinHours: [9], claimBenefits: false },
    })
    expect(scheduler.isEnabled()).toBe(true)
    scheduler.applyConfig({ enabled: false, checkinHours: [9], claimBenefits: false })
    scheduler.start()
    vi.setSystemTime(beijing(15, 10))
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(calls.status).toBe(0)
    scheduler.dispose()
  })

  it('dispose 之后定时器不再触发（卸载后不能对着已 dispose 的上下文发请求）', async () => {
    const { client, calls } = fakeClient()
    const scheduler = new WbScheduler({
      pool: poolOf('a1'),
      client: client as never,
      now: () => new Date(),
      config: { enabled: true, checkinHours: [9], claimBenefits: false, accountDelayMs: 0 },
    })
    scheduler.start()
    scheduler.dispose()
    vi.setSystemTime(beijing(15, 10))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(calls.status).toBe(0)
  })
})

// ── 到点会跑 ─────────────────────────────────────────────────────────────

describe('到点自动运行', () => {
  it('09:00 那个小时里的 tick 会跑一次签到', async () => {
    const { client, calls } = fakeClient()
    const scheduler = new WbScheduler({
      pool: poolOf('a1'),
      client: client as never,
      now: () => new Date(),
      config: { enabled: true, checkinHours: [9], claimBenefits: false, accountDelayMs: 0 },
    })
    vi.setSystemTime(beijing(15, 9, 0))
    scheduler.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.claimDaily).toBe(1)
    scheduler.dispose()
  })

  it('同一小时内不会跑第二次', async () => {
    const { client, calls } = fakeClient()
    const scheduler = new WbScheduler({
      pool: poolOf('a1'),
      client: client as never,
      now: () => new Date(),
      config: { enabled: true, checkinHours: [9], claimBenefits: false, accountDelayMs: 0 },
    })
    vi.setSystemTime(beijing(15, 9, 0))
    scheduler.start()
    await vi.advanceTimersByTimeAsync(59 * 60_000)
    expect(calls.claimDaily).toBe(1)
    scheduler.dispose()
  })

  it('时段之外不跑', async () => {
    const { client, calls } = fakeClient()
    const scheduler = new WbScheduler({
      pool: poolOf('a1'),
      client: client as never,
      now: () => new Date(),
      config: { enabled: true, checkinHours: [9], claimBenefits: false, accountDelayMs: 0 },
    })
    // 12:00 启动：9 点那个时段「已经过去」，所以按自愈规则会补跑——
    // 这一条测的是**还没有任何时段**的情况：hour 必须小于最早时段。
    vi.setSystemTime(beijing(15, 8, 30))
    scheduler.start()
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    // 08:30 → 08:50 之间仍然在 8 点，不命中。
    expect(calls.claimDaily).toBe(0)
    scheduler.dispose()
  })
})

// ── 自愈 ─────────────────────────────────────────────────────────────────

describe('错过的时段会自愈', () => {
  it('宿主 09:00 没开机，10:00 启动时补跑', async () => {
    const { client, calls } = fakeClient()
    const scheduler = new WbScheduler({
      pool: poolOf('a1'),
      client: client as never,
      now: () => new Date(),
      config: { enabled: true, checkinHours: [9], claimBenefits: false, accountDelayMs: 0 },
    })
    // 10:00 才启动 —— 9 点那一格从没消费过。
    vi.setSystemTime(beijing(15, 10, 0))
    scheduler.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.claimDaily).toBe(1)
    scheduler.dispose()
  })

  it('多时段配置按最早的未消费候选依次跑', async () => {
    const { client, calls } = fakeClient()
    const scheduler = new WbScheduler({
      pool: poolOf('a1'),
      client: client as never,
      now: () => new Date(),
      config: { enabled: true, checkinHours: [9, 21], claimBenefits: false, accountDelayMs: 0 },
    })
    // 22:00 启动：9 点与 21 点都没消费过。第一轮跑 9 点那格，第二轮跑 21 点。
    vi.setSystemTime(beijing(15, 22, 0))
    scheduler.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.claimDaily).toBe(1)
    // 下一小时的 tick 依然在 22 点这一小时内——同一小时节流挡住；但下一格 21 点
    // 还没消费，滚到 23 点时才会再跑一次。
    vi.setSystemTime(beijing(15, 23, 0))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.claimDaily).toBe(2)
    scheduler.dispose()
  })
})

// ── 日界 ─────────────────────────────────────────────────────────────────

describe('日界按北京时间滚', () => {
  it('跨零点后昨天的已消费时段作废，新的一天能跑', async () => {
    const { client, calls } = fakeClient()
    const scheduler = new WbScheduler({
      pool: poolOf('a1'),
      client: client as never,
      now: () => new Date(),
      config: { enabled: true, checkinHours: [9], claimBenefits: false, accountDelayMs: 0 },
    })
    // 第一天 09:00 跑掉。
    vi.setSystemTime(beijing(15, 9, 0))
    scheduler.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.claimDaily).toBe(1)

    // 第二天 09:00：昨天的 `2026-03-15T09` 必须已经作废。
    vi.setSystemTime(beijing(16, 9, 0))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.claimDaily).toBe(2)
    scheduler.dispose()
  })

  it('北京时间 00:30 属于新的一天（UTC 还是前一天）', () => {
    // 这条单独钉一次，因为 UTC 机器上最容易出错的正是这段。
    expect(dayKey(beijing(15, 0, 30))).toBe('2026-03-15')
    expect(dayKey(beijing(15, 23, 30))).toBe('2026-03-15')
  })

  it('ledger() 只保留当天的已消费时段', async () => {
    const { client } = fakeClient()
    const scheduler = new WbScheduler({
      pool: poolOf('a1'),
      client: client as never,
      now: () => new Date(),
      config: { enabled: true, checkinHours: [9], claimBenefits: false, accountDelayMs: 0 },
      loadLedger: () => ({ firedSlots: ['2026-03-14T09', '2026-03-15T09'] }),
    })
    vi.setSystemTime(beijing(15, 12, 0))
    expect(scheduler.ledger().firedSlots).toEqual(['2026-03-15T09'])
    scheduler.dispose()
  })
})

// ── 账本持久化 ───────────────────────────────────────────────────────────

describe('账本持久化与重启幂等', () => {
  it('saveLedger 被调用，重启后读回同一份账本不会重跑', async () => {
    const saved: AutomationLedger[] = []
    const { client, calls } = fakeClient()
    const first = new WbScheduler({
      pool: poolOf('a1'),
      client: client as never,
      now: () => new Date(),
      config: { enabled: true, checkinHours: [9], claimBenefits: false, accountDelayMs: 0 },
      saveLedger: ledger => { saved.push(ledger) },
    })
    vi.setSystemTime(beijing(15, 9, 0))
    first.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.claimDaily).toBe(1)
    expect(saved.at(-1)?.firedSlots).toContain('2026-03-15T09')
    first.dispose()

    // 模拟重启：同一份账本喂给新实例，同一小时里不该再跑。
    const ledger = saved.at(-1)
    const callsAfter = { ...calls }
    const second = new WbScheduler({
      pool: poolOf('a1'),
      client: client as never,
      now: () => new Date(),
      config: { enabled: true, checkinHours: [9], claimBenefits: false, accountDelayMs: 0 },
      loadLedger: () => ledger,
    })
    vi.setSystemTime(beijing(15, 9, 30))
    second.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.claimDaily).toBe(callsAfter.claimDaily)
    second.dispose()
  })

  it('applyLedger(undefined) 是空操作，不清空已有账本', () => {
    const { client } = fakeClient()
    // 时钟必须落在账本所属的那一天：`ledger()` 会先滚日界，把更早的时段丢掉
    // （这本身是对的，见上一条）。不设时间的话这里会因为「日期已过期」而为空。
    vi.setSystemTime(beijing(15, 12, 0))
    const scheduler = new WbScheduler({
      pool: poolOf('a1'),
      client: client as never,
      now: () => new Date(),
      config: { enabled: true, checkinHours: [9], claimBenefits: false },
      loadLedger: () => ({ firedSlots: ['2026-03-15T09'] }),
    })
    // 磁盘上还没有账本文件时宿主会传 undefined —— 那不能把内存里已有的擦掉。
    scheduler.applyLedger(undefined)
    expect(scheduler.ledger().firedSlots).toEqual(['2026-03-15T09'])
    scheduler.dispose()
  })

  it('账本里非字符串的脏值被丢掉（手工改坏文件不能让调度器崩）', () => {
    const { client } = fakeClient()
    vi.setSystemTime(beijing(15, 12, 0))
    const scheduler = new WbScheduler({
      pool: poolOf('a1'),
      client: client as never,
      now: () => new Date(),
      loadLedger: () => ({ firedSlots: ['2026-03-15T09', 42 as never, null as never] }),
    })
    expect(scheduler.ledger().firedSlots).toEqual(['2026-03-15T09'])
    scheduler.dispose()
  })
})

// ── 状态快照 ─────────────────────────────────────────────────────────────

describe('status() 快照', () => {
  it('不携带任何 token 材料', async () => {
    const { client } = fakeClient()
    const scheduler = new WbScheduler({
      pool: poolOf('a1'),
      client: client as never,
      now: () => new Date(),
      config: { enabled: true, checkinHours: [9], claimBenefits: true },
    })
    const text = JSON.stringify(scheduler.status())
    expect(text).not.toContain('tok')
    expect(text).not.toContain('accessToken')
    scheduler.dispose()
  })

  it('running 反映定时器是否真的装着', () => {
    const { client } = fakeClient()
    const scheduler = new WbScheduler({ pool: poolOf('a1'), client: client as never, now: () => new Date() })
    expect(scheduler.status().running).toBe(false)
    scheduler.start()
    expect(scheduler.status().running).toBe(true)
    scheduler.dispose()
    expect(scheduler.status().running).toBe(false)
  })

  it('重复 start 不会装两个定时器', async () => {
    const { client, calls } = fakeClient()
    const scheduler = new WbScheduler({
      pool: poolOf('a1'),
      client: client as never,
      now: () => new Date(),
      config: { enabled: true, checkinHours: [9], claimBenefits: false, accountDelayMs: 0 },
    })
    vi.setSystemTime(beijing(15, 9, 0))
    scheduler.start()
    scheduler.start()
    scheduler.start()
    await vi.advanceTimersByTimeAsync(60_000)
    // 三个定时器会跑三轮；只有一个才会让 claimDaily 停在 1。
    expect(calls.claimDaily).toBe(1)
    scheduler.dispose()
  })
})

// ── 时段配置的容错 ───────────────────────────────────────────────────────

describe('非法时段列表回落默认值', () => {
  it('全是非法小时时回落到 [9]，而不是变成永不命中', () => {
    const { client } = fakeClient()
    const scheduler = new WbScheduler({ pool: poolOf('a1'), client: client as never, now: () => new Date() })
    // 空时段 = isFireHour 永不命中 = 自动签到静默停摆且无日志。
    scheduler.applyConfig({ enabled: true, checkinHours: [99, -1, 24], claimBenefits: false })
    expect(scheduler.status().checkinHours).toEqual([9])
    scheduler.dispose()
  })

  it('空数组同样回落 [9]', () => {
    const { client } = fakeClient()
    const scheduler = new WbScheduler({ pool: poolOf('a1'), client: client as never, now: () => new Date() })
    scheduler.applyConfig({ enabled: true, checkinHours: [], claimBenefits: false })
    expect(scheduler.status().checkinHours).toEqual([9])
    scheduler.dispose()
  })

  it('合法的小时原样保留并排序去重', () => {
    const { client } = fakeClient()
    const scheduler = new WbScheduler({ pool: poolOf('a1'), client: client as never, now: () => new Date() })
    scheduler.applyConfig({ enabled: true, checkinHours: [21, 9, 9], claimBenefits: false })
    expect(scheduler.status().checkinHours).toEqual([9, 21])
    scheduler.dispose()
  })
})

// ── 账号间延迟 ───────────────────────────────────────────────────────────

describe('账号之间串行等待', () => {
  it('delayMs 生效：不推进时钟时第二个账号不会开始', async () => {
    const { client, calls } = fakeClient()
    const scheduler = new WbScheduler({
      pool: poolOf('a1', 'a2'),
      client: client as never,
      now: () => new Date(),
      config: { enabled: true, checkinHours: [9], claimBenefits: false, accountDelayMs: 800 },
    })
    const running = scheduler.runCheckinNow()
    // 让它跑到「第一个账号做完、正在等 800ms」那一点。
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.claimDaily).toBe(1)
    // 只推进 400ms：还没到，第二个账号绝不能已经开始。
    await vi.advanceTimersByTimeAsync(400)
    expect(calls.claimDaily).toBe(1)
    // 补足剩下的 400ms：第二个账号开始。
    await vi.advanceTimersByTimeAsync(400)
    await running
    expect(calls.claimDaily).toBe(2)
    scheduler.dispose()
  })

  it('最后一个账号之后不再空等（总耗时正好是 N-1 个间隔）', async () => {
    const { client, calls } = fakeClient()
    const scheduler = new WbScheduler({
      pool: poolOf('a1', 'a2', 'a3'),
      client: client as never,
      now: () => new Date(),
      config: { enabled: true, checkinHours: [9], claimBenefits: false, accountDelayMs: 800 },
    })
    const started = Date.now()
    const running = scheduler.runCheckinNow()
    // 3 个账号 = 2 个间隔 = 1600ms；若最后一个之后也等，就需要 2400ms。
    await vi.advanceTimersByTimeAsync(1600)
    await running
    expect(calls.claimDaily).toBe(3)
    expect(Date.now() - started).toBe(1600)
    scheduler.dispose()
  })
})

// ── slotKey 与 status 的一致性 ───────────────────────────────────────────

describe('slotKey 与账本一致', () => {
  it('跑完之后 lastRunSlot 就是那一刻的 slotKey', async () => {
    const { client } = fakeClient()
    const scheduler = new WbScheduler({
      pool: poolOf('a1'),
      client: client as never,
      now: () => new Date(),
      config: { enabled: true, checkinHours: [9], claimBenefits: false, accountDelayMs: 0 },
    })
    vi.setSystemTime(beijing(15, 9, 0))
    await scheduler.runCheckinNow()
    expect(scheduler.ledger().lastRunSlot).toBe(slotKey(beijing(15, 9, 0)))
    scheduler.dispose()
  })
})
