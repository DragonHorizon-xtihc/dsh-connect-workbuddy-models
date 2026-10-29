// @vitest-environment jsdom
/**
 * 促销徽标的**呈现层**：从 `/status` 的应答形状，到模型选择器里那一行画出来的东西。
 *
 * 纯函数层在 `tests/promo.test.ts`。这里只问三个「接错了就静默失效」的问题：
 *
 * 1. **`/status` 的 `models[]` 是不是未过滤的全量。** 配置页要用它画勾选框；如果它
 *    来自 `visible()`，用户取消勾选一个模型、保存、页面刷新之后，那一行就**从列表里
 *    消失**，再也勾不回来 —— 用户以为模型被删了。而隐藏模型的促销也就永远看不见。
 * 2. **顶层 `busyLevels` 与 `models[].busyLevel` 是不是同源。** 选择器那一行拿不到
 *    `models[]` 元素（宿主只给模型的 id 与名字），只能读顶层那份；两处不一致就会有
 *    一半界面显示拥挤、另一半不显示，而没有任何报错。
 * 3. **标签组件对不属于自己的 provider 返回纯名字，对属于自己的 provider 返回徽标。**
 *    `conversation.input.model.label` 是 `kind: 'single'` 的座位 —— 占用者接管整行。
 *    返回 `null` 会把邻居 provider 的模型行弄成空白。
 *
 * `MODEL_LABEL_PRIORITY` 单独钉一条：撞上宿主（0）、qoder（-1）或参考插件（-0.5）
 * 的表现是两个注册争抢同一个单元格，没有日志、没有异常，只是「有时显示这个、有时显示
 * 那个」。断言这个常量本身，是唯一能在测试里发现它的办法。
 */

import { createElement } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { WbAccountPool } from '../src/accounts.ts'
import type { WbDiscoveredAccount } from '../src/accounts.ts'
import { WbCatalogs } from '../src/catalog.ts'
import type { WbModelInfo } from '../src/status-paths.ts'
import { WbScheduler } from '../src/scheduler.ts'
import { WB_STATUS_PATH, registerWbStatusRoutes } from '../src/web-status.ts'
import type { WbStatusRouteOptions } from '../src/web-status.ts'
import type { WbModelsConfig } from '../src/status-paths.ts'
import type { WbStatusSnapshot } from '../src/status-paths.ts'
import { attachPromos, parseWorkBuddyPromos } from '../src/promo.ts'
import { MODEL_LABEL_PRIORITY, WbModelLabel, resetModelLabelCache, splitCatalogRate } from '../src/client/WbModelLabel.tsx'
import { WbModelsCard } from '../src/client/WbModelsCard.tsx'

afterEach(() => {
  cleanup()
  resetModelLabelCache()
  restoreFetch()
})

const DAY = 86_400_000

// ── /status 的装置 ────────────────────────────────────────────────────────

function accountFixture(id: string): WbDiscoveredAccount {
  return {
    id,
    label: id,
    region: 'cn',
    sourcePath: `/fake/${id}.info`,
    source: 'desktop',
    live: true,
    refreshExpired: false,
    tokenExpiresAtMs: Date.now() + 30 * DAY,
    credential: {
      accessToken: `tok-${id}`,
      refreshToken: `ref-${id}`,
      expiresAtMs: Date.now() + 30 * DAY,
      domain: '',
      sourcePath: `/fake/${id}.info`,
    },
  }
}

function baseConfig(): WbModelsConfig {
  return {
    enabled: true,
    distribution: 'expiry',
    enabledModelIds: [],
    enabledModelIdsGlobal: [],
    accountsEnabled: [],
    orderAccountIds: [],
    showCreditsInComposer: true,
    expiryWarnDays: 3,
    automation: { enabled: false, checkinHours: [9], claimBenefits: false },
    accounts: {},
  }
}

