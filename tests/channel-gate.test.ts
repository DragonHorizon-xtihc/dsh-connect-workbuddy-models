/**
 * 缺陷 A 的判决性测试：渠道闸门 11128 的两道出站防线。
 *
 * ## 上游到底在拦什么
 *
 * 两个网关都会扫描**每一条** `system` 与 `assistant` 消息的**开头**，命中已知第三方
 * agent 提示词就以业务码 `11128`（`Illegal API invocation from an unapproved
 * channel`）整条拒绝。返回的 `displayTips` 是一句「这次调用没通过渠道校验，可能不是
 * 官方客户端发出的」——读起来像凭据或客户端身份问题，实际是**内容前缀匹配**。同码
 * 还有另外两个分支（`conversation id missing`、`first message is not system prompt`），
 * 只能靠 body 区分。
 *
 * 参考插件（`dsh-connect-workbuddy`）的 `prepareChatBody` 里有两道本插件曾完全缺失的
 * 防线，本文件逐条钉住它们的行为：
 *
 * 1. `neutralizeChannelFingerprints` —— 把命中指纹的 system/assistant 开场移到中性头
 *    之后，未命中的消息一个字节都不改。
 * 2. `dropRefusedReasoning` —— 删掉只会被拒的 `reasoning_effort: "off"`。
 *
 * ## 为什么每一条都要有「不该改的不改」那一半
 *
 * 这两步都跑在**即将上线**的 body 上。多改一个字段、或者给一条网关本来会放行的消息
 * 也前置一行，代价不是「多花几个 token」：中性头会改变模型看到的提示词，而用户完全
 * 不知道自己的 system 提示词被改写了。所以「命中的被改」与「没命中的逐字节不变」
 * 必须成对断言，只测前者会让一个「无条件给所有消息加前缀」的错实现全绿。
 *
 * ## 尚未验证的部分（不得当成已验证）
 *
 * 宿主 DSH 实际发出的 system 首行是否**真的**命中这两条指纹，目前没有抓到过真实出站
 * bodyJson。本文件证明的是「防线按上面的规则工作」，不是「用户报的这次报错就是它修
 * 好的」。移植后若实测仍然报错，说明根因判断有误，要回去重新取证。
 */

import { describe, expect, it } from 'vitest'
import { WB_FALLBACK_SYSTEM_PROMPT, prepareChatBody } from '../src/shim.ts'

/** 已实测会被网关拒的两条 system/assistant 开头。 */
const BANNED_OPENINGS: readonly string[] = [
  'You are an AI agent powered by DeepSeek Harness',
  "You are Claude Code, Anthropic's official CLI for Claude",
]

/** 把 `prepareChatBody` 的输出解析回来（它总是返回 JSON 字符串）。 */
function prepared(body: unknown): Record<string, unknown> {
  return JSON.parse(prepareChatBody(JSON.stringify(body))) as Record<string, unknown>
}

/** 取某条消息的 content；数组形态取第一个 text part。 */
function contentOf(message: unknown): string {
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as Record<string, unknown>)['content']
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const first = content[0]
  if (typeof first !== 'object' || first === null) return ''
  const text = (first as Record<string, unknown>)['text']
  return typeof text === 'string' ? text : ''
}

