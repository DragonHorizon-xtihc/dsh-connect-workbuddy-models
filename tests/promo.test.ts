/**
 * 促销/档位徽标的解析与选择（纯函数层）。
 *
 * 夹具是**上游真实应答的逐字摘录**，不是照着类型手搓的形状。这一点在这里不是洁癖：
 * 徽标的全部难点都在真实数据的畸形处 —— `schedule` 可以是 `null`、`discount` 可以是
 * `null`、折扣价是字符串 `"0.50x"` 而不是数字、紧凑措辞的键名是 `shortLabel` 不是
 * `short`、跨午夜窗口有两种写法、`validUntil` 是排他的。手搓的夹具会把这些一起搓平，
 * 结果是测试全绿而界面上仍然什么都没有。
 *
 * 夹具取自 `.probe/promo-live.mjs` 在 2026-10-26 的实测：
 *
 * - CN：`data.modelPromotions` 7 条 + `data.modelTiers` 1 条
 * - global：`data.modelPromotions` 2 条 + `data.modelTiers` 1 条
 * - 两个数组**只在应用通道**（PRODUCT_UA）出现；CLI 通道对同一个 URL 的应答里
 *   `promos=undefined`。本插件的 `readCatalogModels` 用的就是应用通道。
 *
 * `step-5-discount-daytime-badge-202610` 在 10-25 的抓取里还在（第 8 条），有效期到
 * 10-26 为止，本次抓取时已经过期 —— 它被单独放在 `EXPIRED_STEP5` 里，用来测「活动
 * 结束后徽标必须消失」，而不是混在「当前 feed」里冒充一条还在跑的促销。
 *
 * 三层覆盖，缺一层都测不到真东西：
 *
 * 1. **解析**（`parseWorkBuddyPromos`）—— 该留的留、该丢的丢。丢错了不报错，表现是
 *    「某个模型本该有徽标却永远没有」。
 * 2. **挂载**（`attachPromos`）—— 同模型的多条候选必须**全部**跟着走：`glm-5.2` 有
 *    两条，一条带折扣一条不带，选哪条取决于**看的时刻**。在解析期挑一条等于把这个
 *    决定冻在取数时刻。
 * 3. **按时钟选**（`selectPromoBadge` / `selectPromoMultiplier`）—— 活动窗、常驻窗、
 *    跨午夜，以及「常驻徽标不许改价」这条边界。
 */

import { describe, expect, it } from 'vitest'
import {
  attachPromos,
  parseWorkBuddyPromos,
  promoActiveAt,
  promoBadgeColor,
  promoBadgeLabel,
  promoBadgeShortLabel,
  promoBadgeTooltip,
  promoWithinAbsoluteWindow,
  promoWithinDailyWindow,
  selectPromoBadge,
  selectPromoMultiplier,
} from '../src/promo.ts'
import type { WbPromo } from '../src/promo.ts'

// ── 上游真实夹具 ──────────────────────────────────────────────────────────

/** CN 当前在跑的 7 条促销（逐字摘录）。 */
const CN_PROMOTIONS: unknown = [
  {
    id: 'glm-52-night-discount-202607',
    enabled: true,
    kind: 'discount',
    modelIds: ['glm-5.2'],
    badge: { label: '夜间折扣', color: '#009273' },
    hover: { textZh: '23:00–7:50 享五折。' },
    schedule: { timezone: 'Asia/Shanghai', daily: [{ end: '7:50', start: '23:00' }] },
    discount: { discountedCredits: '0.50x', displayMode: 'strikethrough', factor: 0.5 },
    priority: 100,
  },
  {
    id: 'glm-52-night-discount-daytime-badge-202607',
    enabled: true,
    kind: 'discount',
    modelIds: ['glm-5.2'],
    badge: { label: '夜间折扣', color: '#009273' },
    schedule: { timezone: 'Asia/Shanghai', daily: [{ end: '23:00', start: '7:50' }] },
    discount: null,
    priority: 50,
  },
  {
    id: 'hy3-free-trial-202608',
    enabled: true,
    kind: 'trial',
    modelIds: ['hy3', 'hy3-b', 'hy3-c'],
    badge: { label: '限时免费', color: '#009273', display: 'activeOnly' },
    schedule: { timezone: 'Asia/Shanghai', validFrom: '2026-07-06T00:00:00+08:00', validUntil: '2026-11-01T00:00:00+08:00' },
    discount: { discountedCredits: '0x', displayMode: 'replace', factor: 0 },
    priority: 200,
  },
  {
    id: 'hy4-night-discount-badge-202609',
    enabled: true,
    kind: 'discount',
    modelIds: ['hy4-preview', 'hy4-preview-ctrl', 'hy4-preview-exp'],
    badge: { label: '夜间免费', color: '#009273' },
    schedule: {
      timezone: 'Asia/Shanghai',
      validFrom: '2026-09-11T00:00:00+08:00',
      validUntil: '2026-11-01T00:00:00+08:00',
      daily: [{ end: '23:00', start: '8:00' }],
    },
    discount: null,
    priority: 50,
  },
  {
    id: 'hy4-night-discount-daytime-badge-202609',
    enabled: true,
    kind: 'discount',
    modelIds: ['hy4-preview', 'hy4-preview-ctrl', 'hy4-preview-exp'],
    badge: { label: '夜间免费', color: '#009273' },
    schedule: {
      timezone: 'Asia/Shanghai',
      validFrom: '2026-09-11T00:00:00+08:00',
      validUntil: '2026-11-01T00:00:00+08:00',
      daily: [{ end: '23:59', start: '23:00' }, { end: '8:00', start: '0:00' }],
    },
    discount: { discountedCredits: '0.00x', displayMode: 'strikethrough', factor: 0 },
    priority: 50,
  },
  {
    id: 'ds-discount-daytime-badge-202608',
    enabled: true,
    kind: 'discount',
    modelIds: ['deepseek-v4-flash-ioa', 'deepseek-v4.1-flash', 'deepseek-v4-pro-ioa', 'deepseek-v4-flash', 'deepseek-v4-pro'],
    badge: { label: '夜间折扣', color: '#009273' },
    schedule: { timezone: 'Asia/Shanghai', daily: [{ end: '23:59', start: '0:00' }] },
    discount: null,
    priority: 50,
  },
  {
    id: 'space-bunny-discount-202610',
    enabled: true,
    kind: 'discount',
    modelIds: ['space-bunny'],
    // 紧凑措辞的键名是 `shortLabel` —— 写成 `short` 的夹具会让这条分支永远测不到。
    badge: { label: '限时折扣', shortLabel: '折扣', color: '#009273' },
    hover: { textZh: '10月2日-10月7日，享限时折扣。', action: { labelZh: '去使用', type: 'selectModel' } },
    schedule: { timezone: 'Asia/Shanghai', validFrom: '2026-10-02T00:00:00+08:00', validUntil: '2026-10-08T00:00:00+08:00' },
    priority: 100,
  },
]

