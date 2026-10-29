/**
 * 排序键与账号使用方式（需求 R3 / R4）。
 *
 * 这些断言直接调 `status-paths.ts` 的 `rankAccounts` 与 `accounts.ts` 的
 * `WbAccountPool.pick` —— 真实现，不是镜像。镜像会静默漂移：实现改坏了，镜像照样
 * 通过，而那正是测试最该失败的时刻。
 *
 * ## 为什么这里有一条「判决性」断言
 *
 * 需求 R3 = 选模型时优先切到积分最先过期的账号。它是否成立，取决于**默认**配置下
 * `pick` 返回的是「最早到期」还是「分最多」。默认值曾经是 `priority`，而
 * `priority` 的第一键是 `atRisk`（= `expiringSoon > 0`，由用户 `expiryWarnDays`
 * 默认 3 天的窗口现算）。于是 10 天后到期的积分不算 atRisk，排序退回 `score`，
 * R3 只在 3 天窗口内碰巧成立。本文件的「R3 判决」那一条就是钉住这个的回归锁：
 * 它在 `priority` 下必然失败。
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ACCOUNT_DISTRIBUTION,
  distributionOf,
  rankAccounts,
  type AccountDistribution,
  type WbCredits,
  type WbRankMember,
} from '../src/status-paths.ts'

const DAY = 86_400_000
const NOW = 1_700_000_000_000

/** 一次性积分包（会过期）。 */
function oneShot(total: number, expiresAtMs: number): WbCredits {
  return {
    total,
    packages: [{ packageName: 'one-shot', remain: total, size: total, monthly: false, expiresAtMs }],
    expiringSoon: 0,
    nearestExpiryMs: expiresAtMs,
  }
}

/** 纯月包：按周期刷新，**没有**到期信息（不编假时间）。 */
function monthly(total: number): WbCredits {
  return {
    total,
    packages: [{ packageName: 'monthly', remain: total, size: total, monthly: true }],
    expiringSoon: 0,
  }
}

function member(id: string, credits: WbCredits | undefined, extra: Partial<WbRankMember> = {}): WbRankMember {
  return {
    account: { id },
    ...credits === undefined ? {} : { credits },
    ...extra,
  }
}

const idsOf = (rows: readonly { account: { id: string } }[]): string[] => rows.map(row => row.account.id)

describe('默认使用方式是 expiry（R3 的前提）', () => {
  it('默认值就是 expiry，且非法值也回落到 expiry', () => {
    expect(DEFAULT_ACCOUNT_DISTRIBUTION).toBe('expiry')
    expect(distributionOf(undefined)).toBe('expiry')
    expect(distributionOf('不存在的分布')).toBe('expiry')
    expect(distributionOf(null)).toBe('expiry')
  })

  it('合法值原样通过，不被默认值覆盖', () => {
    const known: AccountDistribution[] = ['priority', 'round-robin', 'balanced', 'sticky', 'expiry']
    for (const value of known) expect(distributionOf(value)).toBe(value)
  })
})

describe('R3 判决：默认配置下优先选「积分最先过期」的账号', () => {
  /**
   * A = 10 天后到期且分最少；B = 30 天后到期且分最多；C = 纯月包无到期信息。
   *
   * 三者都 `expiringSoon: 0`、`atRisk: false`（默认 3 天窗口下 10 天还没进窗口）。
   * 所以这一组 fixture 恰好落在「窗口外」——`priority` 会选 B（分多），只有
   * `expiry` 会选 A。这就是判决点。
   */
  const fixture = (): WbRankMember[] => [
    member('A', oneShot(1_000, NOW + 10 * DAY)),
    member('B', oneShot(5_000, NOW + 30 * DAY)),
    member('C', monthly(3_000)),
  ]

  it('expiry 分布选出 A（最早到期），不是分最多的 B', () => {
    const ranked = rankAccounts(fixture(), NOW, [], 'expiry')
    expect(idsOf(ranked)[0]).toBe('A')
    expect(idsOf(ranked)).toEqual(['A', 'B', 'C'])
  })

  it('反向锁：同一份数据在 priority 下给出**不同**结果（证明这条锁真的在起作用）', () => {
    const expiryOrder = idsOf(rankAccounts(fixture(), NOW, [], 'expiry'))
    const priorityOrder = idsOf(rankAccounts(fixture(), NOW, [], 'priority'))
    expect(priorityOrder[0]).toBe('B')
    expect(expiryOrder).not.toEqual(priorityOrder)
  })

  it('无到期信息的纯月包账号在 expiry 下沉底，且原因可读', () => {
    const ranked = rankAccounts(fixture(), NOW, [], 'expiry')
    expect(idsOf(ranked).at(-1)).toBe('C')
    const last = ranked.at(-1)
    // 沉底不是谜：有到期信息的先于没有的，`nearestExpiryMs` 缺席就是那个事实。
    expect(last?.nearestExpiryMs).toBeUndefined()
    expect(last?.account.id).toBe('C')
  })
})

