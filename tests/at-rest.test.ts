/**
 * `$wbEncrypted` 凭据信封的解密通路，以及凭据双源发现（F1 的两半）。
 *
 * ## 为什么信封全是合成的
 *
 * 解密需要「从本机 WorkBuddy 桌面端可执行文件里取到 at-rest 密钥」。这台机器上
 * **没有装桌面端**，所以真信封一个也打不开——那不是代码缺陷，是协议性质（密钥
 * 只存在于桌面端自己的进程里）。于是这组测试用 `node:crypto` 现场封一个信封，
 * 再让生产代码去开它。
 *
 * 加密侧刻意调**生产代码导出的同一个** `fieldAad` 来造 AAD。若测试自己另写一份
 * AAD 拼装，两边可以一起错而所有断言通过——那种测试只证明自洽。所以另有一条
 * 黄金字节断言（`AAD 逐字节钉住协议`）钉死 `fieldAad` 的实际输出，让「两边一起
 * 错」这条路走不通。
 *
 * ## 另一半：vault
 *
 * 本机没有桌面端，但有 `~/.dsh/workbuddy-vault/<region>/*.json` 的**明文**凭据。
 * F1 的真实根因是扫描器只认 `.info` 后缀，把 vault 的 `.json` 全滤掉了，于是
 * 「0 个账号 + 0 个跳过」——连诊断都没有。所以这里也覆盖 vault 双源、后缀按目录
 * 语义收、以及同账号双源折叠成一个池成员。
 */

import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  WORKBUDDY_APP_EXECUTABLE_ENV,
  WB_APP_EXECUTABLE_ENV,
  clearAtRestKeyCache,
  deriveAtRestKey,
  deriveAtRestKeyId,
  fieldAad,
  findWorkbuddyAppExecutable,
  findWbAppExecutable,
  isEncryptedFieldWrapper,
  openEncryptedField,
  type WbEncryptedField,
} from '../src/at-rest.ts'
import {
  WbEncryptedCredentialError,
  candidateAuthSources,
  discoverAccounts,
  parseWorkBuddyAuth,
  resolveDshHome,
} from '../src/accounts.ts'

const DAY = 86_400_000

/** 信封的 suite 号：桌面端字段信封用 1。 */
const SUITE = 1

/** 造一把密钥 + 它的 keyId。 */
function makeKey(secret = 'test-secret'): { key: Buffer; keyId: string } {
  const key = createHash('sha256').update(secret, 'utf8').digest()
  return { key, keyId: deriveAtRestKeyId(key) }
}

/** 用一把密钥把明文封成 `{$wbEncrypted:1, envelope}` 字段。 */
function seal(plain: string, secret = 'test-secret'): WbEncryptedField {
  const { key, keyId } = makeKey(secret)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(fieldAad(keyId, SUITE))
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const envelope = JSON.stringify({
    suite: SUITE,
    keyId,
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  })
  return { $wbEncrypted: 1, envelope: Buffer.from(envelope, 'utf8').toString('base64') }
}

/** 把一段明文包成「envelope 内容是 X」的字段，用来测畸形信封。 */
function wrapEnvelope(inner: unknown, keyId = '0123456789abcdef'): WbEncryptedField {
  const text = typeof inner === 'string' ? inner : JSON.stringify(inner)
  return { $wbEncrypted: 1, envelope: Buffer.from(text, 'utf8').toString('base64') }
}

/** 一份桌面端形状的登录文档；`accessToken` / `refreshToken` 可以是信封。 */
function document(overrides: {
  accessToken: unknown
  refreshToken?: unknown
  uin?: string
  domain?: string
  lastRefreshTime?: number
}): string {
  return JSON.stringify({
    auth: {
      accessToken: overrides.accessToken,
      refreshToken: overrides.refreshToken ?? 'refresh-plain',
      expiresAt: Math.floor((Date.now() + 30 * DAY) / 1000),
      refreshExpiresAt: Math.floor((Date.now() + 90 * DAY) / 1000),
      lastRefreshTime: overrides.lastRefreshTime ?? Math.floor(Date.now() / 1000),
      domain: overrides.domain ?? 'www.workbuddy.cn',
    },
    account: { uin: overrides.uin ?? '1000001', uid: 'uid-0001', nickname: '小明' },
  })
}

