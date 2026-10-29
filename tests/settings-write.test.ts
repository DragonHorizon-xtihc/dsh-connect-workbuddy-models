/**
 * 卡片上的三条写路径必须真的能写进去（F8）。
 *
 * 缺陷形态：`writeConfig` 曾经先把方法摘下来放进局部变量再调用——
 * `const writer = settingsService?.update` 然后 `writer(ns, patch)`。这等于把
 * `update` 从 settings 对象上摘下来，调用时 `this` 是 `undefined`；而宿主
 * `packages/settings/settings/src/index.ts` 的 `update` 第一行就是
 *
 *     await this.write(ns, current => mergeLayers(current, input), expectedRevision)
 *
 * 于是每次都抛 `TypeError: Cannot read properties of undefined (reading 'write')`，
 * 「账户切换」「自动化开关」「模型显示」三条写路由全部 500。用户看到的是
 * 「保存无效」，而不是「有个 bug」——所以这条测试的价值不在断言 200，而在
 * **让 `this` 真的被用到**。
 *
 * 这就是本文件里那个假 settings 服务为什么不用 `vi.fn()`：`vi.fn()` 是箭头函数，
 * 没有自己的 `this`，摘不摘下来都跑得通，测不出这个缺陷。假服务必须写成
 * 彼此调用的对象方法（`update` 里调 `this.write`），与宿主同构。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import {
  WB_ACCOUNTS_SELECT_PATH,
  WB_AUTOMATION_PATH,
  WB_MODELS_SAVE_PATH,
  WB_STATUS_PATH,
} from '../src/status-paths.ts'

const DAY = 86_400_000

interface FakeRoute {
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => unknown
}

/**
 * 一个够用的假 cordis context，比 settings-lines.test.ts 那份多支持 webServer：
 * 只有拿到注册的 handler 才能真的发一次 POST 去打 `writeConfig`。
 */
function fakeCtx(options: { settings?: unknown } = {}) {
  const routes = new Map<string, FakeRoute['handler']>()
  const effects: (() => void)[] = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    settings: options.settings,
    fiber: { entry: { options: { id: 'workbuddy-models' } } },
    effect: (body: () => (() => void) | void) => {
      const disposer = body()
      if (typeof disposer === 'function') effects.push(disposer)
      return disposer
    },
    on: () => {},
    inject: (deps: string[], body: (scope: unknown) => void) => {
      if (!deps.includes('webServer')) return
      body({
        ...ctx,
        webServer: {
          register: (route: FakeRoute) => {
            routes.set(route.path, route.handler)
            return () => { routes.delete(route.path) }
          },
        },
      })
    },
    llm: {
      registerAdapter: () => () => {},
      registerConfigurableProviders: () => () => {},
      registerModelDiscovery: () => {},
    },
  }
  return { ctx, routes, effects }
}

/**
 * 与宿主同构的假 settings 服务：`update` 内部**真的读 `this.write`**。
 * 方法一旦被摘下来，这里就会以 `TypeError` 引爆——这正是生产上的形态。
 *
 * `afterWrite` 用来模拟宿主的另一半行为：真实 settings 服务写完会让配置对象
 * 里的 volatile 引用读到新值（`loader/volatile-update` 再广播一次）。没有这一步，
 * 写路由回执里的 `config` 会一直是旧值，而那不是本插件的缺陷——回执里的 `config`
 * 本来就取自宿主那份活配置。
 */
function fakeSettings(options: { afterWrite?: (ns: string, patch: Record<string, unknown>) => void } = {}) {
  const docs = new Map<string, Record<string, unknown>>()
  const calls: { ns: string; patch: Record<string, unknown> }[] = []
  const service = {
    configure: () => () => {},
    async update(ns: string, patch: Record<string, unknown>): Promise<void> {
      calls.push({ ns, patch })
      await this.write(ns, patch)
      options.afterWrite?.(ns, patch)
    },
    async write(ns: string, patch: Record<string, unknown>): Promise<void> {
      docs.set(ns, { ...(docs.get(ns) ?? {}), ...patch })
    },
  }
  return { service, docs, calls }
}

