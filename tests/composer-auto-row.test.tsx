// @vitest-environment jsdom
/**
 * 读数条面板里的「自动（按账户使用方式）」行，**真的点下去**会发出什么请求。
 *
 * ## 为什么这个文件单独存在
 *
 * 安装后的端到端实测（`docs/E2E-REPORT.md` §11）里，唯一被列为「未验证」的一项
 * 就是这一行的点击：面板结构、五个账号按钮、`wbm-composer-panel-row-current`
 * 高亮都验过，但从来没有真点过。当时不点的理由是「点下去会写共用 profile 的
 * `config.accounts.cn`」——那个理由对 `accounts/select` 这类**写路由**是成立的。
 *
 * 但这条证据链真正缺的一环不在后端，在组件里：
 *
 *     onClick={() => { void switchTo('') }}
 *
 * 从「按钮存在」推到「后端能清除」中间隔着一个「行里的 onClick 真的把空串传下去
 * 了吗」。渲染级测试把这一环补上，而且完全不碰 profile：`fetchImpl` 是组件为测试
 * 留的注入口（`ComposerCreditsProps.fetchImpl`），请求被它接住、既不落地也不上网。
 *
 * ## 为什么断言的粒度是「URL 精确相等」
 *
 * `tests/account-select.test.ts` 已经锁住了下层：`withAccountAndRegion` 传空串会
 * 把 `accountId` 参数整个丢掉、`withAccountCleared` 才会保留成 `?accountId=`。
 * 本文件锁的是**更上一层**：组件确实走了 `withAccountCleared` 那条路。
 *
 * 只断言「fetch 被调用过」在这里等于没断言——账号行的 onClick 也会调 fetch，
 * 面板打开时还会发 status 与每账号读数请求。必须比对完整 URL，才能把「点了自动行」
 * 与「点了账号行」「面板自己刷新」区分开。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ComposerCredits } from '../src/client/ComposerCredits.tsx'
import type { ComposerCreditsSettingsScope } from '../src/client/ComposerCredits.tsx'
import { zh } from '../src/client/locales.ts'
import type { WbModelsSettingsKey } from '../src/client/locales.ts'
import {
  WB_ACCOUNT_CREDITS_PATH,
  WB_ACCOUNTS_SELECT_PATH,
  WB_STATUS_PATH,
} from '../src/status-paths.ts'
import type { WbCredits, WbStatusSnapshot } from '../src/status-paths.ts'

afterEach(() => { cleanup() })

const REGION = 'cn'
const ENDPOINT_ORIGIN = 'http://127.0.0.1:3080'

/**
 * 用真实中文文案表当译器。
 *
 * 组件缺省 `t` 是恒等函数（返回键名本身），那样 `aria-label` 会是
 * `'composer.switchToAuto'` 这个**键**而不是用户看到的话。用 `zh` 才是真实渲染，
 * 也才让「按可见文案取按钮」这条断言有意义。
 */
function translatorOf(): (key: WbModelsSettingsKey, params?: Record<string, unknown>) => string {
  return (key, params) => {
    const template: string = zh[key]
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
      const value = params[name]
      return value === undefined ? whole : String(value)
    })
  }
}

/** 一个能写设置的分区：`writable: true` 才让面板里的行可点。 */
function scopeOf(writable = true): ComposerCreditsSettingsScope {
  return { getSnapshot: () => ({ writable, value: {} }) }
}

interface AccountSpec {
  readonly id: string
  readonly name: string
  readonly selected: boolean
  readonly total: number
}

/** 造一份 `/status` 文档；形状照 `WbStatusSnapshot`，不手抄镜像类型。 */
function snapshotOf(accounts: readonly AccountSpec[]): WbStatusSnapshot {
  const TOKEN_EXPIRES_AT_MS = Date.now() + 30 * 86_400_000
  return {
    scannedAtMs: Date.now(),
    region: REGION,
    accounts: accounts.map(account => ({
      account: {
        id: account.id,
        accountName: account.name,
        domain: 'www.workbuddy.cn',
        region: REGION,
        source: 'dsh',
        tokenExpiresAtMs: TOKEN_EXPIRES_AT_MS,
        sourcePath: `/fake/workbuddy-vault/cn/${account.id}.json`,
        selected: account.selected,
      },
      credits: { total: account.total, packages: [], expiringSoon: 0 },
    })),
    skipped: [],
    models: [],
    totalCredits: accounts.reduce((sum, account) => sum + account.total, 0),
  }
}