/** vault 写盘形状（`dsh-connect-workbuddy` 的 `vaultDocument()`）。 */
function vaultDocument(overrides: {
  uin?: string
  accessToken?: string
  domain?: string
  lastRefreshTimeMs?: number
} = {}): string {
  const lastRefresh = overrides.lastRefreshTimeMs ?? Date.now()
  return JSON.stringify({
    version: 1,
    accountId: 'abc',
    refreshedAtMs: lastRefresh,
    auth: {
      accessToken: overrides.accessToken ?? 'vault-token',
      refreshToken: 'vault-refresh',
      // vault 写的是**秒**，0 表示未知。
      expiresAt: Math.floor((Date.now() + 24 * DAY) / 1000),
      refreshExpiresAt: Math.floor((Date.now() + 60 * DAY) / 1000),
      lastRefreshTime: Math.floor(lastRefresh / 1000),
      domain: overrides.domain ?? 'www.workbuddy.cn',
    },
    account: { uid: 'uid-vault', nickname: 'vault-user', uin: overrides.uin ?? '900001' },
  })
}

let dir: string

beforeEach(async () => {
  clearAtRestKeyCache()
  dir = await mkdtemp(join(tmpdir(), 'wb-at-rest-'))
})

afterEach(async () => {
  clearAtRestKeyCache()
  await rm(dir, { recursive: true, force: true })
})

describe('AAD 逐字节钉住协议', () => {
  it('field framing 的转录与桌面端逐字节一致', () => {
    // 期望值由独立的第二实现算出（python struct：>I 长度前缀 + 域分隔符 + 各段），
    // 不是从本文件里拷贝的。改动拼装顺序、字段宽度或分隔符都会让这条变红。
    const expected = Buffer.from(
      '57422d41414400010000000557424556310000000673796d2d7631'
        + '000000010000001030313233343536373839616263646566020000',
      'hex',
    )
    expect(fieldAad('0123456789abcdef', 1).equals(expected)).toBe(true)
    expect(fieldAad('0123456789abcdef', 1)).toHaveLength(54)
  })

  it('scheme 参与转录（换 scheme 就是换 AAD）', () => {
    const a = fieldAad('0123456789abcdef', 1)
    const b = fieldAad('0123456789abcdef', 1, 'sym-v2')
    expect(a.equals(b)).toBe(false)
  })

  it('suite 参与转录', () => {
    const a = fieldAad('0123456789abcdef', 1)
    const b = fieldAad('0123456789abcdef', 2)
    expect(a.equals(b)).toBe(false)
  })

  it('keyId 不是 16 位小写十六进制就抛（畸形转录不进 GCM）', () => {
    expect(() => fieldAad('NOT-A-KEY', 1)).toThrow(/keyId/u)
  })
})

describe('密钥派生', () => {
  it('哈希的是 payload 里的 base64 字符串本身，不是它解码后的字节', () => {
    const secret = 'dGVzdC1zZWNyZXQ='
    const payload = JSON.stringify({ atRestSecretKey: secret, somethingElse: 1 })
    const key = deriveAtRestKey(payload)
    expect(key).toHaveLength(32)
    expect(key.equals(createHash('sha256').update(secret, 'utf8').digest())).toBe(true)
    // 解码后的字节是完全不同的另一把钥匙——哈希错对象会让每个字段都解不开。
    const wrong = createHash('sha256').update(Buffer.from(secret, 'base64')).digest()
    expect(key.equals(wrong)).toBe(false)
  })

  it('keyId 是密钥 SHA-256 的前 16 位十六进制', () => {
    const { key, keyId } = makeKey()
    expect(keyId).toBe(createHash('sha256').update(key).digest('hex').slice(0, 16))
    expect(keyId).toMatch(/^[0-9a-f]{16}$/u)
  })

  it('payload 畸形时给出可诊断的错，而不是拿到一把垃圾钥匙', () => {
    expect(() => deriveAtRestKey('不是 JSON')).toThrow(/不是合法 JSON/u)
    expect(() => deriveAtRestKey('[]')).toThrow(/不是对象/u)
    expect(() => deriveAtRestKey('{}')).toThrow(/atRestSecretKey/u)
    expect(() => deriveAtRestKey('{"atRestSecretKey":""}')).toThrow(/atRestSecretKey/u)
  })
})

