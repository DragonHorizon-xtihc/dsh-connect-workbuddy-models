/**
 * 回环 shim（宿主 → OpenAI 兼容网关 → 上游）。
 *
 * 分两层测：
 *
 * - **纯函数**（请求体整形、限流时刻解析、对话身份）—— 这些在真实流量里几乎
 *   不会出错，但一旦错了就是全链路错，且症状离原因很远。
 * - **真端口**（`listen(0)`）—— 鉴权闸门、错误码、路由只在真的 HTTP 往返里成立，
 *   mock 掉 `IncomingMessage` 等于测那个 mock。
 *
 * 唯一被替身的是 `WbUpstreamClient`：它是网络边界，替身必须遵守它的返回契约
 * （`WbChatResult` 是判别联合，不是裸 Response），否则测的是替身自己的错。
 */

import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WB_FALLBACK_SYSTEM_PROMPT,
  conversationKeyOf,
  createWbShim,
  isContextTooLong,
  parseRateLimitReset,
  prepareChatBody,
} from '../src/shim.ts'
import type { WbShim } from '../src/shim.ts'
import { WbAccountPool } from '../src/accounts.ts'
import type { WbDiscoveredAccount } from '../src/accounts.ts'
import { WbCatalog } from '../src/catalog.ts'
import { classifyUpstreamError } from '../src/upstream.ts'
import type { WbChatResult } from '../src/upstream.ts'

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

describe('prepareChatBody 整形请求体', () => {
  it('强制 stream=true（adapter 只会以流式调用，非流式会让响应挂住）', () => {
    const out = JSON.parse(prepareChatBody(JSON.stringify({ messages: [] }))) as Record<string, unknown>
    expect(out['stream']).toBe(true)
  })

  it('developer 角色改写成 system（上游只认 system）', () => {
    const out = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [{ role: 'developer', content: 'be nice' }],
    }))) as { messages: { role: string }[] }
    expect(out.messages[0]?.role).toBe('system')
  })

  it('首条不是 system 时补一条兜底 system（网关按开场白指纹判通道）', () => {
    const out = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [{ role: 'user', content: 'hi' }],
    }))) as { messages: { role: string; content: string }[] }
    expect(out.messages[0]).toEqual({ role: 'system', content: WB_FALLBACK_SYSTEM_PROMPT })
    expect(out.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('首条已经是 system 时不重复插入', () => {
    const out = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [{ role: 'system', content: 'mine' }, { role: 'user', content: 'hi' }],
    }))) as { messages: { role: string; content: string }[] }
    expect(out.messages.filter(m => m.role === 'system')).toHaveLength(1)
    expect(out.messages[0]?.content).toBe('mine')
  })

  it('非 JSON / 非对象原样返回（不把用户的坏请求变成 500）', () => {
    expect(prepareChatBody('not json')).toBe('not json')
    expect(prepareChatBody('[]')).toBe('[]')
    expect(prepareChatBody('"str"')).toBe('"str"')
  })
})

describe('parseRateLimitReset 从限流文案里取重置时刻', () => {
  it('认 13 位 epoch 毫秒的 resetAt / reset_at / resetTime / reset_time', () => {
    const at = 1_800_000_000_000
    for (const key of ['resetAt', 'reset_at', 'resetTime', 'reset_time']) {
      expect(parseRateLimitReset(`{"${key}":${at}}`), key).toBe(at)
    }
  })

  it('认中文文案里的日期时间', () => {
    const parsed = parseRateLimitReset('额度将在 2026-03-15 09:00:00 重置')
    expect(parsed).toBe(Date.parse('2026-03-15T09:00:00'))
  })

  it('没有可识别信息时返回 undefined（让调用方退回默认冷却）', () => {
    expect(parseRateLimitReset('rate limited')).toBeUndefined()
    expect(parseRateLimitReset('')).toBeUndefined()
    // 10 位 epoch 秒不是毫秒，不该被当成时间。
    expect(parseRateLimitReset('{"resetAt":1800000000}')).toBeUndefined()
  })
})

describe('isContextTooLong 识别超窗（要换成「缩短对话」的提示，不能报成上游故障）', () => {
  it('认各家文案', () => {
    for (const text of [
      'error: context_length_exceeded',
      'input length too long',
      'context window exceeded',
      'maximum context length is 128000',
      'This exceeds the model context window',
    ]) {
      expect(isContextTooLong(text), text).toBe(true)
    }
  })

  it('普通限流不算超窗', () => {
    expect(isContextTooLong('rate limit reached')).toBe(false)
    expect(isContextTooLong('')).toBe(false)
  })
})

