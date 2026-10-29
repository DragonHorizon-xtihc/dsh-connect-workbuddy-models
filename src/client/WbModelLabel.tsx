/**
 * 宿主模型选择器里的一行标签：模型名 + 本次该画的倍率 + 促销徽标。
 *
 * ## 为什么这个文件单独存在
 *
 * 宿主的 `conversation.input.model.label` 是一个 `kind: 'single'` 的座位 —— 一个
 * 单元格只有一个占用者，渲染的是**它**的输出。本插件要在选择器里画促销徽标，就
 * 只能占用这个座位，没有「附加装饰」的接口可用。
 *
 * ## 为什么优先级是 `-0.25`
 *
 * 这个值必须与已经占过这个座位的实现都不同，否则同一个单元格会被两个注册争抢，
 * 表现是「有时是这个插件的标签、有时是别人的」，且没有任何报错。已知占用者：
 * 宿主自带的 `ui-deepseek-model-label-1017` 用 `0`、`dsh-connect-qoder` 用 `-1`、
 * 已安装的 `dsh-connect-workbuddy` 5.7.0 用 `-0.5`。`-0.25` 与三者都不相交，且是
 * 0.25 的整数倍，排序时不产生浮点抖动。
 *
 * 导出这个常量是为了让测试断言**真正发出去的那个值**，而不是断言一份抄写。
 *
 * ## 为什么不是本插件的 provider 时返回纯名字而不是 `null`
 *
 * 座位契约里，占用者的返回值就是那一行的内容。返回 `null` 会让别的 provider 的
 * 模型行变成空标签 —— 本插件在服务自己的模型时顺手把邻居的显示弄没了，这是不可
 * 接受的副作用。返回 `model.name` 是座位契约给出的最小正确输出。
 *
 * ## 数据从哪来
 *
 * 一次 `/status?region=…` 就够：顶层 `busyLevels` 是按 id 索引的拥挤度，`models[]`
 * 里每个模型带自己的 `promos`（**未解析**）与目录倍率。两处都在同一份应答里，
 * 不需要额外端点，也不需要在这里重复解析上游。
 *
 * 拥挤度这里**不再画一遍**：模型名里已经带着上游给的符号（见 `src/upstream.ts`
 * 的 `busyDisplaySuffix`），再画一次就是同一件事说两遍。
 *
 * @module dsh-connect-workbuddy-models/client/WbModelLabel
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import {
  promoBadgeColor,
  promoBadgeLabel,
  promoBadgeShortLabel,
  promoBadgeTooltip,
  selectPromoBadge,
  selectPromoMultiplier,
  uiLanguage,
} from '../promo.ts'
import type { WbPromo } from '../promo.ts'
import { WB_STATUS_PATH, wbRegionOfProvider, withRegion } from '../status-paths.ts'
import type { WbRegion } from '../status-paths.ts'
import type { WbModelsSettingsKey } from './locales.ts'

/**
 * 本插件注册模型标签座位所用的优先级。
 *
 * 理由见文件头：`0` / `-1` / `-0.5` 已被占用，撞上就是无声的争抢。
 */
export const MODEL_LABEL_PRIORITY = -0.25

/** 一份快照被信任多久（毫秒）。 */
const CACHE_MS = 60_000

/** 挂载中的标签多久重读一次时钟（毫秒）。徽标的成立与否随时钟变化。 */
const TICK_MS = 60_000

/** 一个标签需要的事实，全部来自同一份 `/status` 应答。 */
interface StatusSnapshot {
  /** 按模型 id 索引的拥挤度（顶层 `busyLevels`）。 */
  levels: Readonly<Record<string, string>>
  /** 按模型 id 索引的**未解析**促销条目。 */
  promos: Readonly<Record<string, readonly WbPromo[]>>
  /** 按模型 id 索引的目录倍率，用于折扣期画出折扣价。 */
  rates: Readonly<Record<string, number>>
}

/** 每个区域一份快照，外加读取时刻。 */
const caches = new Map<WbRegion, { snapshot: StatusSnapshot, at: number }>()

/**
 * 读一次本区域的快照，短暂复用。
 *
 * `undefined` 表示**不知道** —— 调用方据此什么都不画。凭空的徽标比没有徽标更糟：
 * 它替上游声称了一件上游没说过的事。
 *
 * @param region - 要读哪个区域；两个网关是两份独立目录，问错就是串台。
 * @returns 快照，或 `undefined`（宿主不可达 / 应答不可用）。
 */
