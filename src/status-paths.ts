/**
 * 宿主半区与浏览器半区共享的 node-free 契约层。
 *
 * 本文件只允许出现「常量 + 纯函数 + 类型」，**不得 import 任何 `@deepseek-ai/*`
 * 包，也不得触碰 `node:*`**：浏览器 bundle 会把它整体打进去，一旦引入宿主侧
 * 依赖，客户端半区就会在加载期抛错，插件表现为「静默不加载」。
 *
 * 出处（均来自本仓库已安装插件的实际源码）：
 * - `plugins/dsh-connect-workbuddy/src/status-paths.ts`（4.15.1）— 路由常量 +
 *   投影类型 + `unwrapVolatileDeep` 的既有形态。
 * - `plugins/dsh-workbuddy-xdpool/src/accounts.ts:555`（dsh-xdpool 2.4.2）—
 *   `AccountDistribution` 五值定义与其语义注释。
 * - `plugins/dsh-connect-workbuddy/src/account-pool.ts:429-520` — 账号排序键顺序。
 *
 * @module dsh-connect-workbuddy-models/status-paths
 */

// 促销条目的类型定义在同级的 `promo.ts` 里。只能用 `import type`：本文件会被打进
// 浏览器 bundle，值导入会把对方的整个模块拖进来；而这里只用到类型，编译后一行不剩。
//
// 拥挤度的六态则**定义在本文件**（见下面的 `WbBusyLevel`）。它原本在 `upstream.ts`
// 里，但 `upstream.ts` 依赖 `node:crypto` 与账号发现，而本文件是浏览器半区也 import
// 的共享契约模块 —— 反过来 import 一次，就等于让浏览器那一侧的 tsc 去编译整个宿主
// 链路。共享的字面量联合必须住在共享模块里。
import type { WbPromo } from './promo.ts'

/**
 * 上游的模型拥挤度六态。
 *
 * `unknown` 是**本插件自有值**，不是上游枚举的一员：缺字段、越界值、以及压根没问
 * （国际网关没有这个端点）都归它。它必须与 `normal` 严格区分 —— 把「没问到」显示成
 * 「正常」等于替上游做了一个它从未做过的声明。
 *
 * 定义放在这里而不是 `upstream.ts`：本文件是浏览器半区与宿主半区共用的契约模块，
 * 而 `upstream.ts` 拖得动 `node:crypto` 与账号发现。宿主侧的 `upstream.ts` 重新导出
 * 本类型，历史 import 路径不受影响。
 */
export type WbBusyLevel = 'idle' | 'normal' | 'busy' | 'congested' | 'unavailable' | 'unknown'

/** 插件 id。与 `package.json` 的 `name`、`cordis.patch.yml` 的 `name` 必须一致。 */
export const PLUGIN_ID = 'dsh-connect-workbuddy-models'

// ── 设置命名空间与座位 ────────────────────────────────────────────────────
//
// 两半区都要用：宿主用它做 settings 双线安装（0.1.5 `installSection` / 0.1.7
// `configure`），浏览器用它拼 locale 命名空间 `settings.wbmodels`。
// 放在共享层而不是各写一份，是因为「两半区对命名空间的看法不一致」会让设置页
// 读到空配置却没有任何报错。

/** 设置命名空间（`installSection` / `configure` 的 ns）。 */
export const WB_MODELS_SETTINGS_NS = 'wbmodels'

/** 浏览器半区的 locale 命名空间。 */
export const WB_MODELS_LOCALE_NS = 'settings.wbmodels'

/**
 * 设置页在左侧导航里的排序位。
 *
 * xdpool 的账号池页占 440、trae-models 占 441（见两插件 `src/client/index.tsx`
 * 的 `order`），本插件排在其后，避免覆盖别人已经占住的位置。
 */
export const WB_MODELS_SETTINGS_ORDER = 442

// ── 路由（DESIGN.md §6）────────────────────────────────────────────────────

/** 本插件所有 web 路由的共同前缀。 */
export const ROUTE_PREFIX = '/plugins/dsh-connect-workbuddy-models'

/** GET：汇总状态（账号 / 积分 / 到期 / 签到 / 模型 / 配置）。 */
export const WB_STATUS_PATH = `${ROUTE_PREFIX}/status`

/** POST：重新扫描本机登录账号。 */
export const WB_ACCOUNTS_REFRESH_PATH = `${ROUTE_PREFIX}/accounts/refresh`

/** GET `?accountId=`：单账号积分明细。 */
export const WB_ACCOUNT_CREDITS_PATH = `${ROUTE_PREFIX}/account/credits`

/** POST `?accountId=`（可省 = 全部）：手动签到。 */
export const WB_CHECKIN_PATH = `${ROUTE_PREFIX}/checkin`

/** POST `?accountId=&kind=`：领取补偿 / 赠礼积分。 */
export const WB_BENEFIT_CLAIM_PATH = `${ROUTE_PREFIX}/benefit/claim`

/** POST：拉取实时模型目录与倍率。 */
export const WB_MODELS_REFRESH_PATH = `${ROUTE_PREFIX}/models/refresh`

/** POST：保存「需要显示的模型」选择。 */
export const WB_MODELS_SAVE_PATH = `${ROUTE_PREFIX}/models/save`

/** POST `?accountId=&region=`：切换当前使用账号。 */
export const WB_ACCOUNTS_SELECT_PATH = `${ROUTE_PREFIX}/accounts/select`

/** GET / POST：自动签到开关与时段。 */
export const WB_AUTOMATION_PATH = `${ROUTE_PREFIX}/automation`

// ── 查询参数名 ────────────────────────────────────────────────────────────
//
// 参数名集中在这里，是因为路由处理函数与浏览器请求方各写一遍时，改名只需改
// 一处；分散写死的字符串在改名后会「请求照发、宿主照答 400」，而且看起来像
// 路由没注册。

/** 选择账号的查询参数名。 */
export const WB_ACCOUNT_ID_PARAM = 'accountId'

