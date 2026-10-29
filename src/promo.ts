/**
 * 上游的促销 / 档位徽标：解析、按时间解析、以及给人看的文案。
 *
 * ## 为什么单开一个模块，且**不花**任何额外请求
 *
 * 徽标就躺在本插件已经在读的那份 `/v3/config` 文档里：`data.modelPromotions` 与
 * `data.modelTiers` 与 `data.models` 并排。所以画一个促销徽标的上游流量是 **0**，
 * 增加的只是一个解析器。
 *
 * 解析器必须存在，因为那两个数组**不是**干净的促销列表：`modelPromotions` 里还
 * 混着根本不是促销的条目（图像 / 视频模型，只有 `tags` / `videoGeneration`，既没有
 * `modelIds` 也没有 `badge`）。它们必须在这里被丢掉，而不是留到渲染层去判断。
 *
 * ## 为什么「解析」和「按时间选」分在两处
 *
 * 徽标是**时钟的函数**，不是取数的函数：上游的窗口是命名时区里的墙钟窗口
 * （`schedule.daily`，例如 `Asia/Shanghai` 的 `23:00`–`7:50`）与绝对窗口
 * （`schedule.validFrom` / `validUntil`）。如果解析时就把徽标定下来，那个答案是
 * **冻住**的：22:59 读到的「夜间折扣」到了次日 08:00 还在自称夜间。所以解析器
 * 保留**全部候选**，由渲染方在画的那一刻问「现在哪个成立」。
 *
 * ## 只有应用通道才看得见这两个数组
 *
 * 同一条 URL，用 CLI 通道的身份去问，回来的是严格子集：既没有 `modelPromotions`
 * 也没有 `modelTiers`。本插件的目录读取本来就用 `PRODUCT_UA`（应用通道），所以
 * 徽标与「应用里看到的一样」，且不需要第二个请求。
 *
 * @module dsh-connect-workbuddy-models/promo
 */

/** 上游希望徽标怎么出现。 */
export interface WbPromoBadge {
  /** 徽标自己的措辞，按区域本地化（CN 是 `限时免费`，global 是 `Free now`）。 */
  label: string
  /** 上游给了就用它：英文措辞。 */
  labelEn?: string
  /** 上游给了就用它：更短的措辞（窄行用）。 */
  shortLabel?: string
  /** 上游给了就用它：英文短措辞。 */
  shortLabelEn?: string
  /**
   * 徽标颜色，6 位 hex（CN 常见 `#009273` 绿，global 的 `Free now` 是 `#FF0000` 红）。
   *
   * 上游对部分促销给、部分不给（CN 的 tier 条目就没有），所以是可选的：缺了由界
   * 面退回自己的品牌色，而不是猜一个。
   */
  color?: string
  /**
   * `'activeOnly'` —— 徽标属于促销的**运行期**，活动结束就必须消失。
   *
   * 缺省 —— 徽标是**常驻**的：它描述这个模型，只要促销本身还在；促销的每日窗口
   * 只管折扣。上游的「夜间折扣」成对条目正是这么用的：一条带徽标 + 夜间时段，
   * 另一条带同一个徽标 + 白天时段。
   */
  display?: 'activeOnly'
}

/** 一个每日窗口，写的是 `schedule.timezone` 里的墙钟。 */
export interface WbPromoWindow {
  /** `'HH:mm'`，**含**。 */
  start: string
  /**
   * `'HH:mm'`，**不含**。
   *
   * `end` 小于等于 `start` 表示窗口**跨午夜**：`23:00`–`7:50` 就是实测到的 CN 夜间窗。
   */
  end: string
}

/** 促销什么时候跑。 */
export interface WbPromoSchedule {
  /** 每日窗口所用的 IANA 时区（`Asia/Shanghai`）。 */
  timezone?: string
  /** Epoch ms；在此之前促销还没开始。 */
  validFrom?: number
  /** Epoch ms；**到这一刻**促销就结束了（排他）。 */
  validUntil?: number
  /** 每日窗口，上游给了就有。 */
  daily?: readonly WbPromoWindow[]
  /**
   * 上游**发布**了 `daily`，但里面一个窗口都读不出来。
   *
   * 这与「没有 `daily`」是两件事：没有 `daily` 是 24 小时活动（促销在跑的时候折扣
   * 一直在），而每个窗口都解析失败的条目对「什么时候跑」什么都没说。把后者读成
   * 「一直跑」会把一个只做夜间的活动变成全天挂徽标 —— 那是唯一会**夸大**上游陈述
   * 的方向。所以带这个标记的促销永远不算「正在运行」：解析失败让徽标消失，而不是
   * 让它翻倍。
   */
  dailyUnusable?: true
}

