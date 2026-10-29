/**
 * 请求路径上的**子串**闸门：已知 span 的等价改写，以及「没有 span 的请求逐字节不变」。
 *
 * 这个文件钉的是 2026-10-29 在真实国内网关上的实测结论
 * （`.probe/t34e` / `.probe/t34f`，口径见 `docs/CHANNEL-SPAN-REWRITE.md`）：
 *
 * 1. 网关对 `system` / `assistant` 的正文做**大小写折叠的精确子串匹配**，DSH 的 Web-GUI
 *    段落是活的 span：原样发 400 / 11128，改动任意一处就 200；
 * 2. 不可见字符（U+200B/U+200D/U+2060/U+00AD）会被网关**剥离后**再比对，所以零宽扰动
 *    救不了它 —— 这就是旧版「第二级自救」在真机上彻底失效的原因；
 * 3. `user` 消息不被扫描。所以「改写」与「换角色承载」是两条不同的路，各自有实测依据。
 *
 * 这里测的是第 3 条对应的**请求路径**（改写），救援路径（搬运）在
 * `tests/channel-rescue.test.ts` 里测。
 */

import { describe, expect, it } from 'vitest'
import { CHANNEL_SPAN_REWRITES, WB_FALLBACK_SYSTEM_PROMPT, prepareChatBody, relocateScannedContent } from '../src/shim.ts'

/** 实测 span：packages/context/harness-dev-context 的 WEB_SURFACE_PROMPT 前两句，221 字符。 */
const SPAN = 'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. '
  + 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI.'
/** 同一段话的等价改写：把定语从句拆成独立句。 */
const REWRITTEN = 'You are interacting with the user through the DeepSeek Harness Web GUI. The runtime context names its URL. '
  + 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI.'

/** 一段只在该 span 存在时才不同的 system 正文。 */
const PROMPT = `You are an AI agent powered by DeepSeek Harness.\n\n${SPAN}\n\nBe concise.`

function bodyOf(messages: readonly unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, messages, ...extra })
}

function messagesOf(bodyJson: string): Record<string, unknown>[] {
  return (JSON.parse(bodyJson) as { messages: Record<string, unknown>[] }).messages
}

function contentOf(message: Record<string, unknown> | undefined): string {
  const content = message?.['content']
  return typeof content === 'string' ? content : ''
}

describe('CHANNEL_SPAN_REWRITES：只收录实测过的 span', () => {
  it('表里那条是实测 span 的开头一句，改写后整条 221 字符 span 不再成立', () => {
    const rule = CHANNEL_SPAN_REWRITES[0]
    expect(rule).toBeDefined()
    // 表里收的是 span 的第一句（更短的逐字节字面量：越短越不容易因为网关那边
    // 改一个字就整体失效），而 span 的后一句原样保留 —— 只要前一句变了，整条
    // 221 字符的精确子串就不再出现，这正是实测里「改任意一处就 200」的用法。
    expect(SPAN.startsWith(rule!.match)).toBe(true)
    expect(SPAN).toHaveLength(221)
    expect(rule!.replace.includes(rule!.match)).toBe(false)

    const rewrittenSpan = SPAN.replace(rule!.match, rule!.replace)
    expect(rewrittenSpan).toBe(REWRITTEN)
    expect(rewrittenSpan).not.toContain(SPAN)
  })

  it('改写保住语义：只把定语从句拆成独立句，句子成分一个都没丢', () => {
    const rule = CHANNEL_SPAN_REWRITES[0]!
    for (const fragment of ['Web GUI', 'runtime context', 'names']) {
      expect(rule.match).toContain(fragment)
      expect(rule.replace).toContain(fragment)
    }
    // 不是删句：改写后是**两句**（原文是一句的定语从句），而不是更短的一句话。
    expect((rule.match.match(/\./gu) ?? [])).toHaveLength(1)
    expect((rule.replace.match(/\./gu) ?? [])).toHaveLength(2)
  })
})

