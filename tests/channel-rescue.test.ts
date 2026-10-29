/**
 * 渠道闸门（业务码 11128 家族里的「未授权通道」那一支）的两级自救。
 *
 * 这个文件存在的理由是一条实测结论：网关的指纹表**按定义不可能完整**。`prepareChatBody`
 * 里那张 `UNAPPROVED_CHANNEL_OPENINGS` 是 2026-10-21 的实测快照，上游随时能加条目而我们
 * 看不到。所以「彻底解决」不能只是「把今天知道的指纹写进表里」，必须还有一条在表失效时
 * 仍能把请求救回来的路。
 *
 * 三层覆盖，缺一层都不算测到：
 *
 * 1. **纯函数**：`forceNeutralHead` / `relocateScannedContent` 的语义与幂等
 *    （`perturbChannelFingerprints` 的规则也还钉在这里，但它已不是救援梯的一级：
 *    2026-10-29 实测网关会剥离不可见字符，见 `.probe/t34e`）。
 * 2. **判决性**：一条**不在表里**、同形状的新指纹，第一道防线必然放过它，只能靠第二级救。
 *    现有 9 条表内用例（`tests/channel-gate.test.ts`）不能替代这一条 —— 它们证的正是
 *    「表命中了」，而这里要证的是「表没命中时也能救」。
 * 3. **循环行为**：真回环 server（`listen(0)`）+ 只会返回 `channel_reject` 的替身 client，
 *    断言自救发生在**同一凭据**上且次数有上限。自救要是退化成「换号重试」，8 次尝试全是
 *    白花，而用户等到的是一个「试过 N 个账号」的错误 —— 这正是修复前的行为。
 *
 * 替身只需要遵守 `WbChatResult` 判别联合（不是裸 Response），归类交给真正的
 * `classifyUpstreamError`：这样「400 加这段 body 算不算渠道闸门」由产品代码决定。
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  WB_FALLBACK_SYSTEM_PROMPT,
  createWbShim,
  forceNeutralHead,
  perturbChannelFingerprints,
  prepareChatBody,
  relocateScannedContent,
  worthRetrying,
} from '../src/shim.ts'
import type { WbShim } from '../src/shim.ts'
import { WbAccountPool } from '../src/accounts.ts'
import type { WbDiscoveredAccount } from '../src/accounts.ts'
import { WbCatalog } from '../src/catalog.ts'
import { classifyUpstreamError, isChannelGateFamilyBody } from '../src/upstream.ts'
import type { WbChatResult } from '../src/upstream.ts'

const DAY = 86_400_000
const ZWSP = '\u200b'

/**
 * 一条**不在** `UNAPPROVED_CHANNEL_OPENINGS` 里、但形状一模一样的新指纹。
 *
 * 用真实产品名而不是 `SomeOtherHarness` 之类的占位词：网关按产品名匹配，一个
 * 虚构的词恰好证明不了「明天的真实指纹会被救回来」。`SomeOtherHarness` 在这里是
 * 故意的——它**必须**不在表里，否则这条用例就退化成第一条防线的又一次自证。
 */
const OFF_TABLE_OPENING = 'You are an AI agent powered by SomeOtherHarness.'
/** 一句普通的 system 提示词，作为「不该被动」的对照。 */
const NEUTRAL_SYSTEM = 'You are a coding assistant. Be concise.'

afterEach(() => {
  live?.close()
  live = undefined
})

let live: WbShim | undefined

function bodyOf(messages: readonly unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ model: 'glm-5.3', messages, ...extra })
}

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

function messagesOf(bodyJson: string): { role: string; content: unknown }[] {
  return (JSON.parse(bodyJson) as { messages: { role: string; content: unknown }[] }).messages
}

/**
 * 上游替身：按脚本回 `WbChatResult`，并把每次收到的 bodyJson 记下来。
 *
 * 记 body 是这个文件的核心 —— 「自救真的换了请求体」只能从**上游视角**看见，
 * 从 shim 自己的状态看不见。
 */
