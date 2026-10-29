/**
 * 模型拥挤度（`POST /v2/chat/busy`）的取数与呈现。
 *
 * 分三层，缺一层都测不到真东西：
 *
 * 1. **纯函数**（`normalizeBusyLevel` / `parseBusyLevels` / `batchModelIds` /
 *    `attachBusyLevels` / `busyDisplaySuffix`）—— 六态与分批规则。上游会给出六态之外
 *    的值，把「问过但不认识」压成「没问过」会让界面上两种完全不同的情况长一样。
 * 2. **取数**（`fetchModelBusy`）—— 必须**分批**（CN 名册 20-62 个，`PAt=50`），且
 *    只有一次调用，不能按模型逐个轮询：62 个模型就是 62 个请求，而这是装饰性信息。
 * 3. **短路与降级**（`fetchModels` → `withBusyLevels`）—— 国际网关实测 404，
 *    按区短路**不发请求**；CN 上任何失败都必须静默降级成「名册原样、不带拥挤度」，
 *    绝不能因为问了拥挤度而让用户拿不到模型列表。
 *
 * 替身只替 `globalThis.fetch`（网络边界），并且断言 **请求体形状**（`{ models: batch }`）
 * 与 **URL**：这两者是上游协议的契约面，只断言返回值的测试对「把 id 拼进 query string」
 * 这类改动是盲的。
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  MODEL_BUSY_PATH,
  WORKBUDDY_BUSY_BATCH_SIZE,
  attachBusyLevels,
  batchModelIds,
  busyDisplaySuffix,
  busySymbol,
  normalizeBusyLevel,
  parseBusyLevels,
} from '../src/upstream.ts'
import type { WbBusyLevel, WbCredential, WbUpstreamModel } from '../src/upstream.ts'
import { WbUpstreamClient } from '../src/upstream.ts'

const DAY = 86_400_000

function credential(domain = ''): WbCredential {
  return {
    accessToken: 'tok-cn',
    refreshToken: 'ref-cn',
    expiresAtMs: Date.now() + 30 * DAY,
    domain,
    sourcePath: '/fake/credential.info',
  }
}

/** 一份最小可用的上游名册条目（`parseUpstreamModel` 的产物形状）。 */
function model(id: string, overrides: Partial<WbUpstreamModel> = {}): WbUpstreamModel {
  return { id, name: id, contextWindow: 128_000, maxTokens: 8_192, ...overrides }
}

// ── 纯函数 ───────────────────────────────────────────────────────────────

describe('normalizeBusyLevel 六态归一', () => {
  it('六个合法值原样返回', () => {
    for (const level of ['idle', 'normal', 'busy', 'congested', 'unavailable', 'unknown'] as const) {
      expect(normalizeBusyLevel(level), level).toBe(level)
    }
  })

  it('越界值、非字符串、缺失一律归 unknown（不是 normal）', () => {
    // 归成 normal 会让「上游说了个新词」显示成「一切正常」，用户永远看不到变化。
    for (const value of ['overloaded', '', null, undefined, 3, {}, ['idle']]) {
      expect(normalizeBusyLevel(value), JSON.stringify(value ?? null)).toBe('unknown')
    }
  })
})

describe('parseBusyLevels 读上游应答', () => {
  it('按 model 字段建索引，busy_level 归一', () => {
    const levels = parseBusyLevels([
      { model: 'm1', busy_level: 'congested' },
      { model: 'm2', busy_level: 'idle' },
      { model: 'm3', busy_level: 'something-new' },
    ])
    expect(levels.get('m1')).toBe('congested')
    expect(levels.get('m2')).toBe('idle')
    // 问过但答了个新值是 unknown —— 与「没问过」(undefined) 必须能分开。
    expect(levels.get('m3')).toBe('unknown')
    expect(levels.has('m3')).toBe(true)
  })

  it('非数组 / 非对象条目 / 缺 model 的条目都跳过', () => {
    expect(parseBusyLevels(undefined).size).toBe(0)
    expect(parseBusyLevels({}).size).toBe(0)
    expect(parseBusyLevels('idle').size).toBe(0)
    const levels = parseBusyLevels([
      'idle',
      null,
      42,
      { busy_level: 'busy' },
      { model: '', busy_level: 'busy' },
      { model: 7, busy_level: 'busy' },
      { model: 'm1', busy_level: 'busy' },
    ])
    expect([...levels.keys()]).toEqual(['m1'])
    expect(levels.get('m1')).toBe('busy')
  })

  it('同一模型出现两次时后者覆盖前者（上游分批重叠时不至于报旧值）', () => {
    const levels = parseBusyLevels([
      { model: 'm1', busy_level: 'congested' },
      { model: 'm1', busy_level: 'idle' },
    ])
    expect(levels.get('m1')).toBe('idle')
  })
})