describe('信封检测', () => {
  it('认桌面端的字段信封', () => {
    expect(isEncryptedFieldWrapper({ $wbEncrypted: 1, envelope: 'AAAA' })).toBe(true)
  })

  it('不认空对象与 $wbEncrypted:0', () => {
    expect(isEncryptedFieldWrapper({})).toBe(false)
    expect(isEncryptedFieldWrapper({ $wbEncrypted: 0, envelope: 'AAAA' })).toBe(false)
  })

  it('不认多带键、缺 envelope、非对象、数组、字符串', () => {
    expect(isEncryptedFieldWrapper({ $wbEncrypted: 1, envelope: 'A', extra: 1 })).toBe(false)
    expect(isEncryptedFieldWrapper({ $wbEncrypted: 1 })).toBe(false)
    expect(isEncryptedFieldWrapper({ $wbEncrypted: 1, envelope: 123 })).toBe(false)
    expect(isEncryptedFieldWrapper(null)).toBe(false)
    expect(isEncryptedFieldWrapper([])).toBe(false)
    expect(isEncryptedFieldWrapper('token')).toBe(false)
  })

  it('混在真文档里时也认得出来', () => {
    const parsed = JSON.parse(document({ accessToken: seal('tok') })) as Record<string, unknown>
    expect(isEncryptedFieldWrapper((parsed['auth'] as Record<string, unknown>)['accessToken'])).toBe(true)
  })
})

describe('开信封', () => {
  it('正确密钥解出原文（含非 ASCII 与长 token）', () => {
    const { key } = makeKey()
    for (const plain of ['token-abc', '中文昵称-8龙在天涯8', 'x'.repeat(1361)]) {
      expect(openEncryptedField(seal(plain), key)).toBe(plain)
    }
  })

  it('错误密钥（keyId 不同）抛错，且不返回任何截断值', () => {
    const field = seal('token-abc', 'secret-a')
    const { key: otherKey } = makeKey('secret-b')
    let returned: string | undefined
    expect(() => {
      returned = openEncryptedField(field, otherKey)
    }).toThrow(/不是本机可得的密钥/u)
    // 关键：不是「解出半截」，而是根本没返回值。
    expect(returned).toBeUndefined()
  })

  it('篡改 authTag 一位 → GCM 认证失败抛错（不放宽校验）', () => {
    const field = seal('token-abc')
    const envelope = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8')) as Record<string, unknown>
    const tag = Buffer.from(envelope['authTag'] as string, 'base64')
    tag[0] = (tag[0] ?? 0) ^ 0x01
    const tampered: WbEncryptedField = {
      $wbEncrypted: 1,
      envelope: Buffer.from(
        JSON.stringify({ ...envelope, authTag: tag.toString('base64') }),
        'utf8',
      ).toString('base64'),
    }
    const { key } = makeKey()
    expect(() => openEncryptedField(tampered, key)).toThrow()
  })

  it('篡改 ciphertext → 同样认证失败', () => {
    const field = seal('token-abc')
    const envelope = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8')) as Record<string, unknown>
    const body = Buffer.from(envelope['ciphertext'] as string, 'base64')
    body[0] = (body[0] ?? 0) ^ 0xff
    const tampered: WbEncryptedField = {
      $wbEncrypted: 1,
      envelope: Buffer.from(
        JSON.stringify({ ...envelope, ciphertext: body.toString('base64') }),
        'utf8',
      ).toString('base64'),
    }
    const { key } = makeKey()
    expect(() => openEncryptedField(tampered, key)).toThrow()
  })

  it('信封畸形时抛带原因的错', () => {
    const { key } = makeKey()
    expect(() => openEncryptedField(wrapEnvelope('不是 JSON'), key)).toThrow(/不是合法 JSON/u)
    expect(() => openEncryptedField(wrapEnvelope('[]'), key)).toThrow(/不是对象/u)
    expect(() => openEncryptedField(wrapEnvelope({}), key)).toThrow(/suite 或 keyId/u)
    expect(() => openEncryptedField(wrapEnvelope({ suite: 1, keyId: '0123456789abcdef' }), key)).toThrow(
      /nonce、authTag 或 ciphertext/u,
    )
  })

  it('信封不同（nonce 不同）时同一明文得到不同密文', () => {
    const a = seal('same-plain')
    const b = seal('same-plain')
    expect(a.envelope).not.toBe(b.envelope)
  })
})

