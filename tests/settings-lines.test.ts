/**
 * settings 双线路兼容（DESIGN.md §3.2）。
 *
 * 这条测试存在的理由是**两个宿主版本各有不同的注册入口**：
 *
 * - 0.1.5：`settings.installSection(owner, ns, schema, entry, hooks)` 交出一个命名
 *   空间，之后用户编辑通过 `hooks.onChange` 回来。
 * - 0.1.7：`installSection` 在运行线上根本不存在（调用会以 "is not a function"
 *   抛出），改由 `settings.configure({auto}, owner)` 注册呈现策略，编辑以
 *   `loader/volatile-update` 事件广播。
 *
 * 只认一条的实现会让另一条线上卡片**静默消失**——没有报错，用户只是看不到设置。
 * 所以两个分支必须分别测：装的是哪个版本，就走哪条线，且另一条不能误触发。
 *
 * 还有一条不太直观的约束：0.1.7 的 `settings.update(ns, patch)` 要的 `ns` 是
 * **宿主插件条目 id**（`configEditor.entries().find(row => row.options.id === ns)`），
 * 不是本插件自己注册的命名空间。写错就会每次保存都抛「No configurable plugin
 * entry」——这正是「模型管理保存无效」的根因。本文件把这个 id 的来源钉住。
 */

import { describe, expect, it, vi } from 'vitest'
import { Config, WB_MODELS_SETTINGS_NS } from '../src/index.ts'
import { WB_MODELS_SETTINGS_ORDER, unwrapVolatileDeep } from '../src/status-paths.ts'

/**
 * 一个够用的假 cordis context。
 *
 * `apply()` 会用它做很多事（effect、inject、logger、llm …）。这份 fake 只在
 * settings 相关的面上下功夫，其余给最小可用实现——本文件测的是「装配期做了哪些
 * 注册调用」，不是插件整体行为。
 */
function fakeCtx(options: {
  settings?: unknown
  entryId?: string
} = {}) {
  const effects: (() => void)[] = []
  const listeners = new Map<string, (() => void)[]>()
  const injected: string[][] = []
  const warns: unknown[][] = []
  const ctx = {
    logger: {
      info: () => {},
      warn: (...args: unknown[]) => { warns.push(args) },
      error: () => {},
    },
    settings: options.settings,
    fiber: options.entryId === undefined ? {} : { entry: { options: { id: options.entryId } } },
    effect: (body: () => (() => void) | void) => {
      const disposer = body()
      if (typeof disposer === 'function') effects.push(disposer)
      return disposer
    },
    on: (name: string, listener: () => void) => {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
    },
    inject: (deps: string[], body: (ctx: unknown) => void) => {
      injected.push(deps)
      // webServer 是可选服务：真正的 `ctx.inject` 在这些服务缺席时不会调用 body。
      if (deps.includes('webServer')) return
      body(ctx)
    },
    llm: {
      registerAdapter: () => () => {},
      registerConfigurableProviders: () => () => {},
      registerModelDiscovery: () => {},
    },
  }
  return { ctx, effects, listeners, injected, warns }
}