/** 选择权益种类的查询参数名。 */
export const WB_KIND_PARAM = 'kind'

/** 选择区域（国内 / 国际）的查询参数名。 */
export const WB_REGION_PARAM = 'region'

// ── 区域与 provider ───────────────────────────────────────────────────────

/** 两个区域：国内版与国际版各是独立的一套 provider 栈。 */
export type WbRegion = 'cn' | 'global'

/** 全部区域，按界面顺序。 */
export const WB_REGIONS: readonly WbRegion[] = ['cn', 'global']

/**
 * 签到只发生在国内版。来源是 t21 的产品裁定：**国际版不提供签到活动**。
 *
 * 这不是一个可以从配置改的开关，而是一条领域事实，所以写成常量而不是设置项。
 * 它存在的原因是「签到」这个概念本身有区域归属：国内版的活动、积分与
 * `codebuddy.cn` 的 billing 端点是同一套；国际版根本没有这套活动，拿它的凭据去
 * 请求国内 billing 端点属于跨域越权请求（即便上游温和地回「活动未开启」，也不该
 * 发）。
 *
 * 用它的人必须理解它是**收口**而不是**默认值**：`scheduler.runCheckin` 在入口就把
 * 入参归一成本常量，因此「不传区域」不再表示「全池」——见那里的注释。
 */
export const CHECKIN_REGION: WbRegion = 'cn'

/**
 * 模型目录（含倍率、促销条目）的自动刷新间隔。
 *
 * 取 5 分钟的**理由**：
 *
 * - 上游 `/v3/config` 里的 `modelPromotions` 是**按天/按小时**起的活动（夜间折扣
 *   23:00 开始、限时免费按绝对窗口结束），最短的变化粒度是「小时」。1 分钟刷新
 *   是纯浪费——一个开着的设置页每分钟都会打一次上游。
 * - 但也不能更长。用户抱怨的正是「促销结束了界面上还在说免费」，而绝对窗口的
 *   边界只会落在整点/整分上；5 分钟意味着最坏情况下用户看到过期徽标 5 分钟。
 * - 与已有的 `credits` 读数（十分钟级）和 `/status` 轮询（秒级）都不同量级，
 *   不会把三个节奏混成一条。
 *
 * **刷新成本不落在回答 `/status` 的那个请求上**：过期只触发一次后台
 * fire-and-forget 刷新，本次应答一律用现有快照 + 上报 `modelsFetchedAtMs`，让
 * 界面自己说清「这份数据多久前抓的」。见 `web-status.ts` 的 `buildStatus`。
 */
export const WB_CATALOG_TTL_MS = 5 * 60_000

/**
 * 拥挤度（`/v2/chat/busy`）的自动刷新间隔。
 *
 * 与 {@link WB_CATALOG_TTL_MS} **故意分开**，因为这是两条独立的上游链路：
 *
 * - 拥挤度是**分钟级**的事实（上游按当前排队情况随时变），且它来自一个专门的
 *   轻量端点，代价远低于读整份 `/v3/config`。1 分钟足以让用户看到「现在堵了」。
 * - 目录是**小时级**的事实，读的是一份大文档。
 *
 * 合成一条 TTL 会逼出两种坏结果之一：要么为了拥挤度把大文档每分钟读一遍，要么
 * 为了省流量让拥挤度 5 分钟才更新一次（那时它已经没意义了）。
 *
 * 失败必须静默降级：拥挤度是**附加信息**，它挂了不能让目录也被标记成失败。
 */
export const WB_BUSY_TTL_MS = 60_000

/**
 * 每个区域注册的 provider id。
 *
 * **必须是 `workbuddy-models`，不能是 `workbuddy`**：`dsh-connect-workbuddy`
 * （4.15.1）已经占住了 `workbuddy` / `workbuddy-global`
 * （见 `plugins/dsh-connect-workbuddy/src/adapter.ts:46,49`）。同一个 provider id
 * 注册两次，cordis 会抛 `service "llm" 的 provider 已注册` 类错误，后加载的那份
 * 插件整份注册失败——而用户看到的是「模型列表少了一半」，不是冲突提示。
 */
export const WB_PROVIDERS: Readonly<Record<WbRegion, string>> = {
  cn: 'workbuddy-models',
  global: 'workbuddy-models-global',
}

/**
 * provider id → 区域。浏览器半区靠它把宿主 `modelSelection` 投影里的 provider
 * 翻译成「该读哪个区域的读数」。
 */
export const WB_PROVIDER_REGIONS: Readonly<Record<string, WbRegion>> = {
  [WB_PROVIDERS.cn]: 'cn',
  [WB_PROVIDERS.global]: 'global',
}

/** 从 provider id 反查区域；不是本插件的 provider 时返回 undefined。 */
export function wbRegionOfProvider(provider: string | undefined): WbRegion | undefined {
  if (provider === undefined) return undefined
  return Object.prototype.hasOwnProperty.call(WB_PROVIDER_REGIONS, provider)
    ? WB_PROVIDER_REGIONS[provider]
    : undefined
}

/** 区域 → provider id；未知区域回落到国内版。 */
export function wbProviderOf(region: WbRegion | undefined): string {
  return region === 'global' ? WB_PROVIDERS.global : WB_PROVIDERS.cn
}

/** 窄化一个字符串是否为合法区域。 */
export function isWbRegion(value: unknown): value is WbRegion {
  return value === 'cn' || value === 'global'
}

// ── 账户使用方式 ──────────────────────────────────────────────────────────

/**
 * 账号使用方式（DESIGN.md §5，定义照抄
 * `plugins/dsh-workbuddy-xdpool/src/accounts.ts:555`）。
 *
 * - `priority`（默认）：一直打同一个号，直到被限流或积分耗尽才换下一个。
 * - `round-robin`：连续请求依次轮过池子，花费均摊。
 * - `balanced`：按权重抽取，冷清时也不会把第一个号抽干。
 * - `sticky`：一个会话钉一个号，新会话换下一个号，保住上游 prompt 缓存。
 * - `expiry`：**一次性积分包最先到期的账号先服务**，无到期信息的排最后
 *   （这正是 R3「选模型时优先切到积分最先过期的用户」的实现口径）。
 */
