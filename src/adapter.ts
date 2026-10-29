/**
 * `dsh-connect-workbuddy-models` 的 pi-ai provider：注册进 Harness LLM seam 的回环
 * 适配器，由 `dsh-llm-pi-ai` 的公开扩展点装配。每个模型都指向本插件的回环 shim；
 * 账号选择留在 shim 内部（下一次请求由池重新选号）。
 *
 * 装配形状（`createProvider` + `openAICompletionsApi` + 惰性 auth 面 + 以 shim 的
 * 进程内 secret 作 apiKey）沿用同仓 `dsh-connect-trae-models/src/adapter.ts` 与
 * `dsh-workbuddy-xdpool` 的已验证设计（血统为 corrinehu/dsh-workbuddy-connect，MIT）。
 *
 * @module dsh-connect-workbuddy-models/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, CredentialStore, Model, Provider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { ReasoningEffortId, resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelReasoningInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import type { WbCatalog } from './catalog.ts'
import type { WbShim } from './shim.ts'
import { WB_PROVIDERS, WB_REFUSES_OFF_MODEL_IDS, type WbModelInfo, type WbRegion } from './status-paths.ts'

/**
 * 目录没给窗口时的兜底。
 *
 * DSH 对 `contextWindow` 缺失/非正数的模型会以 `INVALID_MODEL_CONTEXT` 失败，而那会
 * 拖垮**整条** provider 路由——比一个不精确的窗口严重得多。实时 CN 名册偶尔缺这个
 * 字段（`hy3` 早期版本就没有），所以这里必须有一个正数兜底。
 *
 * 取 128k 而不是 1M：低估会让 DSH 更早压缩上下文（可用性下降但不会 400），高估会让
 * 长请求直接被上游拒绝（看起来像「这个模型坏了」）。两种错的代价不对称。
 */
export const WB_DEFAULT_CONTEXT_WINDOW = 128_000

/** 目录没给输出上限时的兜底。同样取保守值。 */
export const WB_DEFAULT_MAX_TOKENS = 8_192

/**
 * 单次流读取挂起期间的 provider 空闲上限。
 *
 * 取 15 分钟，与 `dsh-connect-trae-models` 同值并沿用同一份证据：排队型通道在晚高峰
 * 把请求挂在队列里 6~10 分钟才排到（对照模型 1 秒级首字），5 分钟会在请求即将排到前
 * 被本地误杀。真正的「上游完全静默」另由 shim 的等待队列保护，不会靠这个值兜底。
 */
export const WB_STREAM_IDLE_TIMEOUT_MS = 900_000

/** dsh-llm-pi-ai 默认值下的图片请求预算（与同仓其它连接器一致）。 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
} as const

/**
 * 惰性 pi-ai auth 面。该路由只通过每请求解析的 shim 共享 secret 认证，所以 pi-ai
 * 自己的凭据生命周期绝不能为它制造凭据——真的生成一个会让 DSH 的 `auth login`
 * 界面出现一个永远登不进去的条目。
 */