/**
 * 上游给的折扣价（有就给）。
 *
 * 这是让「夜间折扣」徽标不只是装饰的东西：徽标说这个模型在打折，这个字段说
 * **打多少**。丢掉它就会出现「挂了夜间折扣的徽标、旁边还是原价」，用户看到的价
 * 与实际计费不一致。
 *
 * 实测形状（CN feed）：`{ discountedCredits: "0x", displayMode: "replace", factor: 0 }`。
 *
 * `discountedCredits` 是**带单位的字符串**（`"0x"` / `"0.06x"`），不是数字：
 * `Number("0.06x")` 是 `NaN`，所以必须解析、不能强转。`factor` 是上游偶尔给的
 * 比例（0.545 = 原价的 55%），只在 `discountedCredits` 读不出来时用；两者不一致时
 * 字符串赢 —— 它才是用户真正被扣的那个数。
 */
export interface WbPromoDiscount {
  /**
   * 促销期间用户付的倍率，例如免费就是 `0`。
   *
   * 从 `discountedCredits`（`"0x"` / `"0.06x"` / `"0.06"`）解析，或只在有 `factor`
   * 时从它推导。两者都读不到就是 `undefined`。
   */
  multiplier?: number
  /**
   * 上游的展示指令 —— 折扣价与目录价的关系。**两种拼写**都在 CN feed 上实测到过：
   *
   *   `'replace'`       —— 用折扣价**替代**原价显示（`hy3-free-trial-202608` 的 `"0x"`）。
   *   `'strikethrough'` —— 上游自己的客户端给原价划线再打折扣价
   *                        （`glm-52-night-discount-202607` 的 `"0.50x"`、
   *                        `hy4-night-discount-daytime-badge-202609` 的 `"0.00x"`、
   *                        `step-5-discount-daytime-badge-202610`）。
   *
   * 只认 `'replace'` 会静默丢掉除 hy3 试用之外的所有真实 CN 折扣：徽标亮着而价格
   * 不动。两种模式都表示「折扣价才是你要付的」，区别只在界面上要不要同时显示原价；
   * 本插件一行只显示一个数，所以两者同等对待。
   *
   * `undefined` 表示上游给了折扣却没标展示方式。**不据此行动**：字段缺失没有说明
   * 该怎么读那个数，猜 `'replace'` 等于凭猜改价。
   */
  displayMode?: 'replace' | 'strikethrough'
}

/** 上游给这个徽标配的说明文案。 */
export interface WbPromoHover {
  /** 中文措辞。 */
  textZh?: string
  /** 英文措辞。 */
  textEn?: string
}

/** 一条上游促销或档位，解析成本插件使用的形状。 */
export interface WbPromo {
  /** 上游的 id（`hy3-free-trial-202608`）。 */
  id: string
  /** 这条来自哪个数组。 */
  source: 'promotion' | 'tier'
  /** 徽标作用于哪些模型。 */
  modelIds: readonly string[]
  /** 徽标说什么、长什么样。 */
  badge: WbPromoBadge
  /** 上游的说明文案，有就有。 */
  hover?: WbPromoHover
  /** 促销什么时候跑，上游给了就有。 */
  schedule?: WbPromoSchedule
  /**
   * 上游的排序权重：数字越大，徽标越要紧。用来在多个都成立时**只挑一个**。
   */
  priority: number
  /** 促销期间的折扣价，上游给了就有。 */
  discount?: WbPromoDiscount
}