export type AccountDistribution = 'priority' | 'round-robin' | 'balanced' | 'sticky' | 'expiry'

/** 全部使用方式，按界面顺序。 */
export const ACCOUNT_DISTRIBUTIONS: readonly AccountDistribution[] = [
  'priority',
  'round-robin',
  'balanced',
  'sticky',
  'expiry',
]

/**
 * 默认使用方式：`expiry` —— 优先把「最先会作废」的积分花掉。
 *
 * 为什么不是 `priority`（「用完一个再换」，看着更省事）：
 *
 * `priority` 分支的第一键是 `atRisk`，而 `atRisk` 的判据是
 * `credits.expiringSoon > 0` —— 一个**由用户 `expiryWarnDays`（默认 3 天）现算的
 * 窗口**（见 `probe.ts` 的 `aggregateCredits`）。默认配置下，10 天后才到期的积分
 * 根本不算 `atRisk`，排序就退回 `_order` / `score`，也就是「谁分多谁先」。那让需求
 * R3（优先切到积分最先过期的账号）只在 3 天窗口内碰巧成立，窗口外变成一条与过期
 * 无关的规则 —— 用户看到的是「积分多的号被优先抽干」，正是 R3 要避免的。
 *
 * `expiry` 分支不依赖 `atRisk`：它按 `nearestExpiryMs` 升序，且有到期信息的账号无
 * 条件排在没有的前面（见 `rankAccounts`）。所以「10 天后到期」与「30 天后到期」在
 * 默认 3 天窗口下依然分得出先后 —— R3 在全时段成立，不只临期时成立。用户的
 * `expiryWarnDays` 仍然决定**提醒**的窗口（`expiringSoon`），只是不再决定**排序**。
 *
 * 已知取舍：纯月包账号（无 `nearestExpiryMs`）会沉到有到期信息的账号之后。这是刻
 * 意的 —— 月包会刷新，不存在「快要流失」的额度。界面用 `rankReasonsOf` 的 `reason`
 * 解释这一点，不让它变成一个谜。
 */
export const DEFAULT_ACCOUNT_DISTRIBUTION: AccountDistribution = 'expiry'

/** 窄化一个字符串是否为合法使用方式；非法值回落到默认（不抛错）。 */
export function distributionOf(value: unknown): AccountDistribution {
  return typeof value === 'string' && (ACCOUNT_DISTRIBUTIONS as readonly string[]).includes(value)
    ? value as AccountDistribution
    : DEFAULT_ACCOUNT_DISTRIBUTION
}

// ── 上游投影类型 ──────────────────────────────────────────────────────────

/**
 * 一个积分包（DESIGN.md §4，来源 `plugins/dsh-connect-workbuddy/src/upstream.ts:165-260`）。
 *
 * 注意：`remain` 必须来自上游 `CycleCapacityRemainPrecise` 家族。`CapacityRemain`
 * 是 pool 家族，整月额度花完时仍报满额（高报，issue #58 定论）。
 */
export interface WbCreditPackage {
  packageName: string
  /** 剩余额度。 */
  remain: number
  /** 包的总量。 */
  size: number
  /** `CapacityType 4`：按周期刷新、永不过期。 */
  monthly: boolean
  /** 下次周期刷新时刻（ms）；仅周期包有。 */
  refreshAtMs?: number
  /** 一次性包的到期时刻（ms）；到期后包从账号上消失。 */
  expiresAtMs?: number
}

/** 一个账号的积分聚合（DESIGN.md §4）。 */
export interface WbCredits {
  total: number
  packages: readonly WbCreditPackage[]
  /** 临期窗口内会过期的额度；`0` 表示没有东西在流失。 */
  expiringSoon: number
  /** 最近一个包的到期时刻（ms）；无到期信息时缺省。**不是** `0`。 */
  nearestExpiryMs?: number
}

/** 签到状态（DESIGN.md §4）。 */
export interface WbCheckinStatus {
  active: boolean
  todayCheckedIn: boolean
  streakDays: number
  dailyCredit: number
  todayCredit: number
  isStreakDay: boolean
  nextStreakDay: number
  streakBonusDays: number
  streakBonusCredit: number
  /** 上游给的按钮文案；缺省时界面用本地文案。 */
  claimButtonText?: string
}

/**
 * 一个可显示 / 可选择的模型（DESIGN.md §4）。
 *
 * `creditMultiplier` **`undefined ≠ 0`**：CN 的 fallback 目录整份没有该字段，
 * 把 `undefined` 当 `0` 会把收费模型显示成免费（见 `parseCreditMultiplier`,
 * `plugins/dsh-connect-workbuddy/src/upstream.ts:1878`）。所以它只能是
 * `number | undefined`，绝不能给默认值 0。
 */
export interface WbModelInfo {
  id: string
  name: string
  /** 积分倍率：`0` 是免费，`undefined` 是未知。两者含义相反。 */
  creditMultiplier?: number
  contextWindow?: number
  maxTokens?: number
  supportsImages?: boolean
  multimodal?: boolean
  description?: string
  /**
   * 点名了这个模型的促销/档位条目（**未解析**，按 priority 降序）。
   *
   * 为什么是「一组未解析条目」而不是「选好的一个」：徽标要对着时钟选，选的结果只在
   * 渲染那一刻成立。在这里解析等于把答案冻在取数时刻 —— 那正是「夜间折扣」到了白天
   * 还自称夜间的那个缺陷。选择逻辑在 `promo.ts` 的 `selectPromoBadge`。
   *
   * `undefined`（没这条键）与 `[]`（有点名但都被解析丢了）在界面上等价：都没有徽标。
   */
  promos?: readonly WbPromo[]
  /**
   * 模型此刻的拥挤度。
   *
   * `undefined` 是「没问过」，`'unknown'` 是「问过但上游答了个不认识的值」。两者的
   * 差别只在诊断，界面上都不画 —— 画一个「未知拥堵」只会让用户以为出了事。
   */
  busyLevel?: WbBusyLevel
  /**
   * 上游宣告的推理档位元数据。
   *
   * **`undefined` 是「上游没说过」，不是「不支持」**——与 `creditMultiplier` 同一套
   * 三态约定。两种拼写（复数 `supportedEfforts` / 单数 `effort`）在
   * `upstream.ts` 的 `parseReasoning` 里已经归一，到这里只剩一种形状。
   *
   * 这一层**必须住在本文件**：`adapter.ts`（宿主半区）要用它构造 pi-ai 的
   * `thinkingLevelMap`，而本文件同时被浏览器 bundle 整体打包。推理能力的声明是
   * 「模型卡片要显示什么」与「发请求时能发哪一档」的共同来源，两半区不能各存一份。
   */
  reasoning?: WbReasoning
}

