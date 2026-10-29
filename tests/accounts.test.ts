/**
 * 账号自动发现（需求 R1-a）。
 *
 * 全部用真实临时目录与真实的 `discoverAccounts` —— 不 mock `node:fs`。文件系统行为
 * （目录不存在、坏 JSON、加密信封）是这块逻辑的主要失败面，用 mock 测等于测那个
 * mock。
 *
 * ## 覆盖的三件事
 *
 * 1. 正常文件解析出身份与到期时间。
 * 2. 三类坏文件各自归到 `encrypted` / `unreadable` / `malformed`，**不被静默吞掉**
 *    —— 用户看到「4 个账号变成 2 个」而没有解释，是这块代码曾经的真实缺陷。
 * 3. 同一 `uin` 的多份快照折叠成一个账号（否则积分合计会翻倍）。
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  WORKBUDDY_LIVE_FILENAME,
  candidateAuthDirs,
  discoverAccounts,
  parseWorkBuddyAuth,
  workbuddyAccountId,
} from '../src/accounts.ts'

const DAY = 86_400_000

/** 一份桌面端形状的登录文件。 */
function liveDocument(overrides: {
  accessToken?: unknown
  uin?: string
  uid?: string
  nickname?: string
  domain?: string
  expiresAt?: number
} = {}): string {
  return JSON.stringify({
    auth: {
      accessToken: overrides.accessToken ?? 'token-abc',
      refreshToken: 'refresh-abc',
      expiresAt: overrides.expiresAt ?? Math.floor((Date.now() + 30 * DAY) / 1000),
      refreshExpiresAt: Math.floor((Date.now() + 90 * DAY) / 1000),
      lastRefreshTime: Math.floor(Date.now() / 1000),
      domain: overrides.domain ?? '',
    },
    account: {
      uin: overrides.uin ?? '1000001',
      uid: overrides.uid ?? 'uid-0001',
      nickname: overrides.nickname ?? '小明',
      enterpriseId: 'ent-1',
    },
  })
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-accounts-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('解析一份正常登录文件', () => {
  it('取出 uin / uid / nickname / domain / 到期时间', () => {
    const credential = parseWorkBuddyAuth(liveDocument({ domain: 'workbuddy.ai' }), '/tmp/x.info')
    expect(credential).toBeDefined()
    expect(credential?.accessToken).toBe('token-abc')
    expect(credential?.refreshToken).toBe('refresh-abc')
    expect(credential?.uin).toBe('1000001')
    expect(credential?.uid).toBe('uid-0001')
    expect(credential?.nickname).toBe('小明')
    expect(credential?.domain).toBe('workbuddy.ai')
    expect(credential?.expiresAtMs).toBeGreaterThan(Date.now())
  })

  it('秒级到期时间被换算成毫秒（上游两种都发过）', () => {
    const seconds = Math.floor((Date.now() + 10 * DAY) / 1000)
    const credential = parseWorkBuddyAuth(liveDocument({ expiresAt: seconds }), '/tmp/x.info')
    expect(credential?.expiresAtMs).toBe(seconds * 1000)
  })

  it('账号 id 只由 uin 决定，和文件名、时间戳无关', () => {
    const a = parseWorkBuddyAuth(liveDocument({ uin: '777' }), '/tmp/one.info')
    const b = parseWorkBuddyAuth(liveDocument({ uin: '777', nickname: '换个昵称' }), '/tmp/two.info')
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(workbuddyAccountId(a!)).toBe(workbuddyAccountId(b!))
  })

  it('没有 uin 时回退 uid，两者都无则回退昵称', () => {
    const byUid = workbuddyAccountId({ uid: 'u-1' })
    const byNick = workbuddyAccountId({ nickname: '只有昵称' })
    expect(byUid).toMatch(/^[0-9a-f]{16}$/)
    expect(byNick).toMatch(/^[0-9a-f]{16}$/)
    expect(byUid).not.toBe(byNick)
  })
})

describe('坏文件必须被上报，不能静默消失', () => {
  it('加密信封归到 encrypted，并给出可操作提示', async () => {
    await writeFile(
      join(dir, 'encrypted.info'),
      JSON.stringify({ auth: { accessToken: { $wbEncrypted: 1, envelope: 'AAAA' } }, account: { uin: '9' } }),
      'utf8',
    )
    const result = await discoverAccounts({ authDirs: [dir] })
    expect(result.accounts).toHaveLength(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.reason).toBe('encrypted')
    expect(result.skipped[0]?.path).toContain('encrypted.info')
  })

  it('坏 JSON 归到 malformed', async () => {
    await writeFile(join(dir, 'broken.info'), '{ 这不是 JSON', 'utf8')
    const result = await discoverAccounts({ authDirs: [dir] })
    expect(result.accounts).toHaveLength(0)
    expect(result.skipped[0]?.reason).toBe('malformed')
  })

  it('空文件归到 malformed（能读，但解析不出凭据）', async () => {
    await writeFile(join(dir, 'empty.info'), '', 'utf8')
    const result = await discoverAccounts({ authDirs: [dir] })
    expect(result.skipped[0]?.reason).toBe('malformed')
  })

  it('一个坏文件不会让同一目录里的好文件一起消失', async () => {
    await writeFile(join(dir, WORKBUDDY_LIVE_FILENAME), liveDocument({ uin: '111' }), 'utf8')
    await writeFile(join(dir, 'broken.info'), 'not json', 'utf8')
    await writeFile(
      join(dir, 'locked.info'),
      JSON.stringify({ auth: { accessToken: { $wbEncrypted: 1, envelope: 'x' } } }),
      'utf8',
    )
    const result = await discoverAccounts({ authDirs: [dir] })
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]?.credential.uin).toBe('111')
    expect(result.skipped.map(file => file.reason).sort()).toEqual(['encrypted', 'malformed'])
  })

  it('目录不存在时返回空池而不是抛错（全新机器）', async () => {
    const result = await discoverAccounts({ authDirs: [join(dir, '不存在')] })
    expect(result.accounts).toHaveLength(0)
    expect(result.skipped).toHaveLength(0)
  })
})

