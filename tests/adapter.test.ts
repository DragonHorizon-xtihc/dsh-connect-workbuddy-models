/**
 * 适配器与 LLM 适配层（需求 R2、R3、R1-g 的生效点）。
 *
 * 这里测三件在**运行时**才看得出错的事：
 *
 * 1. `getModels()` 每次都要重读目录 —— 缓存会让用户改完「显示哪些模型」之后，
 *    选择器里还是旧列表，直到重启 DSH。
 * 2. baseUrl 必须真的指向 shim（`${shim.baseUrl()}/v1`），否则请求打到上游域名
 *    时会被当成没有凭据，而错误信息看起来像 key 无效。
 * 3. R3：选模型/发请求前先选号，且默认分布是 `expiry`（先花最先到期的积分）。
 */

import { describe, expect, it } from 'vitest'
import { createWbAdapter, describeSelection } from '../src/adapter.ts'
import { WbCatalog } from '../src/catalog.ts'
import { WbAccountPool } from '../src/accounts.ts'
import type { WbDiscoveredAccount } from '../src/accounts.ts'
import { WB_PROVIDERS } from '../src/status-paths.ts'

const DAY = 86_400_000

function account(id: string, overrides: Partial<WbDiscoveredAccount> = {}): WbDiscoveredAccount {
  return {
    id,
    label: id,
    region: 'cn',
    sourcePath: `/fake/${id}.info`,
    live: true,
    refreshExpired: false,
    tokenExpiresAtMs: Date.now() + 30 * DAY,
    credential: { accessToken: 'tok', refreshToken: 'ref', expiresAtMs: Date.now() + 30 * DAY, domain: '' },
    ...overrides,
  }
}

/** 一个假 shim：只提供 adapter 真正用到的三个成员。 */
function fakeShim(options: { url?: string; token?: string } = {}) {
  return {
    ready: Promise.resolve(),
    baseUrl: () => options.url ?? 'http://127.0.0.1:41234',
    token: () => options.token ?? 'shim-secret',
    close: async () => {},
  }
}

function adapterFor(options: {
  region?: 'cn' | 'global'
  models?: readonly { id: string; name: string; contextWindow?: number; maxTokens?: number; creditMultiplier?: number }[]
  shimUrl?: string
} = {}) {
  const region = options.region ?? 'cn'
  const catalog = new WbCatalog(region)
  if (options.models !== undefined) catalog.applyFetch(options.models as never, Date.now())
  const adapter = createWbAdapter({
    shim: fakeShim({ url: options.shimUrl }) as never,
    catalog,
    region,
  })
  return { adapter, catalog }
}

describe('provider id 必须是 workbuddy-models / workbuddy-models-global', () => {
  it('两个区域各注册到不同的 provider id', () => {
    expect(WB_PROVIDERS.cn).toBe('workbuddy-models')
    expect(WB_PROVIDERS.global).toBe('workbuddy-models-global')
  })

  it('cn adapter 的 providerId 是 workbuddy-models', () => {
    const { adapter } = adapterFor({ region: 'cn' })
    expect(adapter.providerId).toBe('workbuddy-models')
  })

  it('global adapter 的 providerId 是 workbuddy-models-global', () => {
    const { adapter } = adapterFor({ region: 'global' })
    expect(adapter.providerId).toBe('workbuddy-models-global')
  })

  it('displayName 区分两个区域（用户在模型选择器里要能分辨）', () => {
    expect(adapterFor({ region: 'cn' }).adapter.displayName).toContain('国内')
    expect(adapterFor({ region: 'global' }).adapter.displayName).toContain('国际')
  })
})

