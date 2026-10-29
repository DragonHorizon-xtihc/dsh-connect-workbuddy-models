/**
 * 账号来源标签（F6）。
 *
 * `WbAccountSource` 声明了 `'desktop' | 'dsh'` 两个取值，客户端也早就按
 * `source === 'dsh'` 分支渲染，但后端唯一产出点曾硬编码 `'desktop'` —— 于是
 * 联合里的 `'dsh'` 是一条从未被产出的死类型，本机四个全部来自 `~/.dsh/workbuddy-vault`
 * 的账号在设置页一律显示「桌面端登录」。
 *
 * 这个显示不是装饰：两类来源的续期方式完全不同。桌面端 `.info` 要用户回桌面端重登；
 * vault `.json` 重新登录 `dsh-connect-workbuddy` 就可能救回来。标错会让用户对着
 * 「请重新登录 WorkBuddy 桌面端」去修一个跟桌面端无关的问题。
 *
 * ## 两条断言各自防什么
 *
 * 1. `discoverAccounts` 对同一 uin、分别来自两类目录时给出不同 source —— 防「读目录
 *    时不知道自己在读哪一类」再次发生（`readAccount` 曾只收 `(path, decrypt)`）。
 * 2. `/status` 应答里的 `account.source` 与账号真实来源一致 —— 防 `buildStatus` 再次
 *    在投影处写死字面量。**不给默认值兜底**：`?? 'desktop'` 会把「没接通」伪装成
 *    「接通了」，正是这个缺陷当初躲过复核的方式。
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { WbAccountPool, discoverAccounts } from '../src/accounts.ts'
import type { WbDiscoveredAccount, WbDiscoveryResult } from '../src/accounts.ts'
import { WbCatalogs } from '../src/catalog.ts'
import { WbScheduler } from '../src/scheduler.ts'
import { WB_STATUS_PATH, registerWbStatusRoutes } from '../src/web-status.ts'
import type { WbStatusRouteOptions } from '../src/web-status.ts'
import type { WbModelsConfig } from '../src/status-paths.ts'

const DAY = 86_400_000

/** 两个域的登录文件形状相同，只有 `domain` 决定 region。 */
function loginDocument(overrides: { uin?: string; nickname?: string; domain?: string } = {}): string {
  return JSON.stringify({
    auth: {
      accessToken: 'token-abc',
      refreshToken: 'refresh-abc',
      expiresAt: Math.floor((Date.now() + 30 * DAY) / 1000),
      refreshExpiresAt: Math.floor((Date.now() + 90 * DAY) / 1000),
      lastRefreshTime: Math.floor(Date.now() / 1000),
      domain: overrides.domain ?? 'www.workbuddy.cn',
    },
    account: {
      uin: overrides.uin ?? '1000001',
      uid: 'uid-0001',
      nickname: overrides.nickname ?? '小明',
    },
  })
}

const temps: string[] = []

afterEach(async () => {
  while (temps.length > 0) {
    const path = temps.pop()
    if (path !== undefined) await rm(path, { recursive: true, force: true })
  }
})

async function tempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temps.push(path)
  return path
}

/** `<root>/workbuddy-vault/<region>/` —— `sourceOf` 只认这个形状的上一级目录名。 */
async function vaultDir(root: string, region: 'cn' | 'global'): Promise<string> {
  const path = join(root, 'workbuddy-vault', region)
  await mkdir(path, { recursive: true })
  return path
}

describe('发现阶段的来源标签', () => {
  it('桌面端 .info 目录里的账号 → source = desktop', async () => {
    const desktop = await tempDir('wb-src-desktop-')
    await writeFile(join(desktop, 'workbuddy-desktop.info'), loginDocument({ uin: '900001' }), 'utf8')

    const result = await discoverAccounts({ authDirs: [desktop] })

    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]?.source).toBe('desktop')
  })

  it('**同一个 uin** 从 vault .json 目录读到时 → source = dsh', async () => {
    const root = await tempDir('wb-src-vault-')
    const dir = await vaultDir(root, 'cn')
    // 同一个 uin（900001）—— 来源只能由读它的目录决定，不能由账号身份决定。
    await writeFile(join(dir, '33dc53cb024cbaedc6ef60a5.json'), loginDocument({ uin: '900001' }), 'utf8')

    const result = await discoverAccounts({ authDirs: [dir] })

    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]?.source).toBe('dsh')
  })

  it('同一 uin 的两份来源给两个不同标签（这是死类型被真正产出的证据）', async () => {
    const desktop = await tempDir('wb-src-both-desktop-')
    const root = await tempDir('wb-src-both-vault-')
    const vault = await vaultDir(root, 'cn')
    await writeFile(join(desktop, 'workbuddy-desktop.info'), loginDocument({ uin: '900002' }), 'utf8')
    await writeFile(join(vault, '51c39655c9b6a3637b54bcad.json'), loginDocument({ uin: '900002' }), 'utf8')

    const fromDesktop = await discoverAccounts({ authDirs: [desktop] })
    const fromVault = await discoverAccounts({ authDirs: [vault] })

    expect(fromDesktop.accounts[0]?.id).toBe(fromVault.accounts[0]?.id)
    expect(fromDesktop.accounts[0]?.source).toBe('desktop')
    expect(fromVault.accounts[0]?.source).toBe('dsh')
    expect(fromDesktop.accounts[0]?.source).not.toBe(fromVault.accounts[0]?.source)
  })

  it('两类目录同时扫描时仍折叠成一个账号，且标签取自**胜出那份**', async () => {
    const desktop = await tempDir('wb-src-fold-desktop-')
    const root = await tempDir('wb-src-fold-vault-')
    const vault = await vaultDir(root, 'cn')
    // 桌面端活文件在折叠时优先（compareFreshness 第二键），所以它代表这个账号。
    await writeFile(join(desktop, 'workbuddy-desktop.info'), loginDocument({ uin: '900003' }), 'utf8')
    await writeFile(join(vault, 'bbf8054a7c091d653f571e1a.json'), loginDocument({ uin: '900003' }), 'utf8')

    const result = await discoverAccounts({ authDirs: [desktop, vault] })

    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]?.source).toBe('desktop')
    expect(result.accounts[0]?.sourcePath.endsWith('workbuddy-desktop.info')).toBe(true)
  })

  it('global 区域的 vault 目录同样产出 dsh', async () => {
    const root = await tempDir('wb-src-global-')
    const dir = await vaultDir(root, 'global')
    await writeFile(
      join(dir, '27e8f3bc23d65074b2bd5bb1.json'),
      loginDocument({ uin: '900004', domain: 'www.workbuddy.ai' }),
      'utf8',
    )

    const result = await discoverAccounts({ authDirs: [dir] })

    expect(result.accounts[0]?.region).toBe('global')
    expect(result.accounts[0]?.source).toBe('dsh')
  })
})