describe('batchModelIds 保序去重后按 50 切', () => {
  it('每批不超过上限，且批间顺序就是入参顺序', () => {
    const ids = Array.from({ length: WORKBUDDY_BUSY_BATCH_SIZE * 2 + 1 }, (_, index) => `m${index}`)
    const batches = batchModelIds(ids)
    expect(batches).toHaveLength(3)
    expect(batches[0]).toHaveLength(WORKBUDDY_BUSY_BATCH_SIZE)
    expect(batches[1]).toHaveLength(WORKBUDDY_BUSY_BATCH_SIZE)
    expect(batches[2]).toEqual([`m${WORKBUDDY_BUSY_BATCH_SIZE * 2}`])
    expect(batches.flat()).toEqual(ids)
  })

  it('去重保序、丢掉空 id', () => {
    expect(batchModelIds(['b', 'a', 'b', '', 'a', 'c'])).toEqual([['b', 'a', 'c']])
  })

  it('空名册得到空数组（不发请求，上游对空 models 数组回 400）', () => {
    expect(batchModelIds([])).toEqual([])
    expect(batchModelIds(['', ''])).toEqual([])
  })

  it('size 非正数时回落默认上限', () => {
    const ids = Array.from({ length: WORKBUDDY_BUSY_BATCH_SIZE + 1 }, (_, index) => `m${index}`)
    expect(batchModelIds(ids, 0)).toHaveLength(2)
    expect(batchModelIds(ids, -5)[0]).toHaveLength(WORKBUDDY_BUSY_BATCH_SIZE)
  })
})

describe('attachBusyLevels 复制不改写', () => {
  it('挂上等级但不改原数组与原对象', () => {
    const source = [model('m1'), model('m2')]
    const levels = new Map<string, WbBusyLevel>([['m1', 'congested']])
    const attached = attachBusyLevels(source, levels)
    expect(attached[0]?.busyLevel).toBe('congested')
    expect(attached[1]?.busyLevel).toBeUndefined()
    // 就地把 name 改长、或直接改 source[0]，会让「刷新一次」与「刷新两次」得到不同名字。
    expect(source[0]?.busyLevel).toBeUndefined()
    expect(attached[1]).toBe(source[1])
  })

  it('等级没变时返回同一个对象引用（避免每次刷新都重建名册）', () => {
    const first = model('m1', { busyLevel: 'busy' })
    const attached = attachBusyLevels([first], new Map([['m1', 'busy']]))
    expect(attached[0]).toBe(first)
  })
})

describe('busyDisplaySuffix 只画需要决策的等级', () => {
  it('busy / congested / unavailable / idle 有符号', () => {
    expect(busySymbol('congested')).toBe('🧍🧍🧍')
    expect(busySymbol('busy')).toBe('🧍🧍')
    expect(busySymbol('idle')).toBe('🚀')
    expect(busySymbol('unavailable')).toBe('🚫')
    expect(busyDisplaySuffix('busy')).toBe(' 🧍🧍')
  })

  it('normal / unknown / undefined 一个字符都不加', () => {
    // normal 每行都画会把标记退化成装饰；unknown 是「本插件没问到」，画出来等于
    // 替上游声称了一个它没说过的事实。
    expect(busySymbol('normal')).toBe('')
    expect(busySymbol('unknown')).toBe('')
    expect(busySymbol(undefined)).toBe('')
    expect(busyDisplaySuffix('normal')).toBe('')
    expect(busyDisplaySuffix('unknown')).toBe('')
    expect(busyDisplaySuffix(undefined)).toBe('')
  })
})

// ── 取数（替身 fetch） ───────────────────────────────────────────────────

interface Recorded {
  url: string
  method: string
  body: unknown
}

/**
 * 替身 fetch：按批次应答，记录每次请求的 url / method / body。
 *
 * 必须记录请求体：`{ models: batch }` 是上游协议的契约面。只断言返回值的测试对
 * 「把 id 拼进 query string」或「一次只问一个」这类改动是盲的。
 */
function stubFetch(handler: (batch: readonly string[], url: string) => Response): { calls: Recorded[]; restore: () => void } {
  const original = globalThis.fetch
  const calls: Recorded[] = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const raw = typeof init?.body === 'string' ? init.body : '{}'
    const body = JSON.parse(raw) as { models?: readonly string[] }
    calls.push({ url, method: String(init?.method ?? 'GET'), body })
    return handler(body.models ?? [], url)
  }) as never
  return { calls, restore: () => { globalThis.fetch = original } }
}