/** 一个像记录的值；其他一律 undefined。 */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** 去掉首尾空白后的非空字符串，否则 undefined。 */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * `'HH:mm'` → 距离当日零点的分钟数；其他形状一律 undefined。
 *
 * `24:00` 被接受，且**恰好**表示 1440（一天的结束）。上游今天把「全天」写成
 * `0:00`–`23:59`，这在 23:59 与零点之间留了一分钟的空洞，常驻活动在那分钟里会被
 * 读成「没在跑」。接受 `24:00` 让这种窗口可以被表达（也让上游将来能改）而不留空洞；
 * 作为**起点**仍然拒绝 —— 从 24:00 开始的一天是第二天，那是另一个陈述。
 *
 * 类型守卫是有用的，不是防御性装饰：上游喂的是字符串，`parseDaily` 的 `text()` 早
 * 就把数字丢掉了 —— 但**存下来的目录**是进这个函数的第二个独立入口，那条路上没有
 * 任何类型检查。一个数字 `start` 过去会在**渲染期**抛 `value.trim is not a function`，
 * 被宿主的槽位错误边界吃掉之后，整块配置区就白了。
 */
function minutesOfClock(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim())
  if (match === null) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return undefined
  if (minutes > 59) return undefined
  if (hours > 24) return undefined
  if (hours === 24) return minutes === 0 ? 24 * 60 : undefined
  return hours * 60 + minutes
}

/** 一个 ISO-8601 时刻 → epoch ms。数字是**故意**拒绝的。 */
function parseInstant(value: unknown): number | undefined {
  const raw = text(value)
  if (raw === undefined) return undefined
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? undefined : ms
}

/** 上游的 `modelIds` → 去重后的 id 列表。 */
function parseModelIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids: string[] = []
  for (const entry of value) {
    const id = text(entry)
    if (id !== undefined && !ids.includes(id)) ids.push(id)
  }
  return ids.length === 0 ? undefined : ids
}

/** 上游的 `badge` → 本插件的徽标形状。 */
function parseBadge(value: unknown): WbPromoBadge | undefined {
  const raw = record(value)
  if (raw === undefined) return undefined
  // label 是**必需**的：没有措辞的条目没东西可画，而上游的 `modelPromotions`
  // 数组里还混着图像 / 视频模型 —— 它们不是促销。在这里丢掉，卡片里就不会出现。
  const label = text(raw['label']) ?? text(raw['labelEn']) ?? text(raw['shortLabel']) ?? text(raw['shortLabelEn'])
  if (label === undefined) return undefined
  const labelEn = text(raw['labelEn'])
  const shortLabel = text(raw['shortLabel'])
  const shortLabelEn = text(raw['shortLabelEn'])
  const color = text(raw['color'])
  const display = raw['display'] === 'activeOnly' ? 'activeOnly' as const : undefined
  return {
    label,
    ...labelEn === undefined ? {} : { labelEn },
    ...shortLabel === undefined ? {} : { shortLabel },
    ...shortLabelEn === undefined ? {} : { shortLabelEn },
    ...color === undefined ? {} : { color },
    ...display === undefined ? {} : { display },
  }
}

/** 上游的 `hover` → 本插件的文案形状。 */
function parseHover(value: unknown): WbPromoHover | undefined {
  const raw = record(value)
  if (raw === undefined) return undefined
  const textZh = text(raw['textZh'])
  const textEn = text(raw['textEn'])
  if (textZh === undefined && textEn === undefined) return undefined
  return {
    ...textZh === undefined ? {} : { textZh },
    ...textEn === undefined ? {} : { textEn },
  }
}

