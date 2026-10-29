/**
 * 「workbuddy模型」设置页：账号池、签到、自动任务、模型与倍率、账户使用方式。
 *
 * 分区顺序照参考插件已验证的布局（`dsh-connect-workbuddy` 的 WorkBuddyCard、
 * `dsh-connect-trae-models` 的 TraePoolCard）：
 *   1. 顶部：标题 + 「刷新账号」「重新拉取模型」
 *   2. 区域 Tab：国内版 / 国际版
 *   3. 账号池：每账号一行（参与池、签到、积分、到期、临期提醒）
 *   4. 被跳过的凭据文件（**必须**出现，见下）
 *   5. 自动签到（开关 + 时段 + 顺带领取权益）
 *   6. 模型区（名称 + id + 上下文 + 倍率 + 显示勾选 + 全选/全不选 + 保存）
 *   7. 账户使用方式（五选一，每个带一句中文说明）
 *   8. 显示设置（输入框读数开关、临期提醒阈值）
 *
 * 这个组件是被测的真实实现：测试直接渲染它，不从副本断言。
 *
 * ## 三条贯穿全文件的规则
 *
 * 1. **读不到的数字渲染成 `—`，绝不是 `0`。** `credits === undefined` 表示上游
 *    没有给出余额，`0` 是对账号余额的一句断言。把「不知道」画成「零」会让用户
 *    以为号被用光了。
 * 2. **失败保留上一次成功的值并说明原因。** 一次网络抖动不该让整页数字归零。
 * 3. **倍率 `undefined ≠ 0`。** CN 的 fallback 目录整份没有 `creditMultiplier`
 *    字段，把它当 `0` 会把收费模型显示成免费；所以 `undefined` 时**不渲染**
 *    倍率，照参考插件 `WorkBuddyCard.tsx:1745-1746` 的做法。
 *
 * @module dsh-connect-workbuddy-models/client/WbModelsCard
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ACCOUNT_DISTRIBUTIONS,
  DAY_MS,
  DEFAULT_ACCOUNT_DISTRIBUTION,
  DEFAULT_EXPIRY_WARN_DAYS,
  EXPIRY_WARN_DAYS_MAX,
  EXPIRY_WARN_DAYS_MIN,
  WB_ACCOUNTS_REFRESH_PATH,
  WB_BENEFIT_CLAIM_PATH,
  WB_CATALOG_TTL_MS,
  WB_CHECKIN_PATH,
  WB_MODELS_REFRESH_PATH,
  WB_MODELS_SAVE_PATH,
  WB_MODELS_SETTINGS_NS,
  WB_REGIONS,
  WB_STATUS_PATH,
  WB_BENEFIT_KINDS,
  distributionOf,
  unwrapVolatileDeep,
  withAccountId,
  withBenefitClaim,
  withRegion,
} from '../status-paths.ts'
import type {
  AccountDistribution,
  WbAccountPickReason,
  WbAccountReading,
  WbAutomationConfig,
  WbBenefitKind,
  WbCheckinStatus,
  WbCreditPackage,
  WbCredits,
  WbModelInfo,
  WbModelsConfig,
  WbRegion,
  WbSkippedFile,
  WbStatusSnapshot,
} from '../status-paths.ts'
import {
  promoBadgeColor,
  promoBadgeLabel,
  promoBadgeTooltip,
  selectPromoBadge,
  uiLanguage,
} from '../promo.ts'
import type { WbModelsSettingsKey } from './locales.ts'
import { WB_MODELS_CARD_CSS } from './styles.ts'

/** 卡片用到的设置分区面（已收窄，与参考插件同形状）。 */
export interface WbModelsCardSettingsScope {
  getSnapshot(): { writable?: boolean; value?: unknown }
  subscribe?(listener: () => void): () => void
  set?(field: string, value: unknown): Promise<void> | void
}

/** 卡片渲染所需的注入面。 */
export interface WbModelsCardInjected {
  t: (key: WbModelsSettingsKey, params?: Record<string, unknown>) => string
  /** 插件设置分区；缺省（受限宿主）时配置类开关只读。 */
  settingsScope?: WbModelsCardSettingsScope
  /** 测试注入的 fetch；生产走全局 fetch。 */
  fetchImpl?: typeof fetch
}

/** slot 交给卡片的 props。 */
export type WbModelsCardProps = Partial<WbModelsCardInjected> & {
  t?: (key: WbModelsSettingsKey, params?: Record<string, unknown>) => string
  /**
   * 首帧就带上的状态，按区域。
   *
   * 仅供测试与「宿主已把快照塞进 props」的宿主使用：本组件在 effect 里拉
   * `/status`，而 effect 在 SSR 与 `renderToString` 里不执行，所以没有这个口子
   * 就无法在不联网的前提下渲染出「有账号、有积分、有倍率」的那一屏，也就无法
   * 断言「倍率 undefined 时不渲染 0.00x」这条最要紧的规则。
   */
  initialStatusByRegion?: Partial<Record<WbRegion, WbStatusSnapshot>>
}

/** 卡片内部的文案函数形状。 */
type WbTranslator = (key: WbModelsSettingsKey, params?: Record<string, unknown>) => string

/** 恒等翻译兜底（宿主未接 locale 时键名可见，好过白屏）。 */
const identityT = (key: WbModelsSettingsKey): string => key

/** 状态轮询间隔：5 秒——签到与积分的变化是「点一下就变」，需要及时回显。 */
export const WB_MODELS_POLL_MS = 5_000

/** 自动签到的默认时刻（北京时间整点）。契约层没有导出这条，见 §8 的 [9]。 */
export const DEFAULT_CHECKIN_HOURS: readonly number[] = [9]

/**
 * 「全不选」的哨兵 id。
 *
 * `enabledModelIds` 的口径是**空数组 = 全部显示**（DESIGN.md §7），所以「一个都
 * 不显示」在空数组里没有表示。写一个真实模型 id 永远不会等于的哨兵值，是唯一
 * 能区分「全选」与「全不选」的办法；它同时让「用户什么都没配过」与「用户明确
 * 关掉了全部」在配置层面保持可区分——这两件事在界面上必须长得不一样。
 */
export const WB_NONE_SENTINEL = '__none__'

/** 格式化整数积分；读不到时 `—`。 */
export function formatCredits(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  const rounded = Math.round(value)
  try {
    return rounded.toLocaleString('zh-CN')
  } catch {
    return String(rounded)
  }
}

/** 格式化一个毫秒时刻成本地时间；无效返回 undefined。 */
function formatTime(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined
  try {
    return new Date(ms).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return undefined
  }
}

/** 距某个时刻还有多少整天（向下取整，最小 0）。 */
export function daysUntil(ms: number | undefined, nowMs: number): number | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined
  return Math.max(0, Math.floor((ms - nowMs) / DAY_MS))
}

/**
 * 把「多久以前」说成人话。
 *
 * 三档而不是一档，因为读者对这三个量级的容忍度完全不同：`12 秒前` 说明数据是活的，
 * `18 分钟前` 已经在提示「可能该刷新了」，`3 小时前` 基本等于「别信这些徽标」。
 * 统一写成秒会让后两种变得不可读，统一写成分钟又会让「刚刚刷新过」看起来像卡住了。
 *
 * `undefined`（服务端没给，即从未成功抓取过）返回空串——调用方在那种情况下走的是
 * 另一条文案（`row.modelsFetchedNever`），不需要在这里编一个假的时长。
 */
