// dsh-connect-workbuddy-models 宿主入口。
//
// cordis 插件 id：dsh-connect-workbuddy-models。这里装配六件套：
//   accounts（凭据发现）→ pool（多账号池）→ probe（积分/到期聚合）
//   + catalog（模型目录与倍率）+ shim（回环 OpenAI 端点 + 容错换号）
//   + adapter（pi-ai 路由）+ scheduler（签到与权益自动化）
//
// 同时把上游客户端、账号发现、目录层与适配器工厂的公共 API 再导出，供测试与
// 下游直接使用（不必为了一个纯函数去 import 整份插件入口）。
//
// @module dsh-connect-workbuddy-models/index

import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import { discoverAccounts, WbAccountPool } from './accounts.ts'
import type { WbDiscoveredAccount, WbPickResult } from './accounts.ts'
import { createWbAdapter } from './adapter.ts'
import type { WbAdapter } from './adapter.ts'
import { loadLedger as loadLedgerFrom, saveLedger as saveLedgerTo } from './account-store.ts'
import { WbCatalogs } from './catalog.ts'
import { aggregateCredits, probeAccounts, toCheckinStatus } from './probe.ts'
import type { WbAccountProbe } from './probe.ts'
import { WbScheduler } from './scheduler.ts'
import type { AutomationLedger } from './scheduler.ts'
import { createWbShim } from './shim.ts'
import type { WbShim } from './shim.ts'
import {
  ACCOUNT_DISTRIBUTIONS,
  DEFAULT_ACCOUNT_DISTRIBUTION,
  DEFAULT_EXPIRY_WARN_DAYS,
  EXPIRY_WARN_DAYS_MAX,
  EXPIRY_WARN_DAYS_MIN,
  PLUGIN_ID,
  unwrapVolatileDeep,
  WB_MODELS_SETTINGS_NS,
  WB_PROVIDERS,
  WB_REGIONS,
} from './status-paths.ts'
import type {
  AccountDistribution,
  WbAutomationConfig,
  WbModelsConfig,
  WbRegion,
} from './status-paths.ts'
import { WbUpstreamClient } from './upstream.ts'
import type { WbChatResult, WbUpstreamModel } from './upstream.ts'
import { registerWbStatusRoutes } from './web-status.ts'
import { WB_MODELS_VERSION } from './version.ts'

export { WB_MODELS_VERSION }

/** 依赖注入：LLM seam（注册 provider/adapter）与 settings（挂卡片）。 */
export const inject = ['llm', 'settings']

/**
 * 把一个 schema 字段标记为 volatile。
 *
 * 0.1.7 线**要求**一个 entry 至少有一个 volatile 字段，否则 settings 写入闸门
 * 直接拒绝（"Plugin entry ... has no volatile fields"）且 `describe()` 跳过它 ——
 * 卡片既渲染不出也存不下。0.1.5 线上这个标记退化为恒等操作。
 */
function asVolatile<S>(schema: S): S {
  const candidate = schema as unknown as { volatile?: () => S }
  return typeof candidate.volatile === 'function' ? candidate.volatile() : schema
}

// ── 配置 schema ───────────────────────────────────────────────────────────

/**
 * 自动签到 schema。
 *
 * `enabled` 带真实默认值 `false`：调度器每个 tick 都读它，字段缺失必须意味着
 * 「关闭」而不是 `undefined`。开启会**代用户向上游发起写请求**，所以缺省值不能
 * 是「开」。
 */