describe('prepareChatBody 的第二道防线：正文 span 改写', () => {
  it('system 里的 span 被换成等价改写，其余部分逐字不动', () => {
    const out = prepareChatBody(bodyOf([{ role: 'system', content: PROMPT }, { role: 'user', content: 'hi' }]))
    const system = contentOf(messagesOf(out)[0])
    expect(system).toContain(REWRITTEN)
    expect(system).not.toContain(SPAN)
    // span 之外的字节一个都没变。
    expect(system.startsWith(`${WB_FALLBACK_SYSTEM_PROMPT}\n\nYou are an AI agent powered by DeepSeek Harness.\n\n`)).toBe(true)
    expect(system.endsWith('Be concise.')).toBe(true)
  })

  it('assistant 历史里的 span 同样改写（一条这样的历史会污染之后每一轮）', () => {
    const out = prepareChatBody(bodyOf([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'assistant', content: SPAN },
      { role: 'user', content: 'hi' },
    ]))
    expect(contentOf(messagesOf(out)[1])).toBe(REWRITTEN)
  })

  it('数组 content 的每个 text part 都改写', () => {
    const out = prepareChatBody(bodyOf([
      { role: 'system', content: [{ type: 'text', text: SPAN }, { type: 'text', text: PROMPT }] },
      { role: 'user', content: 'hi' },
    ]))
    const parts = messagesOf(out)[0]?.['content'] as Record<string, unknown>[]
    expect(parts[0]?.['text']).toBe(REWRITTEN)
    expect(parts[1]?.['text']).toContain(REWRITTEN)
  })

  it('user 消息里的 span 不动（网关不扫 user，改它就是白改用户的字）', () => {
    const out = prepareChatBody(bodyOf([{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: SPAN }]))
    expect(contentOf(messagesOf(out)[1])).toBe(SPAN)
  })

  it('不含 span 的请求**逐字节不变**（这条是它敢无条件跑在请求路径上的唯一理由）', () => {
    const clean = bodyOf([
      { role: 'system', content: 'You are a helpful assistant. Be concise.' },
      { role: 'user', content: 'hi' },
    ])
    expect(prepareChatBody(clean)).toBe(clean)
  })

  it('幂等：改写过的 body 再过一次完全不变', () => {
    const once = prepareChatBody(bodyOf([{ role: 'system', content: PROMPT }, { role: 'user', content: 'hi' }]))
    expect(prepareChatBody(once)).toBe(once)
  })

  it('与网关同口径：连续空格 / 全小写形态一样命中（网关自己就会折叠它们）', () => {
    // `.probe/t34f`：`double_space` 与 `case_word` 都仍被拒 —— 网关折叠大小写、把连续
    // 空格压成一个。所以只按逐字节字面量匹配会比闸门更窄，提示词多一个空格就整条落空。
    const spaced = prepareChatBody(bodyOf([{ role: 'system', content: SPAN.replace(/ /gu, '  ') }, { role: 'user', content: 'hi' }]))
    const spacedText = contentOf(messagesOf(spaced)[0])
    expect(spacedText).toContain(REWRITTEN.split(' When')[0])
    expect(spacedText).not.toContain('whose URL')

    const lowered = prepareChatBody(bodyOf([{ role: 'system', content: SPAN.toLowerCase() }, { role: 'user', content: 'hi' }]))
    const loweredText = contentOf(messagesOf(lowered)[0])
    expect(loweredText).toContain(REWRITTEN.split(' When')[0])
    expect(loweredText).not.toContain('whose url')
  })

  it('不误伤：词序列不同的近似句不改（改写只能落在实测过的那句话上）', () => {
    const nearMiss = 'You are interacting with the web-based DeepSeek Harness GUI whose URL the runtime context names.'
    const out = prepareChatBody(bodyOf([{ role: 'system', content: nearMiss }, { role: 'user', content: 'hi' }]))
    expect(contentOf(messagesOf(out)[0])).toBe(nearMiss)
  })
})