const INERT_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() {
      throw new Error('dsh-connect-workbuddy-models: this route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

/**
 * 订阅制额度没有可推断的按 token 定价；报零。
 *
 * 不填一个「估算单价」是有意的：DSH 用 `cost` 做用量面板的金额，而 WorkBuddy 的
 * 计费单位是积分、倍率按模型浮动。编一个数字会让面板显示一个既不是钱也不是积分的
 * 东西。积分读数走本插件自己的状态路由。
 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

export interface WbAdapterOptions {
  shim: WbShim
  catalog: WbCatalog
  region: WbRegion
  /** 插件上下文；pi-ai adapter 从它取 `attachments`/`fs`。 */
  ctx: Context
  providerId?: string
  displayName?: string
}

/** {@link createWbAdapter} 交回的东西。 */
export interface WbAdapter {
  providerId: string
  displayName: string
  adapter: PiAiAdapter
  /** 从当前目录重建 pi-ai 模型列表。 */
  buildModels: () => Model<Api>[]
  /** 重建 adapter 的 provider 快照；目录更新后调用。 */
  invalidate: () => void
}

/** pi-ai 输入模态：只有目录宣告图片时才允许图片。 */
function modelInput(info: WbModelInfo): ('text' | 'image')[] {
  return info.supportsImages === true || info.multimodal === true ? ['text', 'image'] : ['text']
}

/** 中点分隔符：模型 id/名字里自带连字符与点，用空格中点才不会读成名字的一部分。 */
const DISPLAY_SEPARATOR = ' · '

/**
 * 倍率的显示后缀。
 *
 * `creditMultiplier === undefined` **不加任何后缀**，而不是打印「倍率未知」。
 *
 * 理由：CN 静态兜底名册整份没有该字段（上游那个版本没给 `credits`），所以启动后到
 * 第一次实时刷新之间，全部 11 个模型都会是「未知」；给每一行都挂上「倍率未知」会把
 * 模型选择器变成一屏噪声，而且那个状态是**临时的**。真正需要区分「未知 / 免费」的
 * 场合是设置页的模型表（`WbCatalog.multiplierLabelOf` 在那里给出完整文案），那里
 * 有列标题、有上下文，用户读得懂。
 *
 * `0` 打印成「免费」而不是 `x0.00`：后者读起来像零费率计费，且完全没表达促销含义。
 */
function displaySuffix(info: WbModelInfo): string | undefined {
  const multiplier = info.creditMultiplier
  if (multiplier === undefined) return undefined
  if (!Number.isFinite(multiplier)) return undefined
  if (multiplier === 0) return '免费'
  return `x${multiplier.toFixed(2)}`
}

/**
 * 把倍率搭到模型显示名上。
 *
 * 只影响显示：wire 请求由 `model.id` 构造，所以改名不可能影响路由、token 或上游计费。
 * DSH 的 composer（ModelSelect）只渲染 `model.name`，这正是「选模型时能看到倍率」
 * 只能靠改名字实现的原因——没有独立的价格列可用。
 */
function withMultiplierDisplay(name: string, info: WbModelInfo): string {
  const suffix = displaySuffix(info)
  return suffix === undefined ? name : `${name}${DISPLAY_SEPARATOR}${suffix}`
}

/**
 * pi-ai 能表达的思考档位，从低到高（不含 `off`）。
 *
 * 与 `upstream.ts` 的 `EFFORT_LADDER` 同序但**刻意分居两处**：那边是「上游会发什么」
 * 的解析阶梯，这边是「pi-ai 认什么」的适配词表。合并成一个常量会让上游悄悄多出一个
 * pi-ai 不认识的档位时，被本适配层无声吞下。
 */
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

type WbThinkingLevel = (typeof THINKING_LEVELS)[number]
type WbThinkingLevelMap = Partial<Record<'off' | WbThinkingLevel, string | null>>

/** 路由默认档位：目录没给默认值、用户也没选时用它。 */
export const WB_DEFAULT_EFFORT = 'high' as const

/**
 * 把上游的档位名单翻译成 pi-ai 的 `thinkingLevelMap`。
 *
 * `undefined` = **不宣告推理能力**，pi-ai 的 `getSupportedThinkingLevels` 随后只返回
 * `['off']`，composer 不画档位选择器。三种情形走到这里：
 *
 * 1. 上游没给 `reasoning`（`default` / `hunyuan-chat` / 静态兜底名册全部条目）；
 * 2. 上游给了但 `supportedEfforts` 是空的（`{}` 空对象，实测 8 个模型）；
 * 3. 上游给了名单，但一个都不在 pi-ai 的词表里（未来上游引入新拼写时）。
 *
 * 第 3 种是**故意保守**：把 pi-ai 不认识的档位一律 `null` 掉，而不是原样透传。pi-ai
 * 对 `null` 的理解是「这档不支持」，于是选择器里不会出现一个按下去就 400 的选项。
 *
 * `off` 的条件是**两个与**，缺一不可：
 * - `canDisableThinking === true`（上游明确说能关思考）；
 * - 模型 id 不在 {@link WB_REFUSES_OFF_MODEL_IDS}（实测它会拒 `off`）。
 *
 * 第二个条件在这里再查一遍，而不是只依赖上游数据：`off` 一旦成为必需档位（DSH 会把它
 * 当作「不带 effort 字段」的隐式默认），一个错的 `off` 会让该模型之后每一轮请求都失败。
 * 墙要建在离请求最近的地方。
 */
export function wbThinkingLevelMap(info: WbModelInfo): WbThinkingLevelMap | undefined {
  const supported = info.reasoning?.supportedEfforts?.filter(
    (effort): effort is WbThinkingLevel => (THINKING_LEVELS as readonly string[]).includes(effort),
  )
  if (supported === undefined || supported.length === 0) return undefined
  const map: WbThinkingLevelMap = Object.fromEntries(
    THINKING_LEVELS.map(level => [level, supported.includes(level) ? level : null]),
  )
  map.off = info.reasoning?.canDisableThinking === true && !WB_REFUSES_OFF_MODEL_IDS.has(info.id)
    ? 'off'
    : null
  return map
}

/**
 * 构造一个指向回环 shim 的 pi-ai 模型描述符。
 *
 * `baseUrl` 由调用方每次读取时重新解析，让 shim 的临时端口从启动后的第一份快照起
 * 就生效（shim 用 `listen(0)` 随机端口，不重新解析就会指向上一进程的端口）。
 */
function toPiModel(info: WbModelInfo, baseUrl: string, providerId: string): Model<Api> {
  const contextWindow = Number.isFinite(info.contextWindow) && (info.contextWindow ?? 0) > 0
    ? info.contextWindow as number
    : WB_DEFAULT_CONTEXT_WINDOW
  const maxTokens = Number.isFinite(info.maxTokens) && (info.maxTokens ?? 0) > 0
    ? info.maxTokens as number
    : WB_DEFAULT_MAX_TOKENS
  const thinkingLevelMap = wbThinkingLevelMap(info)
  return {
    id: info.id,
    name: withMultiplierDisplay(info.name, info),
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: modelInput(info),
    cost: NO_COST,
    contextWindow,
    maxTokens,
    // `reasoning` 与 `thinkingLevelMap` 必须同时出现：只置 `reasoning: true` 而不给 map，
    // pi-ai 会为该模型放出整条默认阶梯，等于对每个模型都承诺它可能不支持的档位；
    // 只给 map 而不置 `reasoning: true`，`getSupportedThinkingLevels` 直接短路返回
    // `['off']`，map 根本不被读到。
    reasoning: thinkingLevelMap !== undefined,
    ...thinkingLevelMap === undefined ? {} : { thinkingLevelMap },
    // 上游的 `reasoning_effort` 是**按模型白名单**生效的，不支持的档位会被业务码拒绝。
    // 所以这个开关同样跟着 tier map 走：上游没宣告档位的模型一律声明不支持。
    compat: { supportsReasoningEffort: thinkingLevelMap !== undefined },
  } as unknown as Model<Api>
}

/**
 * pi-ai 唯一会给「没有推理元数据」的模型提供的档位。
 *
 * 宿主对这个档位的翻译是「不带 reasoning 字段」（`profileOptions` 把 `off` 变成
 * `undefined`），所以钉它既没有凭空创造能力，也没有改变请求体里任何一个字节。
 */
const NO_REASONING_EFFORT = ReasoningEffortId('off')

/** 告诉宿主一个没有推理元数据的模型能做什么：恰好就这一档。 */
const NO_REASONING_EFFORTS: LlmModelReasoningInfo = {
  efforts: [{ id: NO_REASONING_EFFORT, name: 'Off' }],
}

/**
 * 把「路由默认档位」归一化成该模型真能接受的一档。
 *
 * **为什么需要这一层。** `profile.reasoning` 是**按路由**的一个默认值，而能力是按
 * **模型**的。`dsh-llm-pi-ai` 把每个请求的档位解析成
 * `options.reasoningEffort ?? profile.reasoning`，然后交给
 * `resolveReasoningLevel` 校验；校验失败抛 `UNSUPPORTED_REASONING_EFFORT`，发生在
 * **请求发出之前**——没有 wire 调用、没有上游错误、没有可重试的东西，模型在本地直接
 * 不可用。名册里两类模型会撞上这个：完全没宣告 `reasoning` 的（`default`、
 * `hunyuan-chat`、以及整个静态兜底名册），和宣告了但档位集合不含默认值的。
 *
 * **两道门都得过。** 宿主先看 adapter 自己的模型元数据：`resolveCallWithInfo` 拒绝在
 * 没有 `reasoning` 字段的模型上接受**任何**显式档位，而 `reasoningInfo` 恰好对这类
 * 模型不产出该字段——连 `off` 都会被拒。然后 `streamWithSnapshot` 再拒掉继承来的路由
 * 默认值。只修任何一道门，另一道仍然失败。
 *
 * **修法。** 对这类模型宣告 pi-ai 唯一会接受的那一档（`off`），并在派发处把请求归一化
 * 到它。请求体因此没有任何变化：pi-ai 对 `reasoning: false` 的模型根本不会发
 * `reasoning_effort`。
 *
 * **什么仍然严格。** 调用方**显式**点名一个该模型做不到的档位，仍然被宿主拒绝，且
 * 错误信息准确。那是既有契约，也不是这里要修的缺陷——缺陷是「没有点名任何档位」的请求
 * 被路由自己的默认值杀掉了。
 */
/**
 * 请求该用哪一档：`undefined` = **原样别动**，否则就是该钉成的那一档。
 *
 * 抽成纯函数是为了能直接测：`pinEffort` 的每个分支都是「某种模型 × 某种请求」的组合，
 * 而它只在真正派发时才跑——通过 `stream()` 间接测等于要造整条 pi-ai 调用链。
 *
 * 三类返回：
 * - `undefined`：调用方要的档位这个模型能用（或目录里根本没这个模型），不插手；
 * - `'off'`：不宣告推理能力的模型，或连最低档都取不到——`off` 在 pi-ai 里等于
 *   **不发 `reasoning_effort`**，所以请求体不变，只是不再被宿主按「档位不合法」拒掉；
 * - 具体档位：路由默认值该模型接不了，降到它接受的上游默认档或最低档。
 *
 * `requested` 用裸 `string` 而不是 `ReasoningEffortId`：调用方（宿主）给的就是字符串，
 * 这一层只做比较，不承担品牌类型的校验职责。
 */
export function wbResolveEffort(info: WbModelInfo, requested: string | undefined): string | undefined {
  const map = wbThinkingLevelMap(info)
  if (map === undefined) return NO_REASONING_EFFORT
  const offered = THINKING_LEVELS.filter(level => typeof map[level] === 'string')
  const usable: readonly string[] = map.off === 'off' ? ['off', ...offered] : offered
  // 调用方没表态时，宿主会用 `profile.reasoning`；这里按同一顺序取，才能预判到它。
  const effective: string = requested ?? WB_DEFAULT_EFFORT
  if (usable.includes(effective)) return undefined
  // 路由默认值该模型接不了：先用上游自己给的默认档，没有就用它能接受的最低档。
  // 取最低档而不是最高：这一档是「用户没表态」时的保守落点，高档更贵也更容易超时。
  const upstreamDefault = info.reasoning?.defaultEffort
  const fallback = upstreamDefault !== undefined && usable.includes(upstreamDefault)
    ? upstreamDefault
    : offered[0]
  return fallback ?? NO_REASONING_EFFORT
}

class WbEffortNormalizingAdapter extends PiAiAdapter {
  /**
   * 按模型 id 查当前目录条目。
   *
   * 每次调用都现查，因为目录会在 adapter 背后被刷新（`invalidate`）：一个中途拿到
   * 推理元数据的模型必须立刻停止被归一化。
   */
  private readonly infoOf: (model: string) => WbModelInfo | undefined

  constructor(config: PiAiAdapterOptions, infoOf: (model: string) => WbModelInfo | undefined) {
    super(config)
    this.infoOf = infoOf
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return this.advertiseOffOnly(await super.resolveModel(provider, model, signal))
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const call = await super.prepareCall(provider, model, signal)
    // 两半都要：宿主在调用 `stream` 之前就先校验 `model` 元数据，而真正走到
    // `resolveReasoningLevel` 的是 `stream`。
    return {
      model: this.advertiseOffOnly(call.model),
      stream: (options: GenerateOptions): AsyncIterable<StreamChunk> => call.stream(this.pinEffort(options)),
    }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return super.stream(this.pinEffort(options))
  }

  /**
   * 给没有推理元数据的模型补上它唯一能派发的那一档。
   *
   * **刻意不补 `defaultEffort`**：宿主会把默认值实体化进**每一个**没点名档位的请求，
   * 那会让宿主自己的 prepared-call 配置校验（`callConfigEquals`）去对付省略该字段的
   * 调用方。
   */
  private advertiseOffOnly(info: LlmResolvedModelInfo): LlmResolvedModelInfo {
    return info.reasoning === undefined ? { ...info, reasoning: NO_REASONING_EFFORTS } : info
  }

  /**
   * 把一个该模型用不了的档位换成它真能接受的一档。
   *
   * 只可能在**路由默认值**上触发：显式档位已被宿主按宣告的档位名单校验过，选不出一个
   * 不支持的（能选出来的必然在名单里）。所以这里的替换不会掩盖任何「用户要了什么」，
   * 只是不让插件自己的默认值把模型打死。
   */
  private pinEffort(options: GenerateOptions): GenerateOptions {
    const info = this.infoOf(options.model)
    // 目录里没有这个模型：不是本层能判断的事，原样交给宿主按「无此模型」报错。
    if (info === undefined) return options
    // 归一化决策全在 `wbResolveEffort` 里：这里只负责把结论落成选项。
    const pinned = wbResolveEffort(info, options.reasoningEffort)
    if (pinned === undefined) return options
    if (pinned === NO_REASONING_EFFORT) {
      // 已是要的档位就原样返回，省掉一次无意义的对象复制（`stream` 会被每轮调用）。
      return options.reasoningEffort === NO_REASONING_EFFORT
        ? options
        : { ...options, reasoningEffort: NO_REASONING_EFFORT }
    }
    return { ...options, reasoningEffort: ReasoningEffortId(pinned) }
  }
}

/**
 * 装配 adapter。
 *
 * `getModels` 每次都重读实时目录并重新解析 `baseUrl`：
 * - 目录会随上游刷新变化（新模型上线、促销模型下线），缓存列表会让用户在选择器里
 *   看不到新模型，直到重启。
 * - 用户改「显示哪些模型」后，`catalog.visible()` 立刻反映新选择——这是 R1-g 的
 *   唯一生效点（过滤在 catalog 层做完，adapter 不重复过滤）。
 *
 * 只在 `shim.ready` 之后调用。
 */
export function createWbAdapter(options: WbAdapterOptions): WbAdapter {
  const { shim, catalog, region } = options
  const providerId = options.providerId ?? WB_PROVIDERS[region]
  const displayName = options.displayName ?? (region === 'global'
    ? 'WorkBuddy 模型池（国际版）'
    : 'WorkBuddy 模型池（国内版）')

  const buildModels = (): Model<Api>[] => {
    const baseUrl = `${shim.baseUrl()}/v1`
    return catalog.visible().map(info => toPiModel(info, baseUrl, providerId))
  }

  const base = createProvider({
    id: providerId,
    name: displayName,
    auth: {
      apiKey: {
        name: 'WorkBuddy 模型池回环密钥',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'WorkBuddy 模型池' }
        },
      },
    },
    models: buildModels(),
    api: openAICompletionsApi(),
  })

  const provider: Provider = { ...base, getModels: () => buildModels() }

  const profile: ResolvedPiAiProviderProfile = {
    provider: providerId,
    displayName,
    streamIdleTimeoutMs: WB_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-connect-workbuddy-models retryPolicy'),
    configuredMaxTokens: new Map(),
    // dsh-llm-pi-ai 要求：宿主 adapter 在每次模型解析时读 profile.modelErrors.get(model)。
    // 目录来自实时上游，没有预知的失败——空 map 表示「没有模型被预先拒绝」。
    // 填进去的条目会让那个模型在**请求发出之前**就失败，所以宁可为空。
    modelErrors: new Map(),
    /**
     * 路由默认档位。
     *
     * `dsh-llm-pi-ai` 把每个请求的档位解析成 `options.reasoningEffort ?? profile.reasoning`。
     * 不设这个字段的后果是「由 pi-ai 自己填」——对档位表里 `off` 可用的模型，它会填
     * `off`，于是**每一次压缩摘要**都在要求 `deepseek-v4.1-flash` 这类模型关闭思考，
     * 而上游会对其中一部分回 400。
     *
     * 取 `high` 而不是 `off`：这是本插件全部实测量据里上半区模型都接受的档位，也是
     * 「正常对话」应得的默认质量。接不住 `high` 的模型（只宣告了 `low`/`medium`，或
     * 完全没宣告）由 `WbEffortNormalizingAdapter.pinEffort` 逐模型降到它接受的那一档
     * ——默认值是按路由写的，能力是按模型量的，两者必须在这一层对齐。
     */
    reasoning: WB_DEFAULT_EFFORT,
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])

  // 目录条目按 id 现查：`pinEffort` 要判断「这个模型到底宣告了什么」，而目录会在
  // 本 adapter 背后被刷新，缓存一份快照会让刚拿到推理元数据的模型继续被当成哑模型。
  const infoOf = (model: string): WbModelInfo | undefined =>
    catalog.visible().find(info => info.id === model)

  const adapter = new WbEffortNormalizingAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    // shim 的进程内 secret 就是 OpenAI apiKey；shim 校验它，并自己在每请求从池里
    // 解析真实的 WorkBuddy token。所以这里永远返回同一个值，而不是上游 access token
    // ——后者会过期，而 adapter 的 apiKey 没有刷新窗口。
    resolveApiKey: async () => shim.token(),
    // 图片输入由宿主持久化附件存储提供。宿主 PiAiAdapter 在缺失该钩子时拒绝任何
    // 携带图片的请求，所以宣告图片输入的路由必须把两个钩子都接上。
    resolveAttachments: () => options.ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) =>
      resolveImageAttachmentAccess(attachments, hostPath => options.ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
  }, infoOf)

  return {
    providerId,
    displayName,
    adapter,
    buildModels,
    invalidate: () => {
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])
    },
  }
}

/**
 * 供 model-resolve 路径用的「这次请求该用哪个账号」的解释。
 *
 * adapter 本身**不做选号**：选号发生在 shim 收到请求时（那时才知道 region、会话键与
 * 当前池状态）。这个函数只把「为什么下一次会切到某个账号」讲清楚，供设置页与
 * 诊断路由显示，避免两处各写一遍选号理由。
 */
export function describeSelection(
  region: WbRegion,
  chosen: { label: string; id: string } | undefined,
  reason: 'preferred' | 'distribution' | 'none',
): string {
  const area = region === 'global' ? '国际版' : '国内版'
  if (chosen === undefined) return `${area}：没有可服务的账号（检查登录与「参与池的账号」）`
  switch (reason) {
    case 'preferred':
      return `${area}：使用你手动选定的账号「${chosen.label}」`
    case 'distribution':
      return `${area}：按账户使用方式选中「${chosen.label}」`
    case 'none':
    default:
      return `${area}：使用「${chosen.label}」`
  }
}
