/**
 * 本机 billion-context 闸门的 422，不能被读成「上游按参数拒绝」。
 *
 * 这次缺陷的形状：闸门在我们**自己的进程里**拦下请求（请求根本没发给 WorkBuddy），
 * 回的是 422 + `{"error":{"code":"bili_gate_oversize_refusal_unattributed", …}}`。
 * 旧实现三处一起出错，于是用户看到的是一句最误导的话：
 *
 * 1. `classifyUpstreamError` 对 422 没有分支，落到末尾 `return 'client'`；
 * 2. `KIND_STATUS.client` 是 400，422 被压成 400 —— 与「参数写错了」完全同形；
 * 3. `parseUpstreamErrorDetail` 只读顶层，闸门把码放在 `error.code` 那层，于是
 *    `detail` 是空对象，正文退化成被截断的裸 JSON，闸门自己写的三条可执行建议全丢；
 * 4. 正文还贴上了 `client` 那句「换账号也不会改变结果」—— 用户于是去换账号换模型，
 *    而真正要动的只有历史长度。
 *
 * 两层测，缺一层都不算测到：
 * - **纯函数**：分类、detail 下探、`worthRetrying`。这一层能钉住「不看状态码」。
 * - **真端口**：走真回环 server 与真 `fetch`，读回来的 `error.message` 才是用户
 *   实际看到的那串。这一层能钉住「状态码是 422 而不是 400」与「那三条建议真的
 *   在正文里」——只测纯函数会漏掉 `KIND_STATUS` 与正文拼装。
 *
 * 两份夹具是闸门源码里那两条 `message` 常量与 `JSON.stringify` 的**逐字**结果
 * （`billion-context/dist/agent/dsh-native.js` 的 `unattributedOversizeRefusal` 与
 * `oversizeRefusal`），不是照着「大概长这样」手写的：闸门的措辞会变，而我们要
 * 认的正是它的措辞与码。
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  WB_FALLBACK_SYSTEM_PROMPT,
  createWbShim,
  worthRetrying,
} from '../src/shim.ts'
import type { WbShim } from '../src/shim.ts'
import { WbAccountPool } from '../src/accounts.ts'
import type { WbDiscoveredAccount } from '../src/accounts.ts'
import { WbCatalog } from '../src/catalog.ts'
import {
  classifyUpstreamError,
  isChannelGateFamilyBody,
  localGateKindOf,
  parseUpstreamErrorDetail,
} from '../src/upstream.ts'
import type { WbChatResult } from '../src/upstream.ts'

const DAY = 86_400_000

/** 未归属那一支：没有任何受管会话认得这次请求，且体积可证明超 100 万 token。 */
const UNATTRIBUTED_BODY = '{"error":{"type":"server_error","code":"bili_gate_oversize_refusal_unattributed","message":"billion-context refused this request locally: it is not attributed to any bili-managed session, and its body provably exceeds even a 1,000,000-token window — sending it directly to the provider can only be rejected (every retry re-sends the same oversized history, #4068). Route the conversation through a bili-managed session so it can be compressed (check the client\'s bili plugin attribution), or trim/remove the oversized content (e.g. a giant paste or tool result), or start a fresh session.","retryable":false}}'

/** 归属查询抛错那一支：会话作用域已释放/正在关闭。 */
const OVERSIZE_BODY = '{"error":{"type":"server_error","code":"bili_gate_oversize_refusal","message":"billion-context refused this request locally: the host\'s attribution lookup threw mid-request (its agent scope is disposed/closing), so this body cannot be folded into the model\'s context window — forwarding it uncompressed would be rejected upstream (#2924). While that scope stays dead, retrying this same call will keep failing; restart the client host once (its session state is persisted on disk, so nothing is lost) so the oversized history can be folded back under the window. If you cannot restart, start a fresh session instead.","retryable":false}}'

/**
 * Anthropic 形状的拒绝体（闸门对 `/messages` 结尾的 URL 用它）。
 *
 * **只有 `message` 没有 `code`**：这就是为什么不能只靠业务码认，而要靠那句开场白。
 * 真实 ChatGPT/Anthropic 客户端走的就是这条路径。
 */