export function formatAge(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return ''
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}

/**
 * 计算某个区域的「需要显示的模型」集合。
 *
 * 三条规则，顺序重要：
 * 1. 哨兵在 → 空集（「全不选」）。
 * 2. 空数组 → 全集（「默认全部显示」）。
 * 3. 否则取交集：配置里可能留着已经不存在的模型 id（上游下架过），把它们当
 *    「已勾选」会让「全选」按钮看起来没生效——勾上一个不存在的 id 没有任何
 *    界面表现。
 */
export function enabledModelSetOf(
  stored: readonly string[],
  allModelIds: readonly string[],
): ReadonlySet<string> {
  if (stored.includes(WB_NONE_SENTINEL)) return new Set()
  if (stored.length === 0) return new Set(allModelIds)
  const present = new Set(allModelIds)
  return new Set(stored.filter(id => present.has(id)))
}

/**
 * 把界面上的勾选集合写回配置值。
 *
 * 与 `enabledModelSetOf` 互逆，且**收敛到规范形式**：全选写空数组（让「默认全部
 * 显示」这条口径继续生效，将来上游新增的模型自动出现），空的写哨兵，其余照抄。
 */
export function enabledModelValueOf(
  picked: ReadonlySet<string>,
  allModelIds: readonly string[],
): readonly string[] {
  if (picked.size === 0) return [WB_NONE_SENTINEL]
  if (picked.size === allModelIds.length && allModelIds.every(id => picked.has(id))) return []
  return [...picked]
}

/** 尽力解析一份 JSON；非 2xx 时抛出带可读原因的错。 */
async function readJson(response: Response): Promise<Record<string, unknown>> {
  let payload: Record<string, unknown> = {}
  try {
    payload = await response.json() as Record<string, unknown>
  } catch {
    payload = {}
  }
  if (!response.ok) {
    const message = typeof payload['error'] === 'string' ? payload['error'] : `HTTP ${response.status}`
    throw new Error(message)
  }
  return payload
}

/** 把任意异常转成一句可读文案。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 从设置分区快照里取配置对象（剥掉 volatile 活引用）。 */
function configOfScope(scope: WbModelsCardSettingsScope | undefined): WbModelsConfig | undefined {
  if (scope === undefined) return undefined
  try {
    const value = unwrapVolatileDeep(scope.getSnapshot().value)
    return typeof value === 'object' && value !== null ? value as WbModelsConfig : undefined
  } catch {
    // 分区镜像尚未就绪不算错误：卡片会退回用 `/status` 回显的配置。
    return undefined
  }
}

/** 一个账号在当前时钟下的到期事实，供高亮与文案共用。 */
interface ExpiryFacts {
  /** 最近到期时刻。 */
  nearestExpiryMs?: number
  /** 临期窗口内会流失的额度。 */
  expiringSoon: number
  /** 距最近到期还有多少整天。 */
  days?: number
  /** 是否该高亮。 */
  soon: boolean
}

/**
 * 汇总一个账号的到期事实。
 *
 * `expiringSoon` 用探测层给的显式值（它已经按用户的 `expiryWarnDays` 聚合过），
 * 只有缺省时才从包列表里按窗口现算——两处各算一遍会给出两个不同的「还剩多少分」。
 */
function expiryFactsOf(credits: WbCredits | undefined, warnDays: number, nowMs: number): ExpiryFacts {
  if (credits === undefined) return { expiringSoon: 0, soon: false }
  const windowMs = warnDays * DAY_MS
  const nearest = credits.nearestExpiryMs
  let expiringSoon = credits.expiringSoon
  if (!Number.isFinite(expiringSoon) || expiringSoon < 0) {
    expiringSoon = credits.packages.reduce((sum, pkg) => {
      // 周期包永不「过期」（会刷新）；已经过去的一次性包已经消失了，
      // 它不是「临期」，把它算进来会让一个用光的账号永远高亮。
      if (pkg.monthly) return sum
      const at = pkg.expiresAtMs
      if (at === undefined || !Number.isFinite(at)) return sum
      const left = at - nowMs
      return left > 0 && left <= windowMs ? sum + pkg.remain : sum
    }, 0)
  }
  const days = daysUntil(nearest, nowMs)
  const soon = expiringSoon > 0 || (days !== undefined && days <= warnDays)
  return {
    ...nearest === undefined || !Number.isFinite(nearest) ? {} : { nearestExpiryMs: nearest },
    expiringSoon,
    ...days === undefined ? {} : { days },
    soon,
  }
}

/** 取某个使用方式的名字。 */
function distributionLabel(t: WbTranslator, mode: AccountDistribution): string {
  return t(`row.distribution.${mode}` as WbModelsSettingsKey)
}

/** 取某个使用方式的一句话说明。 */
function distributionHint(t: WbTranslator, mode: AccountDistribution): string {
  return t(`row.distributionHint.${mode}` as WbModelsSettingsKey)
}

/**
 * 一个账号这一位的原因。
 *
 * 用户改了「账户使用方式」之后，唯一的验证手段就是看这一行——如果账号行只写
 * 余额与到期，两种分布给出同样结果时（真实数据上 `expiry` 与 `priority` 会
 * 同时选中到期最早那个账号）用户就没有任何办法判断设置是否生效。
 *
 * 四种情形各自对应一句能据以行动的话，顺序重要：
 * 1. 不可服务 → 池上现成的 `exclusionReason`（未加入池 / 登录窗口已关闭 /
 *    上游已拒绝凭据）。它已经包含「该怎么做」，不再包一层名次话术。
 * 2. 第 1 位 → 它是下一个请求会发去的账号。
 * 3. 有到期信息但排在后面 → 说清「到期更晚」，这就是它排队的原因。
 * 4. 无到期信息（纯月包）→ 月包会刷新、不会浪费，所以排在会过期的账号之后。
 *
 * 快照里没有 `picks`（老宿主、手写首帧）时返回 `undefined`，整行不渲染：比起
 * 编一句「第 ? 位」，少一行更好。
 */
export function rankReasonText(
  t: WbTranslator,
  pick: WbAccountPickReason | undefined,
): string | undefined {
  if (pick === undefined) return undefined
  if (!pick.usable) {
    return pick.reason === undefined
      ? undefined
      : t('row.rankWhyExcluded', { rank: pick.rank, reason: pick.reason })
  }
  const time = formatTime(pick.nearestExpiryMs)
  if (pick.rank === 1) {
    return time === undefined ? t('row.rankWhyCurrentNoExpiry') : t('row.rankWhyCurrent', { time })
  }
  return time === undefined
    ? t('row.rankWhyLaterNoExpiry', { rank: pick.rank })
    : t('row.rankWhyLater', { rank: pick.rank, time })
}