async function statusNow(region: WbRegion): Promise<StatusSnapshot | undefined> {
  const cached = caches.get(region)
  if (cached !== undefined && Date.now() - cached.at < CACHE_MS) return cached.snapshot
  try {
    const response = await fetch(withRegion(WB_STATUS_PATH, region), {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!response.ok) return undefined
    const body = await response.json() as {
      busyLevels?: Record<string, string>
      models?: readonly { id: string, creditMultiplier?: number, promos?: readonly WbPromo[] }[]
    }
    const promos: Record<string, readonly WbPromo[]> = {}
    const rates: Record<string, number> = {}
    for (const model of body.models ?? []) {
      if (model.creditMultiplier !== undefined) rates[model.id] = model.creditMultiplier
      if (model.promos !== undefined && model.promos.length > 0) promos[model.id] = model.promos
    }
    const snapshot: StatusSnapshot = { levels: body.busyLevels ?? {}, promos, rates }
    caches.set(region, { snapshot, at: Date.now() })
    return snapshot
  } catch {
    // 宿主不可达或拒答：不画徽标，绝不编一个。
    return undefined
  }
}

/** 忘掉缓存；供测试使用。 */
export function resetModelLabelCache(): void {
  caches.clear()
}

/** 一个共享的一分钟定时器，N 个挂载标签只花一个 timer。 */
const minuteTicker: { timer: ReturnType<typeof setInterval> | undefined, listeners: Set<() => void> } = {
  timer: undefined,
  listeners: new Set(),
}

/**
 * 挂载期间每分钟重渲染一次。
 *
 * 时钟是徽标的输入：23:00 开窗的折扣，在标签挂着不动的情况下也必须自己出现。
 *
 * @param listener - 每 tick 调用的回调。
 * @returns 退订函数；最后一个监听者离开时停掉共享定时器。
 */
function subscribeMinute(listener: () => void): () => void {
  minuteTicker.listeners.add(listener)
  if (minuteTicker.timer === undefined) {
    minuteTicker.timer = setInterval(() => {
      for (const each of [...minuteTicker.listeners]) each()
    }, TICK_MS)
    // 挂着的 interval 会让 Node 事件循环不退出。它只为界面存在，绝不能成为
    // 测试跑不完或 CLI 命令挂住的原因。
    const handle = minuteTicker.timer as unknown as { unref?: () => void }
    handle.unref?.()
  }
  return () => {
    minuteTicker.listeners.delete(listener)
    if (minuteTicker.listeners.size === 0 && minuteTicker.timer !== undefined) {
      clearInterval(minuteTicker.timer)
      minuteTicker.timer = undefined
    }
  }
}

/**
 * 把宿主渲染的名字拆成「名字」与「该画的那一个倍率」。
 *
 * `src/adapter.ts` 把倍率搭在显示名末尾（`… · x0.11`，免费是 `… · 免费`），因为
 * 选择器只渲染 `model.name`、没有独立的价格列。既然本组件已经能把价格单独画出来，
 * 就把它从名字里摘掉再画，**任何时刻只有一个数字**，而且那个数字是此刻成立的那个。
 *
 * 后缀按**形状**识别，不按与快照里的 `baseRate` 比对：两者可能不一致（促销在快照
 * 之后换了价），那时留在名字里的旧数字会与新数字并列 —— 正是本函数要消除的缺陷。
 *
 * @param name - 宿主渲染的名字，可能以 ` · x<rate>` 或 ` · 免费` 结尾。
 * @param baseRate - 快照里的目录倍率。
 * @param discounted - 折扣价；有折扣时用它替换。
 * @returns 去掉价格后缀的名字，与唯一该画的那个倍率。
 *          `rate` 为 `undefined` 表示「不画数字」。
 */
export function splitCatalogRate(
  name: string,
  baseRate: number | undefined,
  discounted: number | undefined,
): { base: string, rate: number | undefined } {
  // 两个后缀都由 `src/adapter.ts` 的 `displaySuffix` 生产：`x<倍率>`，或倍率为 0 时
  // 的「免费」（`\u514d\u8d39`）。这里用码位转义而不是字面量 —— 本文件是 .tsx，
  // 面向用户的汉字只能出现在 `locales.ts` 里。
  const match = /(?: · x(\d+(?:\.\d+)?)| · \u514d\u8d39)$/u.exec(name)
  const fromName = match === null
    ? undefined
    : match[1] === undefined ? 0 : Number(match[1])
  const base = match === null ? name : name.slice(0, match.index)
  // 折扣优先；否则用名字里带的那个数；再否则退回快照（有些名字不带后缀）。
  const rate = discounted ?? fromName ?? baseRate
  return { base, rate }
}

/**
 * 上游给的促销徽标，在选择器里画出来的样子。
 *
 * 样式全部内联、不新增类名：卡片那套 `.wbm-*` 规则是随卡片挂载时注入的，而选择器
 * 可能比卡片更早出现 —— 依赖它就等于让徽标有时有框、有时没有。
 *
 * @param props.promo - 此刻成立的促销条目。
 * @param props.compact - 是否窄行（菜单行）；影响用完整措辞还是紧凑措辞。
 * @returns 徽标。
 */
function PromoBadge(props: { promo: WbPromo, compact: boolean }): ReactElement {
  const { promo, compact } = props
  const language = uiLanguage()
  const label = compact ? promoBadgeShortLabel(promo, language) : promoBadgeLabel(promo, language)
  const color = promoBadgeColor(promo)
  const tooltip = promoBadgeTooltip(promo, language)
  const style: Record<string, string> = {
    display: 'inline-flex',
    alignItems: 'center',
    borderRadius: '6px',
    padding: '0 5px',
    fontSize: '11px',
    lineHeight: '1.6',
    whiteSpace: 'nowrap',
    border: '1px solid',
    // 颜色来自上游（CN 是 #009273 绿、global 是 #FF0000 红）；不可解析时退回品牌色，
    // 而不是透传一个可能非法的值。
    color: color ?? 'var(--dsw-alias-brand-primary,#5686fe)',
    borderColor: color ?? 'var(--dsw-alias-brand-primary,#5686fe)',
  }
  return (
    <span title={tooltip === '' ? undefined : tooltip} style={style}>{label}</span>
  )
}

/** 有状态的那一半：读快照，再按时钟画此刻成立的东西。 */
function WbModelLabelInner(props: {
  modelId: string
  name: string
  region: WbRegion
  compact: boolean
  t?: (key: WbModelsSettingsKey, params?: Record<string, unknown>) => string
}): ReactElement {
  const { modelId, name, region, compact, t } = props
  const [snapshot, setSnapshot] = useState<StatusSnapshot | undefined>(undefined)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let live = true
    void statusNow(region).then(next => {
      // 期间被新的读取取代：不让旧答案覆盖新答案。
      if (!live || next === undefined) return
      setSnapshot(next)
    })
    return () => { live = false }
  }, [modelId, region])

  useEffect(() => subscribeMinute(() => { setTick(count => count + 1) }), [])

  // 按时钟选，而不是按取数时刻选：缓存之后才开窗的夜间活动要能出现，已经闭窗的要消失。
  const promos = snapshot?.promos[modelId]
  const promo = promos === undefined ? undefined : selectPromoBadge(promos, Date.now())
  // 同一个时钟：常驻的「夜间折扣」在窗口之外不许改价。
  const discounted = promos === undefined ? undefined : selectPromoMultiplier(promos, Date.now())
  const { base, rate } = splitCatalogRate(name, snapshot?.rates[modelId], discounted)
  // 「免费」那句说明走 locale：本文件是 .tsx，代码区不许出现汉字（文案统一在
  // locales.ts 里，中英双份）。没有译器时宁可不画，也不写死中文。
  const rateText = rate === undefined
    ? undefined
    : rate === 0 ? t?.('row.modelsFree') : `x${rate.toFixed(2)}`

  // `tick` 是时钟的依赖：它的唯一作用是让上面两行在每分钟重算一次。
  void tick

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
      <span>{base}</span>
      {rateText === undefined ? null : (
        <span style={{ color: 'var(--dsw-alias-label-tertiary,#999)' }}>{rateText}</span>
      )}
      {promo === undefined ? null : <PromoBadge promo={promo} compact={compact} />}
    </span>
  )
}