const automationSchema = z.object({
  enabled: z.boolean().default(false).description('运行每日积分自动化（签到）'),
  checkinHours: z.array(z.number().step(1).min(0).max(23)).default([9])
    .description('每日签到的北京时间整点列表'),
  claimBenefits: z.boolean().default(false).description('顺带领取可领的补偿 / 赠礼'),
})

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
export const Config = z.object({
  enabled: asVolatile(z.boolean().default(true).description('启用 WorkBuddy 模型池')),
  distribution: asVolatile(
    z.union([...ACCOUNT_DISTRIBUTIONS] as AccountDistribution[]).default(DEFAULT_ACCOUNT_DISTRIBUTION)
      .description(
        '账户使用方式：priority（抽干一个）、round-robin（依次轮转）、balanced（余额加权随机）、'
        + 'sticky（每对话钉一个）、expiry（先花最先到期的积分）',
      ),
  ),
  enabledModelIds: asVolatile(z.array(z.string()).default([])
    .description('国内版要显示的模型；空数组 = 全部显示')),
  enabledModelIdsGlobal: asVolatile(z.array(z.string()).default([])
    .description('国际版要显示的模型；空数组 = 全部显示')),
  accountsEnabled: asVolatile(z.array(z.string()).default([])
    .description('参与池的账号 id；空数组 = 全部发现的账号都参与')),
  orderAccountIds: asVolatile(z.array(z.string()).default([])
    .description('用户手动排序的账号 id（排在前面的优先）')),
  showCreditsInComposer: asVolatile(z.boolean().default(true)
    .description('在输入框下方显示当前账号与剩余总积分')),
  expiryWarnDays: asVolatile(z.number().step(1).min(EXPIRY_WARN_DAYS_MIN).max(EXPIRY_WARN_DAYS_MAX)
    .default(DEFAULT_EXPIRY_WARN_DAYS).description('临期提醒阈值（天）')),
  automation: asVolatile(automationSchema.description('每日签到与权益自动化')),
  accounts: asVolatile(z.object({
    cn: z.string().description('国内版当前使用账号 id（空 = 交给账户使用方式决定）'),
    global: z.string().description('国际版当前使用账号 id（空 = 交给账户使用方式决定）'),
  }).default({})),
}) as unknown as z<WbModelsConfig>

// ── 装配 ──────────────────────────────────────────────────────────────────

/** 装配期需要跨函数共享的可变句柄。 */
interface WbCore {
  client: WbUpstreamClient
  pool: WbAccountPool
  catalogs: WbCatalogs
  scheduler: WbScheduler
}

/**
 * 构造无生命周期的核心对象。
 *
 * 与 `apply` 分开是为了让测试能 `createCore()` 拿到池/目录/调度器，而不必伪造一个
 * 完整的 cordis context。这里**不**装定时器、不绑端口、不读配置。
 */
