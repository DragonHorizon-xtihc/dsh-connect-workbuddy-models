// @vitest-environment jsdom
/**
 * 账号行里的**积分包明细**：每条显示什么、按什么顺序、什么时候不画。
 *
 * ## 为什么这个文件单独存在
 *
 * 后端从第一版起就把 `credits.packages` 原样塞进 `/status` 的账号读数里（本机实测
 * 单账号 26 / 48 / 59 条），客户端却只把它 `reduce` 成一个临期合计。于是用户看到
 * 「积分 4,071」加一句「有 388 分在 3 天内到期」，却没有任何办法知道这 4,071 分是
 * 哪几个包、各自什么时候到期 —— 而「先用哪一份」正是这些数字唯一能支持的决策。
 *
 * 这不是回归修复：`src/client/` 里 `packages` 从头到尾只出现过一次（那个 `reduce`），
 * 从来没有画成列表。参考插件同样零渲染。
 *
 * ## 断言的着力点
 *
 * 明细是**纯展示**，所以能出错的地方只有三类，本文件的 describe 就按这三类分组：
 *
 * 1. **数值口径**：只显示「剩余 / 总量」。任何 `size - remain` 的推算都是需求之外
 *    的多余动作（用户明确选了口径），所以有一条专门反向锁 `11.95` 不出现在 DOM 里。
 * 2. **排序**：一次性包按到期升序、周期包垫底且不参与比较。混在一起会让一个只剩
 *    周期包的账号永远看起来「即将过期」——同一个坑在 `expiryFactsOf` 里踩过。
 * 3. **退化**：没有 `credits`、`packages` 为空、`expiresAtMs` 缺失时都不能画出
 *    `NaN` / `Invalid Date` / `0`，也不能画一个「0 个积分包」的空摘要。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { WbModelsCard, creditPackageRowsOf, creditPackageWhenText, formatAmount } from '../src/client/WbModelsCard.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { WbModelsSettingsKey } from '../src/client/locales.ts'
import type {
  WbAccountReading,
  WbCreditPackage,
  WbCredits,
  WbDiscoveredAccount,
  WbStatusSnapshot,
} from '../src/status-paths.ts'

afterEach(() => { cleanup() })

const DAY = 86_400_000
const NOW = Date.parse('2026-10-26T12:00:00+08:00')

/**
 * 子串直译器：把 `{count}` 之类占位符换成参数值，键名本身保留。
 *
 * 不直接用 `zh` 表：本文件有两条断言要分别验中文与英文的**真实文案**，
 * 其余断言只关心数字与顺序，用键名更好定位（`row.creditPackagesToggle` 不会
 * 与包名撞车）。需要真文案时显式传 `zh` 或 `en`。
 */
function translatorOf(table: Record<string, string>): (key: WbModelsSettingsKey, params?: Record<string, unknown>) => string {
  return (key, params) => {
    const template: string = table[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole))
  }
}

/** 一个最小账号读数的骨架。 */
function readingOf(id: string, credits: WbCredits | undefined): WbAccountReading {
  const account: WbDiscoveredAccount = {
    id,
    label: id,
    region: 'cn',
    source: 'dsh',
    sourcePath: `/fake/workbuddy-vault/cn/${id}.json`,
    live: false,
    refreshExpired: false,
    tokenExpiresAtMs: NOW + 365 * DAY,
    credential: {
      accessToken: 'tok',
      refreshToken: 'ref',
      expiresAtMs: NOW + 365 * DAY,
      domain: 'www.workbuddy.cn',
    },
  }
  return {
    account,
    ...credits === undefined ? {} : { credits },
    ...credits === undefined ? {} : { total: credits.total },
    selected: false,
  } as WbAccountReading
}

function snapshotOf(readings: readonly WbAccountReading[]): WbStatusSnapshot {
  return {
    scannedAtMs: NOW,
    region: 'cn',
    accounts: readings,
    skipped: [],
    models: [],
    totalCredits: readings.reduce((sum, reading) => sum + (reading.credits?.total ?? 0), 0),
  }
}