// ── /status 应答里的来源 ───────────────────────────────────────────────────

function accountFixture(id: string, source: WbDiscoveredAccount['source']): WbDiscoveredAccount {
  return {
    id,
    label: id,
    region: 'cn',
    sourcePath: source === 'dsh' ? `/fake/workbuddy-vault/cn/${id}.json` : `/fake/${id}.info`,
    source,
    live: source === 'desktop',
    refreshExpired: false,
    tokenExpiresAtMs: Date.now() + 30 * DAY,
    credential: {
      accessToken: 'tok',
      refreshToken: 'ref',
      expiresAtMs: Date.now() + 30 * DAY,
      domain: '',
    },
  }
}

function baseConfig(): WbModelsConfig {
  return {
    enabled: true,
    distribution: 'expiry',
    enabledModelIds: [],
    enabledModelIdsGlobal: [],
    accountsEnabled: [],
    orderAccountIds: [],
    showCreditsInComposer: true,
    expiryWarnDays: 3,
    automation: { enabled: false, checkinHours: [9], claimBenefits: false },
    accounts: {},
  }
}

/** 只装 `/status` 需要的那套依赖；用真的路由分派代码，不 mock handler。 */
async function statusBody(accounts: readonly WbDiscoveredAccount[]): Promise<any> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => unknown>()
  const pool = new WbAccountPool({})
  const discovery: WbDiscoveryResult = { accounts, skipped: [] }
  pool.applyDiscovery(discovery)

  const scheduler = new WbScheduler({
    pool,
    client: { fetchCredits: async () => ({ total: 0, packages: [] }) } as never,
    now: () => new Date('2026-03-15T09:30:00+08:00'),
  })

  const deps: WbStatusRouteOptions = {
    pool,
    catalogs: new WbCatalogs(),
    client: {} as never,
    scheduler,
    readConfig: () => baseConfig(),
    writeConfig: async () => {},
    rescan: async () => {},
    probe: async () => [],
    refreshModels: async () => {},
    pickOf: region => pool.pick(region),
  }

  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    webServer: {
      register: (route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }) => {
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    },
  } as never

  registerWbStatusRoutes(ctx, deps)

  const handler = routes.get(WB_STATUS_PATH)
  if (handler === undefined) throw new Error('status route not registered')

  const req = new EventEmitter() as unknown as IncomingMessage & EventEmitter
  Object.assign(req, { method: 'GET', url: WB_STATUS_PATH, headers: {} })

  const res = new PassThrough() as unknown as ServerResponse
  const chunks: Buffer[] = []
  let status = 0
  Object.assign(res, {
    writeHead: (code: number) => { status = code; return res },
    end: (chunk?: unknown) => {
      if (chunk !== undefined) chunks.push(Buffer.from(String(chunk)))
      return res
    },
    headersSent: false,
  })
  res.on('data', (chunk: Buffer) => chunks.push(chunk))

  await handler(req, res)
  req.emit('end')
  await new Promise(resolve => { setImmediate(resolve) })

  expect(status).toBe(200)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

describe('/status 应答里的来源标签', () => {
  it('vault 账号的读数标 dsh、桌面端账号标 desktop（不恒定 desktop）', async () => {
    const body = await statusBody([
      accountFixture('from-desktop', 'desktop'),
      accountFixture('from-vault', 'dsh'),
    ])

    const byId = new Map<string, string>(
      (body.accounts as any[]).map(row => [String(row.account.id), String(row.account.source)]),
    )
    expect(byId.get('from-desktop')).toBe('desktop')
    expect(byId.get('from-vault')).toBe('dsh')
    // 这一条才是 F6 的直接反证：改前两个都会是 'desktop'。
    expect(new Set(byId.values()).size).toBe(2)
  })

  it('全是 vault 账号时每一条都是 dsh', async () => {
    const body = await statusBody([accountFixture('v1', 'dsh'), accountFixture('v2', 'dsh')])
    const sources = (body.accounts as any[]).map(row => row.account.source)
    expect(sources).toEqual(['dsh', 'dsh'])
  })
})