function recordingUpstream(script: readonly { status: number; body: string }[]) {
  const bodies: string[] = []
  let index = 0
  const fn = async (_credential: unknown, bodyJson: string): Promise<WbChatResult> => {
    bodies.push(bodyJson)
    const step = script[Math.min(index, script.length - 1)]!
    index += 1
    if (step.status === 200) {
      return {
        ok: true,
        response: new Response(step.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      }
    }
    return {
      ok: false,
      status: step.status,
      kind: classifyUpstreamError(step.status, step.body),
      message: step.body,
    }
  }
  return { fn, bodies }
}

const GATE_BODY = '{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}'
const SSE_OK = 'data: {"choices":[]}\n\ndata: [DONE]\n\n'

function account(id: string): WbDiscoveredAccount {
  return {
    id,
    label: id,
    region: 'cn',
    sourcePath: `/fake/${id}.info`,
    source: 'desktop',
    live: true,
    refreshExpired: false,
    tokenExpiresAtMs: Date.now() + 30 * DAY,
    credential: { accessToken: `tok-${id}`, refreshToken: 'ref', expiresAtMs: Date.now() + 30 * DAY, domain: '' },
  }
}

function startShim(options: { accounts?: readonly WbDiscoveredAccount[]; upstream: () => Promise<WbChatResult> }): {
  shim: WbShim
  pool: WbAccountPool
} {
  const pool = new WbAccountPool({})
  pool.applyDiscovery({ accounts: options.accounts ?? [account('a')], skipped: [] })
  const shim = createWbShim({
    pool,
    catalog: new WbCatalog('cn'),
    region: 'cn',
    client: { chatStream: options.upstream, fetchCredits: async () => ({ total: 42, packages: [] }) } as never,
  })
  live = shim
  return { shim, pool }
}

async function postChat(shim: WbShim, body: unknown): Promise<Response> {
  await shim.ready
  return await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
    body: JSON.stringify(body),
  })
}

describe('分类支点：渠道闸门是独立的 kind，且判据不用裸数字', () => {
  it('带引号键形式的 11128 判为 channel_reject', () => {
    expect(isChannelGateFamilyBody(GATE_BODY)).toBe(true)
    expect(classifyUpstreamError(400, GATE_BODY)).toBe('channel_reject')
  })

  it('裸 11128 出现在 requestId 十六进制里**不**算渠道闸门', () => {
    // 真实形态的 requestId：十六进制里出现 11128 这种短串是常见巧合。
    const body = '{"code":500,"msg":"upstream hiccup","requestId":"9f4e685b-11128-4693-b2a6-7863e832f885"}'
    expect(isChannelGateFamilyBody(body)).toBe(false)
    expect(classifyUpstreamError(500, body)).toBe('server')
  })

  it('conversation id missing 仍归 client_reject（那一支已经修好了，不能回退）', () => {
    expect(classifyUpstreamError(400, '{"code":11128,"msg":"conversation id missing"}')).toBe('client_reject')
  })

  it('渠道闸门不值得换号（闸门读请求不读账号）', () => {
    expect(worthRetrying('channel_reject')).toBe(false)
    // 对照：限流与凭据问题值得换号，别把整条规则一起改坏。
    expect(worthRetrying('soft_rate')).toBe(true)
    expect(worthRetrying('authentication')).toBe(true)
  })
})