describe('neutralizeChannelFingerprints：命中指纹的 system 开场被移出匹配区', () => {
  it('两条实测指纹都带前缀走（网关只匹配消息开头，所以一行中性头就够了）', () => {
    for (const opening of BANNED_OPENINGS) {
      const out = prepared({
        messages: [
          { role: 'system', content: `${opening}\n\n其余提示词原样保留` },
          { role: 'user', content: 'hi' },
        ],
      })
      const messages = out['messages'] as unknown[]
      expect(contentOf(messages[0]), opening)
        .toBe(`${WB_FALLBACK_SYSTEM_PROMPT}\n\n${opening}\n\n其余提示词原样保留`)
      // 用户消息一个字节都不动。
      expect(contentOf(messages[1]), opening).toBe('hi')
    }
  })

  it('比较是大小写不敏感 + trim 前导空白（网关当前宽容这两种，但随时会收回）', () => {
    const lower = prepared({ messages: [{ role: 'system', content: 'you are an ai agent powered by deepseek harness' }] })
    expect(contentOf((lower['messages'] as unknown[])[0])).toContain(WB_FALLBACK_SYSTEM_PROMPT)

    const spaced = prepared({ messages: [{ role: 'system', content: '  \n You are an AI agent powered by DeepSeek Harness' }] })
    expect(contentOf((spaced['messages'] as unknown[])[0])).toContain(WB_FALLBACK_SYSTEM_PROMPT)
  })

  it('没命中的 system 消息逐字节不变（绝不给会放行的请求加前缀）', () => {
    const body = {
      messages: [
        { role: 'system', content: 'You are a coding assistant. Be concise.' },
        { role: 'user', content: 'hi' },
      ],
    }
    const out = prepared(body)
    const messages = out['messages'] as unknown[]
    expect(contentOf(messages[0])).toBe('You are a coding assistant. Be concise.')
    // 整条消息对象也没被塞额外字段。
    expect(messages[0]).toEqual({ role: 'system', content: 'You are a coding assistant. Be concise.' })
  })

  it('中段命中不动（网关只扫开头，改中段是白改且会污染提示词）', () => {
    const text = `You are a coding assistant.\n\n${BANNED_OPENINGS[0]}`
    const out = prepared({ messages: [{ role: 'system', content: text }] })
    expect(contentOf((out['messages'] as unknown[])[0])).toBe(text)
  })

  it('assistant 历史消息同样被处理（被污染的会话每一轮都会失败，换账号换区域都没用）', () => {
    const out = prepared({
      messages: [
        { role: 'system', content: 'fine' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: `${BANNED_OPENINGS[0]}\n\n我明白了` },
        { role: 'user', content: 'continue' },
      ],
    })
    const messages = out['messages'] as unknown[]
    expect(contentOf(messages[2])).toBe(`${WB_FALLBACK_SYSTEM_PROMPT}\n\n${BANNED_OPENINGS[0]}\n\n我明白了`)
    // 前后两条 user 不动。
    expect(contentOf(messages[1])).toBe('hi')
    expect(contentOf(messages[3])).toBe('continue')
  })

  it('user 消息的开场不处理（实测网关不扫这个角色）', () => {
    const text = `${BANNED_OPENINGS[0]}\n\n我在问问题`
    const out = prepared({
      messages: [{ role: 'system', content: 'fine' }, { role: 'user', content: text }],
    })
    expect(contentOf((out['messages'] as unknown[])[1])).toBe(text)
  })

  it('数组 content 的**第二个** text part 命中也要前置（网关读每一个文本 part）', () => {
    const out = prepared({
      messages: [{
        role: 'system',
        content: [
          { type: 'text', text: '第一段没问题。' },
          { type: 'text', text: `${BANNED_OPENINGS[1]}` },
        ],
      }],
    })
    const parts = ((out['messages'] as Record<string, unknown>[])[0] as Record<string, unknown>)['content'] as Record<string, unknown>[]
    expect(parts[0]?.['text']).toBe('第一段没问题。')
    expect(parts[1]?.['text']).toBe(`${WB_FALLBACK_SYSTEM_PROMPT}\n\n${BANNED_OPENINGS[1]}`)
  })

  it('畸形 part 与畸形消息原样留下，不抛（这段代码跑在即将上线的 body 上）', () => {
    const body = {
      messages: [
        { role: 'system', content: [null, 'bare string', { type: 'text', text: 'ok' }, { type: 'image' }] },
        null,
        'not a message',
      ],
    }
    expect(() => prepareChatBody(JSON.stringify(body))).not.toThrow()
    const out = JSON.parse(prepareChatBody(JSON.stringify(body))) as Record<string, unknown>
    expect((out['messages'] as unknown[]).length).toBe(3)
  })
})