describe('getModels 每次重读目录', () => {
  it('新装的 adapter 用 fallback 目录，非空', () => {
    const { adapter } = adapterFor()
    expect(adapter.buildModels().length).toBeGreaterThan(0)
  })

  it('目录刷新后 getModels 立刻反映新模型（不缓存）', () => {
    const { adapter, catalog } = adapterFor({ models: [{ id: 'old', name: 'Old' }] })
    expect(adapter.buildModels().map(m => m.id)).toEqual(['old'])
    catalog.applyFetch([{ id: 'new-1', name: 'N1' }, { id: 'new-2', name: 'N2' }], Date.now())
    expect(adapter.buildModels().map(m => m.id)).toEqual(['new-1', 'new-2'])
  })

  it('用户改「显示哪些模型」后，getModels 立刻只剩勾选的（R1-g 生效点）', () => {
    const { adapter, catalog } = adapterFor({
      models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    })
    catalog.setEnabledIds(['b'])
    expect(adapter.buildModels().map(m => m.id)).toEqual(['b'])
  })

  it('catalog 不可用时 getModels 为空（本区域没登录 = 不该提供模型）', () => {
    const { adapter, catalog } = adapterFor({ models: [{ id: 'a', name: 'A' }] })
    catalog.setUsable(false)
    expect(adapter.buildModels()).toEqual([])
  })
})

describe('模型投影到 pi-ai 形状', () => {
  it('baseUrl 指向 shim 的 /v1（不是上游域名）', () => {
    const { adapter } = adapterFor({ models: [{ id: 'a', name: 'A' }], shimUrl: 'http://127.0.0.1:5555' })
    expect(adapter.buildModels()[0]?.baseUrl).toBe('http://127.0.0.1:5555/v1')
  })

  it('provider 字段是 providerId，api 是 openai-completions', () => {
    const { adapter } = adapterFor({ models: [{ id: 'a', name: 'A' }] })
    const model = adapter.buildModels()[0]
    expect(model?.provider).toBe('workbuddy-models')
    expect(model?.api).toBe('openai-completions')
  })

  it('缺 contextWindow / maxTokens 时用偏保守的默认值', () => {
    const { adapter } = adapterFor({ models: [{ id: 'a', name: 'A' }] })
    const model = adapter.buildModels()[0]
    expect(model?.contextWindow).toBe(128_000)
    expect(model?.maxTokens).toBe(8_192)
  })

  it('上游给了窗口就用上游的', () => {
    const { adapter } = adapterFor({
      models: [{ id: 'a', name: 'A', contextWindow: 1_000_000, maxTokens: 48_000 }],
    })
    const model = adapter.buildModels()[0]
    expect(model?.contextWindow).toBe(1_000_000)
    expect(model?.maxTokens).toBe(48_000)
  })

  it('不宣告 reasoning 档位（名册不带白名单，宣告了就是对所有模型过度承诺）', () => {
    const { adapter } = adapterFor({ models: [{ id: 'a', name: 'A' }] })
    const model = adapter.buildModels()[0]
    expect(model?.reasoning).toBe(false)
    expect((model?.compat as { supportsReasoningEffort?: boolean } | undefined)?.supportsReasoningEffort)
      .toBe(false)
  })

  it('倍率带在显示名里，undefined 不写成 0×', () => {
    const { adapter } = adapterFor({
      models: [
        { id: 'free', name: 'Free', creditMultiplier: 0 },
        { id: 'paid', name: 'Paid', creditMultiplier: 1.5 },
        { id: 'unknown', name: 'Unknown' },
      ],
    })
    const models = adapter.buildModels()
    expect(models.find(m => m.id === 'free')?.name).toContain('免费')
    expect(models.find(m => m.id === 'paid')?.name).toContain('1.5')
    expect(models.find(m => m.id === 'unknown')?.name).not.toContain('0×')
  })
})