describe('conversationKeyOf 生成稳定的对话身份（sticky 用）', () => {
  const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32)

  it('同一对话的后续轮次哈希相同（用第一条 user 消息，而不是增长的全文）', () => {
    const first = JSON.stringify({ messages: [{ role: 'user', content: '第一句' }] })
    const second = JSON.stringify({
      messages: [
        { role: 'user', content: '第一句' },
        { role: 'assistant', content: '回答' },
        { role: 'user', content: '第二句' },
      ],
    })
    expect(conversationKeyOf(first)).toBe(conversationKeyOf(second))
    expect(conversationKeyOf(first)).toBe(sha('第一句'))
  })

  it('不同开头的对话哈希不同', () => {
    const a = JSON.stringify({ messages: [{ role: 'user', content: 'A' }] })
    const b = JSON.stringify({ messages: [{ role: 'user', content: 'B' }] })
    expect(conversationKeyOf(a)).not.toBe(conversationKeyOf(b))
  })

  it('没有 user 消息 / 坏 JSON / 非数组 messages 时返回 undefined', () => {
    expect(conversationKeyOf(JSON.stringify({ messages: [{ role: 'assistant', content: 'x' }] }))).toBeUndefined()
    expect(conversationKeyOf('nope')).toBeUndefined()
    expect(conversationKeyOf(JSON.stringify({ messages: 'not-array' }))).toBeUndefined()
  })

  it('content 是数组时也能哈希（多模态首条消息）', () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }] }],
    })
    expect(conversationKeyOf(body)).toBeDefined()
  })
})

// ── 真端口 ───────────────────────────────────────────────────────────────

let live: WbShim | undefined

afterEach(async () => {
  await live?.close()
  live = undefined
})

/**
 * 上游替身：吃一个 (status, body) 描述，回**真实契约**的 `WbChatResult`。
 *
 * 归类交给真正的 `classifyUpstreamError` —— 这样「402 是否算 hard_credit」这类
 * 判断由产品代码决定，测试只负责喂状态码。
 */
function upstreamReturning(script: readonly { status: number; body: string }[]) {
  let index = 0
  return async (): Promise<WbChatResult> => {
    const step = script[Math.min(index, script.length - 1)]!
    index += 1
    if (step.status === 200) {
      return {
        ok: true,
        response: new Response(step.body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      }
    }
    return {
      ok: false,
      status: step.status,
      kind: classifyUpstreamError(step.status, step.body),
      message: step.body,
    }
  }
}

function startShim(options: {
  accounts?: readonly WbDiscoveredAccount[]
  upstream?: () => Promise<WbChatResult>
  models?: readonly { id: string; name: string }[]
} = {}): { shim: WbShim; pool: WbAccountPool; calls: string[] } {
  const pool = new WbAccountPool({})
  pool.applyDiscovery({ accounts: options.accounts ?? [account('a')], skipped: [] })
  const catalog = new WbCatalog('cn')
  if (options.models !== undefined) catalog.applyFetch(options.models as never, Date.now())
  const calls: string[] = []
  const upstream = options.upstream
    ?? upstreamReturning([{ status: 200, body: 'data: {"choices":[]}\n\ndata: [DONE]\n\n' }])
  const shim = createWbShim({
    pool,
    catalog,
    region: 'cn',
    client: {
      chatStream: async (credential: { accessToken: string }) => {
        calls.push(credential.accessToken)
        return await upstream()
      },
      fetchCredits: async () => ({ total: 42, packages: [] }),
    } as never,
  })
  live = shim
  return { shim, pool, calls }
}

/** 发一个 OpenAI 形状的 chat 请求。 */
async function postChat(
  shim: WbShim,
  init: { bearer?: string | null; body?: unknown; path?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  await shim.ready
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...init.headers,
  }
  const bearer = init.bearer === undefined ? shim.token() : init.bearer
  if (bearer !== null) headers['Authorization'] = `Bearer ${bearer}`
  return await fetch(`${shim.baseUrl()}${init.path ?? '/v1/chat/completions'}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(init.body ?? { messages: [{ role: 'user', content: 'hi' }] }),
  })
}

describe('鉴权闸门', () => {
  it('正确的 bearer 放行，并把请求转给上游', async () => {
    const { shim, calls } = startShim()
    const res = await postChat(shim)
    expect(res.status).toBe(200)
    expect(calls).toEqual(['tok'])
  })

  it('缺 Authorization 回 401', async () => {
    const { shim, calls } = startShim()
    const res = await postChat(shim, { bearer: null })
    expect(res.status).toBe(401)
    expect(calls).toEqual([])
  })

  it('错的 bearer 回 401（不能让任意本地进程白用账号池）', async () => {
    const { shim, calls } = startShim()
    const res = await postChat(shim, { bearer: 'wrong-secret' })
    expect(res.status).toBe(401)
    expect(calls).toEqual([])
  })

  it('非回环 Host 被挡（防 DNS rebinding）', async () => {
    const { shim } = startShim()
    await shim.ready
    // 必须用 http.request：undici 的 fetch 会把 Host 改写成目标地址，
    // 用它测 Host 闸门等于恒过。
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${shim.baseUrl()}/v1/models`, {
        method: 'GET',
        headers: {
          'Host': 'evil.example.com',
          'Authorization': `Bearer ${shim.token()}`,
        },
      }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(403)
  })

  it('跨站 Origin 被挡', async () => {
    const { shim } = startShim()
    const res = await postChat(shim, { headers: { Origin: 'https://evil.example.com' } })
    expect(res.status).toBe(403)
  })

  it('回环 Origin 放行', async () => {
    const { shim } = startShim()
    const res = await postChat(shim, { headers: { Origin: 'http://127.0.0.1:3080' } })
    expect(res.status).toBe(200)
  })
})

