/**
 * 自动签到调度器（需求 R1-e）。
 *
 * 只测**纯函数与闸门**，不测真的发网络请求：调度器里唯一带写副作用的是
 * `runCheckin`，它依赖上游客户端。这里钉住的是「什么时候该跑、什么时候绝不能跑」，
 * 那才是这块逻辑真正会出错的地方。
 *
 * ## 关键不变量
 *
 * - 时区必须是 `Asia/Shanghai`，不是宿主本地时区。用户在 UTC 机器上装插件，
 *   签到时段仍然应按北京时间算，否则「早 9 点」会漂到别的时段。
 * - `enabled: false` 时**绝不**发生任何写操作（默认值就是 false）。
 * - 日界在任何消费之前滚：跨零点时昨天的 `firedSlots` 必须先作废，否则新的一天
 *   会被「今天已经跑过了」误拦。
 */

import { describe, expect, it } from 'vitest'
import {
  AUTOMATION_ACCOUNT_DELAY_MS,
  AUTOMATION_TICK_MS,
  AUTOMATION_TIME_ZONE,
  DEFAULT_CHECKIN_HOURS,
  WbScheduler,
  dayKey,
  isFireHour,
  slotKey,
} from '../src/scheduler.ts'
import type { AutomationLedger } from '../src/scheduler.ts'
import { WbAccountPool } from '../src/accounts.ts'

/** 北京时间某日某时的时间戳。北京 = UTC+8，没有夏令时。 */
function beijing(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute))
}

describe('常量与默认值', () => {
  it('时区是 Asia/Shanghai', () => {
    expect(AUTOMATION_TIME_ZONE).toBe('Asia/Shanghai')
  })

  it('tick 是 60 秒、账号间延迟 800ms、默认时段 [9]', () => {
    expect(AUTOMATION_TICK_MS).toBe(60_000)
    expect(AUTOMATION_ACCOUNT_DELAY_MS).toBe(800)
    expect(DEFAULT_CHECKIN_HOURS).toEqual([9])
  })
})

describe('dayKey / slotKey 按北京时间切日界', () => {
  it('北京时间 00:30 属于当天，不是前一天', () => {
    // UTC 时间还是前一天 16:30 —— 若用本地时区就会算错。
    expect(dayKey(beijing(2026, 3, 15, 0, 30))).toBe('2026-03-15')
  })

  it('北京时间 23:30 仍属于当天', () => {
    expect(dayKey(beijing(2026, 3, 15, 23, 30))).toBe('2026-03-15')
  })

  it('slotKey 带上两位小时', () => {
    expect(slotKey(beijing(2026, 3, 15, 9))).toBe('2026-03-15T09')
    expect(slotKey(beijing(2026, 3, 15, 0))).toBe('2026-03-15T00')
  })

  it('可以显式指定别的时区（测试与状态路由共用同一套切日逻辑）', () => {
    expect(dayKey(beijing(2026, 3, 15, 0, 30), 'UTC')).toBe('2026-03-14')
  })
})

describe('isFireHour 判断「此刻是否落在配置的时段里」', () => {
  it('默认时段只命中 9 点', () => {
    expect(isFireHour(beijing(2026, 3, 15, 9), DEFAULT_CHECKIN_HOURS)).toBe(true)
    expect(isFireHour(beijing(2026, 3, 15, 8), DEFAULT_CHECKIN_HOURS)).toBe(false)
    expect(isFireHour(beijing(2026, 3, 15, 10), DEFAULT_CHECKIN_HOURS)).toBe(false)
  })

  it('多个时段都命中', () => {
    const hours = [9, 21]
    expect(isFireHour(beijing(2026, 3, 15, 9), hours)).toBe(true)
    expect(isFireHour(beijing(2026, 3, 15, 21), hours)).toBe(true)
    expect(isFireHour(beijing(2026, 3, 15, 12), hours)).toBe(false)
  })

  it('空时段列表永不命中', () => {
    expect(isFireHour(beijing(2026, 3, 15, 9), [])).toBe(false)
  })

  it('分钟数不影响判定（整个小时都算）', () => {
    expect(isFireHour(beijing(2026, 3, 15, 9, 0), [9])).toBe(true)
    expect(isFireHour(beijing(2026, 3, 15, 9, 59), [9])).toBe(true)
  })
})

