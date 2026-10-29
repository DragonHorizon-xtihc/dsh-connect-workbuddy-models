import z from "@deepseek-ai/schemastery";
import { Api, Model } from "@earendil-works/pi-ai";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { Context } from "@deepseek-ai/cordis";
//#region src/promo.d.ts
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
interface WbPromoBadge {
  /** 徽标自己的措辞，按区域本地化（CN 是 `限时免费`，global 是 `Free now`）。 */
  label: string;
  /** 上游给了就用它：英文措辞。 */
  labelEn?: string;
  /** 上游给了就用它：更短的措辞（窄行用）。 */
  shortLabel?: string;
  /** 上游给了就用它：英文短措辞。 */
  shortLabelEn?: string;
  /**
   * 徽标颜色，6 位 hex（CN 常见 `#009273` 绿，global 的 `Free now` 是 `#FF0000` 红）。
   *
   * 上游对部分促销给、部分不给（CN 的 tier 条目就没有），所以是可选的：缺了由界
   * 面退回自己的品牌色，而不是猜一个。
   */
  color?: string;
  /**
   * `'activeOnly'` —— 徽标属于促销的**运行期**，活动结束就必须消失。
   *
   * 缺省 —— 徽标是**常驻**的：它描述这个模型，只要促销本身还在；促销的每日窗口
   * 只管折扣。上游的「夜间折扣」成对条目正是这么用的：一条带徽标 + 夜间时段，
   * 另一条带同一个徽标 + 白天时段。
   */
  display?: 'activeOnly';
}
/** 一个每日窗口，写的是 `schedule.timezone` 里的墙钟。 */
interface WbPromoWindow {
  /** `'HH:mm'`，**含**。 */
  start: string;
  /**
   * `'HH:mm'`，**不含**。
   *
   * `end` 小于等于 `start` 表示窗口**跨午夜**：`23:00`–`7:50` 就是实测到的 CN 夜间窗。
   */
  end: string;
}
/** 促销什么时候跑。 */
interface WbPromoSchedule {
  /** 每日窗口所用的 IANA 时区（`Asia/Shanghai`）。 */
  timezone?: string;
  /** Epoch ms；在此之前促销还没开始。 */
  validFrom?: number;
  /** Epoch ms；**到这一刻**促销就结束了（排他）。 */
  validUntil?: number;
  /** 每日窗口，上游给了就有。 */
  daily?: readonly WbPromoWindow[];
  /**
   * 上游**发布**了 `daily`，但里面一个窗口都读不出来。
   *
   * 这与「没有 `daily`」是两件事：没有 `daily` 是 24 小时活动（促销在跑的时候折扣
   * 一直在），而每个窗口都解析失败的条目对「什么时候跑」什么都没说。把后者读成
   * 「一直跑」会把一个只做夜间的活动变成全天挂徽标 —— 那是唯一会**夸大**上游陈述
   * 的方向。所以带这个标记的促销永远不算「正在运行」：解析失败让徽标消失，而不是
   * 让它翻倍。
   */
  dailyUnusable?: true;
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
interface WbPromoDiscount {
  /**
   * 促销期间用户付的倍率，例如免费就是 `0`。
   *
   * 从 `discountedCredits`（`"0x"` / `"0.06x"` / `"0.06"`）解析，或只在有 `factor`
   * 时从它推导。两者都读不到就是 `undefined`。
   */
  multiplier?: number;
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
  displayMode?: 'replace' | 'strikethrough';
}
/** 上游给这个徽标配的说明文案。 */
interface WbPromoHover {
  /** 中文措辞。 */
  textZh?: string;
  /** 英文措辞。 */
  textEn?: string;
}
/** 一条上游促销或档位，解析成本插件使用的形状。 */
interface WbPromo {
  /** 上游的 id（`hy3-free-trial-202608`）。 */
  id: string;
  /** 这条来自哪个数组。 */
  source: 'promotion' | 'tier';
  /** 徽标作用于哪些模型。 */
  modelIds: readonly string[];
  /** 徽标说什么、长什么样。 */
  badge: WbPromoBadge;
  /** 上游的说明文案，有就有。 */
  hover?: WbPromoHover;
  /** 促销什么时候跑，上游给了就有。 */
  schedule?: WbPromoSchedule;
  /**
   * 上游的排序权重：数字越大，徽标越要紧。用来在多个都成立时**只挑一个**。
   */
  priority: number;
  /** 促销期间的折扣价，上游给了就有。 */
  discount?: WbPromoDiscount;
}
//#endregion
//#region src/status-paths.d.ts
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
type WbBusyLevel = 'idle' | 'normal' | 'busy' | 'congested' | 'unavailable' | 'unknown';
/** 插件 id。与 `package.json` 的 `name`、`cordis.patch.yml` 的 `name` 必须一致。 */
declare const PLUGIN_ID = "dsh-connect-workbuddy-models";
/** 设置命名空间（`installSection` / `configure` 的 ns）。 */
declare const WB_MODELS_SETTINGS_NS = "wbmodels";
/** 浏览器半区的 locale 命名空间。 */
declare const WB_MODELS_LOCALE_NS = "settings.wbmodels";
/**
 * 设置页在左侧导航里的排序位。
 *
 * xdpool 的账号池页占 440、trae-models 占 441（见两插件 `src/client/index.tsx`
 * 的 `order`），本插件排在其后，避免覆盖别人已经占住的位置。
 */
declare const WB_MODELS_SETTINGS_ORDER = 442;
/** 本插件所有 web 路由的共同前缀。 */
declare const ROUTE_PREFIX = "/plugins/dsh-connect-workbuddy-models";
/** GET：汇总状态（账号 / 积分 / 到期 / 签到 / 模型 / 配置）。 */
declare const WB_STATUS_PATH = "/plugins/dsh-connect-workbuddy-models/status";
/** POST：重新扫描本机登录账号。 */
declare const WB_ACCOUNTS_REFRESH_PATH = "/plugins/dsh-connect-workbuddy-models/accounts/refresh";
/** GET `?accountId=`：单账号积分明细。 */
declare const WB_ACCOUNT_CREDITS_PATH = "/plugins/dsh-connect-workbuddy-models/account/credits";
/** POST `?accountId=`（可省 = 全部）：手动签到。 */
declare const WB_CHECKIN_PATH = "/plugins/dsh-connect-workbuddy-models/checkin";
/** POST `?accountId=&kind=`：领取补偿 / 赠礼积分。 */
declare const WB_BENEFIT_CLAIM_PATH = "/plugins/dsh-connect-workbuddy-models/benefit/claim";
/** POST：拉取实时模型目录与倍率。 */
declare const WB_MODELS_REFRESH_PATH = "/plugins/dsh-connect-workbuddy-models/models/refresh";
/** POST：保存「需要显示的模型」选择。 */
declare const WB_MODELS_SAVE_PATH = "/plugins/dsh-connect-workbuddy-models/models/save";
/** POST `?accountId=&region=`：切换当前使用账号。 */
declare const WB_ACCOUNTS_SELECT_PATH = "/plugins/dsh-connect-workbuddy-models/accounts/select";
/** GET / POST：自动签到开关与时段。 */
declare const WB_AUTOMATION_PATH = "/plugins/dsh-connect-workbuddy-models/automation";
/** 选择账号的查询参数名。 */
declare const WB_ACCOUNT_ID_PARAM = "accountId";
/** 选择权益种类的查询参数名。 */
declare const WB_KIND_PARAM = "kind";
/** 选择区域（国内 / 国际）的查询参数名。 */
declare const WB_REGION_PARAM = "region";
/** 两个区域：国内版与国际版各是独立的一套 provider 栈。 */
type WbRegion = 'cn' | 'global';
/** 全部区域，按界面顺序。 */
declare const WB_REGIONS: readonly WbRegion[];
/**
 * 每个区域注册的 provider id。
 *
 * **必须是 `workbuddy-models`，不能是 `workbuddy`**：`dsh-connect-workbuddy`
 * （4.15.1）已经占住了 `workbuddy` / `workbuddy-global`
 * （见 `plugins/dsh-connect-workbuddy/src/adapter.ts:46,49`）。同一个 provider id
 * 注册两次，cordis 会抛 `service "llm" 的 provider 已注册` 类错误，后加载的那份
 * 插件整份注册失败——而用户看到的是「模型列表少了一半」，不是冲突提示。
 */
declare const WB_PROVIDERS: Readonly<Record<WbRegion, string>>;
/** 从 provider id 反查区域；不是本插件的 provider 时返回 undefined。 */
declare function wbRegionOfProvider(provider: string | undefined): WbRegion | undefined;
/** 区域 → provider id；未知区域回落到国内版。 */
declare function wbProviderOf(region: WbRegion | undefined): string;
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
type AccountDistribution = 'priority' | 'round-robin' | 'balanced' | 'sticky' | 'expiry';
/** 全部使用方式，按界面顺序。 */
declare const ACCOUNT_DISTRIBUTIONS: readonly AccountDistribution[];
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
declare const DEFAULT_ACCOUNT_DISTRIBUTION: AccountDistribution;
/** 窄化一个字符串是否为合法使用方式；非法值回落到默认（不抛错）。 */
declare function distributionOf(value: unknown): AccountDistribution;
/**
 * 一个积分包（DESIGN.md §4，来源 `plugins/dsh-connect-workbuddy/src/upstream.ts:165-260`）。
 *
 * 注意：`remain` 必须来自上游 `CycleCapacityRemainPrecise` 家族。`CapacityRemain`
 * 是 pool 家族，整月额度花完时仍报满额（高报，issue #58 定论）。
 */
interface WbCreditPackage {
  packageName: string;
  /** 剩余额度。 */
  remain: number;
  /** 包的总量。 */
  size: number;
  /** `CapacityType 4`：按周期刷新、永不过期。 */
  monthly: boolean;
  /** 下次周期刷新时刻（ms）；仅周期包有。 */
  refreshAtMs?: number;
  /** 一次性包的到期时刻（ms）；到期后包从账号上消失。 */
  expiresAtMs?: number;
}
/** 一个账号的积分聚合（DESIGN.md §4）。 */
interface WbCredits {
  total: number;
  packages: readonly WbCreditPackage[];
  /** 临期窗口内会过期的额度；`0` 表示没有东西在流失。 */
  expiringSoon: number;
  /** 最近一个包的到期时刻（ms）；无到期信息时缺省。**不是** `0`。 */
  nearestExpiryMs?: number;
}
/** 签到状态（DESIGN.md §4）。 */
interface WbCheckinStatus {
  active: boolean;
  todayCheckedIn: boolean;
  streakDays: number;
  dailyCredit: number;
  todayCredit: number;
  isStreakDay: boolean;
  nextStreakDay: number;
  streakBonusDays: number;
  streakBonusCredit: number;
  /** 上游给的按钮文案；缺省时界面用本地文案。 */
  claimButtonText?: string;
}
/**
 * 一个可显示 / 可选择的模型（DESIGN.md §4）。
 *
 * `creditMultiplier` **`undefined ≠ 0`**：CN 的 fallback 目录整份没有该字段，
 * 把 `undefined` 当 `0` 会把收费模型显示成免费（见 `parseCreditMultiplier`,
 * `plugins/dsh-connect-workbuddy/src/upstream.ts:1878`）。所以它只能是
 * `number | undefined`，绝不能给默认值 0。
 */
interface WbModelInfo {
  id: string;
  name: string;
  /** 积分倍率：`0` 是免费，`undefined` 是未知。两者含义相反。 */
  creditMultiplier?: number;
  contextWindow?: number;
  maxTokens?: number;
  supportsImages?: boolean;
  multimodal?: boolean;
  description?: string;
  /**
   * 点名了这个模型的促销/档位条目（**未解析**，按 priority 降序）。
   *
   * 为什么是「一组未解析条目」而不是「选好的一个」：徽标要对着时钟选，选的结果只在
   * 渲染那一刻成立。在这里解析等于把答案冻在取数时刻 —— 那正是「夜间折扣」到了白天
   * 还自称夜间的那个缺陷。选择逻辑在 `promo.ts` 的 `selectPromoBadge`。
   *
   * `undefined`（没这条键）与 `[]`（有点名但都被解析丢了）在界面上等价：都没有徽标。
   */
  promos?: readonly WbPromo[];
  /**
   * 模型此刻的拥挤度。
   *
   * `undefined` 是「没问过」，`'unknown'` 是「问过但上游答了个不认识的值」。两者的
   * 差别只在诊断，界面上都不画 —— 画一个「未知拥堵」只会让用户以为出了事。
   */
  busyLevel?: WbBusyLevel;
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
  reasoning?: WbReasoning;
}
/**
 * 上游宣告的推理档位元数据（两种拼写已归一）。
 *
 * 三个字段全部可选，且**都不补默认值**：上游哪个字段没给，就是「不知道」。
 */
interface WbReasoning {
  /**
   * 该模型接受的档位名单（上游原样宣告，未经本插件的已知档位过滤）。
   *
   * 保留原始值而不是在这里裁剪：`adapter.ts` 要按 pi-ai 的档位词表过滤，而
   * 卡片要显示上游到底说了什么。两个消费者需要的东西不同，解析层只做搬运。
   */
  supportedEfforts?: readonly string[];
  /** 上游给这一档起的默认值。 */
  defaultEffort?: string;
  /**
   * 能否关闭思考（`false` = 必须思考）。
   *
   * `undefined` 同样是「没说过」，此时不提供 `off` 档——这与本插件处理其余
   * 未宣告能力的方式一致。
   */
  canDisableThinking?: boolean;
}
/** 账号被发现时的来源。 */
type WbAccountSource = 'desktop' | 'dsh';
/**
 * 一个可选账号（token-free 投影，凭据永远留在宿主）。
 */
interface WbAccount {
  id: string;
  /** 账号的人话名字；桌面端没记时是 `''`，由界面补占位符。 */
  accountName: string;
  /** 上游域名，用于判定区域。 */
  domain: string;
  region: WbRegion;
  source: WbAccountSource;
  /** 凭据到期时刻（ms）。 */
  tokenExpiresAtMs: number;
  /** 解析出的凭据文件路径（只读诊断用，不含令牌内容）。 */
  sourcePath: string;
  /** 是否是当前区域正在使用的账号。 */
  selected: boolean;
}
/**
 * 一个被跳过的凭据文件。
 *
 * 必须暴露：否则「2 个账号」与「4 个文件里 2 个读不了」在界面上看起来一模一样。
 * `encrypted` 是 WorkBuddy 特有的——Windows 构建会加密令牌字段，此时让用户
 * 「重新登录」是错的（他本来就登着）。
 */
interface WbSkippedFile {
  path: string;
  reason: 'encrypted' | 'unreadable' | 'malformed';
}
/** 可领取的权益种类。 */
type WbBenefitKind = 'compensation' | 'gift';
/** 窄化一个字符串是否为合法权益种类。 */
declare function benefitKindOf(value: unknown): WbBenefitKind | undefined;
/** 单个账号在状态文档里的读数。 */
interface WbAccountReading {
  account: WbAccount;
  /** 读不到余额时缺省——**不是** `0`。`0` 是对账号下的断言。 */
  credits?: WbCredits;
  checkin?: WbCheckinStatus;
  /** 该账号此刻为什么不能服务；能服务时缺省。 */
  excludedBy?: string;
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
interface WbAccountPickReason {
  accountId: string;
  /** 名次，1 起。1 名就是下一个请求会发去的那个账号。 */
  rank: number;
  score: number;
  /** 是否有积分落在用户设置的临期窗口里。 */
  atRisk: boolean;
  /** 临期窗口内会流失的额度；`0` 表示没有临期积分。 */
  expiringAmount: number;
  /** 一次性积分包中最近的未来到期；纯月包账号缺省（**不是** 0）。 */
  nearestExpiryMs?: number;
  usable: boolean;
  /** 不可服务时的可行动理由；能服务时缺省。 */
  reason?: string;
}
/** `/status` 的应答（浏览器半区与宿主半区共同的投影）。 */
interface WbStatusSnapshot {
  /** 扫描到的时间戳（ms）。 */
  scannedAtMs: number;
  region: WbRegion;
  accounts: readonly WbAccountReading[];
  /** 被跳过的凭据文件，必须原样上报。 */
  skipped: readonly WbSkippedFile[];
  models: readonly WbModelInfo[];
  /** 池子里的剩余总积分（所有参与账号之和）。 */
  totalCredits: number;
  /** 配置回显，供设置页首帧就画出用户的选择。 */
  config?: WbModelsConfig;
  /**
   * 本区域的名次表与每位名次的理由。
   *
   * **可选**是刻意的：它是解释性字段，缺了只损失一句说明，不该让「拿到快照」
   * 这件事本身失败。所有手写快照（测试夹具、宿主首帧预置）都不必为它补值。
   */
  picks?: readonly WbAccountPickReason[];
  /**
   * 本区域每个模型的拥挤度，按模型 id 索引。
   *
   * 与 `models[].busyLevel` 同源（都来自同一个 `fetchModelBusy` 结果），之所以在顶层
   * 再给一份，是因为模型选择器的标签槽只拿到 `model.id`、拿不到 `/status` 的
   * `models[]` 元素；没有这份表它就只能为此再打一次请求。
   *
   * **两处必须一致。** 不一致说明有人只更新了一条通路，那是缺陷不是风格。
   */
  busyLevels?: Readonly<Record<string, WbBusyLevel>>;
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
  modelsFetchedAtMs?: number;
  /**
   * 本区域目录距上次成功抓取的毫秒数；从未抓取过时为 `undefined`。
   *
   * 与 {@link modelsFetchedAtMs} 同时给出是刻意的：界面拿到绝对时刻还要自己
   * 算差值，而算差值必须用**客户端**的时钟，客户端的时钟与服务端不一定一致。
   * 服务端算好一并给出，界面就不必为此做时钟假设。
   */
  modelsAgeMs?: number;
  /**
   * 本区域拥挤度**最近一次成功抓取**的时刻（ms），与 {@link modelsFetchedAtMs}
   * 分开，因为这是两条独立的上游链路（`/v2/chat/busy` 与 `/v3/config`）。
   *
   * 拥挤度是分钟级事实，过期没刷新时界面应当把它降级成「未知」而不是继续显示
   * 一个已经不成立的「空闲」。
   */
  busyFetchedAtMs?: number;
}
/** 自动签到配置（DESIGN.md §7-§8）。 */
interface WbAutomationConfig {
  enabled: boolean;
  /** 北京时间整点，默认 `[9]`。 */
  checkinHours: readonly number[];
  /** 是否顺带领取可领的补偿 / 赠礼。 */
  claimBenefits: boolean;
}
/** 插件配置（DESIGN.md §7）。 */
interface WbModelsConfig {
  /** 是否启用本 provider。 */
  enabled: boolean;
  /** 账户使用方式（R4：必须真正生效）。 */
  distribution: AccountDistribution;
  /** 需要显示的模型；**空数组 = 全部显示**（DESIGN.md §7）。 */
  enabledModelIds: readonly string[];
  /** 国际版的同一份选择。 */
  enabledModelIdsGlobal: readonly string[];
  /** 参与池的账号 id。 */
  accountsEnabled: readonly string[];
  /** 用户手动排序的账号 id。 */
  orderAccountIds: readonly string[];
  /** 输入框下方读数开关。 */
  showCreditsInComposer: boolean;
  /** 临期提醒阈值（天）。 */
  expiryWarnDays: number;
  automation: WbAutomationConfig;
  /** 当前使用账号，按区域。 */
  accounts: {
    cn?: string;
    global?: string;
  };
}
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
declare function unwrapVolatile<T>(value: T): T;
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
declare function unwrapVolatileDeep<T>(value: T): T;
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
declare const DEFAULT_EXPIRY_WARN_DAYS = 3;
/** 临期提醒阈值的合法下界（天）。 */
declare const EXPIRY_WARN_DAYS_MIN = 1;
/** 临期提醒阈值的合法上界（天）。 */
declare const EXPIRY_WARN_DAYS_MAX = 90;
/** 参与排序的账号最少需要这些字段。 */
interface WbRankAccountRef {
  id: string;
  /** 凭据到期时刻，用于最后的平局判定。 */
  tokenExpiresAtMs?: number;
}
/** 一个待排序的池成员。 */
interface WbRankMember<TAccount extends WbRankAccountRef = WbRankAccountRef> {
  account: TAccount;
  /** 该账号的积分读数；读不到时缺省。 */
  credits?: WbCredits;
  /** 此刻是否可服务；缺省视为可服务。 */
  usable?: boolean;
  /** 排序分数，缺省为 `credits.total`。 */
  score?: number;
}
/** 排序结果的一行。 */
interface WbRankedAccount<TAccount extends WbRankAccountRef = WbRankAccountRef> {
  account: TAccount;
  score: number;
  /** 是否有额度正在流失（临期窗口内会过期）。 */
  atRisk: boolean;
  /** 流失中的额度数量。 */
  expiringAmount: number;
  /** 最近到期时刻（ms）；无到期信息时缺省。 */
  nearestExpiryMs?: number;
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
declare function rankAccounts<TAccount extends WbRankAccountRef>(members: readonly WbRankMember<TAccount>[], nowMs: number, orderIds?: readonly string[], distribution?: AccountDistribution, warnDays?: number): readonly WbRankedAccount<TAccount>[];
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
declare function pickRankedAccount<TAccount extends WbRankAccountRef>(members: readonly WbRankMember<TAccount>[], nowMs: number, orderIds?: readonly string[], distribution?: AccountDistribution, warnDays?: number): TAccount | undefined;
//#endregion
//#region src/upstream.d.ts
/**
 * 一份解析好的 WorkBuddy 凭据。
 *
 * 字段名与来源对齐 `plugins/dsh-workbuddy-xdpool/src/accounts.ts:62-100` 的
 * `WorkBuddyCredential`；本插件只做只读发现，所以**不含**任何写回桌面端的能力。
 */
interface WbCredential {
  accessToken: string;
  refreshToken: string;
  /** 凭据到期时刻（ms）；0 表示文件里没有该字段。 */
  expiresAtMs: number;
  refreshExpiresAtMs?: number;
  /**
   * 上游自己记录的签发时刻（`auth.lastRefreshTime`）。
   *
   * 这是**唯一可信的新鲜度信号**，不是 `expiresAtMs`：上游吊销 token 时不会改写
   * 已存的到期时间，于是一份早已死掉的备份可以声称比真正可用的 token 到期更晚。
   * 按到期时间选号会让每次上游调用都 401，而同一个目录里明明躺着一份好凭据。
   */
  lastRefreshAtMs?: number;
  nickname?: string;
  /** 计费身份，重新登录后不变；账号 id 优先取它。 */
  uin?: string;
  uid?: string;
  enterpriseId?: string;
  /** 上游域名，用于判定区域。空串 = 未知（按国内处理）。 */
  domain: string;
  /** 凭据文件路径。只读诊断用，响应里绝不下发。 */
  sourcePath: string;
}
/**
 * 上游失败的种类。
 *
 * 只保留本插件会**分支**的种类：每一类都对应一句不同的用户可执行建议，没有
 * 分支的种类留在这里只会让每种失败都退化成同一句话。
 */
type WbUpstreamErrorKind =
/** 402 / 余额耗尽：换号有意义，重试无意义。 */
'hard_credit' |
/** 429 / 限流：等一会儿，或换号。 */
'soft_rate' |
/** 401/403：凭据本身被拒，等没用，必须重新登录。 */
'authentication' |
/** 会话/登录态失效（上游业务码），与上者的区别是可能靠 refresh 恢复。 */
'session_dead' |
/** 内容/渠道拒绝：请求本身被拒，换号不会有帮助。 */
'client_reject' |
/**
 * 渠道闸门（业务码 11128 家族里「未授权通道」那一支）：网关按**请求内容**判定
 * 通道，换账号、换区域都不改变结论。
 *
 * 为什么必须与 {@link WbUpstreamErrorKind} 的 `client_reject` 分开：这一支是
 * 11128 家族里唯一**可以自愈**的。请求被拒是因为 system 开场白被当成第三方
 * agent 的指纹，把开场白换成中性占位、或在句子边界插不可见字符破坏精确子串
 * 匹配，同一个账号同一个模型就能过（实测：只加一行 `You are a helpful
 * assistant.` 就从 400 变 200）。压成 `client_reject` 的话，调用方拿到的结论
 * 是「请求形状有问题，别换了」，于是唯一那条能救回来的路也一并关掉。
 *
 * 两者都**不值得换号**，区别只在「要不要先自救一次」。换号规则仍由
 * `worthRetrying` 统一回答 false。
 */
'channel_reject' |
/**
 * 本机 billion-context 的本地闸门拒绝了请求，**请求根本没到 WorkBuddy 上游**。
 *
 * 两支的成因不同，所以不合并：
 * - `local_gate_unattributed`：这次请求没有归属到任何受管会话，而请求体本身可证明
 *   超过 1,000,000 token —— 塞给上游也只会被拒，每一次重试都重发同一份超长历史；
 * - `local_gate_oversize`：闸门查询会话归属时抛了错（agent 作用域已释放/正在关闭），
 *   超长历史折叠不进模型窗口，作用域恢复前同一次调用会一直失败。
 *
 * 为什么必须与 {@link WbUpstreamErrorKind} 的 `client` 分开：`client` 的处置建议是
 * 「按上面的提示调整参数」，而这支的处置是**裁剪历史或新开会话**，两者不可互换。
 * 更要紧的是 `client` 那句附带「换账号也不会改变结果」在本支属于纯误导 —— 用户会
 * 去换账号、换模型，而唯一能解决的三件事（接入受管会话 / 裁掉超大内容 / 新开会话）
 * 一件都没被说出来。闸门给的 `error.code`、`error.message`、`error.retryable` 是它
 * 自己写的可执行建议，必须原样透出而不是压成一句通用话。
 *
 * 也别指望状态码能区分：两支都是 422，而 422 在这套分类里原本落到 `client`，
 * 对外还会被 `KIND_STATUS` 再压成 400 —— 用户看到的 400 与「参数写错了」完全同形。
 */
'local_gate_oversize' |
/** 同上，未归属那一支（`bili_gate_oversize_refusal_unattributed`）。 */
'local_gate_unattributed' |
/** 其余 4xx：请求形态问题。 */
'client' |
/** 5xx / 传输失败：上游坏了。 */
'server';
/** 上游拒绝凭据。独立的错误类，让调用方能给出「请重新登录」而不是 HTTP 码。 */
declare class WbCredentialRejectedError extends Error {
  readonly code = "WB_CREDENTIAL_REJECTED";
  readonly status: number;
  constructor(status: number, detail?: string);
}
/** 判断一个错误是否是「上游拒绝凭据」；按 code 判定，跨 bundle 安全。 */
declare function isCredentialRejectedError(value: unknown): boolean;
/**
 * 把一个 HTTP 失败归类。
 *
 * 顺序是有理由的：先按**状态码**给出确定答案（402 就是钱的问题），再看 body 里
 * 的标记；`CREDITS_EXHAUSTED_CODE` 排在软限流之前，因为同时带「耗尽」与「节流」
 * 两种码的 body 应当给出可执行的那个结论（去充值/换号），而不是「等一会儿」。
 */
declare function classifyUpstreamError(status: number, body: string): WbUpstreamErrorKind;
/**
 * 登录域名 → 区域。
 *
 * 国际产品在**两个**品牌域名下可达：WorkBuddy AI 桌面端登录在 `workbuddy.ai`，
 * CodeBuddy CLI 把同一个国际账号登录在 `codebuddy.ai`。两者背后是同一套网关。
 * 漏掉 `codebuddy.ai` 会把那些 token 发到国内网关，被 openresty 层以 HTML 401
 * 拒绝——看起来像「凭据坏了」。
 */
declare function regionOf(domain: string): WbRegion;
/** 一个上游模型条目（解析后）。 */
interface WbUpstreamModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  /**
   * 积分倍率。
   *
   * **`undefined ≠ 0`**：上游 CN 的静态 fallback 名册整份没有 `credits` 字段，
   * 把 `undefined` 当 0 会把收费模型显示成「免费」——用户会按免费模型去用，然后
   * 发现积分在掉。所以解析器宁可返回 `undefined`（未知），也绝不补默认值 0。
   */
  creditMultiplier?: number;
  supportsImages?: boolean;
  description?: string;
  supportsToolCall?: boolean;
  /**
   * 拥挤度（`/v2/chat/busy` 给的）。
   *
   * `undefined` 表示**没问过**（国际网关没有这个端点，或探测失败降级），与
   * `'unknown'`（问过但上游答了个我们不认识的值）是两件事。两者都不渲染。
   */
  busyLevel?: WbBusyLevel;
  /**
   * 点名了这个模型的促销/档位条目（**未解析**，按 priority 降序）。
   *
   * 与 `busyLevel` 一样只是「取数那一刻的快照」，本层不做选择：徽标要对着时钟选，
   * 选择逻辑在 `promo.ts` 的 `selectPromoBadge`。
   */
  promos?: readonly WbPromo[];
  /**
   * 上游宣告的推理档位（两种拼写已归一，见 {@link parseReasoning}）。
   *
   * `undefined` = 上游没给这个字段 = 未知。**绝不补 `{}`**：空对象读起来像「宣告了
   * 零个档位」，而下游（`adapter.ts`）对这两者的处置不同——没宣告就不提供选择器，
   * 宣告了空名单同样不提供，但诊断文案要说清楚是上游没给还是上游给了个空的。
   */
  reasoning?: WbReasoning;
}
/**
 * 解析 `credits` 字段（形如 `'x0.00'` / `'x3.31'`）。
 *
 * 只认字符串：上游把倍率编成带 `x` 前缀的字符串，数字形状在实践中没出现过。
 * 非字符串一律 `undefined`（未知），不猜。
 */
declare function parseCreditMultiplier(value: unknown): number | undefined;
/**
 * 解析一个目录条目；没有可用 token 限额的条目直接丢弃。
 *
 * 丢弃而不是补默认值：`contextWindow` 是 DSH 派发前的压缩依据，编一个数字会
 * 让 DSH 按错误的窗口决定截断多少历史。
 */
declare function parseUpstreamModel(value: unknown): WbUpstreamModel | undefined;
/**
 * 从目录形状的文档里挑出可对话的模型。
 *
 * 两种文档（国内个人模型文档、国际 `/v3/config`）都带 `models` 与一个 `agents`
 * 名册，同条目形状，所以一个选择器服务两者。没有可用 `cli` 名册时放出整份解析
 * 结果而不是空：名册是上游细节，空答案会让 provider 静默失效。
 *
 * `keepIds` 是用户自己的选择随刷新一起带过来。上游名册可能撤掉用户正在用的模型
 * （实测：app 通道的 `cli` 名册撤掉了 `minimax-m2.7`，而**同一份文档**仍在发布
 * 它、聊天端点仍答 200）。所以名册 = 上游名册 + 这份文档仍列出的 keepIds：刷新
 * 可以增删上游模型，但绝不静默撤掉用户正在用的模型。
 */
declare function selectCliModels(rawModels: unknown, agents: unknown, keepIds?: readonly string[]): WbUpstreamModel[];
/**
 * 上游 400 信封里**给用户看的那部分**。
 *
 * 为什么需要单独解析：`chat()` 失败时 `message` 带的是上游原始 body 全文（最多
 * 4096 字符），前 400 字符恰好是 `code`/`requestId`/`extError` 的 JSON 骨架
 * （`"param":""`、`"Request":null`…）。直接截断送给用户，等于把唯一一句可执行的
 * 建议（`displayTips`）切在句子中间，而用户读到的是一个 `{` 开头的信封。
 *
 * 字段名与语义照抄参考实现
 * （`plugins/dsh-connect-workbuddy/src/upstream.ts:1273-1306`），因为两边面对的是
 * 同一份上游协议；改名的代价是下次对照取证时要重新翻译一遍。
 */
interface WbUpstreamErrorDetail {
  /** 上游业务码（这里出现的典型值是 11133 = 参数被拒）。 */
  upstreamCode?: number;
  /** 上游请求 id，报障时唯一能对上他们日志的东西。 */
  requestId?: string;
  /** 上游 `msg`（英文短句，通常是 `the request parameters were rejected…`）。 */
  rawMsg?: string;
  /** `displayMsg` 的中文（或英文）版：一句短结论。 */
  displayMsg?: string;
  /** `displayTips` 的中文（或英文）版：一句可执行的建议。 */
  tips?: string;
  /** `extError.param`：哪个参数被拒（空串不记，空串等于没说）。 */
  rejectedParam?: string;
  /** `extError.value`：该参数被拒时用的值（`off` 之类）。 */
  rejectedTier?: string;
  /**
   * 本机闸门把它自己的业务码写在 `error.code` 里（字符串，如
   * `bili_gate_oversize_refusal_unattributed`），不是顶层数字 `code`。
   *
   * 单独一个字段而不是塞进 `upstreamCode`：后者是 number 且语义是「上游业务码」，
   * 而这串是**本机中间件**的标识，混在一起会让「这是谁拒的」这个判断在类型层面
   * 就丢失了。
   */
  localGateCode?: string;
  /** `error.retryable`：闸门自己声明的可重试性（两支都是 `false`）。 */
  retryable?: boolean;
}
/**
 * 一次聊天请求的结果：要么是活的 SSE，要么是已归类的失败。
 *
 * `retryable` 是**池级策略**信号，只在上游客户端自己没能把凭据救回来时置位：它回答
 * 「这份凭据还有没有救」。`kind` 回答的是另一个问题——「这次请求为什么失败」。
 *
 * 两者必须分开，因为它们曾经共用一个字段：刷新时网络抖一下也报
 * `kind: 'authentication'`，而 shim 见 `authentication` 就把账号标成凭据已死，
 * 且判死之后没有任何恢复路径（要重启 DSH 才回到池里）——一次网络抖动被升级成一次
 * 完全不必要的重新登录。
 */
type WbChatResult = {
  ok: true;
  response: Response;
} | {
  ok: false;
  status: number;
  kind: WbUpstreamErrorKind;
  message: string;
  retryable?: boolean;
  /**
   * 上游信封里给用户看的那部分。
   *
   * 只有 HTTP 非 2xx 且 body 是 JSON 对象时才有值；网络层失败、非 JSON 边缘层
   * 错误页都给不出它。缺省是常态，调用方必须能只靠 `message` 工作。
   */
  detail?: WbUpstreamErrorDetail;
};
/** 积分读取的原始产物：只到「包 + 总量」，窗口聚合交给探测层。 */
interface WbRawCredits {
  total: number;
  packages: readonly WbCreditPackage[];
}
/** 签到状态（投影类型见 status-paths）。 */
interface WbUpstreamCheckin {
  active: boolean;
  todayCheckedIn: boolean;
  streakDays: number;
  dailyCredit: number;
  todayCredit: number;
  isStreakDay: boolean;
  nextStreakDay: number;
  streakBonusDays: number;
  streakBonusCredit: number;
  claimButtonText?: string;
}
/** 领取签到奖励的回执。 */
interface WbCheckinClaim {
  credit: number;
  streakDays: number;
  isStreakDay: boolean;
}
/** 一个促销权益（补偿 / 赠礼）。 */
interface WbBenefit {
  kind: 'compensation' | 'gift';
  /** 活动窗口是否开着。 */
  active: boolean;
  /** 本账号是否已领。 */
  claimed: boolean;
  creditNum: number;
  endsAtMs?: number;
  startsAtMs?: number;
  claimedAtMs?: number;
}
/**
 * 上游客户端。一个实例服务整个插件；请求显式接收凭据，所以 token 刷新在下一次
 * 调用里自然生效。
 */
declare class WbUpstreamClient {
  private readonly onFallback?;
  /**
   * 上报一次不得不采取的降级。
   *
   * 注入而不是在这里打日志：本模块不持 logger（理由见文件头）。宿主把它接到
   * `ctx.logger.warn`；没有宿主时事件被丢弃——与只有单一读取方的旧实现同等的安静。
   */
  constructor(onFallback?: ((message: string) => void) | undefined);
  /**
   * POST 聊天端点；成功的答案是原始 SSE 响应。
   *
   * 这是**唯一**会在失败后自愈的请求：登录态过期在这里最贵（用户正对着输入框等
   * 回答），而在余额/签到路径上过期只是少一个读数。自愈规则是「一次请求最多换一次
   * token」——`refreshed` 是这次调用的局部量而不是客户端上的标志位，所以并发中的
   * 十个请求各换各的一次，而每个请求自己绝不换第二次。上游对 refresh 端点有频次
   * 限制，重试环里再刷就变成用一个已经被拒的 token 反复敲门。
   */
  chatStream(credential: WbCredential, bodyJson: string, signal?: AbortSignal): Promise<WbChatResult>;
  /** 一次不带自愈的聊天 POST。自愈逻辑在 {@link chatStream} 里，这里只负责发。 */
  private postChat;
  /** POST token 刷新端点。调用方负责合并结果。 */
  refreshToken(credential: WbCredential): Promise<{
    accessToken?: string;
    refreshToken?: string;
    expiresInSec?: number;
  }>;
  /**
   * 用 refresh token 换一份新登录态，**原地改写** `credential`。
   *
   * 原地改而不是返回新对象：池里那份 `WbDiscoveredAccount.credential` 与 shim 手里
   * 的是同一个引用，换对象只会让这次请求用上新 token、下一次调用又回到旧的那份。
   *
   * 顺序是「先改内存再落盘」：即使磁盘满或权限不对，本次请求仍然可用；反过来先落盘
   * 再改内存，写失败会连带失掉一次本来能成功的回答。
   */
  private renewCredential;
  /**
   * 读模型目录。
   *
   * 两个区域一律先读 `/v3/config`（应用通道文档）；国内失败时回退旧路径。三种失败
   * 都要回退——传输错误、非零信封、以及**空名册**（`selectCliModels` 对空名册抛错），
   * 让「/v3 停止列出模型」退化成少一点功能，而不是整个区域没有模型。
   */
  fetchModels(credential: WbCredential, signal?: AbortSignal, keepModelIds?: readonly string[]): Promise<readonly WbUpstreamModel[]>;
  /**
   * 问一次上游「这些模型现在挤不挤」。
   *
   * 一个请求问一整批（`WORKBUDDY_BUSY_BATCH_SIZE` 个），绝不逐个轮询：名册 20-62 个
   * 模型逐个问就是 20-62 个往返，而这条信息只是给人看的装饰。
   *
   * 非零信封与传输失败一律抛错，由 {@link withBusyLevels} 统一兜成「不挂等级」——
   * 与同类 reader 的分工一致：解析层只负责如实报告，降级策略留给调用方决定。
   */
  fetchModelBusy(credential: WbCredential, modelIds: readonly string[], signal?: AbortSignal): Promise<Map<string, WbBusyLevel>>;
  /**
   * 给名册挂上拥挤度；问不到就原样返回名册。
   *
   * 三层防线都在这里，顺序刻意：
   * 1. **按区短路**：国际网关没有 `/v2/chat/busy`（实测 404）。发出去再吞错会让每次
   *    刷新多一个注定失败的往返，还会在国际区的日志里留下一条永远为真的告警。
   * 2. **失败静默降级**：超时/404/非零信封都只 warn 一次，名册原样返回。拥挤度是
   *    装饰性信息，它失败不该让「刷新模型」这件事失败，也不该让名册少一个模型。
   * 3. **写进 `name`**：`WbModelInfo`（`status-paths.ts`）没有拥挤度字段，而
   *    `catalog.toModelInfo()` 只搬运固定几个字段——`name` 是唯一能原样到达界面的
   *    字段。所以符号拼在名字后面，`unknown`/`undefined` 拼空串（名字逐字节不变）。
   */
  withBusyLevels(credential: WbCredential, models: readonly WbUpstreamModel[], signal?: AbortSignal): Promise<WbUpstreamModel[]>;
  /** 读一份原始名册（不含拥挤度）。拆分出来只为了让 `fetchModels` 的降级链保持原样。 */
  private readCatalogModels;
  /** 读今日签到状态，不改账号状态。 */
  fetchCheckinStatus(credential: WbCredential): Promise<WbUpstreamCheckin>;
  /**
   * 读这个账号还能看到的全部促销权益，**不领取任何东西**。
   *
   * 活动清单刻意是封闭且小的：网关每个活动一个状态端点，所以「发现权益」是一次
   * 固定的扇出，不是搜索。新活动类型意味着在这里加一个 `/billing/meter/*-status`
   * ——插件从不猜未公开的端点。
   *
   * 每个端点独立读、失败按端点隔离：一个活动回 5xx 不能让另一个消失。调用方只
   * 拿到真正读到的东西。
   */
  fetchBenefits(credential: WbCredential): Promise<readonly WbBenefit[]>;
  private readBenefitStatus;
  /**
   * 在**一个**账号上领取一个权益。
   *
   * 这是一次真实的积分发放，所以除交给它的凭据之外不接受任何账号参数：由调用方
   * 决定是哪一个账号，且刻意没有批量形式。响应不解析——这两个端点的文档信封是
   * 空成功，调用方事后重读状态；那次重读才是给用户看的东西，所以「点了没生效」
   * 不会让卡片一直停在待领取。
   */
  claimBenefit(credential: WbCredential, kind: WbBenefit['kind']): Promise<void>;
  /** 领取今日签到奖励。浏览器路由守着这次写操作。 */
  claimDailyCheckin(credential: WbCredential): Promise<WbCheckinClaim>;
  /**
   * 读剩余积分，**每个包单独保留**。
   *
   * 不在这里聚合（总量之外的任何汇合都会丢掉卡片排序需要的日期），窗口聚合交给
   * `probe.ts` —— 因为临期窗口必须用**用户配置的** `expiryWarnDays`，而这个模块
   * 不应该知道用户设置。
   *
   * 余额取 `CycleCapacityRemain` 家族（issue #58 定论）：`CapacityRemain` 是
   * pool 家族，整月额度花完时仍报满额（高报）；国际网关实测三账号报
   * `CapacityRemain=100`，而 chat 直接回 `14018 Credits exhausted`。用高报的那个
   * 当余额，排在第一的永远是一个已经用光的账号。
   */
  fetchCredits(credential: WbCredential): Promise<WbRawCredits>;
}
//#endregion
//#region src/accounts.d.ts
/** 桌面端正在使用的那份登录文件名。它永远优先被选。 */
declare const WORKBUDDY_LIVE_FILENAME = "workbuddy-desktop.info";
/**
 * 覆盖登录文件（或它所在目录）的环境变量。
 *
 * 允许指目录，是因为用户在 issue 里报自己的路径时通常给的是目录；只认文件会让
 * 「我明明设了变量」变成一个静默的空池。
 */
declare const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";
/**
 * 平台默认的登录目录。
 *
 * Windows 先探 Local 再探 Roaming：重定向过配置文件的机器上，登录文件可能在
 * Roaming 里，而 `LOCALAPPDATA` 指向一个空目录——只探一个会得到「没有账号」。
 */
declare function defaultDesktopAuthDirs(platform?: NodeJS.Platform, home?: string, env?: NodeJS.ProcessEnv): string[];
/** 同 {@link candidateAuthSources} 的纯路径视图（既有调用点与诊断脚本用）。 */
declare function candidateAuthDirs(env?: NodeJS.ProcessEnv): string[];
/**
 * 一个被发现并解析成功的账号。
 *
 * 显式满足 `WbRankAccountRef`：`rankAccounts` 用 `tokenExpiresAtMs` 做最后的平局
 * 判定，少这个字段会让所有同余额账号退化成按 id 排——而 id 是哈希，等于随机。
 */
interface WbDiscoveredAccount extends WbRankAccountRef {
  id: string;
  /** 凭据到期时刻（ms）；0 或缺失表示上游没给。 */
  tokenExpiresAtMs?: number;
  /** 人话名字；桌面包里没有昵称时是 `WorkBuddy`。 */
  label: string;
  credential: WbCredential;
  region: WbRegion;
  sourcePath: string;
  /**
   * 这份凭据是从哪类来源读到的。
   *
   * 必填且不下默认值：桌面端 `.info` 与 dsh vault `.json` 的续期方式完全不同——
   * 前者要用户回桌面端重登，后者重新登录 `dsh-connect-workbuddy` 也可能救回来。
   * 让这个字段缺省成 `'desktop'` 会把「没接通」伪装成「接通了」，正是这一缺陷
   * 当初躲过复核的方式。
   */
  source: WbAccountSource;
  /** 是否是桌面端正在使用的那份登录。 */
  live: boolean;
  /**
   * 刷新窗口已关闭：这份凭据救不回来了。
   *
   * 不当作「跳过文件」而是当成一个**账号状态**：用户看到「某某账号的登录窗口已于
   * X 关闭」比看到「你的 4 个文件里有 1 个读不了」更能采取行动。
   */
  refreshExpired: boolean;
}
interface WbDiscoveryResult {
  accounts: readonly WbDiscoveredAccount[];
  skipped: readonly WbSkippedFile[];
}
/**
 * 扫描全部候选目录，把每个可解析文件变成一个账号。
 *
 * 同一账号的多份快照折叠成一份（见 {@link compareFreshness}）：池里一个账号只能
 * 出现一次，否则「剩余总积分」会把同一个人的历史快照重复相加。
 *
 * `decrypt` 不接受外部注入——它是内部实现细节；单测要喂合成信封时直接测
 * {@link parseWorkBuddyAuth} 的三参形态，那条路径才是真正的契约面。
 */
declare function discoverAccounts(options?: {
  authDirs?: readonly string[];
  env?: NodeJS.ProcessEnv;
}): Promise<WbDiscoveryResult>;
/** 一轮选号的结果：选中谁，以及整份名次（界面要显示「为什么它排在后面」）。 */
interface WbPickResult<TAccount extends WbRankAccountRef = WbDiscoveredAccount> {
  account?: TAccount;
  ranked: readonly WbRankedAccount<TAccount>[];
}
/** 一个账号此刻的池状态。 */
interface WbPoolEntry {
  account: WbDiscoveredAccount;
  /** 最近一次读到的积分；没读过时缺省（**不是** 0）。 */
  credits?: WbCredits;
  /**
   * 最近一次读到的签到状态。
   *
   * 和 `credits` 一样缓存在池里而不是每次现问：卡片靠 `/status` 轮询，而签到状态
   * 一天只变一次。探测层拿到它就存进来，卡片与调度器共用同一份读数。
   */
  checkin?: WbCheckinStatus;
  /** 上游明确拒绝过这份凭据后置位；只有重新登录才该清除。 */
  credentialDead?: boolean;
}
/**
 * 账号池：持有发现结果、积分读数与选号策略。
 *
 * 选号**一定**走 `rankAccounts`（status-paths 的纯函数）——五种 `distribution` 的
 * 差别在于「怎么消费这份有序列表」，而不是「谁是下一个」。把分布塞进比较器会让
 * 同一份顺序对五种模式给出五种互不相同的解释，其中四种是错的。
 */
declare class WbAccountPool {
  private readonly options;
  private entries;
  private skipped;
  private scannedAtMs;
  /** 每个区域的轮转游标（`round-robin`）。 */
  private readonly cursors;
  /** 会话 → 账号绑定（`sticky`）。Map 的插入序即 LRU 序。 */
  private readonly affinity;
  /** 用户手动指定的当前账号（按区域），优先级高于任何分布。 */
  private readonly preferred;
  constructor(options?: {
    /** 参与池的账号 id；空数组合义由调用方决定（本类视为「全部参与」）。 */
    enabledIds?: readonly string[];
    orderIds?: readonly string[];
    distribution?: AccountDistribution;
    /**
     * 临期窗口（天），取自用户的 `expiryWarnDays`。
     *
     * 池不读配置（那是 `index.ts` 的职责），只把它**转交**给排序层：`rank()`
     * 会作为 `rankAccounts` 的第 5 个实参传出。缺省时排序层用自己的兜底 3 天。
     */
    expiryWarnDays?: number;
    logger?: {
      warn(...args: unknown[]): void;
      info?(...args: unknown[]): void;
    };
  });
  /** 用一次发现结果替换池内容，保留同一账号的积分读数与死凭据标记。 */
  applyDiscovery(result: WbDiscoveryResult): void;
  /**
   * 施加一次配置。
   *
   * 单独一个方法而不是让调用方重建池：池持有**积分读数**、会话亲和与轮转游标，
   * 换号设置一次就可能被改一次，重建池会把用户刚看到的余额全部清空（卡片忽然
   * 变成「余额未知」），并把 `sticky` 的会话绑定丢掉。
   *
   * 字段为 `undefined` 时保持原值（来自「这次配置里没有这一项」，而不是「清空」）。
   */
  applyConfig(config: {
    enabledIds?: readonly string[] | undefined;
    orderIds?: readonly string[] | undefined;
    distribution?: AccountDistribution | undefined;
    expiryWarnDays?: number | undefined;
  }): void;
  /** 当前的临期窗口（天）。缺省表示「从未配置」，排序层用兜底值。 */
  get expiryWarnDays(): number | undefined;
  /** 扫描时间（ms）；从未扫描时 0。 */
  get lastScannedAtMs(): number;
  /** 被跳过的文件，原样上报。 */
  get skippedFiles(): readonly WbSkippedFile[];
  /** 全部账号（不论是否参与池），按 id 升序。 */
  list(): readonly WbPoolEntry[];
  /** 某区域的账号。 */
  listRegion(region: WbRegion): readonly WbPoolEntry[];
  find(accountId: string): WbPoolEntry | undefined;
  /** 记一次积分读数。到期时间与余额同行——`expiry` 分布靠它排序。 */
  noteCredits(accountId: string, credits: WbCredits | undefined): void;
  /**
   * 记下签到状态。
   *
   * `undefined` 表示「这次没读到」，与 `undefined` 的积分同理：**不要**把它当作
   * 「今天没签到」——那会让卡片把一次网络失败渲染成「待签到」并怂恿用户去点。
   * 所以传 `undefined` 时保留旧读数而不是清除。
   */
  noteCheckin(accountId: string, checkin: WbCheckinStatus | undefined): void;
  /** 上游拒绝过这份凭据。 */
  markCredentialDead(accountId: string): void;
  /** 清掉死凭据标记（重新登录 / 重新扫描后）。 */
  clearCredentialDead(accountId: string): void;
  /** 设置某区域的当前账号（用户显式选择）。 */
  setPreferred(region: WbRegion, accountId: string | undefined): void;
  /** 当前账号（按区域）。 */
  preferredOf(region: WbRegion): string | undefined;
  /** 该账号是否参与池。`enabledIds` 为空 = 全部参与。 */
  isEnabled(accountId: string): boolean;
  /**
   * 一个账号此刻为什么不能服务；能服务时缺省。
   *
   * 这段话会**原样显示在账号卡片上**，所以每一条都要能让用户采取行动（「重新登录」、
   * 「加入池」、「等 X 分钟」），而不是只说「不可用」。
   */
  exclusionReason(entry: WbPoolEntry): string | undefined;
  /**
   * 排序一个区域的成员。`distribution` 的 `expiry` 语义在这里生效。
   *
   * `credits` 理想上由探测层按**用户配置的 `expiryWarnDays`** 聚合过（`probe.ts`
   * 负责），那样 `expiringSoon` 是显式值、`expiryFactsOf` 直接采信。但请求路径上
   * 余额是 `shim.ts` 写的——它拿得到原始包、拿不到聚合结果的历史——所以用户窗口
   * 还有第二条路：作为 `rankAccounts` 的第 5 个实参传下去，让排序层的兜底推算也
   * 按同一个窗口算。两条路都给，任何一条断了都不会静默退回 3 天。
   */
  rank(region: WbRegion, nowMs?: number): readonly WbRankedAccount<WbDiscoveredAccount>[];
  /**
   * 选下一个该服务的账号。
   *
   * 五种分布都**真正分支**（R4：不得只声明不生效），且都建立在同一份
   * {@link rank} 顺序之上：
   *
   * - `priority`：永远队首——单号额度大时「用完一个再换」最省事。
   * - `round-robin`：按游标依次轮过可用成员。
   * - `balanced`：按余额权重抽取，冷清时也不会把第一个号抽干。
   * - `sticky`：一个会话钉一个号；新会话换下一个可用号（保住上游 prompt 缓存）。
   * - `expiry`：队首即「一次性积分包最先到期」的账号（R3）。
   *
   * 用户在卡片上显式选的当前账号（{@link setPreferred}）优先于任何分布——那是
   * 一个明确指令，不是一次采样。
   */
  pick(region: WbRegion, options?: {
    conversationKey?: string;
    nowMs?: number;
    excludeIds?: readonly string[];
  }): WbPickResult<WbDiscoveredAccount>;
  /** 名次行 → 池条目。 */
  entryOf(account: WbDiscoveredAccount): WbPoolEntry;
}
/**
 * 一次目录读取的结果。
 *
 * `source` 让卡片能说清「这 62 个模型是实时读到的，还是静态兜底的」——两者对
 * 倍率的可信度不同：静态 CN 名册整份没有 `credits` 字段，所以那里全都是「未知」。
 */
interface WbCatalogFetch {
  models: readonly WbUpstreamModel[];
  source: 'live' | 'fallback';
  /** 读失败的原因（`source === 'fallback'` 时用于说明）。 */
  error?: string;
}
/**
 * 从一批账号里找一个能读出目录的，逐个尝试。
 *
 * 逐账号而不是只赌队首：池里任一账号的凭据都可能已被上游吊销（401），而读目录
 * 只需要一个健康账号；只赌第一个会让一份死 token 拖垮整个区域的实时目录。
 */
declare function fetchCatalogFromAny(accounts: readonly WbDiscoveredAccount[], read: (account: WbDiscoveredAccount) => Promise<readonly WbUpstreamModel[]>): Promise<WbCatalogFetch>;
/** 供测试与诊断：把一份上游条目列表按 user 选择过滤前的原始形态交出。 */
declare function modelsOfDocument(document: unknown, keepIds?: readonly string[]): WbUpstreamModel[];
//#endregion
//#region src/catalog.d.ts
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
declare const FALLBACK_MODELS_CN: readonly WbModelInfo[];
/**
 * 国际网关静态兜底名册（`www.workbuddy.ai/v3/config` 桌面通道，2026-09-11 抓取）。
 *
 * 这份**带倍率**（上游给了 `credits` 字段），所以国际版的「模型与倍率」列表在
 * 上游不通时也是准的。注意 `deepseek-v4.1-flash` 与 `hy4-preview`/`hy3` 是
 * `x0.00` 的促销免费模型——它们存在是「为什么国际版要读桌面通道」的理由
 * （CLI 通道的名册里没有促销模型）。
 */
declare const FALLBACK_MODELS_GLOBAL: readonly WbModelInfo[];
/** 某区域的静态兜底名册。 */
declare function fallbackModelsFor(region: WbRegion): readonly WbModelInfo[];
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
declare function deriveVisibleModels(catalog: readonly WbModelInfo[], enabled: readonly string[] | undefined): readonly WbModelInfo[];
/**
 * 一个区域的目录。
 *
 * `visible()` 是 adapter 与 shim 唯一该读的东西：它已经把用户选择应用过。
 */
declare class WbCatalog {
  private readonly region;
  /** 最近一次实时名册；从未刷新时缺省。 */
  private live;
  private enabledIds;
  private lastUpdatedAtMs;
  private lastError;
  /** 该区域是否存在本机登录。默认 `true`（宽容方向）：扫描还没跑完时不该清空。 */
  private usable;
  /** 用户是否显式启用了这个区域的 provider。默认 `true`（opt-out）。 */
  private enabled;
  constructor(region: WbRegion);
  /** 当前该暴露给 DSH 的模型列表（已过滤）。 */
  visible(): readonly WbModelInfo[];
  /** 区域的静态兜底名册（诊断用；adapter 不该读它）。 */
  fallback(): readonly WbModelInfo[];
  /** 当前目录里全部模型（未过滤），供设置页画勾选框。 */
  all(): readonly WbModelInfo[];
  /** `'live'` 表示当前列表来自上游，`'fallback'` 表示还在用静态兜底。 */
  get source(): 'live' | 'fallback';
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
  get lastFetchedAtMs(): number | undefined;
  /** 历史别名，等价于 {@link lastFetchedAtMs}（保留给既有读取方）。 */
  get lastUpdatedAt(): number | undefined;
  get lastFetchError(): string | undefined;
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
  isStale(nowMs: number, ttlMs: number): boolean;
  /** 距上次成功抓取的毫秒数；从未抓取过则为 `undefined`。供界面对人显示。 */
  ageMs(nowMs: number): number | undefined;
  isUsable(): boolean;
  isEnabled(): boolean;
  /** 记一次实时名册。空列表被拒——那会让所有模型从选择器里消失。 */
  applyFetch(models: readonly WbModelInfo[], atMs?: number): boolean;
  /** 记一次读目录失败；保留现有列表，只留原因。 */
  noteFetchFailure(message: string): void;
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
  applyBusy(levels: ReadonlyMap<string, WbBusyLevel>): boolean;
  /** 用户改选择。空数组 = 全部显示。 */
  setEnabledIds(ids: readonly string[]): void;
  /** 该区域是否有本机登录。返回是否变化，调用方据此决定要不要刷新快照。 */
  setUsable(usable: boolean): boolean;
  /** 用户显式开关该区域的 provider。返回是否变化。 */
  setEnabled(enabled: boolean): boolean;
  /** 按 id 找一个模型（在**未过滤**的全量里找，供请求路径校验模型是否存在）。 */
  find(modelId: string): WbModelInfo | undefined;
  /**
   * 倍率的界面文案。
   *
   * `undefined`（未知）与 `0`（免费）必须给出**不同**的文字。这正是 R1-f「显示所有
   * 模型及模型使用倍率」要回答的问题：用户需要知道哪些是不要钱的、哪些是 1 倍、
   * 哪些是本插件也不知道的。
   */
  multiplierLabelOf(model: WbModelInfo): string;
}
/** 两个区域的目录一起持有，因为 adapter 与路由都要按区域取。 */
declare class WbCatalogs {
  private readonly byRegion;
  constructor();
  of(region: WbRegion): WbCatalog;
  /** 把用户选择应用到对应区域。**空数组 = 全部显示**，两线口径一致。 */
  applySelection(region: WbRegion, enabledIds: readonly string[] | undefined): void;
}
//#endregion
//#region src/scheduler.d.ts
/** 上游按北京自然日判幂等，日界必须与它一致。 */
declare const AUTOMATION_TIME_ZONE = "Asia/Shanghai";
/** tick 间隔。60 秒足够精细（整点判定的最小粒度就是一小时），又不至于空转。 */
declare const AUTOMATION_TICK_MS = 60000;
/** 账号之间的串行间隔。上游对同一台机器有速率限制，密集请求会有一半拿到 429。 */
declare const AUTOMATION_ACCOUNT_DELAY_MS = 800;
/** 默认签到时段（北京时间整点）。上午 9 点：用户已开机、上游活动已刷新。 */
declare const DEFAULT_CHECKIN_HOURS: readonly number[];
interface SchedulerLogger {
  info?(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}
/** 单个账号在一次运行里的所得。 */
interface AutomationAccountGain {
  /** 本次入账积分。 */
  credit: number;
  /** 其中来自签到的部分。 */
  checkinCredit: number;
  /** 其中来自权益领取的部分。 */
  benefitCredit?: number;
  /** 该账号今天已经领过了（不是失败）。 */
  alreadyDone?: boolean;
}
/** 一个 job 的调度与结果状态。 */
interface AutomationJobState {
  /** 今天已消费的调度时段（`YYYY-MM-DDTHH`，北京时）。 */
  firedSlots: readonly string[];
  /** 最近一次运行开始所在的小时时段（仅节流用）。 */
  lastFiredHour?: string;
  /** 最近一次运行的日期键。 */
  lastRunDate?: string;
  /** 最近一次运行所在时段。 */
  lastRunSlot?: string;
  /** 最近一次运行完成时刻（ms）。 */
  lastRunAtMs?: number;
  ok: number;
  failed: number;
  claimed: number;
  credit: number;
  message?: string;
  detail?: readonly string[];
}
/** 账本：跨重启保留「今天跑过没有」，否则每次重启都会重签一遍。 */
interface AutomationLedger {
  lastRunDate?: string;
  lastRunSlot?: string;
  firedSlots?: readonly string[];
}
/** 调度器状态快照（状态路由与卡片用）。 */
interface AutomationStatus {
  enabled: boolean;
  running: boolean;
  checkinHours: readonly number[];
  claimBenefits: boolean;
  jobs: {
    checkin: AutomationJobState;
  };
  earningsToday: Readonly<Record<string, AutomationAccountGain>>;
  runInProgress: boolean;
  lastPassAtMs?: number;
  lastPass?: Readonly<Record<string, AutomationAccountGain>>;
}
interface SchedulerOptions {
  pool: WbAccountPool;
  client: WbUpstreamClient;
  /** 配置；`enabled: false` 时循环保持惰性（**绝不**默认开启写操作）。 */
  config?: WbAutomationConfig & {
    accountDelayMs?: number;
  };
  logger?: SchedulerLogger;
  /** 时钟注入（测试用假时钟）。 */
  now?: () => Date;
  /** 构造时恢复当日账本。 */
  loadLedger?: () => AutomationLedger | undefined;
  /** 账本变化时的持久化钩子。 */
  saveLedger?: (ledger: AutomationLedger) => void | Promise<void>;
}
/**
 * 自动签到调度器。
 *
 * `start()` 只负责装定时器；真正的写操作只在 `tick` 里、且 `enabled === true` 时
 * 发生。`dispose()` 必须被调用（宿主入口在 `ctx.effect` 里成对绑定），否则宿主
 * 卸载后定时器仍在跑，会对着已 dispose 的上下文发请求。
 */
declare class WbScheduler {
  private readonly pool;
  private readonly client;
  private readonly logger;
  private readonly now;
  private readonly saveLedger;
  private enabled;
  private claimBenefits;
  private checkinHours;
  private delayMs;
  private timer;
  /**
   * 「已被卸载」标记，**初值 false**。
   *
   * 它挡的是 `dispose()` 之后的运行，不是 `start()` 之前的运行：卡片上的「立即
   * 签到」是一次手动调用，与定时器无关，若初值为 `true` 就会在账号循环的第一行
   * 直接 break —— 按钮点下去静默无反应，而日志里一条错都没有。
   * 定时器本身由 `timer === undefined` 兜住，不需要这个标志。
   */
  private stopped;
  private busy;
  private readonly states;
  /** 当日账本：账号 → 所得。跨日清空。 */
  private earnings;
  private earningsDay;
  /** 最近一次运行的整体所得（卡片显示「刚发生了什么」）。 */
  private lastPass;
  constructor(options: SchedulerOptions);
  /**
   * 施加配置。
   *
   * `enabled` 的变化**立即生效**：关掉时不需要等下一个 tick 停止写操作，因为 tick
   * 每次都重读这个字段。定时器本身继续跑（空转极轻），这样重新打开无需重启宿主。
   */
  applyConfig(config: (WbAutomationConfig & {
    accountDelayMs?: number;
  }) | undefined): void;
  /** 当前是否真的会发起写操作。 */
  isEnabled(): boolean;
  /** 装定时器。重复调用是空操作。 */
  start(): void;
  /** 停定时器并阻止后续运行。可重复调用。 */
  dispose(): void;
  /** 状态快照（不含 token 材料）。 */
  status(): AutomationStatus;
  /** 恢复一个持久化的账本（宿主启动时读回）。 */
  applyLedger(ledger: AutomationLedger | undefined): void;
  /** 当前账本（持久化用）。 */
  ledger(): AutomationLedger;
  /**
   * 手动运行一次签到（卡片上的「立即签到」与状态路由的 POST）。
   *
   * `force` 缺省 `true`：用户按下按钮就是「我知道，还是跑」。**不消费调度时段**
   * ——10:35 手动跑一次不能取消 21:00 那个时段。
   */
  runCheckinNow(options?: {
    region?: WbRegion;
    force?: boolean;
  }): Promise<Readonly<Record<string, AutomationAccountGain>>>;
  /**
   * 手动给**一个**账号签到（账号卡片上的按钮）。
   *
   * 与 {@link runCheckinNow} 分开是因为两者的失败语义不同：全量运行里「一个账号
   * 失败」要被吞掉并计入 `failed`，而单账号运行里那个失败必须原样抛给调用方——
   * 用户点的是这一个账号的按钮，吞掉错误等于按钮没反应。
   *
   * 返回 `undefined` 表示没有可做的事（活动未开启 / 账号不存在），而不是失败。
   */
  checkinOne(accountId: string): Promise<{
    gain: AutomationAccountGain | undefined;
    detail: readonly string[];
  }>;
  /**
   * 手动领取**一个**账号的某一类权益。
   *
   * 先复核该权益此刻是否可领（`active && !claimed`）：上游对已领取的赠礼仍报
   * `active: true`，不复核就会在用户连点两次时发出第二个必然被拒的写请求，而
   * 那个拒绝看起来像「领取失败」。
   *
   * 返回 `false` 表示「现在没什么可领」，`true` 表示刚领成功。真正的失败抛给调用方。
   */
  claimOne(accountId: string, kind: WbBenefitKind): Promise<boolean>;
  /**
   * 循环体：到点就跑。
   *
   * 状态筛选（enabled / stopped / busy）与异常隔离都在这里，保证循环本身绝不被
   * 一次失败拖死。
   */
  private tick;
  /** 今天已消费的时段集合（读取时顺手丢掉更早的日期）。 */
  private firedSlotsOf;
  /** 记录一个已消费的调度时段。 */
  private consumeSlot;
  /**
   * 此刻该跑的时段，没有则 undefined。
   *
   * **最早**的未消费候选胜出，这样多时段配置才完整。用「已经过去」而不是「正好
   * 等于」判定：DSH 关闭期间错过的时段能自愈（09:00 的签到在 10:00 启动时补上），
   * 这正是笔记本合盖场景需要的。
   */
  private dueSlot;
  /** 跨日重置账本与 `firedSlots`。 */
  private rollLedger;
  private persist;
  /**
   * 参与自动化的账号。
   *
   * 取池里**可服务**的成员（`exclusionReason` 为空）：死凭据的账号签到也一定失败，
   * 对它们发写请求只是把一次 401 变成一条日志噪声。**不跳过冷却账号** —— 冷却记在
   * shim 里、按 (账号, 模型) 计，是对话路由的闸门；签到走独立的 billing 端点，不该
   * 被对话侧限流连坐。
   */
  private eligibleAccounts;
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
  private runCheckin;
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
  private runOne;
  /**
   * 领取该账号可领的权益。
   *
   * `claimable = active && !claimed`：上游对已领取的赠礼仍会报 `active: true`
   * （campaign 未结束），所以只看 `active` 会每次运行都重复领一次、每次都被拒。
   * 两个标志都必须读。
   *
   * 单个权益失败不打断其他：活动端点各自独立，一个回 5xx 不该让另一个消失。
   */
  private claimBenefitsOf;
  /** 把一次所得累加进当日账本。0 所得的记录也要落（它说明「今天跑过了」）。 */
  private recordEarnings;
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
  private resetRoundCounters;
  /** 一行总结。 */
  private summarise;
}
//#endregion
//#region src/version.d.ts
/**
 * 包版本号。
 *
 * 值由构建期 define 注入（见 `tsdown.config.ts` 的 `VERSION_DEFINE`）：
 * 发布包里只带 `lib/`，没有可解析的 `package.json`，所以不能运行时读。
 * 做法沿用 `plugins/dsh-connect-workbuddy/src/version.ts`。
 *
 * @module dsh-connect-workbuddy-models/version
 */
/** 本份构建产出的 npm 包版本；未注入时回落到 `0.0.0-dev`。 */
declare const WB_MODELS_VERSION: string;
//#endregion
//#region src/probe.d.ts
/** 一次聚合的完整结果，附带给界面用的诊断字段。 */
interface WbProbeResult {
  credits: WbCredits;
  /**
   * 窗口内到期的包名，供「临期提醒」直接列出是什么在流失。
   *
   * 只给总量的话，用户看到「3 天内过期 120 积分」却不知道是哪个包、能不能先花掉。
   */
  expiringPackages: readonly {
    packageName: string;
    remain: number;
    expiresAtMs: number;
  }[];
  /**
   * 距离最近一次到期的天数（向上取整）；无到期信息时缺省。
   *
   * 界面用它决定要不要标红，而复用 `nearestExpiryMs` 天数是错的——两者一个是
   * 时刻一个是「还剩几天」，混用会在格式化时各自算一遍并给出不同答案。
   */
  daysToNearestExpiry?: number;
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
declare function aggregateCredits(raw: WbRawCredits, options?: {
  warnDays?: number;
  nowMs?: number;
}): WbProbeResult;
/**
 * 一个账号的积分读数在界面上的稳定形态。
 *
 * `credits` 缺省与 `total: 0` **必须区分**：前者是「还没读到 / 读失败」，后者是
 * 「读到了，确实是 0」。把两者混成一个数字会让读失败的账号看起来像刚用光，
 * 用户会去找一个不存在的「为什么我积分没了」。
 */
interface WbAccountProbe {
  accountId: string;
  credits?: WbCredits;
  probe?: WbProbeResult;
  checkin?: WbCheckinStatus;
  /** 读失败的原因；成功时缺省。 */
  error?: string;
  /** 读到时刻（ms）。 */
  readAtMs: number;
}
/**
 * 逐账号读取积分与签到，单个账号失败不影响其他账号。
 *
 * 串行而不是 `Promise.all`：上游对同一台机器有速率限制，4 个账号同时打
 * `get-user-resource` 会有一部分拿到 429，而那看起来像「这个号没积分」。
 * 串行多花的几秒换一个可信的读数，值得。
 */
declare function probeAccounts<TAccount extends {
  id: string;
  credential: {
    accessToken: string;
  };
}>(accounts: readonly TAccount[], read: (account: TAccount) => Promise<{
  credits?: WbRawCredits;
  checkin?: WbUpstreamCheckinLike;
}>, options?: {
  warnDays?: number;
  nowMs?: number;
  /** 账号之间的延迟（ms）；自动签到用 800，界面刷新用 150。 */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<readonly WbAccountProbe[]>;
/** 上游签到投影的最小形状（与 `upstream.ts` 的 `WbUpstreamCheckin` 同构）。 */
interface WbUpstreamCheckinLike {
  active: boolean;
  todayCheckedIn: boolean;
  streakDays: number;
  dailyCredit: number;
  todayCredit: number;
  isStreakDay: boolean;
  nextStreakDay: number;
  streakBonusDays: number;
  streakBonusCredit: number;
  claimButtonText?: string;
}
/** 上游签到 → 共享投影。两者字段同名，这里只做一次显式拷贝，避免把 `undefined`
 * 与缺省混在一起（`exactOptionalPropertyTypes` 下两者不等价）。 */
declare function toCheckinStatus(raw: WbUpstreamCheckinLike): WbCheckinStatus;
/**
 * 池子里「剩余总积分」的合计（R2 的读数）。
 *
 * 只累加**读到了读数**的账号：把读失败的账号按 0 计入，会让总数在下一次刷新时
 * 突然跳起来，用户会以为积分涨了。同时返回 `unread` 计数，界面才能说明
 * 「合计 2,196（还有 1 个账号没读到）」。
 */
declare function totalCreditsOf(readings: readonly WbAccountProbe[]): {
  total: number;
  unread: number;
};
/**
 * 供界面判断「这个账号是否进入了临期窗口」。
 *
 * 与 {@link aggregateCredits} 用同一份 `WbCredits`，不重算：两处各算一遍窗口，
 * 迟早会出现「卡片标红但排序没换号」或反过来。
 */
declare function isExpiring(credits: WbCredits | undefined): boolean;
//#endregion
//#region src/shim.d.ts
/** 池与 shim 共用的最小日志面。 */
interface WbShimLogger {
  info?(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
/** 一个已监听的回环端点。 */
interface WbShim {
  ready: Promise<void>;
  /** 例如 `http://127.0.0.1:39271`；ready 之后有效。 */
  baseUrl(): string;
  /** 进程内 secret（adapter 把它当 OpenAI apiKey 用）。 */
  token(): string;
  close(): Promise<void>;
}
interface WbShimOptions {
  pool: WbAccountPool;
  client: WbUpstreamClient;
  catalog: WbCatalog;
  logger?: WbShimLogger;
  /**
   * 把本 shim 限制在一个网关上。两个 shim 并排运行 —— 每区域一个 —— 每个都只能
   * 取属于自己区域的账号。
   *
   * 为什么必须分开而不是「按 model id 猜区域」：`glm-5.3` / `hy3` / `kimi-k2.6`
   * 这些 id 在两个区域的名册里**都存在**，按名字猜会把一个国际账号的请求发到国内
   * 网关（或反过来），被 openresty 以 HTML 401 拒绝，看起来像「凭据坏了」。
   * 区域由 provider 决定，provider 由用户选的那个模型决定，全程不靠猜。
   */
  region: WbRegion;
  /** 每请求最多尝试几个账号。 */
  maxAttempts?: number;
  /**
   * 临期窗口（天），取自用户的 `expiryWarnDays`。
   *
   * 用 getter 而不是数字：用户的设置在插件运行期随时可改（设置页每改一次就广播
   * `loader/volatile-update`），而 shim 在 `apply()` 里只构造一次。传快照数字会让
   * 「改了设置但没重启」的会话一直用旧窗口聚合余额，卡片上的临期金额与账号卡片
   * 的排序都会与设置页显示的天数不符。
   *
   * 缺省（或 getter 返回 `undefined`）时由 `aggregateCredits` 落回兜底 3 天。
   */
  expiryWarnDays?: () => number | undefined;
}
declare function createWbShim(options: WbShimOptions): WbShim;
/**
 * 供测试与诊断：把一个上游失败分类成「该不该换号」。
 *
 * `false` 表示换账号也不会成功（请求形状问题），`true` 表示值得换下一个。
 * 单独导出而不是内联在循环里，因为它是本文件唯一一条「何时停止重试」的规则，
 * 而它出错的代价是 8 倍的无效上游请求或一次本该成功的对话被放弃。
 */
declare function worthRetrying(kind: WbUpstreamErrorKind): boolean;
/** 供测试：把一个错误对象归类。`WbCredentialRejectedError` 一律是凭据问题。 */
declare function classifyThrown(error: unknown): WbUpstreamErrorKind;
//#endregion
//#region src/adapter.d.ts
interface WbAdapterOptions {
  shim: WbShim;
  catalog: WbCatalog;
  region: WbRegion;
  /** 插件上下文；pi-ai adapter 从它取 `attachments`/`fs`。 */
  ctx: Context;
  providerId?: string;
  displayName?: string;
}
/** {@link createWbAdapter} 交回的东西。 */
interface WbAdapter {
  providerId: string;
  displayName: string;
  adapter: PiAiAdapter;
  /** 从当前目录重建 pi-ai 模型列表。 */
  buildModels: () => Model<Api>[];
  /** 重建 adapter 的 provider 快照；目录更新后调用。 */
  invalidate: () => void;
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
declare function createWbAdapter(options: WbAdapterOptions): WbAdapter;
/**
 * 供 model-resolve 路径用的「这次请求该用哪个账号」的解释。
 *
 * adapter 本身**不做选号**：选号发生在 shim 收到请求时（那时才知道 region、会话键与
 * 当前池状态）。这个函数只把「为什么下一次会切到某个账号」讲清楚，供设置页与
 * 诊断路由显示，避免两处各写一遍选号理由。
 */
declare function describeSelection(region: WbRegion, chosen: {
  label: string;
  id: string;
} | undefined, reason: 'preferred' | 'distribution' | 'none'): string;
//#endregion
//#region src/web-status.d.ts
/** 浏览器半区收到的单账号投影（**不含凭据**）。 */
interface WbWebAccount {
  id: string;
  label: string;
  region: WbRegion;
  selected: boolean;
  /** 该账号此刻为什么不能服务；能服务时缺省。 */
  excludedBy?: string;
  /** 余额；读不到时缺省（**不是** 0）。 */
  total?: number;
  expiringSoon?: number;
  nearestExpiryMs?: number;
  /** 距离最近到期的天数（向上取整）。 */
  daysToExpiry?: number;
  todayCheckedIn?: boolean;
  streakDays?: number;
  /** 名次（1 起）；供卡片解释「为什么这个账号排在后面」。 */
  rank?: number;
}
/**
 * `/status` 的应答：共享投影 + 浏览器真正要用的额外字段。
 *
 * 用 `Omit` 换掉 `accounts`：共享投影里 `accounts` 是 `WbAccountReading[]`（给
 * 设置页与客户端共用），而卡片还要人话标签、名次、临期天数与签到状态。直接
 * `extends` 再改字段类型会变成不兼容覆写，所以显式换掉那一项。
 */
interface WbWebStatus extends Omit<WbStatusSnapshot, 'accounts'> {
  /** 池里「剩余总积分」；`unread` 是没读到读数的账号数。 */
  creditsReadout: {
    total: number;
    unread: number;
  };
  accounts: readonly (WbAccountReading & WbWebAccount)[];
  /** 每区域目录的来源与失败原因，让卡片能说清倍率可不可信。 */
  catalogs: Readonly<Record<WbRegion, {
    source: 'live' | 'fallback';
    modelCount: number;
    lastUpdatedAtMs?: number;
    lastError?: string;
    usable: boolean;
    enabled: boolean;
  }>>;
  automation: AutomationStatus;
}
/** 卡片点「立即签到」后的应答。 */
interface WbWebCheckin {
  ok: boolean;
  /** 本次真正入账的积分。 */
  credit: number;
  /**
   * 与 `credit` 恒等。卡片读的是这个字段名（`WbModelsCard.tsx:467` 的
   * `payload['grantedCredit']`）；改名会让签到成功后提示条永远显示「已签到」而
   * 不显示本次获得多少积分。两个名字都留着，读哪个都不会拿到 undefined。
   */
  grantedCredit: number;
  alreadyDone: boolean;
  detail: readonly string[];
  /** 账号在池里的读数（签到后余额已变，顺手回传）。 */
  total?: number;
  /**
   * 只用于「给全部账号签到」这一条：请求已受理但仍在后台跑。
   *
   * 一整轮 4 个账号 × 800ms 间隔要几十秒，把卡片请求挂那么久会让浏览器或宿主
   * web server 先超时；所以先回 200 再在后台推进，卡片靠轮询 `/status` 看结果。
   */
  running?: boolean;
  /** 与 `running` 同出：自动签到开关当时是开着的吗（关着也不影响手动运行）。 */
  started?: boolean;
}
/** 卡片点「领取」后的应答。 */
interface WbWebBenefitClaim {
  ok: boolean;
  /** `false` 表示「现在没什么可领」，不是失败。 */
  claimed: boolean;
}
/**
 * 一路路由的依赖。全部由 `index.ts` 注入，本文件不持有任何生命周期。
 *
 * 用回调（`readConfig` / `writeConfig` / `rescan`）而不是直接持有池与 settings：
 * 路由层要能在测试里被单独装配，而 settings 写入的命名空间判定在 `index.ts` 里
 * （那条判定本身依赖运行时形态）。
 */
interface WbStatusRouteOptions {
  pool: WbAccountPool;
  catalogs: WbCatalogs;
  client: WbUpstreamClient;
  scheduler: WbScheduler;
  logger?: {
    warn(...args: unknown[]): void;
    info?(...args: unknown[]): void;
  };
  /** 当前生效的配置（深剥过 volatile）。 */
  readConfig: () => WbModelsConfig;
  /** 落一次配置补丁。抛错即「没保存」。 */
  writeConfig: (patch: Record<string, unknown>) => Promise<void>;
  /** 重扫本机凭据。 */
  rescan: () => Promise<void>;
  /**
   * 读一批账号的积分（会打上游）。
   *
   * 状态路由里**不**做这件事：一次 `/status` 变成 N 次上游请求会让卡片首帧
   * 挂十几秒，而用户打开设置页时最想先看到的是「有几个账号」。
   */
  probe: (accounts: readonly WbDiscoveredAccount[], warnDays: number) => Promise<readonly WbAccountProbe[]>;
  /** 拉某区域的实时模型目录。 */
  refreshModels: (region: WbRegion) => Promise<void>;
  /**
   * 拉某区域的实时拥挤度。
   *
   * 可选：老调用方（测试夹具、早期宿主）不必实现它，缺了只是不刷新拥挤度。
   * 与 {@link refreshModels} 分开是契约 `t31` 的要求——这是两条独立的上游链路，
   * 拥挤度是分钟级事实、目录是小时级事实，合成一条 TTL 会逼出两种坏结果之一。
   */
  refreshBusy?: (region: WbRegion) => Promise<void>;
  /** 本区域拥挤度最近一次成功抓取的时刻；没抓过返回 `undefined`。 */
  busyFetchedAtMs?: (region: WbRegion) => number | undefined;
  /**
   * 单飞闸门：上一次刷新的 Promise，按 `目录` / `拥挤度` 两条链路分开记。
   *
   * 「单飞」在这里不是性能优化，而是**正确性要求**：设置页打开时会每几秒轮询一次
   * `/status`，两个浏览器标签页就是两条并发流。没有闸门时每次过期判断都各发一次
   * 上游请求，用户开着设置页去开会，回来时上游已经在按 429 限流他——而这会连带
   * 让真正要用的模型调用失败。
   *
   * 放在路由这一层是因为它天然是单例（`registerWbStatusRoutes` 只调一次），
   * 不需要再往 catalog 里塞一个可变字段。
   */
  inFlight?: {
    models: Map<WbRegion, Promise<void>>;
    busy: Map<WbRegion, Promise<void>>;
  };
  /** 允许关掉自动刷新（测试用）。缺省为开启。 */
  autoRefresh?: boolean;
  /**
   * 测试用：单飞闸门与失败计数的容器。
   *
   * 必须由调用方持有，而不是在 {@link refreshForTest} 里用默认参数创建：默认参数
   * 每次调用都会重新求值，连续多次调用就会各拿一份空 Map，于是「单飞」在测试里
   * 永远不成立；而生产代码里 `kick` 用的是闭包外层同一份 Map。容器生命周期不同，
   * 测出来的就不是生产行为。生产路径不传这个字段（路由内部自己建）。
   */
  refreshState?: {
    inFlight: {
      models: Map<WbRegion, Promise<void>>;
      busy: Map<WbRegion, Promise<void>>;
    };
    failures: Map<string, number>;
  };
  /**
   * 连续刷新失败几次之后放弃自动刷新，直到有一次手动成功。
   *
   * 缺省 `3`。理由：上游持续故障时（凭据过期、网关宕机），每次 `/status` 都触发一次
   * 必然失败的请求，等于让设置页变成一个不断打上游的循环。放弃之后界面照常显示
   * 「数据已过期」与错误原因，但不再自己重试——这是唯一不会把一次故障放大成
   * 流量风暴的做法。手动点「刷新模型」会清零计数。
   */
  maxAutoFailures?: number;
  /** 选号结果，供「为什么排在后面」显示。 */
  pickOf: (region: WbRegion, accountId?: string) => WbPickResult<WbDiscoveredAccount>;
}
/** 把 token 类内容抹掉再送回浏览器。 */
declare function safeMessage(error: unknown): string;
/**
 * 在 `webServer` 可用的 context 上挂载全部路由。
 *
 * 调用方用 `ctx.inject(['webServer'], ...)`，让桌面端启动顺序无法让这次注册凭空
 * 消失；直接 `ctx.webServer.register` 在没有该服务时会抛，把整个插件的 apply 弄崩
 * （连 provider 都注册不上）。
 */
declare function registerWbStatusRoutes(ctx: Context, deps: WbStatusRouteOptions): void;
/**
 * 供 `index.ts` 生成 `pickOf`：把一个区域的名次表交出来。
 *
 * 单独导出而不是内联，因为「为什么这个账号排在后面」是本插件给用户的核心解释
 * 之一（R4 让用户选的分布必须可见），而它需要一个可测的纯函数边界。
 */
declare function rankReasonsOf(pool: WbAccountPool, region: WbRegion, nowMs?: number): readonly {
  accountId: string;
  rank: number;
  score: number;
  atRisk: boolean;
  expiringAmount: number;
  nearestExpiryMs?: number;
  usable: boolean;
  reason?: string;
}[];
//#endregion
//#region src/account-store.d.ts
/** 账本的绝对路径。 */
declare function ledgerPath(pluginId: string): string;
/**
 * 读回账本。
 *
 * 读失败一律返回 `undefined`：账本只回答「今天是不是已经签过」，丢了最多多签一次
 * （上游按北京自然日幂等，多签是无害的空操作），而**读失败让插件起不来**是不可
 * 接受的。JSON 结构不对也一样按空账本处理——手改坏的文件不该变成启动故障。
 */
declare function loadLedger(pluginId: string): Promise<AutomationLedger | undefined>;
/**
 * 保存账本。
 *
 * 写失败只记一条 warn：账本是「省一次空操作」的优化，绝不能因为磁盘满或权限问题
 * 打断了正在进行中的签到循环。
 */
declare function saveLedger(pluginId: string, ledger: AutomationLedger, logger?: {
  warn(...args: unknown[]): void;
}): Promise<void>;
//#endregion
//#region src/index.d.ts
/** 依赖注入：LLM seam（注册 provider/adapter）与 settings（挂卡片）。 */
declare const inject: string[];
/**
 * 插件配置 schema。字段形状与卡片保存的文档一一对应。
 *
 * 末尾的 `as unknown as z<WbModelsConfig>` 是有意的：`WbModelsConfig` 里几个数组
 * 是 `readonly string[]`（配置一旦被读出来就不该被就地改写），而 schemastery 的
 * `.default([])` 推出的是可变数组——直接标注会报「readonly 不能赋给可变」。同时
 * 又不能省掉这层标注：不标注时 tsdown 的 dts 生成器会因推导类型引用了 peer 依赖
 * 内部路径而报 TS2742（"cannot be named without a reference to ..."），声明文件
 * 生成失败、整个 build 挂掉。用一次显式断言同时满足两边；断言是纯类型层的，运行时
 * 拿到的还是那个 zod 对象。
 */
declare const Config: z<WbModelsConfig>;
/** 装配期需要跨函数共享的可变句柄。 */
interface WbCore {
  client: WbUpstreamClient;
  pool: WbAccountPool;
  catalogs: WbCatalogs;
  scheduler: WbScheduler;
}
/**
 * 构造无生命周期的核心对象。
 *
 * 与 `apply` 分开是为了让测试能 `createCore()` 拿到池/目录/调度器，而不必伪造一个
 * 完整的 cordis context。这里**不**装定时器、不绑端口、不读配置。
 */
declare function createWbCore(options?: {
  logger?: {
    info?(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  /** 账本持久化钩子：调度器每次产出所得后调它。缺省时账本只活在内存里。 */
  saveLedger?: (ledger: AutomationLedger) => void | Promise<void>;
}): WbCore;
declare function apply(ctx: Context, config?: WbModelsConfig): void;
/** cordis 插件显示名（诊断与日志用）。 */
declare const name = "dsh-connect-workbuddy-models";
//#endregion
export { ACCOUNT_DISTRIBUTIONS, AUTOMATION_ACCOUNT_DELAY_MS, AUTOMATION_TICK_MS, AUTOMATION_TIME_ZONE, type AccountDistribution, type AutomationLedger, type AutomationStatus, Config, DEFAULT_ACCOUNT_DISTRIBUTION, DEFAULT_CHECKIN_HOURS, DEFAULT_EXPIRY_WARN_DAYS, EXPIRY_WARN_DAYS_MAX, EXPIRY_WARN_DAYS_MIN, FALLBACK_MODELS_CN, FALLBACK_MODELS_GLOBAL, PLUGIN_ID, ROUTE_PREFIX, type SchedulerOptions, WB_ACCOUNTS_REFRESH_PATH, WB_ACCOUNTS_SELECT_PATH, WB_ACCOUNT_CREDITS_PATH, WB_ACCOUNT_ID_PARAM, WB_AUTOMATION_PATH, WB_BENEFIT_CLAIM_PATH, WB_CHECKIN_PATH, WB_KIND_PARAM, WB_MODELS_LOCALE_NS, WB_MODELS_REFRESH_PATH, WB_MODELS_SAVE_PATH, WB_MODELS_SETTINGS_NS, WB_MODELS_SETTINGS_ORDER, WB_MODELS_VERSION, WB_PROVIDERS, WB_REGIONS, WB_REGION_PARAM, WB_STATUS_PATH, WORKBUDDY_AUTH_FILE_ENV, WORKBUDDY_LIVE_FILENAME, type WbAccount, WbAccountPool, type WbAccountProbe, type WbAccountReading, type WbAdapter, type WbAdapterOptions, type WbAutomationConfig, type WbBenefit, type WbBenefitKind, WbCatalog, type WbCatalogFetch, WbCatalogs, type WbChatResult as WbChatOutcome, type WbChatResult, type WbCheckinClaim, type WbCheckinStatus, type WbCredential, WbCredentialRejectedError, type WbCreditPackage as WbCreditPackageInfo, type WbCredits, type WbDiscoveredAccount, type WbDiscoveryResult, type WbModelInfo, type WbModelsConfig, type WbPickResult, type WbPoolEntry, type WbProbeResult, type WbRawCredits, type WbRegion, WbScheduler, type WbShim, type WbShimOptions, type WbSkippedFile, type WbStatusRouteOptions, type WbStatusSnapshot, WbUpstreamClient, type WbUpstreamErrorKind, type WbUpstreamModel, type WbWebAccount, type WbWebBenefitClaim, type WbWebCheckin, type WbWebStatus, aggregateCredits, apply, benefitKindOf, candidateAuthDirs, classifyThrown, classifyUpstreamError, createWbAdapter, createWbCore, createWbShim, defaultDesktopAuthDirs, deriveVisibleModels, describeSelection, discoverAccounts, distributionOf, fallbackModelsFor, fetchCatalogFromAny, inject, isCredentialRejectedError, isExpiring, ledgerPath, loadLedger, modelsOfDocument, name, parseCreditMultiplier, parseUpstreamModel, pickRankedAccount, probeAccounts, rankAccounts, rankReasonsOf, regionOf, registerWbStatusRoutes, safeMessage, saveLedger, selectCliModels, toCheckinStatus, totalCreditsOf, unwrapVolatile, unwrapVolatileDeep, wbProviderOf, wbRegionOfProvider, worthRetrying };