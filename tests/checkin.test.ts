/**
 * 签到与权益（需求 R1-b、R5 手动签到）。
 *
 * 这一块真正会出错的地方不是「有没有发出请求」，而是**幂等判据用错了标志**：
 *
 * - `active`：活动窗口是否开着。
 * - `todayCheckedIn`：**这个账号**今天的奖励是否已存在。
 * - `claimed`：这个账号是否已领过这一类权益。
 *
 * 上游对已领取的赠礼仍会报 `active: true`（campaign 还没结束），所以只看 `active`
 * 会每次运行都重复领一次、每次都被拒——那个拒绝看起来像「领取失败」。因此
 * `claimable` 必须是 `active && !claimed`，本文件把它钉住。
 *
 * 另一个已发布过的缺陷是拿**本地日期**当「已签到」：切换账号后卡片显示已签到并
 * 禁用按钮，理由错。本地账本只能回答「今天这个时段跑过没有」，回答不了任何账号级
 * 问题。
 */

import { describe, expect, it, vi } from 'vitest'
import { WbAccountPool } from '../src/accounts.ts'
import type { WbDiscoveredAccount } from '../src/accounts.ts'
import { WbScheduler, dayKey } from '../src/scheduler.ts'
import { benefitIsClaimable } from '../src/upstream.ts'
import type { WbBenefit, WbCheckinClaim, WbUpstreamCheckin } from '../src/upstream.ts'

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

/** 一池只装了给定账号的池子。 */
function poolOf(...accounts: readonly WbDiscoveredAccount[]): WbAccountPool {
  const pool = new WbAccountPool({})
  pool.applyDiscovery({ accounts, skipped: [] })
  return pool
}

/** 一条签到状态；缺省是「活动开着、今天还没签」。 */
function status(overrides: Partial<WbUpstreamCheckin> = {}): WbUpstreamCheckin {
  return {
    active: true,
    todayCheckedIn: false,
    streakDays: 3,
    dailyCredit: 10,
    todayCredit: 10,
    isStreakDay: false,
    nextStreakDay: 4,
    streakBonusDays: 7,
    streakBonusCredit: 50,
    ...overrides,
  }
}

/** 一条权益。 */
function benefit(overrides: Partial<WbBenefit> = {}): WbBenefit {
  return { kind: 'gift', active: true, claimed: false, creditNum: 20, ...overrides }
}

/**
 * 一个假上游。只实现调度器真正会调到的三个方法。
 *
 * 每次调用都计数，因为本文件大半的断言是「**没有**发生第二次领取」——用「返回了
 * 什么」表达不了这件事。
 */
function fakeClient(options: {
  status?: WbUpstreamCheckin
  claim?: WbCheckinClaim
  benefits?: readonly WbBenefit[]
  failStatus?: Error
} = {}) {
  const calls = {
    status: 0,
    claimDaily: 0,
    benefits: 0,
    claimBenefit: [] as string[],
  }
  const client = {
    async fetchCheckinStatus(): Promise<WbUpstreamCheckin> {
      calls.status += 1
      if (options.failStatus !== undefined) throw options.failStatus
      return options.status ?? status()
    },
    async claimDailyCheckin(): Promise<WbCheckinClaim> {
      calls.claimDaily += 1
      return options.claim ?? { credit: 10, streakDays: 4, isStreakDay: false }
    },
    async fetchBenefits(): Promise<readonly WbBenefit[]> {
      calls.benefits += 1
      return options.benefits ?? []
    },
    async claimBenefit(_credential: unknown, kind: 'compensation' | 'gift'): Promise<void> {
      calls.claimBenefit.push(kind)
    },
  }
  return { client, calls }
}

/** 固定在北京时间某日 10:00 的时钟（签到时段之后，日界明确）。 */
function clockAtBeijing(hour = 10): () => Date {
  const at = new Date(Date.UTC(2026, 2, 15, hour - 8, 0, 0))
  return () => at
}