const ANTHROPIC_SHAPE_BODY = '{"type":"error","error":{"type":"invalid_request_error","message":"billion-context refused this request locally: it is not attributed to any bili-managed session, and its body provably exceeds even a 1,000,000-token window — sending it directly to the provider can only be rejected (every retry re-sends the same oversized history, #4068). Route the conversation through a bili-managed session so it can be compressed (check the client\'s bili plugin attribution), or trim/remove the oversized content (e.g. a giant paste or tool result), or start a fresh session."}}'

/** 真上游的参数拒绝（11133）：本任务**不允许**改变它的任何行为。 */
const PARAMS_REJECTED_BODY = '{"code":11133,"msg":"the request parameters were rejected by the model provider","requestId":"33221fe5-f6d5-4ea1-8882-669411e07a5b","extError":{"code":"invalid_request_error","message":"the request parameters were rejected by the model provider","param":"","type":"invalid_request_error","StatusCode":400,"Request":null,"Response":null},"displayMsg":{"en":"The model cannot handle this request. Please retry","zh":"模型无法处理此请求，请重试"},"displayTips":{"en":"This model does not accept the current conversation. It is not a network issue. Please start a new task, switch models, or try again later.","zh":"这次对话的内容这个模型不接受，与网络无关。请新建任务、换个模型或稍后重试。"},"actions":["SWITCH_MODEL","SUBMIT_FEEDBACK","NEW_CONVERSATION"]}'

// ── 纯函数：分类支点 ─────────────────────────────────────────────────────

describe('本机闸门的分类支点（不看状态码）', () => {
  it('未归属那一支被认出来，且不是 client', () => {
    const kind = classifyUpstreamError(422, UNATTRIBUTED_BODY)
    expect(kind).toBe('local_gate_unattributed')
    expect(kind).not.toBe('client')
  })

  it('归属查询抛错那一支也是自己的 kind，与未归属分开', () => {
    expect(classifyUpstreamError(422, OVERSIZE_BODY)).toBe('local_gate_oversize')
    // 两支的处置不同（一支裁剪内容就能过，一支要重启宿主），合并成一个会让其中
    // 一支的用户拿到错的动作。
    expect(classifyUpstreamError(422, OVERSIZE_BODY)).not.toBe(classifyUpstreamError(422, UNATTRIBUTED_BODY))
  })

  it('同一份 body 换个状态码仍然是闸门（结论不依赖 HTTP 码）', () => {
    expect(classifyUpstreamError(400, UNATTRIBUTED_BODY)).toBe('local_gate_unattributed')
    expect(classifyUpstreamError(500, UNATTRIBUTED_BODY)).toBe('local_gate_unattributed')
    expect(classifyUpstreamError(200, OVERSIZE_BODY)).toBe('local_gate_oversize')
  })

  it('Anthropic 形状只有 message 没有 code，靠开场白也认得出来', () => {
    expect(localGateKindOf(ANTHROPIC_SHAPE_BODY)).toBe('local_gate_unattributed')
    // 只有开场白、两支判别句都不在时按未归属处理：它的建议更保守（裁剪内容）。
    expect(localGateKindOf('billion-context refused this request locally: something new')).toBe('local_gate_unattributed')
  })

  it('不是闸门的 body 一律返回 undefined（不误伤）', () => {
    expect(localGateKindOf(PARAMS_REJECTED_BODY)).toBeUndefined()
    expect(localGateKindOf('{"msg":"bad param"}')).toBeUndefined()
    expect(localGateKindOf('')).toBeUndefined()
    // 长的那个码包含短的那个码的前缀，识别正确性靠这个反向锁。
    expect(localGateKindOf(OVERSIZE_BODY)).toBe('local_gate_oversize')
  })
})