/** 一个读不出来的端点**实际**是什么形状，供那唯一一行诊断用。 */
function shapeOf(value: unknown): string {
  if (typeof value === 'number') return 'number'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * 上游的 `schedule.daily` → 本插件能算的窗口。
 *
 * `label` 只用于诊断行，由调用方传入而不是从这里读：条目 id 在上一层（`parsePromo`）。
 */
function parseDaily(value: unknown, label: string): WbPromoWindow[] | undefined {
  if (!Array.isArray(value)) return undefined
  const windows: WbPromoWindow[] = []
  for (const entry of value) {
    const raw = record(entry)
    if (raw === undefined) continue
    const start = text(raw['start'])
    const end = text(raw['end'])
    // 端点不是钟点的窗口无法求值，丢掉而不是猜。但丢掉**最后一个**绝不能悄悄把
    // 「只在夜里」变成「一直」—— `parseSchedule` 会记下「发布了但不可用」。
    //
    // 日志刻意留在这条路径上（每次读文档一次），而不是每个渲染一次：客户端每 60s
    // 会对同样的窗口求值一遍，在那里打日志就是每个模型每分钟一行。
    if (start === undefined || end === undefined || minutesOfClock(start) === undefined || minutesOfClock(end) === undefined) {
      try {
        console.warn(
          `[dsh-connect-workbuddy-models] 促销 "${label}"：丢弃了一个读不出来的每日窗口`
          + `（start: ${shapeOf(raw['start'])}，end: ${shapeOf(raw['end'])}）；`
          + '上游可能改了时间格式',
        )
      } catch { /* 没有 console 的宿主仍然要能解析 */ }
      continue
    }
    windows.push({ start, end })
  }
  return windows.length === 0 ? undefined : windows
}

/**
 * 从上游的 `discountedCredits` 字符串里读出倍率。
 *
 * 上游把单位**写进值里**（`"0x"` / `"0.06x"` / `"0.06"`），所以剥掉尾部 `x` 而不是
 * 直接交给 `Number()`。读不成有限非负数的值一律拒绝 —— 给用户看一个错价格比看原价
 * 更糟，因为原价至少是真的。
 */
function multiplierOfCredits(value: unknown): number | undefined {
  const raw = text(value)
  if (raw === undefined) return undefined
  const stripped = raw.replace(/x$/iu, '').trim()
  if (stripped === '') return undefined
  const parsed = Number(stripped)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/** 上游的 `discount` → 本插件的折扣形状。 */
function parseDiscount(value: unknown): WbPromoDiscount | undefined {
  const raw = record(value)
  if (raw === undefined) return undefined
  const fromString = multiplierOfCredits(raw['discountedCredits'])
  const fromFactor = typeof raw['factor'] === 'number' && Number.isFinite(raw['factor']) && raw['factor'] >= 0
    ? raw['factor']
    : undefined
  // 字符串赢：它才是用户被扣的那个数。`factor` 只在字符串缺失或读不出来时补位。
  const multiplier = fromString ?? fromFactor
  const displayMode = raw['displayMode'] === 'replace' || raw['displayMode'] === 'strikethrough'
    ? raw['displayMode'] as 'replace' | 'strikethrough'
    : undefined
  if (multiplier === undefined && displayMode === undefined) return undefined
  return {
    ...multiplier === undefined ? {} : { multiplier },
    ...displayMode === undefined ? {} : { displayMode },
  }
}

/** 上游的 `schedule` → 本插件的排期形状。 */
function parseSchedule(value: unknown, label: string): WbPromoSchedule | undefined {
  const raw = record(value)
  if (raw === undefined) return undefined
  const timezone = text(raw['timezone'])
  const validFrom = parseInstant(raw['validFrom'])
  const validUntil = parseInstant(raw['validUntil'])
  const daily = parseDaily(raw['daily'], label)
  // 上游**发布**了 `daily`（它是数组且至少一条），却一条都没能留下。那是解析失败，
  // 不是「没有时段」：记下来，让这条促销被当成「永不运行」而不是 24 小时活动。空
  // 数组是上游什么都没说，与缺席无法区分，仍然算「一直」。
  const dailyUnusable = daily === undefined
    && Array.isArray(raw['daily'])
    && raw['daily'].length > 0
  if (timezone === undefined && validFrom === undefined && validUntil === undefined && daily === undefined && !dailyUnusable) return undefined
  return {
    ...timezone === undefined ? {} : { timezone },
    ...validFrom === undefined ? {} : { validFrom },
    ...validUntil === undefined ? {} : { validUntil },
    ...daily === undefined ? {} : { daily },
    ...dailyUnusable ? { dailyUnusable: true as const } : {},
  }
}

/** 一条上游条目 → 本插件的促销形状；不是促销就 undefined。 */
function parsePromo(value: unknown, source: 'promotion' | 'tier'): WbPromo | undefined {
  const raw = record(value)
  if (raw === undefined) return undefined
  // 显式 `enabled: false` 的条目不是促销。`enabled` 缺席表示启用 —— 上游只在关掉
  // 某一条时才写这个字段。
  if (raw['enabled'] === false) return undefined
  const modelIds = parseModelIds(raw['modelIds'])
  if (modelIds === undefined) return undefined
  const badge = parseBadge(raw['badge'])
  if (badge === undefined) return undefined
  const hover = parseHover(raw['hover'])
  // id 在 schedule **之前**解析，好让被丢掉的窗口能报出它属于哪一条。
  const id = text(raw['id']) ?? `${source}:${modelIds.join(',')}`
  const schedule = parseSchedule(raw['schedule'], id)
  const discount = parseDiscount(raw['discount'])
  const priority = typeof raw['priority'] === 'number' && Number.isFinite(raw['priority']) ? raw['priority'] : 0
  return {
    id,
    source,
    modelIds,
    badge,
    ...hover === undefined ? {} : { hover },
    ...schedule === undefined ? {} : { schedule },
    ...discount === undefined ? {} : { discount },
    priority,
  }
}

/**
 * 解析上游的促销与档位两个数组。
 *
 * 两个数组都来自名册所在的**同一份**文档，所以这一步不花任何请求。不是促销的条目
 * （没有 `modelIds`、没有 `badge`、或 `enabled: false`）在这里丢掉，好让下游都能
 * 假定「一条 promo 就是画得出来的」。
 *
 * 促销排在档位之前，于是 `priority` 打平时偏向促销：价格徽标（`Free now`）比访问
 * 档位徽标（`Pro Only`）对用户更可行动，而上游给它们编了同样的数（实测都是 200）。
 */
export function parseWorkBuddyPromos(rawPromotions: unknown, rawTiers: unknown): WbPromo[] {
  const promos: WbPromo[] = []
  for (const entry of Array.isArray(rawPromotions) ? rawPromotions : []) {
    const promo = parsePromo(entry, 'promotion')
    if (promo !== undefined) promos.push(promo)
  }
  for (const entry of Array.isArray(rawTiers) ? rawTiers : []) {
    const tier = parsePromo(entry, 'tier')
    if (tier !== undefined) promos.push(tier)
  }
  return promos
}

/**
 * 把点了名的促销挂到对应模型上。
 *
 * 结果是**故意未解析**的：每一条点名了该模型的候选都跟着走，好让徽标在渲染时对着
 * 时钟选（见 {@link selectPromoBadge}）。在这里解析等于把答案冻在取数时刻 —— 那正是
 * 「夜间折扣」在夜里过去之后还自称夜间的那个缺陷。
 */
export function attachPromos<T extends { id: string }>(
  models: readonly T[],
  promos: readonly WbPromo[],
): (T & { promos?: readonly WbPromo[] })[] {
  if (promos.length === 0) return [...models]
  const byModel = new Map<string, WbPromo[]>()
  for (const promo of promos) {
    for (const modelId of promo.modelIds) {
      const list = byModel.get(modelId)
      if (list === undefined) byModel.set(modelId, [promo])
      else list.push(promo)
    }
  }
  return models.map(model => {
    const list = byModel.get(model.id)
    if (list === undefined) return model
    // 高 priority 在前，渲染方取第一个匹配即可。
    return { ...model, promos: [...list].sort((a, b) => b.priority - a.priority) }
  })
}

/**
 * `nowMs` 时刻在 `timeZone` 里距离当地零点的分钟数。
 *
 * 时区账由 `Intl` 算，因为上游的窗口写在**它**指定的时区里（CN feed 是
 * `Asia/Shanghai`），而用户自己的钟不一定在那个时区。时区不可用就退回 UTC 而不是
 * 抛错：画不出来的徽标是少一个徽标，不是坏掉的卡片。
 */
function zonedMinutes(nowMs: number, timeZone: string | undefined): number {
  const zone = timeZone ?? 'UTC'
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(nowMs))
    const hour = Number(parts.find(part => part.type === 'hour')?.value ?? '0')
    const minute = Number(parts.find(part => part.type === 'minute')?.value ?? '0')
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0
    return hour * 60 + minute
  } catch {
    return 0
  }
}

