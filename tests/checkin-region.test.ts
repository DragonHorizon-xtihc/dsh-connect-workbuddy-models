/**
 * 签到只作用于国内版账号（缺陷 C，P1）。
 *
 * 这个文件锁的不是「有没有传 region」，而是**范围由被调方收口**这件事本身：
 *
 * `scheduler.runCheckin` 在入口把范围归一成 `CHECKIN_REGION`（`'cn'`），因此
 * **`undefined` 不再表示「全池」**。改前的形态是：状态路由的
 * `runCheckinNow({ force: true })` 与定时 tick 的 `runCheckin(undefined, true)`
 * 都不传区域，`eligibleAccounts(undefined)` 的过滤分支随即整段跳过，于是国际版账号
 * 也被送到国内 billing 端点——真机表现是 `detail` 有 4 条而该区域只有 3 个账号，第
 * 一条是国际版账号的「签到活动未开启」。
 *
 * 为什么必须在被调方而不是调用点修：调用点有三处（状态路由、定时器、将来可能还有
 * 卡片按钮），靠自觉总会漏一个；收口后漏传只会退化成本该如此的行为。所以本文件
 * 刻意**从三个不同入口**（不传区域 / 传 global / 定时 tick）各打一次，全部要求只碰
 * cn 账号。
 *
 * 判据用「上游被调用的凭据」而不是「返回了几个 gain」：断言 `detail.length` 只能证明
 * 汇总行数，证明不了**国际版账号一次都没被请求过**。假 client 把每次调用的
 * `accessToken` 记下来，`tok-global` 出现即失败——这是本缺陷唯一不可伪造的证据形态。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WbAccountPool } from '../src/accounts.ts'
import type { WbDiscoveredAccount } from '../src/accounts.ts'
import { CHECKIN_REGION } from '../src/status-paths.ts'
import { WbScheduler } from '../src/scheduler.ts'
import type { WbBenefit, WbCheckinClaim, WbUpstreamCheckin } from '../src/upstream.ts'

const DAY = 86_400_000

/** 最小账号。`accessToken` 编码 region，用来把上游调用归因到具体账号。 */
function account(id: string, region: 'cn' | 'global'): WbDiscoveredAccount {
  return {
    id,
    label: `${id}-label`,
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

/**
 * 与真机同形的池：3 个 cn + 1 个 global。
 *
 * id 取真机那四个，是为了让失败信息能直接和 Lead 的 3098 读数对上（例如出现
 * `27e8f3bc23d65074` 就说明国际版被签了）。
 */
function machineLikePool(): WbAccountPool {
  const pool = new WbAccountPool({})
  pool.applyDiscovery({
    accounts: [
      account('33dc53cb024cbaed', 'cn'),
      account('51c39655c9b6a363', 'cn'),
      account('bbf8054a7c091d65', 'cn'),
      account('27e8f3bc23d65074', 'global'),
    ],
    skipped: [],
  })
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

function benefit(overrides: Partial<WbBenefit> = {}): WbBenefit {
  return { kind: 'gift', active: true, claimed: false, creditNum: 5, ...overrides }
}

/**
 * 记数并**记凭据**的假上游。
 *
 * `tokens` 是本文件的核心：签到是否碰到国际版账号，唯一可靠的判据是「有没有拿
 * `tok-global` 去请求上游」。只看 `detail` 里有没有那个名字是不够的——将来文案改动
 * 会让名字匹配失效，而凭据不会。
 */
function fakeClient(options: { status?: WbUpstreamCheckin; benefits?: readonly WbBenefit[] } = {}) {
  const tokens = { status: [] as string[], claimDaily: [] as string[], benefits: [] as string[], claimBenefit: [] as string[] }
  const client = {
    async fetchCheckinStatus(credential: { accessToken: string }): Promise<WbUpstreamCheckin> {
      tokens.status.push(credential.accessToken)
      return options.status ?? status()
    },
    async claimDailyCheckin(credential: { accessToken: string }): Promise<WbCheckinClaim> {
      tokens.claimDaily.push(credential.accessToken)
      return { credit: 10, streakDays: 2, isStreakDay: false }
    },
    async fetchBenefits(credential: { accessToken: string }): Promise<readonly WbBenefit[]> {
      tokens.benefits.push(credential.accessToken)
      return options.benefits ?? []
    },
    async claimBenefit(credential: { accessToken: string }): Promise<void> {
      tokens.claimBenefit.push(credential.accessToken)
    },
  }
  return { client, tokens }
}

/** 某日某时（北京时）的时钟。 */
function beijing(day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 2, day, hour - 8, minute, 0))
}

function schedulerOf(pool: WbAccountPool, client: unknown, options: { claimBenefits?: boolean; now?: () => Date } = {}): WbScheduler {
  return new WbScheduler({
    pool,
    client: client as never,
    now: options.now ?? (() => beijing(15, 10)),
    config: {
      enabled: true,
      checkinHours: [9],
      claimBenefits: options.claimBenefits ?? false,
      accountDelayMs: 0,
    },
  })
}

// ── 常量本身 ─────────────────────────────────────────────────────────────

describe('CHECKIN_REGION 是领域常量', () => {
  it("值是 'cn'，且与 WB_REGIONS 里的国内版一致", () => {
    // 这条不是为了覆盖率：它把「签到的区域」钉成一个可被引用的名字。若哪天有人
    // 把常量改成 'global'，本文件其余用例会一起红，失败信息直接指向这里。
    expect(CHECKIN_REGION).toBe('cn')
  })
})

// ── 三个入口都必须只碰 cn ────────────────────────────────────────────────

describe('全量签到只作用于国内版账号', () => {
  it('不传 region（改前等于全池）：detail 只有 3 条，且一次都没请求过国际版凭据', async () => {
    const { client, tokens } = fakeClient()
    const scheduler = schedulerOf(machineLikePool(), client)

    const gained = await scheduler.runCheckinNow({})

    // 改前：4 个账号全进，detail 4 条、tok-global 出现在 tokens.status 里。
    expect(Object.keys(gained).sort()).toEqual(['33dc53cb024cbaed', '51c39655c9b6a363', 'bbf8054a7c091d65'])
    expect(tokens.status).toEqual(['tok-cn', 'tok-cn', 'tok-cn'])
    expect(tokens.status).not.toContain('tok-global')

    const jobs = scheduler.status().jobs.checkin
    expect(jobs.detail).toHaveLength(3)
    expect(jobs.ok).toBe(3)
    expect(jobs.claimed).toBe(3)
    expect(jobs.detail?.some(line => line.includes('27e8f3bc23d65074'))).toBe(false)
    expect(jobs.detail?.some(line => line.includes('dragonhorizon'))).toBe(false)
  })

  it("显式传 'global' 也只处理国内版（调用方要不到别的区域，但不报错）", async () => {
    const { client, tokens } = fakeClient()
    const scheduler = schedulerOf(machineLikePool(), client)

    // 这里传的是一个「不可能满足」的请求：签到没有国际版。正确行为是把范围收口回
    // cn，而不是照做（签国际版）或整轮拒绝（用户的按钮会变成红字）。
    const gained = await scheduler.runCheckinNow({ region: 'global' })

    expect(Object.keys(gained).sort()).toEqual(['33dc53cb024cbaed', '51c39655c9b6a363', 'bbf8054a7c091d65'])
    expect(tokens.status).toEqual(['tok-cn', 'tok-cn', 'tok-cn'])
    expect(tokens.status).not.toContain('tok-global')
    expect(scheduler.status().jobs.checkin.detail).toHaveLength(3)
  })

  it("显式传 'cn' 处理 3 个（正向对照：收口没有把范围收成空集）", async () => {
    const { client, tokens } = fakeClient()
    const scheduler = schedulerOf(machineLikePool(), client)

    const gained = await scheduler.runCheckinNow({ region: 'cn' })

    expect(Object.keys(gained)).toHaveLength(3)
    expect(tokens.status).toHaveLength(3)
    expect(tokens.claimDaily).toHaveLength(3)
  })

  it('定时 tick 路径同样只处理 3 个（改前 tick 固定传 undefined）', async () => {
    vi.useFakeTimers()
    try {
      const { client, tokens } = fakeClient()
      const scheduler = new WbScheduler({
        pool: machineLikePool(),
        client: client as never,
        now: () => new Date(),
        config: { enabled: true, checkinHours: [9], claimBenefits: false, accountDelayMs: 0 },
      })
      vi.setSystemTime(beijing(15, 9, 0))
      scheduler.start()
      await vi.advanceTimersByTimeAsync(60_000)
      scheduler.dispose()

      expect(tokens.status).toEqual(['tok-cn', 'tok-cn', 'tok-cn'])
      expect(tokens.status).not.toContain('tok-global')
      expect(scheduler.status().jobs.checkin.detail).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── 权益端点同样不能被国际版触发 ─────────────────────────────────────────

describe('权益领取不被国际版账号触发', () => {
  it('claimBenefits 开着时，权益端点也只收到国内版凭据', async () => {
    // 缺陷的第三条受害面：`runOne` 里只要国际版的 `status.active` 为真（上游行为会
    // 变），就会走到 `claimBenefitsOf` 打权益端点。修 region 过滤应当一并挡掉，不必
    // 单独给权益加一层 region 判断——本用例钉住「不必单独改」这个结论。
    const { client, tokens } = fakeClient({ benefits: [benefit()] })
    const scheduler = schedulerOf(machineLikePool(), client, { claimBenefits: true })

    await scheduler.runCheckinNow({})

    expect(tokens.benefits).toEqual(['tok-cn', 'tok-cn', 'tok-cn'])
    expect(tokens.benefits).not.toContain('tok-global')
    expect(tokens.claimBenefit).toEqual(['tok-cn', 'tok-cn', 'tok-cn'])
    expect(tokens.claimBenefit).not.toContain('tok-global')
  })
})

// ── 收口不改变 cn 侧的既有行为 ───────────────────────────────────────────

describe('收口不误伤国内版', () => {
  it('全部已签到时仍是 3 条「今日已签到」，且不计入 claimed', async () => {
    const { client } = fakeClient({ status: status({ todayCheckedIn: true }) })
    const scheduler = schedulerOf(machineLikePool(), client)

    await scheduler.runCheckinNow({})

    const jobs = scheduler.status().jobs.checkin
    expect(jobs.detail).toHaveLength(3)
    expect(jobs.detail?.every(line => line.includes('今日已签到'))).toBe(true)
    expect(jobs.claimed).toBe(0)
  })

  it('活动未开启时不产生 claim，但仍算一个已处理账号', async () => {
    const { client, tokens } = fakeClient({ status: status({ active: false }) })
    const scheduler = schedulerOf(machineLikePool(), client)

    await scheduler.runCheckinNow({})

    const jobs = scheduler.status().jobs.checkin
    expect(tokens.claimDaily).toEqual([])
    expect(jobs.ok).toBe(3)
    expect(jobs.detail).toHaveLength(3)
  })
})

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})
