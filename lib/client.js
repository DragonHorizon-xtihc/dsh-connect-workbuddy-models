window.__ModuleLoader__.load({
	id: "dsh-connect-workbuddy-models",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react_dom = require("react-dom");
		//#region src/status-paths.ts
		/** 插件 id。与 `package.json` 的 `name`、`cordis.patch.yml` 的 `name` 必须一致。 */
		const PLUGIN_ID = "dsh-connect-workbuddy-models";
		/** 设置命名空间（`installSection` / `configure` 的 ns）。 */
		const WB_MODELS_SETTINGS_NS = "wbmodels";
		/** 浏览器半区的 locale 命名空间。 */
		const WB_MODELS_LOCALE_NS = "settings.wbmodels";
		/** 本插件所有 web 路由的共同前缀。 */
		const ROUTE_PREFIX = "/plugins/dsh-connect-workbuddy-models";
		/** GET：汇总状态（账号 / 积分 / 到期 / 签到 / 模型 / 配置）。 */
		const WB_STATUS_PATH = `${ROUTE_PREFIX}/status`;
		/** POST：重新扫描本机登录账号。 */
		const WB_ACCOUNTS_REFRESH_PATH = `${ROUTE_PREFIX}/accounts/refresh`;
		/** GET `?accountId=`：单账号积分明细。 */
		const WB_ACCOUNT_CREDITS_PATH = `${ROUTE_PREFIX}/account/credits`;
		/** POST `?accountId=`（可省 = 全部）：手动签到。 */
		const WB_CHECKIN_PATH = `${ROUTE_PREFIX}/checkin`;
		/** POST `?accountId=&kind=`：领取补偿 / 赠礼积分。 */
		const WB_BENEFIT_CLAIM_PATH = `${ROUTE_PREFIX}/benefit/claim`;
		/** POST：拉取实时模型目录与倍率。 */
		const WB_MODELS_REFRESH_PATH = `${ROUTE_PREFIX}/models/refresh`;
		/** POST `?accountId=&region=`：切换当前使用账号。 */
		const WB_ACCOUNTS_SELECT_PATH = `${ROUTE_PREFIX}/accounts/select`;
		/** 选择账号的查询参数名。 */
		const WB_ACCOUNT_ID_PARAM = "accountId";
		/** 选择权益种类的查询参数名。 */
		const WB_KIND_PARAM = "kind";
		/** 选择区域（国内 / 国际）的查询参数名。 */
		const WB_REGION_PARAM = "region";
		/** 全部区域，按界面顺序。 */
		const WB_REGIONS = ["cn", "global"];
		/**
		* 每个区域注册的 provider id。
		*
		* **必须是 `workbuddy-models`，不能是 `workbuddy`**：`dsh-connect-workbuddy`
		* （4.15.1）已经占住了 `workbuddy` / `workbuddy-global`
		* （见 `plugins/dsh-connect-workbuddy/src/adapter.ts:46,49`）。同一个 provider id
		* 注册两次，cordis 会抛 `service "llm" 的 provider 已注册` 类错误，后加载的那份
		* 插件整份注册失败——而用户看到的是「模型列表少了一半」，不是冲突提示。
		*/
		const WB_PROVIDERS = {
			cn: "workbuddy-models",
			global: "workbuddy-models-global"
		};
		/**
		* provider id → 区域。浏览器半区靠它把宿主 `modelSelection` 投影里的 provider
		* 翻译成「该读哪个区域的读数」。
		*/
		const WB_PROVIDER_REGIONS = {
			[WB_PROVIDERS.cn]: "cn",
			[WB_PROVIDERS.global]: "global"
		};
		/** 从 provider id 反查区域；不是本插件的 provider 时返回 undefined。 */
		function wbRegionOfProvider(provider) {
			if (provider === void 0) return void 0;
			return Object.prototype.hasOwnProperty.call(WB_PROVIDER_REGIONS, provider) ? WB_PROVIDER_REGIONS[provider] : void 0;
		}
		/** 全部使用方式，按界面顺序。 */
		const ACCOUNT_DISTRIBUTIONS = [
			"priority",
			"round-robin",
			"balanced",
			"sticky",
			"expiry"
		];
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
		const DEFAULT_ACCOUNT_DISTRIBUTION = "expiry";
		/** 窄化一个字符串是否为合法使用方式；非法值回落到默认（不抛错）。 */
		function distributionOf(value) {
			return typeof value === "string" && ACCOUNT_DISTRIBUTIONS.includes(value) ? value : DEFAULT_ACCOUNT_DISTRIBUTION;
		}
		/** 全部权益种类。 */
		const WB_BENEFIT_KINDS = ["compensation", "gift"];
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
		function unwrapVolatile(value) {
			if (value === null || typeof value !== "object") return value;
			const getter = value.get;
			return typeof getter === "function" ? getter.call(value) : value;
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
		function unwrapVolatileDeep(value) {
			if (value === null || typeof value !== "object") return value;
			const peeled = unwrapVolatile(value);
			if (peeled !== value) return unwrapVolatileDeep(peeled);
			if (Array.isArray(peeled)) return peeled.map((entry) => unwrapVolatileDeep(entry));
			const source = peeled;
			const out = {};
			for (const key of Object.keys(source)) out[key] = unwrapVolatileDeep(source[key]);
			return out;
		}
		/**
		* 拼一个带 `accountId` 的 URL。
		*
		* `accountId` 缺省时**不加参数**（而不是加一个空串）：空串会被路由读成「显式
		* 指定了一个不存在的账号」，与「不指定」是两种语义。
		*/
		function withAccountId(path, accountId) {
			if (accountId === void 0 || accountId === "") return path;
			return `${path}?${WB_ACCOUNT_ID_PARAM}=${encodeURIComponent(accountId)}`;
		}
		/** 拼一个带 `region` 的 URL。 */
		function withRegion(path, region) {
			return `${path}${path.includes("?") ? "&" : "?"}${WB_REGION_PARAM}=${region}`;
		}
		/** 拼一个带 `accountId` + `region` 的 URL。 */
		function withAccountAndRegion(path, accountId, region) {
			return withRegion(withAccountId(path, accountId), region);
		}
		/** 拼一个带 `accountId` + `kind` 的 URL。 */
		function withBenefitClaim(path, accountId, kind) {
			return `${withAccountId(path, accountId)}&${WB_KIND_PARAM}=${kind}`;
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
		function withAccountCleared(path, region) {
			return `${path}?${WB_ACCOUNT_ID_PARAM}=&${WB_REGION_PARAM}=${region}`;
		}
		/** 一天的毫秒数。 */
		const DAY_MS = 864e5;
		//#endregion
		//#region src/promo.ts
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
		function minutesOfClock(value) {
			if (typeof value !== "string") return void 0;
			const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim());
			if (match === null) return void 0;
			const hours = Number(match[1]);
			const minutes = Number(match[2]);
			if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return void 0;
			if (minutes > 59) return void 0;
			if (hours > 24) return void 0;
			if (hours === 24) return minutes === 0 ? 1440 : void 0;
			return hours * 60 + minutes;
		}
		/**
		* `nowMs` 时刻在 `timeZone` 里距离当地零点的分钟数。
		*
		* 时区账由 `Intl` 算，因为上游的窗口写在**它**指定的时区里（CN feed 是
		* `Asia/Shanghai`），而用户自己的钟不一定在那个时区。时区不可用就退回 UTC 而不是
		* 抛错：画不出来的徽标是少一个徽标，不是坏掉的卡片。
		*/
		function zonedMinutes(nowMs, timeZone) {
			const zone = timeZone ?? "UTC";
			try {
				const parts = new Intl.DateTimeFormat("en-US", {
					timeZone: zone,
					hour: "2-digit",
					minute: "2-digit",
					hourCycle: "h23"
				}).formatToParts(new Date(nowMs));
				const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
				const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
				if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
				return hour * 60 + minute;
			} catch {
				return 0;
			}
		}
		/** `nowMinutes` 是否落在某个每日窗口里。 */
		function withinDailyWindows(windows, nowMinutes) {
			return windows.some((window) => {
				const start = minutesOfClock(window.start);
				const end = minutesOfClock(window.end);
				if (start === void 0 || end === void 0) return false;
				if (start === end) return true;
				if (end > start) return nowMinutes >= start && nowMinutes < end;
				return nowMinutes >= start || nowMinutes < end;
			});
		}
		/**
		* 促销的**绝对**窗口此刻是否成立。
		*
		* 绝对窗口（`validFrom` / `validUntil`）是促销自己的寿命，它单独就能否掉徽标：寿命
		* 已经结束的促销不许继续宣传自己，无论它的每日时段怎么说。
		*/
		function promoWithinAbsoluteWindow(promo, nowMs) {
			const schedule = promo.schedule;
			if (schedule === void 0) return true;
			if (schedule.validFrom !== void 0 && nowMs < schedule.validFrom) return false;
			if (schedule.validUntil !== void 0 && nowMs >= schedule.validUntil) return false;
			return true;
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
		function promoWithinDailyWindow(promo, nowMs) {
			const schedule = promo.schedule;
			if (schedule === void 0) return true;
			if (schedule.dailyUnusable === true) return false;
			if (schedule.daily === void 0 || schedule.daily.length === 0) return true;
			return withinDailyWindows(schedule.daily, zonedMinutes(nowMs, schedule.timezone));
		}
		/** 促销此刻是否**在跑**：绝对窗口与每日时段同时成立。 */
		function promoActiveAt(promo, nowMs) {
			return promoWithinAbsoluteWindow(promo, nowMs) && promoWithinDailyWindow(promo, nowMs);
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
		function hasSchedule(promo) {
			return promo.schedule !== void 0;
		}
		/** 上游的 priority 降序；打平时促销优先于档位。 */
		function byRanking(a, b) {
			return b.priority - a.priority || (a.source === b.source ? 0 : a.source === "promotion" ? -1 : 1);
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
		function selectPromoBadge(promos, nowMs) {
			if (promos === void 0 || promos.length === 0) return void 0;
			const sorted = [...promos].sort(byRanking);
			const running = sorted.find((promo) => hasSchedule(promo) && promoActiveAt(promo, nowMs));
			if (running !== void 0) return running;
			return sorted.find((promo) => promo.badge.display !== "activeOnly" && promoWithinAbsoluteWindow(promo, nowMs) && promo.schedule?.dailyUnusable !== true);
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
		function selectPromoMultiplier(promos, nowMs) {
			if (promos === void 0 || promos.length === 0) return void 0;
			const sorted = [...promos].sort(byRanking);
			for (const promo of sorted) {
				const discount = promo.discount;
				if (discount === void 0 || discount.multiplier === void 0) continue;
				if (discount.displayMode !== "replace" && discount.displayMode !== "strikethrough") continue;
				if (!promoActiveAt(promo, nowMs)) continue;
				return discount.multiplier;
			}
		}
		/**
		* 界面语言，由浏览器报告。
		*
		* 卡片已经用浏览器 locale 格式化日期与数字，读同一个信号来选上游文案才一致：徽标说
		* 上游说的话，用用户读的那种语言。
		*
		* `navigator` 是防御性读取的 —— 本模块被单元测试在纯 Node 环境里 import，那里没有它。
		*/
		function uiLanguage() {
			return typeof navigator === "undefined" ? "" : navigator.language;
		}
		/** 给定语言是不是英语。 */
		function isEnglish(language) {
			return (language ?? "").toLowerCase().startsWith("en");
		}
		/**
		* 徽标自己的措辞。
		*
		* 上游的 label 本身就是该区域的措辞，所以它对任何界面都是默认值。英文界面在上游
		* 给了 `labelEn` 时优先用它；global feed 不给 `labelEn`，而那里的 label 本来就是英文。
		*/
		function promoBadgeLabel(promo, language) {
			const badge = promo.badge;
			if (isEnglish(language)) return badge.labelEn ?? badge.label;
			return badge.label;
		}
		/**
		* 窄行里用的徽标措辞。
		*
		* 模型选择器的行只有一行宽，且已经带了模型名、倍率与拥挤度图标，一个四字标签
		* （`夜间折扣`）能把勾选框挤出这一行。上游正是为这种情况发布了紧凑措辞
		* （`shortLabel`）；它没给时，完整措辞仍然好过被裁掉的措辞：菜单行里的省略号读起来
		* 像被截断的词，而完整措辞最多是挤一点。
		*/
		function promoBadgeShortLabel(promo, language) {
			const badge = promo.badge;
			return (isEnglish(language) ? badge.shortLabelEn ?? badge.shortLabel : badge.shortLabel) ?? promoBadgeLabel(promo, language);
		}
		/**
		* 徽标颜色，仅当上游给的是能安全放进样式的颜色。
		*
		* 只接受 hex：这个值会进 inline style，而上游发布的是 hex（`#009273`、`#FF0000`）。
		* 其他形状一律拒绝而不是透传，界面退回自己的品牌色。
		*/
		function promoBadgeColor(promo) {
			const color = promo.badge.color;
			if (color === void 0) return void 0;
			return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu.test(color) ? color : void 0;
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
		function formatDay(ms, language, timeZone) {
			try {
				return new Intl.DateTimeFormat(language === void 0 || language === "" ? void 0 : language, {
					year: "numeric",
					month: "short",
					day: "numeric",
					...timeZone === void 0 ? {} : { timeZone }
				}).format(new Date(ms));
			} catch {
				return new Date(ms).toISOString().slice(0, 10);
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
		function promoRangeText(promo, language) {
			const schedule = promo.schedule;
			if (schedule === void 0) return void 0;
			const zone = schedule.timezone;
			const from = schedule.validFrom === void 0 ? void 0 : formatDay(schedule.validFrom, language, zone);
			const to = schedule.validUntil === void 0 ? void 0 : formatDay(schedule.validUntil - 1, language, zone);
			if (from === void 0 && to === void 0) return void 0;
			if (from === void 0) return `– ${to ?? ""}`;
			if (to === void 0) return `${from} –`;
			return `${from} – ${to}`;
		}
		/**
		* 折扣运行的时段，按上游指定的时区。
		*
		* 时区是陈述的一部分：「23:00–7:50」对在别的时区的读者毫无意义，而上游的窗口写在
		* **它**的时区里（CN feed 是 `Asia/Shanghai`），不是用户的。
		*/
		function promoHoursText(promo) {
			const schedule = promo.schedule;
			const daily = schedule?.daily;
			if (daily === void 0 || daily.length === 0) return void 0;
			const windows = daily.map((window) => `${window.start}–${window.end}`).join(", ");
			const zone = schedule?.timezone;
			return zone === void 0 ? windows : `${windows} (${zone})`;
		}
		/**
		* 徽标的 tooltip：上游自己的文案、它的寿命、以及折扣运行的时段。
		*
		* 空的片段直接省掉而不是画成空白，所以一条只发布了 label 的促销得到一个只有 label、
		* 没有悬浮文案的徽标。
		*/
		function promoBadgeTooltip(promo, language) {
			const parts = [];
			const hover = promo.hover;
			if (hover !== void 0) {
				const copy = isEnglish(language) ? hover.textEn ?? hover.textZh : hover.textZh ?? hover.textEn;
				if (copy !== void 0) parts.push(copy);
			}
			const range = promoRangeText(promo, language);
			if (range !== void 0) parts.push(range);
			const hours = promoHoursText(promo);
			if (hours !== void 0) parts.push(hours);
			return parts.join(" · ");
		}
		//#endregion
		//#region src/client/styles.ts
		/**
		* 浏览器半区的内联样式，两段：设置卡片（`WB_MODELS_CARD_CSS`）与输入框读数
		* （`WB_MODELS_COMPOSER_CSS`）。
		*
		* ## 为什么是内联 CSS 而不是 CSS 文件
		*
		* 客户端 bundle 由宿主 `__ModuleLoader__` 以 CJS 形式求值，没有 CSS loader，也
		* 没有可发布的 `.css` 产物（`package.json` 的 `files` 只有 `lib/`），所以样式只能
		* 以字符串形式随 JS 一起走。
		*
		* ## 为什么类名一律 `wbm-` 前缀
		*
		* `dsm-*` 是社区插件之间的事实约定（`dsh-connect-workbuddy`、
		* `dsh-connect-trae-models`、`dsh-workbuddy-xdpool` 都用它），但**同一前缀不等于
		* 同一份规则**：三家各自定义 `.dsm-btn` 与 `.dsm-plugin-card`，谁后注入谁赢，于是
		* 「本插件的卡片外观」取决于用户的插件安装顺序。所以：
		*
		*  - 视觉**原语**（按钮 `.dsm-btn*`、卡片外壳 `.dsm-plugin-card*`）继续用 `dsm-*`，
		*    与邻居共享同一套外部表现语言，这是刻意的；
		*  - 本插件**自己的**结构类（账号行、模型行、读数、面板）一律 `wbm-` 前缀，
		*    永远不会被另一个插件的同名规则改掉。面板的 `position: fixed` 尤其重要：
		*    参考项目曾因为面板没拿到 `position: fixed` 而把测好的 left/top 当作无效值，
		*    面板渲染在「任何地方都不在」的位置上。
		*
		* 主题色一律走宿主变量 `--dsw-alias-*`，并给出十六进制回退值——受限宿主上变量
		* 可能不存在，此时界面必须仍然可读，而不是变成黑底黑字。
		*
		* @module dsh-connect-workbuddy-models/client/styles
		*/
		/** 设置卡片样式。 */
		const WB_MODELS_CARD_CSS = `
/* ── 页面外壳 ───────────────────────────────────────────────────────────── */
.wbm-page{display:flex;flex-direction:column;gap:16px;padding:16px 0 8px}
.wbm-page-head{display:flex;align-items:flex-start;gap:16px;justify-content:space-between}
.wbm-page-copy{display:flex;flex-direction:column;gap:6px;min-width:0}
.wbm-page-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:16px;font-weight:600;line-height:1.4}
.wbm-page-desc{margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5}
.wbm-page-actions{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap}

/* ── 卡片 ───────────────────────────────────────────────────────────────── */
.wbm-card{border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-3,#202126);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.wbm-section-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:1.4;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wbm-section-hint{margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1.5}
.wbm-muted{color:var(--dsw-alias-label-tertiary,#999);font-size:12px}
.wbm-secondary{color:var(--dsw-alias-label-secondary,#c8c8c8);font-size:13px}
.wbm-error{color:var(--dsw-alias-label-danger,#ff6b6b);font-size:12px;margin:0;line-height:1.5}
.wbm-warn{color:var(--dsw-alias-label-warning,#f0a23c);font-size:12px}
.wbm-ok{color:var(--dsw-alias-label-success,#4ec07a);font-size:12px}

/* ── 账号行 ─────────────────────────────────────────────────────────────── */
.wbm-account{border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:10px;display:flex;flex-direction:column;gap:6px}
.wbm-account:first-of-type{border-top:0;padding-top:0}
.wbm-account-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wbm-account-name{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbm-account-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#999);font-size:12px}
.wbm-account-path{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;overflow-wrap:anywhere}
.wbm-account-facts{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary,#c8c8c8)}

/* 标签胶囊。四种语气各自一条规则：颜色表达的是「要不要处理」。 */
.wbm-tag{display:inline-flex;align-items:center;border-radius:6px;padding:1px 6px;font-size:11px;line-height:1.6;border:1px solid transparent;white-space:nowrap}
.wbm-tag-ok{color:var(--dsw-alias-label-success,#4ec07a);border-color:var(--dsw-alias-label-success,#4ec07a)}
.wbm-tag-warn{color:var(--dsw-alias-label-warning,#f0a23c);border-color:var(--dsw-alias-label-warning,#f0a23c)}
.wbm-tag-danger{color:var(--dsw-alias-label-danger,#ff6b6b);border-color:var(--dsw-alias-label-danger,#ff6b6b)}
.wbm-tag-neutral{color:var(--dsw-alias-label-tertiary,#999);border-color:var(--dsw-alias-border-l2,#36373b)}

/* 临期提醒：整行高亮，而不是只给数字染色——用户扫的是一行，不是一位数。 */
.wbm-expiry{display:flex;align-items:center;gap:6px;font-size:12px;line-height:1.5;border-radius:6px;padding:3px 8px}
.wbm-expiry-soon{color:var(--dsw-alias-label-warning,#f0a23c);background:rgba(240,162,60,.12);border:1px solid rgba(240,162,60,.35)}
.wbm-expiry-future{color:var(--dsw-alias-label-tertiary,#999)}
.wbm-expiry-none{color:var(--dsw-alias-label-tertiary,#999)}

/* ── 积分包明细 ─────────────────────────────────────────────────────────── */
/* 折叠按钮长得像链接而不是按钮：它不改变任何状态，只多露出几行文字。 */
.wbm-packages{display:flex;flex-direction:column;gap:4px}
.wbm-packages-toggle{appearance:none;font:inherit;font-size:12px;color:var(--dsw-alias-brand-primary,#5686fe);background:transparent;border:0;border-radius:6px;padding:2px 0;text-align:left;cursor:pointer}
.wbm-packages-toggle:hover{text-decoration:underline}
.wbm-packages-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:2px}
/* 上限高度 + 纵向滚动：实测一个账号可以有 59 个包，展开后必须不把下面的签到按钮
   顶出屏幕，也不能让整页跟着一起滚。 */
.wbm-packages-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;max-height:220px;overflow-y:auto}
.wbm-packages-row{display:flex;align-items:baseline;gap:8px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary,#c8c8c8);border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:2px}
.wbm-packages-row:first-child{border-top:0;padding-top:0}
/* 包名可能很长（「CodeBuddy个人版国内运营裂变包」），让它占满剩余宽度并折行，
   而不是把数量和时间挤出去。 */
.wbm-packages-name{flex:1;min-width:0;overflow-wrap:anywhere}
/* 数量与时间不折行：88.05 / 100 断成两行就读不出「还剩多少 / 总量」了。
   注意这段是 TypeScript 模板字符串，注释里不能出现反引号，会提前终止字符串。 */
.wbm-packages-amount{flex:none;white-space:nowrap;font-variant-numeric:tabular-nums}

/* ── 开关与字段 ─────────────────────────────────────────────────────────── */
.wbm-toggle{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#c8c8c8);cursor:pointer}
.wbm-toggle input{accent-color:var(--dsw-alias-brand-primary,#5686fe);cursor:pointer}
.wbm-toggle input:disabled{cursor:default}
.wbm-field{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#c8c8c8)}
.wbm-field select,.wbm-field input[type=number]{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-2,#25262b);border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:6px;padding:2px 6px}
.wbm-field select:focus-visible,.wbm-field input[type=number]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.wbm-hours{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px}
.wbm-hour{appearance:none;font:inherit;font-size:11px;cursor:pointer;min-width:34px;padding:2px 4px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#36373b);background:transparent;color:var(--dsw-alias-label-tertiary,#999)}
.wbm-hour:hover:not(:disabled){color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-label-dimmed,#777)}
.wbm-hour-on{color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-brand-primary,#5686fe);background:rgba(86,134,254,.16)}
.wbm-hour:disabled{opacity:.4;cursor:default}

/* ── 使用方式（单选组）───────────────────────────────────────────────────── */
.wbm-choices{display:flex;flex-direction:column;gap:6px}
.wbm-choice{display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:6px 8px;border-radius:8px;border:1px solid transparent}
.wbm-choice:hover{border-color:var(--dsw-alias-border-l2,#36373b);background:rgba(255,255,255,.02)}
.wbm-choice input{margin-top:2px;accent-color:var(--dsw-alias-brand-primary,#5686fe);cursor:pointer}
.wbm-choice-body{display:flex;flex-direction:column;gap:2px;min-width:0}
.wbm-choice-label{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;line-height:1.4}
/* 被选中的那条用强调色，好让「现在用的是哪种」一眼可见（单选组只有一处选中）。 */
.wbm-choice-on .wbm-choice-label{color:var(--dsw-alias-brand-primary,#5686fe);font-weight:600}
.wbm-choice-hint{color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1.5}

/* ── 模型行 ─────────────────────────────────────────────────────────────── */
.wbm-model{display:flex;align-items:flex-start;gap:8px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:8px}
.wbm-model:first-of-type{border-top:0;padding-top:0}
.wbm-model input[type=checkbox]{margin-top:3px;accent-color:var(--dsw-alias-brand-primary,#5686fe);cursor:pointer}
.wbm-model input[type=checkbox]:disabled{cursor:default}
.wbm-model-body{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.wbm-model-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wbm-model-name{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbm-model-facts{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#999);font-size:11px}
.wbm-model-id{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);overflow-wrap:anywhere}

/* ── 跳过文件 ───────────────────────────────────────────────────────────── */
.wbm-skipped{display:flex;flex-direction:column;gap:4px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:10px}
.wbm-skipped-row{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#999)}
.wbm-skipped-path{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;overflow-wrap:anywhere;flex:none;max-width:50%}

/* ── 空态 ───────────────────────────────────────────────────────────────── */
.wbm-empty{display:flex;flex-direction:column;gap:6px;padding:12px;border:1px dashed var(--dsw-alias-border-l2,#36373b);border-radius:8px}
.wbm-empty-title{margin:0;color:var(--dsw-alias-label-secondary,#c8c8c8);font-size:13px;font-weight:600}
.wbm-empty-note{margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1.5}
`;
		/**
		* 输入框读数的样式。
		*
		* 单独一段，且由 `ComposerCredits.tsx` 在**模块求值阶段**就注入：设置卡片可能
		* 永远不被渲染（用户没打开设置面板），而读数要立刻可用。参考项目当年就是把两段
		* 揉在一起，结果读数在没有卡片渲染的宿主上渲染成一个默认按钮框。
		*/
		const WB_MODELS_COMPOSER_CSS = `
/* 触发按钮：一行纯读数，没有任何额外控件——这一行与外壳自己的权限/模型控件共享
 * 宽度，每多一个按钮都是别人的空间。手动刷新放在面板里。 */
.wbm-composer-credits{display:inline-flex;align-items:center;min-width:0}
.wbm-composer-trigger{appearance:none;font:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:4px;border:1px solid transparent;border-radius:6px;padding:2px 6px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#999);background:transparent;white-space:nowrap;min-width:0;overflow:hidden;text-overflow:ellipsis}
.wbm-composer-trigger:hover{color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-border-l2,#36373b);background:rgba(255,255,255,.04)}
.wbm-composer-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.wbm-composer-trigger[aria-expanded=true]{color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-label-dimmed,#777)}
.wbm-composer-amount{color:var(--dsw-alias-label-secondary,#c8c8c8)}
.wbm-composer-user{color:var(--dsw-alias-label-tertiary,#999);max-width:14ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbm-composer-stale{color:var(--dsw-alias-label-warning,#f0a23c)}

/* 锚定面板。position: fixed 是必须的——缺了它，JS 测出来的 left/top 对绝对定位
 * 元素无效，面板会渲染到「哪儿都不在」。 */
.wbm-composer-panel{position:fixed;z-index:60;min-width:260px;max-width:340px;display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-2,#25262b);box-shadow:0 8px 28px rgba(0,0,0,.4)}
.wbm-composer-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.wbm-composer-panel-title{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12px;font-weight:600}
.wbm-composer-panel-refresh{appearance:none;font:inherit;font-size:11px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#999);padding:1px 8px}
.wbm-composer-panel-refresh:hover:not(:disabled){color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-label-dimmed,#777)}
.wbm-composer-panel-refresh:disabled{opacity:.4;cursor:default}
.wbm-composer-panel-empty{margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1.5}
.wbm-composer-panel-table{width:100%;border-collapse:collapse;font-size:12px}
.wbm-composer-panel-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary,#999);padding:2px 4px;border-bottom:1px solid var(--dsw-alias-border-l2,#36373b);font-size:11px}
.wbm-composer-panel-table td{padding:2px 4px;color:var(--dsw-alias-label-secondary,#c8c8c8);vertical-align:top}
.wbm-composer-panel-num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.wbm-composer-panel-row-current td{color:var(--dsw-alias-label-primary,#e6e6e6)}
/* 行内按钮铺满单元格，让整行都可点——点行切换账号，不点小圆点。 */
.wbm-composer-row-switch{appearance:none;font:inherit;cursor:pointer;display:flex;align-items:center;gap:6px;width:100%;text-align:left;border:0;border-radius:6px;background:transparent;color:inherit;padding:3px 4px;min-width:0}
.wbm-composer-row-switch:hover:not(:disabled){background:rgba(255,255,255,.06)}
.wbm-composer-row-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:-2px}
.wbm-composer-row-switch:disabled{cursor:default}
.wbm-composer-row-who{display:flex;flex-direction:column;gap:1px;min-width:0}
.wbm-composer-row-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:16ch}
.wbm-composer-row-mark{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-tertiary,#999)}
.wbm-composer-row-mark-current{color:var(--dsw-alias-label-success,#4ec07a)}
.wbm-composer-panel-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:6px}
.wbm-composer-panel-error{margin:0;color:var(--dsw-alias-label-warning,#f0a23c);font-size:11px;line-height:1.5}
`;
		//#endregion
		//#region src/client/WbModelsCard.tsx
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
		/** 恒等翻译兜底（宿主未接 locale 时键名可见，好过白屏）。 */
		const identityT$1 = (key) => key;
		/** 状态轮询间隔：5 秒——签到与积分的变化是「点一下就变」，需要及时回显。 */
		const WB_MODELS_POLL_MS = 5e3;
		/** 自动签到的默认时刻（北京时间整点）。契约层没有导出这条，见 §8 的 [9]。 */
		const DEFAULT_CHECKIN_HOURS = [9];
		/**
		* 「全不选」的哨兵 id。
		*
		* `enabledModelIds` 的口径是**空数组 = 全部显示**（DESIGN.md §7），所以「一个都
		* 不显示」在空数组里没有表示。写一个真实模型 id 永远不会等于的哨兵值，是唯一
		* 能区分「全选」与「全不选」的办法；它同时让「用户什么都没配过」与「用户明确
		* 关掉了全部」在配置层面保持可区分——这两件事在界面上必须长得不一样。
		*/
		const WB_NONE_SENTINEL = "__none__";
		/** 格式化整数积分；读不到时 `—`。 */
		function formatCredits$1(value) {
			if (value === void 0 || !Number.isFinite(value)) return "—";
			const rounded = Math.round(value);
			try {
				return rounded.toLocaleString("zh-CN");
			} catch {
				return String(rounded);
			}
		}
		/** 格式化一个毫秒时刻成本地时间；无效返回 undefined。 */
		function formatTime(ms) {
			if (ms === void 0 || !Number.isFinite(ms) || ms <= 0) return void 0;
			try {
				return new Date(ms).toLocaleString("zh-CN", {
					month: "2-digit",
					day: "2-digit",
					hour: "2-digit",
					minute: "2-digit"
				});
			} catch {
				return;
			}
		}
		/** 距某个时刻还有多少整天（向下取整，最小 0）。 */
		function daysUntil$1(ms, nowMs) {
			if (ms === void 0 || !Number.isFinite(ms)) return void 0;
			return Math.max(0, Math.floor((ms - nowMs) / DAY_MS));
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
		function formatAge(ms) {
			if (ms === void 0 || !Number.isFinite(ms)) return "";
			const seconds = Math.max(0, Math.round(ms / 1e3));
			if (seconds < 60) return `${seconds}s`;
			const minutes = Math.round(seconds / 60);
			if (minutes < 60) return `${minutes}m`;
			return `${Math.round(minutes / 60)}h`;
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
		function enabledModelSetOf(stored, allModelIds) {
			if (stored.includes("__none__")) return /* @__PURE__ */ new Set();
			if (stored.length === 0) return new Set(allModelIds);
			const present = new Set(allModelIds);
			return new Set(stored.filter((id) => present.has(id)));
		}
		/**
		* 把界面上的勾选集合写回配置值。
		*
		* 与 `enabledModelSetOf` 互逆，且**收敛到规范形式**：全选写空数组（让「默认全部
		* 显示」这条口径继续生效，将来上游新增的模型自动出现），空的写哨兵，其余照抄。
		*/
		function enabledModelValueOf(picked, allModelIds) {
			if (picked.size === 0) return [WB_NONE_SENTINEL];
			if (picked.size === allModelIds.length && allModelIds.every((id) => picked.has(id))) return [];
			return [...picked];
		}
		/** 尽力解析一份 JSON；非 2xx 时抛出带可读原因的错。 */
		async function readJson$1(response) {
			let payload = {};
			try {
				payload = await response.json();
			} catch {
				payload = {};
			}
			if (!response.ok) {
				const message = typeof payload["error"] === "string" ? payload["error"] : `HTTP ${response.status}`;
				throw new Error(message);
			}
			return payload;
		}
		/** 把任意异常转成一句可读文案。 */
		function messageOf(error) {
			return error instanceof Error ? error.message : String(error);
		}
		/** 从设置分区快照里取配置对象（剥掉 volatile 活引用）。 */
		function configOfScope(scope) {
			if (scope === void 0) return void 0;
			try {
				const value = unwrapVolatileDeep(scope.getSnapshot().value);
				return typeof value === "object" && value !== null ? value : void 0;
			} catch {
				return;
			}
		}
		/**
		* 汇总一个账号的到期事实。
		*
		* `expiringSoon` 用探测层给的显式值（它已经按用户的 `expiryWarnDays` 聚合过），
		* 只有缺省时才从包列表里按窗口现算——两处各算一遍会给出两个不同的「还剩多少分」。
		*/
		function expiryFactsOf(credits, warnDays, nowMs) {
			if (credits === void 0) return {
				expiringSoon: 0,
				soon: false
			};
			const windowMs = warnDays * DAY_MS;
			const nearest = credits.nearestExpiryMs;
			let expiringSoon = credits.expiringSoon;
			if (!Number.isFinite(expiringSoon) || expiringSoon < 0) expiringSoon = credits.packages.reduce((sum, pkg) => {
				if (pkg.monthly) return sum;
				const at = pkg.expiresAtMs;
				if (at === void 0 || !Number.isFinite(at)) return sum;
				const left = at - nowMs;
				return left > 0 && left <= windowMs ? sum + pkg.remain : sum;
			}, 0);
			const days = daysUntil$1(nearest, nowMs);
			const soon = expiringSoon > 0 || days !== void 0 && days <= warnDays;
			return {
				...nearest === void 0 || !Number.isFinite(nearest) ? {} : { nearestExpiryMs: nearest },
				expiringSoon,
				...days === void 0 ? {} : { days },
				soon
			};
		}
		/** 取某个使用方式的名字。 */
		function distributionLabel(t, mode) {
			return t(`row.distribution.${mode}`);
		}
		/** 取某个使用方式的一句话说明。 */
		function distributionHint(t, mode) {
			return t(`row.distributionHint.${mode}`);
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
		function rankReasonText(t, pick) {
			if (pick === void 0) return void 0;
			if (!pick.usable) return pick.reason === void 0 ? void 0 : t("row.rankWhyExcluded", {
				rank: pick.rank,
				reason: pick.reason
			});
			const time = formatTime(pick.nearestExpiryMs);
			if (pick.rank === 1) return time === void 0 ? t("row.rankWhyCurrentNoExpiry") : t("row.rankWhyCurrent", { time });
			return time === void 0 ? t("row.rankWhyLaterNoExpiry", { rank: pick.rank }) : t("row.rankWhyLater", {
				rank: pick.rank,
				time
			});
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
		function formatAmount(value) {
			if (!Number.isFinite(value)) return "—";
			if (Number.isInteger(value)) try {
				return value.toLocaleString("zh-CN");
			} catch {
				return String(value);
			}
			return String(Math.round(value * 100) / 100);
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
		function creditPackageRowsOf(credits) {
			if (credits === void 0) return [];
			const oneShot = [];
			const monthly = [];
			credits.packages.forEach((pkg, index) => {
				const amountText = `${formatAmount(pkg.remain)} / ${formatAmount(pkg.size)}`;
				const base = {
					packageName: pkg.packageName,
					amountText,
					monthly: pkg.monthly
				};
				if (pkg.monthly) {
					monthly.push({
						...base,
						key: `${index}:${pkg.packageName}`,
						...pkg.refreshAtMs === void 0 || !Number.isFinite(pkg.refreshAtMs) ? {} : { refreshAtMs: pkg.refreshAtMs }
					});
					return;
				}
				oneShot.push({
					...base,
					key: `${index}:${pkg.packageName}`,
					...pkg.expiresAtMs === void 0 || !Number.isFinite(pkg.expiresAtMs) ? {} : { expiresAtMs: pkg.expiresAtMs }
				});
			});
			oneShot.sort((left, right) => {
				const a = left.expiresAtMs;
				const b = right.expiresAtMs;
				if (a === void 0 && b === void 0) return 0;
				if (a === void 0) return 1;
				if (b === void 0) return -1;
				return a - b;
			});
			return [...oneShot, ...monthly];
		}
		function WbModelsCard(props) {
			const t = props.t ?? identityT$1;
			const fetchImpl = props.fetchImpl ?? (typeof fetch === "function" ? fetch : void 0);
			const settingsScope = props.settingsScope;
			/**
			* 配置是否可写。
			*
			* 只读**仅**当宿主明确报告作用域不可写时成立。作用域缺失（绑定探测失败、受限
			* 宿主）也按只读处理——但这时仍允许「刷新账号」「签到」「拉取模型」，因为它们
			* 走 HTTP 路由，与设置分区无关。把两者绑在一起会让受限宿主上连签到都点不了。
			*/
			const scopeSnapshot = settingsScope?.getSnapshot();
			const configWritable = settingsScope !== void 0 && scopeSnapshot !== void 0 && scopeSnapshot.writable !== false && typeof settingsScope.set === "function";
			const [region, setRegion] = (0, react.useState)("cn");
			/** 每个区域各自保留最后一次应答：切 Tab 时立刻显示另一侧，而不是一帧空白。 */
			const [statusByRegion, setStatusByRegion] = (0, react.useState)(() => props.initialStatusByRegion ?? {});
			const [errorByRegion, setErrorByRegion] = (0, react.useState)({});
			const [scopeConfig, setScopeConfig] = (0, react.useState)(() => configOfScope(settingsScope));
			const [busy, setBusy] = (0, react.useState)(void 0);
			const [notice, setNotice] = (0, react.useState)(void 0);
			const [failure, setFailure] = (0, react.useState)(void 0);
			/** 每个账号的签到结果提示（成功/失败都挂在该行上，而不是全局横幅）。 */
			const [checkinNote, setCheckinNote] = (0, react.useState)({});
			/** 模型草稿：`undefined` = 跟随配置。 */
			const [draftByRegion, setDraftByRegion] = (0, react.useState)({});
			const mounted = (0, react.useRef)(true);
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			/** 卡片样式只注入一次（幂等：`data-plugin-css` 去重）。 */
			(0, react.useEffect)(() => {
				if (typeof document === "undefined") return void 0;
				const cssId = `${WB_MODELS_SETTINGS_NS}/card.css`;
				if (document.querySelector(`style[data-plugin-css="${cssId}"]`) !== null) return void 0;
				const tag = document.createElement("style");
				tag.dataset["plugin"] = "dsh-connect-workbuddy-models";
				tag.dataset["pluginCss"] = cssId;
				tag.textContent = WB_MODELS_CARD_CSS;
				document.head.appendChild(tag);
			}, []);
			const status = statusByRegion[region];
			const error = errorByRegion[region];
			/** 配置：设置分区优先（它是用户刚点的那次写的），否则用 `/status` 回显。 */
			const config = scopeConfig ?? status?.config;
			const warnDays = (() => {
				const raw = config?.expiryWarnDays;
				if (raw === void 0 || !Number.isFinite(raw)) return 3;
				return Math.min(90, Math.max(1, Math.round(raw)));
			})();
			/**
			* 读一次 `/status?region=`。
			*
			* 失败时保留该区域上一次的应答并记下错误：一次网络抖动不该让整页数字归零。
			*/
			const reload = (0, react.useCallback)(async (target) => {
				if (fetchImpl === void 0) return;
				try {
					const payload = await readJson$1(await fetchImpl(withRegion(WB_STATUS_PATH, target), {
						headers: { accept: "application/json" },
						credentials: "same-origin"
					}));
					if (!mounted.current) return;
					setStatusByRegion((current) => ({
						...current,
						[target]: payload
					}));
					setErrorByRegion((current) => {
						const next = { ...current };
						delete next[target];
						return next;
					});
				} catch (caught) {
					if (!mounted.current) return;
					setErrorByRegion((current) => ({
						...current,
						[target]: messageOf(caught)
					}));
				}
			}, [fetchImpl]);
			const reloadRef = (0, react.useRef)(reload);
			(0, react.useEffect)(() => {
				reloadRef.current = reload;
			}, [reload]);
			(0, react.useEffect)(() => {
				if (settingsScope?.subscribe === void 0) return void 0;
				return settingsScope.subscribe(() => {
					if (mounted.current) setScopeConfig(configOfScope(settingsScope));
				});
			}, [settingsScope]);
			(0, react.useEffect)(() => {
				reloadRef.current(region);
				const timer = window.setInterval(() => {
					reloadRef.current(region);
				}, WB_MODELS_POLL_MS);
				return () => {
					window.clearInterval(timer);
				};
			}, [region]);
			/** POST 一个路由，返回应答（失败抛出可读错误）。 */
			const post = (0, react.useCallback)(async (path, body, key) => {
				if (fetchImpl === void 0) return void 0;
				setBusy(key);
				setNotice(void 0);
				setFailure(void 0);
				try {
					return await readJson$1(await fetchImpl(path, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							accept: "application/json"
						},
						credentials: "same-origin",
						...body === void 0 ? {} : { body: JSON.stringify(body) }
					}));
				} catch (caught) {
					if (mounted.current) setFailure(messageOf(caught));
					return;
				} finally {
					if (mounted.current) setBusy(void 0);
				}
			}, [fetchImpl]);
			/**
			* 写一个**顶层**配置键。
			*
			* 必须整键写入：settings 文档按顶层键存值，用点号路径 `'automation.enabled'`
			* 会被当成一个字面键名，真正的对象永不更新——这正是「复选框勾不动」的成因。
			* 写完立即重读：读回来的文档才是事实。
			*/
			const writeConfig = (0, react.useCallback)(async (field, value) => {
				const write = settingsScope?.set;
				if (write === void 0) {
					setFailure(t("row.saveFailed", { message: "settings scope is unavailable" }));
					return false;
				}
				setNotice(void 0);
				setFailure(void 0);
				try {
					await write.call(settingsScope, field, value);
					setScopeConfig(configOfScope(settingsScope));
					await reloadRef.current(region);
					setNotice(t("row.settingsSaved"));
					return true;
				} catch (caught) {
					setFailure(t("row.saveFailed", { message: messageOf(caught) }));
					return false;
				}
			}, [
				settingsScope,
				region,
				t
			]);
			(0, react.useMemo)(() => new Set(config?.accountsEnabled ?? []), [config]);
			/**
			* 一个账号是否参与池。
			*
			* `accountsEnabled` 为空表示「全部参与」——与模型选择同一套「空即全」口径；
			* 否则一个刚装好插件的用户会看到所有号都是未勾选状态，而它们其实都在服务。
			*/
			const inPool = (0, react.useCallback)((accountId) => {
				const list = config?.accountsEnabled ?? [];
				return list.length === 0 || list.includes(accountId);
			}, [config]);
			/** 勾掉/勾上某个账号的池成员资格。 */
			const togglePool = (0, react.useCallback)(async (accountId, next) => {
				const all = (status?.accounts ?? []).map((reading) => reading.account.id);
				const explicit = (config?.accountsEnabled ?? []).length === 0 ? new Set(all) : new Set(config?.accountsEnabled ?? []);
				if (next) explicit.add(accountId);
				else explicit.delete(accountId);
				const value = explicit.size === all.length && all.every((id) => explicit.has(id)) ? [] : [...explicit];
				await writeConfig("accountsEnabled", value);
			}, [
				status,
				config,
				writeConfig
			]);
			/** 手动签到一个账号。 */
			const checkin = (0, react.useCallback)(async (account) => {
				const payload = await post(withAccountId(WB_CHECKIN_PATH, account.id), void 0, `checkin:${account.id}`);
				if (!mounted.current) return;
				const grantedRaw = payload === void 0 ? void 0 : payload["grantedCredit"];
				const granted = typeof grantedRaw === "number" && Number.isFinite(grantedRaw) ? grantedRaw : void 0;
				setCheckinNote((current) => ({
					...current,
					[account.id]: granted === void 0 ? t("row.checkinDone") : t("row.checkinToday", { credit: formatCredits$1(granted) })
				}));
				await reloadRef.current(region);
			}, [
				post,
				t,
				region
			]);
			/** 领取某个账号的一类权益（补偿 / 赠礼）。 */
			const claimBenefit = (0, react.useCallback)(async (account, kind) => {
				await post(withBenefitClaim(WB_BENEFIT_CLAIM_PATH, account.id, kind), void 0, `benefit:${account.id}:${kind}`);
				await reloadRef.current(region);
			}, [post, region]);
			/** 重新扫描本机登录账号。 */
			const refreshAccounts = (0, react.useCallback)(async () => {
				const payload = await post(withRegion(WB_ACCOUNTS_REFRESH_PATH, region), void 0, "accounts");
				if (!mounted.current) return;
				const accounts = payload?.["accounts"];
				const count = Array.isArray(accounts) ? accounts.length : void 0;
				setNotice(count === void 0 ? t("row.refreshAccountsDone", { count: "?" }) : t("row.refreshAccountsDone", { count }));
				await reloadRef.current(region);
			}, [
				post,
				region,
				t
			]);
			/** 重新拉取模型目录与倍率。 */
			const refreshModels = (0, react.useCallback)(async () => {
				const payload = await post(withRegion(WB_MODELS_REFRESH_PATH, region), void 0, "models");
				if (!mounted.current) return;
				const models = payload?.["models"];
				const count = Array.isArray(models) ? models.length : void 0;
				setNotice(count === void 0 ? t("row.refreshModelsDone", { count: "?" }) : t("row.refreshModelsDone", { count }));
				await reloadRef.current(region);
			}, [
				post,
				region,
				t
			]);
			const models = status?.models ?? [];
			const modelsFetchedAtMs = status?.modelsFetchedAtMs;
			const modelsAgeMs = status?.modelsAgeMs;
			status?.busyFetchedAtMs;
			const refreshingModels = busy === "models";
			const allModelIds = (0, react.useMemo)(() => models.map((model) => model.id), [models]);
			/** 配置里该区域的存储值。空数组 = 全部显示。 */
			const storedModelIds = region === "global" ? config?.enabledModelIdsGlobal ?? [] : config?.enabledModelIds ?? [];
			/** 界面上勾着的集合：草稿优先。 */
			const pickedModels = (0, react.useMemo)(() => draftByRegion[region] === void 0 ? enabledModelSetOf(storedModelIds, allModelIds) : new Set(draftByRegion[region] ?? []), [
				draftByRegion,
				region,
				storedModelIds,
				allModelIds
			]);
			const modelsDirty = draftByRegion[region] !== void 0;
			const allPicked = allModelIds.length > 0 && allModelIds.every((id) => pickedModels.has(id));
			/** 勾/取消一个模型（只改草稿，等保存）。 */
			const toggleModel = (0, react.useCallback)((modelId) => {
				setDraftByRegion((current) => {
					const base = current[region] === void 0 ? enabledModelSetOf(storedModelIds, allModelIds) : new Set(current[region] ?? []);
					const next = new Set(base);
					if (next.has(modelId)) next.delete(modelId);
					else next.add(modelId);
					return {
						...current,
						[region]: [...next]
					};
				});
			}, [
				region,
				storedModelIds,
				allModelIds
			]);
			/** 全选 / 全不选（只改草稿）。 */
			const pickAll = (0, react.useCallback)((picked) => {
				setDraftByRegion((current) => ({
					...current,
					[region]: picked ? [...allModelIds] : []
				}));
			}, [region, allModelIds]);
			/**
			* 保存模型选择。
			*
			* 走 `/models/save` HTTP 路由而不是写设置：选择要能被宿主侧的模型过滤立即读到，
			* 而设置分区的写入在某些宿主线是延迟投影的。`enabledModelValueOf` 负责把界面
			* 集合收敛成规范值（全选→空数组，空→哨兵）。
			*/
			const saveModels = (0, react.useCallback)(async () => {
				const value = enabledModelValueOf(pickedModels, allModelIds);
				if (await post("/plugins/dsh-connect-workbuddy-models/models/save", {
					region,
					enabledModelIds: [...value]
				}, "models-save") === void 0 || !mounted.current) return;
				setDraftByRegion((current) => {
					const next = { ...current };
					delete next[region];
					return next;
				});
				setNotice(t("row.modelsSaved"));
				await reloadRef.current(region);
			}, [
				pickedModels,
				allModelIds,
				post,
				region,
				t
			]);
			const automation = config?.automation ?? {
				enabled: false,
				checkinHours: [...DEFAULT_CHECKIN_HOURS],
				claimBenefits: false
			};
			const hours = automation.checkinHours.length > 0 ? automation.checkinHours : DEFAULT_CHECKIN_HOURS;
			/**
			* 写自动签到配置。
			*
			* 一次写**整个** `automation` 对象，且把当前所有字段都带上：只写一个字段会把
			* 其余字段丢成 schema 缺省（时段被清成空 = 一份跑不起来的日程）。
			*/
			const writeAutomation = (0, react.useCallback)(async (patch) => {
				const next = {
					enabled: patch.enabled ?? automation.enabled,
					checkinHours: [...patch.checkinHours ?? (hours.length > 0 ? hours : DEFAULT_CHECKIN_HOURS)],
					claimBenefits: patch.claimBenefits ?? automation.claimBenefits
				};
				await writeConfig("automation", next);
			}, [
				automation,
				hours,
				writeConfig
			]);
			/** 勾/取消一个签到整点。 */
			const toggleHour = (0, react.useCallback)((hour) => {
				const current = new Set(hours);
				if (current.has(hour)) current.delete(hour);
				else current.add(hour);
				writeAutomation({ checkinHours: [...current].sort((a, b) => a - b) });
			}, [hours, writeAutomation]);
			const accounts = status?.accounts ?? [];
			const skipped = status?.skipped ?? [];
			/**
			* 名次表按账号 id 索引。
			*
			* `picks` 是可选字段（老宿主不会发），缺了就当没有理由可渲染，而不是“假设
			* 名次等于数组下标”——账号数组是 `pool.list()` 的顺序（按 id 升序），与名次
			* 完全无关，用下标猜会把第 3 名说成第 1 名。
			*/
			const pickById = new Map((status?.picks ?? []).map((pick) => [pick.accountId, pick]));
			const nowMs = Date.now();
			const promoLanguage = uiLanguage();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "wbm-page",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "wbm-page-head",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "wbm-page-copy",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
								className: "wbm-page-title",
								children: t("row.title")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "wbm-page-desc",
								children: t("row.desc")
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "wbm-page-actions",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsm-btn dsm-btn-sm",
								disabled: busy !== void 0,
								onClick: () => {
									refreshAccounts();
								},
								children: busy === "accounts" ? t("row.refreshingAccounts") : t("row.refreshAccounts")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsm-btn dsm-btn-sm",
								disabled: busy !== void 0,
								onClick: () => {
									refreshModels();
								},
								children: busy === "models" ? t("row.refreshingModels") : t("row.refreshModels")
							})]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "wbm-page-actions",
						role: "tablist",
						"aria-label": t("row.accountsTitle"),
						children: WB_REGIONS.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							role: "tab",
							"aria-selected": entry === region,
							className: entry === region ? "dsm-btn dsm-btn-sm dsm-btn-primary" : "dsm-btn dsm-btn-sm dsm-btn-outline",
							onClick: () => {
								setRegion(entry);
							},
							children: t(entry === "cn" ? "row.regionCn" : "row.regionGlobal")
						}, entry))
					}),
					failure === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "wbm-error",
						role: "alert",
						children: failure
					}),
					notice === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "wbm-ok",
						role: "status",
						children: notice
					}),
					error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "wbm-error",
						role: "alert",
						children: t("row.requestFailed", { message: error })
					}),
					configWritable ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "wbm-secondary",
						children: t("row.readonly")
					}),
					status === void 0 ? error === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "wbm-muted",
						children: t("row.loading")
					}) : null : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "wbm-card",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
								className: "wbm-section-title",
								children: [t("row.accountsTitle"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "wbm-muted",
									children: accounts.length
								})]
							}),
							accounts.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "wbm-empty",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "wbm-empty-title",
									children: t("row.accountsEmpty")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "wbm-empty-note",
									children: t("row.accountsEmptyHint")
								})]
							}) : accounts.map((reading) => {
								const account = reading.account;
								const facts = expiryFactsOf(reading.credits, warnDays, nowMs);
								const expiryText = formatTime(facts.nearestExpiryMs);
								const checkinStatus = reading.checkin;
								const note = checkinNote[account.id];
								const excluded = reading.excludedBy;
								const rankReason = rankReasonText(t, pickById.get(account.id));
								const signinSupported = account.region === "cn" && region === "cn";
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "wbm-account",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "wbm-account-head",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
													className: "wbm-toggle",
													title: t("row.accountInPoolHint"),
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
														type: "checkbox",
														checked: inPool(account.id),
														disabled: !configWritable || busy !== void 0,
														onChange: (event) => {
															togglePool(account.id, event.target.checked);
														}
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "wbm-account-name",
														children: account.accountName === "" ? t("row.accountUnknown") : account.accountName
													})]
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "wbm-tag wbm-tag-neutral",
													children: t(account.region === "global" ? "row.regionGlobal" : "row.regionCn")
												}),
												account.selected ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "wbm-tag wbm-tag-ok",
													children: t("row.accountCurrent")
												}) : null,
												excluded === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "wbm-tag wbm-tag-danger",
													children: excluded
												})
											]
										}),
										rankReason === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: "wbm-secondary",
											children: rankReason
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "wbm-account-meta",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t(account.source === "dsh" ? "row.accountSourceDsh" : "row.accountSourceDesktop") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "wbm-account-path",
												title: account.sourcePath,
												children: t("row.accountSourcePath", { path: account.sourcePath })
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "wbm-account-facts",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
												t("row.creditsTotal"),
												" ",
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: reading.credits === void 0 ? t("row.creditsUnknown") : formatCredits$1(reading.credits.total) })
											] }), expiryText === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "wbm-expiry wbm-expiry-none",
												children: t("row.creditsNoExpiry")
											}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: facts.soon ? "wbm-expiry wbm-expiry-soon" : "wbm-expiry wbm-expiry-future",
												children: t("row.creditsExpiry", { time: expiryText })
											})]
										}),
										facts.expiringSoon > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: "wbm-expiry wbm-expiry-soon",
											role: "status",
											children: t("row.creditsExpiringSoon", {
												amount: formatCredits$1(facts.expiringSoon),
												days: facts.days ?? warnDays
											})
										}) : null,
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CreditPackages, {
											t,
											credits: reading.credits,
											accountId: account.id
										}),
										signinSupported ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "wbm-account-facts",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CheckinLine, {
													t,
													status: checkinStatus
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "dsm-btn dsm-btn-sm dsm-btn-outline",
													disabled: busy !== void 0 || checkinStatus?.todayCheckedIn === true || checkinStatus?.active === false,
													onClick: () => {
														checkin(account);
													},
													children: busy === `checkin:${account.id}` ? t("row.checkinClaiming") : t("row.checkinClaim")
												}),
												automation.claimBenefits ? null : WB_BENEFIT_KINDS.map((kind) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "dsm-btn dsm-btn-sm",
													disabled: busy !== void 0,
													onClick: () => {
														claimBenefit(account, kind);
													},
													children: t(kind === "gift" ? "benefit.gift" : "benefit.compensation")
												}, kind))
											]
										}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: "wbm-muted",
											children: t("row.checkinUnsupportedRegion")
										}),
										note === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: "wbm-ok",
											role: "status",
											children: note
										})
									]
								}, account.id);
							}),
							skipped.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "wbm-skipped",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
										className: "wbm-section-title",
										children: t("row.skippedTitle")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "wbm-section-hint",
										children: t("row.skippedHint")
									}),
									skipped.map((file) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "wbm-skipped-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "wbm-skipped-path",
											title: file.path,
											children: file.path
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t(`row.skippedReason.${file.reason}`) })]
									}, file.path))
								]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "wbm-card",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								className: "wbm-section-title",
								children: t("row.automationTitle")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "wbm-toggle",
								title: t("row.autoEnabledHint"),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: automation.enabled,
									disabled: !configWritable || busy !== void 0,
									onChange: (event) => {
										writeAutomation({ enabled: event.target.checked });
									}
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.autoEnabled") })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "wbm-section-hint",
								children: t("row.autoEnabledHint")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "wbm-secondary",
									children: t("row.autoHours")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "wbm-hours",
									role: "group",
									"aria-label": t("row.autoHours"),
									children: Array.from({ length: 24 }, (_, hour) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										"aria-pressed": hours.includes(hour),
										className: hours.includes(hour) ? "wbm-hour wbm-hour-on" : "wbm-hour",
										disabled: !configWritable || busy !== void 0,
										onClick: () => {
											toggleHour(hour);
										},
										children: String(hour).padStart(2, "0")
									}, hour))
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "wbm-section-hint",
									children: t("row.autoHoursHint")
								})
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "wbm-toggle",
								title: t("row.autoClaimBenefitsHint"),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: automation.claimBenefits,
									disabled: !configWritable || busy !== void 0,
									onChange: (event) => {
										writeAutomation({ claimBenefits: event.target.checked });
									}
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.autoClaimBenefits") })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "wbm-section-hint",
								children: t("row.autoClaimBenefitsHint")
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "wbm-card",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
								className: "wbm-section-title",
								children: [t("row.modelsTitle"), modelsDirty ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "wbm-tag wbm-tag-warn",
									children: t("row.modelsDirty")
								}) : null]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "wbm-section-hint",
								children: t("row.modelsHint")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: "wbm-muted wbm-models-freshness",
								children: [modelsFetchedAtMs === void 0 ? t("row.modelsFetchedNever") : t("row.modelsFetchedAt", { time: formatAge(modelsAgeMs) }) + (modelsAgeMs !== void 0 && modelsAgeMs >= 3e5 ? t("row.modelsFetchedStale") : ""), refreshingModels ? ` ${t("row.modelsRefreshing")}` : ""]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "wbm-page-actions",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsm-btn dsm-btn-sm",
									disabled: models.length === 0 || allPicked,
									onClick: () => {
										pickAll(true);
									},
									children: t("row.modelsSelectAll")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsm-btn dsm-btn-sm",
									disabled: models.length === 0 || pickedModels.size === 0,
									onClick: () => {
										pickAll(false);
									},
									children: t("row.modelsSelectNone")
								})]
							}),
							models.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "wbm-muted",
								children: t("row.modelsEmpty")
							}) : models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "wbm-model",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: pickedModels.has(model.id),
									onChange: () => {
										toggleModel(model.id);
									}
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "wbm-model-body",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "wbm-model-head",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "wbm-model-name",
												children: model.name
											}),
											model.creditMultiplier === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "wbm-muted",
												children: [
													"(",
													model.creditMultiplier.toFixed(2),
													"x)"
												]
											}),
											(() => {
												const promo = selectPromoBadge(model.promos ?? [], nowMs);
												if (promo === void 0) return null;
												const color = promoBadgeColor(promo);
												return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "wbm-tag",
													style: color === void 0 ? void 0 : {
														color,
														borderColor: color
													},
													title: promoBadgeTooltip(promo, promoLanguage),
													children: promoBadgeLabel(promo, promoLanguage)
												});
											})()
										]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "wbm-model-facts",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "wbm-model-id",
												children: t("row.modelsId", { id: model.id })
											}),
											model.contextWindow === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.modelsContext", { count: model.contextWindow.toLocaleString("zh-CN") }) }),
											model.maxTokens === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.modelsMaxOutput", { count: model.maxTokens.toLocaleString("zh-CN") }) })
										]
									})]
								})]
							}, model.id)),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "wbm-page-actions",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsm-btn dsm-btn-sm dsm-btn-primary",
									disabled: !modelsDirty || busy !== void 0,
									onClick: () => {
										saveModels();
									},
									children: busy === "models-save" ? t("row.modelsSaving") : t("row.modelsSave")
								})
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "wbm-card",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: "wbm-section-title",
							children: t("row.distributionLabel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "wbm-choices",
							role: "radiogroup",
							"aria-label": t("row.distributionLabel"),
							children: ACCOUNT_DISTRIBUTIONS.map((mode) => {
								const active = distributionOf(config?.distribution ?? "expiry") === mode;
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: active ? "wbm-choice wbm-choice-on" : "wbm-choice",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "radio",
										name: "wbm-distribution",
										checked: active,
										disabled: !configWritable || busy !== void 0,
										onChange: () => {
											writeConfig("distribution", mode);
										}
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "wbm-choice-body",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "wbm-choice-label",
											children: distributionLabel(t, mode)
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "wbm-choice-hint",
											children: distributionHint(t, mode)
										})]
									})]
								}, mode);
							})
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "wbm-card",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								className: "wbm-section-title",
								children: t("row.displayTitle")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "wbm-toggle",
								title: t("row.showCreditsInComposerHint"),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: config?.showCreditsInComposer !== false,
									disabled: !configWritable || busy !== void 0,
									onChange: (event) => {
										writeConfig("showCreditsInComposer", event.target.checked);
									}
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.showCreditsInComposer") })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "wbm-section-hint",
								children: t("row.showCreditsInComposerHint")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "wbm-field",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.expiryWarnDays") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "number",
									min: 1,
									max: 90,
									step: 1,
									value: warnDays,
									disabled: !configWritable || busy !== void 0,
									onChange: (event) => {
										const raw = Number(event.target.value);
										if (!Number.isFinite(raw)) return;
										writeConfig("expiryWarnDays", Math.min(90, Math.max(1, Math.round(raw))));
									}
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "wbm-section-hint",
								children: t("row.expiryWarnDaysHint", {
									min: 1,
									max: 90
								})
							})
						]
					})
				]
			});
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
		function CreditPackages(props) {
			const { t, credits, accountId } = props;
			const [open, setOpen] = (0, react.useState)(true);
			const rows = creditPackageRowsOf(credits);
			if (rows.length === 0) return null;
			const panelId = `wbm-credit-packages-${accountId}`;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "wbm-packages",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "wbm-packages-toggle",
					"aria-expanded": open,
					"aria-controls": panelId,
					onClick: () => {
						setOpen((current) => !current);
					},
					children: t("row.creditPackagesToggle", { count: rows.length })
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
					className: "wbm-packages-list",
					id: panelId,
					children: rows.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
						className: "wbm-packages-row",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wbm-packages-name",
								children: row.packageName
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wbm-packages-amount",
								children: row.amountText
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wbm-muted",
								children: creditPackageWhenText(t, row)
							})
						]
					}, row.key))
				}) : null]
			});
		}
		/**
		* 一行明细的「什么时候」。
		*
		* 周期包说「周期刷新」+ 下次刷新时刻，一次性包说到期时刻；两者都没有时说「无到期
		* 信息」——**不**渲染 `0`、`NaN`、`Invalid Date`，也不编一个假时间。
		*/
		function creditPackageWhenText(t, row) {
			if (row.monthly) {
				const refresh = formatTime(row.refreshAtMs);
				return refresh === void 0 ? t("row.creditPackageMonthly") : `${t("row.creditPackageMonthly")} · ${t("row.creditPackageRefreshes", { time: refresh })}`;
			}
			const expires = formatTime(row.expiresAtMs);
			return expires === void 0 ? t("row.creditPackageNoExpiry") : t("row.creditPackageExpires", { time: expires });
		}
		/** 签到状态那一小段：是否已签 / 连续天数 / 今日可得。 */
		function CheckinLine(props) {
			const { t, status } = props;
			if (status === void 0 || status.active === false) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "wbm-muted",
				children: t("row.checkinDisabled")
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "wbm-account-facts",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: status.todayCheckedIn ? "wbm-tag wbm-tag-ok" : "wbm-tag wbm-tag-warn",
						children: status.todayCheckedIn ? t("row.checkinDone") : t("row.checkinPending")
					}),
					status.streakDays > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "wbm-muted",
						children: t("row.checkinStreak", { days: status.streakDays })
					}) : null,
					status.todayCredit > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "wbm-muted",
						children: t("row.checkinToday", { credit: formatCredits$1(status.todayCredit) })
					}) : null,
					status.isStreakDay && status.streakBonusCredit > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "wbm-muted",
						children: t("row.checkinBonus", {
							days: status.nextStreakDay,
							credit: formatCredits$1(status.streakBonusCredit)
						})
					}) : null
				]
			});
		}
		//#endregion
		//#region src/client/ComposerCredits.tsx
		/**
		* 输入框下方的 WorkBuddy 积分读数（`conversation.input.left`）。
		*
		* ## 形态
		*
		* 一行可点的小读数：`WB 模型 · 1,072` 后面跟着当前账号名。行内**没有**刷新
		* 按钮——这一行与外壳自己的权限 / 模型 / 代理控件共享宽度，每多一个控件都是别人
		* 的空间，手动刷新放在展开的面板里。
		*
		* 点击展开一个锚定在读数上方的面板：一张表，该区域每个账号一行（昵称 + 剩余积分
		* + 到期时间），点行即切换账号。
		*
		* ## 三个刻意的选择
		*
		* 1. **每账号数字只在面板打开时抓。** 读数本身 5 分钟刷一次；如果顺带把每个账号
		*    都读一遍，上游读请求数会乘以账号数——一个没人看的表格不该收这份钱。
		* 2. **读不到的余额显示 `—`，绝不显示 `0`。** 上游在那种情况下就是不返回该字段，
		*    正是为了让这里没法替账号断言一个错误的数字。
		* 3. **失败保留上一次成功的数值**，并在面板底部说明「刷新失败」。读不到 ≠ 余额
		*    变成 0；一个几乎肯定没变的余额，旧数字比空白有用。
		*
		* ## 锚定与关闭
		*
		* `useAnchoredPosition` / `useDismissOnOutsidePointer` 在本文件内就地实现（约 80
		* 行 DOM 几何），不从 `@deepseek-ai/dsh-client-ui-primitives` 导入：那会让这个组件
		* 在 Node 测试里无法渲染（该包会拉 `*.module.css` 与更多 DSH 依赖）。判断逻辑照
		* `plugins/dsh-connect-workbuddy/src/client/popover.ts` 逐条沿用——向上展开、视口
		* 收边、`scroll` capture/resize/自身尺寸变化重测、pointerdown 落在触发器与面板
		* 之外即关闭。
		*
		* @module dsh-connect-workbuddy-models/client/ComposerCredits
		*/
		/**
		* 读数样式在**模块求值阶段**就注入。
		*
		* 设置卡片可能永远不被渲染（用户没打开设置面板），而读数要立刻可用。参考项目
		* 当年把两段样式揉在卡片里，结果在没有卡片渲染的宿主上，读数渲染成一个默认按钮框、
		* 面板因为没有 `position: fixed` 而出现在任何地方都不在的位置上。
		*
		* 幂等靠 `data-plugin-css` 去重：宿主可能把同一个 bundle 求值两次（热重载、
		* profile 里两份条目），重复 `<style>` 不会重复生效，但会让后来者无法判断是否
		* 已经注入过。
		*/
		if (typeof document !== "undefined") {
			const cssId = "dsh-connect-workbuddy-models/composer-credits.css";
			if (document.querySelector(`style[data-plugin-css="${cssId}"]`) === null) {
				const styleTag = document.createElement("style");
				styleTag.dataset["plugin"] = "dsh-connect-workbuddy-models";
				styleTag.dataset["pluginCss"] = cssId;
				styleTag.textContent = WB_MODELS_COMPOSER_CSS;
				document.head.appendChild(styleTag);
			}
		}
		/**
		* 读数自动刷新周期：5 分钟。
		*
		* 积分余额变化的尺度是「多少次模型调用」，不是秒；每次读都是一次上游只读调用。
		*/
		const COMPOSER_CREDITS_REFRESH_INTERVAL_MS = 3e5;
		/** 千分位格式化。非有限数返回 `—`，绝不返回 `0`。 */
		function formatCredits(value) {
			if (value === void 0 || !Number.isFinite(value)) return "—";
			const rounded = Math.round(value);
			try {
				return rounded.toLocaleString("zh-CN");
			} catch {
				return String(rounded);
			}
		}
		/** 把一个毫秒时刻格式化成时钟；无效返回 undefined。 */
		function formatClock(ms) {
			if (ms === void 0 || !Number.isFinite(ms) || ms <= 0) return void 0;
			try {
				return new Date(ms).toLocaleTimeString("zh-CN", {
					hour: "2-digit",
					minute: "2-digit"
				});
			} catch {
				return;
			}
		}
		/** 把一个毫秒时刻格式成本地日期时间；无效返回 undefined。 */
		function formatExpiry(ms) {
			if (ms === void 0 || !Number.isFinite(ms) || ms <= 0) return void 0;
			try {
				return new Date(ms).toLocaleString("zh-CN", {
					month: "2-digit",
					day: "2-digit",
					hour: "2-digit",
					minute: "2-digit"
				});
			} catch {
				return;
			}
		}
		/** 距离某个时刻还有多少整天（向下取整，最小 0）。 */
		function daysUntil(ms, nowMs) {
			if (ms === void 0 || !Number.isFinite(ms)) return void 0;
			return Math.max(0, Math.floor((ms - nowMs) / DAY_MS));
		}
		/**
		* 从 `/status` 的配置回显里取临期窗口（天）。
		*
		* 这里曾经硬编码 `DEFAULT_EXPIRY_WARN_DAYS`，于是同一个数字在三个地方各算一遍：
		* 宿主的排序层按用户窗口选号、宿主探测层按用户窗口算 `expiringSoon`，而面板的
		* 「还有 N 天」标红判据永远是 3 天。用户把提醒改成 30 天，卡片与设置页显示 30 天，
		* 面板却只在 3 天内标红——看起来像「有的账号没被算进临期」。
		*
		* 取值顺序：`config.expiryWarnDays` → 兜底 `DEFAULT_EXPIRY_WARN_DAYS`。读不到配置
		* （老宿主、`/status` 还没回来、字段缺失）时用兜底是**正确**的退化，而不是隐藏：
		* 它不是「账号不可用」这类会让用户困惑的状态，只是标红判据的一个默认值。
		*/
		function warnDaysOf(snapshot) {
			const configured = snapshot?.config?.expiryWarnDays;
			if (typeof configured !== "number" || !Number.isFinite(configured)) return 3;
			return Math.min(90, Math.max(1, Math.round(configured)));
		}
		/** 把状态快照摊成面板行：账号来自快照，数字优先用面板自己抓到的读数。 */
		function accountRowsOf(snapshot, creditsById) {
			return (snapshot?.accounts ?? []).map((reading) => {
				const credits = creditsById[reading.account.id] ?? reading.credits;
				const total = credits?.total;
				const expiry = credits?.nearestExpiryMs;
				return {
					id: reading.account.id,
					name: reading.account.accountName === "" ? reading.account.id.slice(0, 8) : reading.account.accountName,
					selected: reading.account.selected,
					...total === void 0 || !Number.isFinite(total) ? {} : { credits: total },
					...expiry === void 0 || !Number.isFinite(expiry) ? {} : { expiryMs: expiry }
				};
			});
		}
		/**
		* 让一个 `position: fixed` 的浮动元素贴住它的触发器。
		*
		* 用 `useLayoutEffect`：第一次测量发生在打开面板的那次提交里，于是收边用的是真实
		* 尺寸，面板不会先在错的位置闪一下。
		*/
		function useAnchoredPosition(options) {
			const { open, anchorRef, panelRef, side, gap, margin } = options;
			const [position, setPosition] = (0, react.useState)(null);
			(0, react.useLayoutEffect)(() => {
				if (!open) {
					setPosition(null);
					return;
				}
				const place = () => {
					const rect = anchorRef.current?.getBoundingClientRect();
					if (rect === void 0) return;
					const panel = panelRef.current;
					const width = panel?.offsetWidth ?? 0;
					const height = panel?.offsetHeight ?? 0;
					let left = rect.left;
					let top = side === "top" ? rect.top - gap - height : rect.bottom + gap;
					if (width > 0) left = Math.min(Math.max(left, margin), window.innerWidth - width - margin);
					if (height > 0) top = Math.min(Math.max(top, margin), window.innerHeight - height - margin);
					setPosition({
						left,
						top
					});
				};
				place();
				window.addEventListener("scroll", place, true);
				window.addEventListener("resize", place);
				const panel = panelRef.current;
				let observer = null;
				if (typeof ResizeObserver !== "undefined" && panel !== null) {
					observer = new ResizeObserver(place);
					observer.observe(panel);
				}
				return () => {
					observer?.disconnect();
					window.removeEventListener("scroll", place, true);
					window.removeEventListener("resize", place);
				};
			}, [
				open,
				anchorRef,
				panelRef,
				side,
				gap,
				margin
			]);
			return position;
		}
		/** pointerdown 落在触发器与面板之外就关闭。面板被 portal 到 body，所以算「里面」。 */
		function useDismissOnOutsidePointer(root, open, setOpen, portal) {
			(0, react.useEffect)(() => {
				if (!open) return void 0;
				const closeOutside = (event) => {
					if (event.target instanceof Node && root.current?.contains(event.target) !== true && portal?.current?.contains(event.target) !== true) setOpen(false);
				};
				document.addEventListener("pointerdown", closeOutside);
				return () => {
					document.removeEventListener("pointerdown", closeOutside);
				};
			}, [
				root,
				open,
				setOpen,
				portal
			]);
		}
		const identityT = (key) => key;
		/** 尽力解析一份 JSON；失败给出可读错误。 */
		async function readJson(response) {
			let payload = {};
			try {
				payload = await response.json();
			} catch {
				payload = {};
			}
			if (!response.ok) {
				const message = typeof payload["error"] === "string" ? payload["error"] : `HTTP ${response.status}`;
				throw new Error(message);
			}
			return payload;
		}
		/**
		* 读设置分区的当前快照；读不出来就当「不可写」。
		*
		* 分区的 `getSnapshot()` 在它还没挂上、或上游实现换过形状时会抛。这个异常**不能**
		* 冒到渲染层：那条路会把整个读数条（连同账号切换面板）一起炸掉，而用户只是想看
		* 一眼积分。判成「不可写」的后果只是面板里的行不可点，比整块消失轻得多。
		*/
		function snapshotOf(scope) {
			if (scope === void 0) return void 0;
			try {
				return scope.getSnapshot();
			} catch {
				return;
			}
		}
		function ComposerCredits(props) {
			const t = props.t ?? identityT;
			const fetchImpl = props.fetchImpl ?? (typeof fetch === "function" ? fetch : void 0);
			const settingsScope = props.settingsScope;
			const region = props.region ?? (props.provider === void 0 ? void 0 : wbRegionOfProvider(props.provider));
			const [snapshot, setSnapshot] = (0, react.useState)(void 0);
			const [failed, setFailed] = (0, react.useState)(false);
			const [busy, setBusy] = (0, react.useState)(false);
			const [switching, setSwitching] = (0, react.useState)(void 0);
			const [lastRefresh, setLastRefresh] = (0, react.useState)(void 0);
			const [open, setOpen] = (0, react.useState)(false);
			/** 面板自己抓到的每账号读数；只在面板打开期间累积。 */
			const [creditsById, setCreditsById] = (0, react.useState)({});
			const inFlight = (0, react.useRef)(false);
			const mounted = (0, react.useRef)(true);
			const rootRef = (0, react.useRef)(null);
			const panelRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			const position = useAnchoredPosition({
				open: open && region !== void 0,
				anchorRef: rootRef,
				panelRef,
				side: "top",
				gap: 8,
				margin: 12
			});
			useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef);
			/**
			* 读一次该区域的状态文档。
			*
			* 失败时**保留**上一次的值并置 `failed`：读不到不等于余额变成 0。一个几乎肯定
			* 没变的余额，旧数字比空白有用。
			*/
			const fetchStatus = (0, react.useCallback)(async (signal) => {
				if (fetchImpl === void 0 || region === void 0 || inFlight.current) return;
				inFlight.current = true;
				if (mounted.current) setBusy(true);
				try {
					const payload = await readJson(await fetchImpl(withRegion(WB_STATUS_PATH, region), {
						headers: { accept: "application/json" },
						credentials: "same-origin",
						...signal === void 0 ? {} : { signal }
					}));
					if (!mounted.current || signal?.aborted === true) return;
					setSnapshot(payload);
					setLastRefresh(Date.now());
					setFailed(false);
				} catch {
					if (mounted.current && signal?.aborted !== true) setFailed(true);
				} finally {
					inFlight.current = false;
					if (mounted.current) setBusy(false);
				}
			}, [fetchImpl, region]);
			/**
			* 拉每个账号的积分明细，只在面板打开期间付这份钱。
			*
			* 单账号路由逐个读（`/account/credits?accountId=`），不做并发上限以外的优化：
			* 账号数就是本机登录数，个位数。
			*
			* 任一账号失败就跳过它、保留它上一次的值——表格退回状态文档里的数字，于是
			* 「读失败」不会连带把那一行**删掉**或清零。
			*/
			const fetchAccountCredits = (0, react.useCallback)(async (signal) => {
				if (fetchImpl === void 0 || region === void 0) return;
				const accounts = snapshot?.accounts ?? [];
				if (accounts.length === 0) return;
				const settled = await Promise.all(accounts.map(async (reading) => {
					try {
						const credits = (await readJson(await fetchImpl(withAccountId(WB_ACCOUNT_CREDITS_PATH, reading.account.id), {
							headers: { accept: "application/json" },
							credentials: "same-origin",
							...signal === void 0 ? {} : { signal }
						})))["credits"];
						return typeof credits === "object" && credits !== null ? [reading.account.id, credits] : void 0;
					} catch {
						return;
					}
				}));
				if (!mounted.current || signal?.aborted === true) return;
				const readable = settled.filter((entry) => entry !== void 0);
				if (readable.length === 0) {
					setFailed(true);
					return;
				}
				setCreditsById((current) => {
					const next = { ...current };
					for (const [id, credits] of readable) next[id] = credits;
					return next;
				});
				setLastRefresh(Date.now());
			}, [
				fetchImpl,
				region,
				snapshot
			]);
			(0, react.useEffect)(() => {
				if (region === void 0) return void 0;
				let cancelled = false;
				let timer;
				const controller = new AbortController();
				fetchStatus(controller.signal).finally(() => {
					if (cancelled) return;
					timer = window.setInterval(() => {
						fetchStatus(controller.signal);
					}, COMPOSER_CREDITS_REFRESH_INTERVAL_MS);
				});
				return () => {
					cancelled = true;
					if (timer !== void 0) window.clearInterval(timer);
					controller.abort();
				};
			}, [region, fetchStatus]);
			(0, react.useEffect)(() => {
				if (!open || region === void 0) return void 0;
				const controller = new AbortController();
				fetchAccountCredits(controller.signal);
				return () => {
					controller.abort();
				};
			}, [
				open,
				region,
				fetchAccountCredits
			]);
			(0, react.useEffect)(() => {
				if (!open) return void 0;
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);
			/**
			* 切换账号，然后立刻重抓。
			*
			* 走 `/accounts/select?accountId=&region=`。写完之后**必须**重抓：不重抓的话，
			* 读数与面板上的「当前选用」还会描述切换前的那个账号。
			*
			* 空串是一条正式指令：「交还给账户使用方式」。它必须真的出现在 query 里
			* （`?accountId=`），所以不能走 `withAccountAndRegion` —— 那个函数在
			* `accountId === ''` 时会把参数整个丢掉，后端收到的是「参数没传」，只能回 400，
			* 于是「交还」这个能力在 HTTP 面上根本表达不出来。拼 URL 走 `withAccountCleared`。
			*/
			const switchTo = (0, react.useCallback)(async (accountId) => {
				if (fetchImpl === void 0 || region === void 0 || switching !== void 0) return;
				setSwitching(accountId);
				try {
					const url = accountId === "" ? withAccountCleared(WB_ACCOUNTS_SELECT_PATH, region) : withAccountAndRegion(WB_ACCOUNTS_SELECT_PATH, accountId, region);
					await readJson(await fetchImpl(url, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							accept: "application/json"
						},
						credentials: "same-origin"
					}));
					await fetchStatus();
					await fetchAccountCredits();
				} catch {
					if (mounted.current) setFailed(true);
				} finally {
					if (mounted.current) setSwitching(void 0);
				}
			}, [
				fetchImpl,
				region,
				switching,
				fetchStatus,
				fetchAccountCredits
			]);
			if (region === void 0) return null;
			const rows = accountRowsOf(snapshot, creditsById);
			const currentRow = rows.find((row) => row.selected);
			const valueText = formatCredits(currentRow?.credits ?? snapshot?.totalCredits);
			const label = t(region === "cn" ? "composer.pointsCn" : "composer.pointsGlobal");
			const canSwitch = snapshotOf(settingsScope)?.writable === true;
			const nowMs = Date.now();
			const warnDays = warnDaysOf(snapshot);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				ref: rootRef,
				className: "wbm-composer-credits",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: "wbm-composer-trigger",
					"aria-haspopup": "dialog",
					"aria-expanded": open,
					title: failed ? t("composer.refreshFailed") : void 0,
					onClick: () => {
						setOpen(!open);
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							"aria-hidden": "true",
							children: "·"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "wbm-composer-amount",
							children: valueText
						}),
						currentRow === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "wbm-composer-user",
							children: currentRow.name
						}),
						failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "wbm-composer-stale",
							"aria-hidden": "true",
							children: "!"
						}) : null
					]
				}), open && (0, react_dom.createPortal)(/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					ref: panelRef,
					className: "wbm-composer-panel",
					style: position ?? {
						visibility: "hidden",
						left: 0,
						top: 0
					},
					role: "dialog",
					"aria-label": t("composer.panelTitle"),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "wbm-composer-panel-head",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wbm-composer-panel-title",
								children: t(region === "cn" ? "composer.panelTitleCn" : "composer.panelTitleGlobal")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "wbm-composer-panel-refresh",
								disabled: busy || switching !== void 0,
								onClick: () => {
									(async () => {
										await fetchStatus();
										await fetchAccountCredits();
									})();
								},
								children: t("composer.refresh")
							})]
						}),
						rows.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "wbm-composer-panel-empty",
							children: t("composer.noAccounts")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
							className: "wbm-composer-panel-table",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									scope: "col",
									children: t("composer.account")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									scope: "col",
									className: "wbm-composer-panel-num",
									children: t("composer.credits")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									scope: "col",
									className: "wbm-composer-panel-num",
									children: t("composer.expiry")
								})
							] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tbody", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
								className: currentRow === void 0 ? "wbm-composer-panel-row-current" : void 0,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
										scope: "row",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "wbm-composer-row-switch",
											disabled: !canSwitch || switching !== void 0 || currentRow === void 0,
											"aria-label": t("composer.switchToAuto"),
											onClick: () => {
												switchTo("");
											},
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "wbm-composer-row-who",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "wbm-composer-row-name",
													children: t("composer.auto")
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "wbm-composer-row-mark",
													children: currentRow === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "wbm-composer-row-mark-current",
														children: t("composer.current")
													}) : switching === "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("composer.switching") }) : null
												})]
											})
										})
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										className: "wbm-composer-panel-num",
										children: "—"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										className: "wbm-composer-panel-num",
										children: "—"
									})
								]
							}), rows.map((row) => {
								const days = daysUntil(row.expiryMs, nowMs);
								const soon = days !== void 0 && days <= warnDays;
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
									className: row.selected ? "wbm-composer-panel-row-current" : void 0,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
											scope: "row",
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "wbm-composer-row-switch",
												disabled: !canSwitch || switching !== void 0 || row.selected,
												"aria-label": t("composer.switchTo", { account: row.name }),
												onClick: () => {
													switchTo(row.id);
												},
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
													className: "wbm-composer-row-who",
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "wbm-composer-row-name",
														children: row.name
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "wbm-composer-row-mark",
														children: row.selected ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: "wbm-composer-row-mark-current",
															children: t("composer.current")
														}) : switching === row.id ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("composer.switching") }) : null
													})]
												})
											})
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
											className: "wbm-composer-panel-num",
											children: row.credits === void 0 ? "—" : formatCredits(row.credits)
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
											className: soon ? "wbm-composer-panel-num wbm-warn" : "wbm-composer-panel-num",
											children: formatExpiry(row.expiryMs) ?? "—"
										})
									]
								}, row.id);
							})] })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "wbm-composer-panel-foot",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								t("composer.lastRefresh"),
								" ",
								formatClock(lastRefresh) ?? "—"
							] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: region === "cn" ? WB_PROVIDERS.cn : WB_PROVIDERS.global })]
						}),
						failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "wbm-composer-panel-error",
							role: "status",
							children: t("composer.refreshFailed")
						}) : null
					]
				}), document.body)]
			});
		}
		//#endregion
		//#region src/client/ComposerCreditsGate.tsx
		/**
		* `conversation.input.left` 槽位的**门控**。
		*
		* 槽位注册是无条件的：宿主把组件挂进输入框下方之后，它会一直渲染。但我们只在该
		* 会话正用一个本插件的模型时才想露面。这个文件负责这次归属判定，判定通过才渲染
		* `ComposerCredits`，因此读数本身的代码里没有「我该不该出现」这类分支。
		*
		* ## 为什么用宿主的 `modelSelection` 投影
		*
		* 投影是模型选择器写入、也是下一次请求真正要用的，所以读数不可能与实际生效的
		* 模型不一致——不需要本插件自己维护第二份「现在用的是谁」的状态。
		*
		* `next` 优先于 `lastUsed`：用户刚在模型选择器里点了一下、会话还没发出第一条消息
		* 时，`lastUsed` 仍指向上一个用过（或上游解析器默认）的模型。以 `lastUsed` 为准
		* 会让读数短暂挂在**别的** provider 上，是一个用户看得见的错挂。
		*
		* ## 为什么与 `ComposerCredits` 分成两个文件
		*
		* 让「归属判定」可以在没有宿主的测试环境里单独测：入口 import 的是浏览器专属
		* DSH 包，测试环境加载不了，而本模块只依赖 React 与一个窄投影形状。
		*
		* ## 与参考插件的一处差异
		*
		* 参考实现只接受 `useProjection` 钩子（由插槽框架注入）。这里**同时**接受
		* `useProjection` 与一个现成的 `modelSelection` 值：前者是宿主的真实契约，后者让
		* 测试与未来的直接挂载不必伪造一个 Hook。两者都给时以钩子为准——钩子是宿主为
		* 本会话算出来的，比任何调用方传入的快照都新。
		*
		* @module dsh-connect-workbuddy-models/client/ComposerCreditsGate
		*/
		/** 从任意投影值里取出 provider 字符串。裸字符串也接受（宿主某版本就是它）。 */
		function providerOf(candidate) {
			if (typeof candidate === "string") return candidate === "" ? void 0 : candidate;
			if (typeof candidate !== "object" || candidate === null) return void 0;
			const provider = candidate.provider;
			return typeof provider === "string" && provider !== "" ? provider : void 0;
		}
		/**
		* 取出「当前」那次选择：`next` 优先于 `lastUsed`。
		*
		* 导出便于单测：这条优先级是本文件唯一的业务判断。
		*/
		function selectedProviderOf(projection) {
			if (projection === void 0) return void 0;
			if (projection.next !== void 0) return providerOf(projection.next);
			return providerOf(projection.lastUsed);
		}
		/**
		* 把宿主给的 provider id 映射到本插件的区域。
		*
		* 只做一次精确查表，不做前缀/大小写归一化：`workbuddy-models` 与
		* `workbuddy-models-global` 是前缀关系，任何「宽松匹配」都会让国内版把国际版的
		* 读数当成自己的。查表本身用 `hasOwnProperty`（见契约层 `wbRegionOfProvider`），
		* 所以 `constructor` 这类原型键也不会误命中。
		*
		* 不属于本插件时返回 undefined —— 门控据此什么都不渲染。
		*/
		function regionOfProvider(provider) {
			return wbRegionOfProvider(provider);
		}
		/**
		* 读出「在输入框下方显示积分」这个开关。
		*
		* 三条容易被写错的判定，都在这里收口：
		*
		* 1. **缺省是显示**，不是隐藏。只有用户明确关掉（`=== false`）才不渲染。反过来
		*    写（`!== true` 才显示）会让没有设置分区、分区还没读到值、或老版本配置里根本
		*    没有这个字段的会话集体消失——那是「装好了但什么都没出现」的故障形态。
		* 2. 分区不可用（`settingsScope === undefined`）时按缺省处理，**不**当成关闭：
		*    读不到用户的意愿不等于用户说了「不要」。
		* 3. `getSnapshot()` 会抛（分区还没挂上、或上游实现换过形状）。抛出来只说明
		*    「现在读不到」，同样回落到缺省——一个读数条不该因为读配置失败而消失。
		*/
		function composerVisible(value) {
			const live = unwrapVolatileDeep(value);
			if (typeof live !== "object" || live === null) return true;
			return live.showCreditsInComposer !== false;
		}
		/**
		* 安全地读一次设置分区里的当前配置值。
		*
		* `getSnapshot()` 在分区还没挂上、或宿主换过实现形状时会抛。这里吞掉异常并返回
		* `undefined`——调用方（`composerVisible`）把它当「读不到」处理，而不是当「关掉」。
		*/
		function readSettingsValue(scope) {
			if (scope === void 0) return void 0;
			try {
				return scope.getSnapshot()?.value;
			} catch {
				return;
			}
		}
		function ComposerCreditsGate(props) {
			const selectedProvider = selectedProviderOf(props.useProjection === void 0 ? props.modelSelection : props.useProjection("modelSelection"));
			const region = regionOfProvider(selectedProvider);
			if (region === void 0) return null;
			if (!composerVisible(readSettingsValue(props.settingsScope))) return null;
			const provider = selectedProvider;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ComposerCredits, {
				...props.t === void 0 ? {} : { t: props.t },
				provider,
				region,
				...props.settingsScope === void 0 ? {} : { settingsScope: props.settingsScope },
				...props.fetchImpl === void 0 ? {} : { fetchImpl: props.fetchImpl }
			});
		}
		//#endregion
		//#region src/client/WbModelLabel.tsx
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
		/**
		* 本插件注册模型标签座位所用的优先级。
		*
		* 理由见文件头：`0` / `-1` / `-0.5` 已被占用，撞上就是无声的争抢。
		*/
		const MODEL_LABEL_PRIORITY = -.25;
		/** 一份快照被信任多久（毫秒）。 */
		const CACHE_MS = 6e4;
		/** 挂载中的标签多久重读一次时钟（毫秒）。徽标的成立与否随时钟变化。 */
		const TICK_MS = 6e4;
		/** 每个区域一份快照，外加读取时刻。 */
		const caches = /* @__PURE__ */ new Map();
		/**
		* 读一次本区域的快照，短暂复用。
		*
		* `undefined` 表示**不知道** —— 调用方据此什么都不画。凭空的徽标比没有徽标更糟：
		* 它替上游声称了一件上游没说过的事。
		*
		* @param region - 要读哪个区域；两个网关是两份独立目录，问错就是串台。
		* @returns 快照，或 `undefined`（宿主不可达 / 应答不可用）。
		*/
		async function statusNow(region) {
			const cached = caches.get(region);
			if (cached !== void 0 && Date.now() - cached.at < CACHE_MS) return cached.snapshot;
			try {
				const response = await fetch(withRegion(WB_STATUS_PATH, region), {
					headers: { accept: "application/json" },
					credentials: "same-origin"
				});
				if (!response.ok) return void 0;
				const body = await response.json();
				const promos = {};
				const rates = {};
				for (const model of body.models ?? []) {
					if (model.creditMultiplier !== void 0) rates[model.id] = model.creditMultiplier;
					if (model.promos !== void 0 && model.promos.length > 0) promos[model.id] = model.promos;
				}
				const snapshot = {
					levels: body.busyLevels ?? {},
					promos,
					rates
				};
				caches.set(region, {
					snapshot,
					at: Date.now()
				});
				return snapshot;
			} catch {
				return;
			}
		}
		/** 一个共享的一分钟定时器，N 个挂载标签只花一个 timer。 */
		const minuteTicker = {
			timer: void 0,
			listeners: /* @__PURE__ */ new Set()
		};
		/**
		* 挂载期间每分钟重渲染一次。
		*
		* 时钟是徽标的输入：23:00 开窗的折扣，在标签挂着不动的情况下也必须自己出现。
		*
		* @param listener - 每 tick 调用的回调。
		* @returns 退订函数；最后一个监听者离开时停掉共享定时器。
		*/
		function subscribeMinute(listener) {
			minuteTicker.listeners.add(listener);
			if (minuteTicker.timer === void 0) {
				minuteTicker.timer = setInterval(() => {
					for (const each of [...minuteTicker.listeners]) each();
				}, TICK_MS);
				minuteTicker.timer.unref?.();
			}
			return () => {
				minuteTicker.listeners.delete(listener);
				if (minuteTicker.listeners.size === 0 && minuteTicker.timer !== void 0) {
					clearInterval(minuteTicker.timer);
					minuteTicker.timer = void 0;
				}
			};
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
		function splitCatalogRate(name, baseRate, discounted) {
			const match = /(?: · x(\d+(?:\.\d+)?)| · \u514d\u8d39)$/u.exec(name);
			const fromName = match === null ? void 0 : match[1] === void 0 ? 0 : Number(match[1]);
			return {
				base: match === null ? name : name.slice(0, match.index),
				rate: discounted ?? fromName ?? baseRate
			};
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
		function PromoBadge(props) {
			const { promo, compact } = props;
			const language = uiLanguage();
			const label = compact ? promoBadgeShortLabel(promo, language) : promoBadgeLabel(promo, language);
			const color = promoBadgeColor(promo);
			const tooltip = promoBadgeTooltip(promo, language);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				title: tooltip === "" ? void 0 : tooltip,
				style: {
					display: "inline-flex",
					alignItems: "center",
					borderRadius: "6px",
					padding: "0 5px",
					fontSize: "11px",
					lineHeight: "1.6",
					whiteSpace: "nowrap",
					border: "1px solid",
					color: color ?? "var(--dsw-alias-brand-primary,#5686fe)",
					borderColor: color ?? "var(--dsw-alias-brand-primary,#5686fe)"
				},
				children: label
			});
		}
		/** 有状态的那一半：读快照，再按时钟画此刻成立的东西。 */
		function WbModelLabelInner(props) {
			const { modelId, name, region, compact, t } = props;
			const [snapshot, setSnapshot] = (0, react.useState)(void 0);
			const [tick, setTick] = (0, react.useState)(0);
			(0, react.useEffect)(() => {
				let live = true;
				statusNow(region).then((next) => {
					if (!live || next === void 0) return;
					setSnapshot(next);
				});
				return () => {
					live = false;
				};
			}, [modelId, region]);
			(0, react.useEffect)(() => subscribeMinute(() => {
				setTick((count) => count + 1);
			}), []);
			const promos = snapshot?.promos[modelId];
			const promo = promos === void 0 ? void 0 : selectPromoBadge(promos, Date.now());
			const discounted = promos === void 0 ? void 0 : selectPromoMultiplier(promos, Date.now());
			const { base, rate } = splitCatalogRate(name, snapshot?.rates[modelId], discounted);
			const rateText = rate === void 0 ? void 0 : rate === 0 ? t?.("row.modelsFree") : `x${rate.toFixed(2)}`;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: "6px",
					minWidth: 0
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: base }),
					rateText === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: { color: "var(--dsw-alias-label-tertiary,#999)" },
						children: rateText
					}),
					promo === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PromoBadge, {
						promo,
						compact
					})
				]
			});
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
		function WbModelLabel(props) {
			const { provider, model, placement, t } = props;
			const region = wbRegionOfProvider(provider.id);
			if (region === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: model.name });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WbModelLabelInner, {
				modelId: model.id,
				name: model.name,
				region,
				compact: placement !== "trigger",
				...t === void 0 ? {} : { t }
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* 「workbuddy模型」设置页与输入框读数的文案，注册在 `settings.wbmodels`
		* 本地化命名空间下（常量见 `../status-paths.ts` 的 `WB_MODELS_LOCALE_NS`）。
		*
		* `en` 与 `zh` 的 key 保持 1:1：`zh` 的类型显式写成
		* `Record<WbModelsSettingsKey, string>`，于是漏一个键就是编译错误，而不是运行
		* 时渲染出 `undefined`。
		*
		* 命名沿用 `row.*` 前缀习惯（与 `dsh-connect-trae-models`、
		* `dsh-connect-workbuddy` 的卡片一致），便于跨卡片对照键名；输入框读数单独用
		* `composer.*` 前缀，因为它不在卡片里。
		*
		* @module dsh-connect-workbuddy-models/client/locales
		*/
		const en = {
			"row.navLabel": "WorkBuddy Models",
			"row.title": "WorkBuddy Models (dsh-connect-workbuddy-models)",
			"row.desc": "Pool every WorkBuddy sign-in on this machine into one model pool: auto-discovery, check-in, credits and expiry, expiry warnings, scheduled check-in, models and multipliers.",
			"row.loading": "Loading…",
			"row.requestFailed": "Request failed: {message}",
			"row.readonly": "This deployment does not expose plugin settings to the browser, so the switches below are read-only. Account discovery, check-in and model selection still work.",
			"row.refresh": "Refresh",
			"row.refreshAccounts": "Scan accounts again",
			"row.refreshingAccounts": "Scanning…",
			"row.refreshAccountsDone": "{count} account(s) found.",
			"row.refreshModels": "Pull model catalog",
			"row.refreshingModels": "Pulling…",
			"row.refreshModelsDone": "{count} model(s).",
			"row.accountsTitle": "Accounts signed in on this machine",
			"row.accountsEmpty": "No WorkBuddy sign-in was found yet.",
			"row.accountsEmptyHint": "Sign in inside the WorkBuddy desktop app, then choose “Scan accounts again”. Every sign-in on this machine joins the pool — this plugin only reads sign-ins the app already performed and never asks for your password.",
			"row.accountUnknown": "Unnamed account",
			"row.accountInPool": "In pool",
			"row.accountInPoolHint": "Include this account in the pool (uncheck to keep it out without signing out)",
			"row.accountCurrent": "In use",
			"row.accountSourcePath": "from {path}",
			"row.accountSourceDesktop": "desktop sign-in",
			"row.accountSourceDsh": "DSH sign-in",
			"row.regionCn": "domestic",
			"row.regionGlobal": "international",
			"row.rankWhyExcluded": "Rank {rank} · not serving — {reason}",
			"row.rankWhyCurrent": "Serving now · expiring {time}, the earliest of every account in this region",
			"row.rankWhyCurrentNoExpiry": "Serving now · no expiry date (monthly credits refresh, so they cannot be wasted)",
			"row.rankWhyLater": "Rank {rank} · waiting · its credits expire later ({time})",
			"row.rankWhyLaterNoExpiry": "Rank {rank} · waiting · no expiry date, so it queues behind every account that can expire",
			"row.skippedTitle": "Sign-in files that were skipped",
			"row.skippedHint": "These files exist but could not be used. They are listed rather than hidden so a missing account always has a stated reason.",
			"row.skippedReason.encrypted": "The token is encrypted by the system account (Windows builds do this). Re-signing in does not help — this plugin cannot read it, and the existing sign-in stays valid.",
			"row.skippedReason.unreadable": "The file could not be read (permissions or a lock held by the WorkBuddy app).",
			"row.skippedReason.malformed": "The file is readable but its content is not a WorkBuddy sign-in record.",
			"row.checkinDone": "Checked in today",
			"row.checkinPending": "Not checked in yet",
			"row.checkinStreak": "{days}-day streak",
			"row.checkinToday": "Today +{credit}",
			"row.checkinBonus": "{days}-day bonus +{credit}",
			"row.checkinClaim": "Check in",
			"row.checkinClaiming": "Checking in…",
			"row.checkinFailed": "Check-in failed: {message}",
			"row.checkinDisabled": "No check-in programme on this account.",
			"row.checkinUnsupportedRegion": "Check-in is not available for the international region.",
			"row.creditsTotal": "Credits",
			"row.creditsUnknown": "—",
			"row.creditsExpiry": "Expires {time}",
			"row.creditsNoExpiry": "No expiry",
			"row.creditsExpiringSoon": "{amount} credit(s) expire within {days} day(s)",
			"row.creditPackagesToggle": "{count} credit package(s)",
			"row.creditPackageExpires": "expires {time}",
			"row.creditPackageMonthly": "monthly refresh",
			"row.creditPackageRefreshes": "next refresh {time}",
			"row.creditPackageNoExpiry": "no expiry info",
			"row.automationTitle": "Scheduled check-in",
			"row.autoEnabled": "Check in automatically",
			"row.autoEnabledHint": "Runs at the hours below while DSH is open. Nothing is sent when the account is already checked in for the day.",
			"row.autoHours": "Check-in hours",
			"row.autoHoursHint": "Hours are Beijing time. Pick one or more; the default is 09:00.",
			"row.autoClaimBenefits": "Also claim compensation and gift credits",
			"row.autoClaimBenefitsHint": "When a claimable compensation or gift credit exists, claim it in the same run.",
			"benefit.compensation": "Compensation",
			"benefit.gift": "Gift",
			"row.automationSaved": "Scheduled check-in saved.",
			"row.modelsTitle": "Models to show",
			"row.modelsHint": "Unchecked models are hidden from the model picker. Every model is shown by default.",
			"row.modelsEmpty": "No model was reported for this region yet.",
			"row.modelsSelectAll": "Select all",
			"row.modelsSelectNone": "Select none",
			"row.modelsId": "id: {id}",
			"row.modelsContext": "context {count}",
			"row.modelsMaxOutput": "max output {count}",
			"row.modelsFree": "free",
			"row.modelsFetchedAt": "Updated {time}",
			"row.modelsFetchedNever": "Not fetched from upstream yet — showing the built-in list.",
			"row.modelsFetchedStale": " (stale)",
			"row.modelsRefreshing": "Refreshing…",
			"row.modelsAgeSeconds": "{count}s ago",
			"row.modelsAgeMinutes": "{count} min ago",
			"row.modelsAgeHours": "{count} h ago",
			"row.modelsBusyFetchedAt": "Congestion updated {time}",
			"row.modelsBusyNever": "Congestion not fetched yet",
			"row.promoHint": "Promotions and tiers come from WorkBuddy itself; discounts apply upstream.",
			"row.promoUnknown": "Promotion details unavailable",
			"row.modelsSave": "Save model selection",
			"row.modelsSaving": "Saving…",
			"row.modelsSaved": "Model selection saved.",
			"row.modelsDirty": "Unsaved changes",
			"row.distributionLabel": "How accounts are used",
			"row.distribution.priority": "Priority (drain one first)",
			"row.distribution.round-robin": "Round-robin (split evenly)",
			"row.distribution.balanced": "Balanced (idle-weighted)",
			"row.distribution.sticky": "Sticky (one account per chat)",
			"row.distribution.expiry": "Expiry first (use the soonest-expiring account first)",
			"row.distributionHint.priority": "Keeps using one account until its credits run out or the upstream refuses, then moves to the next.",
			"row.distributionHint.round-robin": "Consecutive requests rotate through every account, so spending is split evenly.",
			"row.distributionHint.balanced": "Picks weighted by how long an account has been idle, so one slow account cannot pin the pool to itself.",
			"row.distributionHint.sticky": "Each chat stays on one account, which keeps that account's prompt cache warm; a new chat moves on.",
			"row.distributionHint.expiry": "Always uses the account whose credits expire soonest first, so use-it-or-lose-it credits are not wasted.",
			"row.displayTitle": "Display",
			"row.showCreditsInComposer": "Show remaining credits under the message box",
			"row.showCreditsInComposerHint": "Adds a small readout beside the composer controls, only while one of this plugin's models is selected. Click it to switch accounts.",
			"row.expiryWarnDays": "Warn this many days before credits expire",
			"row.expiryWarnDaysHint": "Between {min} and {max} days. An account holding credits inside this window is highlighted and ranks first under the “expiry first” mode.",
			"row.settingsSaved": "Settings saved.",
			"row.saveFailed": "Could not save: {message}",
			"composer.pointsCn": "WB model",
			"composer.pointsGlobal": "WB model",
			"composer.panelTitle": "WorkBuddy accounts",
			"composer.panelTitleCn": "WorkBuddy accounts — domestic",
			"composer.panelTitleGlobal": "WorkBuddy accounts — international",
			"composer.account": "Account",
			"composer.credits": "Credits",
			"composer.expiry": "Expires",
			"composer.current": "in use",
			"composer.switchTo": "Switch to {account}",
			"composer.auto": "Auto (follow account usage)",
			"composer.switchToAuto": "Hand the choice back to the account usage setting",
			"composer.noAccounts": "No account is signed in for this region.",
			"composer.refreshFailed": "Refresh failed — showing the last value that was read",
			"composer.lastRefresh": "Refreshed",
			"composer.refresh": "Refresh",
			"composer.switching": "Switching…"
		};
		/**
		* 中文文案。
		*
		* 类型写成 `Record<WbModelsSettingsKey, string>` 而不是 `as const`：这样 `zh`
		* 少一个键（或多写一个）都会在编译期被抓住，不必等到界面上看见一个生键名。
		*/
		const zh = {
			"row.navLabel": "workbuddy模型",
			"row.title": "workbuddy模型（dsh-connect-workbuddy-models）",
			"row.desc": "把本机所有 WorkBuddy 登录账号聚合成一个模型池：账号自动发现、签到、积分与到期、临期提醒、自动签到、模型与倍率。",
			"row.loading": "加载中…",
			"row.requestFailed": "请求失败：{message}",
			"row.readonly": "当前宿主没有向浏览器提供插件设置作用域，下面的开关是只读的。账号发现、签到与模型选择仍然可用。",
			"row.refresh": "刷新",
			"row.refreshAccounts": "刷新账号",
			"row.refreshingAccounts": "扫描中…",
			"row.refreshAccountsDone": "找到 {count} 个账号。",
			"row.refreshModels": "拉取模型目录",
			"row.refreshingModels": "拉取中…",
			"row.refreshModelsDone": "{count} 个模型。",
			"row.accountsTitle": "本机已登录的账号",
			"row.accountsEmpty": "还没有发现任何 WorkBuddy 登录。",
			"row.accountsEmptyHint": "在 WorkBuddy 桌面端登录一次，然后点「刷新账号」。本机每一个登录都会自动加入池子——本插件只读取桌面端已经完成的登录，从不索要密码。",
			"row.accountUnknown": "未命名账号",
			"row.accountInPool": "参与池",
			"row.accountInPoolHint": "让这个账号参与池子（取消勾选只是不参与，不会退出登录）",
			"row.accountCurrent": "当前使用",
			"row.accountSourcePath": "来源 {path}",
			"row.accountSourceDesktop": "桌面端登录",
			"row.accountSourceDsh": "DSH 登录",
			"row.regionCn": "国内版",
			"row.regionGlobal": "国际版",
			"row.rankWhyExcluded": "第 {rank} 位 · 未在服务 —— {reason}",
			"row.rankWhyCurrent": "当前在服务 · 积分 {time} 到期，是本区域最早的一个",
			"row.rankWhyCurrentNoExpiry": "当前在服务 · 没有到期时间（月包会刷新，用不完也不会浪费）",
			"row.rankWhyLater": "第 {rank} 位 · 排队中 · 它的积分到期更晚（{time}）",
			"row.rankWhyLaterNoExpiry": "第 {rank} 位 · 排队中 · 没有到期时间，所以排在所有会过期的账号之后",
			"row.skippedTitle": "被跳过的登录文件",
			"row.skippedHint": "这些文件确实存在但用不了。这里列出来而不是让它们消失，这样「少了一个账号」永远有一个可读的原因。",
			"row.skippedReason.encrypted": "令牌被系统账户加密（Windows 版会这样做）。重新登录没用——本插件读不了它，而现有登录仍然有效。",
			"row.skippedReason.unreadable": "文件读不出来（权限问题，或被 WorkBuddy 应用占用）。",
			"row.skippedReason.malformed": "文件能读，但内容不是一份 WorkBuddy 登录记录。",
			"row.checkinDone": "今日已签",
			"row.checkinPending": "今日未签",
			"row.checkinStreak": "连续 {days} 天",
			"row.checkinToday": "今日可得 {credit}",
			"row.checkinBonus": "连续 {days} 天奖励 {credit}",
			"row.checkinClaim": "签到",
			"row.checkinClaiming": "签到中…",
			"row.checkinFailed": "签到失败：{message}",
			"row.checkinDisabled": "该账号没有签到活动。",
			"row.checkinUnsupportedRegion": "国际版暂不支持签到。",
			"row.creditsTotal": "积分",
			"row.creditsUnknown": "—",
			"row.creditsExpiry": "{time} 到期",
			"row.creditsNoExpiry": "无到期时间",
			"row.creditsExpiringSoon": "有 {amount} 分在 {days} 天内到期",
			"row.creditPackagesToggle": "{count} 个积分包",
			"row.creditPackageExpires": "{time} 到期",
			"row.creditPackageMonthly": "周期刷新",
			"row.creditPackageRefreshes": "下次刷新 {time}",
			"row.creditPackageNoExpiry": "无到期信息",
			"row.automationTitle": "自动签到",
			"row.autoEnabled": "自动签到",
			"row.autoEnabledHint": "DSH 开着的时候在下面选定的整点执行。当天已签过的账号不会再发请求。",
			"row.autoHours": "签到时段",
			"row.autoHoursHint": "整点按北京时间。可多选，默认 9 点。",
			"row.autoClaimBenefits": "顺带领取补偿 / 赠礼积分",
			"row.autoClaimBenefitsHint": "存在可领的补偿或赠礼积分时，在同一次运行里领掉。",
			"benefit.compensation": "补偿",
			"benefit.gift": "赠礼",
			"row.automationSaved": "自动签到设置已保存。",
			"row.modelsTitle": "需要显示的模型",
			"row.modelsHint": "取消勾选的模型不会出现在模型选择器里。默认全部显示。",
			"row.modelsEmpty": "该区域还没有任何模型。",
			"row.modelsSelectAll": "全选",
			"row.modelsSelectNone": "全不选",
			"row.modelsId": "id：{id}",
			"row.modelsContext": "上下文 {count}",
			"row.modelsMaxOutput": "最大输出 {count}",
			"row.modelsFree": "免费",
			"row.modelsFetchedAt": "数据更新于 {time}",
			"row.modelsFetchedNever": "还没有从上游取到过模型目录——当前显示的是内置列表。",
			"row.modelsFetchedStale": "（已过期）",
			"row.modelsRefreshing": "正在刷新…",
			"row.modelsAgeSeconds": "{count} 秒前",
			"row.modelsAgeMinutes": "{count} 分钟前",
			"row.modelsAgeHours": "{count} 小时前",
			"row.modelsBusyFetchedAt": "拥挤度更新于 {time}",
			"row.modelsBusyNever": "还没有取到过拥挤度",
			"row.promoHint": "徽标与折扣由 WorkBuddy 上游发布，折扣在上游计费时生效。",
			"row.promoUnknown": "促销信息不可用",
			"row.modelsSave": "保存模型设置",
			"row.modelsSaving": "保存中…",
			"row.modelsSaved": "模型设置已保存。",
			"row.modelsDirty": "有未保存的改动",
			"row.distributionLabel": "账户使用方式",
			"row.distribution.priority": "优先用满（先把一个用完）",
			"row.distribution.round-robin": "轮流使用（平均分摊）",
			"row.distribution.balanced": "均衡（按空闲时长加权）",
			"row.distribution.sticky": "会话粘住（一个会话用一个账号）",
			"row.distribution.expiry": "积分最先到期优先",
			"row.distributionHint.priority": "一直用同一个账号，直到它的积分用完或被上游拒绝，再换下一个。",
			"row.distributionHint.round-robin": "相邻请求依次轮换所有账号，把消耗平均摊开。",
			"row.distributionHint.balanced": "按账号空闲时长加权抽取，避免某个慢账号把池子拴在自己身上。",
			"row.distributionHint.sticky": "一个会话固定用一个账号，这样该账号的 prompt 缓存能一直热着；新会话换下一个。",
			"row.distributionHint.expiry": "优先使用积分最先到期的账号，避免用不完就过期的积分被浪费。",
			"row.displayTitle": "显示",
			"row.showCreditsInComposer": "在输入框下方显示剩余积分",
			"row.showCreditsInComposerHint": "只在当前选中的是本插件的模型时，在输入框控件旁加一行小读数。点它可以切换账号。",
			"row.expiryWarnDays": "积分到期前几天提醒",
			"row.expiryWarnDaysHint": "取值 {min} 到 {max} 天。落在该窗口里的账号会被高亮，并在「积分最先到期优先」模式下排最前。",
			"row.settingsSaved": "设置已保存。",
			"row.saveFailed": "保存失败：{message}",
			"composer.pointsCn": "WB 模型",
			"composer.pointsGlobal": "WB 模型",
			"composer.panelTitle": "WorkBuddy 账号",
			"composer.panelTitleCn": "WorkBuddy 账号 · 国内版",
			"composer.panelTitleGlobal": "WorkBuddy 账号 · 国际版",
			"composer.account": "账号",
			"composer.credits": "剩余积分",
			"composer.expiry": "到期",
			"composer.current": "当前选用",
			"composer.switchTo": "切换到 {account}",
			"composer.auto": "自动（按账户使用方式）",
			"composer.switchToAuto": "交还给账户使用方式，由它决定用哪个账号",
			"composer.noAccounts": "该区域还没有已登录的账号。",
			"composer.refreshFailed": "刷新失败——显示的是上一次读到的数值",
			"composer.lastRefresh": "刷新于",
			"composer.refresh": "刷新",
			"composer.switching": "切换中…"
		};
		//#endregion
		//#region src/client/index.tsx
		/** 稳定的浏览器插件名。 */
		const name = "dsh-connect-workbuddy-models-client";
		/**
		* 设置页与读数需要的客户端服务。
		*
		* 刻意只列两条宿主线都提供的服务，理由见文件头。
		*/
		const inject = ["slots", "locale"];
		/**
		* `cordis.patch.yml` 里挂载本 bundle 的宿主插件条目 id。
		*
		* 0.1.7 线上 `configForms` 以这个 id 寻址。
		*/
		const WB_MODELS_ENTRY_ID = "workbuddy-models";
		/** 注册设置页与输入框读数。 */
		function apply(ctx) {
			try {
				const namespace = WB_MODELS_LOCALE_NS;
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), `${PLUGIN_ID}: settings copy`);
				const t = ctx.locale.bind(namespace);
				const softGet = (serviceName) => ctx.get(serviceName);
				const settingsScope = resolveSettingsScope(softGet);
				ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: WB_MODELS_SETTINGS_NS,
					order: 442,
					label: () => t("row.navLabel"),
					inject: () => settingsScope === void 0 ? { t } : {
						t,
						settingsScope
					}
				}, WbModelsCard));
				const composerSlot = "conversation.input.left";
				try {
					ctx.slots.inject(composerSlot, () => ctx.slots.register({
						name: composerSlot,
						id: `${WB_MODELS_SETTINGS_NS}-composer`,
						order: 4,
						locale: namespace,
						inject: () => settingsScope === void 0 ? { t } : {
							t,
							settingsScope
						}
					}, ComposerCreditsGate));
				} catch (error) {
					console.error(`[${PLUGIN_ID}] 输入框读数插槽注册失败（宿主 provider 不受影响）：`, error);
				}
				const labelSlot = "conversation.input.model.label";
				try {
					ctx.slots.inject(labelSlot, () => ctx.slots.register({
						name: labelSlot,
						id: `${WB_MODELS_SETTINGS_NS}-model-label`,
						priority: MODEL_LABEL_PRIORITY,
						locale: namespace,
						inject: () => ({ t })
					}, WbModelLabel));
				} catch (error) {
					console.error(`[${PLUGIN_ID}] 模型标签插槽注册失败（宿主 provider 不受影响）：`, error);
				}
			} catch (error) {
				console.error(`[${PLUGIN_ID}] 客户端页面加载失败（宿主 provider 不受影响）：`, error);
			}
		}
		/**
		* 绑定卡片读写所用的设置表单，取运行线上实际存在的那一条。
		*
		* 0.1.7 暴露 `configForms.get(entryId)`，以**宿主插件条目 id** 为键——即
		* `cordis.patch.yml` 里注册的 id，而不是 settings 命名空间。0.1.5 暴露
		* `settingsScope.bind({ namespace })`，以宿主侧 `installSection` 注册的命名空间
		* 为键。两个控制器回答同一对方法（`getSnapshot()`、`set(field, value)`），所以
		* 卡片自身不需要按线分支。
		*
		* 两者都不存在时返回 undefined（受限宿主）：卡片退化为只读，这是文档化的降级。
		*/
		function resolveSettingsScope(softGet) {
			const forms = softGet("configForms");
			if (forms !== void 0) {
				let entryId = WB_MODELS_ENTRY_ID;
				try {
					const namespaces = forms.describe().getSnapshot().view?.namespaces ?? [];
					const served = namespaces.find((entry) => entry.ns === WB_MODELS_ENTRY_ID) ?? namespaces.find((entry) => /connect-workbuddy-models/.test(entry.ns));
					if (served !== void 0) entryId = served.ns;
				} catch {}
				return forms.get(entryId);
			}
			const scope = softGet("settingsScope");
			if (scope !== void 0) return scope.bind({ namespace: WB_MODELS_SETTINGS_NS });
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