/**
 * 渲染一次卡片。
 *
 * `initialStatusByRegion` 是卡片为测试留的口子（effect 在 jsdom 里会跑，但首帧就该
 * 有内容，否则每条断言都要等一次网络）；`fetchImpl` 钉成同一个快照，避免轮询把
 * 已展开的明细冲掉。
 */
function renderCard(readings: readonly WbAccountReading[], table: Record<string, string> = {}): void {
  const snapshot = snapshotOf(readings)
  const fetchImpl = (async () => new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch
  render(createElement(WbModelsCard, {
    initialStatusByRegion: { cn: snapshot },
    t: translatorOf(table),
    fetchImpl,
  }))
}

/**
 * 点一下摘要行（明细默认展开，点它是**收起**）。
 *
 * 这个 helper 名字刻意不叫 expand/collapse：默认态变了两次（t32 折叠 → 用户要求展开），
 * 把动作写进名字会让调用点每次都得跟着改名。这里只表达「点摘要行」这一个动作，
 * 断言里各自说清当前期望的 `aria-expanded`。
 */
function clickToggle(): void {
  const toggle = document.querySelector<HTMLButtonElement>('.wbm-packages-toggle')
  if (toggle === null) throw new Error('没有渲染出积分包摘要行')
  fireEvent.click(toggle)
}

/**
 * 保证明细是展开的。
 *
 * 「默认展开」是产品要求（用户明确提过），但下游那些只关心数字与顺序的用例不该
 * 因为默认态再变一次就集体变红——它们要的是「明细可见」这个前提，不是「点了几次」。
 * 所以这里读 `aria-expanded` 决定要不要点，而不是无条件点一次。
 *
 * 默认态本身由 `describe('展开态：默认就把逐行摆出来，摘要行可收起')` 里那条
 * `aria-expanded === 'true'` 的断言单独钉住，不会被这个 helper 掩盖。
 */
function ensureExpanded(): void {
  const toggle = document.querySelector<HTMLButtonElement>('.wbm-packages-toggle')
  if (toggle === null) throw new Error('没有渲染出积分包摘要行')
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle)
}

/**
 * 把 React 渲染出来的文本节点拼回一句。
 *
 * React 会在相邻文本节点之间插 `<!-- -->` 注释分隔符（`88.05` 与 ` / ` 与 `100`），
 * 直接拿 `textContent` 会得到 `88.05<!-- --> / <!-- -->100`，断言「明细没渲染」的
 * 假阴性就是这么来的。这里统一剥掉。
 */
function textOf(node: Element | null): string {
  if (node === null) return ''
  return (node.textContent ?? '').replace(/<!--.*?-->/g, '')
}

/** 明细每一行的三段文本。 */
function rowsOf(): readonly { name: string, amount: string, when: string }[] {
  return Array.from(document.querySelectorAll('.wbm-packages-row')).map(row => ({
    name: textOf(row.querySelector('.wbm-packages-name')),
    amount: textOf(row.querySelector('.wbm-packages-amount')),
    when: textOf(row.querySelector('.wbm-muted')),
  }))
}

function pkg(
  packageName: string,
  remain: number,
  size: number,
  rest: { monthly?: boolean, expiresAtMs?: number, refreshAtMs?: number } = {},
): WbCreditPackage {
  return {
    packageName,
    remain,
    size,
    monthly: rest.monthly === true,
    ...rest.expiresAtMs === undefined ? {} : { expiresAtMs: rest.expiresAtMs },
    ...rest.refreshAtMs === undefined ? {} : { refreshAtMs: rest.refreshAtMs },
  }
}

function creditsOf(packages: readonly WbCreditPackage[], total?: number): WbCredits {
  return {
    total: total ?? packages.reduce((sum, item) => sum + item.remain, 0),
    packages,
    expiringSoon: 0,
  }
}