/**
 * 上游宣告的推理档位元数据（两种拼写已归一）。
 *
 * 三个字段全部可选，且**都不补默认值**：上游哪个字段没给，就是「不知道」。
 */
export interface WbReasoning {
  /**
   * 该模型接受的档位名单（上游原样宣告，未经本插件的已知档位过滤）。
   *
   * 保留原始值而不是在这里裁剪：`adapter.ts` 要按 pi-ai 的档位词表过滤，而
   * 卡片要显示上游到底说了什么。两个消费者需要的东西不同，解析层只做搬运。
   */
  supportedEfforts?: readonly string[]
  /** 上游给这一档起的默认值。 */
  defaultEffort?: string
  /**
   * 能否关闭思考（`false` = 必须思考）。
   *
   * `undefined` 同样是「没说过」，此时不提供 `off` 档——这与本插件处理其余
   * 未宣告能力的方式一致。
   */
  canDisableThinking?: boolean
}

/**
 * 实测**拒绝** `reasoning_effort: "off"` 的模型 id（上游 issue #34 / #83）。
 *
 * 上游名册把这些模型的 `reasoning.canDisableThinking` 声明为 `true`，但它们对
 * `reasoning_effort: "off"` 回 HTTP 400 / 业务码 11133，而**其余每一档**
 * （minimal/low/medium/high/xhigh/max）以及完全不带该字段都能过。也就是说 `off`
 * 是唯一会失败的一档，而声明的能力字段分不开这两组——所以只能靠一张按精确 id
 * 取的表。
 *
 * 表刻意不按区域：`deepseek-v4.1-flash` 在两个网关都拒，分界线跟模型家族走。
 *
 * **代价不对称**：提供一个必然失败的档位，代价是该模型之后**每一轮**请求都失败
 * （档位是保存下来的每模型选择，会一直重放）；而多藏一个本来能用的档位，代价只是
 * 少一个选项。所以这张表一律朝「藏」的方向取整。
 *
 * 住在共享契约层是因为有**两个**消费者：`adapter.ts` 用它把 `off` 映射成 `null`
 * （让 pi-ai 的 `getSupportedThinkingLevels` 直接不提供该档），`shim.ts` 用它删掉
 * 已经混进请求体的 `reasoning_effort: "off"`。同一份实测数据只能有一处。
 */
export const WB_REFUSES_OFF_MODEL_IDS: ReadonlySet<string> = new Set([
  'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-sg',
  'deepseek-v4-pro',
  'primary-model',
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gemini-3.5-flash',
])

/** 账号被发现时的来源。 */
export type WbAccountSource = 'desktop' | 'dsh'

/**
 * 一个可选账号（token-free 投影，凭据永远留在宿主）。
 */
export interface WbAccount {
  id: string
  /** 账号的人话名字；桌面端没记时是 `''`，由界面补占位符。 */
  accountName: string
  /** 上游域名，用于判定区域。 */
  domain: string
  region: WbRegion
  source: WbAccountSource
  /** 凭据到期时刻（ms）。 */
  tokenExpiresAtMs: number
  /** 解析出的凭据文件路径（只读诊断用，不含令牌内容）。 */
  sourcePath: string
  /** 是否是当前区域正在使用的账号。 */
  selected: boolean
}

/**
 * 一个被跳过的凭据文件。
 *
 * 必须暴露：否则「2 个账号」与「4 个文件里 2 个读不了」在界面上看起来一模一样。
 * `encrypted` 是 WorkBuddy 特有的——Windows 构建会加密令牌字段，此时让用户
 * 「重新登录」是错的（他本来就登着）。
 */
export interface WbSkippedFile {
  path: string
  reason: 'encrypted' | 'unreadable' | 'malformed'
}

/** 可领取的权益种类。 */
export type WbBenefitKind = 'compensation' | 'gift'

/** 全部权益种类。 */
export const WB_BENEFIT_KINDS: readonly WbBenefitKind[] = ['compensation', 'gift']

/** 窄化一个字符串是否为合法权益种类。 */
export function benefitKindOf(value: unknown): WbBenefitKind | undefined {
  return value === 'compensation' || value === 'gift' ? value : undefined
}

/** 单个账号在状态文档里的读数。 */
export interface WbAccountReading {
  account: WbAccount
  /** 读不到余额时缺省——**不是** `0`。`0` 是对账号下的断言。 */
  credits?: WbCredits
  checkin?: WbCheckinStatus
  /** 该账号此刻为什么不能服务；能服务时缺省。 */
  excludedBy?: string
}

/**
 * 一个账号在本区域名次表里的位置与理由。
 *
 * 字段与 `web-status.ts` 的 `rankReasonsOf()` 返回值逐字一致——那份实现是这条
 * 解释链路的唯一来源，在这里另起一套字段名会让「谁排第一」与「为什么排第一」
 * 变成两份可能互相矛盾的投影。
 *
 * `usable: false` 时 `reason` 必非空（池上现成的 `exclusionReason`：未加入池 /
 * 登录窗口已关闭 / 上游已拒绝凭据），三种都直接指向用户该做什么。
 */
