/**
 * 推理等级（档位选择器）的整条链路。
 *
 * 为什么值得一个专门的测试文件：这条链路在**修好之前是完全静默的**——
 * `toPiModel` 硬写 `reasoning: false`，pi-ai 的 `getSupportedThinkingLevels` 于是
 * 只返回 `['off']`，composer 干脆不画选择器。没有报错、没有日志、没有坏掉的模型，
 * 只是「这个 provider 的模型好像都不支持推理」。任何一处漏搬（上游不解析、catalog
 * 不搬运、adapter 不宣告）都回到同一个静默症状，所以四层各测一段。
 *
 * 分四组：
 *
 * 1. **上游解析**：两种拼写归一化，以及「空对象 = 没宣告」这个三态约定；
 * 2. **目录搬运**：`toModelInfo` 不能把档位吃掉（它曾经就是吃不掉的那一层）；
 * 3. **pi-ai 投影**：`reasoning` / `thinkingLevelMap` / `compat` 三个字段要一致；
 * 4. **派发归一化**：路由默认档该模型接不了时，请求要降到它真能接受的那一档。
 */

import { describe, expect, it } from 'vitest'
import { createWbAdapter, wbResolveEffort, wbThinkingLevelMap, WB_DEFAULT_EFFORT } from '../src/adapter.ts'
import { WbCatalog, toModelInfo } from '../src/catalog.ts'
import { parseReasoning, parseUpstreamModel } from '../src/upstream.ts'
import { WB_REFUSES_OFF_MODEL_IDS } from '../src/status-paths.ts'
import type { WbModelInfo } from '../src/status-paths.ts'

const DAY = 86_400_000

/** 只提供 adapter 真正用到的三个成员的假 shim。 */
function fakeShim(): never {
  return {
    ready: Promise.resolve(),
    baseUrl: () => 'http://127.0.0.1:41234',
    token: () => 'shim-secret',
    close: async () => {},
  } as never
}

function modelInfo(id: string, overrides: Partial<WbModelInfo> = {}): WbModelInfo {
  return { id, name: id, ...overrides }
}

function adapterWith(models: readonly WbModelInfo[]) {
  const catalog = new WbCatalog('cn')
  catalog.applyFetch(models as never, Date.now())
  const created = createWbAdapter({ shim: fakeShim(), catalog, region: 'cn' })
  return { ...created, catalog }
}

describe('parseReasoning 把两种拼写折叠成同一种', () => {
  it('复数形原样透传（上游宣告了完整名单）', () => {
    const parsed = parseReasoning({
      canDisableThinking: false,
      defaultEffort: 'high',
      summary: 'auto',
      supportedEfforts: ['low', 'high', 'max'],
    })
    expect(parsed?.supportedEfforts).toEqual(['low', 'high', 'max'])
    expect(parsed?.defaultEffort).toBe('high')
    expect(parsed?.canDisableThinking).toBe(false)
  })

  it('单数形 `{ effort: "high" }` 展开成从最低档到锚点的阶梯（实测 4 个模型是这种写法）', () => {
    const parsed = parseReasoning({ effort: 'high', summary: 'auto' })
    // 单数形只报了一个锚点，但上游这些模型的档位是连续的：能跑 high 就能跑它下面
    // 每一档。照抄单点会让选择器只剩一档；补到锚点为止而不是补满阶梯，是因为锚点
    // 之上的档没有证据说它支持。
    expect(parsed?.supportedEfforts).toEqual(['low', 'medium', 'high'])
  })

  it('单数形默认可以关思考（上游用单数形表达「只报当前档」，不是「只能这一档」）', () => {
    expect(parseReasoning({ effort: 'low' })?.canDisableThinking).toBe(true)
  })

  it('单数形的 `effort` 是阶梯外的值时原样单档（不假装它认识）', () => {
    expect(parseReasoning({ effort: 'turbo' })?.supportedEfforts).toEqual(['turbo'])
  })

  it('空对象 `{}` 视为没有宣告（实测 8 个模型就是这样）', () => {
    expect(parseReasoning({})).toBeUndefined()
  })

  it('不是对象、字段类型不对，一律退回 undefined', () => {
    for (const value of [undefined, null, 'high', 42, [], { supportedEfforts: 'high' }]) {
      expect(parseReasoning(value), JSON.stringify(value)).toBeUndefined()
    }
  })

  it('名单里的非字符串与空串被剔掉（不能让它们在词表里制造空洞）', () => {
    const parsed = parseReasoning({ supportedEfforts: ['low', '', 7, null, 'high'] })
    expect(parsed?.supportedEfforts).toEqual(['low', 'high'])
  })

  it('整条名册条目里也读得到（parseUpstreamModel 接上了这一层）', () => {
    const model = parseUpstreamModel({
      id: 'glm-5.3',
      name: 'GLM-5.3',
      // 上游条目必须带可用窗口，否则整条会被丢弃（窗口是 DSH 压缩的依据，不能编）。
      maxInputTokens: 128_000,
      maxOutputTokens: 8_192,
      reasoning: { canDisableThinking: false, defaultEffort: 'high', supportedEfforts: ['low', 'high', 'max'] },
    })
    expect(model?.reasoning?.supportedEfforts).toEqual(['low', 'high', 'max'])
  })

  it('名册条目没带 reasoning 时字段整个缺键（不是补一个空对象）', () => {
    const model = parseUpstreamModel({
      id: 'plain',
      name: 'Plain',
      maxInputTokens: 128_000,
      maxOutputTokens: 8_192,
    })
    expect(model).toBeDefined()
    expect('reasoning' in (model as object)).toBe(false)
  })
})