/** `nowMinutes` 是否落在某个每日窗口里。 */
function withinDailyWindows(windows: readonly WbPromoWindow[], nowMinutes: number): boolean {
  return windows.some(window => {
    const start = minutesOfClock(window.start)
    const end = minutesOfClock(window.end)
    if (start === undefined || end === undefined) return false
    // 端点相等是**24 小时**窗口（`[X:00, X:00+24h)`），不是空区间：终点不含、起点
    // 含，所以同一个钟点开始并结束的窗口覆盖一整天。这是「起点含、终点不含」唯一
    // 不能被读成空区间的地方。
    if (start === end) return true
    if (end > start) return nowMinutes >= start && nowMinutes < end
    // 跨午夜：`23:00`–`7:50` 就是实测到的 CN 夜间窗。
    return nowMinutes >= start || nowMinutes < end
  })
}

/**
 * 促销的**绝对**窗口此刻是否成立。
 *
 * 绝对窗口（`validFrom` / `validUntil`）是促销自己的寿命，它单独就能否掉徽标：寿命
 * 已经结束的促销不许继续宣传自己，无论它的每日时段怎么说。
 */
export function promoWithinAbsoluteWindow(promo: WbPromo, nowMs: number): boolean {
  const schedule = promo.schedule
  if (schedule === undefined) return true
  if (schedule.validFrom !== undefined && nowMs < schedule.validFrom) return false
  if (schedule.validUntil !== undefined && nowMs >= schedule.validUntil) return false
  return true
}