/** 一份名册：两个模型带促销，第三个什么都没有。 */
function catalogModels(): WbModelInfo[] {
  const promos = parseWorkBuddyPromos([
    {
      id: 'hy3-free-trial-202608',
      modelIds: ['hy3'],
      badge: { label: '限时免费', color: '#009273', display: 'activeOnly' },
      schedule: { timezone: 'Asia/Shanghai', validFrom: '2026-07-06T00:00:00+08:00', validUntil: '2026-11-01T00:00:00+08:00' },
      discount: { discountedCredits: '0x', displayMode: 'replace', factor: 0 },
      priority: 200,
    },
    {
      id: 'ds-discount-daytime-badge-202608',
      modelIds: ['deepseek-v4.1-flash'],
      badge: { label: '夜间折扣', color: '#009273' },
      schedule: { timezone: 'Asia/Shanghai', daily: [{ end: '23:59', start: '0:00' }] },
      priority: 50,
    },
  ], [
    { id: 'tier-standard-2026q3', modelIds: ['glm-5.3'], badge: { label: '订阅优先' }, schedule: null, discount: null, priority: 20 },
  ])

  return attachPromos([
    { id: 'hy3', name: 'hy3', contextWindow: 128_000, maxTokens: 8_192, creditMultiplier: 0, busyLevel: 'idle' as const },
    { id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', contextWindow: 128_000, maxTokens: 8_192, creditMultiplier: 0.11, busyLevel: 'congested' as const },
    { id: 'glm-5.3', name: 'glm-5.3', contextWindow: 1_000_000, maxTokens: 32_000, creditMultiplier: 0.69 },
    { id: 'plain', name: 'plain', contextWindow: 32_000, maxTokens: 4_096, creditMultiplier: 1 },
  ], promos)
}

/**
 * 测试读得懂的那一小部分应答形状。
 *
 * 用它替代把应答断言成 `any`：那样写会让「字段名拼错」和「字段根本不在应答里」
 * 都变成 `undefined` 的比较，两者都会在断言里悄悄通过（`undefined === undefined`）。
 * 声明成形状之后，拼错的字段名是编译错误。
 */
interface StatusModelShape {
  id: string
  name: string
  creditMultiplier?: number
  busyLevel?: string
  promos?: { id: string, badge: { label: string }, schedule?: { validUntil?: number } }[]
}

interface StatusBodyShape {
  models: StatusModelShape[]
  busyLevels?: Record<string, string>
}

/**
 * 分派一次 `GET /status`，返回解析后的应答。
 *
 * `enabledIds` 用来制造「用户隐藏了某些模型」的状态 —— 这正是 `visible()` 与 `all()`
 * 分道扬镳的地方。
 */
async function statusBody(options: { enabledIds?: readonly string[] } = {}): Promise<StatusBodyShape> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => unknown>()
  const pool = new WbAccountPool({})
  pool.applyDiscovery({ accounts: [accountFixture('cn-1')], skipped: [] })

  const catalogs = new WbCatalogs()
  const catalog = catalogs.of('cn')
  catalog.applyFetch(catalogModels())
  catalog.setEnabledIds(options.enabledIds ?? [])

  const scheduler = new WbScheduler({
    pool,
    client: { fetchCredits: async () => ({ total: 0, packages: [] }) } as never,
    now: () => new Date('2026-03-15T09:30:00+08:00'),
  })

  const deps: WbStatusRouteOptions = {
    pool,
    catalogs,
    client: {} as never,
    scheduler,
    readConfig: () => baseConfig(),
    writeConfig: async () => {},
    rescan: async () => {},
    probe: async () => [],
    refreshModels: async () => {},
    pickOf: region => pool.pick(region),
  }

  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    webServer: {
      register: (route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }) => {
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    },
  } as never

  registerWbStatusRoutes(ctx, deps)

  const handler = routes.get(WB_STATUS_PATH)
  if (handler === undefined) throw new Error('status route not registered')

  const req = new EventEmitter() as unknown as IncomingMessage & EventEmitter
  Object.assign(req, { method: 'GET', url: WB_STATUS_PATH, headers: {} })

  const res = new PassThrough() as unknown as ServerResponse
  const chunks: Buffer[] = []
  let status = 0
  Object.assign(res, {
    writeHead: (code: number) => { status = code; return res },
    end: (chunk?: unknown) => {
      if (chunk !== undefined) chunks.push(Buffer.from(String(chunk)))
      return res
    },
    headersSent: false,
  })
  res.on('data', (chunk: Buffer) => chunks.push(chunk))

  await handler(req, res)
  req.emit('end')
  await new Promise(resolve => { setImmediate(resolve) })

  expect(status).toBe(200)
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as StatusBodyShape
}


/**
 * 比 `catalogModels()` 多两个 hy3 家族成员。
 *
 * `hy3-free-trial-202608` 的 `modelIds` 是 `["hy3","hy3-b","hy3-c"]` —— 上游确实用
 * 一条促销点名三个模型。只有三个模型都在目录里，「每个模型行都画」才测得出来。
 */