describe('每条明细说的是「剩余 / 总量」，不是已用量', () => {
  it('一条一次性包渲染成 88.05 / 100 加到期时间', () => {
    renderCard([readingOf('a', creditsOf([pkg('裂变包', 88.05, 100, { expiresAtMs: NOW + 6 * DAY })]))])
    ensureExpanded()
    const rows = rowsOf()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.amount).toBe('88.05 / 100')
    expect(rows[0]?.name).toBe('裂变包')
    // 一次性包说的是「到期」，不是「刷新」。
    expect(rows[0]?.when).toContain('row.creditPackageExpires')
    expect(rows[0]?.when).not.toContain('row.creditPackageMonthly')
  })

  it('反向锁：DOM 里不出现 100 - 88.05 = 11.95 这个推算法的「已用量」', () => {
    renderCard([readingOf('a', creditsOf([pkg('裂变包', 88.05, 100, { expiresAtMs: NOW + 6 * DAY })]))])
    ensureExpanded()
    // 用户明确选了口径：只显示剩余与总量。多算一步就是需求之外的动作，
    // 而且那个数在界面上没有对应的操作。
    expect(textOf(document.body)).not.toContain('11.95')
    expect(textOf(document.body)).toContain('88.05 / 100')
  })

  it('整数不带多余的小数位，浮点尾巴被收掉', () => {
    // 上游真给到小数第 8 位（88.05000013），原样渲染既读不了也对不上总量；
    // 但直接 Math.round 会把 88.05 抹成 88，差的那点够让账号突然「不够用」。
    expect(formatAmount(100)).toBe('100')
    expect(formatAmount(88.05000013)).toBe('88.05')
    expect(formatAmount(479.43)).toBe('479.43')
    expect(formatAmount(0)).toBe('0')
    expect(formatAmount(Number.NaN)).toBe('—')
    expect(formatAmount(Number.POSITIVE_INFINITY)).toBe('—')
  })

  it('包名照上游原文显示，不翻译不截断', () => {
    const longName = 'CodeBuddy个人版国内运营裂变包'
    renderCard([readingOf('a', creditsOf([pkg(longName, 1, 2, { expiresAtMs: NOW + DAY })]))])
    ensureExpanded()
    expect(rowsOf()[0]?.name).toBe(longName)
  })
})

describe('周期包垫底且不参与到期排序', () => {
  it('一次性包按到期升序，周期包统一排在最后', () => {
    // 三条一次性包故意乱序：晚到期排前、早到期排后，另有一条无到期时间。
    const credits = creditsOf([
      pkg('晚到期', 10, 10, { expiresAtMs: NOW + 30 * DAY }),
      pkg('周期包', 479.43, 500, { monthly: true, refreshAtMs: NOW + 2 * DAY }),
      pkg('无到期', 5, 5),
      pkg('早到期', 20, 20, { expiresAtMs: NOW + DAY }),
    ])
    expect(creditPackageRowsOf(credits).map(row => row.packageName))
      .toEqual(['早到期', '晚到期', '无到期', '周期包'])
  })

  it('周期包标 monthly、带 refreshAtMs，且不带 expiresAtMs', () => {
    const rows = creditPackageRowsOf(creditsOf([
      pkg('周期包', 479.43, 500, { monthly: true, refreshAtMs: NOW + 2 * DAY }),
    ]))
    expect(rows[0]?.monthly).toBe(true)
    expect(rows[0]?.refreshAtMs).toBe(NOW + 2 * DAY)
    expect(rows[0]?.expiresAtMs).toBeUndefined()
  })

  it('渲染出来的周期包说的是「周期刷新」，一次到期文案都不出现', () => {
    renderCard([readingOf('a', creditsOf([
      pkg('周期包', 479.43, 500, { monthly: true, refreshAtMs: NOW + 2 * DAY }),
    ]))])
    ensureExpanded()
    const rows = rowsOf()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.when).toContain('row.creditPackageMonthly')
    expect(rows[0]?.when).toContain('row.creditPackageRefreshes')
    expect(rows[0]?.when).not.toContain('row.creditPackageExpires')
  })

  it('周期包与一次性包同时存在时，周期包永远在最后（即使它的时间更早）', () => {
    const credits = creditsOf([
      pkg('周期包', 100, 100, { monthly: true, refreshAtMs: NOW + DAY }),
      pkg('一次性', 100, 100, { expiresAtMs: NOW + 90 * DAY }),
    ])
    const names = creditPackageRowsOf(credits).map(row => row.packageName)
    expect(names[0]).toBe('一次性')
    expect(names[1]).toBe('周期包')
  })
})