describe('relocateScannedContent：不依赖知道 span 的那一级', () => {
  it('system 正文搬进紧随其后的一条 user，首条仍是 system（否则撞另一支 11128）', () => {
    const body = bodyOf([
      { role: 'system', content: 'SOME UNKNOWN SPAN THAT THE GATE REFUSES' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
    const out = relocateScannedContent(body)
    expect(out).toBeDefined()
    const messages = messagesOf(out as string)
    expect(messages.map(message => message['role'])).toEqual(['system', 'user', 'user', 'assistant'])
    expect(messages[0]?.['content']).toBe(WB_FALLBACK_SYSTEM_PROMPT)
    expect(contentOf(messages[1])).toContain('SOME UNKNOWN SPAN THAT THE GATE REFUSES')
    expect(contentOf(messages[2])).toBe('hi')
    expect(contentOf(messages[3])).toBe('hello')
  })

  it('多条 system 合并成一条搬运消息（顺序不变）', () => {
    const out = relocateScannedContent(bodyOf([
      { role: 'system', content: 'first rule' },
      { role: 'system', content: 'second rule' },
      { role: 'user', content: 'hi' },
    ]))
    const messages = messagesOf(out as string)
    expect(messages).toHaveLength(3)
    const carried = contentOf(messages[1])
    expect(carried.indexOf('first rule')).toBeLessThan(carried.indexOf('second rule'))
  })

  it('tool 消息与 tool_calls 配对保持原样（只搬 system，不重排别的角色）', () => {
    const out = relocateScannedContent(bodyOf([
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1' }] },
      { role: 'tool', tool_call_id: 't1', content: 'result' },
    ]))
    const messages = messagesOf(out as string)
    expect(messages.map(message => message['role'])).toEqual(['system', 'user', 'user', 'assistant', 'tool'])
    expect(messages[4]?.['tool_call_id']).toBe('t1')
  })

  it('system 正文就是中性占位时返回 undefined（没有东西可搬）', () => {
    expect(relocateScannedContent(bodyOf([
      { role: 'system', content: WB_FALLBACK_SYSTEM_PROMPT },
      { role: 'user', content: 'hi' },
    ]))).toBeUndefined()
  })

  it('带中性头的真实提示词**照常搬**（中性头只挡前缀门，挡不住正文 span）', () => {
    // 这是本次报障的形状：`prepareChatBody` 已经给表内开场白前置了中性头，如果迁移
    // 因此跳过（旧实现用 startsWithNeutralHead 判），正文里的 span 就永远不会被搬走。
    const relocated = relocateScannedContent(bodyOf([
      { role: 'system', content: `${WB_FALLBACK_SYSTEM_PROMPT}\n\n${SPAN}` },
      { role: 'user', content: 'hi' },
    ]))
    expect(relocated).toBeDefined()
    expect(contentOf(messagesOf(relocated as string)[0])).toBe(WB_FALLBACK_SYSTEM_PROMPT)
    expect(contentOf(messagesOf(relocated as string)[1])).toContain(SPAN)
  })

  it('没有 system / 坏 JSON / 非对象一律 undefined，永不抛出', () => {
    expect(relocateScannedContent(bodyOf([{ role: 'user', content: 'hi' }]))).toBeUndefined()
    expect(relocateScannedContent('not json')).toBeUndefined()
    expect(relocateScannedContent('[]')).toBeUndefined()
    expect(relocateScannedContent('{}')).toBeUndefined()
    expect(relocateScannedContent('{"messages":[null,42,"x"]}')).toBeUndefined()
  })

  it('保住原 body 的 key 顺序（重试的是同一个请求，不是重排过的请求）', () => {
    const body = JSON.stringify({
      model: 'glm-5.3',
      stream: true,
      messages: [{ role: 'system', content: 'rules' }],
    })
    const out = relocateScannedContent(body) as string
    expect(Object.keys(JSON.parse(out) as object)).toEqual(['model', 'stream', 'messages'])
  })
})