describe('R3：默认按「最先到期」选号', () => {
  it('不指定分布时，池的默认分布就是 expiry', () => {
    const pool = new WbAccountPool({})
    pool.applyDiscovery({
      accounts: [account('later'), account('sooner')],
      skipped: [],
    })
    const now = Date.now()
    // later 的积分 30 天后到期，sooner 的 2 天后到期 —— expiry 必须先选 sooner。
    pool.noteCredits('later', { total: 100, packages: [], expiringSoon: 0, nearestExpiryMs: now + 30 * DAY })
    pool.noteCredits('sooner', { total: 100, packages: [], expiringSoon: 0, nearestExpiryMs: now + 2 * DAY })
    expect(pool.pick('cn', { nowMs: now }).account?.id).toBe('sooner')
  })

  it('「先花最先到期的积分」用的是积分到期，不是 token 到期', () => {
    const pool = new WbAccountPool({})
    const now = Date.now()
    pool.applyDiscovery({
      // token 明天就过期，但积分两年后才到期。
      accounts: [account('token-soon', { tokenExpiresAtMs: now + 1 * DAY }), account('credit-soon')],
      skipped: [],
    })
    pool.noteCredits('token-soon', { total: 100, packages: [], expiringSoon: 0, nearestExpiryMs: now + 730 * DAY })
    pool.noteCredits('credit-soon', { total: 100, packages: [], expiringSoon: 0, nearestExpiryMs: now + 3 * DAY })
    // 选 token-soon 会把「明天就失效的登录」用上，而它的积分根本不过期 ——
    // 这既浪费登录也浪费积分。正确行为是先用 credit-soon。
    expect(pool.pick('cn', { nowMs: now }).account?.id).toBe('credit-soon')
  })

  it('纯月包账号（没有到期信息）沉底，且能给出行之有效的原因', () => {
    const pool = new WbAccountPool({})
    const now = Date.now()
    pool.applyDiscovery({ accounts: [account('monthly'), account('oneoff')], skipped: [] })
    // monthly 有余额但没有一次性包（refreshAtMs 不是 expiresAtMs，不构成到期）。
    pool.noteCredits('monthly', { total: 5_000, packages: [], expiringSoon: 0 })
    pool.noteCredits('oneoff', { total: 100, packages: [], expiringSoon: 0, nearestExpiryMs: now + 20 * DAY })
    // 有到期信息的无条件排在没到期信息的前面（rankAccounts 的 _hasExpiry 键）。
    expect(pool.pick('cn', { nowMs: now }).account?.id).toBe('oneoff')
    // 但池必须能解释 monthly 为什么在后面，否则用户会以为它是坏的。
    const reason = pool.exclusionReason(pool.find('monthly'))
    // 它不是「被排除」（仍可用），所以要能区分「可用但排后面」与「不可用」。
    expect(reason).toBeUndefined()
    const ranked = pool.rank('cn', now)
    expect(ranked.map(row => row.account.id)).toEqual(['oneoff', 'monthly'])
  })

  it('用户在 R4 选了别的分布，就按那个分布走', () => {
    const pool = new WbAccountPool({ distribution: 'priority' })
    const now = Date.now()
    // priority 下余额最高的优先，即使它的积分两年后才到期。
    pool.applyDiscovery({ accounts: [account('rich'), account('soonish')], skipped: [] })
    pool.noteCredits('rich', { total: 9_000, packages: [], expiringSoon: 0, nearestExpiryMs: now + 730 * DAY })
    pool.noteCredits('soonish', { total: 100, packages: [], expiringSoon: 0, nearestExpiryMs: now + 2 * DAY })
    expect(pool.pick('cn', { nowMs: now }).account?.id).toBe('rich')
  })

  it('手动选定的账号优先于任何分布', () => {
    const pool = new WbAccountPool({})
    const now = Date.now()
    pool.applyDiscovery({ accounts: [account('auto'), account('manual')], skipped: [] })
    pool.noteCredits('auto', { total: 100, packages: [], expiringSoon: 0, nearestExpiryMs: now + 1 * DAY })
    pool.noteCredits('manual', { total: 100, packages: [], expiringSoon: 0, nearestExpiryMs: now + 300 * DAY })
    pool.setPreferred('cn', 'manual')
    expect(pool.pick('cn', { nowMs: now }).account?.id).toBe('manual')
  })
})

describe('选号说明文案', () => {
  it('手动选定 / 按分布 / 兜底 三种理由各自可辨', () => {
    const chosen = { id: 'a', label: '小明' }
    expect(describeSelection('cn', chosen, 'preferred')).toContain('手动选定')
    expect(describeSelection('cn', chosen, 'distribution')).toContain('账户使用方式')
    expect(describeSelection('global', chosen, 'none')).toContain('国际版')
  })

  it('没有可服务账号时给出可操作提示', () => {
    const text = describeSelection('cn', undefined, 'distribution')
    expect(text).toContain('没有可服务的账号')
    expect(text).toContain('登录')
  })
})
