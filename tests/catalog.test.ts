/**
 * 模型目录与倍率（需求 R1-f、R1-g、R2）。
 *
 * 三条容易写错、且写错之后**看不出错**的语义集中钉在这里：
 *
 * 1. `enabled` 空集 = 全部显示（不是全都不显示）；
 * 2. 勾选集与目录完全不相交时退化成全部（不是空列表）；
 * 3. 倍率 `undefined ≠ 0` —— CN 静态目录里没有 `creditMultiplier` 字段，
 *    把它当 0 会把**收费模型显示成免费**。
 */

import { describe, expect, it } from 'vitest'
import {
  FALLBACK_MODELS_CN,
  FALLBACK_MODELS_GLOBAL,
  WbCatalog,
  WbCatalogs,
  deriveVisibleModels,
  fallbackModelsFor,
  reparseMultiplier,
  toModelInfo,
} from '../src/catalog.ts'
import type { WbModelInfo } from '../src/status-paths.ts'
import type { WbUpstreamModel } from '../src/upstream.ts'

const model = (id: string): WbModelInfo => ({ id, name: id, maxInputTokens: 1_000, maxOutputTokens: 100 })

describe('静态兜底目录', () => {
  it('两个区域各有一份非空 fallback', () => {
    expect(FALLBACK_MODELS_CN.length).toBeGreaterThan(0)
    expect(FALLBACK_MODELS_GLOBAL.length).toBeGreaterThan(0)
    expect(fallbackModelsFor('cn')).toBe(FALLBACK_MODELS_CN)
    expect(fallbackModelsFor('global')).toBe(FALLBACK_MODELS_GLOBAL)
  })

  it('CN fallback 不带倍率字段 —— 这正是 undefined 必须区别于 0 的原因', () => {
    // 如果哪天有人给 CN 目录补上 creditMultiplier: 0「免得显示未知」，这条会红。
    expect(FALLBACK_MODELS_CN.every(m => m.creditMultiplier === undefined)).toBe(true)
  })

  it('global fallback 带倍率（含 0 表示免费的条目）', () => {
    expect(FALLBACK_MODELS_GLOBAL.some(m => typeof m.creditMultiplier === 'number')).toBe(true)
    expect(FALLBACK_MODELS_GLOBAL.some(m => m.creditMultiplier === 0)).toBe(true)
  })

  it('两份目录的 id 各自唯一', () => {
    for (const list of [FALLBACK_MODELS_CN, FALLBACK_MODELS_GLOBAL]) {
      const ids = list.map(m => m.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
})

describe('倍率解析：undefined 与 0 是两件事', () => {
  it("'x0.00' 解析成 0（真的是免费的）", () => {
    expect(reparseMultiplier('x0.00')).toBe(0)
  })

  it("'x0.50' / 'x1.00' / 'x1.25' 分别解析成 0.5 / 1 / 1.25", () => {
    expect(reparseMultiplier('x0.50')).toBe(0.5)
    expect(reparseMultiplier('x1.00')).toBe(1)
    expect(reparseMultiplier('x1.25')).toBe(1.25)
  })

  it('字段缺失 / 非字符串 / 空串一律是 undefined，**不是** 0', () => {
    expect(reparseMultiplier(undefined)).toBeUndefined()
    expect(reparseMultiplier(null)).toBeUndefined()
    expect(reparseMultiplier(0)).toBeUndefined()
    expect(reparseMultiplier('')).toBeUndefined()
    expect(reparseMultiplier('free')).toBeUndefined()
  })

  it('负数被拒绝（上游没有负倍率，出现就是脏数据）', () => {
    expect(reparseMultiplier('x-1.00')).toBeUndefined()
  })
})

describe('deriveVisibleModels：空集=全部，不相交=全部', () => {
  const catalog = [model('a'), model('b'), model('c')]

  it('undefined 显示全部', () => {
    expect(deriveVisibleModels(catalog, undefined).map(m => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('空数组显示全部（从未配置过的新装用户必须能用）', () => {
    expect(deriveVisibleModels(catalog, []).map(m => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('正常勾选按勾选集过滤，且保持目录原顺序', () => {
    expect(deriveVisibleModels(catalog, ['c', 'a']).map(m => m.id)).toEqual(['a', 'c'])
  })

  it('勾选集与目录完全不相交时退化成全部（不是空）', () => {
    // 用户勾过的模型可能已从上游下架；返回空列表会让选择器空白，用户无处可点。
    expect(deriveVisibleModels(catalog, ['gone-1', 'gone-2']).map(m => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('目录本身为空时就是空（没什么可退化的）', () => {
    expect(deriveVisibleModels([], [])).toEqual([])
    expect(deriveVisibleModels([], ['a'])).toEqual([])
  })
})

describe('WbCatalog 的可用性与开关闸门', () => {
  it('新目录用 fallback，来源标记为 fallback', () => {
    const catalog = new WbCatalog('cn')
    expect(catalog.source).toBe('fallback')
    expect(catalog.visible()).toBe(FALLBACK_MODELS_CN)
    expect(catalog.all()).toBe(FALLBACK_MODELS_CN)
  })

  it('应用实时名册后来源变 live，且替换掉 fallback', () => {
    const catalog = new WbCatalog('cn')
    const changed = catalog.applyFetch([model('live-1'), model('live-2')], 1_700_000_000_000)
    expect(changed).toBe(true)
    expect(catalog.source).toBe('live')
    expect(catalog.visible().map(m => m.id)).toEqual(['live-1', 'live-2'])
    expect(catalog.lastUpdatedAt).toBe(1_700_000_000_000)
  })

  it('同样的名册再应用一次返回 false（不触发无意义的重建）', () => {
    const catalog = new WbCatalog('cn')
    catalog.applyFetch([model('x')], 1)
    expect(catalog.applyFetch([model('x')], 2)).toBe(false)
  })

  it('空名册被拒绝 —— 一次坏的响应不能把目录清空', () => {
    const catalog = new WbCatalog('cn')
    catalog.applyFetch([model('x')], 1)
    expect(catalog.applyFetch([], 2)).toBe(false)
    // 目录仍然是上一次的好数据。
    expect(catalog.visible().map(m => m.id)).toEqual(['x'])
  })

  it('usable=false 时 visible() 为空（本区域没有登录）', () => {
    const catalog = new WbCatalog('cn')
    expect(catalog.setUsable(false)).toBe(true)
    expect(catalog.visible()).toEqual([])
    // 但 all() 仍可读：设置页要能画勾选框，即使暂不可用。
    expect(catalog.all().length).toBeGreaterThan(0)
  })

  it('enabled=false 时 visible() 为空（用户关掉了这个区域）', () => {
    const catalog = new WbCatalog('cn')
    expect(catalog.setEnabled(false)).toBe(true)
    expect(catalog.visible()).toEqual([])
    expect(catalog.all().length).toBeGreaterThan(0)
  })

  it('抓取失败只记错误，不清空已有目录', () => {
    const catalog = new WbCatalog('cn')
    catalog.applyFetch([model('keep')], 1)
    catalog.noteFetchFailure('上游 502')
    expect(catalog.lastFetchError).toBe('上游 502')
    expect(catalog.visible().map(m => m.id)).toEqual(['keep'])
  })

  it('setEnabledIds 真的影响 visible，但 all() 永远不受影响', () => {
    const catalog = new WbCatalog('cn')
    catalog.applyFetch([model('a'), model('b'), model('c')], 1)
    catalog.setEnabledIds(['b'])
    expect(catalog.visible().map(m => m.id)).toEqual(['b'])
    expect(catalog.all().map(m => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('find() 在 all() 里找，不受勾选过滤影响', () => {
    const catalog = new WbCatalog('cn')
    catalog.applyFetch([model('a'), model('b')], 1)
    catalog.setEnabledIds(['a'])
    expect(catalog.find('b')?.id).toBe('b')
    expect(catalog.find('nope')).toBeUndefined()
  })
})

describe('倍率标签', () => {
  it('undefined 显示「倍率未知」，不是「免费」', () => {
    const catalog = new WbCatalog('cn')
    expect(catalog.multiplierLabelOf(model('m'))).toBe('倍率未知')
  })

  it('0 显示「免费」', () => {
    const catalog = new WbCatalog('cn')
    expect(catalog.multiplierLabelOf({ ...model('m'), creditMultiplier: 0 })).toBe('免费')
  })

  it('正数显示成 `${m}×`', () => {
    const catalog = new WbCatalog('cn')
    expect(catalog.multiplierLabelOf({ ...model('m'), creditMultiplier: 1.25 })).toBe('1.25×')
    expect(catalog.multiplierLabelOf({ ...model('m'), creditMultiplier: 1 })).toBe('1×')
  })
})

describe('WbCatalogs 管两个区域', () => {
  it('of() 按区域给不同实例', () => {
    const catalogs = new WbCatalogs()
    expect(catalogs.of('cn')).not.toBe(catalogs.of('global'))
    expect(catalogs.of('cn')).toBe(catalogs.of('cn'))
  })

  it('applySelection 只作用于指定区域', () => {
    const catalogs = new WbCatalogs()
    catalogs.of('cn').applyFetch([model('cn-a'), model('cn-b')], 1)
    catalogs.of('global').applyFetch([model('g-a'), model('g-b')], 1)
    catalogs.applySelection('cn', ['cn-b'])
    expect(catalogs.of('cn').visible().map(m => m.id)).toEqual(['cn-b'])
    expect(catalogs.of('global').visible().map(m => m.id)).toEqual(['g-a', 'g-b'])
  })

  it('applySelection(undefined) 等于清空勾选 = 全部显示', () => {
    const catalogs = new WbCatalogs()
    catalogs.of('cn').applyFetch([model('a')], 1)
    catalogs.applySelection('cn', undefined)
    expect(catalogs.of('cn').visible().map(m => m.id)).toEqual(['a'])
  })
})

describe('toModelInfo 把上游形状转成目录形状', () => {
  it('保留倍率（undefined 就是 undefined）', () => {
    const upstream: WbUpstreamModel = {
      id: 'm',
      name: 'M',
      maxInputTokens: 100,
      maxOutputTokens: 10,
    }
    expect(toModelInfo(upstream).creditMultiplier).toBeUndefined()
  })

  it('带倍率时原样带过来，包括 0', () => {
    const free: WbUpstreamModel = {
      id: 'f',
      name: 'F',
      maxInputTokens: 100,
      maxOutputTokens: 10,
      creditMultiplier: 0,
    }
    expect(toModelInfo(free).creditMultiplier).toBe(0)
  })
})