describe('退化输入不画出 NaN / Invalid Date / 空块', () => {
  it('没有 credits 时整块不渲染（连摘要行都没有）', () => {
    renderCard([readingOf('a', undefined)])
    expect(document.querySelector('.wbm-packages')).toBeNull()
    expect(screen.queryByText(/row\.creditPackagesToggle/)).toBeNull()
  })

  it('packages 是空数组时整块不渲染', () => {
    renderCard([readingOf('a', creditsOf([], 0))])
    expect(document.querySelector('.wbm-packages')).toBeNull()
  })

  it('到期时间缺失时说「无到期信息」，不出现 NaN / Invalid Date / 0', () => {
    renderCard([readingOf('a', creditsOf([pkg('无到期', 5, 5)]))])
    ensureExpanded()
    const rows = rowsOf()
    expect(rows[0]?.when).toBe('row.creditPackageNoExpiry')
    const body = textOf(document.body)
    expect(body).not.toContain('NaN')
    expect(body).not.toContain('Invalid Date')
  })

  it('到期时间是非有限数时同样退化，不渲染出一个假的 1970 年', () => {
    // `NaN` 在投影层就被丢掉（`Number.isFinite` 判否），所以那一行没有 `expiresAtMs`；
    // `-1` 是有限数，投影层**不**替它编造含义（只有 `formatTime` 在渲染期把它判为
    // 无效），因此它留在字段上、界面照样说「无到期信息」。
    //
    // 顺序不作断言：`undefined` 排在所有有值的一次性包之后（见 `creditPackageRowsOf`
    // 的排序规则），所以这里只按包名取行，不按下标取。
    const rows = creditPackageRowsOf(creditsOf([
      pkg('坏时间', 5, 5, { expiresAtMs: Number.NaN }),
      pkg('负时间', 6, 6, { expiresAtMs: -1 }),
    ]))
    const byName = (name: string): typeof rows[number] | undefined => rows.find(row => row.packageName === name)
    expect(rows).toHaveLength(2)
    expect(byName('坏时间')?.expiresAtMs).toBeUndefined()
    expect(byName('负时间')?.expiresAtMs).toBe(-1)
    // 两者在界面上的结果相同：都是「无到期信息」，都不出现 1970 / NaN / Invalid Date。
    const t = translatorOf({})
    expect(creditPackageWhenText(t, { ...byName('负时间')! })).toBe('row.creditPackageNoExpiry')
    expect(creditPackageWhenText(t, { ...byName('坏时间')! })).toBe('row.creditPackageNoExpiry')
  })
})

