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

export const en = {
  // ── 导航行与顶部 ────────────────────────────────────────────────────────
  // 刻意短：设置面板左侧导航列很窄，完整产品名由页面标题承担。
  'row.navLabel': 'WorkBuddy Models',
  'row.title': 'WorkBuddy Models (dsh-connect-workbuddy-models)',
  'row.desc': 'Pool every WorkBuddy sign-in on this machine into one model pool: auto-discovery, check-in, credits and expiry, expiry warnings, scheduled check-in, models and multipliers.',
  'row.loading': 'Loading…',
  'row.requestFailed': 'Request failed: {message}',
  // 只读降级：宿主没有提供服务设置作用域时，开关一律画成禁用而不是假装能改。
  'row.readonly': 'This deployment does not expose plugin settings to the browser, so the switches below are read-only. Account discovery, check-in and model selection still work.',

  // ── 顶部动作 ────────────────────────────────────────────────────────────
  'row.refresh': 'Refresh',
  'row.refreshAccounts': 'Scan accounts again',
  'row.refreshingAccounts': 'Scanning…',
  'row.refreshAccountsDone': '{count} account(s) found.',
  'row.refreshModels': 'Pull model catalog',
  'row.refreshingModels': 'Pulling…',
  'row.refreshModelsDone': '{count} model(s).',

  // ── 账号区 ──────────────────────────────────────────────────────────────
  'row.accountsTitle': 'Accounts signed in on this machine',
  'row.accountsEmpty': 'No WorkBuddy sign-in was found yet.',
  'row.accountsEmptyHint': 'Sign in inside the WorkBuddy desktop app, then choose “Scan accounts again”. Every sign-in on this machine joins the pool — this plugin only reads sign-ins the app already performed and never asks for your password.',
  'row.accountUnknown': 'Unnamed account',
  'row.accountInPool': 'In pool',
  'row.accountInPoolHint': 'Include this account in the pool (uncheck to keep it out without signing out)',
  'row.accountCurrent': 'In use',
  'row.accountSourcePath': 'from {path}',
  'row.accountSourceDesktop': 'desktop sign-in',
  'row.accountSourceDsh': 'DSH sign-in',
  'row.regionCn': 'domestic',
  'row.regionGlobal': 'international',

  // ── 为什么是这个账号（排序理由） ─────────────────────────────────────────
  // 每行都必须让用户能据此采取行动：要么说明「它现在就该服务」，要么说明
  // 「它为什么排在后面」。只写「第 2 位」而不说原因，等于把选择权的后果
  // 藏起来——用户改了「账户使用方式」也验证不了它是否生效。
  'row.rankWhyExcluded': 'Rank {rank} · not serving — {reason}',
  'row.rankWhyCurrent': 'Serving now · expiring {time}, the earliest of every account in this region',
  'row.rankWhyCurrentNoExpiry': 'Serving now · no expiry date (monthly credits refresh, so they cannot be wasted)',
  'row.rankWhyLater': 'Rank {rank} · waiting · its credits expire later ({time})',
  'row.rankWhyLaterNoExpiry': 'Rank {rank} · waiting · no expiry date, so it queues behind every account that can expire',

  // ── 被跳过的凭据文件 ─────────────────────────────────────────────────────
  // MUST be surfaced: without it "2 accounts" and "2 readable of 4 files" look
  // identical on screen, and the user has no way to tell why a sign-in is missing.
  'row.skippedTitle': 'Sign-in files that were skipped',
  'row.skippedHint': 'These files exist but could not be used. They are listed rather than hidden so a missing account always has a stated reason.',
  'row.skippedReason.encrypted': 'The token is encrypted by the system account (Windows builds do this). Re-signing in does not help — this plugin cannot read it, and the existing sign-in stays valid.',
  'row.skippedReason.unreadable': 'The file could not be read (permissions or a lock held by the WorkBuddy app).',
  'row.skippedReason.malformed': 'The file is readable but its content is not a WorkBuddy sign-in record.',

  // ── 签到 ────────────────────────────────────────────────────────────────
  'row.checkinDone': 'Checked in today',
  'row.checkinPending': 'Not checked in yet',
  'row.checkinStreak': '{days}-day streak',
  'row.checkinToday': 'Today +{credit}',
  'row.checkinBonus': '{days}-day bonus +{credit}',
  'row.checkinClaim': 'Check in',
  'row.checkinClaiming': 'Checking in…',
  'row.checkinFailed': 'Check-in failed: {message}',
  'row.checkinDisabled': 'No check-in programme on this account.',
  // 国际版整区不做签到（产品裁定）。这一句替代按钮出现，而不是画一个点了必然
  // 失败的按钮让用户以为是网络问题。
  'row.checkinUnsupportedRegion': 'Check-in is not available for the international region.',

  // ── 积分与到期 ──────────────────────────────────────────────────────────
  'row.creditsTotal': 'Credits',
  // 读不到余额时显示这个，**不是** 0：0 是对账号余额的一句断言。
  'row.creditsUnknown': '—',
  'row.creditsExpiry': 'Expires {time}',
  'row.creditsNoExpiry': 'No expiry',
  'row.creditsExpiringSoon': '{amount} credit(s) expire within {days} day(s)',
  // 摘要行只说「几个包」，不重复总积分：上一行的 Credits 已经答过那个问题。
  'row.creditPackagesToggle': '{count} credit package(s)',
  // 每行只显示「还剩多少 / 总量」。**不**推算已用量：剩下的量才是能花的数，
  // 已用量可以由它减出来，多写一遍只是多一个会算错的地方。
  'row.creditPackageExpires': 'expires {time}',
  'row.creditPackageMonthly': 'monthly refresh',
  'row.creditPackageRefreshes': 'next refresh {time}',
  'row.creditPackageNoExpiry': 'no expiry info',

  // ── 自动签到 ────────────────────────────────────────────────────────────
  'row.automationTitle': 'Scheduled check-in',
  'row.autoEnabled': 'Check in automatically',
  'row.autoEnabledHint': 'Runs at the hours below while DSH is open. Nothing is sent when the account is already checked in for the day.',
  'row.autoHours': 'Check-in hours',
  'row.autoHoursHint': 'Hours are Beijing time. Pick one or more; the default is 09:00.',
  'row.autoClaimBenefits': 'Also claim compensation and gift credits',
  'row.autoClaimBenefitsHint': 'When a claimable compensation or gift credit exists, claim it in the same run.',
  // 两个权益按钮的文案。必须走 locale：写死中文会让英文界面里冒出两个汉字。
  'benefit.compensation': 'Compensation',
  'benefit.gift': 'Gift',
  'row.automationSaved': 'Scheduled check-in saved.',

  // ── 模型区 ──────────────────────────────────────────────────────────────
  'row.modelsTitle': 'Models to show',
  'row.modelsHint': 'Unchecked models are hidden from the model picker. Every model is shown by default.',
  'row.modelsEmpty': 'No model was reported for this region yet.',
  'row.modelsSelectAll': 'Select all',
  'row.modelsSelectNone': 'Select none',
  'row.modelsId': 'id: {id}',
  'row.modelsContext': 'context {count}',
  'row.modelsMaxOutput': 'max output {count}',
  'row.modelsFree': 'free',
  // 数据新鲜度。用户问的是「这些徽标是不是写死的」，所以界面必须给出
  // 「这份数据是哪一刻抓的」，以及抓不到时到底发生了什么。
  'row.modelsFetchedAt': 'Updated {time}',
  'row.modelsFetchedNever': 'Not fetched from upstream yet — showing the built-in list.',
  'row.modelsFetchedStale': ' (stale)',
  'row.modelsRefreshing': 'Refreshing…',
  'row.modelsAgeSeconds': '{count}s ago',
  'row.modelsAgeMinutes': '{count} min ago',
  'row.modelsAgeHours': '{count} h ago',
  'row.modelsBusyFetchedAt': 'Congestion updated {time}',
  'row.modelsBusyNever': 'Congestion not fetched yet',
  // 促销徽标的兜底说明。徽标文字与提示本身来自上游（badge.label / hover.text），
  // 这里只放上游没给时的措辞，以及卡片里那行「这些徽标是什么意思」的说明。
  'row.promoHint': 'Promotions and tiers come from WorkBuddy itself; discounts apply upstream.',
  'row.promoUnknown': 'Promotion details unavailable',
  'row.modelsSave': 'Save model selection',
  'row.modelsSaving': 'Saving…',
  'row.modelsSaved': 'Model selection saved.',
  'row.modelsDirty': 'Unsaved changes',

  // ── 账户使用方式（R4）────────────────────────────────────────────────────
  'row.distributionLabel': 'How accounts are used',
  'row.distribution.priority': 'Priority (drain one first)',
  'row.distribution.round-robin': 'Round-robin (split evenly)',
  'row.distribution.balanced': 'Balanced (idle-weighted)',
  'row.distribution.sticky': 'Sticky (one account per chat)',
  'row.distribution.expiry': 'Expiry first (use the soonest-expiring account first)',
  'row.distributionHint.priority': 'Keeps using one account until its credits run out or the upstream refuses, then moves to the next.',
  'row.distributionHint.round-robin': 'Consecutive requests rotate through every account, so spending is split evenly.',
  'row.distributionHint.balanced': 'Picks weighted by how long an account has been idle, so one slow account cannot pin the pool to itself.',
  'row.distributionHint.sticky': 'Each chat stays on one account, which keeps that account\'s prompt cache warm; a new chat moves on.',
  // R4 的核心句，与 DESIGN.md §5 的 expiry 语义逐字对齐。
  'row.distributionHint.expiry': 'Always uses the account whose credits expire soonest first, so use-it-or-lose-it credits are not wasted.',

  // ── 显示与读数设置 ───────────────────────────────────────────────────────
  'row.displayTitle': 'Display',
  'row.showCreditsInComposer': 'Show remaining credits under the message box',
  'row.showCreditsInComposerHint': 'Adds a small readout beside the composer controls, only while one of this plugin\'s models is selected. Click it to switch accounts.',
  'row.expiryWarnDays': 'Warn this many days before credits expire',
  'row.expiryWarnDaysHint': 'Between {min} and {max} days. An account holding credits inside this window is highlighted and ranks first under the “expiry first” mode.',
  'row.settingsSaved': 'Settings saved.',
  'row.saveFailed': 'Could not save: {message}',

  // ── 输入框读数与账号面板 ──────────────────────────────────────────────────
  'composer.pointsCn': 'WB model',
  'composer.pointsGlobal': 'WB model',
  'composer.panelTitle': 'WorkBuddy accounts',
  'composer.panelTitleCn': 'WorkBuddy accounts — domestic',
  'composer.panelTitleGlobal': 'WorkBuddy accounts — international',
  'composer.account': 'Account',
  'composer.credits': 'Credits',
  'composer.expiry': 'Expires',
  'composer.current': 'in use',
  'composer.switchTo': 'Switch to {account}',
  // 「自动」= 交还给「账户使用方式」。放在 composer.* 而不是 row.*：它与
  // 「切到某个账号」是同一组互斥选项，两条文案要成对出现，隔着几十条别的键
  // 翻译时容易只改一半。
  'composer.auto': 'Auto (follow account usage)',
  'composer.switchToAuto': 'Hand the choice back to the account usage setting',
  'composer.noAccounts': 'No account is signed in for this region.',
  'composer.refreshFailed': 'Refresh failed — showing the last value that was read',
  'composer.lastRefresh': 'Refreshed',
  'composer.refresh': 'Refresh',
  'composer.switching': 'Switching…',
} as const