/**
 * 把一个额度数字写成「能对得上账」的样子。
 *
 * 上游给的是精确到小数第 8 位的浮点数（`88.05000013`），原样渲染既读不了也对不上
 * 界面上的总量；但直接 `Math.round` 又会把 `88.05` 抹成 `88`，用户看着「剩 88 分」
 * 实际可用 88.05，差的那一点点在临界状态下就是「怎么又不够了」。所以：整数照原样，
 * 有小数就保留两位再抹掉尾随的 0。
 *
 * **刻意不提供「已用量」**（`size - remain`）：用户明确要求只显示剩余与总量。多算
 * 一步就多一个会算错的地方，而且那个数在界面上没有对应的动作。
 */
export function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Number.isInteger(value)) {
    try {
      return value.toLocaleString('zh-CN')
    } catch {
      return String(value)
    }
  }
  return String(Math.round(value * 100) / 100)
}

/** 一个积分包在明细里的一行（已排好序的投影）。 */
export interface CreditPackageRow {
  /** 稳定 key：同名包可能有多个，用序号保证 React 不串行。 */
  key: string
  packageName: string
  /** 上游原文，**不翻译不截断**。 */
  amountText: string
  monthly: boolean
  /** 一次性包的到期时刻；缺失/非有限时 `undefined`（界面写「无到期信息」）。 */
  expiresAtMs?: number
  /** 周期包的下次刷新时刻。 */
  refreshAtMs?: number
}

/**
 * 把 `credits.packages` 排成明细列表。
 *
 * 排序是这里唯一有判断力的部分，两条规则：
 *
 * 1. **一次性包按到期时间升序**。用户看明细是为了决定「先用哪一份」，最先过期的
 *    排最前面才有行动价值；按余额排会让他先看到最大的那包，然后眼看着小包过期。
 * 2. **周期包全部排在最后，且不参与上面那条比较**。周期包会刷新、永不「过期」，
 *    把它混进到期序里，一个只剩周期包的账号会永远显示「最近到期 = 很久以前」，
 *    或者更糟：被当成临期而长期高亮。同一个坑在 `expiryFactsOf` 里已经踩过。
 *
 * 没有到期时间的一次性包排在有到期时间的之后、周期包之前 —— 它确实是一次性的，
 * 只是不知道什么时候到期，「不知道」不该抢在「知道且最早」前面。
 */
export function creditPackageRowsOf(credits: WbCredits | undefined): readonly CreditPackageRow[] {
  if (credits === undefined) return []
  const oneShot: CreditPackageRow[] = []
  const monthly: CreditPackageRow[] = []
  credits.packages.forEach((pkg: WbCreditPackage, index) => {
    const amountText = `${formatAmount(pkg.remain)} / ${formatAmount(pkg.size)}`
    const base = { packageName: pkg.packageName, amountText, monthly: pkg.monthly } as const
    if (pkg.monthly) {
      monthly.push({
        ...base,
        key: `${index}:${pkg.packageName}`,
        ...pkg.refreshAtMs === undefined || !Number.isFinite(pkg.refreshAtMs)
          ? {}
          : { refreshAtMs: pkg.refreshAtMs },
      })
      return
    }
    oneShot.push({
      ...base,
      key: `${index}:${pkg.packageName}`,
      ...pkg.expiresAtMs === undefined || !Number.isFinite(pkg.expiresAtMs)
        ? {}
        : { expiresAtMs: pkg.expiresAtMs },
    })
  })
  oneShot.sort((left, right) => {
    const a = left.expiresAtMs
    const b = right.expiresAtMs
    if (a === undefined && b === undefined) return 0
    if (a === undefined) return 1
    if (b === undefined) return -1
    return a - b
  })
  return [...oneShot, ...monthly]
}

