/**
 * 积分探测：把上游的「一堆积分包」聚合成本插件与排序层共用的 {@link WbCredits}。
 *
 * 为什么聚合要单独成层，而不是直接复用上游字段：
 *
 * `rankAccounts`（`src/status-paths.ts:576`）内部的兜底窗口是硬编码的
 * `DEFAULT_EXPIRY_WARN_DAYS`（3 天）。它的注释给出的理由是「探测层会按用户配置
 * 聚合出 `credits.expiringSoon`，那个显式值优先，所以排序层不必知道设置」。这个
 * 理由只在**探测层确实自己算过**时成立。如果这里把上游原始积分包原样塞进
 * `rankAccounts`，用户的 `expiryWarnDays` 就只影响界面文案，对「谁排第一」完全
 * 无效——用户把提醒改成 30 天，却等不到任何账号被提前切换。
 *
 * 所以本文件的职责就是：**用用户配置的窗口把包算清楚**，让排序层的兜底永远不
 * 需要被用到。
 *
 * @module dsh-connect-workbuddy-models/probe
 */

import {
  DAY_MS,
  DEFAULT_EXPIRY_WARN_DAYS,
  EXPIRY_WARN_DAYS_MAX,
  EXPIRY_WARN_DAYS_MIN,
  type WbCheckinStatus,
  type WbCredits,
  type WbCreditPackage,
} from './status-paths.ts'
import type { WbRawCredits } from './upstream.ts'

/**
 * 把用户设置里的天数夹到合法范围。
 *
 * 夹紧而不是报错：`expiryWarnDays` 来自手改配置文件是常见路径，一个 `0` 或
 * `99999` 应该退化成一个合理的窗口，而不是让整张设置页报校验失败、让插件在
 * 加载期抛错（那会让「输入框下方读数」跟着一起消失）。
 */
export function clampWarnDays(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_EXPIRY_WARN_DAYS
  return Math.min(EXPIRY_WARN_DAYS_MAX, Math.max(EXPIRY_WARN_DAYS_MIN, Math.round(numeric)))
}

/** 一次聚合的完整结果，附带给界面用的诊断字段。 */
export interface WbProbeResult {
  credits: WbCredits
  /**
   * 窗口内到期的包名，供「临期提醒」直接列出是什么在流失。
   *
   * 只给总量的话，用户看到「3 天内过期 120 积分」却不知道是哪个包、能不能先花掉。
   */
  expiringPackages: readonly { packageName: string; remain: number; expiresAtMs: number }[]
  /**
   * 距离最近一次到期的天数（向上取整）；无到期信息时缺省。
   *
   * 界面用它决定要不要标红，而复用 `nearestExpiryMs` 天数是错的——两者一个是
   * 时刻一个是「还剩几天」，混用会在格式化时各自算一遍并给出不同答案。
   */
  daysToNearestExpiry?: number
}

/**
 * 聚合一个账号的积分。
 *
 * 三个口径都由**本函数**决定，下游只读不算：
 *
 * 1. `total` —— 一律取上游已聚合的总量（它优先读 `*Precise` 字段，见
 *    `upstream.ts` 的 `fetchCredits`；用整数版会漏掉小数，实测官方客户端总额带
 *    两位小数，任何整数之和都凑不出来）。**不**用 `CapacityRemain` 家族当余额：
 *    那是 pool 家族，整月额度花完时仍报满额（issue #58 定论）。
 * 2. `expiringSoon` —— 按**用户配置的** `warnDays` 累加窗口内一次性包的余额。
 *    周期包（`monthly`）不参与：它会刷新，不存在「过期」。
 * 3. `nearestExpiryMs` —— **只算一次性包里最近的那个到期时刻**，且必须是**未来**
 *    的、还有余额的包。
 *
 * 第 3 条的语义选择是关键，这里定死为「最近会流失的额度何时流失」，理由：
 * `rankAccounts` 在 `expiry` 分布下用 `nearestExpiryMs` 升序排第一。若把它理解成
 * 「所有包里最早的到期时刻」——月周期包也有 `CycleEndTime`——那一个明年才刷新的
 * 月包会让账号排到最前，而它根本不会过期。这正是 R3 要避免的行为：用户要的是
 * 「先把快要作废的积分花掉」，不是「先把订阅周期最近的那个号用起来」。
 *
 * 与 `rankAccounts` 的兜底口径完全一致（跳过 monthly、跳过已过期、跳过无余额），
 * 所以即使某个调用方绕过本函数，排序结果也不会与这里算出的门票相反。
 */
