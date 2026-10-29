/**
 * 插件卡片背后的同源路由（`/plugins/dsh-connect-workbuddy-models/*`，DESIGN.md §6）。
 *
 * 这些路由**只服务回环浏览器请求**，响应里绝不携带 token 材料：账号只以
 * 「id + 人话名字 + 余额 + 状态」的形式出去，凭据永远留在宿主进程里。默认只读
 * （状态是 GET，其余全是显式 POST）；会改上游账号状态的只有签到与权益领取两族，
 * 它们各由显式的 `accountId` 加一次前置复核守住。
 *
 * 挂载在宿主 `webServer` 上，由 `index.ts` 里的
 * `ctx.inject(['webServer'], ...)` 接线。`webServer` 是**可选**服务：无头 profile
 * 上这些路由根本不挂，卡片退化成离线横幅，而 provider 照常服务模型。
 *
 * @module dsh-connect-workbuddy-models/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

import type { WbAccountPool, WbPickResult, WbDiscoveredAccount } from './accounts.ts'
import type { WbCatalog, WbCatalogs } from './catalog.ts'
import type { WbAccountProbe } from './probe.ts'
import { totalCreditsOf } from './probe.ts'
import type { AutomationAccountGain, AutomationStatus, WbScheduler } from './scheduler.ts'
import type { WbBusyLevel, WbUpstreamClient } from './upstream.ts'
import {
  accountIdOf,
  benefitKindOf,
  claimKindOf,
  isWbRegion,
  queryParamOf,
  rawQueryParamOf,
  regionParamOf,
  WB_ACCOUNT_CREDITS_PATH,
  WB_ACCOUNT_ID_PARAM,
  WB_ACCOUNTS_REFRESH_PATH,
  WB_ACCOUNTS_SELECT_PATH,
  WB_AUTOMATION_PATH,
  WB_BENEFIT_CLAIM_PATH,
  WB_BUSY_TTL_MS,
  WB_CATALOG_TTL_MS,
  WB_CHECKIN_PATH,
  WB_MODELS_REFRESH_PATH,
  WB_MODELS_SAVE_PATH,
  WB_REGION_PARAM,
  WB_STATUS_PATH,
  type WbAccountReading,
  type WbBenefitKind,
  type WbModelsConfig,
  type WbRegion,
  type WbStatusSnapshot,
} from './status-paths.ts'

export {
  WB_ACCOUNT_CREDITS_PATH,
  WB_ACCOUNTS_REFRESH_PATH,
  WB_ACCOUNTS_SELECT_PATH,
  WB_AUTOMATION_PATH,
  WB_BENEFIT_CLAIM_PATH,
  WB_BUSY_TTL_MS,
  WB_CATALOG_TTL_MS,
  WB_CHECKIN_PATH,
  WB_MODELS_REFRESH_PATH,
  WB_MODELS_SAVE_PATH,
  WB_STATUS_PATH,
}
export type { WbStatusSnapshot }

/** 浏览器半区收到的单账号投影（**不含凭据**）。 */
export interface WbWebAccount {
  id: string
  label: string
  region: WbRegion
  selected: boolean
  /** 该账号此刻为什么不能服务；能服务时缺省。 */
  excludedBy?: string
  /** 余额；读不到时缺省（**不是** 0）。 */
  total?: number
  expiringSoon?: number
  nearestExpiryMs?: number
  /** 距离最近到期的天数（向上取整）。 */
  daysToExpiry?: number
  todayCheckedIn?: boolean
  streakDays?: number
  /** 名次（1 起）；供卡片解释「为什么这个账号排在后面」。 */
  rank?: number
}

/**
 * `/status` 的应答：共享投影 + 浏览器真正要用的额外字段。
 *
 * 用 `Omit` 换掉 `accounts`：共享投影里 `accounts` 是 `WbAccountReading[]`（给
 * 设置页与客户端共用），而卡片还要人话标签、名次、临期天数与签到状态。直接
 * `extends` 再改字段类型会变成不兼容覆写，所以显式换掉那一项。
 */
export interface WbWebStatus extends Omit<WbStatusSnapshot, 'accounts'> {
  /** 池里「剩余总积分」；`unread` 是没读到读数的账号数。 */
  creditsReadout: { total: number; unread: number }
  accounts: readonly (WbAccountReading & WbWebAccount)[]
  /** 每区域目录的来源与失败原因，让卡片能说清倍率可不可信。 */
  catalogs: Readonly<Record<WbRegion, {
    source: 'live' | 'fallback'
    modelCount: number
    lastUpdatedAtMs?: number
    lastError?: string
    usable: boolean
    enabled: boolean
  }>>
  automation: AutomationStatus
}

/** 卡片点「立即签到」后的应答。 */
export interface WbWebCheckin {
  ok: boolean
  /** 本次真正入账的积分。 */
  credit: number
  /**
   * 与 `credit` 恒等。卡片读的是这个字段名（`WbModelsCard.tsx:467` 的
   * `payload['grantedCredit']`）；改名会让签到成功后提示条永远显示「已签到」而
   * 不显示本次获得多少积分。两个名字都留着，读哪个都不会拿到 undefined。
   */
  grantedCredit: number
  alreadyDone: boolean
  detail: readonly string[]
  /** 账号在池里的读数（签到后余额已变，顺手回传）。 */
  total?: number
  /**
   * 只用于「给全部账号签到」这一条：请求已受理但仍在后台跑。
   *
   * 一整轮 4 个账号 × 800ms 间隔要几十秒，把卡片请求挂那么久会让浏览器或宿主
   * web server 先超时；所以先回 200 再在后台推进，卡片靠轮询 `/status` 看结果。
   */
  running?: boolean
  /** 与 `running` 同出：自动签到开关当时是开着的吗（关着也不影响手动运行）。 */
  started?: boolean
}

