/**
 * 自动签到与权益领取的调度器。
 *
 * 蓝本 = 同仓 `dsh-connect-trae-models/src/scheduler.ts`（其本身是
 * `dsh-workbuddy-xdpool` scheduler 的成熟线）：60 秒 tick 循环 / 北京时区整点
 * 候选 / per-slot 去重 / 逐账号串行 + 间隔 / 手动运行不消费调度时段。
 *
 * 两个设计点必须留着，它们各对应一个已发布过的缺陷：
 *
 * 1. **日界在任何消费之前滚**。若让 `rollLedger` 在消费之后跑（它由
 *    `recordEarnings` 触发），本日刚消费掉的时段会被立刻擦掉 —— 闸门重新打开，
 *    同一小时可以无限重跑，账本也丢掉「今天跑过」。
 * 2. **`firedSlots` / `lastFiredHour` / `lastRunAtMs` 是三个独立事实**。分别回答
 *    「调度消费了什么」「运行何时开始（仅节流）」「运行何时结束（仅展示）」。任意
 *    两个混用都会产生「补跑擦掉 9 点记录」那类缺陷。
 *
 * @module dsh-connect-workbuddy-models/scheduler
 */

import type { WbDiscoveredAccount, WbAccountPool } from './accounts.ts'
import type { WbUpstreamClient } from './upstream.ts'
import { CHECKIN_REGION } from './status-paths.ts'
import type { WbAutomationConfig, WbBenefitKind, WbRegion } from './status-paths.ts'

/** 上游按北京自然日判幂等，日界必须与它一致。 */
export const AUTOMATION_TIME_ZONE = 'Asia/Shanghai'

/** tick 间隔。60 秒足够精细（整点判定的最小粒度就是一小时），又不至于空转。 */
export const AUTOMATION_TICK_MS = 60_000

/** 账号之间的串行间隔。上游对同一台机器有速率限制，密集请求会有一半拿到 429。 */
export const AUTOMATION_ACCOUNT_DELAY_MS = 800

/** 默认签到时段（北京时间整点）。上午 9 点：用户已开机、上游活动已刷新。 */
export const DEFAULT_CHECKIN_HOURS: readonly number[] = [9]

export interface SchedulerLogger {
  info?(...args: unknown[]): void
  warn(...args: unknown[]): void
}

/** 单个账号在一次运行里的所得。 */
export interface AutomationAccountGain {
  /** 本次入账积分。 */
  credit: number
  /** 其中来自签到的部分。 */
  checkinCredit: number
  /** 其中来自权益领取的部分。 */
  benefitCredit?: number
  /** 该账号今天已经领过了（不是失败）。 */
  alreadyDone?: boolean
}

/** 一个 job 的调度与结果状态。 */
export interface AutomationJobState {
  /** 今天已消费的调度时段（`YYYY-MM-DDTHH`，北京时）。 */
  firedSlots: readonly string[]
  /** 最近一次运行开始所在的小时时段（仅节流用）。 */
  lastFiredHour?: string
  /** 最近一次运行的日期键。 */
  lastRunDate?: string
  /** 最近一次运行所在时段。 */
  lastRunSlot?: string
  /** 最近一次运行完成时刻（ms）。 */
  lastRunAtMs?: number
  ok: number
  failed: number
  claimed: number
  credit: number
  message?: string
  detail?: readonly string[]
}

/** 账本：跨重启保留「今天跑过没有」，否则每次重启都会重签一遍。 */
export interface AutomationLedger {
  lastRunDate?: string
  lastRunSlot?: string
  firedSlots?: readonly string[]
}

/** 调度器状态快照（状态路由与卡片用）。 */
export interface AutomationStatus {
  enabled: boolean
  running: boolean
  checkinHours: readonly number[]
  claimBenefits: boolean
  jobs: { checkin: AutomationJobState }
  earningsToday: Readonly<Record<string, AutomationAccountGain>>
  runInProgress: boolean
  lastPassAtMs?: number
  lastPass?: Readonly<Record<string, AutomationAccountGain>>
}

/** 一个可调度的账号。只用池里的发现结果，调度器不自己扫盘。 */
export type SchedulerAccount = WbDiscoveredAccount