export function aggregateCredits(
  raw: WbRawCredits,
  options: { warnDays?: number; nowMs?: number } = {},
): WbProbeResult {
  const nowMs = options.nowMs ?? Date.now()
  const warnDays = clampWarnDays(options.warnDays ?? DEFAULT_EXPIRY_WARN_DAYS)
  const windowEndMs = nowMs + warnDays * DAY_MS

  let nearestExpiryMs: number | undefined
  let expiringSoon = 0
  const expiringPackages: { packageName: string; remain: number; expiresAtMs: number }[] = []

  for (const pack of raw.packages) {
    // 周期包按周期刷新，永不过期：把它算进临期会让每个月都被误报一次。
    if (pack.monthly) continue
    const at = pack.expiresAtMs
    if (at === undefined || !Number.isFinite(at)) continue
    // 已过期的包不该算：它已经从账号上消失（上游也不再返回），把它当 atRisk 会
    // 让一个余额为 0 的账号永远排在最前。
    if (at <= nowMs) continue
    // 余额为 0 的一次性包不会「流失」任何东西。
    if (pack.remain <= 0) continue
    if (nearestExpiryMs === undefined || at < nearestExpiryMs) nearestExpiryMs = at
    if (at <= windowEndMs) {
      expiringSoon += pack.remain
      expiringPackages.push({ packageName: pack.packageName, remain: pack.remain, expiresAtMs: at })
    }
  }

  expiringPackages.sort((left, right) => left.expiresAtMs - right.expiresAtMs)

  return {
    credits: {
      total: raw.total,
      packages: raw.packages,
      expiringSoon,
      ...nearestExpiryMs === undefined ? {} : { nearestExpiryMs },
    },
    expiringPackages,
    ...nearestExpiryMs === undefined
      ? {}
      : { daysToNearestExpiry: Math.max(0, Math.ceil((nearestExpiryMs - nowMs) / DAY_MS)) },
  }
}

/**
 * 一个账号的积分读数在界面上的稳定形态。
 *
 * `credits` 缺省与 `total: 0` **必须区分**：前者是「还没读到 / 读失败」，后者是
 * 「读到了，确实是 0」。把两者混成一个数字会让读失败的账号看起来像刚用光，
 * 用户会去找一个不存在的「为什么我积分没了」。
 */
export interface WbAccountProbe {
  accountId: string
  credits?: WbCredits
  probe?: WbProbeResult
  checkin?: WbCheckinStatus
  /** 读失败的原因；成功时缺省。 */
  error?: string
  /** 读到时刻（ms）。 */
  readAtMs: number
}

/**
 * 逐账号读取积分与签到，单个账号失败不影响其他账号。
 *
 * 串行而不是 `Promise.all`：上游对同一台机器有速率限制，4 个账号同时打
 * `get-user-resource` 会有一部分拿到 429，而那看起来像「这个号没积分」。
 * 串行多花的几秒换一个可信的读数，值得。
 */