describe('/v1/models', () => {
  it('回当前目录的模型列表', async () => {
    const { shim } = startShim({ models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }] })
    await shim.ready
    const res = await fetch(`${shim.baseUrl()}/v1/models`, {
      headers: { 'Authorization': `Bearer ${shim.token()}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { id: string }[] }
    expect(body.data.map(m => m.id)).toEqual(['m1', 'm2'])
  })

  it('未知路由回 404 且带方法名（便于诊断）', async () => {
    const { shim } = startShim()
    await shim.ready
    const res = await fetch(`${shim.baseUrl()}/v1/nope`, {
      headers: { 'Authorization': `Bearer ${shim.token()}` },
    })
    expect(res.status).toBe(404)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toContain('/v1/nope')
  })
})

describe('chat 的上游失败映射', () => {
  it('上游 429 → 回 429 而不是 401', async () => {
    const { shim } = startShim({
      upstream: upstreamReturning([{ status: 429, body: '{"msg":"rate limit reached"}' }]),
    })
    const res = await postChat(shim)
    // 把临时限流报成 401 会让 DSH 显示「API key 无效」，逼用户去重新登录。
    expect(res.status).toBe(429)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('soft_rate')
  })

  it('上游 402（额度耗尽）→ 402 hard_credit', async () => {
    const { shim } = startShim({
      upstream: upstreamReturning([{ status: 402, body: '{"msg":"Credits exhausted"}' }]),
    })
    const res = await postChat(shim)
    expect(res.status).toBe(402)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('hard_credit')
  })

  it('上下文超窗 → 400 且提示缩短对话，而不是「凭据失效」', async () => {
    const { shim } = startShim({
      upstream: upstreamReturning([{ status: 400, body: '{"msg":"context_length_exceeded"}' }]),
    })
    const res = await postChat(shim)
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('context_length_exceeded')
    expect(body.error.message).toContain('上下文')
  })

  it('普通 400（请求形状被拒）不回 500，也不浪费多账号重试', async () => {
    let attempts = 0
    const base = upstreamReturning([{ status: 400, body: '{"msg":"bad param"}' }])
    const { shim } = startShim({
      accounts: [account('a'), account('b'), account('c')],
      upstream: async () => { attempts += 1; return await base() },
    })
    const res = await postChat(shim)
    expect(res.status).toBe(400)
    // 换账号不会改变「这个请求形状不被接受」，试 3 次只是把等待时间乘 3。
    expect(attempts).toBe(1)
  })

  it('账号池为空回 401 并说清「去登录桌面端」', async () => {
    const { shim } = startShim({ accounts: [] })
    const res = await postChat(shim)
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('not_signed_in')
    expect(body.error.message).toContain('登录')
  })

  it('Content-Type 不是 JSON 回 415', async () => {
    const { shim } = startShim()
    await shim.ready
    const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${shim.token()}`,
        'Content-Type': 'text/plain',
      },
      body: 'hi',
    })
    expect(res.status).toBe(415)
  })
})

describe('多账号重试', () => {
  it('第一个账号失败后自动换下一个，成功即返回', async () => {
    const { shim, calls } = startShim({
      accounts: [account('a'), account('b')],
      upstream: upstreamReturning([
        { status: 500, body: '{"msg":"server error"}' },
        { status: 200, body: 'data: [DONE]\n\n' },
      ]),
    })
    const res = await postChat(shim)
    expect(res.status).toBe(200)
    // 两个账号各试了一次。
    expect(calls).toHaveLength(2)
  })

  it('凭证被拒（401）会写进池，让卡片能提示重新登录', async () => {
    const { shim, pool } = startShim({
      accounts: [account('a')],
      upstream: upstreamReturning([{ status: 401, body: '{"msg":"token expired"}' }]),
    })
    const res = await postChat(shim)
    expect(res.status).toBe(401)
    expect(pool.find('a')?.credentialDead).toBe(true)
  })
})
