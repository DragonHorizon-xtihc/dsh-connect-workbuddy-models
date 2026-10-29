/**
 * 「凭据已死」必须由上游说的话决定，不能由我们自己没刷新成功决定。
 *
 * F7 的链条是四环：刷新失败一律 `kind: 'authentication'` → shim 见 authentication 就
 * `markCredentialDead` → 判死之后没有任何恢复路径（`clearCredentialDead` 无人调用，
 * rescan 的 `{ ...kept, account }` 把标记原样保留）→ 一次网络抖动让该账号在本次进程
 * 生命周期内彻底不可用，给用户的文案还写着「上游拒绝了这份登录凭据」。
 *
 * 所以这里分两层测：
 *
 * - **真客户端**（`WbUpstreamClient`，只替身 `globalThis.fetch`）：证明网络异常与
 *   上游拒绝在**返回值**上真的可区分。这一层不能省——它是 F7 的根因所在，替身
 *   客户端永远说不出它会不会带 `retryable`。
 * - **真 shim**（真回环 server + 真 fetch）：证明两种返回值在池里落成**不同**状态，
 *   且可重试那条会自己恢复参选。
 */

import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createWbShim } from '../src/shim.ts'
import type { WbShim } from '../src/shim.ts'
import { WbAccountPool } from '../src/accounts.ts'
import type { WbDiscoveredAccount } from '../src/accounts.ts'
import { WbCatalog } from '../src/catalog.ts'
import { WbUpstreamClient } from '../src/upstream.ts'
import type { WbChatResult, WbCredential } from '../src/upstream.ts'

const DAY = 86_400_000

function account(id: string, overrides: Partial<WbDiscoveredAccount> = {}): WbDiscoveredAccount {
  const now = Date.now()
  return {
    id,
    label: id,
    region: 'cn',
    sourcePath: `/fake/${id}.info`,
    source: 'desktop',
    live: true,
    refreshExpired: false,
    tokenExpiresAtMs: now + 30 * DAY,
    credential: { accessToken: 'tok', refreshToken: 'ref', expiresAtMs: now + 30 * DAY, domain: '' },
    ...overrides,
  }
}

/** 已经过期的凭据：`chatStream` 一进门就会先去刷新，正好落在 F7 的路径上。 */
function expiredCredential(): WbCredential {
  return {
    accessToken: 'stale-token',
    refreshToken: 'refresh-token',
    expiresAtMs: Date.now() - 60_000,
    domain: '',
    sourcePath: '/fake/expired.info',
  }
}

/**
 * 换掉 `globalThis.fetch` 并保证复原。
 *
 * 本仓库的既有测试就用这个办法（`tests/credits.test.ts`），不用 `vi.stubGlobal`：
 * 被测代码调的是全局 `fetch`，这是唯一真正被调用的那个函数。
 */
async function withFetch<T>(impl: () => Promise<Response>, task: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = impl as never
  try {
    return await task()
  } finally {
    globalThis.fetch = original
  }
}

async function failureOf(impl: () => Promise<Response>): Promise<Extract<WbChatResult, { ok: false }>> {
  const client = new WbUpstreamClient()
  const result = await withFetch(impl, async () => await client.chatStream(expiredCredential(), '{}'))
  if (result.ok) throw new Error('预期这次聊天请求失败（刷新没成功）')
  return result
}

// ── 第一层：真客户端把两种失败区分开了吗 ───────────────────────────────────