/** CN 的档位（`schedule: null`、`discount: null`、`badge.color: null`）。 */
const CN_TIERS: unknown = [
  {
    id: 'tier-standard-2026q3',
    enabled: true,
    modelIds: ['glm-5.3', 'glm-5.3-flash', 'kimi-k2.8-preview'],
    badge: { label: '订阅优先', color: null },
    schedule: null,
    discount: null,
    priority: 20,
  },
]

/**
 * 10-25 那版 feed 里的第 8 条；有效期至 10-26，本次抓取时已过期。
 *
 * 单独成组（而不是混进 `CN_PROMOTIONS`）是因为它已经不在当前 feed 里了：把它当成
 * 「现在还有的促销」会让「活动结束后徽标必须消失」这条断言失去意义。
 *
 * 形状是**数组** —— `parseWorkBuddyPromos` 的第一个参数就是上游那个数组本身。
 */
const EXPIRED_STEP5_PROMOTIONS: unknown = [{
  id: 'step-5-discount-daytime-badge-202610',
  enabled: true,
  kind: 'discount',
  modelIds: ['step-5-preview'],
  badge: { label: '独家限免', labelEn: 'ExclusiveFree', color: '#009273' },
  schedule: { timezone: 'Asia/Shanghai', validFrom: '2026-10-12T00:00:00+08:00', validUntil: '2026-10-26T00:00:00+08:00' },
  discount: { discountedCredits: '0.00x', displayMode: 'strikethrough', factor: 0 },
  priority: 50,
}]

const GLOBAL_PROMOTIONS: unknown = [
  {
    id: 'hy3-free-trial-202608',
    enabled: true,
    modelIds: ['hy3'],
    badge: { label: 'Free now', color: '#FF0000', display: 'activeOnly' },
    schedule: { timezone: 'Asia/Shanghai', validFrom: '2026-07-06T00:00:00+08:00', validUntil: '2026-11-01T00:00:00+08:00' },
    discount: { discountedCredits: '0x', displayMode: 'replace', factor: 0 },
    priority: 200,
  },
  {
    id: 'deepseek-v4.1-flash',
    enabled: true,
    modelIds: ['deepseek-v4.1-flash'],
    badge: { label: 'Free now', color: '#FF0000', display: 'activeOnly' },
    schedule: { timezone: 'Asia/Shanghai', validFrom: '2026-08-06T00:00:00+08:00', validUntil: '2026-11-01T00:00:00+08:00' },
    discount: { discountedCredits: '0x', displayMode: 'replace', factor: 0 },
    priority: 200,
  },
]

/**
 * global 的档位：12 个模型、`color` 是绿而不是红、没有 `schedule`。
 *
 * 它是「常驻徽标」这条路径唯一的真实样本 —— 读不到它，`Pro Only` 就永远画不出来。
 */
const GLOBAL_TIERS: unknown = [
  {
    id: 'gpt-pro-only',
    enabled: true,
    modelIds: [
      'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol',
      'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'grok-4.7',
      'gemini-3.8-flash', 'kimi-k3.1-pro-highspeed',
    ],
    badge: { label: 'Pro Only', labelEn: 'Pro Only', color: '#009273' },
    schedule: null,
    discount: null,
    priority: 200,
  },
]

/** 北京时间某个时刻的毫秒数。CN 的窗口都写在 Asia/Shanghai 里。 */
function beijing(month: number, day: number, hour: number, minute = 0): number {
  return Date.UTC(2026, month - 1, day, hour - 8, minute, 0)
}

function byId(promos: readonly WbPromo[], id: string): WbPromo {
  const found = promos.find(promo => promo.id === id)
  if (found === undefined) throw new Error(`夹具里没有 ${id}`)
  return found
}

// ── 解析 ─────────────────────────────────────────────────────────────────

describe('parseWorkBuddyPromos 读真实的两个数组', () => {
  it('CN 的 7 条促销 + 1 条档位全部留下，顺序是先促销后档位', () => {
    const promos = parseWorkBuddyPromos(CN_PROMOTIONS, CN_TIERS)
    expect(promos).toHaveLength(8)
    expect(promos.slice(0, 7).every(promo => promo.source === 'promotion')).toBe(true)
    expect(promos[7]?.source).toBe('tier')
    expect(promos[7]?.id).toBe('tier-standard-2026q3')
  })

  it('global 的 2 条促销 + 1 条档位同样齐全', () => {
    const promos = parseWorkBuddyPromos(GLOBAL_PROMOTIONS, GLOBAL_TIERS)
    expect(promos).toHaveLength(3)
    expect(promos.filter(promo => promo.source === 'tier')).toHaveLength(1)
    // 12 个模型都要挂上，否则「Pro Only」只在一部分模型上出现。
    expect(byId(promos, 'gpt-pro-only').modelIds).toHaveLength(12)
  })

  it('折扣价是字符串时也解析成数字；`0x` 是 0 而不是「没有折扣」', () => {
    const promos = parseWorkBuddyPromos(CN_PROMOTIONS, CN_TIERS)
    expect(byId(promos, 'glm-52-night-discount-202607').discount?.multiplier).toBe(0.5)
    expect(byId(promos, 'glm-52-night-discount-202607').discount?.displayMode).toBe('strikethrough')
    // 0x → 0：免费也是一种价格。丢掉它会让限免模型显示成原价。
    expect(byId(promos, 'hy3-free-trial-202608').discount?.multiplier).toBe(0)
    expect(byId(promos, 'hy3-free-trial-202608').discount?.displayMode).toBe('replace')
  })

  it('`schedule: null` 与 `discount: null` 解析成缺键，不是 undefined 值', () => {
    const promos = parseWorkBuddyPromos(CN_PROMOTIONS, CN_TIERS)
    const tier = byId(promos, 'tier-standard-2026q3')
    // 键不存在才叫「没有窗口」；带着 `schedule: undefined` 会让 `'schedule' in promo`
    // 为真，下游任何按「有没有这个键」分支的判断都会走错。
    expect('schedule' in tier).toBe(false)
    expect('discount' in tier).toBe(false)
  })

  it('`display: activeOnly` 与 `shortLabel` 都保留下来', () => {
    const promos = parseWorkBuddyPromos(CN_PROMOTIONS, CN_TIERS)
    expect(byId(promos, 'hy3-free-trial-202608').badge.display).toBe('activeOnly')
    expect(byId(promos, 'space-bunny-discount-202610').badge.shortLabel).toBe('折扣')
    // 没写 display 的条目不该被补成 activeOnly：缺省语义是「常驻」。
    expect(byId(promos, 'tier-standard-2026q3').badge.display).toBeUndefined()
  })

  it('`hover.textZh` 保留，`hover.action` 这类无关字段被忽略', () => {
    const promos = parseWorkBuddyPromos(CN_PROMOTIONS, CN_TIERS)
    const bunny = byId(promos, 'space-bunny-discount-202610')
    expect(bunny.hover?.textZh).toContain('限时折扣')
    // action 不是文案，本插件画不了按钮，也不该把它当成一段说明。
    expect(Object.keys(bunny.hover ?? {})).toEqual(['textZh'])
  })

  it('没有 modelIds 或没有 badge 的条目被丢掉（它们画不出来也挂不上）', () => {
    const promos = parseWorkBuddyPromos([
      { id: 'no-models', badge: { label: 'x' } },
      { id: 'no-badge', modelIds: ['m'] },
      { id: 'disabled', modelIds: ['m'], badge: { label: 'x' }, enabled: false },
      { id: 'ok', modelIds: ['m'], badge: { label: 'x' } },
    ], undefined)
    expect(promos.map(promo => promo.id)).toEqual(['ok'])
  })

  it('两个数组都缺失或不是数组时返回空表（不抛）', () => {
    expect(parseWorkBuddyPromos(undefined, undefined)).toEqual([])
    expect(parseWorkBuddyPromos('nope', 42)).toEqual([])
    expect(parseWorkBuddyPromos({}, null)).toEqual([])
  })
})