/** 发一次真请求给已注册的 handler，返回 HTTP 码与 JSON 回执。 */
async function dispatch(
  routes: Map<string, FakeRoute['handler']>,
  path: string,
  body: unknown,
  method: 'GET' | 'POST' = 'POST',
): Promise<{ status: number; json: Record<string, unknown> }> {
  const handler = routes.get(path.split('?')[0] ?? path)
  expect(handler, `路由 ${path} 没有注册`).toBeTypeOf('function')
  const req = new EventEmitter() as unknown as IncomingMessage & EventEmitter
  Object.assign(req, {
    method,
    url: path,
    // loopbackOrigin 认这个头；写路由的 guard 第一关就是本机来源。
    headers: { origin: 'http://127.0.0.1:3080', 'content-type': 'application/json' },
  })
  const chunks: Buffer[] = []
  let status = 0
  const res = new PassThrough() as unknown as ServerResponse & PassThrough
  Object.assign(res, {
    writeHead: (code: number) => { status = code; return res },
    end: (chunk?: unknown) => {
      if (chunk !== undefined) chunks.push(Buffer.from(String(chunk)))
      return res
    },
    headersSent: false,
  })
  // web-status 的 readJsonBody 走 async iterator 读 req；用 EventEmitter 模拟时
  // 必须先让 handler 挂上监听，再吐数据。
  const pending = Promise.resolve(handler(req, res))
  if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
  req.emit('end')
  await pending
  await new Promise(resolve => setImmediate(resolve))
  const text = Buffer.concat(chunks).toString('utf8')
  return { status, json: text === '' ? {} : JSON.parse(text) as Record<string, unknown> }
}

/**
 * 等启动那次 rescan 落地，返回被发现的第一个 **cn** 账号 id。
 *
 * `apply` 里的「发现 → 播种」是后台跑的一条 async IIFE（它不阻塞 apply 返回），
 * 所以刚 apply 完池还是空的。轮询 `/status` 而不是 sleep 一个魔数：本仓有过
 * 「用固定 sleep 等后台任务」的 flaky 前科。
 *
 * 必须按 region 挑：`WORKBUDDY_AUTH_FILE` 只是把我们的夹具**加**进候选目录，
 * 本机真实的 `~/.dsh/workbuddy-vault/global` 仍会被扫进来，而账号按 id 升序返回，
 * 取第 0 个可能拿到国际账号 —— 那样这条用例会以 409 account-region-mismatch 失败，
 * 看起来像写路径坏了，其实是夹具选错了账号。
 */
async function waitForAccount(routes: Map<string, FakeRoute['handler']>): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { json } = await dispatch(routes, WB_STATUS_PATH, undefined, 'GET')
    const accounts = json['accounts'] as { id?: string; region?: string }[] | undefined
    const id = accounts?.find(entry => entry.region === 'cn')?.id
    if (typeof id === 'string' && id !== '') return id
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('等了 2 秒也没有发现任何 cn 账号；检查 WORKBUDDY_AUTH_FILE 指向的文件是否可解析')
}