/** 宿主选择器交给占用者的 props。 */
export interface WbModelLabelProps {
  provider: { id: string, name: string }
  model: { id: string, name: string }
  placement: 'trigger' | 'menu' | 'option'
  selected: boolean
  /**
   * 文案函数。注册座位时带上 `locale: namespace` 就由外壳注入。
   *
   * 可选：没有 locale 的宿主不该因此崩掉。那种情况下「免费」那句说明画不出来，
   * 但模型名、倍率与徽标照常 —— 比整行消失好。
   */
  t?: (key: WbModelsSettingsKey, params?: Record<string, unknown>) => string
}

/**
 * 选择器里的一行标签。
 *
 * 自足：本插件 provider 的模型得到完整标签，别的 provider 的模型得到纯名字。
 * 不去查别人的注册、不联动别的插件 —— 见文件头对优先级的说明。
 *
 * @param props - 宿主给的模型身份与这份标签所在的位置。
 * @returns 模型名、此刻该画的倍率，以及此刻成立的促销徽标。
 */
export function WbModelLabel(props: WbModelLabelProps): ReactElement {
  const { provider, model, placement, t } = props
  const region = wbRegionOfProvider(provider.id)
  if (region === undefined) {
    // 别的 provider 的模型。纯名字是座位契约的最小输出；返回 null 会把邻居的
    // 标签一起弄成空白，而本插件没有权利改别人的显示。
    return <span>{model.name}</span>
  }
  return (
    <WbModelLabelInner
      modelId={model.id}
      name={model.name}
      region={region}
      compact={placement !== 'trigger'}
      {...t === undefined ? {} : { t }}
    />
  )
}
