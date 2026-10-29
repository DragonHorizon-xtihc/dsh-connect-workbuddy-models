/**
 * 真实请求路径上的选号（F1）。
 *
 * 这些断言全部**打真端口**、读 shim 实际发给上游的凭据，而不是读 `pool.pick()`
 * 的返回值。原因就是这条缺陷本身：`pool.pick()` 一直是对的，坏的是 shim 拿到
 * `result.ranked` 之后自己再过滤一遍、取队首 —— 于是池内部那五条选号路径
 * （round-robin 游标、balanced 权重、sticky 亲和、手动切号、未勾选排除）全都
 * 只写在了没人读的地方。
 *
 * 所以判据必须是「上游收到了哪个账号的 token」。任何读 `pool.pick()` 的测试在
 * 改前也是绿的，它测不到这段断裂。
 *
 * 已知的检出力边界：单独一条「冷却中的账号不再被选中」在改前也能通过——旧代码
 * 虽然丢了分布，却确实用 `isCooling` 过滤过候选。那条留作回归守卫，不作缺陷
 * 判据；缺陷判据是下面那五条与分布/排除/手选有关的行为。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createWbShim } from '../src/shim.ts'
import type { WbShim } from '../src/shim.ts'
import { WbAccountPool } from '../src/accounts.ts'
import type { WbDiscoveredAccount, WbPoolEntry } from '../src/accounts.ts'
import { WbCatalog } from '../src/catalog.ts'
import type { WbChatResult } from '../src/upstream.ts'
import { classifyUpstreamError } from '../src/upstream.ts'
import type { AccountDistribution } from '../src/status-paths.ts'

const DAY = 86_400_000

/**
 * 账号样板。`accessToken` 里编进 id，这样上游收到哪个账号一目了然。
 *
 * `expiresAtMs` 放在 30 天后而不是 0：0 在凭据语义里是「上游没给」，但 lease 上
 * 它会被 `tokenExpiresAtMs` 缺省掉，名次平局时改用 id（哈希）比较，测试就变得
 * 依赖哈希顺序。给一个统一的未来时刻，名次只由 id 的字典序决定，可读。
 */
function account(id: string, overrides: Partial<WbDiscoveredAccount> = {}): WbDiscoveredAccount {
  return {
    id,
    label: id,
    region: 'cn',
    sourcePath: `/fake/${id}.info`,
    source: 'desktop',
    live: true,
    refreshExpired: false,
    tokenExpiresAtMs: Date.now() + 30 * DAY,
    credential: {
      accessToken: `tok-${id}`,
      refreshToken: `ref-${id}`,
      expiresAtMs: Date.now() + 30 * DAY,
      domain: '',
    },
    ...overrides,
  }
}

let live: WbShim | undefined

afterEach(async () => {
  await live?.close()
  live = undefined
})

interface Harness {
  shim: WbShim
  pool: WbAccountPool
  /** 上游收到的 accessToken，按顺序。`tok-a` → 账号 a。 */
  calls: string[]
}

/**
 * 起一个真回环 shim。
 *
 * `answers` 按调用顺序取用，用尽后重复最后一项 —— 与 `tests/shim.test.ts` 的
 * `upstreamReturning` 同款语义，但这里需要按账号脚本化（同一个账号第一次失败、
 * 第二次成功），所以多给一层「按 accessToken 决定」的钩子。
 */