/**
 * 促销的**每日**窗口此刻是否成立。
 *
 * 每日窗口是折扣自己的时段 —— 它才是让一条促销成为「夜间折扣」的东西 —— 没有它的
 * 促销在绝对窗口成立期间一直跑。
 *
 * `daily` 发布了却求不出来的排期（{@link WbPromoSchedule.dailyUnusable}）**不算**在跑：
 * 上游确实说了这个活动有时段，我们只是读不出来，而假定「一直跑」是唯一会夸大的猜测。
 */
export function promoWithinDailyWindow(promo: WbPromo, nowMs: number): boolean {
  const schedule = promo.schedule
  if (schedule === undefined) return true
  if (schedule.dailyUnusable === true) return false
  if (schedule.daily === undefined || schedule.daily.length === 0) return true
  return withinDailyWindows(schedule.daily, zonedMinutes(nowMs, schedule.timezone))
}

/** 促销此刻是否**在跑**：绝对窗口与每日时段同时成立。 */
export function promoActiveAt(promo: WbPromo, nowMs: number): boolean {
  return promoWithinAbsoluteWindow(promo, nowMs) && promoWithinDailyWindow(promo, nowMs)
}

/**
 * 这条促销是否自带**任何**时间陈述。
 *
 * 档位徽标（`Pro Only`）根本没有 `schedule`：它无条件描述模型，所以 `promoActiveAt`
 * 对它恒真。这本身没错，但它会让这种徽标有资格参加第一步，从而遮住一条窗口真的
 * 开着、优先级更低的促销。「在跑」应该意味着「这条自己说它现在在跑」，而没有排期
 * 的条目从来不会这样 —— 它只会「常驻」。**带**排期（寿命、时段，或两者）的条目才是
 * 可能「在跑」的那些。
 */
function hasSchedule(promo: WbPromo): boolean {
  return promo.schedule !== undefined
}

/** 上游的 priority 降序；打平时促销优先于档位。 */
function byRanking(a: WbPromo, b: WbPromo): number {
  return b.priority - a.priority
    || (a.source === b.source ? 0 : a.source === 'promotion' ? -1 : 1)
}

/**
 * 此刻该给这个模型画哪个徽标；没有就 undefined。
 *
 * 两个答案的先后顺序就是全部要点：
 *
 * 1. **此刻在跑**的促销赢 —— 按 `priority` 从高到低。「在跑」= 绝对窗口与每日时段
 *    同时成立。
 * 2. 否则，一个**常驻**徽标（上游没标 `activeOnly` 的那种）只要促销本身还在，就继续
 *    描述这个模型。它只在促销的绝对窗口内提供，所以过期的促销会停止宣传自己，即使
 *    它的徽标本来是常驻的。
 *
 * 两条规则让第 2 步不说上游没说过的话：
 *
 * a. 发布了每日时段的条目可以在时段之外常驻（这正是「时段管折扣，不管徽标」的
 *    意思），但时段**解析不出来**的条目不能常驻 —— 见 `dailyUnusable`。
 * b. 完全没有排期的常驻条目不许压过一条真的在跑的促销。`promoActiveAt` 对无排期的
 *    档位返回 true，这本身没错，但它会让高优先级的档位遮住低优先级、窗口真的开着的
 *    活动。所以第 1 步只收**带排期**的条目；无排期的徽标只在第 2 步竞争。
 *
 * 一个模型只画一个徽标：模型行只有一行宽，两个徽标会把名字和勾选框挤出去。
 */