/** 卡片点「领取」后的应答。 */
export interface WbWebBenefitClaim {
  ok: boolean
  /** `false` 表示「现在没什么可领」，不是失败。 */
  claimed: boolean
}

/**
 * 一路路由的依赖。全部由 `index.ts` 注入，本文件不持有任何生命周期。
 *
 * 用回调（`readConfig` / `writeConfig` / `rescan`）而不是直接持有池与 settings：
 * 路由层要能在测试里被单独装配，而 settings 写入的命名空间判定在 `index.ts` 里
 * （那条判定本身依赖运行时形态）。
 */
export interface WbStatusRouteOptions {
  pool: WbAccountPool
  catalogs: WbCatalogs
  client: WbUpstreamClient
  scheduler: WbScheduler
  logger?: { warn(...args: unknown[]): void; info?(...args: unknown[]): void }
  /** 当前生效的配置（深剥过 volatile）。 */
  readConfig: () => WbModelsConfig
  /** 落一次配置补丁。抛错即「没保存」。 */
  writeConfig: (patch: Record<string, unknown>) => Promise<void>
  /** 重扫本机凭据。 */
  rescan: () => Promise<void>
  /**
   * 读一批账号的积分（会打上游）。
   *
   * 状态路由里**不**做这件事：一次 `/status` 变成 N 次上游请求会让卡片首帧
   * 挂十几秒，而用户打开设置页时最想先看到的是「有几个账号」。
   */
  probe: (accounts: readonly WbDiscoveredAccount[], warnDays: number) => Promise<readonly WbAccountProbe[]>
  /** 拉某区域的实时模型目录。 */
  refreshModels: (region: WbRegion) => Promise<void>
  /**
   * 拉某区域的实时拥挤度。
   *
   * 可选：老调用方（测试夹具、早期宿主）不必实现它，缺了只是不刷新拥挤度。
   * 与 {@link refreshModels} 分开是契约 `t31` 的要求——这是两条独立的上游链路，
   * 拥挤度是分钟级事实、目录是小时级事实，合成一条 TTL 会逼出两种坏结果之一。
   */
  refreshBusy?: (region: WbRegion) => Promise<void>
  /** 本区域拥挤度最近一次成功抓取的时刻；没抓过返回 `undefined`。 */
  busyFetchedAtMs?: (region: WbRegion) => number | undefined
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
  inFlight?: { models: Map<WbRegion, Promise<void>>; busy: Map<WbRegion, Promise<void>> }
  /** 允许关掉自动刷新（测试用）。缺省为开启。 */
  autoRefresh?: boolean
  /**
   * 测试用：单飞闸门与失败计数的容器。
   *
   * 必须由调用方持有，而不是在 {@link refreshForTest} 里用默认参数创建：默认参数
   * 每次调用都会重新求值，连续多次调用就会各拿一份空 Map，于是「单飞」在测试里
   * 永远不成立；而生产代码里 `kick` 用的是闭包外层同一份 Map。容器生命周期不同，
   * 测出来的就不是生产行为。生产路径不传这个字段（路由内部自己建）。
   */
  refreshState?: {
    inFlight: { models: Map<WbRegion, Promise<void>>; busy: Map<WbRegion, Promise<void>> }
    failures: Map<string, number>
  }
  /**
   * 连续刷新失败几次之后放弃自动刷新，直到有一次手动成功。
   *
   * 缺省 `3`。理由：上游持续故障时（凭据过期、网关宕机），每次 `/status` 都触发一次
   * 必然失败的请求，等于让设置页变成一个不断打上游的循环。放弃之后界面照常显示
   * 「数据已过期」与错误原因，但不再自己重试——这是唯一不会把一次故障放大成
   * 流量风暴的做法。手动点「刷新模型」会清零计数。
   */
  maxAutoFailures?: number
  /** 选号结果，供「为什么排在后面」显示。 */
  pickOf: (region: WbRegion, accountId?: string) => WbPickResult<WbDiscoveredAccount>
}

/** 把 token 类内容抹掉再送回浏览器。 */
export function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    // 这些应答全部是「此刻的状态」，任何缓存都会让用户看到上一个账号的余额。
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

/**
 * 只接受回环浏览器来源。
 *
 * 没有 `Origin` 头的请求放行：那是同源导航或 curl 这类本地诊断，而它们本来就能
 * 直接读磁盘上的凭据文件；带 `Origin` 的跨站请求一律拒绝，否则任意网页都能读走
 * 用户的账号列表与积分。
 */
function loopbackOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    const { hostname } = new URL(origin)
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
}

/** 最小 POST body 读取器，带上限，防止挂起或超大 body 钉住宿主内存。 */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const LIMIT = 64 * 1024
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        const parsed: unknown = JSON.parse(text)
        resolve(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {})
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

/** 从 query 里取一个区域；缺省 `cn`（界面的主区域），非法值给 undefined。 */
function regionOfRequest(req: IncomingMessage): WbRegion | undefined {
  const raw = queryParamOf(req.url ?? '', WB_REGION_PARAM)
  if (raw === undefined || raw === '') return 'cn'
  return raw === 'cn' || raw === 'global' ? raw : undefined
}

/** 从一个任意值里取字符串数组，非数组给 `[]`（配置补丁的唯一入口校验）。 */
function stringListOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
}

/** 距离某个时刻的天数（向上取整）；无值或缺省给 undefined。 */
function daysUntil(atMs: number | undefined, nowMs: number): number | undefined {
  if (atMs === undefined || !Number.isFinite(atMs)) return undefined
  return Math.max(0, Math.ceil((atMs - nowMs) / 86_400_000))
}

/**
 * 组装 `/status` 的应答。
 *
 * 全部读池里的**缓存读数**，不发上游请求：卡片每几秒轮询一次，每次都去问上游会
 * 让 4 个账号 × 每分钟 12 次的余额查询变成常态流量，而余额本身十分钟才动一次。
 */