function schedulerOf(pool: WbAccountPool, client: unknown, now = clockAtBeijing()): WbScheduler {
  return new WbScheduler({ pool, client: client as never, now })
}

// ── claimable 判据 ───────────────────────────────────────────────────────

describe('权益可领判据：active && !claimed', () => {
  it('活动开着且没领过 → 可领', () => {
    expect(benefitIsClaimable(benefit())).toBe(true)
  })

  it('活动开着但已领过 → 不可领（上游对已领赠礼仍报 active: true）', () => {
    // 这条是整个文件的核心：只看 active 就会重复发写请求。
    expect(benefitIsClaimable(benefit({ active: true, claimed: true }))).toBe(false)
  })

  it('没领过但活动关了 → 不可领', () => {
    expect(benefitIsClaimable(benefit({ active: false, claimed: false }))).toBe(false)
  })

  it('两个都是 false → 不可领', () => {
    expect(benefitIsClaimable(benefit({ active: false, claimed: true }))).toBe(false)
  })
})

// ── 单账号签到 ───────────────────────────────────────────────────────────

describe('单账号签到（R5 手动签到）', () => {
  it('活动开着、今天没签 → 真的领一次，并把积分记进所得', async () => {
    const { client, calls } = fakeClient()
    const scheduler = schedulerOf(poolOf(account('a1')), client)
    const result = await scheduler.checkinOne('a1')
    expect(calls.claimDaily).toBe(1)
    expect(result.gain?.checkinCredit).toBe(10)
    expect(result.detail.join('\n')).toContain('签到成功 +10 积分')
    scheduler.dispose()
  })

  it('今天已签 → 不再领第二次（账号级幂等靠 todayCheckedIn，不是本地日期）', async () => {
    const { client, calls } = fakeClient({ status: status({ todayCheckedIn: true }) })
    const scheduler = schedulerOf(poolOf(account('a1')), client)
    const result = await scheduler.checkinOne('a1')
    expect(calls.claimDaily).toBe(0)
    expect(result.gain?.alreadyDone).toBe(true)
    expect(result.gain?.checkinCredit).toBe(0)
    expect(result.detail.join('\n')).toContain('今日已签到')
    scheduler.dispose()
  })

  it('活动未开启 → 什么都不做，且不算失败', async () => {
    const { client, calls } = fakeClient({ status: status({ active: false }) })
    const scheduler = schedulerOf(poolOf(account('a1')), client)
    const result = await scheduler.checkinOne('a1')
    expect(calls.claimDaily).toBe(0)
    expect(result.gain).toBeUndefined()
    expect(result.detail.join('\n')).toContain('签到活动未开启')
    expect(scheduler.status().jobs.checkin.failed).toBe(0)
    scheduler.dispose()
  })

  it('账号不存在 → 给出可读原因，而不是抛错', async () => {
    const { client, calls } = fakeClient()
    const scheduler = schedulerOf(poolOf(account('a1')), client)
    const result = await scheduler.checkinOne('nope')
    expect(result.gain).toBeUndefined()
    expect(result.detail.join('\n')).toContain('账号不存在')
    // 连状态都没去读：不存在就必须在本地短路。
    expect(calls.status).toBe(0)
    scheduler.dispose()
  })

  it('上游读状态失败 → 原样抛给调用方（按钮不能假装成功）', async () => {
    const { client } = fakeClient({ failStatus: new Error('boom') })
    const scheduler = schedulerOf(poolOf(account('a1')), client)
    await expect(scheduler.checkinOne('a1')).rejects.toThrow('boom')
    scheduler.dispose()
  })

  it('已签到时仍然去领权益（赠礼是独立端点，与签到名额无关）', async () => {
    const { client, calls } = fakeClient({
      status: status({ todayCheckedIn: true }),
      benefits: [benefit({ creditNum: 20 })],
    })
    const scheduler = schedulerOf(poolOf(account('a1')), client)
    scheduler.applyConfig({ enabled: false, checkinHours: [9], claimBenefits: true })
    const result = await scheduler.checkinOne('a1')
    expect(calls.claimDaily).toBe(0)
    expect(calls.claimBenefit).toEqual(['gift'])
    expect(result.gain?.benefitCredit).toBe(20)
    scheduler.dispose()
  })

  it('claimBenefits 关闭时完全不碰权益端点', async () => {
    const { client, calls } = fakeClient({ benefits: [benefit()] })
    const scheduler = schedulerOf(poolOf(account('a1')), client)
    scheduler.applyConfig({ enabled: false, checkinHours: [9], claimBenefits: false })
    await scheduler.checkinOne('a1')
    expect(calls.benefits).toBe(0)
    expect(calls.claimBenefit).toEqual([])
    scheduler.dispose()
  })
})