export function selectPromoBadge(
  promos: readonly WbPromo[] | undefined,
  nowMs: number,
): WbPromo | undefined {
  if (promos === undefined || promos.length === 0) return undefined
  const sorted = [...promos].sort(byRanking)
  const running = sorted.find(promo => hasSchedule(promo) && promoActiveAt(promo, nowMs))
  if (running !== undefined) return running
  return sorted.find(promo =>
    promo.badge.display !== 'activeOnly'
    && promoWithinAbsoluteWindow(promo, nowMs)
    // 解析不出来的时段永远不能成为「常驻」的理由。
    && promo.schedule?.dailyUnusable !== true)
}

/**
 * 此刻该**画**的倍率：有折扣在跑就是折扣价，否则 undefined（沿用目录自己的数）。
 *
 * 为什么与徽标分开。徽标回答「这个模型在搞活动吗」，这个回答「按什么价」。两者通常
 * 一致，但不总是 —— 不一致的时候用户会看到「夜间折扣」的徽标旁边写着原价。折扣与
 * 徽标在同一条条目里，所以两者可以由同一份文档、同一个时钟回答。
 *
 * 两条规则，都是关于不夸大：
 *
 *   1. 只有此刻**在跑**的促销才改价。常驻徽标（夜间折扣对里白天那一半）画在折扣
 *      时段之外，它**绝不能**改价 —— 那正是这个函数存在的理由。徽标允许常驻条目
 *      通过 `selectPromoBadge`，价格不允许。
 *   2. `displayMode` 必须写明，且值要能解析。有徽标但没有可读折扣的条目什么都不改，
 *      目录自己的数照旧。
 *
 * 返回 `undefined` 表示「目录价原样用」—— 调用方保留它本来画的那个数。在这里返回
 * 基值会让没有基值的调用方（`credits` 缺失的模型）凭空造一个。
 */
export function selectPromoMultiplier(
  promos: readonly WbPromo[] | undefined,
  nowMs: number,
): number | undefined {
  if (promos === undefined || promos.length === 0) return undefined
  const sorted = [...promos].sort(byRanking)
  for (const promo of sorted) {
    const discount = promo.discount
    if (discount === undefined || discount.multiplier === undefined) continue
    // 两种实测模式都表示「折扣价才是你要付的」。没标模式的折扣跳过：它的缺席没有
    // 说明该怎么读那个数。
    if (discount.displayMode !== 'replace' && discount.displayMode !== 'strikethrough') continue
    // 规则 1：**折扣**跑在每日窗口上，常驻徽标在窗口之外不许改价。
    if (!promoActiveAt(promo, nowMs)) continue
    return discount.multiplier
  }
  return undefined
}

// ── 给人看的文案 ──────────────────────────────────────────────────────────

/**
 * 界面语言，由浏览器报告。
 *
 * 卡片已经用浏览器 locale 格式化日期与数字，读同一个信号来选上游文案才一致：徽标说
 * 上游说的话，用用户读的那种语言。
 *
 * `navigator` 是防御性读取的 —— 本模块被单元测试在纯 Node 环境里 import，那里没有它。
 */
export function uiLanguage(): string {
  return typeof navigator === 'undefined' ? '' : navigator.language
}

/** 给定语言是不是英语。 */
function isEnglish(language: string | undefined): boolean {
  return (language ?? '').toLowerCase().startsWith('en')
}

/**
 * 徽标自己的措辞。
 *
 * 上游的 label 本身就是该区域的措辞，所以它对任何界面都是默认值。英文界面在上游
 * 给了 `labelEn` 时优先用它；global feed 不给 `labelEn`，而那里的 label 本来就是英文。
 */
export function promoBadgeLabel(promo: WbPromo, language?: string): string {
  const badge = promo.badge
  if (isEnglish(language)) return badge.labelEn ?? badge.label
  return badge.label
}

/**
 * 窄行里用的徽标措辞。
 *
 * 模型选择器的行只有一行宽，且已经带了模型名、倍率与拥挤度图标，一个四字标签
 * （`夜间折扣`）能把勾选框挤出这一行。上游正是为这种情况发布了紧凑措辞
 * （`shortLabel`）；它没给时，完整措辞仍然好过被裁掉的措辞：菜单行里的省略号读起来
 * 像被截断的词，而完整措辞最多是挤一点。
 */
export function promoBadgeShortLabel(promo: WbPromo, language?: string): string {
  const badge = promo.badge
  const short = isEnglish(language)
    ? (badge.shortLabelEn ?? badge.shortLabel)
    : badge.shortLabel
  return short ?? promoBadgeLabel(promo, language)
}