describe('parseWorkBuddyAuth 的解密接线', () => {
  const decryptWith = (secret: string) => (field: unknown): string => {
    const { key: activeKey } = makeKey(secret)
    return openEncryptedField(field as WbEncryptedField, activeKey)
  }

  it('accessToken 加密且能解开 → 返回明文凭据', () => {
    const text = document({ accessToken: seal('token-real', 'test-secret') })
    // 两参调用（无 decrypt）时这份凭据是**打不开的**，所以是抛而不是「空凭据」。
    expect(() => parseWorkBuddyAuth(text, 'x.info')).toThrow(WbEncryptedCredentialError)
    const credential = parseWorkBuddyAuth(text, 'x.info', decryptWith('test-secret'))
    expect(credential?.accessToken).toBe('token-real')
    expect(credential?.uin).toBe('1000001')
  })

  it('accessToken 加密但没有 decrypt → 抛 WbEncryptedCredentialError 且提示可操作', () => {
    const text = document({ accessToken: seal('token-real') })
    expect(() => parseWorkBuddyAuth(text, 'x.info')).toThrow(WbEncryptedCredentialError)
    // 错误消息要能指导行动：告诉用户密钥在哪、有哪两条出路。
    expect(() => parseWorkBuddyAuth(text, 'x.info')).toThrow(/WORKBUDDY_APP_EXECUTABLE/u)
  })

  it('accessToken 加密但密钥不对 → 抛（不降级成空 token 的可读凭据）', () => {
    const text = document({ accessToken: seal('token-real', 'secret-a') })
    expect(() => parseWorkBuddyAuth(text, 'x.info', decryptWith('secret-b'))).toThrow(
      WbEncryptedCredentialError,
    )
  })

  it('refreshToken 加密且能解开 → 一并拿到明文（刷新窗口靠它）', () => {
    const text = document({
      accessToken: 'token-plain',
      refreshToken: seal('refresh-real', 'test-secret'),
    })
    const credential = parseWorkBuddyAuth(text, 'x.info', decryptWith('test-secret'))
    expect(credential?.accessToken).toBe('token-plain')
    expect(credential?.refreshToken).toBe('refresh-real')
  })

  it('refreshToken 加密且解不开 → 账号仍可用，refreshToken 为空串（不抛）', () => {
    // accessToken 还能用一阵；为了让一个「暂时解不开、以后可能解开」的字段丢掉整个
    // 账号（用户会看到账号消失）比丢掉刷新能力更糟。
    const text = document({
      accessToken: 'token-plain',
      refreshToken: seal('refresh-real', 'secret-a'),
    })
    const credential = parseWorkBuddyAuth(text, 'x.info', decryptWith('secret-b'))
    expect(credential?.accessToken).toBe('token-plain')
    expect(credential?.refreshToken).toBe('')
  })

  it('两个字段都加密且都能解开 → 两个都是明文', () => {
    const text = document({
      accessToken: seal('token-real', 'test-secret'),
      refreshToken: seal('refresh-real', 'test-secret'),
    })
    const credential = parseWorkBuddyAuth(text, 'x.info', decryptWith('test-secret'))
    expect(credential?.accessToken).toBe('token-real')
    expect(credential?.refreshToken).toBe('refresh-real')
  })

  it('昵称加密解不开不影响账号可用（装饰字段不判死整账号）', () => {
    const parsed = JSON.parse(document({ accessToken: 'tok' })) as Record<string, unknown>
    ;(parsed['account'] as Record<string, unknown>)['nickname'] = seal('小明', 'secret-a')
    const credential = parseWorkBuddyAuth(JSON.stringify(parsed), 'x.info', decryptWith('secret-b'))
    expect(credential?.accessToken).toBe('tok')
    expect(credential?.nickname).toBeUndefined()
  })

  it('明文凭据在有没有 decrypt 时结果一致（向后兼容两参调用）', () => {
    const text = document({ accessToken: 'token-plain' })
    const withoutDecrypt = parseWorkBuddyAuth(text, 'x.info')
    const withDecrypt = parseWorkBuddyAuth(text, 'x.info', decryptWith('test-secret'))
    expect(withoutDecrypt?.accessToken).toBe('token-plain')
    expect(withDecrypt).toEqual(withoutDecrypt)
  })

  it('decrypt 自己抛错时，加密 accessToken 仍归到 encrypted 口径', () => {
    const text = document({ accessToken: seal('token-real') })
    const boom = (): string => {
      throw new Error('boom')
    }
    expect(() => parseWorkBuddyAuth(text, 'x.info', boom)).toThrow(WbEncryptedCredentialError)
  })
})