describe('本机闸门的 detail 下探', () => {
  it('能从 error.code / error.message / error.retryable 读到东西', () => {
    const detail = parseUpstreamErrorDetail(UNATTRIBUTED_BODY)
    expect(detail?.localGateCode).toBe('bili_gate_oversize_refusal_unattributed')
    expect(detail?.retryable).toBe(false)
    // 顶层没有人话，所以从 error.message 取 —— 否则用户只看得到裸 JSON。
    expect(detail?.displayMsg).toContain('billion-context refused this request locally')
    // 码不是数字，不该被塞进 upstreamCode（那是「上游业务码」的位置）。
    expect(detail?.upstreamCode).toBeUndefined()
  })

  it('Anthropic 形状没有 code 时 detail 仍不为空', () => {
    const detail = parseUpstreamErrorDetail(ANTHROPIC_SHAPE_BODY)
    expect(detail).toBeDefined()
    expect(detail?.displayMsg).toContain('billion-context refused')
    expect(detail?.localGateCode).toBeUndefined()
  })

  it('顶层有人话时不重复采用 error.message（避免同一句算两遍）', () => {
    const detail = parseUpstreamErrorDetail(JSON.stringify({
      msg: '顶层短结论',
      error: { code: 'bili_gate_oversize_refusal', message: 'error 层的长句' },
    }))
    expect(detail?.displayMsg).toBe('顶层短结论')
  })

  it('普通上游信封不带 localGateCode / retryable（不误伤）', () => {
    const detail = parseUpstreamErrorDetail(PARAMS_REJECTED_BODY)
    expect(detail?.upstreamCode).toBe(11133)
    expect(detail?.localGateCode).toBeUndefined()
    expect(detail?.retryable).toBeUndefined()
  })
})

describe('本机闸门不该换号', () => {
  it('worthRetrying 对两支都说 false', () => {
    expect(worthRetrying('local_gate_oversize')).toBe(false)
    expect(worthRetrying('local_gate_unattributed')).toBe(false)
  })

  it('同一份 body 也不是渠道闸门那一支（11128 家族没被扩大）', () => {
    expect(isChannelGateFamilyBody(UNATTRIBUTED_BODY)).toBe(false)
    expect(isChannelGateFamilyBody(OVERSIZE_BODY)).toBe(false)
    expect(isChannelGateFamilyBody('{"code":11128}')).toBe(true)
  })
})

describe('既有分支一个都没被动到', () => {
  it('401/402/14018/429/conversation-id 各自仍是原来那个 kind', () => {
    expect(classifyUpstreamError(401, '')).toBe('authentication')
    expect(classifyUpstreamError(403, '')).toBe('authentication')
    expect(classifyUpstreamError(402, '')).toBe('hard_credit')
    expect(classifyUpstreamError(400, '{"code":14018,"msg":"Credits exhausted."}')).toBe('hard_credit')
    expect(classifyUpstreamError(429, '')).toBe('soft_rate')
    expect(classifyUpstreamError(400, 'conversation id missing')).toBe('client_reject')
    expect(classifyUpstreamError(400, '{"code":11128}')).toBe('channel_reject')
    expect(classifyUpstreamError(503, 'boom')).toBe('server')
  })

  it('真上游的参数拒绝仍然落到 client（并保留它那句建议）', () => {
    expect(classifyUpstreamError(400, PARAMS_REJECTED_BODY)).toBe('client')
  })
})

// ── 真端口 ───────────────────────────────────────────────────────────────

let live: WbShim | undefined

afterEach(async () => {
  await live?.close()
  live = undefined
})

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
    credential: { accessToken: 'tok', refreshToken: 'ref', expiresAtMs: Date.now() + 30 * DAY, domain: '', sourcePath: '/fake/credential.info' },
  }
}

/**
 * 上游替身：喂一份 422 body，回**真实契约**的 `WbChatResult`。
 *
 * `detail` 由真的 `parseUpstreamErrorDetail` 产出，与 `postChat` 里那行赋值同源；
 * 测试自己手搓 detail 就等于测一个上游不会产生的形状。
 */
function rejectingWith(status: number, body: string): () => Promise<WbChatResult> {
  return async () => {
    const detail = parseUpstreamErrorDetail(body)
    return {
      ok: false,
      status,
      kind: classifyUpstreamError(status, body),
      message: body,
      ...detail === undefined ? {} : { detail },
    }
  }
}