/**
 * 校准 hour list：只留 0-23 整数，去重升序；**过滤后为空则回落到默认值**。
 *
 * 回落的判据必须是「过滤后」而不是「过滤前」：用户配置里写了 [99] 这类越界值
 * （手改配置文件、或从旧版本迁移）时，过滤前非空、过滤后为空——此时若直接返回
 * 空列表， 就永不命中，自动签到会**静默停摆**且没有任何错误可看。
 */
function hoursOrDefault(hours: readonly number[] | undefined, fallback: readonly number[]): readonly number[] {
  if (hours === undefined || hours.length === 0) return fallback
  const valid = [...new Set(hours.filter(hour => Number.isInteger(hour) && hour >= 0 && hour <= 23))].sort((a, b) => a - b)
  return valid.length === 0 ? fallback : valid
}

/** `date` 在指定时区下的日历部件（全部为补零字符串）。 */
function zonedParts(
  date: Date,
  timeZone: string = AUTOMATION_TIME_ZONE,
): { year: string; month: string; day: string; hour: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const pick = (type: string): string => parts.find(part => part.type === type)?.value ?? '00'
  return { year: pick('year'), month: pick('month'), day: pick('day'), hour: pick('hour') }
}

/**
 * `date` 所属的自然日，`YYYY-MM-DD`（北京时）。
 *
 * 导出因为状态路由也要按同一个日界决定「今天」。
 */
export function dayKey(date: Date, timeZone: string = AUTOMATION_TIME_ZONE): string {
  const { year, month, day } = zonedParts(date, timeZone)
  return `${year}-${month}-${day}`
}

/** `date` 所在的调度时段 `YYYY-MM-DDTHH`（北京时）。 */
export function slotKey(date: Date, timeZone: string = AUTOMATION_TIME_ZONE): string {
  return `${dayKey(date, timeZone)}T${zonedParts(date, timeZone).hour}`
}