// ── 挂载 ─────────────────────────────────────────────────────────────────

describe('attachPromos 把候选挂到模型上', () => {
  it('同一模型的多条候选**全部**跟着走，按 priority 降序（glm-5.2 有两条）', () => {
    const promos = parseWorkBuddyPromos(CN_PROMOTIONS, CN_TIERS)
    const models = attachPromos([{ id: 'glm-5.2' }, { id: 'glm-5.3' }], promos)
    const glm52 = models[0]?.promos ?? []
    // 解析期挑一条会把「白天只有徽标、夜里才打折」永久压成其中一半。
    expect(glm52).toHaveLength(2)
    expect(glm52.map(promo => promo.priority)).toEqual([100, 50])
    expect(glm52[0]?.id).toBe('glm-52-night-discount-202607')
    expect(models[1]?.promos?.map(promo => promo.id)).toEqual(['tier-standard-2026q3'])
  })

  it('没被点名的模型不带 promos 键（不是带一个空数组）', () => {
    const promos = parseWorkBuddyPromos(CN_PROMOTIONS, CN_TIERS)
    const models = attachPromos([{ id: 'unmentioned' }], promos)
    expect('promos' in (models[0] ?? {})).toBe(false)
  })

  it('空促销表时原样返回，不产生任何键', () => {
    const models = attachPromos([{ id: 'a' }], [])
    expect(models).toEqual([{ id: 'a' }])
  })

  it('一个促销点名多个模型时，每个都挂上（hy3 家族三个、deepseek 五个）', () => {
    const promos = parseWorkBuddyPromos(CN_PROMOTIONS, CN_TIERS)
    const hy3 = attachPromos([{ id: 'hy3' }, { id: 'hy3-b' }, { id: 'hy3-c' }], promos)
    expect(hy3.every(model => model.promos?.length === 1)).toBe(true)
    expect(hy3.map(model => model.promos?.[0]?.id))
      .toEqual(['hy3-free-trial-202608', 'hy3-free-trial-202608', 'hy3-free-trial-202608'])
    const ds = attachPromos([{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }], promos)
    expect(ds.every(model => model.promos?.[0]?.id === 'ds-discount-daytime-badge-202608')).toBe(true)
  })
})

// ── 活动窗 ───────────────────────────────────────────────────────────────