function startShim(upstream: () => Promise<WbChatResult>, accounts: readonly string[] = ['a']): { shim: WbShim; pool: WbAccountPool; calls: string[] } {
  const pool = new WbAccountPool({})
  pool.applyDiscovery({ accounts: accounts.map(account), skipped: [] })
  const calls: string[] = []
  const shim = createWbShim({
    pool,
    catalog: new WbCatalog('cn'),
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

interface Reply {
  status: number
  message: string
  type: string
  code: string
}

async function rejectOnce(status: number, body: string, accounts: readonly string[] = ['a']): Promise<Reply & { calls: string[] }> {
  const { shim, calls } = startShim(rejectingWith(status, body), accounts)
  await shim.ready
  const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${shim.token()}` },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'system', content: WB_FALLBACK_SYSTEM_PROMPT }, { role: 'user', content: 'hi' }],
    }),
  })
  const parsed = await res.json() as { error: Reply }
  return { ...parsed.error, status: res.status, calls }
}

describe('本机闸门拒绝时用户看到的那句话（真端口）', () => {
  it('对外是 422 而不是 400（压成 400 就与「参数写错了」同形）', async () => {
    const reply = await rejectOnce(422, UNATTRIBUTED_BODY)
    expect(reply.status).toBe(422)
    expect(reply.type).toBe('local_gate_unattributed')
    expect(reply.code).toBe('local_gate_unattributed')
  })

  it('正文说清「拦在本地、没发给上游」，并给出三条中文可执行建议', async () => {
    const reply = await rejectOnce(422, UNATTRIBUTED_BODY)
    expect(reply.message).toContain('本机 billion-context 闸门')
    expect(reply.message).toContain('没有发给 WorkBuddy 上游')
    // 三条建议里最要紧的两条（裁剪处理超大内容 / 新开会话）必须是中文且能照做。
    expect(reply.message).toContain('裁剪')
    expect(reply.message).toContain('新开一个会话')
    // 闸门码进正文，报障时能对上它的日志。
    expect(reply.message).toContain('bili_gate_oversize_refusal_unattributed')
    // 不再是裸 JSON 骨架。
    expect(reply.message).not.toContain('"error"')
    expect(reply.message).not.toContain('retryable')
  })

  it('绝不出现「换账号也不会改变结果」这句误导（那是真上游参数拒绝的建议）', async () => {
    const unattributed = await rejectOnce(422, UNATTRIBUTED_BODY)
    expect(unattributed.message).not.toContain('换账号也不会改变结果')
    const oversize = await rejectOnce(422, OVERSIZE_BODY)
    expect(oversize.message).not.toContain('换账号也不会改变结果')
  })

  it('归属查询抛错那一支给的是「重启宿主或新开会话」，不是裁剪指引', async () => {
    const reply = await rejectOnce(422, OVERSIZE_BODY)
    expect(reply.status).toBe(422)
    expect(reply.message).toContain('归属')
    expect(reply.message).toContain('重启一次客户端宿主')
    // 两支的闸门码都能读出来，报障时对得上它的日志。
    expect(reply.message).toContain('闸门码 bili_gate_oversize_refusal')
    // 反向锁：未归属那一支独有的措辞不该出现在这一支里（两支的处置不同）。
    expect(reply.message).not.toContain('接入受管会话')
  })

  it('不换号：池里有三个账号也只打了一次上游，且没有判任何账号已死', async () => {
    const { shim, pool } = startShim(rejectingWith(422, UNATTRIBUTED_BODY), ['a', 'b', 'c'])
    await shim.ready
    const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(422)
    // 闸门读的是请求体，换号只是拿同一份超长历史再撞一次；判凭据已死更是误伤 ——
    // 这份凭据一次都没被上游看到过。
    for (const id of ['a', 'b', 'c']) {
      expect(pool.find(id)?.credentialDead).toBeUndefined()
    }
  })

  it('真上游的参数拒绝一字未变：仍是 400 + 那句「换账号也不会改变结果」', async () => {
    const reply = await rejectOnce(400, PARAMS_REJECTED_BODY)
    expect(reply.status).toBe(400)
    expect(reply.type).toBe('client')
    expect(reply.message).toContain('该请求被上游按参数拒绝')
    expect(reply.message).toContain('换账号也不会改变结果')
    // 反向锁：那段话不该出现在本机闸门的回复里，反之亦然。
    expect(reply.message).not.toContain('本机 billion-context 闸门')
  })
})