export async function probeAccounts<TAccount extends { id: string; credential: { accessToken: string } }>(
  accounts: readonly TAccount[],
  read: (account: TAccount) => Promise<{ credits?: WbRawCredits; checkin?: WbUpstreamCheckinLike }>,
  options: {
    warnDays?: number
    nowMs?: number
    /** 账号之间的延迟（ms）；自动签到用 800，界面刷新用 150。 */
    delayMs?: number
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<readonly WbAccountProbe[]> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const delayMs = options.delayMs ?? 150
  const out: WbAccountProbe[] = []
  for (const [index, account] of accounts.entries()) {
    if (index > 0 && delayMs > 0) await sleep(delayMs)
    const readAtMs = Date.now()
    try {
      const reading = await read(account)
      const probe = reading.credits === undefined
        ? undefined
        : aggregateCredits(reading.credits, { ...options.warnDays === undefined ? {} : { warnDays: options.warnDays }, nowMs: options.nowMs ?? readAtMs })
      out.push({
        accountId: account.id,
        ...probe === undefined ? {} : { credits: probe.credits, probe },
        ...reading.checkin === undefined ? {} : { checkin: toCheckinStatus(reading.checkin) },
        readAtMs,
      })
    } catch (error: unknown) {
      out.push({
        accountId: account.id,
        error: error instanceof Error ? error.message : String(error),
        readAtMs,
      })
    }
  }
  return out
}

/** 上游签到投影的最小形状（与 `upstream.ts` 的 `WbUpstreamCheckin` 同构）。 */
interface WbUpstreamCheckinLike {
  active: boolean
  todayCheckedIn: boolean
  streakDays: number
  dailyCredit: number
  todayCredit: number
  isStreakDay: boolean
  nextStreakDay: number
  streakBonusDays: number
  streakBonusCredit: number
  claimButtonText?: string
}

/** 上游签到 → 共享投影。两者字段同名，这里只做一次显式拷贝，避免把 `undefined`
 * 与缺省混在一起（`exactOptionalPropertyTypes` 下两者不等价）。 */
export function toCheckinStatus(raw: WbUpstreamCheckinLike): WbCheckinStatus {
  return {
    active: raw.active,
    todayCheckedIn: raw.todayCheckedIn,
    streakDays: raw.streakDays,
    dailyCredit: raw.dailyCredit,
    todayCredit: raw.todayCredit,
    isStreakDay: raw.isStreakDay,
    nextStreakDay: raw.nextStreakDay,
    streakBonusDays: raw.streakBonusDays,
    streakBonusCredit: raw.streakBonusCredit,
    ...raw.claimButtonText === undefined ? {} : { claimButtonText: raw.claimButtonText },
  }
}

/**
 * 池子里「剩余总积分」的合计（R2 的读数）。
 *
 * 只累加**读到了读数**的账号：把读失败的账号按 0 计入，会让总数在下一次刷新时
 * 突然跳起来，用户会以为积分涨了。同时返回 `unread` 计数，界面才能说明
 * 「合计 2,196（还有 1 个账号没读到）」。
 */
export function totalCreditsOf(readings: readonly WbAccountProbe[]): { total: number; unread: number } {
  let total = 0
  let unread = 0
  for (const reading of readings) {
    if (reading.credits === undefined) {
      unread += 1
      continue
    }
    total += reading.credits.total
  }
  return { total, unread }
}

/**
 * 供界面判断「这个账号是否进入了临期窗口」。
 *
 * 与 {@link aggregateCredits} 用同一份 `WbCredits`，不重算：两处各算一遍窗口，
 * 迟早会出现「卡片标红但排序没换号」或反过来。
 */
export function isExpiring(credits: WbCredits | undefined): boolean {
  return credits !== undefined && credits.expiringSoon > 0
}

/** 一个包的到期说明；无到期信息时缺省（周期包会走 {@link refreshHintOf}）。 */
export function expiryHintOf(pack: WbCreditPackage, nowMs = Date.now()): string | undefined {
  if (pack.monthly) return undefined
  const at = pack.expiresAtMs
  if (at === undefined) return undefined
  const days = Math.ceil((at - nowMs) / DAY_MS)
  if (days <= 0) return '已过期'
  return `${days} 天后过期`
}

/** 周期包的下次刷新说明。 */
export function refreshHintOf(pack: WbCreditPackage, nowMs = Date.now()): string | undefined {
  if (!pack.monthly) return undefined
  const at = pack.refreshAtMs
  if (at === undefined) return undefined
  const days = Math.ceil((at - nowMs) / DAY_MS)
  return days <= 0 ? '即将刷新' : `${days} 天后刷新`
}