export interface WbAccountPickReason {
  accountId: string
  /** 名次，1 起。1 名就是下一个请求会发去的那个账号。 */
  rank: number
  score: number
  /** 是否有积分落在用户设置的临期窗口里。 */
  atRisk: boolean
  /** 临期窗口内会流失的额度；`0` 表示没有临期积分。 */
  expiringAmount: number
  /** 一次性积分包中最近的未来到期；纯月包账号缺省（**不是** 0）。 */
  nearestExpiryMs?: number
  usable: boolean
  /** 不可服务时的可行动理由；能服务时缺省。 */
  reason?: string
}

/** `/status` 的应答（浏览器半区与宿主半区共同的投影）。 */
export interface WbStatusSnapshot {
  /** 扫描到的时间戳（ms）。 */
  scannedAtMs: number
  region: WbRegion
  accounts: readonly WbAccountReading[]
  /** 被跳过的凭据文件，必须原样上报。 */
  skipped: readonly WbSkippedFile[]
  models: readonly WbModelInfo[]
  /** 池子里的剩余总积分（所有参与账号之和）。 */
  totalCredits: number
  /** 配置回显，供设置页首帧就画出用户的选择。 */
  config?: WbModelsConfig
  /**
   * 本区域的名次表与每位名次的理由。
   *
   * **可选**是刻意的：它是解释性字段，缺了只损失一句说明，不该让「拿到快照」
   * 这件事本身失败。所有手写快照（测试夹具、宿主首帧预置）都不必为它补值。
   */
  picks?: readonly WbAccountPickReason[]
  /**
   * 本区域每个模型的拥挤度，按模型 id 索引。
   *
   * 与 `models[].busyLevel` 同源（都来自同一个 `fetchModelBusy` 结果），之所以在顶层
   * 再给一份，是因为模型选择器的标签槽只拿到 `model.id`、拿不到 `/status` 的
   * `models[]` 元素；没有这份表它就只能为此再打一次请求。
   *
   * **两处必须一致。** 不一致说明有人只更新了一条通路，那是缺陷不是风格。
   */
  busyLevels?: Readonly<Record<string, WbBusyLevel>>
  /**
   * 本区域目录（含倍率、促销条目）**最近一次成功抓取**的时刻（ms）。
   *
   * 给界面用来说清「你看到的这些徽标有多新」。没有它就分不清两种完全不同的
   * 情形：上游确实没有促销（该显示「无」），还是这份快照是两小时前抓的、促销
   * 早就结束了（该显示「数据已过期」）。用户抱怨的「促销结束了还在说免费」
   * 正是后者。
   *
   * 从未成功抓取过时为 `undefined`——此时 `models` 是静态兜底名册。
   */
  modelsFetchedAtMs?: number
  /**
   * 本区域目录距上次成功抓取的毫秒数；从未抓取过时为 `undefined`。
   *
   * 与 {@link modelsFetchedAtMs} 同时给出是刻意的：界面拿到绝对时刻还要自己
   * 算差值，而算差值必须用**客户端**的时钟，客户端的时钟与服务端不一定一致。
   * 服务端算好一并给出，界面就不必为此做时钟假设。
   */
  modelsAgeMs?: number
  /**
   * 本区域拥挤度**最近一次成功抓取**的时刻（ms），与 {@link modelsFetchedAtMs}
   * 分开，因为这是两条独立的上游链路（`/v2/chat/busy` 与 `/v3/config`）。
   *
   * 拥挤度是分钟级事实，过期没刷新时界面应当把它降级成「未知」而不是继续显示
   * 一个已经不成立的「空闲」。
   */
  busyFetchedAtMs?: number
}

/** 自动签到配置（DESIGN.md §7-§8）。 */
export interface WbAutomationConfig {
  enabled: boolean
  /** 北京时间整点，默认 `[9]`。 */
  checkinHours: readonly number[]
  /** 是否顺带领取可领的补偿 / 赠礼。 */
  claimBenefits: boolean
}

/** 插件配置（DESIGN.md §7）。 */
export interface WbModelsConfig {
  /** 是否启用本 provider。 */
  enabled: boolean
  /** 账户使用方式（R4：必须真正生效）。 */
  distribution: AccountDistribution
  /** 需要显示的模型；**空数组 = 全部显示**（DESIGN.md §7）。 */
  enabledModelIds: readonly string[]
  /** 国际版的同一份选择。 */
  enabledModelIdsGlobal: readonly string[]
  /** 参与池的账号 id。 */
  accountsEnabled: readonly string[]
  /** 用户手动排序的账号 id。 */
  orderAccountIds: readonly string[]
  /** 输入框下方读数开关。 */
  showCreditsInComposer: boolean
  /** 临期提醒阈值（天）。 */
  expiryWarnDays: number
  automation: WbAutomationConfig
  /** 当前使用账号，按区域。 */
  accounts: { cn?: string; global?: string }
}

// ── volatile 剥离 ─────────────────────────────────────────────────────────

/**
 * 剥掉一层 `{ get(): T }` 活引用。
 *
 * schemastery 的 `volatile()` 字段解析出来是**活引用**（`{ get(): T }`），而不是
 * 值本身。它 `typeof === 'object'`，所以任何「看起来像对象就当对象用」的判断都会
 * 把它当值放行，后续每次属性读取都拿到 `undefined`。
 *
 * 出处：`plugins/dsh-connect-workbuddy/src/index.ts:564-569`，
 * 浏览器侧同一规则见 `plugins/dsh-connect-workbuddy/src/client/ComposerCreditsGate.tsx`
 * 的 `scopeValueOf`（`unwrapVolatileDeep(scope.getSnapshot().value)`）。
 *
 * 不剥离的后果（README 与本仓库既有记录里都出现过）：
 * - 把配置交给 settings 服务时，服务会 `structuredClone` 整份对象做校验，活引用
 *   过不去，报 `$.xxx expected string but got [object Object]`——**命名空间注册不上**；
 * - 于是设置页的卡片**静默消失**：没有异常，没有横幅，只是那片 UI 不再出现。
 */