describe('三条写路径都必须真的落到 settings（F8）', () => {
  it('账户切换：回执 200，且 config.accounts.cn 等于传入的 accountId', async () => {
    // 这条路由要先在池里找到账号（找不到就 404 短路，写路径根本走不到）。池是在
    // `apply` 内部装配的，外面拿不到引用——所以走真实入口：把凭据目录指到临时
    // 目录里的一份 .info，让启动那次 rescan 真的把它发现出来。
    const home = await mkdtemp(join(tmpdir(), 'wb-settings-write-'))
    const authDir = join(home, 'auth')
    await mkdir(authDir, { recursive: true })
    const expiresAt = Math.floor((Date.now() + 30 * DAY) / 1000)
    await writeFile(join(authDir, 'workbuddy-desktop.info'), JSON.stringify({
      auth: {
        accessToken: 'token-abc',
        refreshToken: 'refresh-abc',
        expiresAt,
        refreshExpiresAt: Math.floor((Date.now() + 90 * DAY) / 1000),
        lastRefreshTime: Math.floor(Date.now() / 1000),
        domain: 'www.workbuddy.cn',
      },
      account: { uin: '1000001', uid: 'uid-0001', nickname: '小明' },
    }), 'utf8')
    const previous = process.env['WORKBUDDY_AUTH_FILE']
    process.env['WORKBUDDY_AUTH_FILE'] = join(authDir, 'workbuddy-desktop.info')
    try {
      // 活的配置对象：`apply` 的第二参就是宿主那份 config，`liveConfig()` 直接读它。
      // 真实 settings 服务写完后这些值会变（0.1.7 还会再广播一次 volatile-update），
      // 这里用 `afterWrite` 复现那一半——否则回执里的 `config` 永远是 apply 时的初始值。
      const liveConfig: Record<string, unknown> = {}
      const { service, docs } = fakeSettings({
        afterWrite: (_ns, patch) => { Object.assign(liveConfig, patch) },
      })
      const { ctx, routes } = fakeCtx({ settings: service })
      apply(ctx as never, liveConfig as never)
      const accountId = await waitForAccount(routes)
      const { status, json } = await dispatch(routes, `${WB_ACCOUNTS_SELECT_PATH}?accountId=${accountId}&region=cn`, undefined)
      expect(status).toBe(200)
      const config = json['config'] as { accounts?: Record<string, string> } | undefined
      expect(config?.accounts?.['cn']).toBe(accountId)
      // 写真的进了服务（不是只改了内存里的池）。
      expect((docs.get('workbuddy-models')?.['accounts'] as Record<string, string> | undefined)?.['cn']).toBe(accountId)
    } finally {
      if (previous === undefined) delete process.env['WORKBUDDY_AUTH_FILE']
      else process.env['WORKBUDDY_AUTH_FILE'] = previous
      await rm(home, { recursive: true, force: true })
    }
  })

  it('自动化开关：回执 200，且回执里的 config 与写入一致', async () => {
    const { service, docs } = fakeSettings()
    const { ctx, routes } = fakeCtx({ settings: service })
    apply(ctx as never, {} as never)
    const { status, json } = await dispatch(routes, WB_AUTOMATION_PATH, {
      enabled: false,
      checkinHours: [9],
      claimBenefits: false,
    })
    expect(status).toBe(200)
    const config = json['config'] as { enabled?: boolean; checkinHours?: number[] } | undefined
    expect(config?.enabled).toBe(false)
    expect(config?.checkinHours).toEqual([9])
    const written = docs.get('workbuddy-models')?.['automation'] as { enabled?: boolean } | undefined
    expect(written?.enabled).toBe(false)
  })

  it('模型显示：回执 200，空数组表示全部显示而不是一个都不要', async () => {
    const { service, docs } = fakeSettings()
    const { ctx, routes } = fakeCtx({ settings: service })
    apply(ctx as never, {} as never)
    const { status, json } = await dispatch(routes, WB_MODELS_SAVE_PATH, { region: 'cn', enabledModelIds: [] })
    expect(status).toBe(200)
    expect(json['enabledModelIds']).toEqual([])
    expect(docs.get('workbuddy-models')?.['enabledModelIds']).toEqual([])
  })

  it('settings 服务没有 update 时抛出可读错误，而不是 TypeError', async () => {
    const { ctx, routes } = fakeCtx({ settings: { configure: () => () => {} } })
    apply(ctx as never, {} as never)
    const { status, json } = await dispatch(routes, WB_AUTOMATION_PATH, { enabled: false })
    expect(status).toBe(500)
    // 关键：说的是「settings 服务不可用」，不是「Cannot read properties of undefined」。
    expect(String(json['error'])).toContain('settings 服务不可用')
    expect(String(json['error'])).not.toContain('Cannot read properties')
  })
})