function liveCatalogModels(): WbModelInfo[] {
  const promos = parseWorkBuddyPromos([
    {
      id: 'hy3-free-trial-202608',
      modelIds: ['hy3', 'hy3-b', 'hy3-c'],
      badge: { label: '限时免费', color: '#009273', display: 'activeOnly' },
      hover: { textZh: '7月6日-10月31日，免费使用。' },
      schedule: { timezone: 'Asia/Shanghai', validFrom: '2020-01-01T00:00:00+08:00', validUntil: '2099-01-01T00:00:00+08:00' },
      discount: { discountedCredits: '0x', displayMode: 'replace', factor: 0 },
      priority: 200,
    },
  ], [])
  return attachPromos([
    { id: 'hy3', name: 'hy3', contextWindow: 128_000, maxTokens: 8_192, creditMultiplier: 0 },
    { id: 'hy3-b', name: 'hy3-b', contextWindow: 128_000, maxTokens: 8_192, creditMultiplier: 0 },
    { id: 'hy3-c', name: 'hy3-c', contextWindow: 128_000, maxTokens: 8_192, creditMultiplier: 0 },
    { id: 'plain', name: 'plain', contextWindow: 32_000, maxTokens: 4_096, creditMultiplier: 1 },
  ], promos)
}

// ── /status 的形状 ────────────────────────────────────────────────────────

describe('/status 的模型列表与促销', () => {
  it('feed 里真有促销的模型带非空 promos（至少三个）', async () => {
    const body = await statusBody()
    const withPromos = body.models.filter(model => Array.isArray(model.promos) && model.promos.length > 0)
    expect(withPromos.length).toBeGreaterThanOrEqual(3)
    expect(new Set(withPromos.map(model => String(model.id))))
      .toEqual(new Set(['hy3', 'deepseek-v4.1-flash', 'glm-5.3']))
  })

  it('促销是**未解析**的候选（同模型两条都跟着走，不在这里挑）', async () => {
    const body = await statusBody()
    const hy3 = body.models.find(model => model.id === 'hy3')
    if (hy3 === undefined) throw new Error('夹具里没有 hy3，下面的断言无从谈起')
    // 挑哪一条取决于看的时刻，不取决于取数时刻 —— 所以这里必须还是候选表。
    const promos = hy3.promos ?? []
    expect(promos).toHaveLength(1)
    const [first] = promos
    if (first === undefined) throw new Error('hy3 一条候选都没挂上')
    expect(first.id).toBe('hy3-free-trial-202608')
    expect(first.badge.label).toBe('限时免费')
    // 上游的结构原样过来，没有被压成一句文案；时刻已归一成 epoch 毫秒（渲染期要按
    // 用户的语言与时区格式化，字符串在这里没有用处）。
    expect(first.schedule?.validUntil).toBe(Date.parse('2026-11-01T00:00:00+08:00'))
  })

  it('用户隐藏的模型**仍在** models[] 里（这是 all() 而非 visible() 的直接证据）', async () => {
    // 只勾了 plain 一个，另外三个都被用户取消勾选。
    const body = await statusBody({ enabledIds: ['plain'] })
    const ids = body.models.map(model => String(model.id))
    expect(ids).toContain('plain')
    // 关键：被取消勾选的那三个没有从应答里消失，否则用户再也勾不回来。
    expect(ids).toContain('hy3')
    expect(ids).toContain('deepseek-v4.1-flash')
    expect(ids).toContain('glm-5.3')
    expect(ids).toHaveLength(4)
  })

  it('顶层 busyLevels 与 models[].busyLevel 同源（两处不一致即缺陷）', async () => {
    const body = await statusBody()
    const levels = body.busyLevels as Record<string, string>
    expect(levels['hy3']).toBe('idle')
    expect(levels['deepseek-v4.1-flash']).toBe('congested')
    // 没有拥挤度的模型不该在顶层表里凭空出现一个键。
    expect('glm-5.3' in levels).toBe(false)
    expect('plain' in levels).toBe(false)

    for (const model of body.models) {
      const fromTop = levels[String(model.id)]
      const own = model.busyLevel as string | undefined
      expect(fromTop).toBe(own)
    }
  })

  it('没有促销的模型不带 promos 键（不是空数组）', async () => {
    const body = await statusBody()
    const plain = body.models.find(model => model.id === 'plain')
    if (plain === undefined) throw new Error('夹具里没有 plain，下面的断言无从谈起')
    expect('promos' in plain).toBe(false)
  })
})

// ── 模型标签组件 ──────────────────────────────────────────────────────────

const realFetch = globalThis.fetch
let stubbed = false

/** 替身 `fetch`：只回答 `/status`，别的 URL 直接抛（漏了会立刻看见）。 */
function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === 'string' ? input : String(input)
    return await handler(url)
  }) as unknown as typeof fetch
  stubbed = true
}

function restoreFetch(): void {
  if (!stubbed) return
  globalThis.fetch = realFetch
  stubbed = false
}