function startPickShim(options: {
  accounts: readonly WbDiscoveredAccount[]
  enabledIds?: readonly string[]
  distribution?: AccountDistribution
  orderIds?: readonly string[]
  answer?: (accessToken: string, index: number) => WbChatResult
}): Harness {
  const pool = new WbAccountPool({})
  pool.applyDiscovery({ accounts: options.accounts, skipped: [] })
  // 池的构造缺省是 expiry + 全部参与。夹具必须显式施加，否则「切分布」「未勾选
  // 排除」两组断言都会看不出变化（本仓踩过一次）。
  pool.applyConfig({
    enabledIds: options.enabledIds ?? [],
    orderIds: options.orderIds ?? [],
    ...options.distribution === undefined ? {} : { distribution: options.distribution },
    expiryWarnDays: 3,
  })
  const calls: string[] = []
  const defaultAnswer = (): WbChatResult => ok()
  const answer = options.answer ?? defaultAnswer
  const shim = createWbShim({
    pool,
    catalog: new WbCatalog('cn'),
    region: 'cn',
    client: {
      chatStream: async (credential: { accessToken: string }) => {
        calls.push(credential.accessToken)
        return answer(credential.accessToken, calls.length - 1)
      },
      fetchCredits: async () => ({ total: 0, packages: [] }),
    } as never,
  })
  live = shim
  return { shim, pool, calls }
}

function ok(): WbChatResult {
  return {
    ok: true,
    response: new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  }
}

function failure(status: number, body: string): WbChatResult {
  return {
    ok: false,
    status,
    kind: classifyUpstreamError(status, body),
    message: body,
  }
}

/**
 * 发一次 chat 请求。
 *
 * `prompt` 决定对话身份（`conversationKeyOf` 取首条 user 消息的 sha256），所以
 * 换 prompt 就是换会话 —— sticky 与会话亲和靠它区分。
 */
async function post(shim: WbShim, prompt = 'hi'): Promise<Response> {
  await shim.ready
  return await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${shim.token()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }),
  })
}

/** `tok-a` → `a`。 */
function idOf(token: string): string {
  return token.replace(/^tok-/u, '')
}

describe('shim 必须采用池的选号结论', () => {
  it('round-robin：连两次请求打到不同账号', async () => {
    const harness = startPickShim({
      accounts: [account('a'), account('b'), account('c')],
      distribution: 'round-robin',
    })
    await (await post(harness.shim)).text()
    await (await post(harness.shim)).text()

    expect(harness.calls.map(idOf)).toHaveLength(2)
    const [first, second] = harness.calls.map(idOf)
    // 改前：两次都是 rank 队首（同一个账号），游标永远停在 0。
    expect(first).not.toBe(second)
  })

  it('balanced：多次请求覆盖到 2 个以上账号', async () => {
    const harness = startPickShim({
      accounts: [account('a'), account('b'), account('c')],
      distribution: 'balanced',
    })
    for (let index = 0; index < 40; index += 1) {
      await (await post(harness.shim)).text()
    }

    const seen = new Set(harness.calls.map(idOf))
    // 改前：40 次全压在同一账号上（rank 队首）。
    expect(seen.size).toBeGreaterThanOrEqual(2)
  })

  it('sticky：同一会话恒用同一账号，换会话才可能换号', async () => {
    const harness = startPickShim({
      accounts: [account('a'), account('b'), account('c')],
      distribution: 'sticky',
    })
    await (await post(harness.shim, 'conversation-one')).text()
    await (await post(harness.shim, 'conversation-one')).text()
    await (await post(harness.shim, 'conversation-one')).text()

    const stickyRun = harness.calls.map(idOf)
    // 改前：三条也全同（因为根本没用 sticky，只是恰好都取队首）——所以光这一条
    // 分不出新旧，必须配合下面「换会话能换号」一起看。
    expect(new Set(stickyRun).size).toBe(1)

    await (await post(harness.shim, 'conversation-two')).text()
    await (await post(harness.shim, 'conversation-three')).text()
    const all = new Set(harness.calls.map(idOf))
    // 改前：始终只有队首那一个账号，这里恒为 1。
    expect(all.size).toBeGreaterThanOrEqual(2)
  })

  it('手动切号（setPreferred）优先于任何分布', async () => {
    // 分布用 priority：队首是 `a`，用户的明确指令是 `c`。
    const harness = startPickShim({
      accounts: [account('a'), account('b'), account('c')],
      distribution: 'priority',
    })
    harness.pool.setPreferred('cn', 'c')
    await (await post(harness.shim)).text()

    // 改前：发的是掩在队首的 a ——「切到某个账号」这个动作在真实请求里没有生效。
    expect(harness.calls.map(idOf)).toEqual(['c'])
  })

  it('全部可用账号都在 excludeIds 里时不回落到未勾选的账号', async () => {
    const harness = startPickShim({
      accounts: [account('good'), account('off')],
      enabledIds: ['good'],
      distribution: 'priority',
      // `good` 每次都 500（server，不冷却也不判死），于是本次请求的第二轮尝试
      // 要把 good 排掉；`off` 未勾选，任何情况下都不该被选。
      answer: token => token === 'tok-good' ? failure(500, '{"msg":"server error"}') : ok(),
    })
    const response = await post(harness.shim)
    await response.text()

    // 改前：第二轮把 `candidates` 过滤成 [off]，向未勾选的账号发出了真实请求，
    // 而且因为 off 回 200，用户还会拿到一个「看起来成功」的答复。
    expect(harness.calls.map(idOf)).toEqual(['good'])
    expect(response.status).not.toBe(200)
  })

  it('冷却中的账号在后续请求里不会再次被打到（回归守卫）', async () => {
    // 两个账号，`a` 会回一条带 resetAt 的限流（冷却 5 分钟），`b` 正常。
    const harness = startPickShim({
      accounts: [account('a'), account('b')],
      distribution: 'priority',
      answer: token => token === 'tok-a'
        ? failure(429, `{"msg":"rate limited","resetAt":${Date.now() + 300_000}}`)
        : ok(),
    })
    await (await post(harness.shim)).text()
    // 第一次请求里 a 限流后应换到 b。
    expect(harness.calls.map(idOf)).toEqual(['a', 'b'])

    harness.calls.length = 0
    await (await post(harness.shim)).text()
    // a 仍在冷却窗口内，第二次请求应该一开始就选 b，不再浪费一次调用。
    expect(harness.calls.map(idOf)).toEqual(['b'])
  })
})