interface RecordedCall {
  readonly url: string
  readonly method: string
}

interface Harness {
  readonly fetchImpl: typeof fetch
  readonly calls: readonly RecordedCall[]
  /** 只保留打到 `accounts/select` 上的调用——断言集中在它身上。 */
  selectCalls(): readonly RecordedCall[]
}

/**
 * 按 path 分派的 fetch 替身。
 *
 * 三个端点各自返回合理的最小文档：`/status` 给快照、`/account/credits` 给单个
 * 账号读数、`/accounts/select` 给一张成功回执。任何别的 URL 直接抛错——漏掉的
 * 端点会以「没有为 … 准备响应」暴露出来，而不是静默返回 undefined。
 */
function harnessOf(snapshot: WbStatusSnapshot): Harness {
  const calls: RecordedCall[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? 'GET'
    calls.push({ url, method })
    const parsed = new URL(url, ENDPOINT_ORIGIN)
    if (parsed.pathname === WB_STATUS_PATH) {
      return Response.json(snapshot)
    }
    if (parsed.pathname === WB_ACCOUNT_CREDITS_PATH) {
      const accountId = parsed.searchParams.get('accountId') ?? ''
      const credits: WbCredits = { total: 1, packages: [], expiringSoon: 0 }
      return Response.json({ accountId, credits })
    }
    if (parsed.pathname === WB_ACCOUNTS_SELECT_PATH) {
      return Response.json({ ok: true })
    }
    throw new Error(`没有为 ${method} ${url} 准备响应`)
  }) as typeof fetch
  return {
    fetchImpl,
    calls,
    selectCalls: () => calls.filter(call => call.url.startsWith(WB_ACCOUNTS_SELECT_PATH)),
  }
}

/** 挂载读数条，等首次 `/status` 落地，再点触发器把面板打开。 */
async function openPanel(harness: Harness): Promise<void> {
  render(
    <ComposerCredits
      region={REGION}
      settingsScope={scopeOf()}
      fetchImpl={harness.fetchImpl}
      t={translatorOf()}
    />,
  )
  // 首帧还没有快照，面板里会是空表；等 /status 落地后再开才测得到账号行。
  await waitFor(() => {
    expect(harness.calls.some(call => call.url.startsWith(WB_STATUS_PATH))).toBe(true)
  })
  fireEvent.click(triggerOf())
  await waitFor(() => {
    expect(screen.getByRole('button', { name: zh['composer.switchToAuto'] })).toBeDefined()
  })
}

/**
 * 触发器。
 *
 * 不能用可见文案取：它的可及名是「WB 模型 · 200 乙」这样拼出来的（区域名 + 数字
 * + 当前账号名），随快照变化。`aria-haspopup="dialog"` 是它独有的属性，面板里的
 * 行按钮都没有，用它来区分。
 */
function triggerOf(): HTMLElement {
  const trigger = document.querySelector<HTMLElement>('button.wbm-composer-trigger')
  if (trigger === null) throw new Error('读数条触发器没有渲染')
  return trigger
}