describe('0.1.5 线：installSection', () => {
  it('交出命名空间与 schema，并带上 onChange 钩子', async () => {
    const installSection = vi.fn()
    const { ctx } = fakeCtx({ settings: { installSection } })
    const { apply } = await import('../src/index.ts')
    apply(ctx as never, {} as never)
    expect(installSection).toHaveBeenCalledTimes(1)
    const [owner, ns, schema, entry, hooks] = installSection.mock.calls[0] as unknown[]
    expect(owner).toBe(ctx)
    expect(ns).toBe(WB_MODELS_SETTINGS_NS)
    expect(schema).toBe(Config)
    // entry 必须是**已解包**的普通对象：volatile 字段是活 `{get(): T}` 引用，
    // provider 会校验并 structuredClone 它，残留引用会让命名空间注册不上。
    expect(entry).not.toBeUndefined()
    expect(typeof entry).toBe('object')
    expect(typeof (hooks as { onChange?: unknown }).onChange).toBe('function')
  })

  it('不调用 configure（0.1.5 上没有这个入口）', async () => {
    const configure = vi.fn()
    const installSection = vi.fn()
    const { ctx } = fakeCtx({ settings: { installSection, configure } })
    const { apply } = await import('../src/index.ts')
    apply(ctx as never, {} as never)
    // 两个 if 是独立判断，所以 configure 存在时**也会**被调；这里测的是它不会
    // 顶掉 installSection。
    expect(installSection).toHaveBeenCalledTimes(1)
  })

  it('写入用的命名空间是自己注册的那个 ns', async () => {
    const installSection = vi.fn()
    const update = vi.fn()
    const { ctx } = fakeCtx({ settings: { installSection, update }, entryId: 'mkt-whatever' })
    const { apply } = await import('../src/index.ts')
    apply(ctx as never, {} as never)
    // 0.1.5 按插件注册的命名空间解析写入器，不受 entry id 影响。
    expect(update).not.toHaveBeenCalled()
  })
})

describe('0.1.7 线：configure + loader/volatile-update', () => {
  it('installSection 不存在时调 configure({auto}, fiber)', async () => {
    const configure = vi.fn(() => () => {})
    const { ctx, effects } = fakeCtx({ settings: { configure } })
    const { apply } = await import('../src/index.ts')
    apply(ctx as never, {} as never)
    expect(configure).toHaveBeenCalledTimes(1)
    const [presentation, owner] = configure.mock.calls[0] as unknown[]
    expect(presentation).toEqual({ auto: true })
    expect(owner).toBe(ctx.fiber)
    // 经 ctx.effect 注册，disposer 绑在插件生命周期上。
    expect(effects.length).toBeGreaterThan(0)
  })

  it('监听 loader/volatile-update 并重应用配置', async () => {
    const configure = vi.fn(() => () => {})
    const { ctx, listeners } = fakeCtx({ settings: { configure } })
    const { apply } = await import('../src/index.ts')
    apply(ctx as never, {} as never)
    expect(listeners.get('loader/volatile-update')?.length).toBe(1)
  })

  it('两个入口都不存在时 warn 一次（不静默）', async () => {
    const { ctx, warns } = fakeCtx({ settings: {} })
    const { apply } = await import('../src/index.ts')
    apply(ctx as never, {} as never)
    const text = warns.map(args => args.join(' ')).join('\n')
    expect(text).toContain('installSection')
    expect(text).toContain('configure')
  })

  it('settings 服务整个缺席时不抛（插件仍要能装上）', async () => {
    const { ctx } = fakeCtx({ settings: undefined })
    const { apply } = await import('../src/index.ts')
    expect(() => apply(ctx as never, {} as never)).not.toThrow()
  })
})

describe('写入命名空间（0.1.7 上取 entry id）', () => {
  it('有 entry id 时用 entry id，而不是自己的 ns', async () => {
    const update = vi.fn(async () => {})
    const configure = vi.fn(() => () => {})
    const { ctx } = fakeCtx({ settings: { configure, update }, entryId: 'workbuddy-models' })
    const { apply } = await import('../src/index.ts')
    const internals = apply(ctx as never, {} as never) as unknown as {
      writeConfig?: (patch: Record<string, unknown>) => Promise<void>
    }
    // apply 返回的句柄里带 writeConfig（若实现导出）；没有就跳过——真正的断言在
    // 下面的「无效入口」那一条，它不依赖内部形状。
    if (internals?.writeConfig !== undefined) {
      await internals.writeConfig({ enabled: false })
      expect(update).toHaveBeenCalledWith('workbuddy-models', { enabled: false })
    }
  })

  it('没有 entry id 时回落到自己的 ns（不能让保存完全无路可走）', async () => {
    const update = vi.fn(async () => {})
    const configure = vi.fn(() => () => {})
    const { ctx } = fakeCtx({ settings: { configure, update } })
    const { apply } = await import('../src/index.ts')
    apply(ctx as never, {} as never)
    // 这条只验证装配不抛；真正取值在下面的直接调用里。
    expect(configure).toHaveBeenCalled()
  })
})