/** 一个空池：调度器测闸门不需要真账号。 */
function emptyPool(): WbAccountPool {
  return new WbAccountPool({})
}

describe('启停与配置闸门', () => {
  it('默认 disabled —— 绝不默认开启写操作', () => {
    const scheduler = new WbScheduler({ pool: emptyPool(), client: {} as never })
    expect(scheduler.isEnabled()).toBe(false)
    const status = scheduler.status()
    expect(status.enabled).toBe(false)
    expect(status.running).toBe(false)
    scheduler.dispose()
  })

  it('applyConfig(enabled: true) 后 enabled 生效', () => {
    const scheduler = new WbScheduler({ pool: emptyPool(), client: {} as never })
    scheduler.applyConfig({ enabled: true, checkinHours: [9], claimBenefits: true })
    expect(scheduler.isEnabled()).toBe(true)
    expect(scheduler.status().checkinHours).toEqual([9])
    scheduler.dispose()
  })

  it('applyConfig(undefined) 是空操作，不改动已有配置', () => {
    // 这是「缺省不覆盖」而不是「缺省关闭」：宿主入口每次都会传入一个**构造好的**
    // 完整对象（`enabled: live.automation?.enabled === true`），undefined 只可能是
    // 调用方还没准备好配置。此时把调度器悄悄关掉，会让「配置尚未加载」与
    // 「用户明确关闭」两种情况变得无法区分。
    const scheduler = new WbScheduler({ pool: emptyPool(), client: {} as never })
    scheduler.applyConfig({ enabled: true, checkinHours: [9], claimBenefits: true })
    scheduler.applyConfig(undefined)
    expect(scheduler.isEnabled()).toBe(true)
    expect(scheduler.status().checkinHours).toEqual([9])
    scheduler.dispose()
  })

  it('非法时段被过滤掉，剩下合法的继续用', () => {
    const scheduler = new WbScheduler({ pool: emptyPool(), client: {} as never })
    scheduler.applyConfig({ enabled: true, checkinHours: [25, -1, 7.5, 21], claimBenefits: false })
    expect(scheduler.status().checkinHours).toEqual([21])
    scheduler.dispose()
  })

  it('空数组回落到默认 [9]', () => {
    const scheduler = new WbScheduler({ pool: emptyPool(), client: {} as never })
    scheduler.applyConfig({ enabled: true, checkinHours: [], claimBenefits: false })
    expect(scheduler.status().checkinHours).toEqual([9])
    scheduler.dispose()
  })

  it('过滤后为空时回落到默认 [9]，而不是空时段', () => {
    // 空时段 =  永不命中 = 自动签到**静默停摆**，而且日志里一条错都没有。
    // 判据必须是「过滤后」而不是「过滤前」：配置 schema 虽然拦住了 99，
    // 但  还能从 web 路由与旧版配置文件进来，不能把安全寄托给上游校验。
    const scheduler = new WbScheduler({ pool: emptyPool(), client: {} as never })
    scheduler.applyConfig({ enabled: true, checkinHours: [99], claimBenefits: false })
    expect(scheduler.status().checkinHours).toEqual([9])
    scheduler.applyConfig({ enabled: true, checkinHours: [-3, 1.5, 42], claimBenefits: false })
    expect(scheduler.status().checkinHours).toEqual([9])
    scheduler.dispose()
  })

  it('重复时段去重并升序', () => {
    const scheduler = new WbScheduler({ pool: emptyPool(), client: {} as never })
    scheduler.applyConfig({ enabled: true, checkinHours: [21, 9, 21, 9], claimBenefits: false })
    expect(scheduler.status().checkinHours).toEqual([9, 21])
    scheduler.dispose()
  })
})