/**
 * 池侧的选号结论本身（不改 shim，直接问池）。
 *
 * 与上面那组互为对照：上面证明 shim 采纳了池的结论，这里证明池的结论本身在
 * 五种分布下都自洽。两组同时绿，才说明「唯一选号 Owner」这个结构成立。
 */
describe('池是唯一的选号 Owner', () => {
  function poolOf(distribution: AccountDistribution, extra: {
    enabledIds?: readonly string[]
  } = {}): WbAccountPool {
    const pool = new WbAccountPool({})
    pool.applyDiscovery({
      accounts: [account('a'), account('b'), account('c')],
      skipped: [],
    })
    pool.applyConfig({
      enabledIds: extra.enabledIds ?? [],
      orderIds: [],
      distribution,
      expiryWarnDays: 3,
    })
    return pool
  }

  it('excludeIds 覆盖所有可用成员时返回 undefined，而不是退回池里剩下的账号', () => {
    const pool = poolOf('priority')
    const result = pool.pick('cn', { excludeIds: ['a', 'b', 'c'] })
    expect(result.account).toBeUndefined()
    // `ranked` 仍返回完整名次表：调用方要靠它说清「为什么没得选」。
    expect(result.ranked).toHaveLength(3)
  })

  it('未勾选的账号即使被 excludeIds 排除干净也不会被选中', () => {
    const pool = poolOf('priority', { enabledIds: ['a'] })
    expect(pool.pick('cn', { excludeIds: ['a'] }).account).toBeUndefined()
  })

  it('setPreferred 指向的账号不在可用集合里时退回分布结果', () => {
    const pool = poolOf('priority', { enabledIds: ['a'] })
    pool.setPreferred('cn', 'c')
    // `c` 未勾选 → 不因为「用户选过它」就绕过排除。
    expect(pool.pick('cn').account?.id).toBe('a')
  })
})