describe('刷新失败的两种来源在返回值上必须可区分', () => {
  it('网络异常（TypeError: fetch failed）标成可重试', async () => {
    const failure = await failureOf(async () => {
      throw new TypeError('fetch failed')
    })
    expect(failure.kind).toBe('authentication')
    // 关键断言：可重试。没有这一位，shim 只能按 kind 判死。
    expect(failure.retryable).toBe(true)
    // 文案必须说「稍后自动重试」——现在它才名副其实（以前返回值说不可重试）。
    expect(failure.message).toContain('稍后自动重试')
  })

  it('超时（AbortError）同样可重试', async () => {
    const failure = await failureOf(async () => {
      const error = new Error('The operation was aborted due to timeout')
      error.name = 'TimeoutError'
      throw error
    })
    expect(failure.retryable).toBe(true)
  })

  it('上游明确拒绝 refresh token 时**不**可重试，且文案指向重新登录', async () => {
    const failure = await failureOf(async () => await new Response(
      JSON.stringify({ code: 401, msg: 'refresh token invalid', data: null }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    ))
    expect(failure.kind).toBe('authentication')
    // 关键断言：没有 retryable 位（而不是 false——缺省即「不要重试」）。
    expect(failure.retryable).toBe(undefined)
    expect(failure.message).toContain('refresh token 被上游拒绝')
    expect(failure.message).toContain('请重新登录 WorkBuddy 桌面端')
  })

  it('没有 refresh token 时不可重试（重试变不出 token 来）', async () => {
    const client = new WbUpstreamClient()
    const credential: WbCredential = { ...expiredCredential(), refreshToken: '' }
    let calls = 0
    const result = await withFetch(async () => {
      calls += 1
      return await new Response('{}', { status: 200 })
    }, async () => await client.chatStream(credential, '{}'))
    if (result.ok) throw new Error('预期失败')
    expect(result.retryable).toBe(undefined)
    expect(calls).toBe(0)
  })

  it('反向锁：可重试与不可重试的返回值必须不同（相同即 F7 未修）', async () => {
    const network = await failureOf(async () => {
      throw new TypeError('fetch failed')
    })
    const rejected = await failureOf(async () => await new Response(
      JSON.stringify({ code: 401, msg: 'refresh token invalid', data: null }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    ))
    // 两者的 kind 相同（都是「这次请求因为登录态没拿到而失败」），差别只在
    // retryable。所以只比 kind 的测试是测不出 F7 的，必须比 retryable。
    expect(network.kind).toBe(rejected.kind)
    expect(network.retryable).not.toBe(rejected.retryable)
  })
})

// ── 第二层：真 shim 把它落成两种不同的池状态 ───────────────────────────────

let live: WbShim | undefined

afterEach(async () => {
  await live?.close()
  live = undefined
})

/**
 * 起一个真 shim，上游替身按顺序吐出给定的失败/成功。
 *
 * 替身必须返回**真契约**的 `WbChatResult`（判别联合 + 可选的 retryable），否则测的是
 * 替身自己的错。
 */
function startShim(script: readonly (() => WbChatResult)[]): {
  shim: WbShim
  pool: WbAccountPool
  calls: () => number
} {
  const pool = new WbAccountPool({})
  pool.applyDiscovery({ accounts: [account('a')], skipped: [] })
  let index = 0
  const shim = createWbShim({
    pool,
    catalog: new WbCatalog('cn'),
    region: 'cn',
    client: {
      chatStream: async () => {
        const step = script[Math.min(index, script.length - 1)]!
        index += 1
        return step()
      },
      fetchCredits: async () => ({ total: 42, packages: [] }),
    } as never,
  })
  live = shim
  return { shim, pool, calls: () => index }
}

/** 刷新时网络失败后 shim 拿到的结果：kind 仍是 authentication，但标了可重试。 */
function retryableFailure(message = '刷新登录态失败（TypeError: fetch failed），本轮无法自动续期；稍后自动重试，持续失败请重新登录 WorkBuddy 桌面端。'): WbChatResult {
  return { ok: false, status: 401, kind: 'authentication', message, retryable: true }
}

/** 上游明确拒绝：同一个 kind，但没有可重试位。 */
function rejectedFailure(): WbChatResult {
  return {
    ok: false,
    status: 401,
    kind: 'authentication',
    message: 'refresh token 被上游拒绝（refresh token invalid），无法自动续期；请重新登录 WorkBuddy 桌面端。',
  }
}

async function postChat(shim: WbShim): Promise<Response> {
  await shim.ready
  return await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${shim.token()}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  })
}