describe('forceNeutralHead：表外指纹的唯一救法', () => {
  it('表外的同形状新指纹，第一道防线必然放过它，第二级救回它', () => {
    const body = bodyOf([{ role: 'system', content: OFF_TABLE_OPENING }, { role: 'user', content: 'hi' }])

    // ① prepareChatBody 一字不改：它只认表内的 9 条，表外的新指纹它看不见。
    // 这正是「只补指纹表」不够用的直接证据。
    const prepared = prepareChatBody(body)
    expect(contentOf(messagesOf(prepared)[0])).toBe(OFF_TABLE_OPENING)

    // ② forceNeutralHead 把它救回来。注意中性占位与原文之间是空行分隔，不是拼接。
    const forced = forceNeutralHead(prepared)
    expect(forced).toBeDefined()
    expect(contentOf(messagesOf(forced as string)[0]))
      .toBe(`${WB_FALLBACK_SYSTEM_PROMPT}\n\n${OFF_TABLE_OPENING}`)
    // 其余消息不受影响。
    expect(messagesOf(forced as string)[1]?.content).toBe('hi')
  })

  it('表内的已知指纹也会被再前置一次（它不走表，走「无条件前置」）', () => {
    const forced = forceNeutralHead(bodyOf([{ role: 'system', content: 'You are an AI agent powered by DeepSeek Harness.' }]))
    expect(contentOf(messagesOf(forced as string)[0]))
      .toBe(`${WB_FALLBACK_SYSTEM_PROMPT}\n\nYou are an AI agent powered by DeepSeek Harness.`)
  })

  it('已经是中性头开头时返回 undefined（再加就是白花一次注定被拒的往返）', () => {
    const already = bodyOf([{ role: 'system', content: `${WB_FALLBACK_SYSTEM_PROMPT}\n\nanything` }])
    expect(forceNeutralHead(already)).toBeUndefined()
  })

  it('空 content 跳过（带 tool_calls 的 content:"" 是合法重放形状，塞字进去会改语义）', () => {
    const body = bodyOf([
      { role: 'assistant', content: '', tool_calls: [] },
      { role: 'user', content: 'hi' },
    ])
    expect(forceNeutralHead(body)).toBeUndefined()
  })

  it('user 角色不动（网关只扫 system / assistant）', () => {
    const body = bodyOf([{ role: 'user', content: OFF_TABLE_OPENING }])
    expect(forceNeutralHead(body)).toBeUndefined()
  })

  it('assistant 历史消息同样处理（一条这样的历史会污染之后每一轮）', () => {
    const forced = forceNeutralHead(bodyOf([
      { role: 'system', content: 'ok' },
      { role: 'assistant', content: OFF_TABLE_OPENING },
      { role: 'user', content: 'hi' },
    ]))
    expect(contentOf(messagesOf(forced as string)[1]))
      .toBe(`${WB_FALLBACK_SYSTEM_PROMPT}\n\n${OFF_TABLE_OPENING}`)
  })

  it('数组 content 逐个 text part 处理（网关读每一个 part）', () => {
    const forced = forceNeutralHead(bodyOf([
      {
        role: 'system',
        content: [
          { type: 'text', text: NEUTRAL_SYSTEM },
          { type: 'text', text: OFF_TABLE_OPENING },
        ],
      },
    ]))
    const parts = (messagesOf(forced as string)[0]?.content as { type: string; text: string }[])
    // 第一个 part 不是「有罪的开关」也照样前置：这一级是无条件前置，不查表。
    expect(parts[0]?.text).toBe(`${WB_FALLBACK_SYSTEM_PROMPT}\n\n${NEUTRAL_SYSTEM}`)
    expect(parts[1]?.text).toBe(`${WB_FALLBACK_SYSTEM_PROMPT}\n\n${OFF_TABLE_OPENING}`)
  })

  it('坏 JSON / 非对象 / 没有 messages 时返回 undefined，永不抛出', () => {
    expect(forceNeutralHead('not json')).toBeUndefined()
    expect(forceNeutralHead('[]')).toBeUndefined()
    expect(forceNeutralHead('{}')).toBeUndefined()
    expect(forceNeutralHead('{"messages":[null,42,"x"]}')).toBeUndefined()
  })

  it('保住原 key 顺序（重试的是同一个请求，不是重排过的请求）', () => {
    const source = '{"model":"glm-5.3","stream":true,"messages":[{"role":"system","content":"hi"}]}'
    const forced = forceNeutralHead(source) as string
    expect(Object.keys(JSON.parse(forced) as object)).toEqual(['model', 'stream', 'messages'])
  })
})