describe('展开态：默认就把逐行摆出来，摘要行可收起', () => {
  it('默认展开：摘要行写条数，明细行立刻在 DOM 里', () => {
    renderCard([readingOf('a', creditsOf([
      pkg('p1', 1, 1, { expiresAtMs: NOW + DAY }),
      pkg('p2', 2, 2, { expiresAtMs: NOW + 2 * DAY }),
      pkg('p3', 3, 3, { expiresAtMs: NOW + 3 * DAY }),
    ]))])
    const toggle = document.querySelector<HTMLButtonElement>('.wbm-packages-toggle')
    expect(toggle).not.toBeNull()
    // 判决性：默认态是 true。用户明确要求「积分包需要默认展开」——这条断言就是
    // 那个要求的机器可读形式，改回 false 必须让它变红。
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(textOf(toggle)).toBe('row.creditPackagesToggle')
    expect(document.querySelectorAll('.wbm-packages-row')).toHaveLength(3)
  })

  it('点一下收起，再点一下展开', () => {
    renderCard([readingOf('a', creditsOf([pkg('p1', 1, 1, { expiresAtMs: NOW + DAY })]))])
    // 默认已展开，所以第一次点击是「收起」。
    clickToggle()
    expect(document.querySelectorAll('.wbm-packages-row')).toHaveLength(0)
    const toggle = document.querySelector<HTMLButtonElement>('.wbm-packages-toggle')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle as HTMLButtonElement)
    expect(document.querySelectorAll('.wbm-packages-row')).toHaveLength(1)
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
  })

  it('摘要行带上真实条数（占位符被替换，不是键名原文）', () => {
    renderCard(
      [readingOf('a', creditsOf([
        pkg('p1', 1, 1, { expiresAtMs: NOW + DAY }),
        pkg('p2', 2, 2, { expiresAtMs: NOW + 2 * DAY }),
      ]))],
      { 'row.creditPackagesToggle': '{count} 个积分包' },
    )
    expect(textOf(document.querySelector('.wbm-packages-toggle'))).toBe('2 个积分包')
  })

  it('59 条默认就全在 DOM 里（本机实测最多的一个账号）', () => {
    // 59 条不会把下面的签到按钮挤出屏幕：列表自身 `max-height:220px; overflow-y:auto`
    // （`src/client/styles.ts` 的 `.wbm-packages-list`），撑到 220px 后内部滚动。
    const many = Array.from({ length: 59 }, (_, index) =>
      pkg(`包${index}`, index + 1, 100, { expiresAtMs: NOW + (index + 1) * DAY }))
    renderCard([readingOf('a', creditsOf(many))])
    expect(document.querySelectorAll('.wbm-packages-row')).toHaveLength(59)
    clickToggle()
    expect(document.querySelectorAll('.wbm-packages-row')).toHaveLength(0)
  })

  it('列表容器带可滚动的样式类（默认展开下的高度约束）', () => {
    renderCard([readingOf('a', creditsOf([pkg('p1', 1, 1, { expiresAtMs: NOW + DAY })]))])
    const list = document.querySelector('.wbm-packages-list')
    expect(list).not.toBeNull()
    // 类是样式契约的另一半：没有它，59 条的默认展开就是一次视觉事故。
    expect(list?.className).toContain('wbm-packages-list')
  })
})

describe('文案走 locale 键，中英各一份', () => {
  it('中文表：摘要与逐行文案是真的中文，看不到键名', () => {
    renderCard([readingOf('a', creditsOf([
      pkg('早到期', 20, 20, { expiresAtMs: NOW + DAY }),
      pkg('周期包', 479.43, 500, { monthly: true, refreshAtMs: NOW + 2 * DAY }),
    ]))], zh)
    const toggle = document.querySelector('.wbm-packages-toggle')
    expect(textOf(toggle)).toBe('2 个积分包')
    ensureExpanded()
    const body = textOf(document.body)
    expect(body).toContain('周期刷新')
    expect(body).toContain('下次刷新')
    expect(body).not.toContain('row.creditPackage')
  })

  it('英文表：摘要与逐行文案是真的英文，看不到键名', () => {
    renderCard([readingOf('a', creditsOf([
      pkg('early', 20, 20, { expiresAtMs: NOW + DAY }),
      pkg('monthly', 479.43, 500, { monthly: true, refreshAtMs: NOW + 2 * DAY }),
    ]))], en)
    const toggle = document.querySelector('.wbm-packages-toggle')
    expect(textOf(toggle)).toBe('2 credit package(s)')
    ensureExpanded()
    const body = textOf(document.body)
    expect(body).toContain('monthly refresh')
    expect(body).toContain('next refresh')
    expect(body).not.toContain('row.creditPackage')
  })

  it('两张表覆盖同一组键（漏一个就会渲染出键名原文）', () => {
    const keys: WbModelsSettingsKey[] = [
      'row.creditPackagesToggle',
      'row.creditPackageExpires',
      'row.creditPackageMonthly',
      'row.creditPackageRefreshes',
      'row.creditPackageNoExpiry',
    ]
    for (const key of keys) {
      expect(typeof zh[key]).toBe('string')
      expect(zh[key].length).toBeGreaterThan(0)
      expect(typeof en[key]).toBe('string')
      expect(en[key].length).toBeGreaterThan(0)
    }
  })
})
