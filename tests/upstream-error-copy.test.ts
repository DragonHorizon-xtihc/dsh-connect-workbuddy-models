/**
 * 上游 400/11133 参数拒绝时，用户**看到的那句话**。
 *
 * 两层测，缺一层都不算测到：
 *
 * - **纯函数**（`parseUpstreamErrorDetail`）：信封解析本身。上游两种形态（`displayMsg`
 *   是字符串 / 是 `{zh,en}`）、单字段畸形、`extError` 缺失都在这一层。
 * - **真端口**：走真回环 server 与真 `fetch`，读回来的 `error.message` 才是用户
 *   实际看到的那串。只测纯函数会漏掉「正文里还留着裸 JSON 骨架」这类问题 ——
 *   那恰恰是本次缺陷的症状（旧实现在回复里贴了 400+ 字符的 `{"code":11133,…}`
 *   原信封，把唯一一句建议切成两半）。
 *
 * 替身只替 `WbUpstreamClient`（网络边界），且必须遵守它的返回契约：失败支带上
 * `detail`，和真实 `postChat` 一样由 `parseUpstreamErrorDetail(text)` 产出。
 *
 * 两份信封夹具逐字搬自参考实现
 * （`plugins/dsh-connect-workbuddy/tests/upstream-error-copy.spec.ts:58` 与 `:97`）：
 * 它们是同一份上游协议的真实样本，自己编一份就测不出上游实际会给什么。
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  WB_FALLBACK_SYSTEM_PROMPT,
  createWbShim,
} from '../src/shim.ts'
import type { WbShim } from '../src/shim.ts'
import { WbAccountPool } from '../src/accounts.ts'
import type { WbDiscoveredAccount } from '../src/accounts.ts'
import { WbCatalog } from '../src/catalog.ts'
import { classifyUpstreamError, parseUpstreamErrorDetail } from '../src/upstream.ts'
import type { WbChatResult } from '../src/upstream.ts'

const DAY = 86_400_000

/** 参数被拒（`extError.param` 为空串）：通用参数拒绝那一支。 */
const PARAMS_REJECTED_BODY = '{"code":11133,"msg":"the request parameters were rejected by the model provider","requestId":"33221fe5-f6d5-4ea1-8882-669411e07a5b","extError":{"code":"invalid_request_error","message":"the request parameters were rejected by the model provider","param":"","type":"invalid_request_error","StatusCode":400,"Request":null,"Response":null},"displayMsg":{"en":"The model cannot handle this request. Please retry","zh":"模型无法处理此请求，请重试"},"displayTips":{"en":"This model does not accept the current conversation. It is not a network issue. Please start a new task, switch models, or try again later.","zh":"这次对话的内容这个模型不接受，与网络无关。请新建任务、换个模型或稍后重试。"},"actions":["SWITCH_MODEL","SUBMIT_FEEDBACK","NEW_CONVERSATION"]}'

/** 推理档位被拒（`extError.param="reasoning_effort"`, `value="off"`）。 */
const OFF_REJECTED_BODY = '{"code":11133,"msg":"the request parameters were rejected by the model provider","requestId":"8f1c0000-0000-4000-8000-000000000001","extError":{"code":"invalid_request_error","message":"reasoning_effort is not supported","param":"reasoning_effort","value":"off","type":"invalid_request_error","StatusCode":400,"Request":null,"Response":null},"displayMsg":{"zh":"模型无法处理此请求，请重试"},"displayTips":{"zh":"这次对话的内容这个模型不接受，与网络无关。请新建任务、换个模型或稍后重试。"},"actions":["SWITCH_MODEL"]}'

/** 上游写给用户看的那句建议（夹具里的中文原文）。 */
const TIPS_ZH = '这次对话的内容这个模型不接受，与网络无关。请新建任务、换个模型或稍后重试。'