// ── 权益领取 ─────────────────────────────────────────────────────────────

describe('单账号领取权益', () => {
  it('可领 → 领一次并返回 true', async () => {
    const { client, calls } = fakeClient({ benefits: [benefit({ kind: 'compensation', creditNum: 30 })] })
    const scheduler = schedulerOf(poolOf(account('a1')), client)
    expect(await scheduler.claimOne('a1', 'compensation')).toBe(true)
    expect(calls.claimBenefit).toEqual(['compensation'])
    scheduler.dispose()
  })

  it('已领过 → 返回 false 且不发写请求（连点两次的第二下必须无事发生）', async () => {
    const { client, calls } = fakeClient({ benefits: [benefit({ claimed: true })] })
    const scheduler = schedulerOf(poolOf(account('a1')), client)
    expect(await scheduler.claimOne('a1', 'gift')).toBe(false)
    expect(calls.claimBenefit).toEqual([])
    scheduler.dispose()
  })

  it('活动关着 → 返回 false 且不发写请求', async () => {
    const { client, calls } = fakeClient({ benefits: [benefit({ active: false })] })
    const scheduler = schedulerOf(poolOf(account('a1')), client)
    expect(await scheduler.claimOne('a1', 'gift')).toBe(false)
    expect(calls.claimBenefit).toEqual([])
    scheduler.dispose()
  })

  it('上游根本不报这一类权益 → 抛错，而不是静默成功', async () => {
    const { client } = fakeClient({ benefits: [benefit({ kind: 'gift' })] })
    const scheduler = schedulerOf(poolOf(account('a1')), client)
    await expect(scheduler.claimOne('a1', 'compensation')).rejects.toThrow(/compensation/)
    scheduler.dispose()
  })

  it('账号不存在 → 抛错（用户点的是这个账号的按钮）', async () => {
    const { client } = fakeClient()
    const scheduler = schedulerOf(poolOf(account('a1')), client)
    await expect(scheduler.claimOne('ghost', 'gift')).rejects.toThrow(/ghost/)
    scheduler.dispose()
  })

  it('领取所得进当日账本', async () => {
    const { client } = fakeClient({ benefits: [benefit({ creditNum: 25 })] })
    const scheduler = schedulerOf(poolOf(account('a1')), client)
    await scheduler.claimOne('a1', 'gift')
    expect(scheduler.status().earningsToday['a1']?.benefitCredit).toBe(25)
    scheduler.dispose()
  })
})

// ── 全量运行 ─────────────────────────────────────────────────────────────