describe('活动窗判定（绝对窗 + 每日窗）', () => {
  it('绝对窗两端都是排他的：validUntil 那一刻已经不成立', () => {
    const step = byId(parseWorkBuddyPromos(EXPIRED_STEP5_PROMOTIONS, undefined), 'step-5-discount-daytime-badge-202610')
    expect(promoWithinAbsoluteWindow(step, beijing(10, 12, 0))).toBe(true)
    expect(promoWithinAbsoluteWindow(step, beijing(10, 25, 23))).toBe(true)
    // 10-26 00:00 就是 validUntil，那一刻活动已结束。
    expect(promoWithinAbsoluteWindow(step, beijing(10, 26, 0))).toBe(false)
    // 10-12 00:00 之前不算。
    expect(promoWithinAbsoluteWindow(step, beijing(10, 11, 23))).toBe(false)
    // 本次抓取时刻（10-26 凌晨）它已经过期 —— 这就是它在当前 feed 里消失的原因。
    expect(promoWithinAbsoluteWindow(step, Date.UTC(2026, 9, 25, 17, 19))).toBe(false)
  })

  it('已过期的限时折扣不再成立（space-bunny 窗口 10-02 → 10-08）', () => {
    const promos = parseWorkBuddyPromos(CN_PROMOTIONS, CN_TIERS)
    const bunny = byId(promos, 'space-bunny-discount-202610')
    expect(promoWithinAbsoluteWindow(bunny, beijing(10, 5, 12))).toBe(true)
    expect(promoWithinAbsoluteWindow(bunny, beijing(10, 25, 12))).toBe(false)
  })

  it('跨午夜的每日窗两种写法都成立（23:00-7:50 与 23:00-23:59 + 0:00-8:00）', () => {
    const promos = parseWorkBuddyPromos(CN_PROMOTIONS, CN_TIERS)
    const night = byId(promos, 'glm-52-night-discount-202607')
    const twoWindows = byId(promos, 'hy4-night-discount-daytime-badge-202609')
    // 凌晨 3 点：两个窗口都跨午夜，都在窗内。
    expect(promoWithinDailyWindow(night, beijing(10, 20, 3))).toBe(true)
    expect(promoWithinDailyWindow(twoWindows, beijing(10, 20, 3))).toBe(true)
    // 中午 12 点：两个都不在窗内。
    expect(promoWithinDailyWindow(night, beijing(10, 20, 12))).toBe(false)
    expect(promoWithinDailyWindow(twoWindows, beijing(10, 20, 12))).toBe(false)
    // 23:30：两窗并集（23:00-23:59 ∪ 0:00-8:00）里。
    expect(promoWithinDailyWindow(twoWindows, beijing(10, 20, 23, 30))).toBe(true)
    // 7:50 是 night 的终点（排他），7:49 还在里面。
    expect(promoWithinDailyWindow(night, beijing(10, 20, 7, 49))).toBe(true)
    expect(promoWithinDailyWindow(night, beijing(10, 20, 7, 50))).toBe(false)
  })

  it('`0:00`–`23:59` 这条「全天」窗口在 23:59 那一分钟是空的（上游的真实空隙）', () => {
    const promos = parseWorkBuddyPromos(CN_PROMOTIONS, CN_TIERS)
    const ds = byId(promos, 'ds-discount-daytime-badge-202608')
    expect(promoWithinDailyWindow(ds, beijing(10, 20, 0))).toBe(true)
    expect(promoWithinDailyWindow(ds, beijing(10, 20, 12))).toBe(true)
    expect(promoWithinDailyWindow(ds, beijing(10, 20, 23, 58))).toBe(true)
    // 终点排他 ⇒ 23:59:00 起算窗内但 < 23:59 为假：上游把「全天」写成 0:00–23:59
    // 留下的这一分钟空隙是真实存在的，本插件如实反映它，不假装 24 小时。
    expect(promoWithinDailyWindow(ds, beijing(10, 20, 23, 59))).toBe(false)
  })

  it('起点与终点相同的窗口按 24 小时算（不是空窗口）', () => {
    const promos = parseWorkBuddyPromos([
      { id: 'all-day', modelIds: ['m'], badge: { label: '全天' }, schedule: { daily: [{ start: '0:00', end: '0:00' }] } },
      { id: 'explicit-24', modelIds: ['m'], badge: { label: '到 24' }, schedule: { daily: [{ start: '0:00', end: '24:00' }] } },
    ], undefined)
    for (const at of [beijing(10, 20, 0), beijing(10, 20, 12), beijing(10, 20, 23, 59)]) {
      expect(promoWithinDailyWindow(byId(promos, 'all-day'), at)).toBe(true)
      expect(promoWithinDailyWindow(byId(promos, 'explicit-24'), at)).toBe(true)
    }
  })

  it('没有 schedule 的条目按常驻处理：绝对窗与每日窗都算通过', () => {
    const promos = parseWorkBuddyPromos(CN_PROMOTIONS, CN_TIERS)
    const tier = byId(promos, 'tier-standard-2026q3')
    // 「订阅优先」没有任何窗口 —— 它描述的是访问档位，不是一次活动。
    expect(promoWithinAbsoluteWindow(tier, beijing(10, 20, 12))).toBe(true)
    expect(promoWithinDailyWindow(tier, beijing(10, 20, 12))).toBe(true)
  })

  it('绝对窗过了以后 promoActiveAt 为假，即使在每日窗内', () => {
    const promos = parseWorkBuddyPromos(CN_PROMOTIONS, CN_TIERS)
    const hy4 = byId(promos, 'hy4-night-discount-badge-202609')
    // 11-02 中午：每日窗（8:00-23:00）成立，但活动已在 11-01 结束。
    expect(promoWithinDailyWindow(hy4, beijing(11, 2, 12))).toBe(true)
    expect(promoActiveAt(hy4, beijing(11, 2, 12))).toBe(false)
    // 活动进行中且在窗口内。
    expect(promoActiveAt(hy4, beijing(10, 20, 12))).toBe(true)
  })

  it('每日窗解析不出来时不算在跑（宁可少画，也不夸大）', () => {
    const promos = parseWorkBuddyPromos([
      { id: 'broken', modelIds: ['m'], badge: { label: 'x' }, schedule: { daily: [{ start: 'morning', end: 'evening' }] } },
    ], undefined)
    const broken = byId(promos, 'broken')
    // 上游说了有时段，我们只是读不出来 —— 假定「一直跑」是唯一会夸大的猜测。
    expect(promoWithinDailyWindow(broken, beijing(10, 20, 12))).toBe(false)
    expect(promoActiveAt(broken, beijing(10, 20, 12))).toBe(false)
  })
})

// ── 选一个画出来 ─────────────────────────────────────────────────────────

describe('selectPromoBadge 按时钟挑一个', () => {
  it('夜间折扣在夜里成立、白天换成那条白天徽标', () => {
    const promos = parseWorkBuddyPromos(CN_PROMOTIONS, CN_TIERS)
    const candidates = attachPromos([{ id: 'glm-5.2' }], promos)[0]?.promos ?? []
    // 凌晨 2 点：打折那条（priority 100）成立。
    expect(selectPromoBadge(candidates, beijing(10, 20, 2))?.id).toBe('glm-52-night-discount-202607')
    // 中午 12 点：只有白天那条（priority 50）成立。
    expect(selectPromoBadge(candidates, beijing(10, 20, 12))?.id)
      .toBe('glm-52-night-discount-daytime-badge-202607')
  })

  it('常驻的档位徽标（无 schedule、非 activeOnly）任何时候都成立', () => {
    const promos = parseWorkBuddyPromos(CN_PROMOTIONS, CN_TIERS)
    const candidates = attachPromos([{ id: 'glm-5.3' }], promos)[0]?.promos ?? []
    // 档位不是活动：凌晨、中午、年末都该画。
    for (const at of [beijing(10, 20, 2), beijing(10, 20, 12), beijing(12, 31, 23)]) {
      expect(selectPromoBadge(candidates, at)?.badge.label).toBe('订阅优先')
    }
  })

  it('`display: activeOnly` 的活动一旦过期就消失，不常驻', () => {
    const promos = parseWorkBuddyPromos(GLOBAL_PROMOTIONS, GLOBAL_TIERS)
    const candidates = attachPromos([{ id: 'hy3' }], promos)[0]?.promos ?? []
    expect(selectPromoBadge(candidates, Date.UTC(2026, 9, 20, 12))?.badge.label).toBe('Free now')
    // 11-01 之后活动结束，徽标必须消失 —— 这就是 activeOnly 与常驻的区别。
    expect(selectPromoBadge(candidates, Date.UTC(2026, 11, 1, 12))).toBeUndefined()
  })

  it('多条都成立时取 priority 最大的那个', () => {
    const promos = parseWorkBuddyPromos([
      { id: 'low', modelIds: ['m'], badge: { label: '低' }, priority: 10 },
      { id: 'high', modelIds: ['m'], badge: { label: '高' }, priority: 999 },
      { id: 'mid', modelIds: ['m'], badge: { label: '中' }, priority: 100 },
    ], undefined)
    const candidates = attachPromos([{ id: 'm' }], promos)[0]?.promos ?? []
    expect(selectPromoBadge(candidates, Date.now())?.id).toBe('high')
  })

  it('一条都不成立时返回 undefined（调用方据此不画）', () => {
    const promos = parseWorkBuddyPromos(CN_PROMOTIONS, CN_TIERS)
    const candidates = attachPromos([{ id: 'space-bunny' }], promos)[0]?.promos ?? []
    // 已过期、且没有常驻路径。
    expect(selectPromoBadge(candidates, beijing(10, 25, 12))).toBeUndefined()
  })

  it('空表与 undefined 都返回 undefined', () => {
    expect(selectPromoBadge(undefined, Date.now())).toBeUndefined()
    expect(selectPromoBadge([], Date.now())).toBeUndefined()
  })
})