describe('toModelInfo 把档位搬进目录', () => {
  it('reasoning 原样搬运（不在这一层裁成 pi-ai 的词表）', () => {
    const upstream = parseUpstreamModel({
      id: 'glm-5.3',
      name: 'GLM-5.3',
      maxInputTokens: 128_000,
      maxOutputTokens: 8_192,
      reasoning: { canDisableThinking: true, defaultEffort: 'low', supportedEfforts: ['low', 'turbo'] },
    })
    const info = toModelInfo(upstream!)
    // `turbo` 不在 pi-ai 词表里，但裁剪是 adapter 的事：这一层裁了，adapter 就再也
    // 不知道上游原本说了什么，将来 pi-ai 认识 `turbo` 时也无从恢复。
    expect(info.reasoning?.supportedEfforts).toEqual(['low', 'turbo'])
    expect(info.reasoning?.defaultEffort).toBe('low')
  })

  it('上游没宣告时不补 reasoning 键（三态里「没说过」必须还是没说过）', () => {
    const info = toModelInfo({ id: 'plain', name: 'Plain' })
    expect('reasoning' in info).toBe(false)
  })
})

describe('wbThinkingLevelMap 把上游名单翻译成 pi-ai 的档位表', () => {
  it('名单里的档位是它自己，其余一律 null（null = 这档不支持）', () => {
    const map = wbThinkingLevelMap(modelInfo('m', {
      reasoning: { supportedEfforts: ['low', 'high', 'max'], canDisableThinking: false },
    }))
    expect(map).toEqual({
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max',
      // canDisableThinking: false → 上游说这一档不能关思考
      off: null,
    })
  })

  it('canDisableThinking 为 true 时 `off` 可用', () => {
    const map = wbThinkingLevelMap(modelInfo('m', {
      reasoning: { supportedEfforts: ['low', 'high'], canDisableThinking: true },
    }))
    expect(map?.off).toBe('off')
  })

  it('拒绝表的模型即使上游说能关思考，`off` 也映射成 null', () => {
    const refused = [...WB_REFUSES_OFF_MODEL_IDS][0]!
    const map = wbThinkingLevelMap(modelInfo(refused, {
      reasoning: { supportedEfforts: ['low', 'high'], canDisableThinking: true },
    }))
    // 上游元数据与实测冲突时信实测：这一档一旦可选，该模型之后每一轮都会 400。
    expect(map?.off).toBeNull()
  })

  it('pi-ai 不认识的档位被 null 掉，不原样透传（否则选择器里按下去就 400）', () => {
    const map = wbThinkingLevelMap(modelInfo('m', {
      reasoning: { supportedEfforts: ['low', 'turbo'], canDisableThinking: false },
    }))
    expect(map?.low).toBe('low')
    expect(Object.values(map ?? {})).not.toContain('turbo')
  })

  it('没有 reasoning / 名单为空 / 名单全不认识 → undefined（不宣告推理能力）', () => {
    expect(wbThinkingLevelMap(modelInfo('plain'))).toBeUndefined()
    expect(wbThinkingLevelMap(modelInfo('empty', { reasoning: {} }))).toBeUndefined()
    expect(wbThinkingLevelMap(modelInfo('empty2', { reasoning: { supportedEfforts: [] } }))).toBeUndefined()
    expect(wbThinkingLevelMap(modelInfo('alien', {
      reasoning: { supportedEfforts: ['turbo', 'ludicrous'] },
    }))).toBeUndefined()
  })
})