/** 一份 `/status` 应答，只含标签组件读的那几项。 */
function statusResponse(): Response {
  return new Response(JSON.stringify({
    busyLevels: { hy3: 'idle' },
    models: [
      {
        id: 'hy3',
        name: 'hy3 · 免费',
        creditMultiplier: 0,
        promos: [{
          id: 'hy3-free-trial-202608',
          source: 'promotion',
          modelIds: ['hy3'],
          badge: { label: '限时免费', color: '#009273', display: 'activeOnly' },
          // 窗口是 epoch 毫秒，不是 ISO 字符串 —— `parseWorkBuddyPromos` 之外拿到的
          // 对象必须自己满足这个类型，否则 `validUntil - 1` 会算成 NaN，格式化那一步
          // 抛 RangeError（写测试时踩过：JSON 里能放 ISO 串，类型上不能）。
          schedule: { validFrom: Date.parse('2020-01-01T00:00:00+08:00'), validUntil: Date.parse('2099-01-01T00:00:00+08:00') },
          discount: { multiplier: 0, displayMode: 'replace' },
          priority: 200,
        }],
      },
      {
        id: 'glm-5.3',
        name: 'glm-5.3 · x0.69',
        creditMultiplier: 0.69,
        promos: [{
          id: 'tier-standard-2026q3',
          source: 'tier',
          modelIds: ['glm-5.3'],
          badge: { label: '订阅优先' },
          priority: 20,
        }],
      },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('WbModelLabel 选择器标签', () => {
  it('优先级避开了已知的三个占用者（0 / -1 / -0.5）', () => {
    expect(MODEL_LABEL_PRIORITY).not.toBe(0)
    expect(MODEL_LABEL_PRIORITY).not.toBe(-1)
    expect(MODEL_LABEL_PRIORITY).not.toBe(-0.5)
    // 撞上就是无声争抢；这条断言是唯一能在测试里发现它的地方。
    expect(typeof MODEL_LABEL_PRIORITY).toBe('number')
  })

  it('不是本插件的 provider 时返回纯模型名（不是 null、不发请求）', () => {
    stubFetch(() => { throw new Error('别的 provider 不该触发本插件的取数') })
    const { container } = render(createElement(WbModelLabel, {
      provider: { id: 'deepseek', name: 'DeepSeek' },
      model: { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      placement: 'trigger' as const,
      selected: false,
    }))
    // 座位契约里占用者的返回值就是那一行内容；返回 null 会把邻居的显示弄没。
    expect(container.textContent).toBe('DeepSeek Chat')
    expect(container.querySelector('span')).not.toBeNull()
  })

  it('已知的两个前缀相近 id 也不被吞（workbuddy / workbuddy-global 属于参考插件）', () => {
    stubFetch(() => { throw new Error('不该取数') })
    for (const providerId of ['workbuddy', 'workbuddy-global', 'workbuddy-model']) {
      const { container, unmount } = render(createElement(WbModelLabel, {
        provider: { id: providerId, name: providerId },
        model: { id: 'm', name: `名字-${providerId}` },
        placement: 'menu' as const,
        selected: false,
      }))
      expect(container.textContent).toBe(`名字-${providerId}`)
      unmount()
    }
  })

  it('本插件 provider 的模型：名字、倍率与促销徽标都在', async () => {
    stubFetch(() => statusResponse())
    render(createElement(WbModelLabel, {
      provider: { id: 'workbuddy-models', name: 'WorkBuddy' },
      model: { id: 'hy3', name: 'hy3 · 免费' },
      placement: 'menu' as const,
      selected: false,
      t: (key: string) => (key === 'row.modelsFree' ? '免费' : key),
    }))
    await waitFor(() => { expect(screen.getByText('限时免费')).toBeTruthy() })
    // 名字里的「· 免费」被摘掉了，只剩一处价格 —— 否则会与新价并列。
    expect(screen.getByText('hy3')).toBeTruthy()
    expect(screen.queryByText('hy3 · 免费')).toBeNull()
  })

  it('常驻的档位徽标也画（无窗口、无折扣，任何时候成立）', async () => {
    stubFetch(() => statusResponse())
    render(createElement(WbModelLabel, {
      provider: { id: 'workbuddy-models', name: 'WorkBuddy' },
      model: { id: 'glm-5.3', name: 'glm-5.3 · x0.69' },
      placement: 'trigger' as const,
      selected: true,
      t: (key: string) => key,
    }))
    await waitFor(() => { expect(screen.getByText('订阅优先')).toBeTruthy() })
    // 目录倍率单独画出来（名字里的那份已摘掉）。
    expect(screen.getByText('x0.69')).toBeTruthy()
  })

  it('/status 拿不到时不画徽标、也不抛（界面退化成纯名字 + 倍率）', async () => {
    stubFetch(() => new Response('boom', { status: 500 }))
    const { container } = render(createElement(WbModelLabel, {
      provider: { id: 'workbuddy-models', name: 'WorkBuddy' },
      model: { id: 'hy3', name: 'hy3 · 免费' },
      placement: 'menu' as const,
      selected: false,
      t: (key: string) => (key === 'row.modelsFree' ? '免费' : key),
    }))
    // 等一拍让失败的取数落定，然后断言「什么都没画」而不是「画了个假的」。
    await waitFor(() => { expect(container.textContent).toContain('hy3') })
    expect(screen.queryByText('限时免费')).toBeNull()
    // 名字里的「· 免费」即使没有快照也照常摘掉：价格的位置由本组件决定。
    expect(container.textContent).not.toContain('·')
  })

  it('启动时只读一次 /status（缓存挡住了后续渲染）', async () => {
    let calls = 0
    stubFetch(() => { calls += 1; return statusResponse() })
    const element = createElement(WbModelLabel, {
      provider: { id: 'workbuddy-models', name: 'WorkBuddy' },
      model: { id: 'glm-5.3', name: 'glm-5.3 · x0.69' },
      placement: 'trigger' as const,
      selected: true,
      t: (key: string) => key,
    })
    const first = render(element)
    await waitFor(() => { expect(screen.getByText('订阅优先')).toBeTruthy() })
    first.unmount()
    // 60 秒缓存期内再挂一个标签，不该再打一次网络。
    render(element)
    await waitFor(() => { expect(screen.getAllByText('订阅优先').length).toBeGreaterThan(0) })
    expect(calls).toBe(1)
  })
})

// ── 倍率与名字后缀 ────────────────────────────────────────────────────────

describe('splitCatalogRate 把名字里的价格摘出来单独画', () => {
  it('`· x0.11` 后缀被摘下，倍率来自名字', () => {
    expect(splitCatalogRate('deepseek-v4.1-flash · x0.11', undefined, undefined))
      .toEqual({ base: 'deepseek-v4.1-flash', rate: 0.11 })
  })

  it('`· 免费` 后缀被摘下，倍率是 0（不是 undefined）', () => {
    expect(splitCatalogRate('hy3 · 免费', undefined, undefined))
      .toEqual({ base: 'hy3', rate: 0 })
  })

  it('折扣优先于名字里那个数（促销换了价时名字是旧的）', () => {
    expect(splitCatalogRate('glm-5.2 · x0.79', 0.79, 0.5))
      .toEqual({ base: 'glm-5.2', rate: 0.5 })
  })

  it('名字不带后缀时退回快照倍率', () => {
    expect(splitCatalogRate('裸名字', 0.69, undefined)).toEqual({ base: '裸名字', rate: 0.69 })
  })

  it('三样都没有时不画数字（undefined，不是 0）', () => {
    expect(splitCatalogRate('裸名字', undefined, undefined)).toEqual({ base: '裸名字', rate: undefined })
  })

  it('不误伤名字里正常的点号与空格', () => {
    expect(splitCatalogRate('gpt-6.1-sol', 0.5, undefined))
      .toEqual({ base: 'gpt-6.1-sol', rate: 0.5 })
    expect(splitCatalogRate('名字 里 有 空格', undefined, undefined))
      .toEqual({ base: '名字 里 有 空格', rate: undefined })
  })
})

// ── 配置页模型行 ──────────────────────────────────────────────────────────

/**
 * 配置页那一行与选择器那一行**不是同一份代码**：选择器走 `WbModelLabel` 组件，
 * 配置页走 `WbModelsCard` 里的一小段内联渲染。两处都读 `model.promos`，但任何
 * 一处接错，另一处的测试都不会红 —— 所以这里单独钉一遍。
 *
 * 卡片用 `initialStatusByRegion` 喂快照（它的文档已经写明这个口子是为测试存在的：
 * effect 在 jsdom 里会执行，但首帧就该有内容，否则断言只能等一次网络）。
 */
function cardSnapshot(models: readonly WbModelInfo[]): WbStatusSnapshot {
  return {
    scannedAtMs: Date.parse('2026-10-26T02:46:00+08:00'),
    region: 'cn',
    accounts: [],
    skipped: [],
    models,
    totalCredits: 0,
  }
}

/** 卡片渲染一次就够；不需要它的轮询，所以把 fetch 钉成同一个快照。 */
function renderCard(models: readonly WbModelInfo[]): void {
  const snapshot = cardSnapshot(models)
  stubFetch(() => new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
  render(createElement(WbModelsCard, {
    initialStatusByRegion: { cn: snapshot },
    t: (key: string) => key,
  }))
}

describe('配置页的模型行也画促销徽标', () => {
  it('此刻成立的促销在模型行里出现，措辞取自上游 label', () => {
    renderCard(liveCatalogModels())
    // 一条促销点名三个 hy3 家族模型，所以是复数 —— 见下一条。
    expect(screen.getAllByText('限时免费').length).toBe(3)
  })

  it('一条促销点名多个模型时，每个模型行都画出来（hy3 家族三个）', () => {
    renderCard(liveCatalogModels())
    // 三行各画一次，措辞相同 —— 徽标是每行一个，不是全局一个。
    expect(screen.getAllByText('限时免费').length).toBe(3)
  })

  it('没有促销的模型行不画徽标（不是画一个空的 span）', () => {
    renderCard(liveCatalogModels())
    const rows = Array.from(document.querySelectorAll('.wbm-model'))
    const plainRow = rows.find(row => row.textContent?.includes('plain'))
    expect(plainRow).toBeDefined()
    // `.wbm-tag` 在模型行里只可能来自徽标；`plain` 那一行不该有。
    expect(plainRow?.querySelector('.wbm-tag')).toBeNull()
  })

  it('徽标的颜色来自上游 badge.color（CN 绿），不是写死的主题色', () => {
    renderCard(liveCatalogModels())
    const badge = screen.getAllByText('限时免费')[0]
    if (badge === undefined) throw new Error('没找到徽标')
    // jsdom 把 `#009273` 规范成 `rgb(0, 146, 115)`。
    expect(badge.getAttribute('style')).toContain('rgb(0, 146, 115)')
  })

  it('上游给了 hover 文案时进 title（悬停能看到活动说明）', () => {
    renderCard(liveCatalogModels())
    const badge = screen.getAllByText('限时免费')[0]
    if (badge === undefined) throw new Error('没找到徽标')
    const title = badge.getAttribute('title')
    expect(title).not.toBeNull()
    expect(title).toContain('7月6日')
    // tooltip 只有「上游文案 · 有效区间 · 每日时段」，不重复徽标措辞。
    expect(title).not.toContain('限时免费')
  })

  it('活动过期后徽标从配置页消失（同一个组件、不重取数据也能变）', () => {
    const promos = parseWorkBuddyPromos([{
      id: 'gone',
      modelIds: ['hy3'],
      badge: { label: '限时免费' },
      schedule: { validFrom: '2020-01-01T00:00:00+08:00', validUntil: '2020-02-01T00:00:00+08:00' },
      priority: 200,
    }], [])
    renderCard(attachPromos([
      { id: 'hy3', name: 'hy3', contextWindow: 128_000, maxTokens: 8_192, creditMultiplier: 0 },
    ], promos))
    expect(screen.queryByText('限时免费')).toBeNull()
    // 行还在（模型本身是可见的），只是没有徽标。
    expect(document.querySelectorAll('.wbm-model').length).toBe(1)
  })

  it('`display: activeOnly` 的促销只在窗口内画，窗口外不常驻', () => {
    const future = parseWorkBuddyPromos([{
      id: 'later',
      modelIds: ['hy3'],
      badge: { label: '限时免费', display: 'activeOnly' },
      schedule: { validFrom: '2099-01-01T00:00:00+08:00' },
      priority: 200,
    }], [])
    renderCard(attachPromos([
      { id: 'hy3', name: 'hy3', contextWindow: 128_000, maxTokens: 8_192, creditMultiplier: 0 },
    ], future))
    expect(screen.queryByText('限时免费')).toBeNull()
  })

  it('同日同模型两条促销时只画一条（模型行只有一行宽）', () => {
    const promos = parseWorkBuddyPromos([
      {
        id: 'high',
        modelIds: ['hy3'],
        badge: { label: '限时免费' },
        schedule: { validFrom: '2020-01-01T00:00:00+08:00', validUntil: '2099-01-01T00:00:00+08:00' },
        priority: 200,
      },
      {
        id: 'low',
        modelIds: ['hy3'],
        badge: { label: '订阅优先' },
        schedule: { validFrom: '2020-01-01T00:00:00+08:00', validUntil: '2099-01-01T00:00:00+08:00' },
        priority: 20,
      },
    ], [])
    renderCard(attachPromos([
      { id: 'hy3', name: 'hy3', contextWindow: 128_000, maxTokens: 8_192, creditMultiplier: 0 },
    ], promos))
    expect(screen.getByText('限时免费')).toBeTruthy()
    expect(screen.queryByText('订阅优先')).toBeNull()
  })

  it('模型行里同时有倍率、上下文与促销徽标，三者不互相遮挡', () => {
    renderCard(liveCatalogModels())
    const row = Array.from(document.querySelectorAll('.wbm-model'))
      .find(candidate => candidate.textContent?.includes('hy3'))
    expect(row).toBeDefined()
    const text = row?.textContent ?? ''
    expect(text).toContain('hy3')
    expect(text).toContain('0.00x')
    expect(text).toContain('row.modelsContext')
    expect(text).toContain('限时免费')
  })

  it('快照里没有 promos 键的模型照常渲染（老宿主/老缓存下的退化）', () => {
    renderCard([{ id: 'hy3', name: 'hy3', contextWindow: 128_000, maxTokens: 8_192, creditMultiplier: 0 }])
    expect(document.querySelectorAll('.wbm-model').length).toBe(1)
    expect(screen.queryByText('限时免费')).toBeNull()
  })

  it('busyLevel 不参与卡片模型行（拥堵只在选择器里画，避免两处措辞不一致）', () => {
    renderCard([{ id: 'hy3', name: 'hy3', contextWindow: 128_000, maxTokens: 8_192, creditMultiplier: 0, busyLevel: 'congested' }])
    const row = document.querySelector('.wbm-model')
    expect(row?.textContent).not.toContain('🧍')
  })
})

// ── 标签在不同位置的形态 ──────────────────────────────────────────────────

/**
 * 选择器那一行在三个位置出现：触发器（宽）、菜单项与选项（窄）。组件用
 * `placement !== 'trigger'` 决定措辞 —— 窄行用上游的紧凑措辞，宽行用完整措辞。
 *
 * 这条分支不测的话，改坏它没有任何症状：徽标照样出现，只是四字标签把勾选框挤出窄行，
 * 或者宽行里显示一个没必要的缩写。
 */
describe('标签在不同位置的形态', () => {
  const SHORT_PROMO = (): ReturnType<typeof parseWorkBuddyPromos> => parseWorkBuddyPromos([{
    id: 'short-labelled',
    modelIds: ['hy3'],
    badge: { label: '限时折扣', shortLabel: '折扣', color: '#009273' },
    schedule: { timezone: 'Asia/Shanghai', validFrom: '2020-01-01T00:00:00+08:00', validUntil: '2099-01-01T00:00:00+08:00' },
    priority: 100,
  }], [])

  function statusWith(promos: ReturnType<typeof parseWorkBuddyPromos>): Response {
    const models = attachPromos([
      { id: 'hy3', name: 'hy3', contextWindow: 128_000, maxTokens: 8_192, creditMultiplier: 0 },
    ], promos)
    return new Response(JSON.stringify({
      scannedAtMs: Date.now(), region: 'cn', accounts: [], skipped: [], models, totalCredits: 0,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  it('触发器位置用完整措辞（宽行不必缩写）', async () => {
    stubFetch(() => statusWith(SHORT_PROMO()))
    render(createElement(WbModelLabel, {
      provider: { id: 'workbuddy-models', name: 'WorkBuddy' },
      model: { id: 'hy3', name: 'hy3 · 免费' },
      placement: 'trigger' as const,
      selected: true,
      t: (key: string) => (key === 'row.modelsFree' ? '免费' : key),
    }))
    await waitFor(() => { expect(screen.getByText('限时折扣')).toBeTruthy() })
    expect(screen.queryByText('折扣')).toBeNull()
  })

  it('菜单位置用上游的紧凑措辞（窄行放不下四字）', async () => {
    stubFetch(() => statusWith(SHORT_PROMO()))
    render(createElement(WbModelLabel, {
      provider: { id: 'workbuddy-models', name: 'WorkBuddy' },
      model: { id: 'hy3', name: 'hy3 · 免费' },
      placement: 'menu' as const,
      selected: false,
      t: (key: string) => (key === 'row.modelsFree' ? '免费' : key),
    }))
    await waitFor(() => { expect(screen.getByText('折扣')).toBeTruthy() })
    expect(screen.queryByText('限时折扣')).toBeNull()
  })

  it('没有译器时不崩，且不写死中文（倍率为 0 时干脆不画价格）', async () => {
    stubFetch(() => statusWith(SHORT_PROMO()))
    const { container } = render(createElement(WbModelLabel, {
      provider: { id: 'workbuddy-models', name: 'WorkBuddy' },
      model: { id: 'hy3', name: 'hy3 · 免费' },
      placement: 'menu' as const,
      selected: false,
      // 故意不给 t：受限宿主的真实情况。
    }))
    await waitFor(() => { expect(screen.getByText('折扣')).toBeTruthy() })
    // 名字还在、徽标还在，只有「免费」那句说明缺席 —— 比整行消失好。
    expect(container.textContent).toContain('hy3')
    expect(container.textContent).not.toContain('免费使用')
  })

  it('缓存被清掉后重新挂载会再取一次数（reset 真的生效）', async () => {
    let calls = 0
    stubFetch(() => { calls += 1; return statusWith(SHORT_PROMO()) })
    const element = createElement(WbModelLabel, {
      provider: { id: 'workbuddy-models', name: 'WorkBuddy' },
      model: { id: 'hy3', name: 'hy3 · 免费' },
      placement: 'menu' as const,
      selected: false,
      t: (key: string) => (key === 'row.modelsFree' ? '免费' : key),
    })
    const first = render(element)
    await waitFor(() => { expect(screen.getByText('折扣')).toBeTruthy() })
    first.unmount()
    resetModelLabelCache()
    render(element)
    await waitFor(() => { expect(calls).toBe(2) })
  })

  it('顶层 busyLevels 缺失时标签照常渲染名字（老宿主退化）', async () => {
    const models = attachPromos([
      { id: 'hy3', name: 'hy3', contextWindow: 128_000, maxTokens: 8_192, creditMultiplier: 0 },
    ], SHORT_PROMO())
    stubFetch(() => new Response(JSON.stringify({
      scannedAtMs: Date.now(), region: 'cn', accounts: [], skipped: [], models, totalCredits: 0,
      // 刻意不给 busyLevels。
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { container } = render(createElement(WbModelLabel, {
      provider: { id: 'workbuddy-models', name: 'WorkBuddy' },
      model: { id: 'hy3', name: 'hy3 · 免费' },
      placement: 'menu' as const,
      selected: false,
      t: (key: string) => (key === 'row.modelsFree' ? '免费' : key),
    }))
    await waitFor(() => { expect(screen.getByText('折扣')).toBeTruthy() })
    expect(container.textContent).toContain('hy3')
  })

  it('快照里这个模型不存在时只画名字（新模型尚未进入目录）', async () => {
    stubFetch(() => statusWith([]))
    const { container } = render(createElement(WbModelLabel, {
      provider: { id: 'workbuddy-models', name: 'WorkBuddy' },
      model: { id: 'brand-new', name: 'brand-new · x0.50' },
      placement: 'trigger' as const,
      selected: false,
      t: (key: string) => key,
    }))
    await waitFor(() => { expect(container.textContent).toContain('brand-new') })
    // 名字里的价格后缀照常被摘掉并单独画（那是名字解析，不依赖快照）。
    expect(container.textContent).toContain('x0.50')
  })

  it('global 的红色徽标也按上游颜色画（不是只有 CN 的绿）', async () => {
    const promos = parseWorkBuddyPromos([{
      id: 'free-now',
      modelIds: ['hy3'],
      badge: { label: 'Free now', color: '#FF0000', display: 'activeOnly' },
      schedule: { validFrom: '2020-01-01T00:00:00+08:00', validUntil: '2099-01-01T00:00:00+08:00' },
      priority: 200,
    }], [])
    const models = attachPromos([
      { id: 'hy3', name: 'hy3', contextWindow: 128_000, maxTokens: 8_192, creditMultiplier: 0 },
    ], promos)
    stubFetch(() => new Response(JSON.stringify({
      scannedAtMs: Date.now(), region: 'global', accounts: [], skipped: [], models, totalCredits: 0,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    render(createElement(WbModelLabel, {
      provider: { id: 'workbuddy-models-global', name: 'WorkBuddy Global' },
      model: { id: 'hy3', name: 'hy3 · 免费' },
      placement: 'menu' as const,
      selected: false,
      t: (key: string) => key,
    }))
    await waitFor(() => { expect(screen.getByText('Free now')).toBeTruthy() })
    // jsdom 把 #FF0000 规范成 rgb(255, 0, 0)。
    const badge = screen.getByText('Free now')
    const style = badge.getAttribute('style') ?? ''
    expect(style).toContain('rgb(255, 0, 0)')
  })

  it('global 区域读的是 global 的 /status（不串台到 cn）', async () => {
    const urls: string[] = []
    stubFetch((url) => {
      urls.push(url)
      return new Response(JSON.stringify({
        scannedAtMs: Date.now(), region: 'global', accounts: [], skipped: [], models: [], totalCredits: 0,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    render(createElement(WbModelLabel, {
      provider: { id: 'workbuddy-models-global', name: 'WorkBuddy Global' },
      model: { id: 'hy3', name: 'hy3' },
      placement: 'menu' as const,
      selected: false,
    }))
    await waitFor(() => { expect(urls.length).toBe(1) })
    expect(urls[0]).toContain('region=global')
  })
})