export function unwrapVolatile<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  const getter = (value as { get?: unknown }).get
  return typeof getter === 'function' ? (getter as () => T).call(value) : value
}

/**
 * 深剥：递归把每个 `{ get(): T }` 替换成它解析出的值。
 *
 * {@link unwrapVolatile} 只剥调用者「这一层」读到的那个字段，普通读路径够用；
 * 但把**整份配置**交给 settings 服务（以及浏览器侧把解析后的字段展开以保留兄弟
 * 字段）时，任何一个残留的活引用都会让 `structuredClone` 失败 / 让 `{ ...ref }`
 * 展开成 `{ get: <function> }` 而丢掉所有兄弟字段。
 *
 * 出处：`plugins/dsh-connect-workbuddy/src/status-paths.ts:1233-1245`（同一实现）与
 * `plugins/dsh-connect-trae-models/src/index.ts:58-82`。
 *
 * 数组与对象都**重建**而不是原地修改，调用方的值不会被改动。
 */
export function unwrapVolatileDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  const peeled = unwrapVolatile(value)
  // 活引用剥出来的值可能还是对象，必须继续往下走。
  if (peeled !== value) return unwrapVolatileDeep(peeled)
  if (Array.isArray(peeled)) return peeled.map(entry => unwrapVolatileDeep(entry)) as T
  const source = peeled as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source)) out[key] = unwrapVolatileDeep(source[key])
  return out as T
}

// ── 路由 URL 拼装与解析 ───────────────────────────────────────────────────

/**
 * 拼一个带 `accountId` 的 URL。
 *
 * `accountId` 缺省时**不加参数**（而不是加一个空串）：空串会被路由读成「显式
 * 指定了一个不存在的账号」，与「不指定」是两种语义。
 */
export function withAccountId(path: string, accountId?: string): string {
  if (accountId === undefined || accountId === '') return path
  return `${path}?${WB_ACCOUNT_ID_PARAM}=${encodeURIComponent(accountId)}`
}