describe('全量签到运行', () => {
  it('一个账号失败不打断整轮', async () => {
    const pool = poolOf(account('a1'), account('a2'), account('a3'))
    let index = 0
    const client = {
      async fetchCheckinStatus(): Promise<WbUpstreamCheckin> {
        index += 1
        // 第二个账号炸，前后两个必须照常跑完。
        if (index === 2) throw new Error('a2 exploded')
        return status()
      },
      async claimDailyCheckin(): Promise<WbCheckinClaim> {
        return { credit: 10, streakDays: 1, isStreakDay: false }
      },
      async fetchBenefits(): Promise<readonly WbBenefit[]> {
        return []
      },
      async claimBenefit(): Promise<void> {},
    }
    const scheduler = new WbScheduler({
      pool,
      client: client as never,
      now: clockAtBeijing(),
      // 关掉账号之间的真实等待：这一条测的是「失败隔离」，而 800ms 的串行间隔
      // 已经由常量断言钉住（scheduler.test.ts），没必要在测试里真等 1.6 秒。
      config: { enabled: true, checkinHours: [9], claimBenefits: false, accountDelayMs: 0 },
    })
    const gained = await scheduler.runCheckinNow()
    expect(Object.keys(gained).sort()).toEqual(['a1', 'a3'])
    const report = scheduler.status().jobs.checkin
    expect(report.ok).toBe(2)
    expect(report.failed).toBe(1)
    expect(report.claimed).toBe(2)
    expect(report.credit).toBe(20)
    scheduler.dispose()
  })

  it('死凭据账号被排除在自动化之外（对它们发写请求只是把 401 变成日志噪声）', async () => {
    const pool = poolOf(account('a1'), account('a2'))
    pool.markCredentialDead('a2')
    const { client, calls } = fakeClient()
    const scheduler = schedulerOf(pool, client)
    await scheduler.runCheckinNow()
    // 只读了 a1 的状态。
    expect(calls.status).toBe(1)
    scheduler.dispose()
  })

  it('region 过滤只跑该区域的账号', async () => {
    const pool = poolOf(account('cn1'), account('g1', { region: 'global' }))
    const { client, calls } = fakeClient()
    const scheduler = schedulerOf(pool, client)
    await scheduler.runCheckinNow({ region: 'global' })
    expect(calls.status).toBe(1)
    scheduler.dispose()
  })

  it('enabled 为 false 时手动运行仍然可以跑（手动是用户明确要求）', async () => {
    const { client, calls } = fakeClient()
    const scheduler = schedulerOf(poolOf(account('a1')), client)
    // 默认就是 disabled，但按钮按下去要真的动。
    expect(scheduler.isEnabled()).toBe(false)
    await scheduler.runCheckinNow()
    expect(calls.status).toBe(1)
    scheduler.dispose()
  })

  it('运行结束后写回账本（日期与时段都落）', async () => {
    const { client } = fakeClient()
    const scheduler = schedulerOf(poolOf(account('a1')), client)
    await scheduler.runCheckinNow()
    const ledger = scheduler.ledger()
    expect(ledger.lastRunDate).toBe(dayKey(clockAtBeijing()()))
    expect(ledger.lastRunSlot).toBe('2026-03-15T10')
    scheduler.dispose()
  })
})

// ── 与池子的读数联动 ─────────────────────────────────────────────────────

describe('签到状态缓存进池子', () => {
  it('noteCheckin 之后卡片能读到同一份读数', () => {
    const pool = poolOf(account('a1'))
    pool.noteCheckin('a1', {
      active: true,
      todayCheckedIn: true,
      streakDays: 5,
      dailyCredit: 10,
      todayCredit: 10,
      isStreakDay: false,
      nextStreakDay: 6,
      streakBonusDays: 7,
      streakBonusCredit: 50,
    })
    expect(pool.find('a1')?.checkin?.todayCheckedIn).toBe(true)
    expect(pool.find('a1')?.checkin?.streakDays).toBe(5)
  })

  it('noteCheckin(undefined) 只清掉读数，不把账号踢出池子', () => {
    const pool = poolOf(account('a1'))
    pool.noteCheckin('a1', undefined)
    expect(pool.find('a1')?.checkin).toBeUndefined()
    expect(pool.find('a1')?.account.id).toBe('a1')
  })
})

// ── claimButtonText 的透传 ───────────────────────────────────────────────