describe('dropRefusedReasoning：只删那一档只会被拒的 off', () => {
  it('名单内的模型 + reasoning_effort:"off" → 字段被删（上游对它回 400 / 11133）', () => {
    for (const model of ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'primary-model', 'gemini-3.5-flash']) {
      const out = prepared({
        model,
        reasoning_effort: 'off',
        messages: [{ role: 'system', content: 'fine' }],
      })
      expect('reasoning_effort' in out, model).toBe(false)
    }
  })

  it('名单外的模型保留 off（其余每个测过的模型都返回 200，删掉是替用户做决定）', () => {
    const out = prepared({
      model: 'glm-5.3',
      reasoning_effort: 'off',
      messages: [{ role: 'system', content: 'fine' }],
    })
    expect(out['reasoning_effort']).toBe('off')
  })

  it('其余每一档一律保留（off 是唯一会失败的一档）', () => {
    for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      const out = prepared({
        model: 'deepseek-v4.1-flash',
        reasoning_effort: effort,
        messages: [{ role: 'system', content: 'fine' }],
      })
      expect(out['reasoning_effort'], effort).toBe(effort)
    }
  })

  it('大小写与空白形态的 off 同样被删（比较前 trim + 小写化）', () => {
    for (const effort of ['OFF', ' off ', 'Off']) {
      const out = prepared({
        model: 'deepseek-v4.1-flash',
        reasoning_effort: effort,
        messages: [{ role: 'system', content: 'fine' }],
      })
      expect('reasoning_effort' in out, effort).toBe(false)
    }
  })

  it('不带该字段的 body 不新增任何键（删调用方没发过的字段等于替它决定怎么思考）', () => {
    const out = prepared({ model: 'deepseek-v4.1-flash', messages: [{ role: 'system', content: 'fine' }] })
    expect('reasoning_effort' in out).toBe(false)
    // 键集与送入时逐项相同，只多出被强制打开的 stream。
    expect(Object.keys(out).sort()).toEqual(['messages', 'model', 'stream'])
  })
})

describe('两步的接入点与顺序', () => {
  it('首条不是 system 时，补的兜底头本身不会被再前置一层（顺序：兜底在前、抹指纹在后）', () => {
    const out = prepared({ messages: [{ role: 'user', content: 'hi' }] })
    const messages = out['messages'] as unknown[]
    expect(contentOf(messages[0])).toBe(WB_FALLBACK_SYSTEM_PROMPT)
    expect(contentOf(messages[0])).not.toBe(`${WB_FALLBACK_SYSTEM_PROMPT}\n\n${WB_FALLBACK_SYSTEM_PROMPT}`)
  })

  it('developer 角色改写与两道防线同时生效（一条被污染的 developer 消息也要救）', () => {
    const out = prepared({
      model: 'deepseek-v4.1-flash',
      reasoning_effort: 'off',
      messages: [{ role: 'developer', content: BANNED_OPENINGS[0] }],
    })
    const messages = out['messages'] as Record<string, unknown>[]
    expect(messages[0]?.['role']).toBe('system')
    expect(contentOf(messages[0])).toBe(`${WB_FALLBACK_SYSTEM_PROMPT}\n\n${BANNED_OPENINGS[0]}`)
    expect('reasoning_effort' in out).toBe(false)
  })

  it('空 messages / 非数组 messages 都不抛（上游该拒的由它拒，插件不制造崩溃）', () => {
    expect(() => prepareChatBody(JSON.stringify({ messages: [] }))).not.toThrow()
    expect(() => prepareChatBody(JSON.stringify({ messages: 'nope' }))).not.toThrow()
    expect(() => prepareChatBody(JSON.stringify({}))).not.toThrow()
  })
})
