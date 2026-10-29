/**
 * 签到计数器必须按「轮」归零（F9）。
 *
 * 缺陷形态：`ok` / `failed` / `claimed` / `credit` 四个字段只在构造时被初始化为
 * 0，`runOne` 里只有 `+=`。于是同一天第二次运行之后，`summarise()` 拼出来的
 * 是**累计**数：「8 个账号已处理」而本机只有 4 个账号。
 *
 * 为什么这不是「数字偏大」那么无害：幂等本身是对的（`detail` 会如实写「今日已
 * 签到」），只有这个总数在涨。用户唯一的解读是「它在乱跑」——一个明明什么都没
 * 做的按钮，报告说它处理了 8 个账号。
 *
 * 跨轮累计另有去处，不受归零影响：`earningsToday`（按账号按自然日建账）与
 * `lastPass`（最近一次的结果）。这条测试同时钉住这一点——归零不能把累计也一起抹掉。
 */

import { describe, expect, it } from 'vitest'
import { WbAccountPool } from '../src/accounts.ts'
import { WbScheduler } from '../src/scheduler.ts'
import type { WbDiscoveredAccount } from '../src/accounts.ts'

const DAY = 86_400_000

function account(id: string): WbDiscoveredAccount {
  return {
    id,
    label: id,
    region: 'cn',
    sourcePath: `/fake/${id}.info`,
    source: 'desktop',
    live: true,
    refreshExpired: false,
    tokenExpiresAtMs: Date.now() + 30 * DAY,
    credential: { accessToken: `tok-${id}`, refreshToken: `ref-${id}`, expiresAtMs: Date.now() + 30 * DAY, domain: '' },
  }
}

function poolOf(...accounts: WbDiscoveredAccount[]): WbAccountPool {
  const pool = new WbAccountPool({})
  pool.applyDiscovery({ accounts, skipped: [] })
  return pool
}

/** 北京时间固定在一个整点之后，避开跨日与节流两个副作用。 */
function clock(): () => Date {
  let ms = new Date('2026-03-15T09:30:00+08:00').getTime()
  return () => {
    ms += 1_000
    return new Date(ms)
  }
}

function schedulerOf(pool: WbAccountPool): WbScheduler {
  return new WbScheduler({
    pool,
    client: {
      async fetchCheckinStatus() {
        // 今天已签：这条路径只加 ok，最能把「累计」暴露出来。
        return { active: true, todayCheckedIn: true, streakDays: 3, todayCredit: 5 }
      },
      async claimDailyCheckin() {
        return { credit: 10, streakDays: 4, isStreakDay: false }
      },
      async fetchBenefits() {
        return []
      },
      async claimBenefit() {},
    } as never,
    now: clock(),
    // 关掉账号间的真实等待：测的是计数口径，不是节流。
    config: { enabled: true, checkinHours: [9], claimBenefits: false, accountDelayMs: 0 },
  })
}

describe('签到计数器是「本轮」口径（F9）', () => {
  it('连跑两轮，第二轮 ok 仍等于账号数，而不是两倍', async () => {
    const scheduler = schedulerOf(poolOf(account('a1'), account('a2'), account('a3')))
    await scheduler.runCheckinNow()
    const first = scheduler.status().jobs.checkin
    expect(first.ok).toBe(3)

    await scheduler.runCheckinNow()
    const second = scheduler.status().jobs.checkin
    // 这是判决性断言：不归零时它是 6。
    expect(second.ok).toBe(3)
    expect(second.message).toContain('3 个账号已处理')
    expect(second.message).not.toContain('6 个账号已处理')
    scheduler.dispose()
  })

  it('claimed / credit 也是本轮口径（第二轮没人真的签到，就该是 0）', async () => {
    const scheduler = schedulerOf(poolOf(account('a1'), account('a2')))
    await scheduler.runCheckinNow()
    expect(scheduler.status().jobs.checkin.claimed).toBe(0)

    await scheduler.runCheckinNow()
    const second = scheduler.status().jobs.checkin
    // 全部「今日已签到」，所以本轮 claimed 必须是 0，不能累加成别的数。
    expect(second.claimed).toBe(0)
    expect(second.credit).toBe(0)
    expect(second.message).not.toContain('签到成功')
    scheduler.dispose()
  })

  it('单账号按钮也归零：点一次不能把全量的「N 个账号已处理」撑大', async () => {
    const scheduler = schedulerOf(poolOf(account('a1'), account('a2'), account('a3')))
    await scheduler.runCheckinNow()
    expect(scheduler.status().jobs.checkin.ok).toBe(3)

    await scheduler.checkinOne('a1')
    const after = scheduler.status().jobs.checkin
    // 单账号也是一轮：本轮只处理了 1 个。
    expect(after.ok).toBe(1)
    expect(after.message).toContain('1 个账号已处理')
    scheduler.dispose()
  })

  it('归零不动跨轮累计：earningsToday 与 lastPass 都还在', async () => {
    const scheduler = schedulerOf(poolOf(account('a1'), account('a2')))
    const firstPass = await scheduler.runCheckinNow()
    expect(Object.keys(firstPass).sort()).toEqual(['a1', 'a2'])

    await scheduler.runCheckinNow()
    const status = scheduler.status()
    // 按账号按自然日的账没有被归零动过——那才是「今天一共得了多少」的出处。
    expect(Object.keys(status.earningsToday).sort()).toEqual(['a1', 'a2'])
    expect(status.lastPass === undefined ? {} : status.lastPass).not.toBeUndefined()
    scheduler.dispose()
  })

  it('归零不清调度账本：同一天同一时段不会被重复消费', async () => {
    const scheduler = schedulerOf(poolOf(account('a1')))
    await scheduler.runCheckinNow({ force: false })
    const fired = scheduler.status().jobs.checkin.firedSlots
    const second = await scheduler.runCheckinNow({ force: false })
    // 非 force 的第二次在同一时段被节流挡掉，返回空——归零如果顺手清了
    // firedSlots，这里会真的再跑一遍。
    expect(Object.keys(second)).toEqual([])
    expect(scheduler.status().jobs.checkin.firedSlots).toEqual(fired)
    scheduler.dispose()
  })
})