describe('parseUpstreamErrorDetail 读信封里给用户看的那部分', () => {
  it('两份真实信封的每个字段都对得上', () => {
    const params = parseUpstreamErrorDetail(PARAMS_REJECTED_BODY)
    expect(params?.upstreamCode).toBe(11133)
    expect(params?.requestId).toBe('33221fe5-f6d5-4ea1-8882-669411e07a5b')
    expect(params?.displayMsg).toBe('模型无法处理此请求，请重试')
    expect(params?.tips).toBe(TIPS_ZH)
    // 空串的 `param` 等于没说：详情报了「参数被拒」却指不出是哪个参数，不如留空。
    expect(params?.rejectedParam).toBeUndefined()

    const off = parseUpstreamErrorDetail(OFF_REJECTED_BODY)
    expect(off?.requestId).toBe('8f1c0000-0000-4000-8000-000000000001')
    expect(off?.rejectedParam).toBe('reasoning_effort')
    expect(off?.rejectedTier).toBe('off')
  })

  it('displayMsg / displayTips 是纯字符串时也认（上游两种形态都出现过）', () => {
    const detail = parseUpstreamErrorDetail(JSON.stringify({
      code: 11133,
      displayMsg: '模型无法处理此请求，请重试',
      displayTips: '换个模型再试。',
    }))
    expect(detail?.displayMsg).toBe('模型无法处理此请求，请重试')
    expect(detail?.tips).toBe('换个模型再试。')
  })

  it('{zh,en} 里只有 en 时回落 en（不能因此丢掉整句建议）', () => {
    const detail = parseUpstreamErrorDetail(JSON.stringify({
      displayTips: { en: 'start a new task' },
    }))
    expect(detail?.tips).toBe('start a new task')
  })

  it('单字段畸形不连累其余字段', () => {
    // code 变成字符串、requestId 是数字：各自丢掉，bad 之外的都要留着。
    const detail = parseUpstreamErrorDetail(JSON.stringify({
      code: '11133',
      requestId: 42,
      msg: 'the request parameters were rejected',
      displayTips: { zh: '换个模型再试。' },
      extError: { param: 'temperature' },
    }))
    expect(detail?.upstreamCode).toBeUndefined()
    expect(detail?.requestId).toBeUndefined()
    expect(detail?.rawMsg).toBe('the request parameters were rejected')
    expect(detail?.tips).toBe('换个模型再试。')
    expect(detail?.rejectedParam).toBe('temperature')
  })

  it('非 JSON / 非对象返回 undefined（调用方据此退回原始 body）', () => {
    expect(parseUpstreamErrorDetail('not json')).toBeUndefined()
    expect(parseUpstreamErrorDetail('[]')).toBeUndefined()
    expect(parseUpstreamErrorDetail('"text"')).toBeUndefined()
    expect(parseUpstreamErrorDetail('null')).toBeUndefined()
  })

  it('extError 不是对象时不当成参数拒绝', () => {
    const detail = parseUpstreamErrorDetail(JSON.stringify({
      code: 11133,
      extError: 'invalid_request_error',
      displayTips: { zh: '换个模型再试。' },
    }))
    expect(detail?.rejectedParam).toBeUndefined()
    expect(detail?.tips).toBe('换个模型再试。')
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
 * 上游替身：喂一份 400 body，回**真实契约**的 `WbChatResult`。
 *
 * `detail` 由真的 `parseUpstreamErrorDetail` 产出，和 `postChat` 里那行赋值同源；
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

function startShim(upstream: () => Promise<WbChatResult>): { shim: WbShim; pool: WbAccountPool; calls: string[] } {
  const pool = new WbAccountPool({})
  pool.applyDiscovery({ accounts: [account('a')], skipped: [] })
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

async function rejectOnce(status: number, body: string): Promise<Reply> {
  const { shim } = startShim(rejectingWith(status, body))
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
  return { ...parsed.error, status: res.status }
}

describe('参数拒绝时用户看到的那句话（真端口）', () => {
  it('上游的中文建议出现在回复里，且不再是裸 JSON 信封', async () => {
    const reply = await rejectOnce(400, PARAMS_REJECTED_BODY)
    expect(reply.status).toBe(400)
    expect(reply.message).toContain(TIPS_ZH)
    // 旧实现贴的就是这几段骨架；它们出现说明又回到了「把 body 前 300 字符直接甩给用户」。
    expect(reply.message).not.toContain('extError')
    expect(reply.message).not.toContain('"requestId"')
    expect(reply.message).not.toContain('displayMsg')
    expect(reply.message).not.toContain('displayTips')
    expect(reply.message.length).toBeLessThan(300)
  })

  it('带 code/requestId 紧凑摘要，且仍是原来的 class 命名（type/code 不被改写）', async () => {
    const reply = await rejectOnce(400, PARAMS_REJECTED_BODY)
    expect(reply.message).toContain('（code 11133，requestId 33221fe5-f6d5-4ea1-8882-669411e07a5b）')
    // 客户端靠 `code` 分支；文案变好不能顺手改了它，否则上层匹配全部失效。
    expect(reply.type).toBe('client')
    expect(reply.code).toBe('client')
  })

  it('通用参数拒绝带「换账号也不会改变结果」那句建议', async () => {
    const reply = await rejectOnce(400, PARAMS_REJECTED_BODY)
    expect(reply.message).toContain('该请求被上游按参数拒绝')
    expect(reply.message).toContain('换账号也不会改变结果')
  })

  it('推理档位拒绝命中专属建议，不落进通用那支', async () => {
    const reply = await rejectOnce(400, OFF_REJECTED_BODY)
    expect(reply.message).toContain('上游拒绝了推理档位「off」')
    // 专属建议必须指向一个**用户真的能做的动作**。adapter 已按拒绝表把 `off` 从选择器
    // 里摘掉，所以走到这里说明请求点名的模型不是选择器展示的那个——能动手的是重新选
    // 模型或换档，而不是去翻一个已经不存在的「可关闭思考」勾选。
    expect(reply.message).toContain('模型选择器')
    expect(reply.message).not.toContain('可关闭思考')
    // 通用那支的句子一旦也出现，说明两支的优先级接反了：用户会去换账号/改历史，
    // 而真正该做的「重新选模型」还在原地。
    expect(reply.message).not.toContain('换账号也不会改变结果')
    expect(reply.message).toContain('（code 11133，requestId 8f1c0000-0000-4000-8000-000000000001）')
    expect(reply.message.length).toBeLessThan(300)
  })

  it('信封里没有人话时退回裁剪后的原始 body，仍是可读句子', async () => {
    const reply = await rejectOnce(400, '{"msg":"bad param"}')
    expect(reply.status).toBe(400)
    // 没有 displayTips/displayMsg，正文只能是原始 body；但摘要仍要出现。
    expect(reply.message).toContain('bad param')
    expect(reply.message).not.toContain('undefined')
  })

  it('上下文超窗仍走原来那支（文案变好不能顶掉更具体的指导）', async () => {
    const reply = await rejectOnce(400, '{"msg":"context_length_exceeded"}')
    expect(reply.status).toBe(400)
    expect(reply.code).toBe('context_length_exceeded')
    expect(reply.message).toContain('上下文窗口放不下')
    // 超窗有自己更具体的行动（减少历史/换大窗口），不该被参数拒绝的通用句盖住。
    expect(reply.message).not.toContain('换账号也不会改变结果')
  })
})