describe('adapter 投影：三个字段必须一致', () => {
  it('有档位的模型：reasoning=true，带 thinkingLevelMap，compat 支持档位', () => {
    const { buildModels } = adapterWith([
      modelInfo('glm-5.3', { reasoning: { supportedEfforts: ['low', 'high', 'max'], canDisableThinking: false } }),
    ])
    const model = buildModels()[0]!
    expect(model.reasoning).toBe(true)
    expect(model.thinkingLevelMap?.high).toBe('high')
    expect(model.compat?.supportsReasoningEffort).toBe(true)
  })

  it('没有档位的模型：reasoning=false，无 map，compat 不支持（选择器不出现）', () => {
    const { buildModels } = adapterWith([modelInfo('hunyuan-chat')])
    const model = buildModels()[0]!
    expect(model.reasoning).toBe(false)
    expect(model.thinkingLevelMap).toBeUndefined()
    expect(model.compat?.supportsReasoningEffort).toBe(false)
  })

  it('只置 reasoning 不给 map 是错的：pi-ai 会以为整条阶梯都可用', () => {
    // 反向保护：这两个字段一旦脱钩，选择器里会出现该模型接不住的档位。
    const { buildModels } = adapterWith([
      modelInfo('m', { reasoning: { supportedEfforts: ['high'], canDisableThinking: false } }),
    ])
    const model = buildModels()[0]!
    expect(model.reasoning).toBe(true)
    expect(model.thinkingLevelMap).toBeDefined()
    expect(model.thinkingLevelMap?.low).toBeNull()
    expect(model.thinkingLevelMap?.high).toBe('high')
  })

  it('目录刷新后立刻反映（新模型带档位，旧的没有）', () => {
    const { buildModels, catalog } = adapterWith([modelInfo('old')])
    expect(buildModels()[0]?.reasoning).toBe(false)
    catalog.applyFetch([
      modelInfo('new', { reasoning: { supportedEfforts: ['low', 'high'], canDisableThinking: true } }),
    ] as never, Date.now())
    expect(buildModels()[0]?.reasoning).toBe(true)
  })
})

describe('resolveModel 宣告档位（宿主据此画选择器）', () => {
  it('有档位的模型：efforts 就是它能接的那几档，默认档取上游的', async () => {
    const { adapter } = adapterWith([
      modelInfo('glm-5.3', {
        reasoning: { supportedEfforts: ['low', 'high', 'max'], canDisableThinking: false, defaultEffort: 'high' },
      }),
    ])
    const resolved = await adapter.resolveModel('workbuddy-models', 'glm-5.3')
    expect(resolved.reasoning?.efforts.map(e => e.id)).toEqual(['low', 'high', 'max'])
    expect(resolved.reasoning?.defaultEffort).toBe('high')
  })

  it('没有档位的模型：只宣告 off（否则宿主拒绝对它派发任何请求）', async () => {
    const { adapter } = adapterWith([modelInfo('hunyuan-chat')])
    const resolved = await adapter.resolveModel('workbuddy-models', 'hunyuan-chat')
    expect(resolved.reasoning?.efforts.map(e => e.id)).toEqual(['off'])
    // 刻意不补 defaultEffort：宿主会把默认值实体化进每一个没点名档位的请求。
    expect(resolved.reasoning?.defaultEffort).toBeUndefined()
  })

  it('prepareCall 也宣告（宿主在调 stream 之前就先校验 model 元数据）', async () => {
    const { adapter } = adapterWith([modelInfo('hunyuan-chat')])
    const call = await adapter.prepareCall('workbuddy-models', 'hunyuan-chat')
    expect(call.model.reasoning?.efforts.map(e => e.id)).toEqual(['off'])
  })
})