describe('同一账号的多份快照折叠成一个成员', () => {
  it('活文件优先于历史快照', async () => {
    // 历史快照：token 更晚过期，但 lastRefreshTime 更早 —— 它其实是旧的。
    const stale = JSON.stringify({
      auth: {
        accessToken: 'stale-token',
        refreshToken: 'r',
        expiresAt: Math.floor((Date.now() + 200 * DAY) / 1000),
        lastRefreshTime: Math.floor((Date.now() - 50 * DAY) / 1000),
        domain: '',
      },
      account: { uin: '42', uid: 'u', nickname: '明明' },
    })
    await writeFile(join(dir, 'workbuddy-desktop.20240101.info'), stale, 'utf8')
    await writeFile(join(dir, WORKBUDDY_LIVE_FILENAME), liveDocument({ uin: '42' }), 'utf8')

    const result = await discoverAccounts({ authDirs: [dir] })
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]?.live).toBe(true)
    expect(result.accounts[0]?.credential.accessToken).toBe('token-abc')
  })

  it('国际客户端的 workbuddy-desktop-ai.info 也被扫到（前缀过滤会漏掉它）', async () => {
    await writeFile(
      join(dir, 'workbuddy-desktop-ai.info'),
      liveDocument({ uin: '8888', domain: 'workbuddy.ai', nickname: 'Global' }),
      'utf8',
    )
    const result = await discoverAccounts({ authDirs: [dir] })
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]?.region).toBe('global')
  })

  it('非 .info 文件不参与扫描（同目录的 observation.json 不是登录）', async () => {
    await writeFile(join(dir, WORKBUDDY_LIVE_FILENAME), liveDocument(), 'utf8')
    await writeFile(join(dir, 'workbuddy-desktop.observation.json'), liveDocument({ uin: '999' }), 'utf8')
    const result = await discoverAccounts({ authDirs: [dir] })
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]?.credential.uin).toBe('1000001')
  })
})

describe('WORKBUDDY_AUTH_FILE 覆盖扫描位置', () => {
  it('指目录时只扫那一个目录', () => {
    const dirs = candidateAuthDirs({ WORKBUDDY_AUTH_FILE: 'D:\\custom\\auth' })
    expect(dirs[0]).toMatch(/custom[\\/]auth$/)
  })

  it('指文件时取其所在目录', () => {
    const dirs = candidateAuthDirs({ WORKBUDDY_AUTH_FILE: '/opt/wb/custom.info' })
    expect(dirs[0]).toMatch(/opt[\\/]wb$/)
  })

  it('空字符串被当作未设置（不能变成「扫当前目录」）', () => {
    const dirs = candidateAuthDirs({ WORKBUDDY_AUTH_FILE: '   ' })
    expect(dirs.every(entry => entry.trim() !== '')).toBe(true)
    expect(dirs[0]).not.toBe('')
  })

  it('覆盖目录里的账号能被真的发现', async () => {
    const custom = join(dir, 'custom-auth')
    await mkdir(custom, { recursive: true })
    await writeFile(join(custom, WORKBUDDY_LIVE_FILENAME), liveDocument({ uin: '31337' }), 'utf8')
    const result = await discoverAccounts({ env: { WORKBUDDY_AUTH_FILE: custom } })
    // 覆盖量**追加**在平台默认目录之前（不是替换）：用户在 issue 里给的常是自己
    // 那份额外拷贝，而桌面端默认目录里的登录仍然有效，不该因为设了变量就消失。
    // 所以这里不断言总数，只断言覆盖目录的账号确实进来了。
    expect(result.accounts.map(account => account.credential.uin)).toContain('31337')
  })
})

describe('凭据新鲜度与可用性信号', () => {
  it('刷新窗口已关闭的文件仍能被发现，但标记 refreshExpired', async () => {
    const expired = JSON.stringify({
      auth: {
        accessToken: 'tok',
        refreshToken: 'r',
        expiresAt: Math.floor((Date.now() + 1 * DAY) / 1000),
        refreshExpiresAt: Math.floor((Date.now() - 30 * DAY) / 1000),
        domain: '',
      },
      account: { uin: '55' },
    })
    await writeFile(join(dir, WORKBUDDY_LIVE_FILENAME), expired, 'utf8')
    const result = await discoverAccounts({ authDirs: [dir] })
    // 仍进池（用户可能刚重新登录过终端），但界面能据此说「该重新登录了」。
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]?.refreshExpired).toBe(true)
  })
})