describe('selectPromoMultiplier 只改「活动进行中」的价格', () => {
  it('夜间折扣在窗口内给出折扣价，窗外不给', () => {
    const promos = parseWorkBuddyPromos(CN_PROMOTIONS, CN_TIERS)
    const candidates = attachPromos([{ id: 'glm-5.2' }], promos)[0]?.promos ?? []
    expect(selectPromoMultiplier(candidates, beijing(10, 20, 2))).toBe(0.5)
    // 白天那条虽然有徽标，但没有 discount —— 不许凭空造一个价。
    expect(selectPromoMultiplier(candidates, beijing(10, 20, 12))).toBeUndefined()
  })

  it('常驻徽标（无窗口、无 discount）永远不改价', () => {
    const promos = parseWorkBuddyPromos(CN_PROMOTIONS, CN_TIERS)
    const candidates = attachPromos([{ id: 'glm-5.3' }], promos)[0]?.promos ?? []
    expect(selectPromoMultiplier(candidates, beijing(10, 20, 2))).toBeUndefined()
  })

  it('限免的活动期内给出 0（不是 undefined）', () => {
    const promos = parseWorkBuddyPromos(CN_PROMOTIONS, CN_TIERS)
    const candidates = attachPromos([{ id: 'hy3' }], promos)[0]?.promos ?? []
    expect(selectPromoMultiplier(candidates, beijing(10, 20, 12))).toBe(0)
    // 活动结束后既不打折也不显示旧价。
    expect(selectPromoMultiplier(candidates, beijing(11, 2, 12))).toBeUndefined()
  })

  it('同一模型两条都带折扣时，取 priority 高的那个价', () => {
    const promos = parseWorkBuddyPromos([
      { id: 'a', modelIds: ['m'], badge: { label: 'A' }, discount: { discountedCredits: '0.80x', displayMode: 'strikethrough' }, priority: 10 },
      { id: 'b', modelIds: ['m'], badge: { label: 'B' }, discount: { discountedCredits: '0.30x', displayMode: 'strikethrough' }, priority: 500 },
    ], undefined)
    const candidates = attachPromos([{ id: 'm' }], promos)[0]?.promos ?? []
    expect(selectPromoMultiplier(candidates, Date.now())).toBe(0.3)
  })
})

// ── 文案与颜色 ───────────────────────────────────────────────────────────

describe('徽标文案与颜色', () => {
  it('英文界面用 labelEn，中文界面用 label（CN 条目不因英文环境丢中文）', () => {
    const step = byId(parseWorkBuddyPromos(EXPIRED_STEP5_PROMOTIONS, undefined), 'step-5-discount-daytime-badge-202610')
    expect(promoBadgeLabel(step, 'zh-CN')).toBe('独家限免')
    expect(promoBadgeLabel(step, 'en-US')).toBe('ExclusiveFree')
    const cn = parseWorkBuddyPromos(CN_PROMOTIONS, CN_TIERS)
    // 没有 labelEn 的条目在英文环境下仍给中文：上游没给译法，编一个更糟。
    expect(promoBadgeLabel(byId(cn, 'hy4-night-discount-badge-202609'), 'en-US')).toBe('夜间免费')
  })

  it('global 的 `Pro Only` 在两种语言下都是它自己', () => {
    const pro = byId(parseWorkBuddyPromos(GLOBAL_PROMOTIONS, GLOBAL_TIERS), 'gpt-pro-only')
    expect(promoBadgeLabel(pro, 'zh-CN')).toBe('Pro Only')
    expect(promoBadgeLabel(pro, 'en-US')).toBe('Pro Only')
  })

  it('紧凑措辞：有 shortLabel 用 shortLabel，没有就退回完整标签', () => {
    const promos = parseWorkBuddyPromos(CN_PROMOTIONS, CN_TIERS)
    expect(promoBadgeShortLabel(byId(promos, 'space-bunny-discount-202610'), 'zh-CN')).toBe('折扣')
    // 没有 shortLabel 的条目：完整标签好过被裁掉的词。
    expect(promoBadgeShortLabel(byId(promos, 'hy4-night-discount-badge-202609'), 'zh-CN')).toBe('夜间免费')
  })

  it('颜色两种上游写法都认（CN 绿 #009273 / global 红 #FF0000），无颜色时 undefined', () => {
    const cn = parseWorkBuddyPromos(CN_PROMOTIONS, CN_TIERS)
    const global = parseWorkBuddyPromos(GLOBAL_PROMOTIONS, GLOBAL_TIERS)
    expect(promoBadgeColor(byId(cn, 'glm-52-night-discount-202607'))).toBe('#009273')
    expect(promoBadgeColor(byId(global, 'gpt-pro-only'))).toBe('#009273')
    expect(promoBadgeColor(byId(global, 'hy3-free-trial-202608'))).toBe('#FF0000')
    // 档位那条上游给的是 `color: null` → undefined，由调用方退回自己的品牌色。
    expect(promoBadgeColor(byId(cn, 'tier-standard-2026q3'))).toBeUndefined()
  })

  it('非法颜色不透传（上游给个坏值不该让整行样式失效）', () => {
    const promos = parseWorkBuddyPromos([
      { id: 'bad', modelIds: ['m'], badge: { label: 'x', color: 'red' } },
      { id: 'short-hex', modelIds: ['m'], badge: { label: 'y', color: '#0a0' } },
    ], undefined)
    expect(promoBadgeColor(byId(promos, 'bad'))).toBeUndefined()
    // 3 位缩写是合法 CSS，也认。
    expect(promoBadgeColor(byId(promos, 'short-hex'))).toBe('#0a0')
  })

  it('悬停说明的片段按「上游文案 · 有效区间 · 每日时段」拼，空的省掉', () => {
    const promos = parseWorkBuddyPromos(CN_PROMOTIONS, CN_TIERS)
    // 这条只有 hover 文案（没有每日窗，但有空的有效区间）。
    const bunny = byId(promos, 'space-bunny-discount-202610')
    const bunnyTip = promoBadgeTooltip(bunny, 'zh-CN')
    expect(bunnyTip).toContain('限时折扣')
    // 有效区间显示的最后一天是 10-07（validUntil 10-08 排他）。
    expect(bunnyTip).toContain('10月7日')
    expect(bunnyTip).not.toContain('10月8日')

    // 这条有每日窗：时段与 (Asia/Shanghai) 都要出现。
    const night = byId(promos, 'glm-52-night-discount-202607')
    const nightTip = promoBadgeTooltip(night, 'zh-CN')
    expect(nightTip).toContain('23:00')
    expect(nightTip).toContain('7:50')
    expect(nightTip).toContain('Asia/Shanghai')
  })

  it('上游没给 hover 时只剩时间陈述（不会凭空出现促销名）', () => {
    const step = byId(parseWorkBuddyPromos(EXPIRED_STEP5_PROMOTIONS, undefined), 'step-5-discount-daytime-badge-202610')
    const tip = promoBadgeTooltip(step, 'zh-CN')
    // 没有 hover、没有 daily ⇒ 只有有效区间；徽标措辞不重复进 tooltip。
    expect(tip).toContain('10月12日')
    expect(tip).toContain('10月25日')
    expect(tip).not.toContain('独家限免')
  })

  it('hover 文案按语言取，缺一侧就退回另一侧', () => {
    const promos = parseWorkBuddyPromos([
      { id: 'both', modelIds: ['m'], badge: { label: '夜间免费' }, hover: { textZh: '夜里不要钱', textEn: 'free at night' } },
      { id: 'zh-only', modelIds: ['m'], badge: { label: '夜间免费' }, hover: { textZh: '只有中文' } },
    ], undefined)
    expect(promoBadgeTooltip(byId(promos, 'both'), 'zh-CN')).toContain('夜里不要钱')
    expect(promoBadgeTooltip(byId(promos, 'both'), 'en-US')).toContain('free at night')
    // 只有中文时不编英文。
    expect(promoBadgeTooltip(byId(promos, 'zh-only'), 'en-US')).toContain('只有中文')
  })
})

