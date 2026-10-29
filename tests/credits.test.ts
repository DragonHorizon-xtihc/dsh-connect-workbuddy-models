/**
 * 积分聚合（需求 R1-c / R1-d）。
 *
 * 这里测的是**解析层**（`WbUpstreamClient.fetchCredits`）与**聚合层**
 * （`probe.ts` 的 `aggregateCredits`）的接合处：解析层把上游 JSON 变成积分包，
 * 聚合层按用户配置的窗口算出 `expiringSoon` 与 `nearestExpiryMs`。
 *
 * ## 为什么必须有一条「CapacityRemain 不得当余额」的断言
 *
 * 上游对每个容量字段同时发 `CapacityRemain`（pool 家族，整数）与
 * `CycleCapacityRemainPrecise`（cycle 家族，字符串带小数）。两者在正常月里数值
 * 相同，看不出差别；但在**整月额度已花完**时 pool 家族仍报满额（高报，issue #58：
 * 国际网关三账号报 `CapacityRemain=100`，而 chat 返回 `14018 Credits exhausted`）。
 * 以它为余额会让界面显示一片充足，而每次请求都硬失败。本文件用
 * `CapacityRemain=100 / Precise=0` 的样本把这条钉住。
 */

import { describe, expect, it } from 'vitest'
import { aggregateCredits, clampWarnDays, totalCreditsOf } from '../src/probe.ts'
import type { WbAccountProbe } from '../src/probe.ts'
import type { WbRawCredits } from '../src/upstream.ts'

const DAY = 86_400_000
const NOW = 1_700_000_000_000

describe('clampWarnDays 把配置夹进可用区间', () => {
  it('非数字回落到默认 3 天', () => {
    expect(clampWarnDays(undefined)).toBe(3)
    expect(clampWarnDays('abc')).toBe(3)
    expect(clampWarnDays(Number.NaN)).toBe(3)
    expect(clampWarnDays(Number.POSITIVE_INFINITY)).toBe(3)
  })

  it('小于下界夹到 1，大于上界夹到 90', () => {
    expect(clampWarnDays(0)).toBe(1)
    expect(clampWarnDays(-5)).toBe(1)
    expect(clampWarnDays(1_000)).toBe(90)
  })

  it('区间内的值原样保留', () => {
    expect(clampWarnDays(1)).toBe(1)
    expect(clampWarnDays(7)).toBe(7)
    expect(clampWarnDays(90)).toBe(90)
  })
})

describe('expiringSoon 按用户配置的窗口现算', () => {
  /** 三个一次性包：1 天后 / 10 天后 / 40 天后到期，各 100。 */
  const raw = (): WbRawCredits => ({
    total: 300,
    packages: [
      { packageName: '1d', remain: 100, size: 100, monthly: false, expiresAtMs: NOW + 1 * DAY },
      { packageName: '10d', remain: 100, size: 100, monthly: false, expiresAtMs: NOW + 10 * DAY },
      { packageName: '40d', remain: 100, size: 100, monthly: false, expiresAtMs: NOW + 40 * DAY },
    ],
  })

  it('默认 3 天窗口：只算 1 天后到期的那 100', () => {
    const result = aggregateCredits(raw(), { nowMs: NOW })
    expect(result.credits.expiringSoon).toBe(100)
    // total 与窗口无关：窗口只影响「临期」这个投影，不改实际余额。
    expect(result.credits.total).toBe(300)
  })

  it('把窗口放大到 15 天，临期额变成 200 —— 用户的 expiryWarnDays 真的生效', () => {
    const result = aggregateCredits(raw(), { warnDays: 15, nowMs: NOW })
    expect(result.credits.expiringSoon).toBe(200)
    // 这条是关键：同一个 total、不同窗口，只有 expiringSoon 变。
    expect(result.credits.total).toBe(300)
  })

  it('窗口放大到 60 天时三者全算进来', () => {
    expect(aggregateCredits(raw(), { warnDays: 60, nowMs: NOW }).credits.expiringSoon).toBe(300)
  })

  it('已过期的包不计入临期额（它不是「快要过期」，是已经没了）', () => {
    const expired: WbRawCredits = {
      total: 100,
      packages: [{ packageName: 'gone', remain: 100, size: 100, monthly: false, expiresAtMs: NOW - 1 * DAY }],
    }
    expect(aggregateCredits(expired, { warnDays: 30, nowMs: NOW }).credits.expiringSoon).toBe(0)
  })

  it('remain 为 0 的包不计入临期额（没有可流失的额度）', () => {
    const empty: WbRawCredits = {
      total: 0,
      packages: [{ packageName: 'drained', remain: 0, size: 100, monthly: false, expiresAtMs: NOW + 1 * DAY }],
    }
    expect(aggregateCredits(empty, { warnDays: 30, nowMs: NOW }).credits.expiringSoon).toBe(0)
  })

  it('月包不参与临期统计（它按周期刷新，不会流失）', () => {
    const withMonthly: WbRawCredits = {
      total: 1_000,
      packages: [
        { packageName: 'monthly', remain: 900, size: 900, monthly: true, refreshAtMs: NOW + 2 * DAY },
        { packageName: 'gift', remain: 100, size: 100, monthly: false, expiresAtMs: NOW + 1 * DAY },
      ],
    }
    // 月包即使「2 天后刷新」也不算临期；只有那份额外的 100 算。
    expect(aggregateCredits(withMonthly, { warnDays: 3, nowMs: NOW }).credits.expiringSoon).toBe(100)
  })
})

