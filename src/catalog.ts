/**
 * 模型目录：静态兜底 + 实时刷新 + 用户选择过滤。
 *
 * 三件事各有一个明确的归属，混在一起就会出问题：
 *
 * 1. **静态兜底**（{@link FALLBACK_MODELS_CN} / {@link FALLBACK_MODELS_GLOBAL}）——
 *    照抄 `plugins/dsh-connect-workbuddy/src/catalog.ts:37-100`。它的存在只是为了让
 *    provider 在第一次实时刷新落地之前、或上游不通时**不为空**。两个区域各一份：
 *    CN 名册里没有 `gpt-*`/`gemini-*`，用 CN 名册去喂一个国际账号会让用户看到
 *    一堆点了必然失败的模型。
 * 2. **实时刷新**（{@link WbCatalog.applyFetch}）——从上游读到的名册替换兜底，
 *    带上真实的 `creditMultiplier`。
 * 3. **用户选择**（`enabledModelIds`）——过滤**在这里**完成，adapter 只暴露过滤后的
 *    列表。放在 adapter 里会让 shim 的 `/v1/models` 与 adapter 的模型列表各过滤一次，
 *    任何一次口径漂移都表现为「选择器里有这个模型，但选它 404」。
 *
 * @module dsh-connect-workbuddy-models/catalog
 */

import { busyDisplaySuffix, parseCreditMultiplier, type WbBusyLevel, type WbUpstreamModel } from './upstream.ts'
import type { WbModelInfo, WbRegion } from './status-paths.ts'

/**
 * 剥掉名字末尾的拥挤度符号后缀。
 *
 * 认「空格 + 已知符号」的形式，而不是记住上次加了几位：后者在名册被
 * {@link WbCatalog.applyFetch} 整份替换之后就会失配，于是名字越滚越长。
 * 多次循环是为了处理「上一次忘了剥、这一次又加」的历史脏值。
 */
function stripBusySuffix(name: string): string {
  let current = name
  for (;;) {
    const stripped = current.replace(/ (?:🚀|🧍🧍🧍|🧍🧍|🧍|🚫)$/u, '')
    if (stripped === current) return current
    current = stripped
  }
}

/**
 * CN 静态兜底名册（2026-08-30 抓取）。
 *
 * **整份没有 `creditMultiplier`**：上游 CN 的 `/v2/enterprises/personal/models` 在
 * 这个版本没给 `credits` 字段。这不是遗漏——照抄它才是对的：补一个 0 会把收费
 * 模型显示成免费，补一个猜测的倍率会让用户按错的成本预期选模型。`undefined`
 * 在界面上渲染成「倍率未知」，这是唯一诚实的表达。
 *
 * `auto` 路由模型刻意不在表里：它按请求解析成不同模型，不是本插件能描述的一行。
 */
export const FALLBACK_MODELS_CN: readonly WbModelInfo[] = [
  { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000 },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', contextWindow: 200_000, maxTokens: 64_000 },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 48_000 },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxTokens: 48_000 },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200_000, maxTokens: 48_000 },
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 512_000, maxTokens: 128_000 },
  { id: 'kimi-k3-1', name: 'Kimi-K3', contextWindow: 1_000_000, maxTokens: 32_000 },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code', contextWindow: 256_000, maxTokens: 32_000 },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, maxTokens: 32_000 },
  { id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash', contextWindow: 1_000_000, maxTokens: 50_000 },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1_000_000, maxTokens: 50_000 },
]

/**
 * 国际网关静态兜底名册（`www.workbuddy.ai/v3/config` 桌面通道，2026-09-11 抓取）。
 *
 * 这份**带倍率**（上游给了 `credits` 字段），所以国际版的「模型与倍率」列表在
 * 上游不通时也是准的。注意 `deepseek-v4.1-flash` 与 `hy4-preview`/`hy3` 是
 * `x0.00` 的促销免费模型——它们存在是「为什么国际版要读桌面通道」的理由
 * （CLI 通道的名册里没有促销模型）。
 */