/** 卡片与读数共用的文案键集合。 */
export type WbModelsSettingsKey = keyof typeof en

/**
 * 中文文案。
 *
 * 类型写成 `Record<WbModelsSettingsKey, string>` 而不是 `as const`：这样 `zh`
 * 少一个键（或多写一个）都会在编译期被抓住，不必等到界面上看见一个生键名。
 */
export const zh: Record<WbModelsSettingsKey, string> = {
  'row.navLabel': 'workbuddy模型',
  'row.title': 'workbuddy模型（dsh-connect-workbuddy-models）',
  'row.desc': '把本机所有 WorkBuddy 登录账号聚合成一个模型池：账号自动发现、签到、积分与到期、临期提醒、自动签到、模型与倍率。',
  'row.loading': '加载中…',
  'row.requestFailed': '请求失败：{message}',
  'row.readonly': '当前宿主没有向浏览器提供插件设置作用域，下面的开关是只读的。账号发现、签到与模型选择仍然可用。',

  'row.refresh': '刷新',
  'row.refreshAccounts': '刷新账号',
  'row.refreshingAccounts': '扫描中…',
  'row.refreshAccountsDone': '找到 {count} 个账号。',
  'row.refreshModels': '拉取模型目录',
  'row.refreshingModels': '拉取中…',
  'row.refreshModelsDone': '{count} 个模型。',

  'row.accountsTitle': '本机已登录的账号',
  'row.accountsEmpty': '还没有发现任何 WorkBuddy 登录。',
  'row.accountsEmptyHint': '在 WorkBuddy 桌面端登录一次，然后点「刷新账号」。本机每一个登录都会自动加入池子——本插件只读取桌面端已经完成的登录，从不索要密码。',
  'row.accountUnknown': '未命名账号',
  'row.accountInPool': '参与池',
  'row.accountInPoolHint': '让这个账号参与池子（取消勾选只是不参与，不会退出登录）',
  'row.accountCurrent': '当前使用',
  'row.accountSourcePath': '来源 {path}',
  'row.accountSourceDesktop': '桌面端登录',
  'row.accountSourceDsh': 'DSH 登录',
  'row.regionCn': '国内版',
  'row.regionGlobal': '国际版',

  // ── 为什么是这个账号（排序理由） ─────────────────────────────────────────
  'row.rankWhyExcluded': '第 {rank} 位 · 未在服务 —— {reason}',
  'row.rankWhyCurrent': '当前在服务 · 积分 {time} 到期，是本区域最早的一个',
  'row.rankWhyCurrentNoExpiry': '当前在服务 · 没有到期时间（月包会刷新，用不完也不会浪费）',
  'row.rankWhyLater': '第 {rank} 位 · 排队中 · 它的积分到期更晚（{time}）',
  'row.rankWhyLaterNoExpiry': '第 {rank} 位 · 排队中 · 没有到期时间，所以排在所有会过期的账号之后',

  'row.skippedTitle': '被跳过的登录文件',
  'row.skippedHint': '这些文件确实存在但用不了。这里列出来而不是让它们消失，这样「少了一个账号」永远有一个可读的原因。',
  'row.skippedReason.encrypted': '令牌被系统账户加密（Windows 版会这样做）。重新登录没用——本插件读不了它，而现有登录仍然有效。',
  'row.skippedReason.unreadable': '文件读不出来（权限问题，或被 WorkBuddy 应用占用）。',
  'row.skippedReason.malformed': '文件能读，但内容不是一份 WorkBuddy 登录记录。',

  'row.checkinDone': '今日已签',
  'row.checkinPending': '今日未签',
  'row.checkinStreak': '连续 {days} 天',
  'row.checkinToday': '今日可得 {credit}',
  'row.checkinBonus': '连续 {days} 天奖励 {credit}',
  'row.checkinClaim': '签到',
  'row.checkinClaiming': '签到中…',
  'row.checkinFailed': '签到失败：{message}',
  'row.checkinDisabled': '该账号没有签到活动。',
  // 国际版整区不做签到（产品裁定）。这一句替代按钮出现，而不是画一个点了必然
  // 失败的按钮让用户以为是网络问题。
  'row.checkinUnsupportedRegion': '国际版暂不支持签到。',

  'row.creditsTotal': '积分',
  'row.creditsUnknown': '—',
  'row.creditsExpiry': '{time} 到期',
  'row.creditsNoExpiry': '无到期时间',
  'row.creditsExpiringSoon': '有 {amount} 分在 {days} 天内到期',
  // 摘要行只说「几个包」，不重复总积分：上一行的「积分」已经答过那个问题。
  'row.creditPackagesToggle': '{count} 个积分包',
  // 每行只显示「还剩多少 / 总量」。**不**推算已用量：剩下的量才是能花的数，
  // 已用量可以由它减出来，多写一遍只是多一个会算错的地方。
  'row.creditPackageExpires': '{time} 到期',
  'row.creditPackageMonthly': '周期刷新',
  'row.creditPackageRefreshes': '下次刷新 {time}',
  'row.creditPackageNoExpiry': '无到期信息',

  'row.automationTitle': '自动签到',
  'row.autoEnabled': '自动签到',
  'row.autoEnabledHint': 'DSH 开着的时候在下面选定的整点执行。当天已签过的账号不会再发请求。',
  'row.autoHours': '签到时段',
  'row.autoHoursHint': '整点按北京时间。可多选，默认 9 点。',
  'row.autoClaimBenefits': '顺带领取补偿 / 赠礼积分',
  'row.autoClaimBenefitsHint': '存在可领的补偿或赠礼积分时，在同一次运行里领掉。',
  'benefit.compensation': '补偿',
  'benefit.gift': '赠礼',
  'row.automationSaved': '自动签到设置已保存。',

  'row.modelsTitle': '需要显示的模型',
  'row.modelsHint': '取消勾选的模型不会出现在模型选择器里。默认全部显示。',
  'row.modelsEmpty': '该区域还没有任何模型。',
  'row.modelsSelectAll': '全选',
  'row.modelsSelectNone': '全不选',
  'row.modelsId': 'id：{id}',
  'row.modelsContext': '上下文 {count}',
  'row.modelsMaxOutput': '最大输出 {count}',
  'row.modelsFree': '免费',
  'row.modelsFetchedAt': '数据更新于 {time}',
  'row.modelsFetchedNever': '还没有从上游取到过模型目录——当前显示的是内置列表。',
  'row.modelsFetchedStale': '（已过期）',
  'row.modelsRefreshing': '正在刷新…',
  'row.modelsAgeSeconds': '{count} 秒前',
  'row.modelsAgeMinutes': '{count} 分钟前',
  'row.modelsAgeHours': '{count} 小时前',
  'row.modelsBusyFetchedAt': '拥挤度更新于 {time}',
  'row.modelsBusyNever': '还没有取到过拥挤度',
  'row.promoHint': '徽标与折扣由 WorkBuddy 上游发布，折扣在上游计费时生效。',
  'row.promoUnknown': '促销信息不可用',
  'row.modelsSave': '保存模型设置',
  'row.modelsSaving': '保存中…',
  'row.modelsSaved': '模型设置已保存。',
  'row.modelsDirty': '有未保存的改动',

  'row.distributionLabel': '账户使用方式',
  'row.distribution.priority': '优先用满（先把一个用完）',
  'row.distribution.round-robin': '轮流使用（平均分摊）',
  'row.distribution.balanced': '均衡（按空闲时长加权）',
  'row.distribution.sticky': '会话粘住（一个会话用一个账号）',
  'row.distribution.expiry': '积分最先到期优先',
  'row.distributionHint.priority': '一直用同一个账号，直到它的积分用完或被上游拒绝，再换下一个。',
  'row.distributionHint.round-robin': '相邻请求依次轮换所有账号，把消耗平均摊开。',
  'row.distributionHint.balanced': '按账号空闲时长加权抽取，避免某个慢账号把池子拴在自己身上。',
  'row.distributionHint.sticky': '一个会话固定用一个账号，这样该账号的 prompt 缓存能一直热着；新会话换下一个。',
  'row.distributionHint.expiry': '优先使用积分最先到期的账号，避免用不完就过期的积分被浪费。',

  'row.displayTitle': '显示',
  'row.showCreditsInComposer': '在输入框下方显示剩余积分',
  'row.showCreditsInComposerHint': '只在当前选中的是本插件的模型时，在输入框控件旁加一行小读数。点它可以切换账号。',
  'row.expiryWarnDays': '积分到期前几天提醒',
  'row.expiryWarnDaysHint': '取值 {min} 到 {max} 天。落在该窗口里的账号会被高亮，并在「积分最先到期优先」模式下排最前。',
  'row.settingsSaved': '设置已保存。',
  'row.saveFailed': '保存失败：{message}',

  'composer.pointsCn': 'WB 模型',
  'composer.pointsGlobal': 'WB 模型',
  'composer.panelTitle': 'WorkBuddy 账号',
  'composer.panelTitleCn': 'WorkBuddy 账号 · 国内版',
  'composer.panelTitleGlobal': 'WorkBuddy 账号 · 国际版',
  'composer.account': '账号',
  'composer.credits': '剩余积分',
  'composer.expiry': '到期',
  'composer.current': '当前选用',
  'composer.switchTo': '切换到 {account}',
  'composer.auto': '自动（按账户使用方式）',
  'composer.switchToAuto': '交还给账户使用方式，由它决定用哪个账号',
  'composer.noAccounts': '该区域还没有已登录的账号。',
  'composer.refreshFailed': '刷新失败——显示的是上一次读到的数值',
  'composer.lastRefresh': '刷新于',
  'composer.refresh': '刷新',
  'composer.switching': '切换中…',
}