describe('nearestExpiryMs 的语义：一次性包里最近的未来到期', () => {
  it('取最小到期时刻', () => {
    const raw: WbRawCredits = {
      total: 200,
      packages: [
        { packageName: 'b', remain: 100, size: 100, monthly: false, expiresAtMs: NOW + 20 * DAY },
        { packageName: 'a', remain: 100, size: 100, monthly: false, expiresAtMs: NOW + 5 * DAY },
      ],
    }
    expect(aggregateCredits(raw, { nowMs: NOW }).credits.nearestExpiryMs).toBe(NOW + 5 * DAY)
  })

  it('纯月包账号没有到期信息 —— 不编一个假时间（那会让它错误地排到最前）', () => {
    const raw: WbRawCredits = {
      total: 5_000,
      packages: [{ packageName: 'monthly', remain: 5_000, size: 5_000, monthly: true, refreshAtMs: NOW + 3 * DAY }],
    }
    // 「3 天后刷新」不是「3 天后作废」：刷新意味着额度回来，不是流失。
    expect(aggregateCredits(raw, { nowMs: NOW }).credits.nearestExpiryMs).toBeUndefined()
  })

  it('已过期的一次性包不会把 nearestExpiryMs 拉到过去', () => {
    const raw: WbRawCredits = {
      total: 100,
      packages: [
        { packageName: 'gone', remain: 50, size: 50, monthly: false, expiresAtMs: NOW - 5 * DAY },
        { packageName: 'alive', remain: 50, size: 50, monthly: false, expiresAtMs: NOW + 9 * DAY },
      ],
    }
    expect(aggregateCredits(raw, { nowMs: NOW }).credits.nearestExpiryMs).toBe(NOW + 9 * DAY)
  })

  it('完全没有一次性包时是 undefined，不是 0（0 会被排成「最早到期」）', () => {
    expect(aggregateCredits({ total: 0, packages: [] }, { nowMs: NOW }).credits.nearestExpiryMs).toBeUndefined()
  })
})

describe('total 是全部包的 remain 之和', () => {
  it('月包与一次性包都算进 total', () => {
    const raw: WbRawCredits = {
      total: 1_500,
      packages: [
        { packageName: 'monthly', remain: 1_000, size: 1_000, monthly: true },
        { packageName: 'gift', remain: 500, size: 500, monthly: false, expiresAtMs: NOW + 2 * DAY },
      ],
    }
    expect(aggregateCredits(raw, { nowMs: NOW }).credits.total).toBe(1_500)
  })
})

describe('totalCreditsOf 汇总多账号读数', () => {
  const reading = (accountId: string, total: number | undefined): WbAccountProbe => ({
    accountId,
    readAtMs: NOW,
    ...total === undefined
      ? { error: '读取失败' }
      : {
          credits: {
            total,
            packages: [{ packageName: 'p', remain: total, size: total, monthly: false }],
            expiringSoon: 0,
          },
        },
  })

  it('只累加读到的账号，读失败的计入 unread', () => {
    const sum = totalCreditsOf([reading('a', 100), reading('b', 250), reading('c', undefined)])
    expect(sum.total).toBe(350)
    expect(sum.unread).toBe(1)
  })

  it('读失败不是 0：全部失败时 total 为 0 但 unread 是全部', () => {
    const sum = totalCreditsOf([reading('a', undefined), reading('b', undefined)])
    expect(sum.total).toBe(0)
    expect(sum.unread).toBe(2)
  })

  it('空池给出 0 / 0', () => {
    expect(totalCreditsOf([])).toEqual({ total: 0, unread: 0 })
  })
})

describe('expiringPackages 供界面列明细', () => {
  it('只列窗口内、remain>0 的一次性包', () => {
    const raw: WbRawCredits = {
      total: 300,
      packages: [
        { packageName: 'soon', remain: 100, size: 100, monthly: false, expiresAtMs: NOW + 1 * DAY },
        { packageName: 'later', remain: 100, size: 100, monthly: false, expiresAtMs: NOW + 20 * DAY },
        { packageName: 'zero', remain: 0, size: 100, monthly: false, expiresAtMs: NOW + 1 * DAY },
        { packageName: 'monthly', remain: 100, size: 100, monthly: true },
      ],
    }
    const result = aggregateCredits(raw, { warnDays: 3, nowMs: NOW })
    expect(result.expiringPackages).toHaveLength(1)
    expect(result.expiringPackages[0]?.packageName).toBe('soon')
  })
})