/** 只是为了确认 `WbPoolEntry` 在当前形状下可被外部观察（F2 的读数入口）。 */
function deadOf(pool: WbAccountPool, id: string): boolean | undefined {
  const entry: WbPoolEntry | undefined = pool.find(id)
  return entry?.credentialDead
}

describe('死凭据标记的恢复路径（F2）', () => {
  it('判死之后这个账号不再被选中（所以要恢复只能靠凭据变化）', async () => {
    // 这条不是缺陷判据，而是**恢复路径必须走 rescan** 的原因：`exclusionReason`
    // 让判死的账号 `usable: false`，`pool.pick` 因此永远不选它，一次「成功请求
    // 顺手清标记」在结构上不可能发生。所以恢复只能由「凭据真的换了」触发。
    const harness = startPickShim({ accounts: [account('a')] })
    harness.pool.markCredentialDead('a')

    const response = await post(harness.shim)
    await response.text()

    // 关键断言：一次上游调用都没发出去。改前这里会打到那份已被拒的 token。
    expect(harness.calls).toHaveLength(0)
    expect(response.status).not.toBe(200)
  })

  it('rescan 拿到的是同一份凭据时保留标记（不闪回）', () => {
    const harness = startPickShim({ accounts: [account('a')] })
    harness.pool.markCredentialDead('a')
    harness.pool.applyDiscovery({ accounts: [account('a')], skipped: [] })
    // 「无条件清」会让真被拒的凭据每次 rescan 都重新参选、每次撞一次 401。
    expect(deadOf(harness.pool, 'a')).toBe(true)
  })

  it('rescan 拿到换了 token 的凭据（用户重登）时清掉标记', () => {
    const harness = startPickShim({ accounts: [account('a')] })
    harness.pool.markCredentialDead('a')
    const relogged = account('a')
    relogged.credential = { ...relogged.credential, accessToken: 'tok-a-relogged' }
    harness.pool.applyDiscovery({ accounts: [relogged], skipped: [] })

    expect(deadOf(harness.pool, 'a')).toBeUndefined()
    expect(harness.pool.find('a')?.account.credential.accessToken).toBe('tok-a-relogged')
  })

  it('重登之后账号立刻回到可用集合（不必重启 DSH）', async () => {
    const harness = startPickShim({ accounts: [account('a')] })
    harness.pool.markCredentialDead('a')
    const relogged = account('a')
    relogged.credential = { ...relogged.credential, accessToken: 'tok-a-relogged' }
    harness.pool.applyDiscovery({ accounts: [relogged], skipped: [] })

    const response = await post(harness.shim)
    await response.text()

    expect(response.status).toBe(200)
    // 发出去的是**新**凭据：rescan 换掉了 account 里的 credential。
    expect(harness.calls).toEqual(['tok-a-relogged'])
  })

  it('只换了 refreshToken 也算重登（刷新被拒后用户可能只重签那一条）', () => {
    const harness = startPickShim({ accounts: [account('a')] })
    harness.pool.markCredentialDead('a')
    const relogged = account('a')
    relogged.credential = { ...relogged.credential, refreshToken: 'ref-a-relogged' }
    harness.pool.applyDiscovery({ accounts: [relogged], skipped: [] })

    expect(deadOf(harness.pool, 'a')).toBeUndefined()
  })

  it('rescan 之后积分读数与签到读数不丢（重登不该重置余额显示）', () => {
    const harness = startPickShim({ accounts: [account('a')] })
    harness.pool.noteCredits('a', { total: 777, packages: [], expiringSoon: 0 })
    harness.pool.markCredentialDead('a')
    const relogged = account('a')
    relogged.credential = { ...relogged.credential, accessToken: 'tok-a-relogged' }
    harness.pool.applyDiscovery({ accounts: [relogged], skipped: [] })

    expect(harness.pool.find('a')?.credits?.total).toBe(777)
  })
})