/** 拼一个带 `region` 的 URL。 */
export function withRegion(path: string, region: WbRegion): string {
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}${WB_REGION_PARAM}=${region}`
}

/** 拼一个带 `accountId` + `region` 的 URL。 */
export function withAccountAndRegion(path: string, accountId: string, region: WbRegion): string {
  return withRegion(withAccountId(path, accountId), region)
}

/** 拼一个带 `accountId` + `kind` 的 URL。 */
export function withBenefitClaim(path: string, accountId: string, kind: WbBenefitKind): string {
  return `${withAccountId(path, accountId)}&${WB_KIND_PARAM}=${kind}`
}

/**
 * 拼一个**显式带空 `accountId`** 的 URL：`?accountId=&region=cn`。
 *
 * `withAccountId` / `withAccountAndRegion` 都会在 `accountId === ''` 时直接把参数
 * 丢掉（它们服务的是「不筛这个维度」的只读路由），得到的是 `?region=cn` —— 后端
 * 无法把它与「参数没传」区分开，只能回 400。清除手动选号必须让空串真的出现在
 * query 里，所以这个 URL 只能单独拼。
 *
 * 名字里带 `Clear` 而不是给 `withAccountAndRegion` 加分支：那个函数的所有调用点
 * 都是「切到某个账号」的语义，让同一个函数既能表达「切到 A」又能表达「取消切换」，
 * 读代码的人必须回去看 `accountId` 是不是空串才知道走哪条路。
 */
export function withAccountCleared(path: string, region: WbRegion): string {
  return `${path}?${WB_ACCOUNT_ID_PARAM}=&${WB_REGION_PARAM}=${region}`
}

/**
 * 从 URL 里取一个查询参数。空串按「未提供」处理（浏览器表单与手写链接都会
 * 产生 `?accountId=`），这样调用方只需判 undefined。
 */
export function queryParamOf(url: string, name: string): string | undefined {
  const at = url.indexOf('?')
  if (at === -1) return undefined
  const value = new URLSearchParams(url.slice(at + 1)).get(name)
  return value === null || value === '' ? undefined : value
}

/**
 * 从 URL 里取一个查询参数，**保留空串**。
 *
 * 与 {@link queryParamOf} 的唯一差别就是 `?key=` 的返回值：这里给 `''`，那里给
 * `undefined`。两个口径都必要，不能合并：
 *
 * - `queryParamOf` 的「空串按未提供处理」对**只读**路由是对的（浏览器表单与手写
 *   链接都会产生 `?accountId=`，把它当成「没筛这个维度」最省事）。
 * - 但 `/accounts/select` 里空串本身就是一条指令：「交还给账户使用方式」。用
 *   `queryParamOf` 取参会把它归一化成 `undefined`，于是那句「传空字符串表示交还
 *   给账户使用方式」的错误文案必然命中、HTTP 面**在结构上无法表达清除**——
 *   用户一旦手动选过号，五种账户使用方式就永久失效，且没有任何撤销手段。
 *
 * 所以这里刻意不共用 `queryParamOf`，而是在它旁边放一个只给写路由用的入口。
 */
export function rawQueryParamOf(url: string, name: string): string | undefined {
  const at = url.indexOf('?')
  if (at === -1) return undefined
  const value = new URLSearchParams(url.slice(at + 1)).get(name)
  return value === null ? undefined : value
}

/** 从 URL 里取 `accountId`。 */
export function accountIdOf(url: string): string | undefined {
  return queryParamOf(url, WB_ACCOUNT_ID_PARAM)
}

/**
 * 从 URL 里取 `region`。
 *
 * 缺省 / 空串 = 国内版（`cn`）；**存在但不认识的值返回 `undefined`**，让路由
 * 回 400 而不是猜一个区域——猜错会让国际版账号被当国内版号去计费。
 */
export function regionParamOf(url: string): WbRegion | undefined {
  const at = url.indexOf('?')
  const raw = at === -1 ? null : new URLSearchParams(url.slice(at + 1)).get(WB_REGION_PARAM)
  if (raw === null || raw === '') return 'cn'
  return isWbRegion(raw) ? raw : undefined
}

/** 从 URL 里取 `kind`；不认识/缺省时 undefined。 */
export function claimKindOf(url: string): WbBenefitKind | undefined {
  return benefitKindOf(queryParamOf(url, WB_KIND_PARAM))
}

// ── 账号排序（DESIGN.md §5）────────────────────────────────────────────────

/** 一天的毫秒数。 */
export const DAY_MS = 86_400_000

/**
 * 临期窗口默认值（天）。
 *
 * 这是**兜底**，不是口径来源。临期窗口的用户真值只有一个：配置里的
 * `expiryWarnDays`。它经由两条路进入排序层，任一到达都不该用到本常量：
 *
 * 1. 探测层（`probe.ts` 的 `aggregateCredits`）按用户窗口算出 `credits.expiringSoon`
 *    写进读数，`expiryFactsOf` 遇到显式值直接采信；
 * 2. 调用方把用户窗口作为 `rankAccounts` 的第 5 个实参 `warnDays` 传进来。
 *
 * 只有两者都缺省（老调用点、纯单元测试、池里从未探测过）才会落回本常量。把它当
 * 口径用会让用户的设置对「谁排第一」完全无效——那正是 F2 的缺陷形态。
 */
export const DEFAULT_EXPIRY_WARN_DAYS = 3

/** 临期提醒阈值的合法下界（天）。 */
export const EXPIRY_WARN_DAYS_MIN = 1

/** 临期提醒阈值的合法上界（天）。 */
export const EXPIRY_WARN_DAYS_MAX = 90

/** 参与排序的账号最少需要这些字段。 */
export interface WbRankAccountRef {
  id: string
  /** 凭据到期时刻，用于最后的平局判定。 */
  tokenExpiresAtMs?: number
}

/** 一个待排序的池成员。 */
export interface WbRankMember<TAccount extends WbRankAccountRef = WbRankAccountRef> {
  account: TAccount
  /** 该账号的积分读数；读不到时缺省。 */
  credits?: WbCredits
  /** 此刻是否可服务；缺省视为可服务。 */
  usable?: boolean
  /** 排序分数，缺省为 `credits.total`。 */
  score?: number
}

/** 排序结果的一行。 */
export interface WbRankedAccount<TAccount extends WbRankAccountRef = WbRankAccountRef> {
  account: TAccount
  score: number
  /** 是否有额度正在流失（临期窗口内会过期）。 */
  atRisk: boolean
  /** 流失中的额度数量。 */
  expiringAmount: number
  /** 最近到期时刻（ms）；无到期信息时缺省。 */
  nearestExpiryMs?: number
}

/** 一个成员的到期事实：最近到期时刻 + 窗口内会流失的额度。 */
interface WbExpiryFacts {
  nearestExpiryMs?: number
  expiringAmount: number
}

/**
 * 汇总一个成员的到期事实。
 *
 * 两条口径都写在这里，避免排序键各处各算一遍：
 * 1. **显式优先**：`credits.nearestExpiryMs` / `credits.expiringSoon` 来自探测层，
 *    已经按用户的 `expiryWarnDays` 聚合过，直接采信。
 * 2. **兜底推算**：只有缺省时才从 `packages` 里推——周期包（`monthly`）会刷新、
 *    永不过期，不参与；已经过期（`expiresAtMs <= nowMs`）的包也不算「临期」，
 *    它已经消失了，把它当 atRisk 会让一个用光的账号永远排第一。
 *
 * 第 2 条用哪个窗口由 `warnDays` 决定。它**必须**来自用户配置（`rankAccounts` 的
 * 第 5 个实参），否则「用户把提醒改成 30 天」在排序上完全不可观测：实测传入
 * `DEFAULT_EXPIRY_WARN_DAYS` 时，一个 10 天后到期的包无论在 3 天还是 30 天窗口下
 * 都不会被算进 `expiringAmount`，两种设置的排序结果逐字节相同。
 */
function expiryFactsOf(
  credits: WbCredits | undefined,
  nowMs: number,
  warnDays: number,
): WbExpiryFacts {
  if (credits === undefined) return { expiringAmount: 0 }
  const windowEndMs = nowMs + Math.max(0, warnDays) * DAY_MS
  let computedAt: number | undefined
  let computedAmount = 0
  for (const pack of credits.packages ?? []) {
    if (pack.monthly) continue
    const at = pack.expiresAtMs
    if (at === undefined || !Number.isFinite(at) || at <= nowMs) continue
    if (computedAt === undefined || at < computedAt) computedAt = at
    if (at <= windowEndMs) computedAmount += pack.remain
  }
  const explicitAt = credits.nearestExpiryMs
  const explicitValid = explicitAt !== undefined && Number.isFinite(explicitAt) && explicitAt > nowMs
  const nearestExpiryMs = explicitValid ? explicitAt : computedAt
  const explicitAmount = credits.expiringSoon
  const expiringAmount = Number.isFinite(explicitAmount) && explicitAmount > 0
    ? explicitAmount
    : computedAmount
  return { expiringAmount, ...nearestExpiryMs === undefined ? {} : { nearestExpiryMs } }
}

/**
 * 把一个池成员列表排成「下一个该由谁服务」的顺序。
 *
 * 纯函数：同样的输入永远给同样的顺序，缺数据不抛错（没有积分按 0 排，不崩）。
 *
 * 键顺序照 `plugins/dsh-connect-workbuddy/src/account-pool.ts:440-520`：
 *
 * ```
 * _usable            可服务的排前面（不可服务的仍然返回，只是排在后面）
 * _atRisk            有额度正在流失的排前面            ← R3 的基础
 * _order             用户手动序（未列出的排最后）
 * _expiring          都 atRisk 时，最先到期的排前面
 * _expiringAmount    流失额度大的排前面
 * score              积分多的排前面
 * _tokenExpiresAtMs  凭据更晚到期的排前面
 * id                 保证顺序是「全序」，同样的输入不会两次排出不同结果
 * ```
 *
 * `distribution` 只影响**这次排序**的一个键：
 * - `expiry`：把「有到期信息」提到 `_atRisk` 之前，于是「一次性积分包最先到期的
 *   账号」必定排第一，无到期信息的排最后，从未探测过的池退化成 `priority`。
 * - 其余四种（`priority` / `round-robin` / `balanced` / `sticky`）**用同一份顺序**：
 *   它们的差别在于「怎么消费这份有序列表」（依次打同一个 / 走游标轮换 / 按权重抽 /
 *   按会话绑定），而不是「谁是下一个」。把它们塞进比较器会让同一份顺序对四种模式
 *   给出四种互不相同的解释，而其中三种是错的。
 *
 * @param members 池成员
 * @param nowMs 当前时刻（ms），用于判定临期窗口
 * @param orderIds 用户手动排序的账号 id（`orderIds[0]` 排最前）
 * @param distribution 账户使用方式
 * @param warnDays 临期窗口（天），取自用户的 `expiryWarnDays`
 */
export function rankAccounts<TAccount extends WbRankAccountRef>(
  members: readonly WbRankMember<TAccount>[],
  nowMs: number,
  orderIds: readonly string[] = [],
  distribution: AccountDistribution = DEFAULT_ACCOUNT_DISTRIBUTION,
  warnDays: number = DEFAULT_EXPIRY_WARN_DAYS,
): readonly WbRankedAccount<TAccount>[] {
  // 手动序做成位置表：未列出的账号统一映射到「排最后」。重复 id 保留第一次出现
  // 的位置——手写清单里常有重复项，用户本意是那个先出现的。
  const order = new Map<string, number>()
  for (const [index, id] of orderIds.entries()) {
    if (!order.has(id)) order.set(id, index)
  }

  // 夹到合法范围后再用：`warnDays` 最终来自手改的配置文件，`0` 或 `99999` 会分别
  // 让窗口空掉 / 把所有包都算成临期。夹紧与 `probe.ts` 的 `clampWarnDays` 同一口径，
  // 这样即使调用方绕过探测层直接传原始值，两条路也不会给出相反的 atRisk。
  const effectiveWarnDays = Number.isFinite(warnDays)
    ? Math.min(EXPIRY_WARN_DAYS_MAX, Math.max(EXPIRY_WARN_DAYS_MIN, Math.round(warnDays)))
    : DEFAULT_EXPIRY_WARN_DAYS

  const rows = members.map(member => {
    const facts = expiryFactsOf(member.credits, nowMs, effectiveWarnDays)
    const score = member.score ?? member.credits?.total ?? 0
    return {
      account: member.account,
      score,
      atRisk: facts.expiringAmount > 0,
      expiringAmount: facts.expiringAmount,
      ...facts.nearestExpiryMs === undefined ? {} : { nearestExpiryMs: facts.nearestExpiryMs },
      // 以下键仅在排序内部使用，不出现在返回值里。
      _usable: member.usable !== false,
      _order: order.get(member.account.id) ?? Number.POSITIVE_INFINITY,
      _expiring: facts.nearestExpiryMs ?? Number.POSITIVE_INFINITY,
      _hasExpiry: facts.nearestExpiryMs !== undefined,
      _tokenExpiresAtMs: member.account.tokenExpiresAtMs ?? 0,
    }
  })

  const byExpiryMode = distribution === 'expiry'
  rows.sort((left, right) => {
    if (left._usable !== right._usable) return left._usable ? -1 : 1
    if (byExpiryMode) {
      // `expiry` 分布：有到期信息的先上，且最先到期者最前。
      if (left._hasExpiry !== right._hasExpiry) return left._hasExpiry ? -1 : 1
      if (left._expiring !== right._expiring) return left._expiring - right._expiring
      if (left.atRisk !== right.atRisk) return left.atRisk ? -1 : 1
    } else {
      if (left.atRisk !== right.atRisk) return left.atRisk ? -1 : 1
      if (left._order !== right._order) return left._order - right._order
      if (left.atRisk && right.atRisk && left._expiring !== right._expiring) {
        return left._expiring - right._expiring
      }
    }
    if (left.expiringAmount !== right.expiringAmount) {
      return right.expiringAmount - left.expiringAmount
    }
    if (left.score !== right.score) return right.score - left.score
    if (left._tokenExpiresAtMs !== right._tokenExpiresAtMs) {
      return right._tokenExpiresAtMs - left._tokenExpiresAtMs
    }
    // 末键用账号 id：两个在所有键上相等的账号否则会保持调用方恰好传入的顺序，
    // 同一份池两次排队可能不同——那既难推理也没法测。id 唯一，顺序因此是全序。
    return left.account.id < right.account.id ? -1 : left.account.id > right.account.id ? 1 : 0
  })

  return rows.map(({ account, score, atRisk, expiringAmount, nearestExpiryMs }) => ({
    account,
    score,
    atRisk,
    expiringAmount,
    ...nearestExpiryMs === undefined ? {} : { nearestExpiryMs },
  }))
}

/**
 * 取排序后第一个可服务的账号（DESIGN.md §5 的「谁下一个服务」）。
 *
 * 只是 {@link rankAccounts} 的一行封装：调用方若还需要名次或原因，直接用
 * `rankAccounts`。
 *
 * `warnDays` 必须与 `rankAccounts` 的第 5 个实参同源（用户的 `expiryWarnDays`）：
 * 「谁排第一」如果在两个入口上用两个窗口算，用户会看到卡片上写着 A 是下一个、
 * 实际请求被发到 B。
 */
export function pickRankedAccount<TAccount extends WbRankAccountRef>(
  members: readonly WbRankMember<TAccount>[],
  nowMs: number,
  orderIds: readonly string[] = [],
  distribution: AccountDistribution = DEFAULT_ACCOUNT_DISTRIBUTION,
  warnDays: number = DEFAULT_EXPIRY_WARN_DAYS,
): TAccount | undefined {
  return rankAccounts(members, nowMs, orderIds, distribution, warnDays)[0]?.account
}