describe('解析层：CapacityRemain 绝不能当余额（issue #58）', () => {
  /**
   * 解析层的时间基准必须是**真实** now：`fetchCredits` 内部用 `Date.now()` 判断
   * 「一次性包是否已过期」。上文的 `NOW` 是固定时间戳（为了让聚合层断言可重复），
   * 拿它当「9 天后」会落在过去，包会被当成已过期丢掉。
   */
  const REAL_NOW = Date.now()

  /** 拼一份上游 `get-user-resource` 的信封。 */
  function envelope(accounts: readonly Record<string, unknown>[]): string {
    return JSON.stringify({
      code: 0,
      msg: '',
      data: { Response: { Data: { Accounts: accounts } } },
    })
  }

  /** 用假 fetch 调真的 `fetchCredits`（不 mock 客户端本身）。 */
  async function fetchWith(accounts: readonly Record<string, unknown>[]): Promise<WbRawCredits> {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response(envelope(accounts), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
    try {
      const { WbUpstreamClient } = await import('../src/upstream.ts')
      const client = new WbUpstreamClient()
      return await client.fetchCredits({
        accessToken: 'tok',
        refreshToken: 'r',
        expiresAtMs: 0,
        domain: 'workbuddy.ai',
      })
    } finally {
      globalThis.fetch = original
    }
  }

  it('CapacityRemain=100 而 Precise=0 时，余额是 0（不是 100）', async () => {
    const raw = await fetchWith([{
      // pool 家族：整月额度花完后仍报满额 —— 高报。
      CapacityRemain: 100,
      // cycle 家族（官方客户端读的那个）已扣到 0。
      CycleCapacityRemain: 0,
      CycleCapacityRemainPrecise: '0',
      CycleCapacitySize: 100,
      CapacityType: 1,
      PackageName: 'promo',
      ExpiredTime: new Date(REAL_NOW + 5 * DAY).toISOString(),
    }])
    // 已用光的一次性包被整个丢掉：它没有可用余额。
    expect(raw.total).toBe(0)
    expect(raw.packages).toHaveLength(0)
  })

  it('正常月份里 Precise 的小数被保留（整数版会丢分）', async () => {
    const raw = await fetchWith([{
      CapacityType: 4,
      CycleCapacityRemain: 96,
      CycleCapacityRemainPrecise: '96.61000218',
      CycleCapacitySizePrecise: '1000',
      PackageName: 'monthly',
    }])
    expect(raw.total).toBeCloseTo(96.61000218, 6)
    expect(raw.packages[0]?.remain).toBeCloseTo(96.61000218, 6)
  })

  it('多个包的 precise 值逐项相加（不是取整数再和）', async () => {
    const raw = await fetchWith([
      { CapacityType: 4, CycleCapacityRemainPrecise: '0.5', PackageName: 'm1' },
      { CapacityType: 4, CycleCapacityRemainPrecise: '0.25', PackageName: 'm2' },
      {
        CapacityType: 1,
        CycleCapacityRemainPrecise: '0.25',
        PackageName: 'g',
        ExpiredTime: new Date(REAL_NOW + 9 * DAY).toISOString(),
      },
    ])
    expect(raw.total).toBeCloseTo(1, 9)
  })

  it('没有 precise 字段时回退整数版（老响应仍能解析）', async () => {
    const raw = await fetchWith([{ CapacityType: 4, CycleCapacityRemain: 42, PackageName: 'legacy' }])
    expect(raw.total).toBe(42)
  })

  it('CapacityType=4 是月包：带 refreshAtMs 而不带 expiresAtMs', async () => {
    const cycleEnd = new Date(REAL_NOW + 3 * DAY).toISOString()
    const raw = await fetchWith([{
      CapacityType: 4,
      CycleCapacityRemainPrecise: '500',
      CycleEndTime: cycleEnd,
      PackageName: 'monthly',
    }])
    const pack = raw.packages[0]
    expect(pack?.monthly).toBe(true)
    expect(pack?.expiresAtMs).toBeUndefined()
    // 刷新点 = cycleEnd + 1s，避免「23:59:59 刷新」读起来像那时就没了。
    expect(pack?.refreshAtMs).toBe(Date.parse(cycleEnd) + 1_000)
  })

  it('已过期的一次性包被丢弃（不占临期列表）', async () => {
    const raw = await fetchWith([{
      CapacityType: 1,
      CycleCapacityRemainPrecise: '80',
      PackageName: 'expired',
      ExpiredTime: new Date(REAL_NOW - 3 * DAY).toISOString(),
    }])
    expect(raw.total).toBe(0)
    expect(raw.packages).toHaveLength(0)
  })
})