describe('discoverAccounts 的降级与混装', () => {
  it('唯一文件是加密信封且本机无密钥 → 报 encrypted，不静默消失', async () => {
    await writeFile(join(dir, 'only-encrypted.info'), document({ accessToken: seal('tok') }), 'utf8')
    const result = await discoverAccounts({ authDirs: [dir] })
    expect(result.accounts).toHaveLength(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.reason).toBe('encrypted')
  })

  it('混装：同账号既有明文文件又有加密文件 → 账号可用，不被判成不可用', async () => {
    // 这是 F1 的真实形态：桌面端对同一 uin 写了多份快照，其中一份是加密的。
    await writeFile(join(dir, 'aaa-old.info'), document({ accessToken: 'token-plain', uin: '777' }), 'utf8')
    await writeFile(join(dir, 'bbb-new.info'), document({ accessToken: seal('token-sealed'), uin: '777' }), 'utf8')
    const result = await discoverAccounts({ authDirs: [dir] })
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]?.credential.uin).toBe('777')
    expect(result.accounts[0]?.credential.accessToken).toBe('token-plain')
    // 加密那份进跳过列表（如实上报），但账号本体在池里。
    expect(result.skipped.map(file => file.reason)).toEqual(['encrypted'])
  })

  it('加密-only 账号与明文账号并存 → 明文账号照旧可用', async () => {
    await writeFile(join(dir, 'plain.info'), document({ accessToken: 'token-plain', uin: '111' }), 'utf8')
    await writeFile(join(dir, 'sealed.info'), document({ accessToken: seal('x'), uin: '222' }), 'utf8')
    const result = await discoverAccounts({ authDirs: [dir] })
    expect(result.accounts.map(account => account.credential.uin)).toEqual(['111'])
    expect(result.skipped[0]?.reason).toBe('encrypted')
  })

  it('只有 refreshToken 加密、accessToken 明文 → 账号照旧可用，不进跳过列表', async () => {
    // 两个字段分别接线：refreshToken 解不开只损失刷新能力，不该把账号判成
    // `encrypted` 整份丢掉。若哪天把 `fieldOf(auth['refreshToken']).failed` 也
    // 接成抛错，这条会红。
    await writeFile(
      join(dir, 'half-sealed.info'),
      document({ accessToken: 'token-plain', refreshToken: seal('refresh', 'secret-a'), uin: '333' }),
      'utf8',
    )
    const result = await discoverAccounts({ authDirs: [dir] })
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]?.credential.uin).toBe('333')
    expect(result.accounts[0]?.credential.accessToken).toBe('token-plain')
    expect(result.accounts[0]?.credential.refreshToken).toBe('')
    expect(result.skipped).toHaveLength(0)
  })
})