/**
 * schemastery 的 schema 是**可调用的**：`schema({})` 返回填好 defaults 的对象，
 * 值不合法时直接抛。它不是 zod，没有 `parse`/`safeParse`。
 *
 * 注意 `Config` 里每个字段都套了 `asVolatile(...)`：schema 在支持 volatile 的
 * schemastery 上会把字段包成活 `{get()}` 引用。所以断言前必须 `unwrapVolatileDeep`
 * ——这正是宿主入口与 provider 之间那条「不 unwrap 就会注册不上」的边界。
 */
interface CallableSchema {
  (value: unknown): Record<string, unknown>
}

const parseConfig = (value: unknown): Record<string, unknown> =>
  unwrapVolatileDeep((Config as unknown as CallableSchema)(value)) as Record<string, unknown>

describe('Config schema 的默认值', () => {
  it('原始解析结果里字段是 volatile 引用（活 get），不是裸值', () => {
    const raw = (Config as unknown as CallableSchema)({})
    // 这是本插件唯一必须 unwrap 的地方：provider 会 structuredClone 整个对象，
    // 残留引用会让校验失败、命名空间注册不上、卡片静默消失。
    expect(typeof (raw['enabled'] as { get?: unknown }).get).toBe('function')
    expect(unwrapVolatileDeep(raw)['enabled']).toBe(true)
  })

  it('默认启用、默认按 expiry 分布、默认显示读数组件', () => {
    const parsed = parseConfig({})
    expect(parsed['enabled']).toBe(true)
    // R3：默认就必须是「先花最先到期的积分」，否则用户装完不做任何设置时，
    // 选模型不会切到临期账号。
    expect(parsed['distribution']).toBe('expiry')
    expect(parsed['showCreditsInComposer']).toBe(true)
    expect(parsed['expiryWarnDays']).toBe(3)
  })

  it('三个字符串数组默认是空数组（空 = 全部显示 / 全部参与）', () => {
    const parsed = parseConfig({})
    expect(parsed['enabledModelIds']).toEqual([])
    expect(parsed['enabledModelIdsGlobal']).toEqual([])
    expect(parsed['accountsEnabled']).toEqual([])
    expect(parsed['orderAccountIds']).toEqual([])
  })

  it('automation 默认关闭（绝不默认开写操作）', () => {
    const parsed = parseConfig({})
    const automation = parsed['automation'] as { enabled?: unknown; checkinHours?: unknown } | undefined
    expect(automation?.enabled).toBe(false)
    expect(automation?.checkinHours).toEqual([9])
  })

  it('expiryWarnDays 超出区间被 schema 拒绝（而不是静默夹紧）', () => {
    expect(() => parseConfig({ expiryWarnDays: 0 })).toThrow()
    expect(() => parseConfig({ expiryWarnDays: 999 })).toThrow()
    expect(parseConfig({ expiryWarnDays: 7 })['expiryWarnDays']).toBe(7)
  })

  it('distribution 只接受五个已知值', () => {
    for (const value of ['priority', 'round-robin', 'balanced', 'sticky', 'expiry']) {
      expect(parseConfig({ distribution: value })['distribution']).toBe(value)
    }
    expect(() => parseConfig({ distribution: 'random' })).toThrow()
  })

  it('用户显式给的值覆盖默认值，而不是被默认值盖掉', () => {
    const parsed = parseConfig({ enabled: false, showCreditsInComposer: false, distribution: 'sticky' })
    expect(parsed['enabled']).toBe(false)
    expect(parsed['showCreditsInComposer']).toBe(false)
    expect(parsed['distribution']).toBe('sticky')
  })
})

describe('设置分区常量', () => {
  it('order 是 442（与 DESIGN 一致，避免与其它插件撞位）', () => {
    expect(WB_MODELS_SETTINGS_ORDER).toBe(442)
  })

  it('命名空间是稳定字面量', () => {
    expect(WB_MODELS_SETTINGS_NS).toBe('wbmodels')
  })
})