export function createWbCore(options: {
  logger?: {
    info?(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
  }
  /** 账本持久化钩子：调度器每次产出所得后调它。缺省时账本只活在内存里。 */
  saveLedger?: (ledger: AutomationLedger) => void | Promise<void>
} = {}): WbCore {
  const logger = options.logger
  const client = new WbUpstreamClient(message => {
    logger?.warn(`dsh-connect-workbuddy-models: ${message}`)
  })
  const pool = new WbAccountPool({ ...logger === undefined ? {} : { logger } })
  const catalogs = new WbCatalogs()
  const scheduler = new WbScheduler({
    pool,
    client,
    ...logger === undefined ? {} : { logger },
    ...options.saveLedger === undefined ? {} : { saveLedger: options.saveLedger },
  })
  return { client, pool, catalogs, scheduler }
}

export function apply(ctx: Context, config: WbModelsConfig = {} as WbModelsConfig): void {
  const core = createWbCore({
    logger: ctx.logger,
    // 账本持久化在构造时就交给调度器：它在每次产出所得后自己调这个钩子，
    // 早于 apply 末尾那次 applyLedger —— 那种「先跑再装钩子」的顺序会让启动
    // 当天的第一轮所得落不了盘。
    saveLedger: ledger => { void saveLedgerTo(PLUGIN_ID, ledger, ctx.logger) },
  })

  let stopped = false
  let releaseProviders: (() => void) | undefined
  /** 目录变化后重建 picker；provider 注册完成前是空操作。 */
  let invalidateCatalog: () => void = () => {}

  /** 每区域的 shim。两区域互不影响：一个绑端口失败不该让另一个消失。 */
  const shims: Partial<Record<WbRegion, WbShim>> = {}
  for (const region of WB_REGIONS) {
    shims[region] = createWbShim({
      pool: core.pool,
      client: core.client,
      catalog: core.catalogs.of(region),
      region,
      // 用 getter 而不是快照：设置页改完立即生效。`liveConfig()` 每次读都重新剥
      // volatile 活引用，所以这里拿到的永远是当前值。
      expiryWarnDays: () => liveConfig().expiryWarnDays,
      logger: ctx.logger,
    })
  }

  /** 深剥后的当前配置。每次读都重新剥：0.1.7 上字段是活引用。 */
  const liveConfig = (): WbModelsConfig => unwrapVolatileDeep(config) as WbModelsConfig

  // ── 凭据发现与积分探测 ────────────────────────────────────────────────

  /**
   * 重扫本机凭据并刷新每个账号的积分读数。
   *
   * 探测用**用户配置的 `expiryWarnDays`** 聚合临期窗口。这一点不能省：排序层
   * （`rankAccounts`）内部的兜底窗口固定为 3 天，如果这里照抄上游字段或走兜底，
   * 用户的阈值设置就只影响 UI 显示、完全不影响「谁排第一」——那正是 R3 要的行为
   * 反过来的样子。
   */
  const rescan = async (): Promise<void> => {
    const result = await discoverAccounts()
    core.pool.applyDiscovery(result)
    if (result.skipped.length > 0) {
      // 跳过文件必须说出来：否则「2 个账号」与「4 个文件里 2 个读不了」在界面上
      // 一模一样，而 encrypted 的成因是桌面端加密、重新登录并不能解决。
      ctx.logger.warn?.(
        `dsh-connect-workbuddy-models: 跳过 ${result.skipped.length} 个凭据文件（`
        + `${result.skipped.map(file => `${file.path}: ${file.reason}`).join(', ')}）`,
      )
    }
    const warnDays = liveConfig().expiryWarnDays
    const probed = await probeAccounts(
      result.accounts,
      async account => ({
        credits: await core.client.fetchCredits(account.credential),
        checkin: await core.client.fetchCheckinStatus(account.credential),
      }),
      { warnDays: warnDays ?? DEFAULT_EXPIRY_WARN_DAYS, delayMs: 150 },
    )
    for (const reading of probed) {
      if (reading.credits !== undefined) core.pool.noteCredits(reading.accountId, reading.credits)
      // 签到状态也存进池：`/status` 只读缓存、不发上游请求（卡片每几秒轮询一次，
      // 每次都去问会让 4 个账号 × 每分钟 12 次变成常态流量）。
      if (reading.checkin !== undefined) core.pool.noteCheckin(reading.accountId, reading.checkin)
    }
    const unread = probed.filter(reading => reading.credits === undefined).length
    ctx.logger.info?.(
      `dsh-connect-workbuddy-models: 发现 ${result.accounts.length} 个账号`
      + `（${WB_REGIONS.map(region => `${region}=${result.accounts.filter(a => a.region === region).length}`).join(' ')}）`
      + (unread === 0 ? '' : `，${unread} 个读不出余额`),
    )
  }

  /**
   * 播种某一区域的实时模型目录。
   *
   * 静态 fallback 名册保证 provider 永不为空；实时目录只用来拿到真实倍率与新增
   * 模型。区域内逐账号尝试：池里任一账号的凭据都可能已被上游吊销（401），而播种
   * 只需要一个健康账号，只赌队首会让一份死 token 拖垮整个区域的实时目录。
   */
  const seedRegion = async (region: WbRegion): Promise<void> => {
    const accounts = core.pool.listRegion(region)
      .map(entry => entry.account)
      .filter(account => core.pool.exclusionReason(core.pool.entryOf(account)) === undefined)
    const catalog = core.catalogs.of(region)
    if (accounts.length === 0) {
      ctx.logger.info?.(`dsh-connect-workbuddy-models: 尚无 ${region} 可用账号；保留静态 ${region} 目录`)
      return
    }
    const failures: string[] = []
    for (const account of accounts) {
      try {
        const models: readonly WbUpstreamModel[] = await core.client.fetchModels(
          account.credential,
          undefined,
          catalog.all().map(model => model.id),
        )
        if (catalog.applyFetch(models)) invalidateCatalog()
        // 目录抓取内含一次拥挤度请求（`withBusyLevels`），所以这次成功同样意味着
        // 拥挤度有了新鲜值。不记这一笔的话，CN 区每次目录刷新后仍会立刻判定拥挤度
        // 过期，白跑一次 `/v2/chat/busy`。
        if (region === 'cn') busyFetchedAt.set(region, Date.now())
        applyConfigFromSource()
        ctx.logger.info?.(`dsh-connect-workbuddy-models: ${region} 目录已播种 ${models.length} 个模型`)
        return
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push(`${account.label}: ${message}`)
        ctx.logger.warn(
          `dsh-connect-workbuddy-models: ${region} 账号 ${account.label} 目录播种失败，尝试下一个账号`,
          error,
        )
      }
    }
    const message = failures.join(' | ')
    catalog.noteFetchFailure(message)
    ctx.logger.warn(
      `dsh-connect-workbuddy-models: ${region} 模型目录不可用，使用静态回退（倍率可能未知）`,
      message,
    )
    // 全部失败时也要重新贴合选择：目录可能刚从实时退回静态。
    applyConfigFromSource()
  }

  const refreshModels = async (region: WbRegion): Promise<void> => {
    await seedRegion(region)
  }

  /**
   * 拥挤度最近一次**成功**抓取的时刻，按区域记。
   *
   * 与目录的 `catalog.lastFetchedAtMs` 分开维护，因为这是两条独立的上游链路：
   * `/v2/chat/busy` 是分钟级事实，`/v3/config` 是小时级事实。共用一条 TTL 会逼出
   * 「为了拥挤度把大文档每分钟读一遍」或「拥挤度 5 分钟才更新一次」两种坏结果。
   *
   * 失败**不**推进这个时钟：否则上游一直不通时 TTL 永不到期，自动刷新就被永久
   * 饿死——这与 `WbCatalog.lastFetchedAtMs` 是同一条理由。
   */
  const busyFetchedAt = new Map<WbRegion, number>()

  /**
   * 只刷新拥挤度，不动目录。
   *
   * 逐个账号试而不是只赌队首：与 `seedRegion` 同一条理由——一份被上游吊销的 token
   * 不该让整个区域的拥挤度一直显示成过期。
   *
   * 国际区直接返回且**不**推进时间戳：`/v2/chat/busy` 在国际网关实测 404，发出去
   * 只是多一个注定失败的往返。时钟不动，界面就会把它显示成「从未取到」——那是事实。
   */
  const refreshBusy = async (region: WbRegion): Promise<void> => {
    if (region !== 'cn') return
    const catalog = core.catalogs.of(region)
    const ids = catalog.all().map(model => model.id)
    if (ids.length === 0) return
    const accounts = core.pool.listRegion(region)
      .map(entry => entry.account)
      .filter(account => core.pool.exclusionReason(core.pool.entryOf(account)) === undefined)
    for (const account of accounts) {
      try {
        const levels = await core.client.fetchModelBusy(account.credential, ids)
        // 只改拥挤度，不重建名册：重建名册是目录刷新的职责。
        catalog.applyBusy(levels)
        busyFetchedAt.set(region, Date.now())
        invalidateCatalog()
        return
      } catch (error: unknown) {
        ctx.logger.warn(
          `dsh-connect-workbuddy-models: ${region} 账号 ${account.label} 拥挤度刷新失败，尝试下一个账号`,
          error,
        )
      }
    }
  }

  // ── 配置应用 ──────────────────────────────────────────────────────────

  /**
   * 把当前配置施加到池、目录、调度器与选号。
   *
   * 必须存在且**启动时调一次**：0.1.7 上的编辑以 `loader/volatile-update` 广播
   * 回来（那是监听器，启动时不触发）。没有这一步重应用，池/目录/调度器会停在构造
   * 默认值上，每次重启都静默回退成「全部默认」。
   */
  const applyConfigFromSource = (): void => {
    const live = liveConfig()

    // 空数组在**两处**都表示「不过滤」：这里折成缺省，catalog 层也把空数组当全部。
    // 丢失选择必须退化为「不筛选」，绝不能退化为「一个都不要」——后者会让配置界面
    // 看不到任何可选模型。
    core.pool.applyConfig({
      enabledIds: live.accountsEnabled ?? [],
      orderIds: live.orderAccountIds ?? [],
      distribution: (live.distribution ?? DEFAULT_ACCOUNT_DISTRIBUTION) as AccountDistribution,
      // 用户的临期窗口。池只是转交者：它把值传给 `rankAccounts` 的第 5 个实参，
      // 让排序层的兜底推算与探测层的显式聚合用同一个窗口。
      expiryWarnDays: live.expiryWarnDays ?? DEFAULT_EXPIRY_WARN_DAYS,
    })
    core.catalogs.applySelection('cn', live.enabledModelIds ?? [])
    core.catalogs.applySelection('global', live.enabledModelIdsGlobal ?? [])

    // 用户显式选的当前账号优先级高于任何分布。空串 = 交还给分布。
    const cn = live.accounts?.cn
    core.pool.setPreferred('cn', cn === undefined || cn === '' ? undefined : cn)
    const global = live.accounts?.global
    core.pool.setPreferred('global', global === undefined || global === '' ? undefined : global)

    const automation: WbAutomationConfig = {
      enabled: live.automation?.enabled === true,
      checkinHours: live.automation?.checkinHours ?? [9],
      claimBenefits: live.automation?.claimBenefits === true,
    }
    core.scheduler.applyConfig(automation)

    // 两个区域的目录可用性跟着插件总开关走：关掉插件后 provider 仍注册着（摘掉
    // 路由要重建注册），但一个模型都不暴露，等于「用户看不到它」。
    for (const region of WB_REGIONS) {
      core.catalogs.of(region).setUsable(live.enabled !== false)
    }
    invalidateCatalog()
  }

  // ── settings 卡片：双线路兼容 ─────────────────────────────────────────
  //
  // 0.1.5  SettingsProvider.installSection(owner, ns, schema, entry, hooks)
  // 0.1.7  SettingsForms.configure({auto}, owner) 注册呈现策略，编辑以
  //        `loader/volatile-update` 事件广播（0.1.7 上调 installSection 会以
  //        "is not a function" 抛出）。
  // 两条都探测调用：只认一条会让另一个版本线上卡片静默消失。
  const settingsService = (ctx as unknown as {
    settings?: {
      installSection?: (
        owner: unknown,
        ns: string,
        schema: unknown,
        entry: unknown,
        hooks?: { onChange?(): void },
      ) => void
      configure?: (presentation: { auto?: boolean }, owner?: unknown) => () => void
      update?: (ns: string, patch: Record<string, unknown>) => Promise<void> | void
    }
  }).settings

  /**
   * `settings.update` 在运行线上期望的命名空间。
   *
   * 0.1.5 按插件经 `installSection` 注册的**命名空间**解析写入器；0.1.7 起改为按
   * **宿主插件条目 id** 解析（`configEditor.entries().find(row => row.options.id === ns)`），
   * 而 profile patch 选的就是那个 id —— 桌面宿主把本插件挂成 `workbuddy-models`
   * （见 cordis.patch.yml），但市场安装可能包一层（`mkt-...`）或经 `include` 行挂载。
   * 唯一正确答案是问 fiber 要它自己的 entry id；硬猜自己的 namespace 会让每次保存
   * 都抛「No configurable plugin entry」——这正是「模型管理保存无效」的根因。
   */
  const settingsWriteNs: string = typeof settingsService?.installSection === 'function'
    ? WB_MODELS_SETTINGS_NS
    : (() => {
        try {
          const entryId = (ctx.fiber as unknown as { entry?: { options?: { id?: string } } })?.entry?.options?.id
          return entryId === undefined || entryId === '' ? WB_MODELS_SETTINGS_NS : entryId
        } catch {
          return WB_MODELS_SETTINGS_NS
        }
      })()

  if (settingsService !== undefined) {
    if (typeof settingsService.installSection === 'function') {
      // 0.1.5：交出命名空间，让 provider 拥有该文档。
      //
      // 配置先过 `unwrapVolatileDeep`：volatile 字段是活 `{get(): T}` 引用，而
      // provider 会校验并 structuredClone 整个对象 —— 残留引用会让校验失败、
      // 命名空间注册不上、卡片静默消失。
      settingsService.installSection(
        ctx,
        WB_MODELS_SETTINGS_NS,
        Config,
        unwrapVolatileDeep(config),
        { onChange() { applyConfigFromSource() } },
      )
    }
    if (typeof settingsService.configure === 'function') {
      // 0.1.7：宿主从这个 entry 推导表单，并把编辑持久化进 profile patch。
      // 经 `ctx.effect` 注册让 disposer 绑在本插件生命周期上。
      ctx.effect(() => settingsService.configure?.({ auto: true }, ctx.fiber) ?? (() => {}))
    }
    if (typeof settingsService.installSection !== 'function' && typeof settingsService.configure !== 'function') {
      ctx.logger.warn?.('dsh-connect-workbuddy-models: settings 服务既没有 installSection 也没有 configure；卡片不会挂载')
    }
  }

  // 0.1.7 上保存的编辑落在 profile patch 里并以 `loader/volatile-update` 广播。
  // 在这里重应用，才让卡片上的保存无需重启宿主就生效。该事件在 0.1.5 上不存在，
  // 那条线走上面的 hooks.onChange，所以这里只是永不触发。
  ;(ctx as unknown as { on(name: string, listener: () => void): unknown })
    .on('loader/volatile-update', () => { applyConfigFromSource() })

  /** 把一次卡片写入落到 settings。 */
  const writeConfig = async (patch: Record<string, unknown>): Promise<void> => {
    // 必须**方法调用**（`settingsService.update(...)`），不能先把 `update` 赋给局部变量
    // 再由那个变量调用——那样等于把方法从对象上摘下来，调用时 `this` 是 undefined，
    // 而宿主的 `update` 第一行就是 `this.write(...)`：
    //   async update(ns, patch, expectedRevision) {
    //     const input = cloneJsonShaped(patch)
    //     await this.write(ns, current => mergeLayers(current, input), expectedRevision)
    //   }
    // 于是每次都抛 `TypeError: Cannot read properties of undefined (reading 'write')`，
    // 三条写路由（账户切换 / 自动化 / 模型显示）全部 500。
    // 也不用 `.bind(settingsService)`：那是把一个明确的对象依赖藏进闭包，换 writer 时会漏改，
    // 并且让「这个方法属于谁」在代码里消失。
    if (typeof settingsService?.update !== 'function') {
      throw new Error('settings 服务不可用；改动没有保存')
    }
    await settingsService.update(settingsWriteNs, patch)
    // 写入后立即重应用：0.1.7 的编辑通常经 loader/volatile-update 广播回来，但那条
    // 路对卡片自身的写入不保证触发顺序，主动重应用才能让开关立刻生效。
    applyConfigFromSource()
  }

  // 启动即应用一次已保存配置。
  applyConfigFromSource()

  // ── 生命周期 ──────────────────────────────────────────────────────────

  const stopAll = (): void => {
    stopped = true
    core.scheduler.dispose()
    releaseProviders?.()
    releaseProviders = undefined
    for (const region of WB_REGIONS) void shims[region]?.close()
  }
  ctx.effect(() => stopAll)

  // ── web 路由 ──────────────────────────────────────────────────────────
  //
  // `webServer` 是**可选**服务：无头 profile（CLI、测试）上没有它，此时这些路由
  // 根本不挂、卡片退化成离线横幅 —— 而 provider 照常服务模型。因此必须用
  // `ctx.inject(['webServer'], ...)` 而不是直接调 `ctx.webServer.register`：后者在
  // 没有该服务时会以「Cannot read properties of undefined (reading 'register')」
  // 抛出，把**整个插件**的 apply 弄崩（不只是卡片），连 provider 都注册不上。
  ctx.inject(['webServer'], webCtx => registerWbStatusRoutes(webCtx, {
    pool: core.pool,
    catalogs: core.catalogs,
    client: core.client,
    scheduler: core.scheduler,
    logger: ctx.logger,
    readConfig: liveConfig,
    writeConfig,
    rescan,
    probe: async (accounts, warnDays) => await probeAccounts(
      accounts,
      async account => ({
        credits: await core.client.fetchCredits(account.credential),
        checkin: await core.client.fetchCheckinStatus(account.credential),
      }),
      { warnDays, delayMs: 150 },
    ),
    refreshModels,
    refreshBusy,
    busyFetchedAtMs: (region: WbRegion): number | undefined => busyFetchedAt.get(region),
    pickOf: (region: WbRegion, accountId?: string): WbPickResult<WbDiscoveredAccount> => {
      // 卡片问「为什么这个账号排在后面」时用同一个选号入口，保证解释与真实选择
      // 不可能不一致。
      if (accountId !== undefined && accountId !== '') core.pool.setPreferred(region, accountId)
      return core.pool.pick(region)
    },
  }))

  // ── 注册两个 provider ──────────────────────────────────────────────────
  //
  // provider id 必须是 `workbuddy-models` / `workbuddy-models-global`，**不能**是
  // `workbuddy` / `workbuddy-global`：后者已被 dsh-connect-workbuddy（4.15.1）占用
  // （plugins/dsh-connect-workbuddy/src/adapter.ts:46,49）。cordis 的 llm 服务不允许
  // 同一个 provider id 注册两次，重复注册会让后加载的这份整份注册失败，而用户看到
  // 的只是模型列表变短，不是冲突提示。
  void (async () => {
    try {
      await Promise.all(WB_REGIONS.map(async region => await shims[region]?.ready))
    } catch (error: unknown) {
      // 一个 shim 绑不上端口不该让另一个也消失：逐区域报告，继续注册能用的。
      ctx.logger.error('dsh-connect-workbuddy-models: shim 启动失败（该区域 provider 将缺席）', error)
    }
    if (stopped) return

    const adapters: Partial<Record<WbRegion, WbAdapter>> = {}
    for (const region of WB_REGIONS) {
      const shim = shims[region]
      if (shim === undefined) continue
      adapters[region] = createWbAdapter({
        shim,
        catalog: core.catalogs.of(region),
        region,
        ctx,
      })
    }

    try {
      const disposers: Array<() => void> = []
      for (const region of WB_REGIONS) {
        const adapter = adapters[region]
        if (adapter === undefined) continue
        disposers.push(ctx.llm.registerAdapter([WB_PROVIDERS[region]], adapter.adapter))
      }
      const registered = WB_REGIONS.filter(region => adapters[region] !== undefined)
      if (registered.length > 0) {
        disposers.push(ctx.llm.registerConfigurableProviders(registered.map(region => ({
          provider: WB_PROVIDERS[region],
          displayName: adapters[region]?.displayName ?? WB_PROVIDERS[region],
          settingsNs: WB_MODELS_SETTINGS_NS,
          settingsPath: [],
          declared: false,
        }))))
      }
      releaseProviders = () => {
        for (const dispose of disposers.reverse()) {
          try {
            dispose()
          } catch {
            // 单个 disposer 失败不该阻止其余注册被撤掉。
          }
        }
      }
    } catch (error: unknown) {
      // 中途抛出会留下已注册的部分；撤掉它们，免得启动失败留下半个 provider。
      releaseProviders?.()
      releaseProviders = undefined
      ctx.logger.error('dsh-connect-workbuddy-models: provider 注册失败', error)
      return
    }

    // 从这里开始设置变更可以重建 picker。在这行之前 invalidateCatalog 是空操作。
    invalidateCatalog = () => {
      for (const region of WB_REGIONS) adapters[region]?.invalidate()
    }

    ctx.llm.registerModelDiscovery(WB_MODELS_SETTINGS_NS, async (request: { provider?: string }) => {
      const region = WB_REGIONS.find(candidate => WB_PROVIDERS[candidate] === request.provider)
      // 只答自己两个 provider 的名册：`provider` 指向别的路由（用户在「添加
      // provider」草稿里换了 baseURL）时返回空数组，让宿主去别处问，而不是把
      // WorkBuddy 的模型挂到别人的路由上。
      if (region === undefined) return []
      return core.catalogs.of(region).visible().map(model => ({
        id: model.id,
        name: model.name,
        ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
        ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
        inputModalities: model.supportsImages ? ['text', 'image' as const] : ['text' as const],
      }))
    })

    ctx.logger.info?.(
      `dsh-connect-workbuddy-models: provider 已注册 ${WB_REGIONS
        .map(region => `${WB_PROVIDERS[region]}=${shims[region]?.baseUrl() ?? '未启动'}`)
        .join(' ')}`,
    )

    // ── 发现 → 探测 → 播种 → 启调度器 ──────────────────────────────────
    try {
      await rescan()
    } catch (error: unknown) {
      // 没有账号也一样要往下走：静态目录仍能让 provider 有一个可用模型列表，
      // 而「发现失败」会在卡片上以「0 个账号」+ 重扫按钮呈现。
      ctx.logger.warn('dsh-connect-workbuddy-models: 账号发现失败（保留静态目录与空池）', error)
    }
    if (stopped) return

    await Promise.all(WB_REGIONS.map(async region => await seedRegion(region)))
    if (stopped) return

    // 先装账本再启动：`start()` 会立刻跑一次 tick，把「恢复」与「启动」调换顺序
    // 会让启动那轮以为今天还没签过。
    core.scheduler.applyLedger(await loadLedgerFrom(PLUGIN_ID))

    // 调度器放装配末尾：核心对象就绪、配置已应用。
    core.scheduler.start()
    ctx.logger.info?.(
      'dsh-connect-workbuddy-models: 签到调度器已启动'
      + `（automation.enabled=${core.scheduler.isEnabled() ? 'true' : 'false'} 时`
      + `${core.scheduler.isEnabled() ? '' : '保持惰性；'}）`,
    )
  })()
}

// ── 公共 API 再导出 ───────────────────────────────────────────────────────
//
// 只再导出**纯函数与工厂**，不再导出整份上游响应类型：测试与下游需要的是
// 「怎么聚合积分」「怎么排账号」「怎么做目录过滤」，而不是一份与上游字段一一对应
// 的镜像——那层镜像由 upstream.ts 自己维护。

export { aggregateCredits, probeAccounts, toCheckinStatus, isExpiring, totalCreditsOf } from './probe.ts'
export type { WbAccountProbe, WbProbeResult } from './probe.ts'
export {
  candidateAuthDirs,
  defaultDesktopAuthDirs,
  discoverAccounts,
  fetchCatalogFromAny,
  modelsOfDocument,
  WbAccountPool,
  WORKBUDDY_AUTH_FILE_ENV,
  WORKBUDDY_LIVE_FILENAME,
} from './accounts.ts'
export type {
  WbCatalogFetch,
  WbDiscoveredAccount,
  WbDiscoveryResult,
  WbPickResult,
  WbPoolEntry,
} from './accounts.ts'
export {
  deriveVisibleModels,
  fallbackModelsFor,
  FALLBACK_MODELS_CN,
  FALLBACK_MODELS_GLOBAL,
  WbCatalog,
  WbCatalogs,
} from './catalog.ts'
export { createWbAdapter, describeSelection } from './adapter.ts'
export type { WbAdapter, WbAdapterOptions } from './adapter.ts'
export { createWbShim, classifyThrown, worthRetrying } from './shim.ts'
export type { WbShim, WbShimOptions } from './shim.ts'
export {
  AUTOMATION_ACCOUNT_DELAY_MS,
  AUTOMATION_TICK_MS,
  AUTOMATION_TIME_ZONE,
  DEFAULT_CHECKIN_HOURS,
  WbScheduler,
} from './scheduler.ts'
export type { AutomationLedger, AutomationStatus, SchedulerOptions } from './scheduler.ts'
export {
  classifyUpstreamError,
  isCredentialRejectedError,
  parseCreditMultiplier,
  parseUpstreamModel,
  regionOf,
  selectCliModels,
  WbCredentialRejectedError,
  WbUpstreamClient,
} from './upstream.ts'
export type {
  WbBenefit,
  WbCheckinClaim,
  WbChatResult,
  WbCredential,
  WbRawCredits,
  WbUpstreamErrorKind,
  WbUpstreamModel,
} from './upstream.ts'
export {
  benefitKindOf,
  DEFAULT_ACCOUNT_DISTRIBUTION,
  DEFAULT_EXPIRY_WARN_DAYS,
  distributionOf,
  pickRankedAccount,
  PLUGIN_ID,
  rankAccounts,
  ROUTE_PREFIX,
  ACCOUNT_DISTRIBUTIONS,
  EXPIRY_WARN_DAYS_MAX,
  EXPIRY_WARN_DAYS_MIN,
  unwrapVolatile,
  unwrapVolatileDeep,
  WB_MODELS_LOCALE_NS,
  WB_MODELS_SETTINGS_NS,
  WB_MODELS_SETTINGS_ORDER,
  WB_PROVIDERS,
  WB_REGIONS,
  wbProviderOf,
  wbRegionOfProvider,
} from './status-paths.ts'
export type {
  AccountDistribution,
  WbAccount,
  WbAccountReading,
  WbAutomationConfig,
  WbBenefitKind,
  WbCheckinStatus,
  WbCreditPackage as WbCreditPackageInfo,
  WbCredits,
  WbModelInfo,
  WbModelsConfig,
  WbRegion,
  WbSkippedFile,
  WbStatusSnapshot,
} from './status-paths.ts'
export {
  registerWbStatusRoutes,
  rankReasonsOf,
  safeMessage,
  // 九条路由常量与三个参数名一并再导出：客户端半区要拼 URL，测试要断言路由表，
  // 两边都只应该认这一个来源（status-paths 定义、web-status 再导出、这里汇总）。
  WB_ACCOUNT_CREDITS_PATH,
  WB_ACCOUNTS_REFRESH_PATH,
  WB_ACCOUNTS_SELECT_PATH,
  WB_AUTOMATION_PATH,
  WB_BENEFIT_CLAIM_PATH,
  WB_CHECKIN_PATH,
  WB_MODELS_REFRESH_PATH,
  WB_MODELS_SAVE_PATH,
  WB_STATUS_PATH,
} from './web-status.ts'
export { WB_ACCOUNT_ID_PARAM, WB_KIND_PARAM, WB_REGION_PARAM } from './status-paths.ts'
export type {
  WbStatusRouteOptions,
  WbWebAccount,
  WbWebBenefitClaim,
  WbWebCheckin,
  WbWebStatus,
} from './web-status.ts'

/** cordis 插件显示名（诊断与日志用）。 */
export const name = PLUGIN_ID

// 上面的 `createWbCore` 与 `rescan` 都收窄在 apply 内部；`WbChatResult` 只作为
// shim 的返回类型出现在导出面里，这里显式引用一次以免 noUnusedLocals 把 import
// 判成未使用（这条注释同时也是「为什么它在这儿」的答案）。
export type { WbChatResult as WbChatOutcome }

// 持久化助手与上游类型一起进入导出面：t4 要能直接测「账本坏了插件照样起得来」，
// 而不必去驱动整个 apply（那需要 llm/settings 两个 seam）。
export { ledgerPath, loadLedger, saveLedger } from './account-store.ts'