function buildStatus(deps: WbStatusRouteOptions, region: WbRegion, nowMs = Date.now()): WbWebStatus {
  const config = deps.readConfig()
  const pick = deps.pickOf(region)
  const ranks = new Map(pick.ranked.map((row, index) => [row.account.id, index + 1] as const))

  // 账号数组必须按 region 过滤。这里曾经用的是 `deps.pool.list()`（全量），于是
  // `?region=cn` 与 `?region=global` 返回**同一批**账号：国内版列表里混进国际版账号，
  // 点国际版看到的还是国内版那批。客户端是信任服务端的（`WbModelsCard` 直接渲染
  // `status.accounts`，不再二次过滤），所以根因只能在这里修。
  //
  // 同一个函数里另外两处的口径**不要跟着改**，它们本来就是对的：
  //
  // - `skipped` 保持全量：它是**发现阶段**的产物（桌面端 auth 目录里扫到多少个打不开
  //   的加密信封），跨区域显示是合理的——用户需要知道「这台机器上有 4 个登录态但一个
  //   都用不了」，而不需要按 Tab 各看一遍同一份清单。按 region 过滤会把「本区域 0 个
  //   跳过」显示成没事，恰恰抹掉了唯一的诊断线索。
  // - `catalogs` 一直是两个区域都给（`catalogInfo('cn')` / `catalogInfo('global')`），
  //   同理不动。
  //
  // `picks` 也不用动：`rankReasonsOf(deps.pool, region, nowMs)` 内部已经走
  // `pool.rank(region)` 的区域口径。
  const readings = deps.pool.listRegion(region).map(entry => {
    const credits = entry.credits
    const excludedBy = deps.pool.exclusionReason(entry)
    const probeCredits = credits === undefined
      ? {}
      : {
          credits,
          total: credits.total,
          expiringSoon: credits.expiringSoon,
          ...credits.nearestExpiryMs === undefined ? {} : { nearestExpiryMs: credits.nearestExpiryMs },
          ...daysUntil(credits.nearestExpiryMs, nowMs) === undefined
            ? {}
            : { daysToExpiry: daysUntil(credits.nearestExpiryMs, nowMs) as number },
        }
    const rank = ranks.get(entry.account.id)
    return {
      account: {
        id: entry.account.id,
        accountName: entry.account.label,
        domain: entry.account.credential.domain,
        region: entry.account.region,
        source: entry.account.source,
        tokenExpiresAtMs: entry.account.tokenExpiresAtMs ?? 0,
        sourcePath: entry.account.sourcePath,
        selected: deps.pool.preferredOf(entry.account.region) === entry.account.id,
      },
      ...probeCredits,
      // 三件在顶层重复给一次：卡片用它排序与勾选，而共享投影把它们藏在
      // `account` 里。重复是有意的——卡片不该为了读一个 id 去解一层嵌套，
      // 而共享投影的形状要留给设置页与客户端半区。
      id: entry.account.id,
      region: entry.account.region,
      selected: deps.pool.preferredOf(entry.account.region) === entry.account.id,
      label: entry.account.label,
      ...rank === undefined ? {} : { rank },
      ...excludedBy === undefined ? {} : { excludedBy },
      ...entry.checkin === undefined ? {} : {
        checkin: entry.checkin,
        todayCheckedIn: entry.checkin.todayCheckedIn,
        streakDays: entry.checkin.streakDays,
      },
    }
  })

  // 「剩余总积分」只统计**本区域参与池**的账号：把国际账号的积分加进国内读数会
  // 让用户以为一个区域的额度比实际多（两边计价单位相同但不可互换）。
  const inPool = deps.pool.listRegion(region).filter(entry => deps.pool.exclusionReason(entry) === undefined)
  const readout = totalCreditsOf(inPool.map(entry => ({
    accountId: entry.account.id,
    ...entry.credits === undefined ? {} : { credits: entry.credits },
    readAtMs: nowMs,
  })))

  const catalogInfo = (which: WbRegion): WbWebStatus['catalogs'][WbRegion] => {
    const catalog = deps.catalogs.of(which)
    const updatedAt = catalog.lastUpdatedAt
    const lastError = catalog.lastFetchError
    return {
      source: catalog.source,
      modelCount: catalog.all().length,
      ...updatedAt === undefined ? {} : { lastUpdatedAtMs: updatedAt },
      ...lastError === undefined ? {} : { lastError },
      usable: catalog.isUsable(),
      enabled: catalog.isEnabled(),
    }
  }

  // models 用 `all()` 而不是 `visible()`。
  //
  // 设置页要展示**每一个**模型。如果用 `visible()`，用户取消勾选之后那一行就会
  // 从列表里消失——用户再也找不到它，也就无法把它勾回来。勾选状态记在
  // `config.enabledModelIds` 里，列表必须比它更宽。
  //
  // 模型选择器只呈现 `visible()`，所以那条通路不受影响。
  const models = deps.catalogs.of(region).all()
  // 再给一份按 id 索引的拥挤度：选择器的标签槽只拿得到 model.id，拿不到
  // `models[]` 元素。它与 `models[].busyLevel` 同源（同一次 fetchModelBusy 结果经
  // toModelInfo 投影而来），两处必须一致。
  const busyLevels: Record<string, WbBusyLevel> = {}
  for (const model of models) {
    if (model.busyLevel !== undefined) busyLevels[model.id] = model.busyLevel
  }

  // 目录与拥挤度的「上次成功抓取时刻」分开取：这是两条独立的上游链路，
  // 一条挂了不该让另一条也显示成过期。
  const regionCatalog = deps.catalogs.of(region)
  const catalogFetchedAt = regionCatalog.lastFetchedAtMs
  const catalogAge = regionCatalog.ageMs(nowMs)
  const busyFetchedAt = deps.busyFetchedAtMs?.(region)

  return {
    scannedAtMs: deps.pool.lastScannedAtMs,
    region,
    accounts: readings,
    skipped: deps.pool.skippedFiles,
    models,
    busyLevels,
    // 这三个是「你看到的数据有多新」的唯一来源。没有它们，界面分不清
    // 「上游确实没促销」与「这份快照是两小时前抓的、促销早就结束了」。
    ...catalogFetchedAt === undefined ? {} : { modelsFetchedAtMs: catalogFetchedAt },
    ...catalogAge === undefined ? {} : { modelsAgeMs: catalogAge },
    ...busyFetchedAt === undefined ? {} : { busyFetchedAtMs: busyFetchedAt },
    totalCredits: readout.total,
    creditsReadout: readout,
    catalogs: { cn: catalogInfo('cn'), global: catalogInfo('global') },
    automation: deps.scheduler.status(),
    config,
    // 名次表与每位名次的理由。用户选了「积分最先到期优先」之后，唯一能验证这个
    // 选择真的生效的证据就是这张表：账号行上的名次与「为什么它在这一位」。
    //
    // 不复用上面那个 `ranks` Map：它只有数字。理由要 `rankReasonsOf` 现补一次
    // `pool.exclusionReason`，而它是 pool 上现成的判定，与排序用的 `_usable`
    // 同源，不会给出两套互相矛盾的说法。
    picks: rankReasonsOf(deps.pool, region, nowMs),
  }
}