/** `now` 所在小时是否属于 `hours`（北京时）。 */
export function isFireHour(
  now: Date,
  hours: readonly number[],
  timeZone: string = AUTOMATION_TIME_ZONE,
): boolean {
  return hours.includes(Number(zonedParts(now, timeZone).hour))
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

function accountWord(account: SchedulerAccount): string {
  return account.label === '' ? account.id.slice(0, 8) : account.label
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface SchedulerOptions {
  pool: WbAccountPool
  client: WbUpstreamClient
  /** 配置；`enabled: false` 时循环保持惰性（**绝不**默认开启写操作）。 */
  config?: WbAutomationConfig & { accountDelayMs?: number }
  logger?: SchedulerLogger
  /** 时钟注入（测试用假时钟）。 */
  now?: () => Date
  /** 构造时恢复当日账本。 */
  loadLedger?: () => AutomationLedger | undefined
  /** 账本变化时的持久化钩子。 */
  saveLedger?: (ledger: AutomationLedger) => void | Promise<void>
}

/**
 * 自动签到调度器。
 *
 * `start()` 只负责装定时器；真正的写操作只在 `tick` 里、且 `enabled === true` 时
 * 发生。`dispose()` 必须被调用（宿主入口在 `ctx.effect` 里成对绑定），否则宿主
 * 卸载后定时器仍在跑，会对着已 dispose 的上下文发请求。
 */
export class WbScheduler {
  private readonly pool: WbAccountPool
  private readonly client: WbUpstreamClient
  private readonly logger: SchedulerLogger | undefined
  private readonly now: () => Date
  private readonly saveLedger: ((ledger: AutomationLedger) => void | Promise<void>) | undefined

  private enabled = false
  private claimBenefits = false
  private checkinHours: readonly number[] = DEFAULT_CHECKIN_HOURS
  private delayMs = AUTOMATION_ACCOUNT_DELAY_MS

  private timer: ReturnType<typeof setInterval> | undefined
  /**
   * 「已被卸载」标记，**初值 false**。
   *
   * 它挡的是 `dispose()` 之后的运行，不是 `start()` 之前的运行：卡片上的「立即
   * 签到」是一次手动调用，与定时器无关，若初值为 `true` 就会在账号循环的第一行
   * 直接 break —— 按钮点下去静默无反应，而日志里一条错都没有。
   * 定时器本身由 `timer === undefined` 兜住，不需要这个标志。
   */
  private stopped = false
  private busy = false

  private readonly states: { checkin: AutomationJobState } = {
    checkin: { firedSlots: [], ok: 0, failed: 0, claimed: 0, credit: 0 },
  }

  /** 当日账本：账号 → 所得。跨日清空。 */
  private earnings = new Map<string, AutomationAccountGain>()
  private earningsDay: string | undefined

  /** 最近一次运行的整体所得（卡片显示「刚发生了什么」）。 */
  private lastPass: Readonly<Record<string, AutomationAccountGain>> | undefined

  constructor(options: SchedulerOptions) {
    this.pool = options.pool
    this.client = options.client
    this.logger = options.logger
    this.now = options.now ?? (() => new Date())
    this.saveLedger = options.saveLedger
    const stored = options.loadLedger?.()
    if (stored !== undefined) {
      this.states.checkin.firedSlots = (stored.firedSlots ?? []).filter(entry => typeof entry === 'string')
      if (stored.lastRunDate !== undefined) this.states.checkin.lastRunDate = stored.lastRunDate
      if (stored.lastRunSlot !== undefined) this.states.checkin.lastRunSlot = stored.lastRunSlot
    }
    if (options.config !== undefined) this.applyConfig(options.config)
  }

  /**
   * 施加配置。
   *
   * `enabled` 的变化**立即生效**：关掉时不需要等下一个 tick 停止写操作，因为 tick
   * 每次都重读这个字段。定时器本身继续跑（空转极轻），这样重新打开无需重启宿主。
   */
  applyConfig(config: (WbAutomationConfig & { accountDelayMs?: number }) | undefined): void {
    if (config === undefined) return
    this.enabled = config.enabled === true
    this.claimBenefits = config.claimBenefits === true
    this.checkinHours = hoursOrDefault(config.checkinHours, DEFAULT_CHECKIN_HOURS)
    if (config.accountDelayMs !== undefined) this.delayMs = Math.max(0, config.accountDelayMs)
  }

  /** 当前是否真的会发起写操作。 */
  isEnabled(): boolean {
    return this.enabled
  }

  /** 装定时器。重复调用是空操作。 */
  start(): void {
    if (this.timer !== undefined) return
    this.stopped = false
    this.timer = setInterval(() => { void this.tick() }, AUTOMATION_TICK_MS)
    // 不阻止进程退出：宿主关掉后一个空转的 setInterval 会让 dsh 进程挂住。
    this.timer.unref?.()
  }

  /** 停定时器并阻止后续运行。可重复调用。 */
  dispose(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** 状态快照（不含 token 材料）。 */
  status(): AutomationStatus {
    this.rollLedger(dayKey(this.now()))
    return {
      enabled: this.enabled,
      running: this.timer !== undefined && !this.stopped,
      checkinHours: this.checkinHours,
      claimBenefits: this.claimBenefits,
      jobs: { checkin: { ...this.states.checkin } },
      earningsToday: Object.fromEntries(this.earnings),
      runInProgress: this.busy,
      ...this.states.checkin.lastRunAtMs === undefined ? {} : { lastPassAtMs: this.states.checkin.lastRunAtMs },
      ...this.lastPass === undefined ? {} : { lastPass: this.lastPass },
    }
  }

  /** 恢复一个持久化的账本（宿主启动时读回）。 */
  applyLedger(ledger: AutomationLedger | undefined): void {
    if (ledger === undefined) return
    this.states.checkin.firedSlots = (ledger.firedSlots ?? []).filter(entry => typeof entry === 'string')
    if (ledger.lastRunDate !== undefined) this.states.checkin.lastRunDate = ledger.lastRunDate
    if (ledger.lastRunSlot !== undefined) this.states.checkin.lastRunSlot = ledger.lastRunSlot
  }

  /** 当前账本（持久化用）。 */
  ledger(): AutomationLedger {
    this.rollLedger(dayKey(this.now()))
    const state = this.states.checkin
    return {
      firedSlots: state.firedSlots,
      ...state.lastRunDate === undefined ? {} : { lastRunDate: state.lastRunDate },
      ...state.lastRunSlot === undefined ? {} : { lastRunSlot: state.lastRunSlot },
    }
  }

  /**
   * 手动运行一次签到（卡片上的「立即签到」与状态路由的 POST）。
   *
   * `force` 缺省 `true`：用户按下按钮就是「我知道，还是跑」。**不消费调度时段**
   * ——10:35 手动跑一次不能取消 21:00 那个时段。
   */
  async runCheckinNow(options: { region?: WbRegion; force?: boolean } = {}): Promise<Readonly<Record<string, AutomationAccountGain>>> {
    return await this.runCheckin(options.region, options.force ?? true)
  }

  /**
   * 手动给**一个**账号签到（账号卡片上的按钮）。
   *
   * 与 {@link runCheckinNow} 分开是因为两者的失败语义不同：全量运行里「一个账号
   * 失败」要被吞掉并计入 `failed`，而单账号运行里那个失败必须原样抛给调用方——
   * 用户点的是这一个账号的按钮，吞掉错误等于按钮没反应。
   *
   * 返回 `undefined` 表示没有可做的事（活动未开启 / 账号不存在），而不是失败。
   */
  async checkinOne(accountId: string): Promise<{ gain: AutomationAccountGain | undefined; detail: readonly string[] }> {
    const entry = this.pool.find(accountId)
    if (entry === undefined) return { gain: undefined, detail: ['账号不存在（可能已被上游注销或文件被删）'] }
    const today = dayKey(this.now())
    this.rollLedger(today)
    const state = this.states.checkin
    // 单账号按钮也是一轮。不归零的话，点一次按钮就让全量运行的「N 个账号已处理」
    // 凭空 +1，而那个 N 的含义是「这一轮处理了几个」。
    this.resetRoundCounters(state)
    const detail: string[] = []
    const gain = await this.runOne(entry.account, today, detail)
    state.lastRunDate = today
    state.lastRunSlot = slotKey(this.now())
    state.lastRunAtMs = this.now().getTime()
    state.message = this.summarise(state)
    state.detail = detail
    this.lastPass = gain === undefined ? {} : { [accountId]: gain }
    void this.persist()
    return { gain, detail }
  }

  /**
   * 手动领取**一个**账号的某一类权益。
   *
   * 先复核该权益此刻是否可领（`active && !claimed`）：上游对已领取的赠礼仍报
   * `active: true`，不复核就会在用户连点两次时发出第二个必然被拒的写请求，而
   * 那个拒绝看起来像「领取失败」。
   *
   * 返回 `false` 表示「现在没什么可领」，`true` 表示刚领成功。真正的失败抛给调用方。
   */
  async claimOne(accountId: string, kind: WbBenefitKind): Promise<boolean> {
    const entry = this.pool.find(accountId)
    if (entry === undefined) throw new Error(`unknown account: ${accountId}`)
    const benefits = await this.client.fetchBenefits(entry.account.credential)
    const target = benefits.find(benefit => benefit.kind === kind)
    if (target === undefined) throw new Error(`upstream does not report a ${kind} benefit for this account`)
    if (!target.active || target.claimed) return false
    await this.client.claimBenefit(entry.account.credential, kind)
    const today = dayKey(this.now())
    this.recordEarnings(accountId, today, { credit: target.creditNum, checkinCredit: 0, benefitCredit: target.creditNum })
    void this.persist()
    return true
  }

  /**
   * 循环体：到点就跑。
   *
   * 状态筛选（enabled / stopped / busy）与异常隔离都在这里，保证循环本身绝不被
   * 一次失败拖死。
   */
  private async tick(): Promise<void> {
    if (!this.enabled || this.stopped || this.busy) return
    try {
      const now = this.now()
      const slot = slotKey(now)
      // 日界在任何消费之前滚（理由见文件头）。
      this.rollLedger(dayKey(now))
      const consumed = this.dueSlot(now)
      if (consumed === undefined) return
      // 节流：同一个时钟小时内不重复启动。
      if (this.states.checkin.lastFiredHour === slot) return
      this.consumeSlot(consumed)
      // 显式传 CHECKIN_REGION，而不是 `undefined`。`undefined` 在 `runCheckin`
      // 入口已经会被归一成同一个值，这里仍然写明，是为了让「定时路径签的是哪个
      // 区域」在调用点就能读出来，不必跳到被调方去查。
      await this.runCheckin(CHECKIN_REGION, true)
    } catch (error: unknown) {
      // 循环自身的缺陷绝不能杀死定时器。
      this.logger?.warn?.('dsh-connect-workbuddy-models: 自动签到 tick 失败', error)
    }
  }

  /** 今天已消费的时段集合（读取时顺手丢掉更早的日期）。 */
  private firedSlotsOf(): Set<string> {
    const today = dayKey(this.now())
    return new Set(this.states.checkin.firedSlots.filter(entry => entry.startsWith(`${today}T`)))
  }

  /** 记录一个已消费的调度时段。 */
  private consumeSlot(slot: string): void {
    const today = dayKey(this.now())
    const next = new Set([...this.firedSlotsOf(), slot])
    this.states.checkin.firedSlots = [...next].filter(entry => entry.startsWith(`${today}T`)).sort()
    void this.persist()
  }

  /**
   * 此刻该跑的时段，没有则 undefined。
   *
   * **最早**的未消费候选胜出，这样多时段配置才完整。用「已经过去」而不是「正好
   * 等于」判定：DSH 关闭期间错过的时段能自愈（09:00 的签到在 10:00 启动时补上），
   * 这正是笔记本合盖场景需要的。
   */
  private dueSlot(now: Date): string | undefined {
    const hours = this.checkinHours
    if (hours.length === 0) return undefined
    const current = Number(zonedParts(now).hour)
    const today = dayKey(now)
    const fired = this.firedSlotsOf()
    for (const candidate of [...hours].sort((a, b) => a - b)) {
      if (candidate > current) break
      const slot = `${today}T${String(candidate).padStart(2, '0')}`
      if (!fired.has(slot)) return slot
    }
    return undefined
  }

  /** 跨日重置账本与 `firedSlots`。 */
  private rollLedger(today: string): void {
    if (this.earningsDay === today) return
    this.earningsDay = today
    this.earnings = new Map()
    // 只保留今天的时段：更早的键永远不会再被判定，留着只会让账本越来越大。
    this.states.checkin.firedSlots = this.states.checkin.firedSlots.filter(entry => entry.startsWith(`${today}T`))
  }

  private async persist(): Promise<void> {
    if (this.saveLedger === undefined) return
    try {
      await this.saveLedger(this.ledger())
    } catch (error: unknown) {
      // 持久化失败绝不能打断调度器；下一次成功会覆盖这次。
      this.logger?.warn?.('dsh-connect-workbuddy-models: 自动化账本写入失败', error)
    }
  }

  /**
   * 参与自动化的账号。
   *
   * 取池里**可服务**的成员（`exclusionReason` 为空）：死凭据的账号签到也一定失败，
   * 对它们发写请求只是把一次 401 变成一条日志噪声。**不跳过冷却账号** —— 冷却记在
   * shim 里、按 (账号, 模型) 计，是对话路由的闸门；签到走独立的 billing 端点，不该
   * 被对话侧限流连坐。
   */
  private eligibleAccounts(region: WbRegion | undefined): SchedulerAccount[] {
    const out: SchedulerAccount[] = []
    for (const entry of this.pool.list()) {
      if (region !== undefined && entry.account.region !== region) continue
      if (this.pool.exclusionReason(entry) !== undefined) continue
      out.push(entry.account)
    }
    return out
  }

  /**
   * 跑一轮签到。`requestedRegion` **只是调用方的意图，不是参与范围**。
   *
   * 签到是 **cn 专属操作**（`CHECKIN_REGION`，来源见那里的注释：t21 产品裁定国际版
   * 不提供签到活动）。因此本方法在入口就把范围归一成 `CHECKIN_REGION`：**无论调用
   * 方传什么，包括 `undefined`，本轮参与的账号一律限定为国内版**——`undefined`
   * 在这里**不再表示「全池」**。
   *
   * 为什么要在被调方收口，而不是让三个调用点各自传对：这个缺陷真实发生过——
   * `runCheckinNow({ force: true })`（状态路由）与 `runCheckin(undefined, true)`
   * （定时 tick）都不传区域，于是国际版账号被送到国内 billing 端点，`detail` 里留下
   * 它的名字，用户看到的是「国际版被签到了」。调用点分散在路由、定时器、卡片按钮三
   * 处，靠自觉总会漏一个；收口后漏传只会退化成本该如此的行为。
   */
  private async runCheckin(
    requestedRegion: WbRegion | undefined,
    force: boolean,
  ): Promise<Readonly<Record<string, AutomationAccountGain>>> {
    // 归一：范围永远是国内版。调用方要别的区域不是错误输入，只是拿不到它要的东西
    // ——签 warning 而不是抛错，因为抛错会让「点了一下全部签到」在界面上变成红字。
    const region: WbRegion = CHECKIN_REGION
    if (requestedRegion !== undefined && requestedRegion !== CHECKIN_REGION) {
      this.logger?.warn?.(`dsh-connect-workbuddy-models: 签到只对国内版账号生效，收到区域 ${requestedRegion}，本轮仍只处理 ${CHECKIN_REGION}`)
    }
    const now = this.now()
    const today = dayKey(now)
    const state = this.states.checkin
    const slot = slotKey(now)
    // 节流：同一个时钟小时内不重复启动。手动 force 才是「我知道，还是跑」。
    if (!force && state.lastFiredHour === slot) return {}
    if (this.busy) return {}
    this.busy = true
    // 本轮计数从零起。这四个字段是**本轮**的统计口径（`summarise` 直接拿它们拼
    // 「N 个账号已处理」），不是跨轮累计——跨轮累计的正确去处是 `earningsToday`
    // 与 `lastPass`，两者已经按账号、按自然日建好了账。
    //
    // 不归零的后果不是数字偏大那么无害：同一天第二次签到时幂等生效（detail 正确
    // 显示「今日已签到」），`ok` 却从 4 变 8，于是卡片上写着「8 个账号已处理」而
    // 本机只有 4 个账号 —— 用户唯一的解读是「它在乱跑」。
    this.resetRoundCounters(state)
    const gained: Record<string, AutomationAccountGain> = {}
    const detail: string[] = []
    try {
      const accounts = this.eligibleAccounts(region)
      for (let index = 0; index < accounts.length; index += 1) {
        if (this.stopped) break
        const account = accounts[index]!
        try {
          const gain = await this.runOne(account, today, detail)
          if (gain !== undefined) gained[account.id] = gain
        } catch (error: unknown) {
          // 一个账号失败绝不停下整轮。
          state.failed += 1
          this.logger?.warn?.(`dsh-connect-workbuddy-models: 账号 ${accountWord(account)} 签到失败`, error)
          detail.push(`${accountWord(account)}：失败（${describeError(error)}）`)
        }
        // 串行间隔，但绝不在最后一个账号之后空等。
        if (index < accounts.length - 1 && this.delayMs > 0 && !this.stopped) await sleep(this.delayMs)
      }
    } finally {
      this.busy = false
    }
    // 三个独立事实，三个字段（理由见文件头）。
    state.lastFiredHour = slot
    state.lastRunDate = today
    state.lastRunSlot = slot
    state.lastRunAtMs = this.now().getTime()
    state.message = this.summarise(state)
    state.detail = detail
    this.lastPass = gained
    this.logger?.info?.(`dsh-connect-workbuddy-models: ${state.message}`)
    void this.persist()
    return gained
  }

  /**
   * 单账号：读签到状态 → 判定 → （必要时）领取 → 顺带领权益。
   *
   * 幂等靠**上游的两个独立标志**，而不是本地账本：
   * - `todayCheckedIn`：该账号今天的奖励已存在（无论哪台设备领的）。
   * - `active`：活动窗口是否开着。
   *
   * 本地账本只用于「今天这个时段跑过没有」，它回答不了任何账号级问题——把本地
   * 日期当「已签到」是已发布过的缺陷（切换账号后卡片显示已签到并禁用按钮，理由错）。
   */
  private async runOne(
    account: SchedulerAccount,
    today: string,
    detail: string[],
  ): Promise<AutomationAccountGain | undefined> {
    const state = this.states.checkin
    const label = accountWord(account)

    const status = await this.client.fetchCheckinStatus(account.credential)
    // 活动没开：不是错误，跳过。
    if (!status.active) {
      state.ok += 1
      detail.push(`${label}：签到活动未开启`)
      return undefined
    }
    if (status.todayCheckedIn) {
      state.ok += 1
      detail.push(`${label}：今日已签到（连续 ${status.streakDays} 天，今日 +${status.todayCredit} 积分）`)
      // 已签到也要看权益：赠礼是独立端点，与签到名额无关。
      const benefitCredit = this.claimBenefits ? await this.claimBenefitsOf(account, detail, label) : 0
      const gain: AutomationAccountGain = { credit: benefitCredit, checkinCredit: 0, alreadyDone: true }
      if (benefitCredit > 0) gain.benefitCredit = benefitCredit
      this.recordEarnings(account.id, today, gain)
      return gain
    }

    const claim = await this.client.claimDailyCheckin(account.credential)
    state.ok += 1
    state.claimed += 1
    state.credit += claim.credit
    detail.push(`${label}：签到成功 +${claim.credit} 积分（连续 ${claim.streakDays} 天）`)
    const benefitCredit = this.claimBenefits ? await this.claimBenefitsOf(account, detail, label) : 0
    const gain: AutomationAccountGain = { credit: claim.credit + benefitCredit, checkinCredit: claim.credit }
    if (benefitCredit > 0) gain.benefitCredit = benefitCredit
    this.recordEarnings(account.id, today, gain)
    return gain
  }

  /**
   * 领取该账号可领的权益。
   *
   * `claimable = active && !claimed`：上游对已领取的赠礼仍会报 `active: true`
   * （campaign 未结束），所以只看 `active` 会每次运行都重复领一次、每次都被拒。
   * 两个标志都必须读。
   *
   * 单个权益失败不打断其他：活动端点各自独立，一个回 5xx 不该让另一个消失。
   */
  private async claimBenefitsOf(account: SchedulerAccount, detail: string[], label: string): Promise<number> {
    let credits = 0
    let benefits: Awaited<ReturnType<WbUpstreamClient['fetchBenefits']>>
    try {
      benefits = await this.client.fetchBenefits(account.credential)
    } catch (error: unknown) {
      detail.push(`${label}：权益清单读取失败（${describeError(error)}）`)
      return 0
    }
    for (const benefit of benefits) {
      if (!benefit.active || benefit.claimed) continue
      try {
        await this.client.claimBenefit(account.credential, benefit.kind)
        credits += benefit.creditNum
        detail.push(`${label}：领取${benefit.kind === 'gift' ? '赠礼' : '补偿'} +${benefit.creditNum} 积分`)
      } catch (error: unknown) {
        detail.push(`${label}：${benefit.kind === 'gift' ? '赠礼' : '补偿'}领取失败（${describeError(error)}）`)
      }
    }
    return credits
  }

  /** 把一次所得累加进当日账本。0 所得的记录也要落（它说明「今天跑过了」）。 */
  private recordEarnings(accountId: string, today: string, gain: AutomationAccountGain): void {
    this.rollLedger(today)
    const prev = this.earnings.get(accountId)
    this.earnings.set(accountId, prev === undefined
      ? gain
      : {
          credit: prev.credit + gain.credit,
          checkinCredit: prev.checkinCredit + gain.checkinCredit,
          ...(prev.benefitCredit ?? 0) + (gain.benefitCredit ?? 0) === 0
            ? {}
            : { benefitCredit: (prev.benefitCredit ?? 0) + (gain.benefitCredit ?? 0) },
          ...(prev.alreadyDone === true || gain.alreadyDone === true) ? { alreadyDone: true } : {},
        })
  }

  /**
   * 把「本轮」的四个计数器归零。
   *
   * `ok` / `failed` / `claimed` / `credit` 是**本轮**口径——{@link summarise} 直接
   * 拿它们拼「N 个账号已处理」。跨轮累计另有去处：`earningsToday` 按账号按自然日
   * 建账，`lastPass` 记最近一次的结果，两者都不受这里影响。
   *
   * 三种入口（定时、手动全量、单账号按钮）都必须先过这里：漏一个，用户点一次
   * 单账号按钮就会让「4 个账号已处理」变成 5。
   *
   * **不清** `firedSlots`：那是「今天哪些时段跑过」的调度账本，清掉会让同一个
   * 时段被重复消费。
   */
  private resetRoundCounters(state: AutomationJobState): void {
    state.ok = 0
    state.failed = 0
    state.claimed = 0
    state.credit = 0
  }

  /** 一行总结。 */
  private summarise(state: AutomationJobState): string {
    const parts = [`${state.ok} 个账号已处理`]
    if (state.claimed > 0) parts.push(`${state.claimed} 个签到成功 +${state.credit} 积分`)
    if (state.failed > 0) parts.push(`${state.failed} 个失败`)
    return `自动签到：${parts.join('，')}`
  }
}