export const FALLBACK_MODELS_GLOBAL: readonly WbModelInfo[] = [
  { id: 'default-model', name: 'Auto', contextWindow: 176_000, maxTokens: 24_000, creditMultiplier: 0.79 },
  { id: 'fast-model', name: 'Fast', contextWindow: 200_000, maxTokens: 32_000, creditMultiplier: 0.34 },
  { id: 'balanced-model', name: 'Balanced', contextWindow: 256_000, maxTokens: 32_000, creditMultiplier: 0.59 },
  { id: 'primary-model', name: 'Primary', contextWindow: 272_000, maxTokens: 72_000, creditMultiplier: 3.31 },
  { id: 'deep-model', name: 'Deep', contextWindow: 176_000, maxTokens: 24_000, creditMultiplier: 3.33 },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 0 },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 6.67 },
  { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1_000_000, maxTokens: 64_000, creditMultiplier: 0 },
  { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000, creditMultiplier: 0 },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 3.47 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 1.39 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 0.14 },
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 3.31 },
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272_000, maxTokens: 72_000, creditMultiplier: 1.65 },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3-Codex', contextWindow: 272_000, maxTokens: 72_000, creditMultiplier: 1.25 },
  { id: 'gemini-3.5-flash', name: 'Gemini-3.5-Flash', contextWindow: 1_000_000, maxTokens: 65_536, creditMultiplier: 0.99 },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 48_000, creditMultiplier: 0.79 },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxTokens: 48_000, creditMultiplier: 0.79 },
  { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 1_000_000, maxTokens: 32_000, creditMultiplier: 1.62 },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, maxTokens: 32_000, creditMultiplier: 0.52 },
]

/** 某区域的静态兜底名册。 */
export function fallbackModelsFor(region: WbRegion): readonly WbModelInfo[] {
  return region === 'global' ? FALLBACK_MODELS_GLOBAL : FALLBACK_MODELS_CN
}

/**
 * 上游条目 → 共享投影。
 *
 * 只做字段搬运，**不补默认倍率**：`creditMultiplier` 缺省就是未知。
 */
export function toModelInfo(model: WbUpstreamModel): WbModelInfo {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...model.creditMultiplier === undefined ? {} : { creditMultiplier: model.creditMultiplier },
    ...model.supportsImages === undefined ? {} : { supportsImages: model.supportsImages },
    ...model.description === undefined ? {} : { description: model.description },
    // 促销条目与拥挤度原样搬运，两者都**不在这一层解析**：
    // - `promos` 要由渲染方对着时钟选（`selectPromoBadge`），在这一层选等于把答案
    //   冻在取数时刻，「夜间折扣」到了白天就会还自称夜间；
    // - `busyLevel` 是取数那一刻的快照，本层没有更新的信息可用。
    // 空数组与缺键都不搬运：凭空补一个 `[]` 会让「这条模型有没有促销」这件事失真。
    ...(model.promos === undefined || model.promos.length === 0 ? {} : { promos: model.promos }),
    ...(model.busyLevel === undefined ? {} : { busyLevel: model.busyLevel }),
    // 推理档位原样搬运，**不在这里裁剪成 pi-ai 的已知档位**：裁剪要按 pi-ai 的
    // 词表做，而 `catalog.ts` 的浏览器半区拿不到宿主类型。搬到 `adapter.ts` 再裁，
    // 那里既能看见 pi-ai 的词表，也看得见 `WB_REFUSES_OFF_MODEL_IDS`。
    ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
  }
}

/**
 * 从上游原始条目里再解析一遍倍率，用于「实时名册丢了 credits 字段」的兜底。
 *
 * 为什么需要：`parseUpstreamModel` 已经在解析时调过 `parseCreditMultiplier`，
 * 但 `selectCliModels` 可能把条目从不同分支拼出来（live 名册 + 保留下来的旧条目），
 * 其中保留的那部分可能是**未经解析**的原始 JSON。再走一遍是幂等的，代价可忽略。
 */
export function reparseMultiplier(value: unknown): number | undefined {
  return parseCreditMultiplier(value)
}

/**
 * 按用户选择过滤。
 *
 * 两条语义（DESIGN.md §7，`plugins/dsh-connect-workbuddy/src/catalog.ts:198-215`）：
 *
 * 1. `enabled` 为空集 = **全部显示**。从未配置过的插件必须能用，否则用户装完
 *    看到空模型列表，会以为插件坏了。
 * 2. `enabled` 非空但与目录完全不相交 = **退化成全部显示**，而不是空。用户勾过的
 *    唯一模型可能已经从上游下架（例如 `auto` 路由模型），此时「一个都不显示」是
 *    最糟的结果：选择器空了，用户没有任何可点的东西去恢复。他表达的是「要一些
 *    模型开着」，退化满足了这个意图；而目录本身为空时才真的是空。
 */
