/**
 * 登录态自愈（F5）：accessToken 过期后能不能自己续上。
 *
 * ## 为什么这个文件必须存在
 *
 * `WbUpstreamClient.refreshToken()` 从 t2 起就实现了，`refreshHeaders()` 里那行
 * `X-Refresh-Token` 也是照着桌面端的抓包抄的 —— 但**全仓没有一个调用点**。能力
 * 悬空的代码不会报错、不会让任何测试变红，它只会在真机上表现为「本机 4 个账号里
 * 3 个 token 已过期，必须回桌面端重新登录」，而用户以为这就是这个插件的能力边界。
 *
 * 四件互相独立的事在这里被钉住：
 *
 * 1. **谁触发刷新**：已知过期先刷（省一次必然 401 的往返）；未知过期靠 401 触发。
 * 2. **刷几次**：一次请求最多一次。刷完还 401 就是上游真的不行，再刷只是拿一个
 *    已经被拒的 refresh token 反复敲门（refresh 端点有限流）。
 * 3. **刷完落在哪**：内存里那份 `credential` 被原地改写（池与 shim 持同一引用），
 *    同时落盘到 `credential-refresh.json` —— 否则进程重启后又回到过期状态。
 * 4. **重新扫描会不会盖回旧值**：磁盘上的 `.info` / vault `.json` 仍是旧 token
 *    （本插件从不回写桌面端），而 `WbAccountPool.applyDiscovery` 用磁盘内容整体
 *    替换 `account`。不主动覆盖就会出现「刷新成功，过一会儿又全部 401」。
 *
 * 所有用例都把 `$DSH_HOME` 指向临时目录：刷新记录是按 Harness home 落盘的，不隔离
 * 就会往真实的 `~/.dsh` 里写测试数据。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { discoverAccounts } from '../src/accounts.ts'
import {
  credentialRefreshPath,
  loadRefreshedCredentials,
  saveRefreshedCredential,
} from '../src/account-store.ts'
import { PLUGIN_ID } from '../src/status-paths.ts'
import { WbUpstreamClient, workbuddyAccountId } from '../src/upstream.ts'
import type { WbCredential } from '../src/upstream.ts'

const DAY = 86_400_000

/** 一次上游调用的记录。断言「刷了几次」比断言返回值更需要它。 */
interface Call {
  url: string
  authorization: string
  refreshToken: string
}

interface FakeReply {
  status: number
  body: string
}

/**
 * 假上游：按 URL 分派，并把每次调用记进 `calls`。
 *
 * 刻意替换 `globalThis.fetch` 而不是 mock 客户端本身 —— 这里要验的正是
 * `WbUpstreamClient` 自己的编排（先刷后重试、刷几次），客户端被替掉就什么也验不到。
 */
function fakeUpstream(plan: {
  chat: readonly FakeReply[]
  refresh?: readonly FakeReply[]
}): { calls: Call[]; restore(): void } {
  const calls: Call[] = []
  let chatIndex = 0
  let refreshIndex = 0
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      url,
      authorization: headers['Authorization'] ?? '',
      refreshToken: headers['X-Refresh-Token'] ?? '',
    })
    if (url.includes('/v2/plugin/auth/token/refresh')) {
      const queue = plan.refresh ?? []
      const reply = queue[Math.min(refreshIndex, queue.length - 1)] ?? {
        status: 500,
        body: '{"code":500,"msg":"no refresh plan"}',
      }
      refreshIndex += 1
      return new Response(reply.body, {
        status: reply.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const reply = plan.chat[Math.min(chatIndex, plan.chat.length - 1)] ?? {
      status: 500,
      body: '{"msg":"no chat plan"}',
    }
    chatIndex += 1
    return new Response(reply.body, {
      status: reply.status,
      headers: { 'Content-Type': reply.status === 200 ? 'text/event-stream' : 'application/json' },
    })
  }) as typeof fetch
  return {
    calls,
    restore(): void {
      globalThis.fetch = original
    },
  }
}

/** 刷新端点的成功应答。`expiresIn` 是秒，与上游一致。 */
function refreshOk(accessToken: string, refreshToken = 'rotated-refresh', expiresInSec = 3600): FakeReply {
  return {
    status: 200,
    body: JSON.stringify({
      code: 0,
      msg: '',
      data: { accessToken, refreshToken, expiresIn: expiresInSec },
    }),
  }
}