// ── 边界与退化 ────────────────────────────────────────────────────────────

/**
 * 上游的 feed 会变。上面几组用的是今天的真实摘录，只能证明「今天的形状读得对」；
 * 这一组证明**形状变了以后**行为仍然定义过：缺 `priority`、换时区、窗口写法变形、
 * 只有 `factor` 没有 `discountedCredits`。
 */
describe('解析的边界与退化', () => {
  it('`priority` 缺失或不是数字时按 0 算（不是丢掉整条，也不是 NaN）', () => {
    const promos = parseWorkBuddyPromos([
      { id: 'no-priority', modelIds: ['m'], badge: { label: '夜间免费' } },
      { id: 'string-priority', modelIds: ['m'], badge: { label: '夜间免费' }, priority: '100' },
      { id: 'nan-priority', modelIds: ['m'], badge: { label: '夜间免费' }, priority: Number.NaN },
    ], undefined)
    expect(promos.map(promo => promo.id)).toEqual(['no-priority', 'string-priority', 'nan-priority'])
    // 字符串 '100' 与 NaN 都不当作数字 —— 上游的权重全是 JSON number。
    expect(promos.map(promo => promo.priority)).toEqual([0, 0, 0])
  })

  it('显式 `enabled: true` 与缺省一样保留；只有 `false` 才丢', () => {
    const promos = parseWorkBuddyPromos([
      { id: 'on', modelIds: ['m'], badge: { label: '夜间免费' }, enabled: true },
      { id: 'off', modelIds: ['m'], badge: { label: '夜间免费' }, enabled: false },
    ], undefined)
    expect(promos.map(promo => promo.id)).toEqual(['on'])
  })

  it('`modelIds` 里的重复项被去重、空串与非字符串被剔掉', () => {
    const promos = parseWorkBuddyPromos([
      { id: 'dup', modelIds: ['m', 'm', '', '  ', 42, 'n'], badge: { label: '夜间免费' } },
    ], undefined)
    expect(byId(promos, 'dup').modelIds).toEqual(['m', 'n'])
  })

  it('`modelIds` 全被剔掉时整条丢掉（挂不上任何模型的促销画不出来）', () => {
    const promos = parseWorkBuddyPromos([
      { id: 'empty', modelIds: ['', 7], badge: { label: '夜间免费' } },
      { id: 'not-array', modelIds: 'm', badge: { label: '夜间免费' } },
    ], undefined)
    expect(promos).toEqual([])
  })

  it('`24:00` 作为终点被接受：23:00–24:00 覆盖 23 点整段', () => {
    const promos = parseWorkBuddyPromos([{
      id: 'late',
      modelIds: ['m'],
      badge: { label: '夜间折扣' },
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '24:00' }] },
    }], undefined)
    const promo = byId(promos, 'late')
    // 北京时间 23:30 = UTC 15:30。
    expect(promoWithinDailyWindow(promo, Date.UTC(2026, 9, 26, 15, 30))).toBe(true)
    // 北京时间 23:59 仍在窗内（终点是 24:00 而不是 23:59，没有那一分钟空洞）。
    expect(promoWithinDailyWindow(promo, Date.UTC(2026, 9, 26, 15, 59))).toBe(true)
    // 零点那一刻已经出窗。
    expect(promoWithinDailyWindow(promo, Date.UTC(2026, 9, 26, 16, 0))).toBe(false)
  })

  it('`24:00` 作为**起点**被拒绝：那个窗口求不出来，于是这条促销不算在跑', () => {
    const promos = parseWorkBuddyPromos([{
      id: 'starts-at-midnight',
      modelIds: ['m'],
      badge: { label: '夜间折扣' },
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '24:00', end: '25:00' }] },
    }], undefined)
    const promo = byId(promos, 'starts-at-midnight')
    // 发布了 daily 却一条都没留下 ⇒ dailyUnusable ⇒ 永不「在跑」（宁可少画）。
    expect(promo.schedule?.dailyUnusable).toBe(true)
    expect(promoWithinDailyWindow(promo, Date.UTC(2026, 9, 26, 16, 30))).toBe(false)
  })

  it('`daily` 是空数组时视为「没有时段」（常驻），不是 dailyUnusable', () => {
    const promos = parseWorkBuddyPromos([{
      id: 'empty-daily',
      modelIds: ['m'],
      badge: { label: '夜间折扣' },
      schedule: { timezone: 'Asia/Shanghai', daily: [] },
    }], undefined)
    const promo = byId(promos, 'empty-daily')
    // 空数组 = 上游什么都没说，与缺席无法区分。
    expect(promo.schedule?.dailyUnusable).toBeUndefined()
    expect(promoWithinDailyWindow(promo, Date.UTC(2026, 9, 26, 4, 0))).toBe(true)
  })

  it('时区不是装饰：同一个绝对时刻，两个时区给出相反结论', () => {
    const promos = parseWorkBuddyPromos([
      {
        id: 'shanghai',
        modelIds: ['m'],
        badge: { label: '夜间折扣' },
        schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '7:00', end: '9:00' }] },
      },
      {
        id: 'new-york',
        modelIds: ['m'],
        badge: { label: '夜间折扣' },
        schedule: { timezone: 'America/New_York', daily: [{ start: '19:00', end: '21:00' }] },
      },
    ], undefined)
    // 2026-10-26T00:00:00Z = 上海 08:00 = 纽约（EDT，UTC-4）前一天 20:00。
    const instant = Date.UTC(2026, 9, 26, 0, 0)
    expect(promoWithinDailyWindow(byId(promos, 'shanghai'), instant)).toBe(true)
    expect(promoWithinDailyWindow(byId(promos, 'new-york'), instant)).toBe(true)
    // 四小时后：上海 12:00（出窗）、纽约 00:00（出窗）。
    const later = Date.UTC(2026, 9, 26, 4, 0)
    expect(promoWithinDailyWindow(byId(promos, 'shanghai'), later)).toBe(false)
    expect(promoWithinDailyWindow(byId(promos, 'new-york'), later)).toBe(false)
  })

  it('时区缺失时按 UTC 求值（不是按本机时区）', () => {
    const promos = parseWorkBuddyPromos([{
      id: 'no-zone',
      modelIds: ['m'],
      badge: { label: '夜间折扣' },
      schedule: { daily: [{ start: '0:00', end: '1:00' }] },
    }], undefined)
    const promo = byId(promos, 'no-zone')
    expect(promoWithinDailyWindow(promo, Date.UTC(2026, 9, 26, 0, 30))).toBe(true)
    expect(promoWithinDailyWindow(promo, Date.UTC(2026, 9, 26, 1, 30))).toBe(false)
  })

  it('时区名非法时不抛：退回 UTC 起点，界面少一个徽标而不是白屏', () => {
    const promos = parseWorkBuddyPromos([{
      id: 'bad-zone',
      modelIds: ['m'],
      badge: { label: '夜间折扣' },
      schedule: { timezone: 'Mars/Olympus', daily: [{ start: '0:00', end: '1:00' }] },
    }], undefined)
    const promo = byId(promos, 'bad-zone')
    // 退回 0 分钟 ⇒ 0:00–1:00 恒成立。这个结论看着「太宽」，但它只在时区名坏掉时出现，
    // 而 Bad zone 的替代方案（抛错）会让整块配置区消失。
    expect(() => promoWithinDailyWindow(promo, Date.now())).not.toThrow()
    expect(promoWithinDailyWindow(promo, Date.UTC(2026, 9, 26, 12, 0))).toBe(true)
  })

  it('只有 `factor` 没有 `discountedCredits` 时用 factor 补位', () => {
    const promos = parseWorkBuddyPromos([{
      id: 'factor-only',
      modelIds: ['m'],
      badge: { label: '夜间折扣' },
      discount: { factor: 0.5, displayMode: 'strikethrough' },
    }], undefined)
    expect(byId(promos, 'factor-only').discount).toEqual({ multiplier: 0.5, displayMode: 'strikethrough' })
  })

  it('`discountedCredits` 读不出来时退回 factor（字符串赢，但只在读得出时赢）', () => {
    const promos = parseWorkBuddyPromos([{
      id: 'bad-string',
      modelIds: ['m'],
      badge: { label: '夜间折扣' },
      discount: { discountedCredits: '免费', factor: 0.8, displayMode: 'replace' },
    }], undefined)
    expect(byId(promos, 'bad-string').discount?.multiplier).toBe(0.8)
  })

  it('没标 `displayMode` 的折扣：倍率解析出来，但不改价（缺席没说怎么读）', () => {
    const promos = parseWorkBuddyPromos([{
      id: 'no-mode',
      modelIds: ['m'],
      badge: { label: '夜间折扣' },
      schedule: { timezone: 'Asia/Shanghai', validFrom: '2020-01-01T00:00:00+08:00' },
      discount: { discountedCredits: '0.5x' },
    }], undefined)
    const promo = byId(promos, 'no-mode')
    expect(promo.discount?.multiplier).toBe(0.5)
    expect(promo.discount?.displayMode).toBeUndefined()
    expect(selectPromoMultiplier([promo], beijing(10, 26, 12))).toBeUndefined()
  })

  it('徽标只有 `labelEn` 时中文界面也用它（有话说胜过空白）', () => {
    const promos = parseWorkBuddyPromos([{
      id: 'en-only',
      modelIds: ['m'],
      badge: { labelEn: 'Free now' },
    }], undefined)
    // 上游的 `label` 是**必需**字段的回落，只有 labelEn 时 labelEn 自己顶上。
    expect(byId(promos, 'en-only').badge.label).toBe('Free now')
    expect(promoBadgeLabel(byId(promos, 'en-only'), 'zh-CN')).toBe('Free now')
  })

  it('三位 hex 颜色也接受（`#0a0` 是合法 CSS），四位 hex 与 rgb() 拒绝', () => {
    const promos = parseWorkBuddyPromos([
      { id: 'short-hex', modelIds: ['m'], badge: { label: '夜间免费', color: '#0a0' } },
      { id: 'four-hex', modelIds: ['m'], badge: { label: '夜间免费', color: '#0a0b' } },
      { id: 'rgb', modelIds: ['m'], badge: { label: '夜间免费', color: 'rgb(0,146,115)' } },
    ], undefined)
    expect(promoBadgeColor(byId(promos, 'short-hex'))).toBe('#0a0')
    expect(promoBadgeColor(byId(promos, 'four-hex'))).toBeUndefined()
    expect(promoBadgeColor(byId(promos, 'rgb'))).toBeUndefined()
  })

  it('`hover` 只有 `action` 没有文案时整块丢掉（不产生空对象）', () => {
    const promos = parseWorkBuddyPromos([{
      id: 'action-only',
      modelIds: ['m'],
      badge: { label: '限时折扣' },
      hover: { action: { labelZh: '去使用', type: 'selectModel' } },
    }], undefined)
    expect(byId(promos, 'action-only').hover).toBeUndefined()
  })

  it('省电模式下也解析：`schedule: {}` 不产生 schedule（与 null 等效）', () => {
    const promos = parseWorkBuddyPromos([{
      id: 'empty-schedule',
      modelIds: ['m'],
      badge: { label: '订阅优先' },
      schedule: {},
    }], undefined)
    // 一个什么陈述都没有的 schedule 与缺席不可区分，别留个空壳给下游判真。
    expect(byId(promos, 'empty-schedule').schedule).toBeUndefined()
  })
})