export function deriveVisibleModels(
  catalog: readonly WbModelInfo[],
  enabled: readonly string[] | undefined,
): readonly WbModelInfo[] {
  const selected = enabled === undefined || enabled.length === 0
    ? catalog
    : catalog.filter(model => enabled.includes(model.id))
  return selected.length === 0 && catalog.length > 0 ? catalog : selected
}

/**
 * 一个区域的目录。
 *
 * `visible()` 是 adapter 与 shim 唯一该读的东西：它已经把用户选择应用过。
 */
export class WbCatalog {
  /** 最近一次实时名册；从未刷新时缺省。 */
  private live: readonly WbModelInfo[] | undefined
  private enabledIds: readonly string[] = []
  private lastUpdatedAtMs: number | undefined
  private lastError: string | undefined
  /** 该区域是否存在本机登录。默认 `true`（宽容方向）：扫描还没跑完时不该清空。 */
  private usable = true
  /** 用户是否显式启用了这个区域的 provider。默认 `true`（opt-out）。 */
  private enabled = true

  constructor(private readonly region: WbRegion) {}

  /** 当前该暴露给 DSH 的模型列表（已过滤）。 */
  visible(): readonly WbModelInfo[] {
    if (!this.usable || !this.enabled) return []
    return deriveVisibleModels(this.live ?? fallbackModelsFor(this.region), this.enabledIds)
  }

  /** 区域的静态兜底名册（诊断用；adapter 不该读它）。 */
  fallback(): readonly WbModelInfo[] {
    return fallbackModelsFor(this.region)
  }

  /** 当前目录里全部模型（未过滤），供设置页画勾选框。 */
  all(): readonly WbModelInfo[] {
    return this.live ?? fallbackModelsFor(this.region)
  }

  /** `'live'` 表示当前列表来自上游，`'fallback'` 表示还在用静态兜底。 */
  get source(): 'live' | 'fallback' {
    return this.live === undefined ? 'fallback' : 'live'
  }

  /**
   * 最近一次**成功**抓取的时刻；从未成功过则为 `undefined`。
   *
   * 这是「这份数据多久前抓的」的唯一真相，也是 TTL 判定的输入。
   *
   * `noteFetchFailure` **不**更新它，这一点是刻意的，并且是契约 `t31` 的一条
   * 判决性断言：上游一直不通时，若失败也把时钟往前推，TTL 就永远不会到期，
   * 于是「过期了就去试一次」永远不成立——一次失败会把自动刷新**永久饿死**，
   * 只剩重启宿主才能恢复。失败必须让时钟留在原地，下一个 `/status` 才会再试。
   *
   * 名字选 `lastFetchedAtMs` 而不是复用下面的 `lastUpdatedAt`：后者是 0.1.x 的
   * 历史名字，语义被读成「列表内容变了没有」（`applyFetch` 的返回值也是这个），
   * 两者混用会让 TTL 判定跟着内容去抖动。
   */
  get lastFetchedAtMs(): number | undefined {
    return this.lastUpdatedAtMs
  }

  /** 历史别名，等价于 {@link lastFetchedAtMs}（保留给既有读取方）。 */
  get lastUpdatedAt(): number | undefined {
    return this.lastUpdatedAtMs
  }

  get lastFetchError(): string | undefined {
    return this.lastError
  }

  /**
   * 该区域的目录按 `ttlMs` 是否已到该重抓的时候。
   *
   * 从未成功抓取过（`lastFetchedAtMs === undefined`）算**过期**：启动播种失败后
   * 还在用静态兜底的情况必须被允许重试，否则一次开机时的网络抖动会让整个会话
   * 停留在兜底名册上（兜底名册没有促销条目，用户看到的就是「徽标永远不出现」）。
   *
   * 容忍时钟回拨：`nowMs < lastFetchedAtMs` 时按过期处理。系统时间被往回拨
   * （或 NTP 校正）之后 `now - fetched` 会是负数，若照常比较就会得出「还很新」，
   * 而这个错误会一直持续到真实时间追上那个未来时间戳为止。
   */
  isStale(nowMs: number, ttlMs: number): boolean {
    if (this.lastUpdatedAtMs === undefined) return true
    if (nowMs < this.lastUpdatedAtMs) return true
    return nowMs - this.lastUpdatedAtMs >= ttlMs
  }

  /** 距上次成功抓取的毫秒数；从未抓取过则为 `undefined`。供界面对人显示。 */
  ageMs(nowMs: number): number | undefined {
    if (this.lastUpdatedAtMs === undefined) return undefined
    // 同样是时钟回拨：报 0 而不是负值，界面不必为此写一个特例。
    return Math.max(0, nowMs - this.lastUpdatedAtMs)
  }