describe('可执行文件探测的导出面', () => {
  it('两个环境变量名指向同一个值（跨插件抄常量名都能 import）', () => {
    expect(WORKBUDDY_APP_EXECUTABLE_ENV).toBe(WB_APP_EXECUTABLE_ENV)
    expect(WORKBUDDY_APP_EXECUTABLE_ENV).toBe('WORKBUDDY_APP_EXECUTABLE')
  })

  it('两个发现函数是同一个实现（不是行为可能分叉的包装）', () => {
    expect(findWorkbuddyAppExecutable).toBe(findWbAppExecutable)
  })

  it('环境变量指向一个不存在的路径时不去猜（返回 undefined 而非硬编码默认）', () => {
    const found = findWorkbuddyAppExecutable('linux', '/nonexistent-home-for-test', {
      WORKBUDDY_APP_EXECUTABLE: '/nonexistent/WorkBuddy',
    })
    expect(found).toBeUndefined()
  })
})

describe('凭据双源：dsh vault 的 .json 必须被扫到（F1 的另一半）', () => {
  async function makeVault(regions: { cn?: string[]; global?: string[] }): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'wb-dshhome-'))
    for (const region of ['cn', 'global'] as const) {
      const texts = regions[region]
      if (texts === undefined) continue
      const vaultDir = join(home, 'workbuddy-vault', region)
      await mkdir(vaultDir, { recursive: true })
      for (const [index, text] of texts.entries()) {
        await writeFile(join(vaultDir, `${region}-${index}.json`), text, 'utf8')
      }
    }
    return home
  }

  it('vault 目录里的 .json 被发现（改前这里返回 0 个账号、0 个跳过）', async () => {
    const home = await makeVault({ cn: [vaultDocument({ uin: '900001' })] })
    try {
      const result = await discoverAccounts({ authDirs: [join(home, 'workbuddy-vault', 'cn')] })
      expect(result.accounts).toHaveLength(1)
      expect(result.accounts[0]?.credential.uin).toBe('900001')
      expect(result.accounts[0]?.credential.accessToken).toBe('vault-token')
      expect(result.accounts[0]?.region).toBe('cn')
      expect(result.skipped).toHaveLength(0)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('global 区域的 vault 文件按 domain 判到 global', async () => {
    const home = await makeVault({
      global: [vaultDocument({ uin: '900002', domain: 'www.workbuddy.ai' })],
    })
    try {
      const result = await discoverAccounts({ authDirs: [join(home, 'workbuddy-vault', 'global')] })
      expect(result.accounts[0]?.region).toBe('global')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('桌面端目录里的 .json 仍被排除（observation.json 不是登录）', async () => {
    // 后缀按**目录语义**收：同一份 .json 放在桌面端目录里必须被忽略，否则
    // `workbuddy-desktop.observation.json` 会被当成一个账号读进来。
    await writeFile(
      join(dir, 'workbuddy-desktop.observation.json'),
      vaultDocument({ uin: '900003' }),
      'utf8',
    )
    const result = await discoverAccounts({ authDirs: [dir] })
    expect(result.accounts).toHaveLength(0)
    expect(result.skipped).toHaveLength(0)
  })

  it('同账号双源（桌面端 .info + vault .json）只产出一个池成员，取较新的那份', async () => {
    const stale = Date.now() - 10 * DAY
    const fresh = Date.now()
    const home = await makeVault({
      cn: [vaultDocument({ uin: '900004', accessToken: 'from-vault', lastRefreshTimeMs: fresh })],
    })
    const desktop = await mkdtemp(join(tmpdir(), 'wb-desktop-'))
    try {
      // 用**带时间戳**的桌面端快照（不是 `workbuddy-desktop.info`）：活文件优先键
      // 只该在「桌面端正在使用那份登录」时压过新鲜度，历史快照不该。
      await writeFile(
        join(desktop, 'workbuddy-desktop.2026-10-09T14-47-00-407Z.27932.info'),
        document({ accessToken: 'from-desktop', uin: '900004', lastRefreshTime: Math.floor(stale / 1000) }),
        'utf8',
      )
      const result = await discoverAccounts({
        authDirs: [desktop, join(home, 'workbuddy-vault', 'cn')],
      })
      // 一个成员而不是两个：两个会让「剩余总积分」把同一个人的余额重复相加。
      expect(result.accounts).toHaveLength(1)
      expect(result.accounts[0]?.credential.uin).toBe('900004')
      expect(result.accounts[0]?.credential.accessToken).toBe('from-vault')
    } finally {
      await rm(home, { recursive: true, force: true })
      await rm(desktop, { recursive: true, force: true })
    }
  })

  it('桌面端活文件优先于更新的 vault 副本（那是用户此刻正在用的登录）', async () => {
    // 反向钉子：`compareFreshness` 的第二键是「活文件优先」。若哪天把它去掉，
    // 一次陈旧的 vault 写盘就能把用户刚在桌面端登录的账号顶掉。
    const home = await makeVault({
      cn: [vaultDocument({ uin: '900006', accessToken: 'from-vault', lastRefreshTimeMs: Date.now() })],
    })
    const desktop = await mkdtemp(join(tmpdir(), 'wb-desktop-'))
    try {
      await writeFile(
        join(desktop, 'workbuddy-desktop.info'),
        document({
          accessToken: 'from-desktop',
          uin: '900006',
          lastRefreshTime: Math.floor((Date.now() - 5 * DAY) / 1000),
        }),
        'utf8',
      )
      const result = await discoverAccounts({
        authDirs: [desktop, join(home, 'workbuddy-vault', 'cn')],
      })
      expect(result.accounts).toHaveLength(1)
      expect(result.accounts[0]?.credential.accessToken).toBe('from-desktop')
      expect(result.accounts[0]?.live).toBe(true)
    } finally {
      await rm(home, { recursive: true, force: true })
      await rm(desktop, { recursive: true, force: true })
    }
  })

  it('$DSH_HOME 指向临时目录时，两个 region 目录都在扫描范围内', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wb-dshhome-'))
    try {
      const sources = candidateAuthSources({ DSH_HOME: home })
      const vaultSources = sources.filter(source => source.kind === 'vault')
      expect(vaultSources.map(source => source.dir)).toEqual([
        join(home, 'workbuddy-vault', 'cn'),
        join(home, 'workbuddy-vault', 'global'),
      ])
      // 桌面端目录仍在、且排在 vault 之前（活文件优先键只在桌面端生效）。
      expect(sources[0]?.kind).toBe('desktop')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('$DSH_HOME 为空白时回落 ~/.dsh（不落到当前工作目录）', () => {
    const home = join(tmpdir(), 'wb-fake-home')
    expect(resolveDshHome(undefined, { DSH_HOME: '   ' }, home)).toBe(resolve(join(home, '.dsh')))
  })

  it('$DSH_HOME 下的 vault 会被真的读出来（端到端走 resolveDshHome）', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wb-fake-home-'))
    try {
      // `DSH_HOME` 就是 Harness home 本身，所以 vault 直接落在 `$DSH_HOME` 下，
      // **不是** `$DSH_HOME/.dsh` 下。搞错这一层会让扫描指向一个不存在的目录。
      const vaultDir = join(home, 'workbuddy-vault', 'cn')
      await mkdir(vaultDir, { recursive: true })
      await writeFile(join(vaultDir, 'x.json'), vaultDocument({ uin: '900005' }), 'utf8')
      const resolved = resolveDshHome(undefined, { DSH_HOME: home }, '/nonexistent-home')
      expect(resolved).toBe(resolve(home))
      const result = await discoverAccounts({ authDirs: [join(resolved, 'workbuddy-vault', 'cn')] })
      expect(result.accounts.map(account => account.credential.uin)).toEqual(['900005'])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('未设 $DSH_HOME 时 vault 落在 ~/.dsh 下', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wb-plain-home-'))
    try {
      const vaultDir = join(home, '.dsh', 'workbuddy-vault', 'global')
      await mkdir(vaultDir, { recursive: true })
      await writeFile(
        join(vaultDir, 'y.json'),
        vaultDocument({ uin: '900007', domain: 'www.workbuddy.ai' }),
        'utf8',
      )
      const resolved = resolveDshHome(undefined, {}, home)
      expect(resolved).toBe(resolve(join(home, '.dsh')))
      const result = await discoverAccounts({
        authDirs: [join(resolved, 'workbuddy-vault', 'global')],
      })
      expect(result.accounts.map(account => account.credential.uin)).toEqual(['900007'])
      expect(result.accounts[0]?.region).toBe('global')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