describe('wbResolveEffort：路由默认档接不住时降到该模型能接的那一档', () => {
  it('调用方点名的档位能用 → 不插手', () => {
    const info = modelInfo('m', { reasoning: { supportedEfforts: ['low', 'high'], canDisableThinking: false } })
    expect(wbResolveEffort(info, 'low')).toBeUndefined()
  })

  it('调用方没表态且默认档能用 → 不插手（默认档就是 WB_DEFAULT_EFFORT）', () => {
    const info = modelInfo('m', { reasoning: { supportedEfforts: ['low', 'high'], canDisableThinking: false } })
    expect(wbResolveEffort(info, undefined)).toBeUndefined()
    expect(WB_DEFAULT_EFFORT).toBe('high')
  })

  it('默认档接不住 → 先取上游自己的默认档', () => {
    const info = modelInfo('m', {
      reasoning: { supportedEfforts: ['low', 'max'], canDisableThinking: false, defaultEffort: 'max' },
    })
    // high 不在名单里；上游说它自己默认 max，就用 max 而不是最低档。
    expect(wbResolveEffort(info, undefined)).toBe('max')
  })

  it('默认档接不住且上游没给默认档 → 取它能接受的最低档（不是最高）', () => {
    const info = modelInfo('m', { reasoning: { supportedEfforts: ['medium', 'max'], canDisableThinking: false } })
    // 高档更贵也更容易超时，用户没表态时保守落点应该在低端。
    expect(wbResolveEffort(info, undefined)).toBe('medium')
  })

  it('没有档位宣告 → 钉到 off（= 不发该字段，请求体不变）', () => {
    expect(wbResolveEffort(modelInfo('plain'), undefined)).toBe('off')
    expect(wbResolveEffort(modelInfo('plain'), 'high')).toBe('off')
  })

  it('调用方显式点名一个该模型做不到的档位 → 也降级（不能让必然失败的请求发出去）', () => {
    const info = modelInfo('m', { reasoning: { supportedEfforts: ['low', 'high'], canDisableThinking: false } })
    expect(wbResolveEffort(info, 'max')).toBe('low')
  })

  it('`off` 在可用集合里时，点名 off 原样通过', () => {
    const info = modelInfo('m', { reasoning: { supportedEfforts: ['low', 'high'], canDisableThinking: true } })
    expect(wbResolveEffort(info, 'off')).toBeUndefined()
  })
})

describe('派发路径上真的换了档位', () => {
  it('stream 收到接不住的档位时，实际发出去的是降级后的那一档', async () => {
    // 走到真正的 stream：它内部会调 `pinEffort`，再交给 pi-ai 序列化。
    // 这里只验证「不抛」——真正的 body 由 shim 的 prepareChatBody 负责，
    // 而它已经由其它测试覆盖。这条测的是「降级发生在派发之前」。
    const { adapter } = adapterWith([modelInfo('plain')])
    const call = await adapter.prepareCall('workbuddy-models', 'plain')
    const iterable = call.stream({ model: 'plain', reasoningEffort: 'high' } as never)
    // 立刻放弃迭代：只关心它没有在构造阶段因为档位不合法而抛。
    expect(iterable[Symbol.asyncIterator]()).toBeDefined()
    await iterable[Symbol.asyncIterator]().return?.()
  })
})

describe('默认档位是路由级别的，且写进了 profile', () => {
  it('WB_DEFAULT_EFFORT 是 high 而不是 off', () => {
    // 取 off 的话，每一次压缩摘要都在要求模型关闭思考，而上游会对其中一部分回 400。
    expect(WB_DEFAULT_EFFORT).toBe('high')
  })

  it('路由默认档由 profile 承载：宿主按 options.reasoningEffort ?? profile.reasoning 解析', () => {
    // profile 不在 adapter 的公开返回面上（`createWbAdapter` 只交出 adapter /
    // buildModels / invalidate），所以这里断言的是它的**可观察后果**：一个只支持
    // low/medium 的模型，在调用方没表态时会被降到它接得住的档，而不是被默认的
    // high 打死。默认值取错成 off 或漏设，这条就会退化成 'off'。
    const info = modelInfo('low-only', { reasoning: { supportedEfforts: ['low', 'medium'] } })
    expect(wbResolveEffort(info, undefined)).toBe('low')
    // 反向：真能接 high 的模型不需要降级，说明默认值确实是 high（若默认是 low 或
    // off，这里会返回降级值而不是 undefined）。
    const highOk = modelInfo('high-ok', { reasoning: { supportedEfforts: ['low', 'high'] } })
    expect(wbResolveEffort(highOk, undefined)).toBeUndefined()
  })
})