const chatOk: FakeReply = { status: 200, body: 'data: {"choices":[]}\n\n' }
const chatUnauthorized: FakeReply = { status: 401, body: '{"code":401,"msg":"token expired"}' }

function credentialOf(overrides: Partial<WbCredential> = {}): WbCredential {
  return {
    accessToken: 'old-token',
    refreshToken: 'old-refresh',
    // 默认 **已过期**：这个文件的每个用例都在验「过期之后怎么办」，用未来时刻
    // 做默认会让所有用例悄悄变成「本来就没过期」而全绿。
    expiresAtMs: Date.now() - 60_000,
    domain: '',
    sourcePath: '/fake/account.info',
    uin: '900001',
    ...overrides,
  }
}

function countOf(calls: readonly Call[], fragment: string): number {
  return calls.filter(call => call.url.includes(fragment)).length
}

let home: string
let previousHome: string | undefined
let restore: (() => void) | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-refresh-'))
  previousHome = process.env['DSH_HOME']
  process.env['DSH_HOME'] = home
})

afterEach(async () => {
  restore?.()
  restore = undefined
  if (previousHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousHome
  await rm(home, { recursive: true, force: true })
})

describe('已知过期：先换 token 再发请求', () => {
  it('一次刷新后带着新 token 发出唯一一次聊天请求', async () => {
    const fake = fakeUpstream({ chat: [chatOk], refresh: [refreshOk('new-token')] })
    restore = fake.restore
    const credential = credentialOf()
    const client = new WbUpstreamClient()

    const result = await client.chatStream(credential, '{}')

    expect(result.ok).toBe(true)
    // 恰好两次上游调用：先 refresh，再 chat —— 没有那次注定 401 的往返。
    expect(fake.calls.map(call => call.url.includes('/token/refresh') ? 'refresh' : 'chat')).toEqual([
      'refresh',
      'chat',
    ])
    expect(fake.calls[1]?.authorization).toBe('Bearer new-token')
  })

  it('刷新结果原地写回凭据，池与 shim 手里的同一份引用都看得见', () => {
    // 只验 mutate 的语义：`chatStream` 之后 credential 对象的字段变了，而不是
    // 返回了一个新对象。池条目与 shim 的候选行持的都是同一个引用，换对象只让
    // 这一次请求生效、下一次调用又回到旧的那份。
    const credential = credentialOf()
    const fake = fakeUpstream({ chat: [chatOk], refresh: [refreshOk('new-token', 'rotated', 7200)] })
    restore = fake.restore
    const client = new WbUpstreamClient()
    return client.chatStream(credential, '{}').then(() => {
      expect(credential.accessToken).toBe('new-token')
      expect(credential.refreshToken).toBe('rotated')
      expect(credential.expiresAtMs).toBeGreaterThan(Date.now())
      expect(credential.lastRefreshAtMs).toBeGreaterThan(0)
    })
  })

  it('上游没给 expiresIn 时到期时刻记 0（未知），不编造一个时刻', async () => {
    const fake = fakeUpstream({
      chat: [chatOk],
      refresh: [{
        status: 200,
        body: JSON.stringify({ code: 0, msg: '', data: { accessToken: 'new-token' } }),
      }],
    })
    restore = fake.restore
    const credential = credentialOf()
    const client = new WbUpstreamClient()

    await client.chatStream(credential, '{}')

    // 0 = 「文件没写/上游没说」。下一次靠真实的 401 触发刷新，而不是靠一个
    // 猜出来的时刻——猜早了会白白刷新，猜晚了等于没设。
    expect(credential.expiresAtMs).toBe(0)
  })
})

describe('未知过期：401 之后刷新并重试一次', () => {
  it('401 → 刷新 → 重试成功，三次调用不多不少', async () => {
    const fake = fakeUpstream({
      chat: [chatUnauthorized, chatOk],
      refresh: [refreshOk('new-token')],
    })
    restore = fake.restore
    const credential = credentialOf({ expiresAtMs: Date.now() + 30 * DAY })
    const client = new WbUpstreamClient()

    const result = await client.chatStream(credential, '{}')

    expect(result.ok).toBe(true)
    expect(fake.calls).toHaveLength(3)
    expect(countOf(fake.calls, '/v2/chat/completions')).toBe(2)
    expect(countOf(fake.calls, '/token/refresh')).toBe(1)
    // 第一次带旧 token、第三次带新 token —— 证明重试真的换了凭据。
    expect(fake.calls[0]?.authorization).toBe('Bearer old-token')
    expect(fake.calls[2]?.authorization).toBe('Bearer new-token')
  })

  it('session_dead 也触发刷新（业务码说登录态失效，不只是 401）', async () => {
    const fake = fakeUpstream({
      // 400 + 「session expired」正文：`classifyUpstreamError` 归成 session_dead。
      // 它不是 401/403，所以走不到 `envelopeError` 那条凭据拒绝分支 —— 这条用例
      // 钉的正是「刷新触发点认的是分类结果，不是状态码」。
      chat: [{ status: 400, body: '{"code":400,"msg":"session expired"}' }, chatOk],
      refresh: [refreshOk('new-token')],
    })
    restore = fake.restore
    const credential = credentialOf({ expiresAtMs: Date.now() + 30 * DAY })
    const client = new WbUpstreamClient()

    const result = await client.chatStream(credential, '{}')

    expect(result.ok).toBe(true)
    expect(countOf(fake.calls, '/token/refresh')).toBe(1)
    expect(fake.calls[2]?.authorization).toBe('Bearer new-token')
  })

  it('200 的正常回答不会触发刷新', async () => {
    const fake = fakeUpstream({ chat: [chatOk], refresh: [refreshOk('new-token')] })
    restore = fake.restore
    const credential = credentialOf({ expiresAtMs: Date.now() + 30 * DAY })
    const client = new WbUpstreamClient()

    const result = await client.chatStream(credential, '{}')

    expect(result.ok).toBe(true)
    expect(countOf(fake.calls, '/token/refresh')).toBe(0)
    expect(fake.calls).toHaveLength(1)
  })

  it('刷新后仍然 401：直接失败返回，不再刷第二次', async () => {
    const fake = fakeUpstream({
      chat: [chatUnauthorized, chatUnauthorized],
      refresh: [refreshOk('new-token')],
    })
    restore = fake.restore
    const credential = credentialOf({ expiresAtMs: Date.now() + 30 * DAY })
    const client = new WbUpstreamClient()

    const result = await client.chatStream(credential, '{}')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('authentication')
    // 关键断言：refresh 端点只被敲了 1 次。用已经被拒的 refresh token 反复敲门
    // 会让上游把整个插件的刷新频次配额烧光。
    expect(countOf(fake.calls, '/token/refresh')).toBe(1)
    expect(fake.calls).toHaveLength(3)
  })

  it('hard_credit / soft_rate 这类失败不触发刷新', async () => {
    const fake = fakeUpstream({
      chat: [{ status: 402, body: '{"msg":"14018 Credits exhausted"}' }],
      refresh: [refreshOk('new-token')],
    })
    restore = fake.restore
    const credential = credentialOf({ expiresAtMs: Date.now() + 30 * DAY })
    const client = new WbUpstreamClient()

    const result = await client.chatStream(credential, '{}')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('hard_credit')
    // 没钱和没登录是两件事：换 token 不会变出积分。
    expect(countOf(fake.calls, '/token/refresh')).toBe(0)
  })

  it('传输失败（status 0）不当成凭据问题去刷新', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('ECONNRESET')
    }) as typeof fetch
    try {
      const credential = credentialOf({ expiresAtMs: Date.now() + 30 * DAY })
      const client = new WbUpstreamClient()
      const result = await client.chatStream(credential, '{}')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.kind).toBe('server')
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('刷新失败时给一句能执行的话', () => {
  it('refresh token 被上游拒绝 → 文案指向回桌面端重新登录', async () => {
    const fake = fakeUpstream({
      chat: [chatUnauthorized],
      refresh: [{ status: 401, body: '{"code":401,"msg":"refresh token revoked"}' }],
    })
    restore = fake.restore
    const credential = credentialOf({ expiresAtMs: Date.now() + 30 * DAY })
    const client = new WbUpstreamClient()

    const result = await client.chatStream(credential, '{}')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('authentication')
      expect(result.message).toContain('重新登录 WorkBuddy 桌面端')
      expect(result.message).toContain('refresh token 被上游拒绝')
    }
    // chat 一次 + refresh 一次，没有第三次：被拒的 refresh token 不会因为再敲
    // 一次就变成可用。
    expect(fake.calls).toHaveLength(2)
  })

  it('网络层失败（非鉴权）→ 文案说稍后重试，不把人赶去重新登录', async () => {
    const fake = fakeUpstream({
      chat: [chatUnauthorized],
      refresh: [{ status: 502, body: '<html>openresty 502</html>' }],
    })
    restore = fake.restore
    const credential = credentialOf({ expiresAtMs: Date.now() + 30 * DAY })
    const client = new WbUpstreamClient()

    const result = await client.chatStream(credential, '{}')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('稍后自动重试')
      expect(result.message).toContain('刷新登录态失败')
    }
  })

  it('refreshToken 是空串时直接判需重登，一次上游都不打', async () => {
    // 加密信封解不开时 refreshToken 落成空串（见 accounts.ts 的 fieldOf）。
    // 拿空串去敲上游只会换回一个 401，还会在日志里伪装成「上游拒绝了我们」。
    const fake = fakeUpstream({ chat: [chatUnauthorized], refresh: [refreshOk('new-token')] })
    restore = fake.restore
    const credential = credentialOf({ refreshToken: '' })
    const client = new WbUpstreamClient()

    const result = await client.chatStream(credential, '{}')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('没有 refresh token')
    expect(fake.calls).toHaveLength(0)
  })

  it('refresh token 的窗口已关闭时直接判需重登，一次上游都不打', async () => {
    const fake = fakeUpstream({ chat: [chatUnauthorized], refresh: [refreshOk('new-token')] })
    restore = fake.restore
    const credential = credentialOf({ refreshExpiresAtMs: Date.now() - DAY })
    const client = new WbUpstreamClient()

    const result = await client.chatStream(credential, '{}')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('失效')
      expect(result.message).toContain('重新登录 WorkBuddy 桌面端')
    }
    expect(fake.calls).toHaveLength(0)
  })
})