/**
 * 自动刷新的纯判定：这一刻该不该为这条链路发一次请求。
 *
 * 单独抽出来是为了让四种边界都能在测试里逐条钉住——它们全都产生过真实故障：
 *
 * - 从未成功过 → 过期。启动播种失败后停在兜底名册，必须允许重试。
 * - 时钟回拨（`nowMs < fetchedAtMs`）→ 过期。否则 NTP 校正之后要等到真实时间追上
 *   那个未来时间戳，自动刷新才会恢复。
 * - 恰好等于 TTL → 过期（`>=`，不是 `>`）。
 * - 上一次还没回来 → 不发。这条就是「单飞」，它是正确性要求不是性能优化。
 *
 * `lane === 'busy'` 且刷新器缺席时返回 `false`：老调用方没有实现它，不该因此
 * 每次 `/status` 都白跑一遍判定。
 */
export function shouldRefreshForTest(
  lane: 'models' | 'busy',
  fetchedAtMs: number | undefined,
  nowMs: number,
  inFlight: boolean,
  hasRefresher: boolean,
): boolean {
  if (inFlight) return false
  if (!hasRefresher) return false
  const ttl = lane === 'models' ? WB_CATALOG_TTL_MS : WB_BUSY_TTL_MS
  if (fetchedAtMs === undefined) return true
  if (nowMs < fetchedAtMs) return true
  return nowMs - fetchedAtMs >= ttl
}

/**
 * 自动刷新的一次判定与发起。**生产与测试共用这一份**。
 *
 * 抽成一个函数而不是让路由闭包与测试各写一遍，是有代价教训的：原先 `kick` 与
 * `refreshForTest` 是两份独立实现，其中「闸门登记先于启动」这条被写反了一次，
 * 而测试用的是另一份，于是测试全绿、生产照旧坏。判定逻辑只能有一份。
 *
 * 返回本次实际发起的请求数，供测试断言「一次都没发」「只发了一次」这种性质。
 *
 * 四条性质（都有对应的回归用例）：
 *
 * 1. **不阻塞调用方**：发起即返回，失败只计数不抛。`/status` 必须立刻应答。
 * 2. **单飞**：同一条链路同一个区域同时只有一个在飞。两个标签页加几秒一次的
 *    轮询足以把上游打到 429，那会连带打挂真正要用的模型调用。所以闸门必须在
 *    **启动之前**登记进 `inFlight`——`start()` 返回的 promise 即使立刻被拒绝，
 *    `.finally` 也要等微任务才跑，中间那一瞬不能算「没在飞」。
 * 3. **连续失败到上限就停手**：凭据过期时不能让设置页变成不断打上游的循环。
 *    手动刷新会清掉计数（它走另一条路径，不经过这里）。
 * 4. **两条链路各算各的**：目录 5 分钟、拥挤度 1 分钟。合成一条会逼出「为了拥挤度
 *    每分钟读一遍大文档」或「拥挤度 5 分钟才更新一次」两种坏结果。
 */
export function runAutoRefresh(
  deps: WbStatusRouteOptions,
  region: WbRegion,
  nowMs: number,
): { models: number; busy: number } {
  const state = deps.refreshState ?? {
    inFlight: { models: new Map<WbRegion, Promise<void>>(), busy: new Map<WbRegion, Promise<void>>() },
    failures: new Map<string, number>(),
  }
  const { inFlight, failures } = state
  const sent = { models: 0, busy: 0 }
  const maxFailures = deps.maxAutoFailures ?? 3
  if (deps.autoRefresh === false) return sent

  const fire = (lane: 'models' | 'busy', start: () => Promise<void>): void => {
    if ((failures.get(`${lane}:${region}`) ?? 0) >= maxFailures) return
    const fetchedAt = lane === 'models'
      ? deps.catalogs.of(region).lastFetchedAtMs
      : deps.busyFetchedAtMs?.(region)
    const hasRefresher = lane === 'models' ? true : deps.refreshBusy !== undefined
    if (!shouldRefreshForTest(lane, fetchedAt, nowMs, inFlight[lane].has(region), hasRefresher)) return
    sent[lane] += 1
    // 闸门先登记、再启动。反过来写（或放到 .finally 里登记）会让同一轮 tick 里
    // 的第二、第三次判断都看到「没有在飞」，各发一次。
    const running = start()
      .then(() => { failures.delete(`${lane}:${region}`) })
      .catch((error: unknown) => {
        failures.set(`${lane}:${region}`, (failures.get(`${lane}:${region}`) ?? 0) + 1)
        deps.logger?.warn(`dsh-connect-workbuddy-models: 自动刷新 ${lane} 失败（${region}）`, error)
      })
      .finally(() => { inFlight[lane].delete(region) })
    inFlight[lane].set(region, running)
  }

  fire('models', () => deps.refreshModels(region))
  fire('busy', () => (deps.refreshBusy as (r: WbRegion) => Promise<void>)(region))
  return sent
}