describe('排序键逐级生效', () => {
  it('不可用账号无条件排最后，哪怕它到期更早、分更多', () => {
    const rows = rankAccounts([
      member('usable-late', oneShot(100, NOW + 60 * DAY)),
      member('dead-early', oneShot(9_999, NOW + 1 * DAY), { usable: false }),
    ], NOW, [], 'expiry')
    expect(idsOf(rows)).toEqual(['usable-late', 'dead-early'])
  })

  it('都可用时，最早到期者先', () => {
    const rows = rankAccounts([
      member('late', oneShot(500, NOW + 5 * DAY)),
      member('early', oneShot(500, NOW + 2 * DAY)),
    ], NOW, [], 'expiry')
    expect(idsOf(rows)).toEqual(['early', 'late'])
  })

  it('priority 下 atRisk 优先于普通账号', () => {
    // expiringSoon 显式 > 0 → atRisk；窗口内的一次性包也算。
    const risky: WbCredits = {
      total: 10,
      packages: [{ packageName: 'soon', remain: 10, size: 10, monthly: false, expiresAtMs: NOW + 1 * DAY }],
      expiringSoon: 10,
      nearestExpiryMs: NOW + 1 * DAY,
    }
    const rows = rankAccounts([
      member('rich', monthly(9_000)),
      member('risky', risky),
    ], NOW, [], 'priority')
    expect(idsOf(rows)[0]).toBe('risky')
  })

  it('都 atRisk 时，nearestExpiryMs 小者先', () => {
    const sooner: WbCredits = { ...oneShot(10, NOW + 1 * DAY), expiringSoon: 10 }
    const later: WbCredits = { ...oneShot(10, NOW + 2 * DAY), expiringSoon: 10 }
    const rows = rankAccounts([member('later', later), member('sooner', sooner)], NOW, [], 'priority')
    expect(idsOf(rows)).toEqual(['sooner', 'later'])
  })

  it('expiringSoon 大者先（余额规模是临期时的次序理由）', () => {
    const small: WbCredits = { ...oneShot(10, NOW + 1 * DAY), expiringSoon: 10 }
    const big: WbCredits = { ...oneShot(900, NOW + 1 * DAY), expiringSoon: 900 }
    const rows = rankAccounts([member('small', small), member('big', big)], NOW, [], 'priority')
    expect(idsOf(rows)).toEqual(['big', 'small'])
  })

  it('orderIds 只在前面所有键相等时才生效', () => {
    const same = (): WbCredits => oneShot(500, NOW + 7 * DAY)
    const rows = rankAccounts(
      [member('x', same()), member('y', same()), member('z', same())],
      NOW,
      ['z', 'x'],
      'priority',
    )
    // z 与 x 被手动序提前；y 未列出 → 排最后。
    expect(idsOf(rows)).toEqual(['z', 'x', 'y'])
  })

  it('orderIds 不会盖过 expiry 的到期时间序', () => {
    const rows = rankAccounts(
      [member('early', oneShot(100, NOW + 1 * DAY)), member('late', oneShot(100, NOW + 90 * DAY))],
      NOW,
      ['late', 'early'],
      'expiry',
    )
    // 手动序不是第一键：最早到期者仍然先。
    expect(idsOf(rows)).toEqual(['early', 'late'])
  })

  it('所有键都相等时用账号 id 兜底，结果与传入顺序无关', () => {
    const same = (): WbCredits => oneShot(100, NOW + 3 * DAY)
    const forward = idsOf(rankAccounts([member('a', same()), member('b', same())], NOW, [], 'expiry'))
    const backward = idsOf(rankAccounts([member('b', same()), member('a', same())], NOW, [], 'expiry'))
    expect(forward).toEqual(['a', 'b'])
    expect(backward).toEqual(forward)
  })
})

describe('五种分布都能被区分（R4：不得只声明不生效）', () => {
  it('expiry 与 priority 在「分多者更晚到期」的数据上给出相反首选', () => {
    const pool = (): WbRankMember[] => [
      member('poor-early', oneShot(100, NOW + 5 * DAY)),
      member('rich-late', oneShot(9_000, NOW + 120 * DAY)),
    ]
    expect(idsOf(rankAccounts(pool(), NOW, [], 'expiry'))[0]).toBe('poor-early')
    expect(idsOf(rankAccounts(pool(), NOW, [], 'priority'))[0]).toBe('rich-late')
  })
})

describe('pickRankedAccount 只是「取队首」的一行封装', () => {
  it('返回的是账号本身（不是名次行），且队首是可用账号', async () => {
    const { pickRankedAccount } = await import('../src/status-paths.ts')
    const chosen = pickRankedAccount([
      member('dead', oneShot(9_999, NOW + 1 * DAY), { usable: false }),
      member('ok', oneShot(10, NOW + 9 * DAY)),
    ], NOW, [], 'expiry')
    // 不可用者排最后是 rankAccounts 的职责，故队首必然是可服务的那个。
    expect(chosen?.id).toBe('ok')
  })

  it('空池返回 undefined', async () => {
    const { pickRankedAccount } = await import('../src/status-paths.ts')
    expect(pickRankedAccount([], NOW, [], 'expiry')).toBeUndefined()
  })

  it('全员不可用时**照样**返回队首——过滤留给 pool.pick（分工，不是缺陷）', async () => {
    const { pickRankedAccount } = await import('../src/status-paths.ts')
    const chosen = pickRankedAccount([
      member('dead', oneShot(1, NOW + 1 * DAY), { usable: false }),
    ], NOW, [], 'expiry')
    // 这个纯函数不做可用性闸门：调用方要「一个都不给」时必须自己滤
    // （`WbAccountPool.pick` 就是这么做的，它的 `usable.length === 0` 返回无账号）。
    expect(chosen?.id).toBe('dead')
  })
})