function envelope(data: unknown, code = 0): Response {
  return new Response(JSON.stringify({ code, msg: code === 0 ? 'ok' : 'boom', data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

let restoreFetch: (() => void) | undefined

afterEach(() => {
  restoreFetch?.()
  restoreFetch = undefined
})

describe('fetchModelBusy 分批取拥挤度', () => {
  it('超过 50 个模型时分批，每批一次请求，body 是 { models: batch }', async () => {
    const ids = Array.from({ length: WORKBUDDY_BUSY_BATCH_SIZE + 3 }, (_, index) => `m${index}`)
    const stub = stubFetch(batch => envelope(batch.map(id => ({ model: id, busy_level: 'busy' }))))
    restoreFetch = stub.restore
    const client = new WbUpstreamClient()
    const levels = await client.fetchModelBusy(credential(), ids)
    expect(stub.calls).toHaveLength(2)
    expect(stub.calls[0]?.method).toBe('POST')
    expect(stub.calls[0]?.url).toContain(MODEL_BUSY_PATH)
    expect((stub.calls[0]?.body as { models: string[] }).models).toHaveLength(WORKBUDDY_BUSY_BATCH_SIZE)
    expect((stub.calls[1]?.body as { models: string[] }).models).toHaveLength(3)
    expect(levels.size).toBe(WORKBUDDY_BUSY_BATCH_SIZE + 3)
    expect(levels.get('m0')).toBe('busy')
  })

  it('空名册一次请求都不发（上游对空 models 数组回 400）', async () => {
    const stub = stubFetch(() => envelope([]))
    restoreFetch = stub.restore
    const levels = await new WbUpstreamClient().fetchModelBusy(credential(), [])
    expect(stub.calls).toHaveLength(0)
    expect(levels.size).toBe(0)
  })

  it('非 code:0 抛错（让上层统一降级，不在取数层吞掉）', async () => {
    const stub = stubFetch(() => envelope(undefined, 500))
    restoreFetch = stub.restore
    await expect(new WbUpstreamClient().fetchModelBusy(credential(), ['m1'])).rejects.toThrow(/workbuddy/u)
  })
})

// ── 短路与降级（走真 fetchModels） ───────────────────────────────────────

/** `/v3/config` 的最小应答（`{ data: { models, agents } }`，`agents` 里 `cli` 定白名单）。 */
function catalogResponse(ids: readonly string[]): Response {
  return new Response(JSON.stringify({
    code: 0,
    msg: 'ok',
    data: {
      models: ids.map(id => ({ id, name: id, maxInputTokens: 128_000, maxOutputTokens: 8_192 })),
      agents: [{ name: 'cli', models: [...ids] }],
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('withBusyLevels：国际区短路 + 失败静默降级（真 fetchModels）', () => {
  it('国际区不发 busy 请求，名册照常返回（实测该端点在国际网关 404）', async () => {
    const ids = ['g1', 'g2']
    const stub = stubFetch((_batch, url) => {
      if (url.includes(MODEL_BUSY_PATH)) throw new Error('国际网关不该被问到拥挤度')
      return catalogResponse(ids)
    })
    restoreFetch = stub.restore
    const models = await new WbUpstreamClient().fetchModels(credential('www.workbuddy.ai'))
    expect(stub.calls.map(call => call.url)).toHaveLength(1)
    expect(stub.calls[0]?.url).not.toContain(MODEL_BUSY_PATH)
    expect(models.map(item => item.id)).toEqual(ids)
    // 一个后缀都不该被加上：国际区的名字必须与没有这个功能时逐字节相同。
    expect(models.map(item => item.name)).toEqual(ids)
  })

  it('CN 区取到拥挤度并写进 name 后缀', async () => {
    const ids = ['m1', 'm2']
    const stub = stubFetch((_batch, url) => {
      if (url.includes(MODEL_BUSY_PATH)) {
        return envelope([{ model: 'm1', busy_level: 'congested' }, { model: 'm2', busy_level: 'normal' }])
      }
      return catalogResponse(ids)
    })
    restoreFetch = stub.restore
    const models = await new WbUpstreamClient().fetchModels(credential())
    expect(models[0]?.name).toBe('m1 🧍🧍🧍')
    expect(models[0]?.busyLevel).toBe('congested')
    // normal 不画，名字保持原样 —— 否则每行都有标记，标记就不再有信息量。
    expect(models[1]?.name).toBe('m2')
    expect(models[1]?.busyLevel).toBe('normal')
  })

  it('CN 区 busy 失败时静默降级：名册原样、不挂等级、不抛错', async () => {
    const ids = ['m1', 'm2']
    const warnings: string[] = []
    const stub = stubFetch((_batch, url) => {
      if (url.includes(MODEL_BUSY_PATH)) throw new Error('busy exploded')
      return catalogResponse(ids)
    })
    restoreFetch = stub.restore
    const models = await new WbUpstreamClient(message => { warnings.push(message) }).fetchModels(credential())
    expect(models.map(item => item.id)).toEqual(ids)
    expect(models.map(item => item.name)).toEqual(ids)
    expect(models.every(item => item.busyLevel === undefined)).toBe(true)
    // 用户没主动要拥挤度；失败只在日志里留一条，不占用界面的错误位。
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('拥挤度')
  })

  it('每个模型只被问一次：请求数 = 批次数，不随模型数增长', async () => {
    const ids = Array.from({ length: 12 }, (_, index) => `m${index}`)
    const stub = stubFetch((batch, url) => {
      if (url.includes(MODEL_BUSY_PATH)) return envelope(batch.map(id => ({ model: id, busy_level: 'idle' })))
      return catalogResponse(ids)
    })
    restoreFetch = stub.restore
    await new WbUpstreamClient().fetchModels(credential())
    const busyCalls = stub.calls.filter(call => call.url.includes(MODEL_BUSY_PATH))
    // 12 个模型 < 50，所以恰好 1 次。逐模型轮询会是 12 次。
    expect(busyCalls).toHaveLength(1)
  })
})