describe('刷新结果落盘，重启后仍可用', () => {
  it('刷新后的 token 写进 credential-refresh.json（挂在 Harness home 下）', async () => {
    const fake = fakeUpstream({ chat: [chatOk], refresh: [refreshOk('new-token', 'rotated', 7200)] })
    restore = fake.restore
    const credential = credentialOf()
    const client = new WbUpstreamClient()
    await client.chatStream(credential, '{}')

    expect(credentialRefreshPath(PLUGIN_ID).startsWith(home)).toBe(true)
    const store = await loadRefreshedCredentials(PLUGIN_ID)
    const entry = store[workbuddyAccountId(credential)]
    expect(entry?.accessToken).toBe('new-token')
    expect(entry?.refreshToken).toBe('rotated')
    expect(entry?.expiresAtMs).toBeGreaterThan(Date.now())
  })

  it('读不回来时不抛错（坏文件不能让插件起不来）', async () => {
    const path = credentialRefreshPath(PLUGIN_ID)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, 'not json at all', 'utf8')
    await expect(loadRefreshedCredentials(PLUGIN_ID)).resolves.toEqual({})
  })

  it('并发保存两个账号不会互相覆盖', async () => {
    await Promise.all([
      saveRefreshedCredential(PLUGIN_ID, 'acc-a', {
        accessToken: 'a-token',
        expiresAtMs: Date.now() + DAY,
        refreshedAtMs: Date.now(),
      }),
      saveRefreshedCredential(PLUGIN_ID, 'acc-b', {
        accessToken: 'b-token',
        expiresAtMs: Date.now() + DAY,
        refreshedAtMs: Date.now(),
      }),
    ])
    const store = await loadRefreshedCredentials(PLUGIN_ID)
    expect(store['acc-a']?.accessToken).toBe('a-token')
    expect(store['acc-b']?.accessToken).toBe('b-token')
  })
})