// ── 多候选共存 ────────────────────────────────────────────────────────────

/**
 * 一个模型上真正会同时挂着好几条候选：`glm-5.2` 在今天的 CN feed 上就有两条
 * 「夜间折扣」（一条带折扣、一条只是白天徽标），而档位徽标又可以叠在同一批模型上。
 * 这一组把「三条以上共存」的交叉情况钉住 —— 单条正确不代表组合正确。
 */
describe('多候选共存时的选择规则', () => {
  const threeWay = (): WbPromo[] => parseWorkBuddyPromos([
    {
      id: 'discount-night',
      modelIds: ['m'],
      badge: { label: '夜间折扣' },
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '7:50' }] },
      discount: { discountedCredits: '0.5x', displayMode: 'strikethrough' },
      priority: 100,
    },
    {
      id: 'badge-day',
      modelIds: ['m'],
      badge: { label: '夜间折扣' },
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '7:50', end: '23:00' }] },
      priority: 50,
    },
    {
      id: 'tier',
      modelIds: ['m'],
      badge: { label: '订阅优先' },
      priority: 20,
    },
  ], undefined)

  it('夜里：带折扣的那条赢，且价格真的减半', () => {
    const promos = threeWay()
    const night = beijing(10, 26, 2)
    expect(selectPromoBadge(promos, night)?.id).toBe('discount-night')
    expect(selectPromoMultiplier(promos, night)).toBe(0.5)
  })

  it('白天：换到白天徽标那条，价格回到原价（常驻与白天徽标都不改价）', () => {
    const promos = threeWay()
    const day = beijing(10, 26, 12)
    expect(selectPromoBadge(promos, day)?.id).toBe('badge-day')
    expect(selectPromoMultiplier(promos, day)).toBeUndefined()
  })

  it('档位徽标（无 schedule）不抢「真的在跑」的那条，即使它优先级不低', () => {
    // 把档位调到最高：它仍然不该赢 —— 无排期的条目只在第二步竞争。
    const promos = parseWorkBuddyPromos([{
      id: 'busy-night',
      modelIds: ['m'],
      badge: { label: '夜间免费' },
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '7:50' }] },
      priority: 10,
    }, {
      id: 'loud-tier',
      modelIds: ['m'],
      badge: { label: '订阅优先' },
      priority: 999,
    }], undefined)
    expect(selectPromoBadge(promos, beijing(10, 26, 2))?.id).toBe('busy-night')
  })

  it('窗口外的两条都不成立时，档位徽标作为常驻项补上（不是什么都不画）', () => {
    const promos = parseWorkBuddyPromos([{
      id: 'closed',
      modelIds: ['m'],
      badge: { label: '夜间免费', display: 'activeOnly' },
      schedule: { timezone: 'Asia/Shanghai', validFrom: '2020-01-01T00:00:00+08:00', validUntil: '2020-02-01T00:00:00+08:00' },
      priority: 999,
    }, {
      id: 'standing-tier',
      modelIds: ['m'],
      badge: { label: '订阅优先' },
      priority: 1,
    }], undefined)
    // activeOnly + 过期 ⇒ 第一步不收、第二步也不收（它自己说过只在活动期内画）。
    expect(selectPromoBadge(promos, beijing(10, 26, 12))?.id).toBe('standing-tier')
    expect(selectPromoMultiplier(promos, beijing(10, 26, 12))).toBeUndefined()
  })

  it('同 priority、同 source 时顺序稳定（不打平到随机）', () => {
    const raw = [
      { id: 'a', modelIds: ['m'], badge: { label: '夜间免费' }, priority: 100 },
      { id: 'b', modelIds: ['m'], badge: { label: '限时免费' }, priority: 100 },
    ]
    // 两次解析 + 多次选择必须给出同一个答案。
    const first = parseWorkBuddyPromos(raw, undefined)
    const second = parseWorkBuddyPromos(raw, undefined)
    expect(selectPromoBadge(first, beijing(10, 26, 12))?.id)
      .toBe(selectPromoBadge(second, beijing(10, 26, 12))?.id)
  })

  it('一条候选挂三个模型时，三个模型各自独立选（互不影响）', () => {
    const promos = parseWorkBuddyPromos([{
      id: 'family',
      modelIds: ['m1', 'm2', 'm3'],
      badge: { label: '限时免费' },
      schedule: { timezone: 'Asia/Shanghai', validFrom: '2020-01-01T00:00:00+08:00', validUntil: '2099-01-01T00:00:00+08:00' },
      priority: 200,
    }], undefined)
    const models = attachPromos([{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }, { id: 'm4' }], promos)
    expect(models.slice(0, 3).map(model => selectPromoBadge(model.promos, beijing(10, 26, 12))?.id))
      .toEqual(['family', 'family', 'family'])
    expect(models[3]?.promos).toBeUndefined()
  })

  it('折扣只跟着「在跑」的那条走：同模型另一条常驻折扣不生效', () => {
    const promos = parseWorkBuddyPromos([{
      id: 'running',
      modelIds: ['m'],
      badge: { label: '限时免费' },
      schedule: { timezone: 'Asia/Shanghai', validFrom: '2020-01-01T00:00:00+08:00', validUntil: '2099-01-01T00:00:00+08:00' },
      discount: { discountedCredits: '0x', displayMode: 'replace' },
      priority: 200,
    }, {
      id: 'dormant-cheap',
      modelIds: ['m'],
      badge: { label: '夜间折扣' },
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '7:50' }] },
      discount: { discountedCredits: '0.1x', displayMode: 'strikethrough' },
      priority: 300,
    }], undefined)
    // 中午：只有 'running' 在跑 ⇒ 价格是它的 0（不是优先级更高的 0.1）。
    expect(selectPromoMultiplier(promos, beijing(10, 26, 12))).toBe(0)
    // 夜里：'dormant-cheap' 优先级更高且也在跑 ⇒ 价格是它的 0.1。
    expect(selectPromoMultiplier(promos, beijing(10, 26, 2))).toBe(0.1)
  })

  it('徽标与折扣可以来自不同条目（徽标取高优先，价格取在跑且有折扣的那条）', () => {
    const promos = parseWorkBuddyPromos([{
      id: 'badge-only',
      modelIds: ['m'],
      badge: { label: '订阅优先' },
      priority: 500,
    }, {
      id: 'price-only',
      modelIds: ['m'],
      badge: { label: '夜间折扣' },
      schedule: { timezone: 'Asia/Shanghai', validFrom: '2020-01-01T00:00:00+08:00' },
      discount: { discountedCredits: '0.5x', displayMode: 'replace' },
      priority: 1,
    }], undefined)
    // 徽标：无排期的档位只在第二步，而带排期的 price-only 在第一步就赢。
    expect(selectPromoBadge(promos, beijing(10, 26, 12))?.id).toBe('price-only')
    expect(selectPromoMultiplier(promos, beijing(10, 26, 12))).toBe(0.5)
  })
})