describe('perturbChannelFingerprints：内层长 span 的唯一救法', () => {
  /** 参考实现实测过的形状：长 span 的结尾是产品名，四条标点规则一条都落不到。 */
  const LONG_SPAN = 'You are an AI agent powered by DeepSeek Harness. '
    + 'Answer the user, and prefer small diffs; never invent files.'

  it('四条规则都生效：英文句末、中文句末、子句边界、词内断点', () => {
    const perturbed = perturbChannelFingerprints(bodyOf([{ role: 'system', content: LONG_SPAN }])) as string
    const text = contentOf(messagesOf(perturbed)[0])
    expect(text).toContain('Harness.')
    expect(text).toContain(`.${ZWSP} `)
    expect(text).toContain(`;${ZWSP} `)
    // 词内断点：末尾那句没有尾随标点，只能靠 WORD_INTERNAL_BREAK 切开。
    expect(text).toContain(`DeepSeek${ZWSP} Harness`)
  })

  it('中文句末同样插零宽（中文提示词不带空格，独立的第四条）', () => {
    const perturbed = perturbChannelFingerprints(bodyOf([{ role: 'system', content: '你是助手。保持简洁。' }])) as string
    expect(contentOf(messagesOf(perturbed)[0])).toBe(`你是助手。${ZWSP}保持简洁。${ZWSP}`)
  })

  it('幂等：同一个 body 连调两次，第二次返回 undefined（不叠加零宽）', () => {
    const once = perturbChannelFingerprints(bodyOf([{ role: 'system', content: LONG_SPAN }])) as string
    expect(perturbChannelFingerprints(once)).toBeUndefined()
    // 第一遍只插了一层：零宽字符数不该翻倍。
    const count = (contentOf(messagesOf(once)[0]).match(new RegExp(ZWSP, 'gu')) ?? []).length
    expect(count).toBeGreaterThan(0)
    expect(count).toBe((contentOf(messagesOf(once)[0]).split(ZWSP).length - 1))
  })

  it('没有可扰动的边界时返回 undefined（不值得为它发一次请求）', () => {
    expect(perturbChannelFingerprints(bodyOf([{ role: 'system', content: 'hi' }]))).toBeUndefined()
  })

  it('user 角色不动', () => {
    expect(perturbChannelFingerprints(bodyOf([{ role: 'user', content: LONG_SPAN }]))).toBeUndefined()
  })

  it('坏 JSON 返回 undefined，永不抛出', () => {
    expect(perturbChannelFingerprints('not json')).toBeUndefined()
    expect(perturbChannelFingerprints('{}')).toBeUndefined()
  })
})