describe('shim 按「有没有救」而不是按 kind 决定账号命运', () => {
  it('网络抖动：不判死，答复是「都在冷却」而不是「去重新登录」', async () => {
    const { shim, pool, calls } = startShim([retryableFailure])
    const first = await postChat(shim)
    // 池里只有一个账号：它这次没成功，重试环找不到第二个候选，最终答复来自
    // exhaustedReason。**关键**是这条答复把情况说成「冷却」而不是「被拒绝」。
    expect(first.status).toBe(429)
    const body = await first.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('soft_rate')
    expect(body.error.message).toContain('冷却')
    expect(body.error.message).not.toContain('重新登录')
    expect(calls()).toBe(1)

    expect(pool.find('a')?.credentialDead).not.toBe(true)
    expect(pool.exclusionReason(pool.find('a')!)).toBeUndefined()

    // 第二次：仍在冷却 → 一个候选都没有 → 不再打上游（这就是「进入冷却」的可观测证据）。
    const second = await postChat(shim)
    expect(calls()).toBe(1)
    expect(second.status).toBe(429)
    const again = await second.json() as { error: { code: string } }
    expect(again.error.code).toBe('soft_rate')
  })

  it('上游明确拒绝：判死，且 exclusionReason 命中「上游已拒绝」', async () => {
    const { shim, pool, calls } = startShim([rejectedFailure])
    const first = await postChat(shim)
    // 唯一账号被判死 → 重试环找不到可用候选 → exhaustedReason 认出「都被拒了」。
    expect(first.status).toBe(401)
    const body = await first.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('session_dead')
    expect(body.error.message).toContain('都被上游拒绝了登录凭据')
    expect(calls()).toBe(1)

    expect(pool.find('a')?.credentialDead).toBe(true)
    expect(pool.exclusionReason(pool.find('a')!)).toContain('上游已拒绝这份登录凭据')
    expect(pool.exclusionReason(pool.find('a')!)).toContain('重新登录 WorkBuddy 桌面端')
  })

  it('冷却到期后同一账号重新可被 pick（这是判死永远做不到的）', async () => {
    // 让冷却时长可控：冷却端点认「重置时刻」，把 resetAt 放在 150ms 之后。
    // 生产里这个字段来自上游的限流文案；这里用它把 60s 的默认冷却缩到可测。
    const { shim, pool, calls } = startShim([
      () => retryableFailure(`刷新登录态失败（TypeError: fetch failed），稍后自动重试 {"resetAt":${Date.now() + 150}}`),
      () => ({ ok: true, response: new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }) }),
    ])

    const first = await postChat(shim)
    expect(first.status).toBe(429)
    expect(calls()).toBe(1)
    expect(pool.find('a')?.credentialDead).not.toBe(true)

    // 冷却中：跳过。
    expect((await postChat(shim)).status).toBe(429)
    expect(calls()).toBe(1)

    await new Promise(resolve => { setTimeout(resolve, 250) })

    // 冷却到期：同一次进程生命周期内自动回到参选名单，无需重启、无需重新登录。
    const recovered = await postChat(shim)
    expect(recovered.status).toBe(200)
    expect(calls()).toBe(2)
    expect(pool.find('a')?.credentialDead).not.toBe(true)
  })

  it('反向锁：两条路径产生的 credentialDead 状态必须不同（相同即 F7 未修）', async () => {
    const network = startShim([retryableFailure])
    await postChat(network.shim)
    const networkDead = network.pool.find('a')?.credentialDead
    await live?.close()
    live = undefined

    const rejected = startShim([rejectedFailure])
    await postChat(rejected.shim)
    const rejectedDead = rejected.pool.find('a')?.credentialDead

    expect(networkDead).not.toBe(true)
    expect(rejectedDead).toBe(true)
    expect(networkDead).not.toBe(rejectedDead)
  })

  it('未标可重试的 authentication（老形状）仍然判死，行为不倒退', async () => {
    const { shim, pool } = startShim([() => ({
      ok: false,
      status: 401,
      kind: 'authentication',
      message: '上游 401',
    })])
    await postChat(shim)
    expect(pool.find('a')?.credentialDead).toBe(true)
  })

  it('session_dead 也可重试时不判死（kind 不是唯一判据）', async () => {
    const { shim, pool } = startShim([() => ({
      ok: false,
      status: 401,
      kind: 'session_dead',
      message: '刷新登录态失败（边缘层 502 HTML），稍后自动重试',
      retryable: true,
    })])
    await postChat(shim)
    expect(pool.find('a')?.credentialDead).not.toBe(true)
  })

  it('随机会话 id 不参与冷却键（同一账号不同对话共享一次冷却）', async () => {
    // 冷却键是 (accountId, modelId)，与对话无关：否则换一个对话就等于绕过冷却。
    const { shim, pool, calls } = startShim([retryableFailure])
    await shim.ready
    for (const conversation of [randomUUID(), randomUUID()]) {
      const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${shim.token()}`,
          'X-Conversation-Id': conversation,
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      })
      expect(res.status).toBeGreaterThanOrEqual(400)
    }
    expect(calls()).toBe(1)
    expect(pool.find('a')?.credentialDead).not.toBe(true)
  })
})