/**
 * 测试入口：与 {@link runAutoRefresh} 同一份实现，保留这个名字是因为既有用例
 * 已经按它组织断言（“发起了几次”比“发起了什么”更容易读）。
 */
export function refreshForTest(
  deps: WbStatusRouteOptions,
  region: WbRegion,
  nowMs: number,
): { models: number; busy: number } {
  return runAutoRefresh(deps, region, nowMs)
}

/** `buildStatus` 的测试别名。生产路径只有路由内部调用它。 */
export const buildStatusForTest = buildStatus

/**
 * 在 `webServer` 可用的 context 上挂载全部路由。
 *
 * 调用方用 `ctx.inject(['webServer'], ...)`，让桌面端启动顺序无法让这次注册凭空
 * 消失；直接 `ctx.webServer.register` 在没有该服务时会抛，把整个插件的 apply 弄崩
 * （连 provider 都注册不上）。
 */
export function registerWbStatusRoutes(ctx: Context, deps: WbStatusRouteOptions): void {
  ctx.effect(() => {
    const disposers: Array<() => void> = []

    /** 每个路由都要过的三道闸：方法、来源、region 解析。 */
    const guard = (
      req: IncomingMessage,
      res: ServerResponse,
      method: 'GET' | 'POST',
    ): WbRegion | undefined => {
      if ((req.method ?? 'GET') !== method) {
        json(res, 405, { error: `method not allowed: 该路由只接受 ${method}` })
        return undefined
      }
      if (!loopbackOrigin(req)) {
        json(res, 403, { error: 'origin-not-trusted: 只接受本机浏览器请求' })
        return undefined
      }
      const region = regionOfRequest(req)
      if (region === undefined) {
        json(res, 400, { error: `invalid ${WB_REGION_PARAM}: 只接受 cn 或 global` })
        return undefined
      }
      return region
    }

    // ── 自动刷新：过期就去拉一次，但**不等它** ──────────────────────────
    //
    // 这段是整个刷新机制的落点，四条性质缺一都不能上线：
    //
    // 1. **不阻塞应答**。`/status` 是设置页每几秒轮询一次的路径，把它挂在上游
    //    请求上意味着上游慢的时候整个设置页跟着卡。所以这里只 `void` 掉 promise，
    //    本次应答一律用现有快照，并把它有多新如实上报（`modelsFetchedAtMs`）。
    // 2. **单飞**。同一区域上一次刷新还没回来就不再发第二次。没有这条，用户开着
    //    设置页去开个会，回来时上游已经在 429 限流他——而那会连带打挂真正要用的
    //    模型调用。闸门放在路由这一层，因为 `registerWbStatusRoutes` 天然只调一次。
    // 3. **连续失败要停**。上游持续故障时（凭据过期、网关宕机），每次 `/status`
    //    都触发一次必然失败的请求，等于把设置页变成不断打上游的循环。失败到
    //    `maxAutoFailures` 次就停止自动刷新，只保留「数据已过期 + 错误原因」，
    //    等用户手动刷新把它清零。
    // 4. **两条链路各算各的**。拥挤度是分钟级事实、目录是小时级事实，用一条 TTL
    //    会逼出「为了拥挤度把大文档每分钟读一遍」或「拥挤度 5 分钟才更新一次」
    //    两种坏结果。
    // 生产路径把闸门容器挂到 deps 上：`runAutoRefresh` 与测试走同一份实现，
    // 容器必须同源，否则「单飞」在一边成立、另一边不成立。
    const refreshDeps: WbStatusRouteOptions = {
      ...deps,
      refreshState: deps.refreshState ?? {
        inFlight: deps.inFlight ?? { models: new Map<WbRegion, Promise<void>>(), busy: new Map<WbRegion, Promise<void>>() },
        failures: new Map<string, number>(),
      },
    }

    /** 两条链路一起判。手动刷新不走这里（它要 `await`）。 */
    const kickAutoRefresh = (region: WbRegion, nowMs = Date.now()): void => {
      runAutoRefresh(refreshDeps, region, nowMs)
    }

    // ── GET /status ──────────────────────────────────────────────────────
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: WB_STATUS_PATH,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (guard(req, res, 'GET') === undefined) return
        const region = regionOfRequest(req) ?? 'cn'
        try {
          // 先按现有快照应答，再顺手判断要不要在后台补一次。
          const status = buildStatus(deps, region)
          json(res, 200, status)
          kickAutoRefresh(region)
        } catch (error: unknown) {
          deps.logger?.warn('dsh-connect-workbuddy-models: /status 失败', error)
          json(res, 500, { error: safeMessage(error) })
        }
      },
    }))

    // ── POST /accounts/refresh ───────────────────────────────────────────
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: WB_ACCOUNTS_REFRESH_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const region = guard(req, res, 'POST')
        if (region === undefined) return
        try {
          await deps.rescan()
          json(res, 200, buildStatus(deps, region))
        } catch (error: unknown) {
          deps.logger?.warn('dsh-connect-workbuddy-models: 重扫失败', error)
          json(res, 500, {
            error: `rescan-failed: ${safeMessage(error)}（凭据目录可能被占用；重试或手动重启 WorkBuddy 桌面端）`,
          })
        }
      },
    }))

    // ── GET /account/credits?accountId= ──────────────────────────────────
    //
    // 唯一会**现读上游**的读路由：用户点开某个账号的明细时，他要的就是此刻的数。
    // 余额缓存在池里，而这个路由会把新读数写回池（到期时间与余额同行，`expiry`
    // 分布靠它排序）。
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: WB_ACCOUNT_CREDITS_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (guard(req, res, 'GET') === undefined) return
        const accountId = accountIdOf(req.url ?? '')
        if (accountId === undefined || accountId === '') {
          json(res, 400, { error: '缺少 accountId 查询参数（用 /accounts/refresh 拿账号列表）' })
          return
        }
        const entry = deps.pool.find(accountId)
        if (entry === undefined) {
          json(res, 404, { error: `unknown account: ${accountId}（可能已被上游注销，重扫一次）` })
          return
        }
        try {
          const config = deps.readConfig()
          const [probe] = await deps.probe([entry.account], config.expiryWarnDays)
          if (probe !== undefined && probe.credits !== undefined) {
            deps.pool.noteCredits(accountId, probe.credits)
          }
          if (probe !== undefined && probe.checkin !== undefined) {
            deps.pool.noteCheckin(accountId, probe.checkin)
          }
          json(res, 200, {
            accountId,
            label: entry.account.label,
            region: entry.account.region,
            ...probe === undefined ? {} : probe,
            ...entry.credits === undefined ? {} : { cached: entry.credits },
          })
        } catch (error: unknown) {
          // 读不到余额**不是** 500：上游 401（凭据被吊销）与网络失败都要如实说明，
          // 因为用户看到的应当是「这个号读不出余额」，不是「插件坏了」。
          deps.logger?.warn('dsh-connect-workbuddy-models: 读积分失败', error)
          json(res, 502, {
            error: `credits-unavailable: ${safeMessage(error)}（检查该账号是否还能在 WorkBuddy 里对话）`,
          })
        }
      },
    }))

    // ── POST /checkin?accountId= ─────────────────────────────────────────
    //
    // 手动签到。这是会改上游账号状态的两条路由之一，所以守得比读路由严：先读
    // 签到状态，`todayCheckedIn` 为真时**不**发 claim（上游按北京自然日幂等，但把
    // 正确性建立在别人的宽容上等于把闸门交出去）。
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: WB_CHECKIN_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const region = guard(req, res, 'POST')
        if (region === undefined) return
        // 国际版整区不做签到（产品裁定）。这里必须**明确拒绝**而不是静默成功：
        // 静默 200 会让卡片显示「今天已签过」，用户以为积分到账了，实际什么也没发生。
        // 客户端已经不画按钮，但路由是公开的，直接 POST 依然能到这里。
        if (region === 'global') {
          json(res, 400, {
            error: 'checkin-unsupported-region: 国际版不提供签到活动；这条路由只对国内版账号生效',
          })
          return
        }
        const accountId = accountIdOf(req.url ?? '')
        try {
          if (accountId === undefined || accountId === '') {
            // 省略 accountId = 给该区域全部账号签到。后台跑并立即返回：一整轮要
            // 几十秒，把卡片请求挂那么久会让浏览器或宿主 web server 超时。
            const started = deps.scheduler.isEnabled()
            // `region` 必须往下传。它到这里一定是 `'cn'`（`global` 在上面的
            // 400 分支已经返回），但**不要**因此改写成字面量：这条路由将来若支持
            // 别的区域，漏传会让「全部账号」重新变成全池——那正是本缺陷的形态。
            void deps.scheduler.runCheckinNow({ region, force: true }).catch((error: unknown) => {
              deps.logger?.warn('dsh-connect-workbuddy-models: 全量签到失败', error)
            })
            json(res, 200, {
              ok: true,
              running: true,
              started,
              detail: [
                started
                  ? '已开始为全部账号签到（逐账号间隔 800ms，避免上游限流）'
                  : '已开始为全部账号签到（自动签到开关关闭不影响这次手动运行）',
              ],
              credit: 0,
              grantedCredit: 0,
              alreadyDone: false,
            } satisfies WbWebCheckin)
            return
          }
          // 先在这里判 404，而不是信 scheduler 的返回值：scheduler 对未知账号也
          // 正常返回（`{gain: undefined}`），照它回 200 ok:true 会让卡片把「账号
          // 不存在」显示成「今天已签过」。/account/credits 与 /accounts/select 都
          // 是 404，三个入口的口径必须一致。
          const entry = deps.pool.find(accountId)
          if (entry === undefined) {
            json(res, 404, {
              error: `unknown account: ${accountId}（可能已在 WorkBuddy 桌面端退出登录；先重新扫描账号）`,
            })
            return
          }
          // 区域兜底：即使在 cn 的 provider 下点名一个国际版账号，也不能替它去
          // 打一个没有签到活动的计费域。上面 intake 已挡了整区，这一条挡混装。
          if (entry.account.region !== region) {
            json(res, 409, {
              error: `account-region-mismatch: 该账号属于 ${entry.account.region}，不能在 ${region} 的签到路由下使用`,
            })
            return
          }
          const result = await deps.scheduler.checkinOne(accountId)
          json(res, 200, {
            ok: true,
            credit: result.gain?.credit ?? 0,
            grantedCredit: result.gain?.credit ?? 0,
            alreadyDone: result.gain?.alreadyDone === true,
            detail: result.detail,
            ...entry?.credits === undefined ? {} : { total: entry.credits.total },
          } satisfies WbWebCheckin)
        } catch (error: unknown) {
          deps.logger?.warn('dsh-connect-workbuddy-models: 签到失败', error)
          json(res, 502, {
            error: `checkin-failed: ${safeMessage(error)}（凭据可能已失效；在 WorkBuddy 桌面端重新登录后重试）`,
          })
        }
      },
    }))

    // ── POST /benefit/claim?accountId=&kind= ─────────────────────────────
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: WB_BENEFIT_CLAIM_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (guard(req, res, 'POST') === undefined) return
        const accountId = accountIdOf(req.url ?? '')
        const kind: WbBenefitKind | undefined = claimKindOf(req.url ?? '') ?? benefitKindOf(queryParamOf(req.url ?? '', 'kind'))
        if (accountId === undefined || accountId === '') {
          json(res, 400, { error: '缺少 accountId 查询参数' })
          return
        }
        if (kind === undefined) {
          json(res, 400, { error: '缺少或非法的 kind 查询参数（只接受 compensation 或 gift）' })
          return
        }
        try {
          const claimed = await deps.scheduler.claimOne(accountId, kind)
          json(res, 200, { ok: true, claimed } satisfies WbWebBenefitClaim)
        } catch (error: unknown) {
          deps.logger?.warn('dsh-connect-workbuddy-models: 权益领取失败', error)
          json(res, 502, {
            error: `benefit-claim-failed: ${safeMessage(error)}（该权益可能已过期或已被其他设备领取）`,
          })
        }
      },
    }))

    // ── POST /models/refresh ─────────────────────────────────────────────
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: WB_MODELS_REFRESH_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const region = guard(req, res, 'POST')
        if (region === undefined) return
        try {
          await deps.refreshModels(region)
          const status = buildStatus(deps, region)
          json(res, 200, {
            ok: true,
            region,
            source: status.catalogs[region].source,
            modelCount: status.catalogs[region].modelCount,
            models: status.models,
            ...status.catalogs[region].lastError === undefined
              ? {}
              : { error: status.catalogs[region].lastError },
          })
        } catch (error: unknown) {
          deps.logger?.warn('dsh-connect-workbuddy-models: 模型目录刷新失败', error)
          json(res, 502, {
            error: `models-refresh-failed: ${safeMessage(error)}（静态目录仍在服务，倍率可能未知）`,
          })
        }
      },
    }))

    // ── POST /models/save ────────────────────────────────────────────────
    //
    // 空数组 = 全部显示。**写入侧也要把空数组折成「不过滤」**，而不是原样存起来：
    // catalog 层按 DESIGN.md 把空数组当全部，两边口径必须一致。丢失选择必须退化
    // 为「不筛选」，绝不能退化为「一个都不要」。
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: WB_MODELS_SAVE_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const region = guard(req, res, 'POST')
        if (region === undefined) return
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(req)
        } catch (error: unknown) {
          json(res, 400, { error: safeMessage(error) })
          return
        }
        const ids = stringListOf(body['enabledModelIds'])
        if (ids === undefined) {
          json(res, 400, { error: 'enabledModelIds 必须是字符串数组（空数组 = 全部显示）' })
          return
        }
        // region 可以从 body 给。客户端卡片（src/client/WbModelsCard.tsx）就是
        // `post(WB_MODELS_SAVE_PATH, { region, enabledModelIds })` —— 不带 query。
        // 只认 query 会把国际版的保存写进 CN 的键，界面看起来「保存没生效」。
        // query 显式给了就优先（那是调用方最明确的意图）。
        const bodyRegion = body['region']
        const writeRegion: WbRegion =
          queryParamOf(req.url ?? '', WB_REGION_PARAM) === undefined
            && isWbRegion(bodyRegion)
            ? bodyRegion
            : region
        try {
          await deps.writeConfig({
            [writeRegion === 'cn' ? 'enabledModelIds' : 'enabledModelIdsGlobal']: ids,
          })
          deps.catalogs.applySelection(writeRegion, ids)
          json(res, 200, { ok: true, region: writeRegion, enabledModelIds: ids })
        } catch (error: unknown) {
          json(res, 500, { error: `settings-save-failed: ${safeMessage(error)}` })
        }
      },
    }))

    // ── POST /accounts/select?accountId=&region= ─────────────────────────
    //
    // 用户显式选号。写回两层：池的 preferred（本进程立刻生效）+ settings（重启后
    // 仍在）。只写 settings 会让当前进程继续用手动选号之前那个账号，直到重启。
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: WB_ACCOUNTS_SELECT_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const region = guard(req, res, 'POST')
        if (region === undefined) return
        // 这里**不能**用 `accountIdOf`：它走 `queryParamOf`，而那里把空串归一化成
        // `undefined`。于是「传空字符串表示交还给账户使用方式」这句文案承诺的能力
        // 被上一层否决——只要用户手动选过一次号，五种 distribution 就永久失效，
        // 而且没有任何 HTTP 面可以撤销。`rawQueryParamOf` 保留空串，三种情况才分得开。
        const accountId = rawQueryParamOf(req.url ?? '', WB_ACCOUNT_ID_PARAM)
        if (accountId === undefined) {
          json(res, 400, { error: '缺少 accountId 查询参数（传空字符串表示交还给账户使用方式）' })
          return
        }
        // 空串 = 交还给「账户使用方式」。写回两层与选号相同：池的 preferred 让本
        // 进程立刻恢复按分布选号，settings 里的空串让重启后仍是交还状态
        // （`applyConfigFromSource` 已把 `''` 读成「没有 preferred」）。
        if (accountId === '') {
          try {
            deps.pool.setPreferred(region, undefined)
            const config = deps.readConfig()
            await deps.writeConfig({
              accounts: { ...config.accounts, [region]: '' },
            })
            json(res, 200, buildStatus(deps, region))
          } catch (error: unknown) {
            json(res, 500, { error: `select-failed: ${safeMessage(error)}` })
          }
          return
        }
        const entry = deps.pool.find(accountId)
        if (entry === undefined) {
          json(res, 404, { error: `unknown account: ${accountId}` })
          return
        }
        if (entry.account.region !== region) {
          json(res, 409, {
            error: `account-region-mismatch: 该账号属于 ${entry.account.region}，不能在 ${region} 的 provider 下使用`,
          })
          return
        }
        try {
          deps.pool.setPreferred(region, accountId)
          const config = deps.readConfig()
          await deps.writeConfig({
            accounts: { ...config.accounts, [region]: accountId },
          })
          json(res, 200, buildStatus(deps, region))
        } catch (error: unknown) {
          json(res, 500, { error: `select-failed: ${safeMessage(error)}` })
        }
      },
    }))

    // ── GET/POST /automation ────────────────────────────────────────────
    //
    // GET 只读状态；POST 改开关与时段。开启自动签到是一个会**代用户向上游发起
    // 写请求**的决定，所以必须由用户显式 POST，不能由「保存了配置」隐式打开。
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: WB_AUTOMATION_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!loopbackOrigin(req)) {
          json(res, 403, { error: 'origin-not-trusted: 只接受本机浏览器请求' })
          return
        }
        const method = req.method ?? 'GET'
        if (method === 'GET') {
          try {
            json(res, 200, {
              automation: deps.scheduler.status(),
              config: deps.readConfig().automation,
            })
          } catch (error: unknown) {
            json(res, 500, { error: safeMessage(error) })
          }
          return
        }
        if (method !== 'POST') {
          json(res, 405, { error: 'method not allowed: 该路由只接受 GET 或 POST' })
          return
        }
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(req)
        } catch (error: unknown) {
          json(res, 400, { error: safeMessage(error) })
          return
        }
        const patch: Record<string, unknown> = {}
        if (body['enabled'] !== undefined) {
          if (typeof body['enabled'] !== 'boolean') {
            json(res, 400, { error: 'enabled 必须是布尔值' })
            return
          }
          patch['enabled'] = body['enabled']
        }
        if (body['claimBenefits'] !== undefined) {
          if (typeof body['claimBenefits'] !== 'boolean') {
            json(res, 400, { error: 'claimBenefits 必须是布尔值' })
            return
          }
          patch['claimBenefits'] = body['claimBenefits']
        }
        if (body['checkinHours'] !== undefined) {
          const hours = body['checkinHours']
          if (!Array.isArray(hours) || hours.some(hour => typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23)) {
            json(res, 400, { error: 'checkinHours 必须是 0-23 的整数数组（北京时间整点）' })
            return
          }
          patch['checkinHours'] = hours
        }
        if (Object.keys(patch).length === 0) {
          json(res, 400, { error: '没有可应用的字段（接受 enabled / checkinHours / claimBenefits）' })
          return
        }
        try {
          const config = deps.readConfig()
          const nextAutomation = { ...config.automation, ...patch } as WbModelsConfig['automation']
          await deps.writeConfig({ automation: nextAutomation })
          // 立刻施加，不等下一次 volatile 广播：用户点完开关期待马上看到状态变化。
          deps.scheduler.applyConfig(nextAutomation)
          json(res, 200, {
            automation: deps.scheduler.status(),
            config: nextAutomation,
          })
        } catch (error: unknown) {
          json(res, 500, { error: `automation-save-failed: ${safeMessage(error)}` })
        }
      },
    }))

    // 全部路由共用一个 effect：宿主卸载时一次性摘掉，避免留下悬挂的 handler。
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // 单个 disposer 失败不该阻止其余路由被摘掉。
        }
      }
    }
  })
}