/**
 * 徽标颜色，仅当上游给的是能安全放进样式的颜色。
 *
 * 只接受 hex：这个值会进 inline style，而上游发布的是 hex（`#009273`、`#FF0000`）。
 * 其他形状一律拒绝而不是透传，界面退回自己的品牌色。
 */
export function promoBadgeColor(promo: WbPromo): string | undefined {
  const color = promo.badge.color
  if (color === undefined) return undefined
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu.test(color) ? color : undefined
}

/**
 * 一个日历日，用用户自己的 locale 读 —— 但按上游写下那个时刻的**时区**读。
 *
 * 时区是陈述的一部分，与每日时段同理。上游发布 `validFrom: "2026-07-06T00:00:00+08:00"`
 * 并把同一次活动描述成「7月6日–10月31日」；在 UTC 以西的时区格式化那个时刻会显示
 * 7月5日，与同一份 tooltip 里上游自己的文案矛盾。保留上游的时区让 tooltip 在任何地方
 * 读都自洽。
 *
 * 用 `medium` 而不是卡片的数字 `MM/DD`：这是促销的寿命，「2026年7月6日」读起来是日期，
 * 「07/06」读起来是用户要解码的数字。
 */
function formatDay(ms: number, language?: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat(language === undefined || language === '' ? undefined : language, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      ...timeZone === undefined ? {} : { timeZone },
    }).format(new Date(ms))
  } catch {
    // 不可用的语言标签**或**时区不能让用户丢掉整条 tooltip。
    return new Date(ms).toISOString().slice(0, 10)
  }
}

/**
 * 促销的寿命，用上游自己的两个端点表示。
 *
 * `validUntil` 是**排他**的 —— 见 {@link promoWithinAbsoluteWindow}：促销到那一刻就
 * 结束了。上游把它写成开启活动次日的那一个午夜，而它自己的文案对
 * `2026-11-01T00:00:00+08:00` 说「– Oct 31」。直接打印原始时刻会把「2026年11月1日」
 * 放进同一份 tooltip 里，读起来像活动多跑了一天。边界前一毫秒仍是属于它的最后一个
 * 时刻，所以画的是它。
 */
function promoRangeText(promo: WbPromo, language?: string): string | undefined {
  const schedule = promo.schedule
  if (schedule === undefined) return undefined
  const zone = schedule.timezone
  const from = schedule.validFrom === undefined ? undefined : formatDay(schedule.validFrom, language, zone)
  const to = schedule.validUntil === undefined ? undefined : formatDay(schedule.validUntil - 1, language, zone)
  if (from === undefined && to === undefined) return undefined
  if (from === undefined) return `– ${to ?? ''}`
  if (to === undefined) return `${from} –`
  return `${from} – ${to}`
}

/**
 * 折扣运行的时段，按上游指定的时区。
 *
 * 时区是陈述的一部分：「23:00–7:50」对在别的时区的读者毫无意义，而上游的窗口写在
 * **它**的时区里（CN feed 是 `Asia/Shanghai`），不是用户的。
 */
function promoHoursText(promo: WbPromo): string | undefined {
  const schedule = promo.schedule
  const daily = schedule?.daily
  if (daily === undefined || daily.length === 0) return undefined
  const windows = daily.map(window => `${window.start}–${window.end}`).join(', ')
  const zone = schedule?.timezone
  return zone === undefined ? windows : `${windows} (${zone})`
}

/**
 * 徽标的 tooltip：上游自己的文案、它的寿命、以及折扣运行的时段。
 *
 * 空的片段直接省掉而不是画成空白，所以一条只发布了 label 的促销得到一个只有 label、
 * 没有悬浮文案的徽标。
 */
export function promoBadgeTooltip(promo: WbPromo, language?: string): string {
  const parts: string[] = []
  const hover = promo.hover
  if (hover !== undefined) {
    const copy = isEnglish(language)
      ? (hover.textEn ?? hover.textZh)
      : (hover.textZh ?? hover.textEn)
    if (copy !== undefined) parts.push(copy)
  }
  const range = promoRangeText(promo, language)
  if (range !== undefined) parts.push(range)
  const hours = promoHoursText(promo)
  if (hours !== undefined) parts.push(hours)
  return parts.join(' · ')
}