  isUsable(): boolean {
    return this.usable
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** 记一次实时名册。空列表被拒——那会让所有模型从选择器里消失。 */
  applyFetch(models: readonly WbModelInfo[], atMs = Date.now()): boolean {
    if (models.length === 0) {
      this.lastError = '上游返回了空模型目录，已保留原有列表'
      return false
    }
    const before = JSON.stringify(this.live ?? [])
    this.live = models.map(model => ({ ...model }))
    this.lastUpdatedAtMs = atMs
    this.lastError = undefined
    return JSON.stringify(this.live) !== before
  }

  /** 记一次读目录失败；保留现有列表，只留原因。 */
  noteFetchFailure(message: string): void {
    this.lastError = message
  }

  /**
   * 只更新拥挤度，**不动**名册与 `lastUpdatedAtMs`。
   *
   * 为什么需要这条独立入口：拥挤度是分钟级事实、目录是小时级事实。若复用
   * {@link applyFetch}，一次「只问拥挤度」的刷新就会把 `lastFetchedAtMs` 推到当下，
   * 于是目录的 5 分钟 TTL 被这次拥挤度刷新**重置**——倍率与促销条目再也不会按时
   * 更新，而这正是用户抱怨的那个现象。
   *
   * 未在 `levels` 里出现的模型保留它原有的等级：上游只回答被问到的 id，漏答不等于
   * 「变回 unknown」。`name` 上的符号后缀要跟着重算，否则界面显示的还是上一次的。
   *
   * 返回是否真的变了（调用方据此决定要不耍刷新快照）。
   */
  applyBusy(levels: ReadonlyMap<string, WbBusyLevel>): boolean {
    if (this.live === undefined || levels.size === 0) return false
    let changed = false
    const next = this.live.map(model => {
      const level = levels.get(model.id)
      if (level === undefined || level === model.busyLevel) return model
      changed = true
      // 名字里的旧符号必须先剥掉再加新的，否则每刷新一次名字就长一截。剥法是
      // 认「空格 + 已知符号」这个后缀，而不是记住上次的长度——后者会在名册被
      // `applyFetch` 换掉之后失配。
      const base = stripBusySuffix(model.name)
      const suffix = busyDisplaySuffix(level)
      return { ...model, busyLevel: level, name: suffix === '' ? base : `${base}${suffix}` }
    })
    if (!changed) return false
    this.live = next
    return true
  }

  /** 用户改选择。空数组 = 全部显示。 */
  setEnabledIds(ids: readonly string[]): void {
    this.enabledIds = [...ids]
  }

  /** 该区域是否有本机登录。返回是否变化，调用方据此决定要不要刷新快照。 */
  setUsable(usable: boolean): boolean {
    if (this.usable === usable) return false
    this.usable = usable
    return true
  }

  /** 用户显式开关该区域的 provider。返回是否变化。 */
  setEnabled(enabled: boolean): boolean {
    if (this.enabled === enabled) return false
    this.enabled = enabled
    return true
  }

  /** 按 id 找一个模型（在**未过滤**的全量里找，供请求路径校验模型是否存在）。 */
  find(modelId: string): WbModelInfo | undefined {
    return this.all().find(model => model.id === modelId)
  }

  /**
   * 倍率的界面文案。
   *
   * `undefined`（未知）与 `0`（免费）必须给出**不同**的文字。这正是 R1-f「显示所有
   * 模型及模型使用倍率」要回答的问题：用户需要知道哪些是不要钱的、哪些是 1 倍、
   * 哪些是本插件也不知道的。
   */
  multiplierLabelOf(model: WbModelInfo): string {
    const multiplier = model.creditMultiplier
    if (multiplier === undefined) return '倍率未知'
    if (multiplier === 0) return '免费'
    return `${multiplier}×`
  }
}

/** 两个区域的目录一起持有，因为 adapter 与路由都要按区域取。 */
export class WbCatalogs {
  private readonly byRegion: Record<WbRegion, WbCatalog>

  constructor() {
    this.byRegion = { cn: new WbCatalog('cn'), global: new WbCatalog('global') }
  }

  of(region: WbRegion): WbCatalog {
    return this.byRegion[region]
  }

  /** 把用户选择应用到对应区域。**空数组 = 全部显示**，两线口径一致。 */
  applySelection(region: WbRegion, enabledIds: readonly string[] | undefined): void {
    this.of(region).setEnabledIds(enabledIds ?? [])
  }
}