/**
 * 供 `index.ts` 生成 `pickOf`：把一个区域的名次表交出来。
 *
 * 单独导出而不是内联，因为「为什么这个账号排在后面」是本插件给用户的核心解释
 * 之一（R4 让用户选的分布必须可见），而它需要一个可测的纯函数边界。
 */
export function rankReasonsOf(
  pool: WbAccountPool,
  region: WbRegion,
  nowMs = Date.now(),
): readonly {
  accountId: string
  rank: number
  score: number
  atRisk: boolean
  expiringAmount: number
  nearestExpiryMs?: number
  usable: boolean
  reason?: string
}[] {
  const rows = pool.rank(region, nowMs)
  return rows.map((row, index) => {
    // `rankAccounts` 的排序键里 `_usable` 最靠前，但它只交出数字与布尔，不交出
    // 「为什么不可用」。卡片要解释「为什么这个账号排在后面」，所以在这一层补一次
    // `exclusionReason`——它是 pool 上现成的判定（未进池 / 登录窗口已关闭 / 上游
    // 已拒绝凭据），与排序用的 `_usable` 同源，不会给出互相矛盾的两种说法。
    //
    // 不复用 `pool.rank()` 的原样输出、也不改 `rankAccounts` 的签名：t4 的测试锁
    // 的是它现在的形状，加参数会让下游测试一起返工。
    const entry = pool.find(row.account.id)
    const reason = entry === undefined ? undefined : pool.exclusionReason(entry)
    return {
      accountId: row.account.id,
      rank: index + 1,
      score: row.score,
      atRisk: row.atRisk,
      expiringAmount: row.expiringAmount,
      ...row.nearestExpiryMs === undefined ? {} : { nearestExpiryMs: row.nearestExpiryMs },
      usable: reason === undefined,
      ...reason === undefined ? {} : { reason },
    }
  })
}

/** 供测试与诊断：把一个账号的签到结果总结成一行。 */
export function summariseGain(gain: AutomationAccountGain | undefined): string {
  if (gain === undefined) return '没有可做的'
  if (gain.alreadyDone === true) return `今日已签到${gain.credit > 0 ? `（另领 +${gain.credit}）` : ''}`
  return `签到成功 +${gain.checkinCredit}${(gain.benefitCredit ?? 0) > 0 ? `，权益 +${gain.benefitCredit}` : ''}`
}

/** 供诊断：目录对象的可序列化摘要（不含模型全文）。 */
export function catalogSummary(catalog: WbCatalog): {
  source: 'live' | 'fallback'
  visible: number
  total: number
  lastError?: string
} {
  const lastError = catalog.lastFetchError
  return {
    source: catalog.source,
    visible: catalog.visible().length,
    total: catalog.all().length,
    ...lastError === undefined ? {} : { lastError },
  }
}