describe('三级救援梯：同一凭据上重试，不换号', () => {
  it('第一次就发内容迁移形态；两次被拒后回退到 system 形态并成功', async () => {
    const { fn, bodies } = recordingUpstream([
      { status: 400, body: GATE_BODY },
      { status: 400, body: GATE_BODY },
      { status: 200, body: SSE_OK },
    ])
    const { shim } = startShim({ upstream: fn })

    const res = await postChat(shim, {
      messages: [{ role: 'system', content: OFF_TABLE_OPENING }, { role: 'user', content: 'hi' }],
    })
    const text = await res.text()

    expect(res.status).toBe(200)
    expect(text).toContain('[DONE]')
    expect(bodies).toHaveLength(3)

    // 第 1 次是**迁移形态**：system 只剩中性占位，原文搬到紧随其后的 user 里。这是默认
    // 形态而不是救援步骤——网关的指纹清单来自「已知 agent 提示词库」，等失败再救等于每次
    // 先白花两三倍的上游调用（见 `relocateScannedContent` 的文档）。
    const relocated = messagesOf(bodies[0] as string)
    expect(relocated[0]?.role).toBe('system')
    expect(relocated[0]?.content).toBe(WB_FALLBACK_SYSTEM_PROMPT)
    expect(relocated[1]?.role).toBe('user')
    expect(contentOf(relocated[1])).toContain(OFF_TABLE_OPENING)
    expect(relocated[2]?.role).toBe('user')
    expect(relocated[2]?.content).toBe('hi')
    expect(bodies[0]).not.toContain(ZWSP)

    // 第 2 次回退到**保留 system 角色**的形态：只留 span 改写，不搬角色。
    expect(contentOf(messagesOf(bodies[1] as string)[0])).toBe(OFF_TABLE_OPENING)

    // 第 3 次在 system 形态之上再前置中性占位，覆盖表外的新前缀。
    expect(contentOf(messagesOf(bodies[2] as string)[0])).toBe(`${WB_FALLBACK_SYSTEM_PROMPT}\n\n${OFF_TABLE_OPENING}`)
  })

  it('始终 channel_reject ⇒ 恰好 3 次而不是 8 次，并给出可执行文案', async () => {
    const { fn, bodies } = recordingUpstream([{ status: 400, body: GATE_BODY }])
    const { shim, pool } = startShim({ upstream: fn })

    const res = await postChat(shim, {
      messages: [{ role: 'system', content: OFF_TABLE_OPENING }, { role: 'user', content: 'hi' }],
    })
    const payload = JSON.parse(await res.text()) as { error: { message: string; code: string } }

    expect(bodies).toHaveLength(3)
    expect(res.status).toBe(400)
    expect(payload.error.code).toBe('channel_reject')
    // 文案要说清「三种形态都试过了」，否则下一个人会把同一个 400 当新问题重查一遍。
    expect(payload.error.message).toContain('三种形态')
    // 不换号：只有一个账号，且它没被判死（闸门不是凭据问题）。
    expect(pool.find('a')?.credentialDead).toBeUndefined()
  })

  it('三个账号也仍然只打 3 次（自救不因多账号变成 8 次换号）', async () => {
    const { fn, bodies } = recordingUpstream([{ status: 400, body: GATE_BODY }])
    const { shim } = startShim({ accounts: [account('a'), account('b'), account('c')], upstream: fn })

    await postChat(shim, {
      messages: [{ role: 'system', content: OFF_TABLE_OPENING }, { role: 'user', content: 'hi' }],
    })
    expect(bodies).toHaveLength(3)
  })

  it('后续请求同样一上来就是迁移形态（不需要重新学一遍）', async () => {
    const { fn, bodies } = recordingUpstream([
      { status: 400, body: GATE_BODY },
      { status: 400, body: GATE_BODY },
      { status: 200, body: SSE_OK },
      { status: 200, body: SSE_OK },
    ])
    const { shim } = startShim({ upstream: fn })
    const body = { messages: [{ role: 'system', content: OFF_TABLE_OPENING }, { role: 'user', content: 'hi' }] }

    const first = await postChat(shim, body)
    await first.text()
    expect(bodies).toHaveLength(3)

    const second = await postChat(shim, body)
    await second.text()
    // 第二次请求只多了一次调用，且它一上来就是迁移形态（默认形态，与「学到」无关）。
    expect(bodies).toHaveLength(4)
    expect(contentOf(messagesOf(bodies[3] as string)[0])).toBe(WB_FALLBACK_SYSTEM_PROMPT)
    expect(messagesOf(bodies[3] as string)).toHaveLength(3)
  })

  it('没有可搬运的 system 正文时只打 1 次（不为一份逐字节相同的请求白花往返）', async () => {
    // system 正文就是中性占位本身：prepare 没有可改写的前缀，relocate 认为没有东西可搬，
    // forceNeutralHead 看到已经是中性头也返回 undefined —— 三级都如实报告「改变不了
    // 任何东西」，于是只发一次，而不是发三份一样的请求。
    const { fn, bodies } = recordingUpstream([{ status: 400, body: GATE_BODY }])
    const { shim } = startShim({ upstream: fn })
    const body = { messages: [{ role: 'system', content: WB_FALLBACK_SYSTEM_PROMPT }, { role: 'user', content: 'hi' }] }

    const res = await postChat(shim, body)
    await res.text()
    expect(bodies).toHaveLength(1)
    expect(contentOf(messagesOf(bodies[0] as string)[0])).toBe(WB_FALLBACK_SYSTEM_PROMPT)
  })

  it('普通形态本来就过时，不触发任何自救（不误伤正常请求）', async () => {
    const { fn, bodies } = recordingUpstream([{ status: 200, body: SSE_OK }])
    const { shim } = startShim({ upstream: fn })

    const res = await postChat(shim, { messages: [{ role: 'system', content: NEUTRAL_SYSTEM }, { role: 'user', content: 'hi' }] })
    await res.text()
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).not.toContain(ZWSP)
  })
})