export function WbModelsCard(props: WbModelsCardProps) {  const t = props.t ?? identityT
  const fetchImpl = props.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined)
  const settingsScope = props.settingsScope

  /**
   * 配置是否可写。
   *
   * 只读**仅**当宿主明确报告作用域不可写时成立。作用域缺失（绑定探测失败、受限
   * 宿主）也按只读处理——但这时仍允许「刷新账号」「签到」「拉取模型」，因为它们
   * 走 HTTP 路由，与设置分区无关。把两者绑在一起会让受限宿主上连签到都点不了。
   */
  const scopeSnapshot = settingsScope?.getSnapshot()
  const configWritable = settingsScope !== undefined
    && scopeSnapshot !== undefined
    && scopeSnapshot.writable !== false
    && typeof settingsScope.set === 'function'

  const [region, setRegion] = useState<WbRegion>('cn')
  /** 每个区域各自保留最后一次应答：切 Tab 时立刻显示另一侧，而不是一帧空白。 */
  const [statusByRegion, setStatusByRegion] = useState<Partial<Record<WbRegion, WbStatusSnapshot>>>(
    () => props.initialStatusByRegion ?? {},
  )
  const [errorByRegion, setErrorByRegion] = useState<Partial<Record<WbRegion, string>>>({})
  const [scopeConfig, setScopeConfig] = useState<WbModelsConfig | undefined>(() => configOfScope(settingsScope))
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  /** 每个账号的签到结果提示（成功/失败都挂在该行上，而不是全局横幅）。 */
  const [checkinNote, setCheckinNote] = useState<Record<string, string>>({})
  /** 模型草稿：`undefined` = 跟随配置。 */
  const [draftByRegion, setDraftByRegion] = useState<Partial<Record<WbRegion, readonly string[]>>>({})
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  /** 卡片样式只注入一次（幂等：`data-plugin-css` 去重）。 */
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const cssId = `${WB_MODELS_SETTINGS_NS}/card.css`
    if (document.querySelector(`style[data-plugin-css="${cssId}"]`) !== null) return undefined
    const tag = document.createElement('style')
    tag.dataset['plugin'] = 'dsh-connect-workbuddy-models'
    tag.dataset['pluginCss'] = cssId
    tag.textContent = WB_MODELS_CARD_CSS
    document.head.appendChild(tag)
    // 刻意**不**在卸载时移除：另一个同插件条目的卡片可能正在用同一段样式，
    // 移除会让它失去外观。
    return undefined
  }, [])

  const status = statusByRegion[region]
  const error = errorByRegion[region]
  /** 配置：设置分区优先（它是用户刚点的那次写的），否则用 `/status` 回显。 */
  const config = scopeConfig ?? status?.config

  const warnDays = (() => {
    const raw = config?.expiryWarnDays
    if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_EXPIRY_WARN_DAYS
    return Math.min(EXPIRY_WARN_DAYS_MAX, Math.max(EXPIRY_WARN_DAYS_MIN, Math.round(raw)))
  })()

  /**
   * 读一次 `/status?region=`。
   *
   * 失败时保留该区域上一次的应答并记下错误：一次网络抖动不该让整页数字归零。
   */
  const reload = useCallback(async (target: WbRegion): Promise<void> => {
    if (fetchImpl === undefined) return
    try {
      const response = await fetchImpl(withRegion(WB_STATUS_PATH, target), {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      const payload = await readJson(response)
      if (!mounted.current) return
      setStatusByRegion(current => ({ ...current, [target]: payload as unknown as WbStatusSnapshot }))
      setErrorByRegion(current => {
        const next = { ...current }
        delete next[target]
        return next
      })
    } catch (caught: unknown) {
      if (!mounted.current) return
      setErrorByRegion(current => ({ ...current, [target]: messageOf(caught) }))
    }
  }, [fetchImpl])

  const reloadRef = useRef(reload)
  useEffect(() => { reloadRef.current = reload }, [reload])

  // 订阅设置分区：用户可能在另一个窗口改了同一份配置。
  useEffect(() => {
    if (settingsScope?.subscribe === undefined) return undefined
    const unsubscribe = settingsScope.subscribe(() => {
      if (mounted.current) setScopeConfig(configOfScope(settingsScope))
    })
    return unsubscribe
  }, [settingsScope])

  // 当前区域的轮询。切区域即重挂：`region` 在依赖里，旧定时器随清理函数消失。
  useEffect(() => {
    void reloadRef.current(region)
    const timer = window.setInterval(() => { void reloadRef.current(region) }, WB_MODELS_POLL_MS)
    return () => { window.clearInterval(timer) }
  }, [region])

  /** POST 一个路由，返回应答（失败抛出可读错误）。 */
  const post = useCallback(async (path: string, body: unknown, key: string): Promise<Record<string, unknown> | undefined> => {
    if (fetchImpl === undefined) return undefined
    setBusy(key)
    setNotice(undefined)
    setFailure(undefined)
    try {
      const response = await fetchImpl(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        ...body === undefined ? {} : { body: JSON.stringify(body) },
      })
      return await readJson(response)
    } catch (caught: unknown) {
      if (mounted.current) setFailure(messageOf(caught))
      return undefined
    } finally {
      if (mounted.current) setBusy(undefined)
    }
  }, [fetchImpl])

  /**
   * 写一个**顶层**配置键。
   *
   * 必须整键写入：settings 文档按顶层键存值，用点号路径 `'automation.enabled'`
   * 会被当成一个字面键名，真正的对象永不更新——这正是「复选框勾不动」的成因。
   * 写完立即重读：读回来的文档才是事实。
   */
  const writeConfig = useCallback(async (field: string, value: unknown): Promise<boolean> => {
    const write = settingsScope?.set
    if (write === undefined) {
      setFailure(t('row.saveFailed', { message: 'settings scope is unavailable' }))
      return false
    }
    setNotice(undefined)
    setFailure(undefined)
    try {
      await write.call(settingsScope, field, value)
      setScopeConfig(configOfScope(settingsScope))
      await reloadRef.current(region)
      setNotice(t('row.settingsSaved'))
      return true
    } catch (caught: unknown) {
      setFailure(t('row.saveFailed', { message: messageOf(caught) }))
      return false
    }
  }, [settingsScope, region, t])

  /** 参与池的账号集合。 */
  const poolIds = useMemo(() => new Set(config?.accountsEnabled ?? []), [config])

  /**
   * 一个账号是否参与池。
   *
   * `accountsEnabled` 为空表示「全部参与」——与模型选择同一套「空即全」口径；
   * 否则一个刚装好插件的用户会看到所有号都是未勾选状态，而它们其实都在服务。
   */
  const inPool = useCallback((accountId: string): boolean => {
    const list = config?.accountsEnabled ?? []
    return list.length === 0 || list.includes(accountId)
  }, [config])

  /** 勾掉/勾上某个账号的池成员资格。 */
  const togglePool = useCallback(async (accountId: string, next: boolean): Promise<void> => {
    const all = (status?.accounts ?? []).map(reading => reading.account.id)
    const explicit = (config?.accountsEnabled ?? []).length === 0
      ? new Set(all)
      : new Set(config?.accountsEnabled ?? [])
    if (next) explicit.add(accountId)
    else explicit.delete(accountId)
    // 收敛到规范形式：全选写空数组，让新发现的账号自动加入。
    const value = explicit.size === all.length && all.every(id => explicit.has(id)) ? [] : [...explicit]
    // 失败文案交给 `writeConfig`：它 catch 住了真实原因并已写成 `row.saveFailed`。
    // 别在这里补一句 `failure ?? 'write failed'`——闭包里的 `failure` 是上一次渲染
    // 的值，会把刚写好的准确原因覆盖成一句泛泛的「write failed」。
    await writeConfig('accountsEnabled', value)
  }, [status, config, writeConfig])

  /** 手动签到一个账号。 */
  const checkin = useCallback(async (account: WbAccountReading['account']): Promise<void> => {
    const payload = await post(withAccountId(WB_CHECKIN_PATH, account.id), undefined, `checkin:${account.id}`)
    if (!mounted.current) return
    const grantedRaw = payload === undefined ? undefined : payload['grantedCredit']
    const granted = typeof grantedRaw === 'number' && Number.isFinite(grantedRaw) ? grantedRaw : undefined
    setCheckinNote(current => ({
      ...current,
      [account.id]: granted === undefined
        ? t('row.checkinDone')
        : t('row.checkinToday', { credit: formatCredits(granted) }),
    }))
    await reloadRef.current(region)
  }, [post, t, region])

  /** 领取某个账号的一类权益（补偿 / 赠礼）。 */
  const claimBenefit = useCallback(async (account: WbAccountReading['account'], kind: WbBenefitKind): Promise<void> => {
    await post(withBenefitClaim(WB_BENEFIT_CLAIM_PATH, account.id, kind), undefined, `benefit:${account.id}:${kind}`)
    await reloadRef.current(region)
  }, [post, region])

  /** 重新扫描本机登录账号。 */
  const refreshAccounts = useCallback(async (): Promise<void> => {
    const payload = await post(withRegion(WB_ACCOUNTS_REFRESH_PATH, region), undefined, 'accounts')
    if (!mounted.current) return
    const accounts = payload?.['accounts']
    const count = Array.isArray(accounts) ? accounts.length : undefined
    setNotice(count === undefined ? t('row.refreshAccountsDone', { count: '?' }) : t('row.refreshAccountsDone', { count }))
    await reloadRef.current(region)
  }, [post, region, t])

  /** 重新拉取模型目录与倍率。 */
  const refreshModels = useCallback(async (): Promise<void> => {
    const payload = await post(withRegion(WB_MODELS_REFRESH_PATH, region), undefined, 'models')
    if (!mounted.current) return
    const models = payload?.['models']
    const count = Array.isArray(models) ? models.length : undefined
    setNotice(count === undefined ? t('row.refreshModelsDone', { count: '?' }) : t('row.refreshModelsDone', { count }))
    await reloadRef.current(region)
  }, [post, region, t])

  // ── 模型区 ─────────────────────────────────────────────────────────────

  const models: readonly WbModelInfo[] = status?.models ?? []
  // 新鲜度的两个读数。**注意它们来自 `/status` 的顶层**，不在 `catalogs[region]`
  // 里：后者是「两个区域各一份」的目录元信息，而用户此刻看的是本区域这一份。
  const modelsFetchedAtMs = status?.modelsFetchedAtMs
  const modelsAgeMs = status?.modelsAgeMs
  const busyFetchedAtMs = status?.busyFetchedAtMs
  // 手动刷新模型目录进行中。与账号区的「刷新账号」分开：两者共用 `busy` 状态机，
  // 但这里只说目录。
  const refreshingModels = busy === 'models'
  const allModelIds = useMemo(() => models.map(model => model.id), [models])
  /** 配置里该区域的存储值。空数组 = 全部显示。 */
  const storedModelIds: readonly string[] = region === 'global'
    ? config?.enabledModelIdsGlobal ?? []
    : config?.enabledModelIds ?? []
  /** 界面上勾着的集合：草稿优先。 */
  const pickedModels = useMemo(
    () => draftByRegion[region] === undefined
      ? enabledModelSetOf(storedModelIds, allModelIds)
      : new Set(draftByRegion[region] ?? []),
    [draftByRegion, region, storedModelIds, allModelIds],
  )
  const modelsDirty = draftByRegion[region] !== undefined
  const allPicked = allModelIds.length > 0 && allModelIds.every(id => pickedModels.has(id))

  /** 勾/取消一个模型（只改草稿，等保存）。 */
  const toggleModel = useCallback((modelId: string): void => {
    setDraftByRegion(current => {
      const base = current[region] === undefined
        ? enabledModelSetOf(storedModelIds, allModelIds)
        : new Set(current[region] ?? [])
      const next = new Set(base)
      if (next.has(modelId)) next.delete(modelId)
      else next.add(modelId)
      return { ...current, [region]: [...next] }
    })
  }, [region, storedModelIds, allModelIds])

  /** 全选 / 全不选（只改草稿）。 */
  const pickAll = useCallback((picked: boolean): void => {
    setDraftByRegion(current => ({ ...current, [region]: picked ? [...allModelIds] : [] }))
  }, [region, allModelIds])

  /**
   * 保存模型选择。
   *
   * 走 `/models/save` HTTP 路由而不是写设置：选择要能被宿主侧的模型过滤立即读到，
   * 而设置分区的写入在某些宿主线是延迟投影的。`enabledModelValueOf` 负责把界面
   * 集合收敛成规范值（全选→空数组，空→哨兵）。
   */
  const saveModels = useCallback(async (): Promise<void> => {
    const value = enabledModelValueOf(pickedModels, allModelIds)
    const payload = await post(WB_MODELS_SAVE_PATH, { region, enabledModelIds: [...value] }, 'models-save')
    if (payload === undefined || !mounted.current) return
    setDraftByRegion(current => {
      const next = { ...current }
      delete next[region]
      return next
    })
    setNotice(t('row.modelsSaved'))
    await reloadRef.current(region)
  }, [pickedModels, allModelIds, post, region, t])

  // ── 自动签到 ───────────────────────────────────────────────────────────

  const automation: WbAutomationConfig = config?.automation ?? {
    enabled: false,
    checkinHours: [...DEFAULT_CHECKIN_HOURS],
    claimBenefits: false,
  }
  const hours = automation.checkinHours.length > 0 ? automation.checkinHours : DEFAULT_CHECKIN_HOURS

  /**
   * 写自动签到配置。
   *
   * 一次写**整个** `automation` 对象，且把当前所有字段都带上：只写一个字段会把
   * 其余字段丢成 schema 缺省（时段被清成空 = 一份跑不起来的日程）。
   */
  const writeAutomation = useCallback(async (patch: Partial<WbAutomationConfig>): Promise<void> => {
    const next: WbAutomationConfig = {
      enabled: patch.enabled ?? automation.enabled,
      // 时段为空时回落默认 [9]：一份被写成 `[]` 的日程跑不起来，而用户看不到它为什么不动。
      checkinHours: [...(patch.checkinHours ?? (hours.length > 0 ? hours : DEFAULT_CHECKIN_HOURS))],
      claimBenefits: patch.claimBenefits ?? automation.claimBenefits,
    }
    await writeConfig('automation', next)
  }, [automation, hours, writeConfig])

  /** 勾/取消一个签到整点。 */
  const toggleHour = useCallback((hour: number): void => {
    const current = new Set(hours)
    if (current.has(hour)) current.delete(hour)
    else current.add(hour)
    void writeAutomation({ checkinHours: [...current].sort((a, b) => a - b) })
  }, [hours, writeAutomation])

  const accounts = status?.accounts ?? []
  const skipped: readonly WbSkippedFile[] = status?.skipped ?? []
  /**
   * 名次表按账号 id 索引。
   *
   * `picks` 是可选字段（老宿主不会发），缺了就当没有理由可渲染，而不是“假设
   * 名次等于数组下标”——账号数组是 `pool.list()` 的顺序（按 id 升序），与名次
   * 完全无关，用下标猜会把第 3 名说成第 1 名。
   */
  const pickById = new Map((status?.picks ?? []).map(pick => [pick.accountId, pick] as const))
  const nowMs = Date.now()
  // 徽标文案由上游给（`badge.label` / `hover.text`），语言偏好取浏览器那一侧。
  const promoLanguage = uiLanguage()

  return (
    <div className="wbm-page">
      {/* ── 顶部 ─────────────────────────────────────────────────────── */}
      <div className="wbm-page-head">
        <div className="wbm-page-copy">
          <h2 className="wbm-page-title">{t('row.title')}</h2>
          <p className="wbm-page-desc">{t('row.desc')}</p>
        </div>
        <div className="wbm-page-actions">
          <button
            type="button"
            className="dsm-btn dsm-btn-sm"
            disabled={busy !== undefined}
            onClick={() => { void refreshAccounts() }}
          >
            {busy === 'accounts' ? t('row.refreshingAccounts') : t('row.refreshAccounts')}
          </button>
          <button
            type="button"
            className="dsm-btn dsm-btn-sm"
            disabled={busy !== undefined}
            onClick={() => { void refreshModels() }}
          >
            {busy === 'models' ? t('row.refreshingModels') : t('row.refreshModels')}
          </button>
        </div>
      </div>

      {/* 区域 Tab：两个区域是两套独立的 provider 栈，账号与模型都不共享。 */}
      <div className="wbm-page-actions" role="tablist" aria-label={t('row.accountsTitle')}>
        {WB_REGIONS.map(entry => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={entry === region}
            className={entry === region ? 'dsm-btn dsm-btn-sm dsm-btn-primary' : 'dsm-btn dsm-btn-sm dsm-btn-outline'}
            onClick={() => { setRegion(entry) }}
          >
            {t(entry === 'cn' ? 'row.regionCn' : 'row.regionGlobal')}
          </button>
        ))}
      </div>

      {/* 全局提示。错误与成功分开渲染：一条绿色「已保存」盖住一条红色失败，是
          最容易让人以为写进去了的那种界面。 */}
      {failure === undefined ? null : <p className="wbm-error" role="alert">{failure}</p>}
      {notice === undefined ? null : <p className="wbm-ok" role="status">{notice}</p>}
      {error === undefined ? null : (
        <p className="wbm-error" role="alert">{t('row.requestFailed', { message: error })}</p>
      )}
      {configWritable ? null : <p className="wbm-secondary">{t('row.readonly')}</p>}
      {status === undefined ? (
        error === undefined ? <p className="wbm-muted">{t('row.loading')}</p> : null
      ) : null}

      {/* ── 账号区 ───────────────────────────────────────────────────── */}
      <section className="wbm-card">
        <h3 className="wbm-section-title">
          {t('row.accountsTitle')}
          <span className="wbm-muted">{accounts.length}</span>
        </h3>
        {accounts.length === 0 ? (
          <div className="wbm-empty">
            <p className="wbm-empty-title">{t('row.accountsEmpty')}</p>
            <p className="wbm-empty-note">{t('row.accountsEmptyHint')}</p>
          </div>
        ) : (
          accounts.map(reading => {
            const account = reading.account
            const facts = expiryFactsOf(reading.credits, warnDays, nowMs)
            const expiryText = formatTime(facts.nearestExpiryMs)
            const checkinStatus = reading.checkin
            const note = checkinNote[account.id]
            const excluded = reading.excludedBy
            const rankReason = rankReasonText(t, pickById.get(account.id))
            // 这个账号所在区域是否提供签到。两个条件都要：账号本身是国内版（国际版
            // 整区不做签到，用户已裁定），且当前 Tab 就是这个区域——服务端现在按
            // region 过滤账号，两者应当恒等，这里仍然都写，是为了让「万一又串台了」
            // 的错态表现为少画一个按钮，而不是给国际版账号画一个必然失败的按钮。
            const signinSupported = account.region === 'cn' && region === 'cn'
            return (
              <div key={account.id} className="wbm-account">
                <div className="wbm-account-head">
                  <label className="wbm-toggle" title={t('row.accountInPoolHint')}>
                    <input
                      type="checkbox"
                      checked={inPool(account.id)}
                      disabled={!configWritable || busy !== undefined}
                      onChange={event => { void togglePool(account.id, event.target.checked) }}
                    />
                    <span className="wbm-account-name">
                      {account.accountName === '' ? t('row.accountUnknown') : account.accountName}
                    </span>
                  </label>
                  <span className="wbm-tag wbm-tag-neutral">
                    {t(account.region === 'global' ? 'row.regionGlobal' : 'row.regionCn')}
                  </span>
                  {account.selected ? <span className="wbm-tag wbm-tag-ok">{t('row.accountCurrent')}</span> : null}
                  {excluded === undefined ? null : <span className="wbm-tag wbm-tag-danger">{excluded}</span>}
                </div>

                {/* 为什么在这一位。放在名字与标签之后、来源文件之前：用户刚看完
                    「这是哪个账号」，接着要知道「它现在算不算数」。 */}
                {rankReason === undefined ? null : (
                  <p className="wbm-secondary">{rankReason}</p>
                )}

                {/* 来源文件：只说「从哪个文件读到的」，不含任何令牌内容。 */}
                <div className="wbm-account-meta">
                  <span>{t(account.source === 'dsh' ? 'row.accountSourceDsh' : 'row.accountSourceDesktop')}</span>
                  <span className="wbm-account-path" title={account.sourcePath}>
                    {t('row.accountSourcePath', { path: account.sourcePath })}
                  </span>
                </div>

                {/* 积分 + 到期。读不到渲染 `—`，不渲染 0。 */}
                <div className="wbm-account-facts">
                  <span>
                    {t('row.creditsTotal')}{' '}
                    <strong>{reading.credits === undefined ? t('row.creditsUnknown') : formatCredits(reading.credits.total)}</strong>
                  </span>
                  {expiryText === undefined ? (
                    <span className="wbm-expiry wbm-expiry-none">{t('row.creditsNoExpiry')}</span>
                  ) : (
                    <span className={facts.soon ? 'wbm-expiry wbm-expiry-soon' : 'wbm-expiry wbm-expiry-future'}>
                      {t('row.creditsExpiry', { time: expiryText })}
                    </span>
                  )}
                </div>

                {/* 临期提醒：整行高亮并说清「还剩多少分、多少天到期」。 */}
                {facts.expiringSoon > 0 ? (
                  <p className="wbm-expiry wbm-expiry-soon" role="status">
                    {t('row.creditsExpiringSoon', {
                      amount: formatCredits(facts.expiringSoon),
                      days: facts.days ?? warnDays,
                    })}
                  </p>
                ) : null}

                {/* 积分包明细：默认展开。本机实测一个账号可以有 59 个包，但列表自身有
                    `max-height:220px; overflow-y:auto`（`styles.ts` 的 `.wbm-packages-list`），
                    最多撑到 220px 并在内部滚动，不会把签到按钮挤出屏幕。摘要行只说条数，
                    点它可收起（想一屏看全时用）。**不做「前 N 条 + 其余折叠」**——两层折叠
                    需要第二套文案与第二个展开动作，而这里的数据量是一次性看完就能决策的。 */}
                <CreditPackages t={t} credits={reading.credits} accountId={account.id} />

                {/* 签到。国际版不画按钮，只画一句只读说明：这两条按钮点下去要往后端
                    发一次必然被拒的请求，用户拿到的是一个「失败」，而真相是这个区域
                    本来就没有这个功能。权益领取同理——它们与签到是同一套计费侧动作。 */}
                {signinSupported ? (
                  <div className="wbm-account-facts">
                    <CheckinLine t={t} status={checkinStatus} />
                    <button
                      type="button"
                      className="dsm-btn dsm-btn-sm dsm-btn-outline"
                      disabled={busy !== undefined || checkinStatus?.todayCheckedIn === true || checkinStatus?.active === false}
                      onClick={() => { void checkin(account) }}
                    >
                      {busy === `checkin:${account.id}` ? t('row.checkinClaiming') : t('row.checkinClaim')}
                    </button>
                    {/* 顺带领取权益：只在自动任务关闭时手动露出，否则会与自动流程重复。 */}
                    {automation.claimBenefits ? null : WB_BENEFIT_KINDS.map(kind => (
                      <button
                        key={kind}
                        type="button"
                        className="dsm-btn dsm-btn-sm"
                        disabled={busy !== undefined}
                        onClick={() => { void claimBenefit(account, kind) }}
                      >
                        {t(kind === 'gift' ? 'benefit.gift' : 'benefit.compensation')}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="wbm-muted">{t('row.checkinUnsupportedRegion')}</p>
                )}
                {note === undefined ? null : <p className="wbm-ok" role="status">{note}</p>}
              </div>
            )
          })
        )}

        {/* 被跳过的文件：**必须**出现。否则「2 个账号」与「4 个文件里 2 个读不了」
            在界面上看起来一模一样，用户没有任何线索知道某次登录为什么不见了。 */}
        {skipped.length === 0 ? null : (
          <div className="wbm-skipped">
            <h4 className="wbm-section-title">{t('row.skippedTitle')}</h4>
            <p className="wbm-section-hint">{t('row.skippedHint')}</p>
            {skipped.map(file => (
              <div key={file.path} className="wbm-skipped-row">
                <span className="wbm-skipped-path" title={file.path}>{file.path}</span>
                <span>
                  {t(`row.skippedReason.${file.reason}` as WbModelsSettingsKey)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── 自动签到 ─────────────────────────────────────────────────── */}
      <section className="wbm-card">
        <h3 className="wbm-section-title">{t('row.automationTitle')}</h3>
        <label className="wbm-toggle" title={t('row.autoEnabledHint')}>
          <input
            type="checkbox"
            checked={automation.enabled}
            disabled={!configWritable || busy !== undefined}
            onChange={event => { void writeAutomation({ enabled: event.target.checked }) }}
          />
          <span>{t('row.autoEnabled')}</span>
        </label>
        <p className="wbm-section-hint">{t('row.autoEnabledHint')}</p>

        <div>
          <span className="wbm-secondary">{t('row.autoHours')}</span>
          <div className="wbm-hours" role="group" aria-label={t('row.autoHours')}>
            {Array.from({ length: 24 }, (_, hour) => (
              <button
                key={hour}
                type="button"
                aria-pressed={hours.includes(hour)}
                className={hours.includes(hour) ? 'wbm-hour wbm-hour-on' : 'wbm-hour'}
                disabled={!configWritable || busy !== undefined}
                onClick={() => { toggleHour(hour) }}
              >
                {String(hour).padStart(2, '0')}
              </button>
            ))}
          </div>
          <p className="wbm-section-hint">{t('row.autoHoursHint')}</p>
        </div>

        <label className="wbm-toggle" title={t('row.autoClaimBenefitsHint')}>
          <input
            type="checkbox"
            checked={automation.claimBenefits}
            disabled={!configWritable || busy !== undefined}
            onChange={event => { void writeAutomation({ claimBenefits: event.target.checked }) }}
          />
          <span>{t('row.autoClaimBenefits')}</span>
        </label>
        <p className="wbm-section-hint">{t('row.autoClaimBenefitsHint')}</p>
      </section>

      {/* ── 模型区 ───────────────────────────────────────────────────── */}
      <section className="wbm-card">
        <h3 className="wbm-section-title">
          {t('row.modelsTitle')}
          {modelsDirty ? <span className="wbm-tag wbm-tag-warn">{t('row.modelsDirty')}</span> : null}
        </h3>
        <p className="wbm-section-hint">{t('row.modelsHint')}</p>
        {/*
          数据新鲜度。三件事必须分开说，否则用户又回到「这些徽标是不是写死的」：
          ① 从没取到过（内置列表，没有促销条目）；
          ② 取到过，报出是哪一刻；
          ③ 已经超过 TTL 还在显示旧值（后台正在补，但这一帧仍是旧的）。

          `modelsAgeMs` 由服务端算好（`buildStatus`），因为差值得用同一个时钟：
          拿客户端的钟去减服务端的时间戳，两边有偏差时就会显示成负数。
        */}
        <p className="wbm-muted wbm-models-freshness">
          {modelsFetchedAtMs === undefined
            ? t('row.modelsFetchedNever')
            : t('row.modelsFetchedAt', { time: formatAge(modelsAgeMs) })
              + (modelsAgeMs !== undefined && modelsAgeMs >= WB_CATALOG_TTL_MS ? t('row.modelsFetchedStale') : '')}
          {refreshingModels ? ` ${t('row.modelsRefreshing')}` : ''}
        </p>
        <div className="wbm-page-actions">
          <button
            type="button"
            className="dsm-btn dsm-btn-sm"
            disabled={models.length === 0 || allPicked}
            onClick={() => { pickAll(true) }}
          >
            {t('row.modelsSelectAll')}
          </button>
          <button
            type="button"
            className="dsm-btn dsm-btn-sm"
            disabled={models.length === 0 || pickedModels.size === 0}
            onClick={() => { pickAll(false) }}
          >
            {t('row.modelsSelectNone')}
          </button>
        </div>

        {models.length === 0 ? (
          <p className="wbm-muted">{t('row.modelsEmpty')}</p>
        ) : (
          models.map(model => (
            <label key={model.id} className="wbm-model">
              <input
                type="checkbox"
                checked={pickedModels.has(model.id)}
                onChange={() => { toggleModel(model.id) }}
              />
              <span className="wbm-model-body">
                <span className="wbm-model-head">
                  <span className="wbm-model-name">{model.name}</span>
                  {/*
                    倍率：`undefined` 时**整段不渲染**（不是 0.00x）。CN 的 fallback
                    目录整份没有该字段，把 undefined 当 0 会把收费模型显示成免费。
                    照参考插件 WorkBuddyCard.tsx:1745-1746 的做法。
                  */}
                  {model.creditMultiplier === undefined ? null : (
                    <span className="wbm-muted">({model.creditMultiplier.toFixed(2)}x)</span>
                  )}
                  {/*
                    促销/档位徽标。**此刻**成立才画：`selectPromoBadge` 按时钟把
                    「夜间免费」这类活动窗算进去，闭窗后徽标自己消失，不需要重取数据。
                    `model.promos` 是上游原样的候选（按 priority 降序），解析推迟到
                    这里，因为「哪一条成立」取决于看的时刻，不取决于取数时刻。

                    颜色取上游的 `badge.color`（CN 绿 #009273 / global 红 #FF0000），
                    用内联样式覆盖 `.wbm-tag` 的边框与文字色；不可解析时退回 neutral。
                  */}
                  {(() => {
                    const promo = selectPromoBadge(model.promos ?? [], nowMs)
                    if (promo === undefined) return null
                    const color = promoBadgeColor(promo)
                    return (
                      <span
                        className="wbm-tag"
                        style={color === undefined ? undefined : { color, borderColor: color }}
                        title={promoBadgeTooltip(promo, promoLanguage)}
                      >
                        {promoBadgeLabel(promo, promoLanguage)}
                      </span>
                    )
                  })()}
                </span>
                <span className="wbm-model-facts">
                  <span className="wbm-model-id">{t('row.modelsId', { id: model.id })}</span>
                  {/*
                    窗口与最大输出一起显示，因为它们是同一个决定的两半：用户要判断
                    「这个模型能不能装下我的项目」看上下文，要判断「它能不能一次写完
                    一个文件」看最大输出。只给前者会让人以为输出上限等于上下文。
                  */}
                  {model.contextWindow === undefined ? null : (
                    <span>{t('row.modelsContext', { count: model.contextWindow.toLocaleString('zh-CN') })}</span>
                  )}
                  {model.maxTokens === undefined ? null : (
                    <span>{t('row.modelsMaxOutput', { count: model.maxTokens.toLocaleString('zh-CN') })}</span>
                  )}
                </span>
              </span>
            </label>
          ))
        )}

        <div className="wbm-page-actions">
          <button
            type="button"
            className="dsm-btn dsm-btn-sm dsm-btn-primary"
            disabled={!modelsDirty || busy !== undefined}
            onClick={() => { void saveModels() }}
          >
            {busy === 'models-save' ? t('row.modelsSaving') : t('row.modelsSave')}
          </button>
        </div>
      </section>

      {/* ── 账户使用方式（R4）───────────────────────────────────────── */}
      <section className="wbm-card">
        <h3 className="wbm-section-title">{t('row.distributionLabel')}</h3>
        <div className="wbm-choices" role="radiogroup" aria-label={t('row.distributionLabel')}>
          {ACCOUNT_DISTRIBUTIONS.map(mode => {
            const active = distributionOf(config?.distribution ?? DEFAULT_ACCOUNT_DISTRIBUTION) === mode
            return (
              <label key={mode} className={active ? 'wbm-choice wbm-choice-on' : 'wbm-choice'}>
                <input
                  type="radio"
                  name="wbm-distribution"
                  checked={active}
                  disabled={!configWritable || busy !== undefined}
                  onChange={() => { void writeConfig('distribution', mode) }}
                />
                <span className="wbm-choice-body">
                  <span className="wbm-choice-label">{distributionLabel(t, mode)}</span>
                  <span className="wbm-choice-hint">{distributionHint(t, mode)}</span>
                </span>
              </label>
            )
          })}
        </div>
      </section>

      {/* ── 显示设置 ─────────────────────────────────────────────────── */}
      <section className="wbm-card">
        <h3 className="wbm-section-title">{t('row.displayTitle')}</h3>
        <label className="wbm-toggle" title={t('row.showCreditsInComposerHint')}>
          <input
            type="checkbox"
            checked={config?.showCreditsInComposer !== false}
            disabled={!configWritable || busy !== undefined}
            onChange={event => { void writeConfig('showCreditsInComposer', event.target.checked) }}
          />
          <span>{t('row.showCreditsInComposer')}</span>
        </label>
        <p className="wbm-section-hint">{t('row.showCreditsInComposerHint')}</p>

        <label className="wbm-field">
          <span>{t('row.expiryWarnDays')}</span>
          <input
            type="number"
            min={EXPIRY_WARN_DAYS_MIN}
            max={EXPIRY_WARN_DAYS_MAX}
            step={1}
            value={warnDays}
            disabled={!configWritable || busy !== undefined}
            onChange={event => {
              const raw = Number(event.target.value)
              if (!Number.isFinite(raw)) return
              // 夹在合法区间里：写进配置的是夹过的值，界面回显也用它，
              // 于是「输入 0 天」不会存成一份 0 天窗口（永远不提醒）。
              const next = Math.min(EXPIRY_WARN_DAYS_MAX, Math.max(EXPIRY_WARN_DAYS_MIN, Math.round(raw)))
              void writeConfig('expiryWarnDays', next)
            }}
          />
        </label>
        <p className="wbm-section-hint">
          {t('row.expiryWarnDaysHint', { min: EXPIRY_WARN_DAYS_MIN, max: EXPIRY_WARN_DAYS_MAX })}
        </p>
      </section>
    </div>
  )
}

/**
 * 一个账号的积分包明细（默认展开）。
 *
 * ## 为什么默认展开
 *
 * 这一块的存在意义就是「我现在能用哪几份、各什么时候作废」——默认折叠等于让用户
 * 先点一次才看到它唯一想传达的内容。列表自身有 `max-height:220px; overflow-y:auto`
 * （见 `styles.ts` 的 `.wbm-packages-list`），一个账号 59 个包也只是把这一块撑到
 * 220px 高、内部滚动，不会把下面的签到按钮挤出屏幕。想一屏看全时仍可点摘要行收起。
 *
 * ## 为什么整块数据都在、却一直没画
 *
 * 后端从第一版起就把 `credits.packages` 原样塞进 `/status` 的账号读数里（本机实测
 * 单账号 26 / 48 / 59 条），但客户端从来只把它 `reduce` 成一个临期合计。于是用户
 * 看到的是「积分 4,071」加一句「有 388 分在 3 天内到期」，却没有任何办法知道
 * 这 4,071 分是哪些包、各自什么时候到期 —— 而「先用哪一份」正是这些数字唯一
 * 能支持的决策。
 *
 * ## 三条硬规则
 *
 * 1. **只显示 `remain / size`，不推算已用量。** 用户明确选了这个口径：剩余量是
 *    能花的数，已用量由它减得出来，多算一步就多一个会算错的地方。
 * 2. **周期包不参与到期排序、排最后、显示「周期刷新」。** 会刷新的包永不「过期」，
 *    混进到期序会让一个只剩周期包的账号长期看起来「刚过期」或「即将过期」。
 * 3. **空数据整块不渲染。** 没有 `credits`（上游没给余额）与「有余额但一个包都
 *    没列出来」是两种不同的事实，但对这一块来说都是「没有明细可说」——画一个
 *    空的「0 个积分包」摘要只是噪声。
 *
 * @param props.credits 账号读数里的积分聚合；`undefined` 表示上游没给。
 */
function CreditPackages(props: {
  t: WbTranslator
  credits: WbCredits | undefined
  accountId: string
}) {
  const { t, credits, accountId } = props
  // 默认展开：这块内容就是用户要看的「哪几份积分、各什么时候作废」。收起是可选项，
  // 展开是默认状态——反过来说，默认折叠会让用户以为这里没有明细。
  const [open, setOpen] = useState(true)
  const rows = creditPackageRowsOf(credits)
  if (rows.length === 0) return null
  const panelId = `wbm-credit-packages-${accountId}`
  return (
    <div className="wbm-packages">
      <button
        type="button"
        className="wbm-packages-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => { setOpen(current => !current) }}
      >
        {t('row.creditPackagesToggle', { count: rows.length })}
      </button>
      {open ? (
        <ul className="wbm-packages-list" id={panelId}>
          {rows.map(row => (
            <li key={row.key} className="wbm-packages-row">
              {/* 上游原文直接显示：这是计费侧的包名，翻译它会让用户拿着界面上
                  的名字去对账对不上。 */}
              <span className="wbm-packages-name">{row.packageName}</span>
              <span className="wbm-packages-amount">{row.amountText}</span>
              <span className="wbm-muted">{creditPackageWhenText(t, row)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * 一行明细的「什么时候」。
 *
 * 周期包说「周期刷新」+ 下次刷新时刻，一次性包说到期时刻；两者都没有时说「无到期
 * 信息」——**不**渲染 `0`、`NaN`、`Invalid Date`，也不编一个假时间。
 */
export function creditPackageWhenText(t: WbTranslator, row: CreditPackageRow): string {
  if (row.monthly) {
    const refresh = formatTime(row.refreshAtMs)
    return refresh === undefined
      ? t('row.creditPackageMonthly')
      : `${t('row.creditPackageMonthly')} · ${t('row.creditPackageRefreshes', { time: refresh })}`
  }
  const expires = formatTime(row.expiresAtMs)
  return expires === undefined
    ? t('row.creditPackageNoExpiry')
    : t('row.creditPackageExpires', { time: expires })
}

/** 签到状态那一小段：是否已签 / 连续天数 / 今日可得。 */
function CheckinLine(props: { t: WbTranslator; status: WbCheckinStatus | undefined }) {
  const { t, status } = props
  // 该账号没有签到活动：说清楚，而不是画一个永远按不动的按钮。
  if (status === undefined || status.active === false) {
    return <span className="wbm-muted">{t('row.checkinDisabled')}</span>
  }
  return (
    <span className="wbm-account-facts">
      <span className={status.todayCheckedIn ? 'wbm-tag wbm-tag-ok' : 'wbm-tag wbm-tag-warn'}>
        {status.todayCheckedIn ? t('row.checkinDone') : t('row.checkinPending')}
      </span>
      {status.streakDays > 0 ? (
        <span className="wbm-muted">{t('row.checkinStreak', { days: status.streakDays })}</span>
      ) : null}
      {status.todayCredit > 0 ? (
        <span className="wbm-muted">{t('row.checkinToday', { credit: formatCredits(status.todayCredit) })}</span>
      ) : null}
      {/* 连续奖励日：只在今天真的能多拿的时候才提。 */}
      {status.isStreakDay && status.streakBonusCredit > 0 ? (
        <span className="wbm-muted">
          {t('row.checkinBonus', { days: status.nextStreakDay, credit: formatCredits(status.streakBonusCredit) })}
        </span>
      ) : null}
    </span>
  )
}