describe('重新扫描不得把刷新成果盖回旧 token', () => {
  /** 桌面端形状的明文快照。`lastRefreshTime` 是秒，与本文件其他用例同一口径。 */
  function authDocument(overrides: {
    uin: string
    accessToken: string
    expiresAtMs: number
    lastRefreshTimeMs: number
  }): string {
    return JSON.stringify({
      auth: {
        accessToken: overrides.accessToken,
        refreshToken: 'disk-refresh',
        expiresAt: Math.floor(overrides.expiresAtMs / 1000),
        refreshExpiresAt: Math.floor((Date.now() + 90 * DAY) / 1000),
        lastRefreshTime: Math.floor(overrides.lastRefreshTimeMs / 1000),
        domain: '',
      },
      account: { uin: overrides.uin, uid: `uid-${overrides.uin}`, nickname: `账号${overrides.uin}` },
    })
  }

  it('磁盘上是过期旧 token、本插件刷新过 → 用刷新后的凭据', async () => {
    const dir = join(home, 'auth')
    await mkdir(dir, { recursive: true })
    const issuedAtMs = Date.now() - 2 * DAY
    await writeFile(
      join(dir, 'stale.info'),
      authDocument({
        uin: '900002',
        accessToken: 'disk-old-token',
        expiresAtMs: Date.now() - DAY,
        lastRefreshTimeMs: issuedAtMs,
      }),
      'utf8',
    )
    // 本插件在这之后刷新过（refreshedAtMs 更晚），记录里的 token 还没过期。
    const id = workbuddyAccountId({ uin: '900002' })
    await saveRefreshedCredential(PLUGIN_ID, id, {
      accessToken: 'refreshed-token',
      refreshToken: 'rotated-refresh',
      expiresAtMs: Date.now() + 3 * DAY,
      refreshedAtMs: Date.now(),
    })

    const result = await discoverAccounts({ authDirs: [dir] })

    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]?.credential.accessToken).toBe('refreshed-token')
    expect(result.accounts[0]?.credential.refreshToken).toBe('rotated-refresh')
    // 派生字段必须跟着走，否则选号会按旧 token 的到期时刻排。
    expect(result.accounts[0]?.tokenExpiresAtMs).toBeGreaterThan(Date.now())
    expect(result.accounts[0]?.tokenExpiresAtMs).toBe(result.accounts[0]?.credential.expiresAtMs)
  })

  it('用户在桌面端重新登录过（磁盘的 lastRefreshTime 更晚）→ 用磁盘的新 token', async () => {
    const dir = join(home, 'auth')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'fresh.info'),
      authDocument({
        uin: '900003',
        accessToken: 'desktop-new-token',
        expiresAtMs: Date.now() + 30 * DAY,
        lastRefreshTimeMs: Date.now(),
      }),
      'utf8',
    )
    // 记录比用户这次登录**更早**：用户的操作必须赢，否则换了账号还在用旧 token。
    const id = workbuddyAccountId({ uin: '900003' })
    await saveRefreshedCredential(PLUGIN_ID, id, {
      accessToken: 'plugin-old-refresh',
      expiresAtMs: Date.now() + DAY,
      refreshedAtMs: Date.now() - 2 * DAY,
    })

    const result = await discoverAccounts({ authDirs: [dir] })

    expect(result.accounts[0]?.credential.accessToken).toBe('desktop-new-token')
  })

  it('记录里的 token 已过期、磁盘那份还没过期 → 用磁盘的', async () => {
    const dir = join(home, 'auth')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'usable.info'),
      authDocument({
        uin: '900004',
        accessToken: 'disk-usable',
        expiresAtMs: Date.now() + 10 * DAY,
        lastRefreshTimeMs: Date.now() - 5 * DAY,
      }),
      'utf8',
    )
    const id = workbuddyAccountId({ uin: '900004' })
    await saveRefreshedCredential(PLUGIN_ID, id, {
      accessToken: 'recorded-but-expired',
      expiresAtMs: Date.now() - DAY,
      refreshedAtMs: Date.now() - DAY,
    })

    const result = await discoverAccounts({ authDirs: [dir] })

    expect(result.accounts[0]?.credential.accessToken).toBe('disk-usable')
  })

  it('没有刷新记录时，扫描结果与改前完全一致', async () => {
    const dir = join(home, 'auth')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'plain.info'),
      authDocument({
        uin: '900005',
        accessToken: 'disk-only',
        expiresAtMs: Date.now() + 20 * DAY,
        lastRefreshTimeMs: Date.now() - DAY,
      }),
      'utf8',
    )

    const result = await discoverAccounts({ authDirs: [dir] })

    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]?.credential.accessToken).toBe('disk-only')
    expect(result.accounts[0]?.credential.refreshToken).toBe('disk-refresh')
  })
})