describe('「自动（按账户使用方式）」行的点击端到端', () => {
  it('有账号被选中时，点它发出 POST ?accountId=&region=cn（空串必须还在 URL 里）', async () => {
    const harness = harnessOf(snapshotOf([
      { id: 'aaaaaaaaaaaaaaaa', name: '甲', selected: true, total: 100 },
      { id: 'bbbbbbbbbbbbbbbb', name: '乙', selected: false, total: 200 },
    ]))
    await openPanel(harness)

    const autoButton = screen.getByRole<HTMLButtonElement>('button', { name: zh['composer.switchToAuto'] })
    expect(autoButton.disabled).toBe(false)
    fireEvent.click(autoButton)

    await waitFor(() => { expect(harness.selectCalls().length).toBe(1) })
    const [call] = harness.selectCalls()
    expect(call?.method).toBe('POST')
    // 整串相等，不是 contains：`withAccountAndRegion` 丢掉参数后得到的是
    // `?region=cn`，只查 `region=cn` 的话那种坏法照样通过。
    expect(call?.url).toBe(`${WB_ACCOUNTS_SELECT_PATH}?accountId=&region=${REGION}`)
    // 反向锁：URL 里必须真的出现那个空参数名。
    expect(new URL(call?.url ?? '', ENDPOINT_ORIGIN).searchParams.has('accountId')).toBe(true)
    expect(new URL(call?.url ?? '', ENDPOINT_ORIGIN).searchParams.get('accountId')).toBe('')
  })

  it('没有账号被选中时，自动行自己就是当前项', async () => {
    const harness = harnessOf(snapshotOf([
      { id: 'aaaaaaaaaaaaaaaa', name: '甲', selected: false, total: 100 },
    ]))
    await openPanel(harness)

    const autoButton = screen.getByRole<HTMLButtonElement>('button', { name: zh['composer.switchToAuto'] })
    const row = autoButton.closest('tr')
    expect(row).not.toBeNull()
    expect(row?.className).toBe('wbm-composer-panel-row-current')
    // 同一时刻账号行不该也标成当前项。
    const accountRow = screen.getByRole('button', { name: '切换到 甲' }).closest('tr')
    expect(accountRow?.className).toBe('')
  })

  it('没有账号被选中时，自动行按钮是禁用的（已经在自动上，没有可撤销的东西）', async () => {
    /*
     * 这条断言记录的是**实现的真实行为**，与任务说明里「此时按钮 disabled 为
     * false 才可点」这句相反，必须说清楚：
     *
     *   disabled={!canSwitch || switching !== undefined || currentRow === undefined}
     *
     * `currentRow === undefined`（没有任何账号被选中）第三个条件为真 ⇒ 禁用。
     * 语义上是对的：没有任何账号被手动选中，就说明现在**正在**按账户使用方式选号，
     * 这一行没有任何可撤销的状态；真有东西要撤销的正是「已选中某个账号」那种情形，
     * 那也是下一条用例走的路。src/ 不在本任务改动范围内，所以这里如实断言现状，
     * 而不是把测试写成实现没做到的样子。
     */
    const harness = harnessOf(snapshotOf([
      { id: 'aaaaaaaaaaaaaaaa', name: '甲', selected: false, total: 100 },
    ]))
    await openPanel(harness)

    const autoButton = screen.getByRole<HTMLButtonElement>('button', { name: zh['composer.switchToAuto'] })
    expect(autoButton.disabled).toBe(true)

    fireEvent.click(autoButton)
    // 禁用按钮不派发 click 处理器，因此不该产生任何 select 请求。
    expect(harness.selectCalls().length).toBe(0)
  })

  it('点账号行发的是非空 accountId（空串只由自动行产生）', async () => {
    const harness = harnessOf(snapshotOf([
      { id: 'aaaaaaaaaaaaaaaa', name: '甲', selected: false, total: 100 },
      { id: 'bbbbbbbbbbbbbbbb', name: '乙', selected: true, total: 200 },
    ]))
    await openPanel(harness)

    fireEvent.click(screen.getByRole('button', { name: '切换到 甲' }))
    await waitFor(() => { expect(harness.selectCalls().length).toBe(1) })
    const [call] = harness.selectCalls()
    expect(call?.method).toBe('POST')
    expect(call?.url).toBe(`${WB_ACCOUNTS_SELECT_PATH}?accountId=aaaaaaaaaaaaaaaa&region=${REGION}`)
    // 与自动行那条对照：这条 URL 里 accountId 有值，说明「空串」不是拼装函数
    // 的偶然产物，而是自动行独有的指令形态。
    expect(new URL(call?.url ?? '', ENDPOINT_ORIGIN).searchParams.get('accountId')).toBe('aaaaaaaaaaaaaaaa')
  })

  it('面板没打开时不渲染自动行（被测按钮只来自面板，不是页面上别的按钮）', async () => {
    const harness = harnessOf(snapshotOf([
      { id: 'aaaaaaaaaaaaaaaa', name: '甲', selected: true, total: 100 },
    ]))
    render(
      <ComposerCredits
        region={REGION}
        settingsScope={scopeOf()}
        fetchImpl={harness.fetchImpl}
        t={translatorOf()}
      />,
    )
    await waitFor(() => {
      expect(harness.calls.some(call => call.url.startsWith(WB_STATUS_PATH))).toBe(true)
    })
    expect(screen.queryByRole('button', { name: zh['composer.switchToAuto'] })).toBeNull()
    // 触发器自己在：否则上一条「查不到」可能只是因为组件压根没渲染。
    expect(triggerOf()).toBeDefined()
  })
})