describe('toCheckinStatus 的字段透传', () => {
  it('上游有 claimButtonText 才带上那个键（exactOptionalPropertyTypes）', async () => {
    const { toCheckinStatus } = await import('../src/probe.ts')
    const bare = toCheckinStatus(status())
    expect('claimButtonText' in bare).toBe(false)
    const labelled = toCheckinStatus(status({ claimButtonText: '立即签到' }))
    expect(labelled.claimButtonText).toBe('立即签到')
  })

  it('snake_case 的上游字段被翻成驼峰，且 false 不会被真值判断吞掉', async () => {
    const { toCheckinStatus } = await import('../src/probe.ts')
    const mapped = toCheckinStatus(status({ isStreakDay: false, todayCheckedIn: false }))
    expect(mapped.isStreakDay).toBe(false)
    expect(mapped.todayCheckedIn).toBe(false)
    expect(mapped.streakBonusCredit).toBe(50)
  })
})

// ── 节流 ─────────────────────────────────────────────────────────────────

describe('同一时钟小时内不重复启动', () => {
  it('非 force 的第二次运行直接返回空', async () => {
    const { client, calls } = fakeClient()
    const scheduler = schedulerOf(poolOf(account('a1')), client)
    await scheduler.runCheckinNow({ force: true })
    expect(calls.status).toBe(1)
    await scheduler.runCheckinNow({ force: false })
    // 仍然是 1：节流挡住了第二次。
    expect(calls.status).toBe(1)
    scheduler.dispose()
  })

  it('force 能穿透节流', async () => {
    const { client, calls } = fakeClient()
    const scheduler = schedulerOf(poolOf(account('a1')), client)
    await scheduler.runCheckinNow({ force: true })
    await scheduler.runCheckinNow({ force: true })
    expect(calls.status).toBe(2)
    scheduler.dispose()
  })
})

// ── 不静默 ───────────────────────────────────────────────────────────────

describe('失败要有可读文本', () => {
  it('单权益失败不打断其他权益，且原因进 detail', async () => {
    const client = {
      async fetchCheckinStatus(): Promise<WbUpstreamCheckin> {
        return status({ todayCheckedIn: true })
      },
      async claimDailyCheckin(): Promise<WbCheckinClaim> {
        return { credit: 0, streakDays: 0, isStreakDay: false }
      },
      async fetchBenefits(): Promise<readonly WbBenefit[]> {
        return [benefit({ kind: 'gift', creditNum: 20 }), benefit({ kind: 'compensation', creditNum: 30 })]
      },
      async claimBenefit(_credential: unknown, kind: 'compensation' | 'gift'): Promise<void> {
        if (kind === 'gift') throw new Error('gift endpoint 500')
      },
    }
    const scheduler = new WbScheduler({
      pool: poolOf(account('a1')),
      client: client as never,
      now: clockAtBeijing(),
      config: { enabled: true, checkinHours: [9], claimBenefits: true },
    })
    const gained = await scheduler.runCheckinNow()
    // 补偿那一条仍然领到了。
    expect(gained['a1']?.benefitCredit).toBe(30)
    const text = scheduler.status().jobs.checkin.detail?.join('\n') ?? ''
    expect(text).toContain('赠礼领取失败')
    expect(text).toContain('领取补偿 +30 积分')
    scheduler.dispose()
  })

  it('logger.warn 收到失败（不静默吞掉）', async () => {
    const warn = vi.fn()
    const client = {
      async fetchCheckinStatus(): Promise<WbUpstreamCheckin> {
        throw new Error('nope')
      },
      async claimDailyCheckin(): Promise<WbCheckinClaim> {
        return { credit: 0, streakDays: 0, isStreakDay: false }
      },
      async fetchBenefits(): Promise<readonly WbBenefit[]> {
        return []
      },
      async claimBenefit(): Promise<void> {},
    }
    const scheduler = new WbScheduler({
      pool: poolOf(account('a1')),
      client: client as never,
      now: clockAtBeijing(),
      logger: { warn },
    })
    await scheduler.runCheckinNow()
    expect(warn).toHaveBeenCalled()
    scheduler.dispose()
  })
})