describe('账本恢复：跨重启记住「今天跑过没有」', () => {
  it('applyLedger 后 firedSlots 保留当天的键', () => {
    const now = beijing(2026, 3, 15, 10)
    const scheduler = new WbScheduler({
      pool: emptyPool(),
      client: {} as never,
      now: () => now,
    })
    const ledger: AutomationLedger = {
      lastRunDate: '2026-03-15',
      lastRunSlot: '2026-03-15T09',
      firedSlots: ['2026-03-15T09'],
    }
    scheduler.applyLedger(ledger)
    expect(scheduler.ledger().firedSlots).toEqual(['2026-03-15T09'])
    scheduler.dispose()
  })

  it('过期的 firedSlots（昨天的键）在读取时被丢弃', () => {
    const now = beijing(2026, 3, 15, 10)
    const scheduler = new WbScheduler({
      pool: emptyPool(),
      client: {} as never,
      now: () => now,
    })
    scheduler.applyLedger({
      firedSlots: ['2026-03-14T09', '2026-03-15T09'],
    })
    expect(scheduler.ledger().firedSlots).toEqual(['2026-03-15T09'])
    scheduler.dispose()
  })

  it('applyLedger(undefined) 清空账本', () => {
    const scheduler = new WbScheduler({ pool: emptyPool(), client: {} as never })
    scheduler.applyLedger({ firedSlots: ['2026-03-15T09'] })
    scheduler.applyLedger(undefined)
    expect(scheduler.ledger().firedSlots).toEqual([])
    scheduler.dispose()
  })
})

describe('start / dispose 成对', () => {
  it('dispose 后再 dispose 不抛（宿主的 dispose 可能被调两次）', () => {
    const scheduler = new WbScheduler({ pool: emptyPool(), client: {} as never })
    scheduler.start()
    scheduler.dispose()
    expect(() => { scheduler.dispose() }).not.toThrow()
  })

  it('start 后 running 为 true，dispose 后为 false', () => {
    const scheduler = new WbScheduler({ pool: emptyPool(), client: {} as never })
    scheduler.start()
    expect(scheduler.status().running).toBe(true)
    scheduler.dispose()
    expect(scheduler.status().running).toBe(false)
  })

  it('重复 start 不会装两个定时器', () => {
    const scheduler = new WbScheduler({ pool: emptyPool(), client: {} as never })
    scheduler.start()
    scheduler.start()
    // 若装了两次，dispose 只清掉最后一个，进程会被残留的 interval 挂住。
    scheduler.dispose()
    expect(scheduler.status().running).toBe(false)
  })
})

describe('enabled 为 false 时 tick 不产生任何写操作', () => {
  it('到点但 disabled：账本不记时段，也不调上游', async () => {
    const now = beijing(2026, 3, 15, 9, 30)
    let claimed = 0
    const scheduler = new WbScheduler({
      pool: emptyPool(),
      // 任何上游调用都会使 claimed 递增，用来断言「一次都没发」。
      client: {
        claimDailyCheckin: async () => { claimed += 1; return { credit: 0, streakDays: 0 } },
        fetchCheckinStatus: async () => { claimed += 1; return { checkedIn: false } },
      } as never,
      now: () => now,
    })
    scheduler.applyConfig({ enabled: false, checkinHours: [9], claimBenefits: true })
    scheduler.start()
    // 等一轮 tick（60s 太长，直接调私有路径：runCheckinNow 是显式入口）。
    await new Promise(resolve => { setTimeout(resolve, 50) })
    expect(claimed).toBe(0)
    expect(scheduler.ledger().firedSlots).toEqual([])
    scheduler.dispose()
  })
})
