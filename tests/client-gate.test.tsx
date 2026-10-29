// @vitest-environment jsdom
/**
 * 输入框下方读数的**门控**（需求 R2、R4 的入口判定）。
 *
 * 这个组件决定「本会话用着本插件的模型时，才在输入框下方显示积分与账号」。
 * 它最容易出的两类错，都不是崩溃，而是**该出现时没出现 / 不该出现时出现了**：
 *
 * 1. **归属判错**。`workbuddy-models` 与 `workbuddy-models-global` 是前缀关系，
 *    任何宽松匹配都会让国内版把国际版的读数当成自己的。所以映射必须是一次精确
 *    查表，且不认原型链上的键（`constructor`、`toString`）。
 * 2. **开关读错**。`showCreditsInComposer` 的语义是「关掉才不显示」。写成
 *    「`!== true` 才显示」会让没有设置分区、分区还没读到值、或老配置里没有这个
 *    字段的会话集体消失——用户看到的是「装好了但什么都没出现」。
 *
 * 文件头里那条「门控与读数分成两个文件」的理由也在这里兑现：本文件只 import
 * React 与一个窄投影形状，不需要浏览器专属的 DSH 包，所以能在 jsdom 里直接跑。
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ComposerCreditsGate,
  composerVisible,
  regionOfProvider,
  selectedProviderOf,
} from '../src/client/ComposerCreditsGate.tsx'
import type { ComposerCreditsSettingsScope } from '../src/client/ComposerCredits.tsx'

afterEach(() => { cleanup() })

/** 一个不做任何网络请求的 fetch：门控不该触发读数，所以它不该被调到。 */
const neverFetch: typeof fetch = (async () => {
  throw new Error('门控不应该发起网络请求')
}) as unknown as typeof fetch

/** 构造一个设置分区；`value` 是配置对象，`writable` 控制面板行能否点。 */
function scopeOf(value: unknown, writable = false): ComposerCreditsSettingsScope {
  return {
    getSnapshot: () => ({ writable, value }),
  }
}

// ── provider → 区域 ──────────────────────────────────────────────────────

describe('provider 映射到区域', () => {
  it('两个 provider id 各自映射到自己那一侧', () => {
    expect(regionOfProvider('workbuddy-models')).toBe('cn')
    expect(regionOfProvider('workbuddy-models-global')).toBe('global')
  })

  it('前缀相近但不同的 id 不会被误认（这是本插件与 workbuddy 插件共存的前提）', () => {
    // dsh-connect-workbuddy 占用了这两个；它们不属于本插件。
    expect(regionOfProvider('workbuddy')).toBeUndefined()
    expect(regionOfProvider('workbuddy-global')).toBeUndefined()
    // 我们的 id 加上后缀也不该命中。
    expect(regionOfProvider('workbuddy-models-global-x')).toBeUndefined()
    expect(regionOfProvider('workbuddy-model')).toBeUndefined()
  })

  it('undefined / 空串 / 别家 provider 都不命中', () => {
    expect(regionOfProvider(undefined)).toBeUndefined()
    expect(regionOfProvider('')).toBeUndefined()
    expect(regionOfProvider('connect-trae-models')).toBeUndefined()
  })

  it('原型链上的键不会误命中（查表用 hasOwnProperty）', () => {
    expect(regionOfProvider('constructor')).toBeUndefined()
    expect(regionOfProvider('toString')).toBeUndefined()
    expect(regionOfProvider('__proto__')).toBeUndefined()
  })
})

// ── 投影里取「当前」选择 ─────────────────────────────────────────────────

describe('从 modelSelection 投影里取当前选择', () => {
  it('next 优先于 lastUsed', () => {
    expect(selectedProviderOf({
      lastUsed: { provider: 'workbuddy-models' },
      next: { provider: 'workbuddy-models-global' },
    })).toBe('workbuddy-models-global')
  })

  it('只有 lastUsed 时用它', () => {
    expect(selectedProviderOf({ lastUsed: { provider: 'workbuddy-models' } })).toBe('workbuddy-models')
  })

  it('next 存在但 provider 读不出来时不回落到 lastUsed', () => {
    // 用户刚换过选择，回落到上一个会把读数挂到已经不被选中的模型上。
    expect(selectedProviderOf({
      lastUsed: { provider: 'workbuddy-models' },
      next: {},
    })).toBeUndefined()
  })

  it('裸字符串也接受（宿主某版本就是它）', () => {
    expect(selectedProviderOf({ next: 'workbuddy-models' })).toBe('workbuddy-models')
  })

  it('空字符串当缺席处理', () => {
    expect(selectedProviderOf({ lastUsed: { provider: '' } })).toBeUndefined()
  })

  it('undefined 投影 → undefined', () => {
    expect(selectedProviderOf(undefined)).toBeUndefined()
  })

  it('结构不对的投影不抛', () => {
    expect(selectedProviderOf({ next: 42 as never })).toBeUndefined()
    expect(selectedProviderOf({ next: null as never })).toBeUndefined()
  })
})

// ── 显示开关 ─────────────────────────────────────────────────────────────

describe('showCreditsInComposer 开关', () => {
  it('缺省显示（配置里没这个字段时仍然出现）', () => {
    expect(composerVisible({})).toBe(true)
    expect(composerVisible(undefined)).toBe(true)
    expect(composerVisible(null)).toBe(true)
  })

  it('显式 true → 显示；显式 false → 隐藏', () => {
    expect(composerVisible({ showCreditsInComposer: true })).toBe(true)
    expect(composerVisible({ showCreditsInComposer: false })).toBe(false)
  })

  it('别的字段不影响判定', () => {
    expect(composerVisible({ enabled: false, showCreditsInComposer: true })).toBe(true)
  })

  it('volatile 包装的值也读得出来（不 unwrap 会把它当成「关掉」）', () => {
    // 配置在运行线上一律是 `{get(): T}` 活引用。直接读 `.showCreditsInComposer`
    // 会拿到 undefined —— 而按「关掉才不显示」的语义那恰好等于显示，看起来没坏；
    // 真正坏掉的是用户写了 false 却仍然显示。
    const volatile = { [Symbol.for('cosmokit.volatile')]: true, get: () => ({ showCreditsInComposer: false }) }
    expect(composerVisible(volatile)).toBe(false)
  })
})

// ── 组件渲染 ─────────────────────────────────────────────────────────────

describe('门控渲染', () => {
  it('不是本插件的模型 → 什么都不渲染', () => {
    const { container } = render(
      <ComposerCreditsGate
        modelSelection={{ next: { provider: 'connect-trae-models' } }}
        fetchImpl={neverFetch}
      />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('没有选中任何模型 → 什么都不渲染', () => {
    const { container } = render(<ComposerCreditsGate fetchImpl={neverFetch} />)
    expect(container.innerHTML).toBe('')
  })

  it('选中本插件模型 → 渲染出读数条', () => {
    render(
      <ComposerCreditsGate
        modelSelection={{ next: { provider: 'workbuddy-models' } }}
        fetchImpl={neverFetch}
      />,
    )
    // 触发器是读数组件唯一的按钮。
    expect(screen.getByRole('button')).toBeDefined()
  })

  it('国际版 provider 也渲染（两个区域都要露面）', () => {
    render(
      <ComposerCreditsGate
        modelSelection={{ next: { provider: 'workbuddy-models-global' } }}
        fetchImpl={neverFetch}
      />,
    )
    expect(screen.getByRole('button')).toBeDefined()
  })

  it('开关关掉时即使 provider 命中也不渲染', () => {
    const { container } = render(
      <ComposerCreditsGate
        modelSelection={{ next: { provider: 'workbuddy-models' } }}
        settingsScope={scopeOf({ showCreditsInComposer: false })}
        fetchImpl={neverFetch}
      />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('开关打开时渲染', () => {
    render(
      <ComposerCreditsGate
        modelSelection={{ next: { provider: 'workbuddy-models' } }}
        settingsScope={scopeOf({ showCreditsInComposer: true })}
        fetchImpl={neverFetch}
      />,
    )
    expect(screen.getByRole('button')).toBeDefined()
  })

  it('设置分区读不出值时按缺省显示（读不到意愿 ≠ 用户说不要）', () => {
    render(
      <ComposerCreditsGate
        modelSelection={{ next: { provider: 'workbuddy-models' } }}
        settingsScope={{ getSnapshot: () => { throw new Error('分区还没挂上') } }}
        fetchImpl={neverFetch}
      />,
    )
    expect(screen.getByRole('button')).toBeDefined()
  })

  it('设置分区完全缺席时仍然显示', () => {
    render(
      <ComposerCreditsGate
        modelSelection={{ next: { provider: 'workbuddy-models' } }}
        fetchImpl={neverFetch}
      />,
    )
    expect(screen.getByRole('button')).toBeDefined()
  })
})

// ── useProjection 钩子 ───────────────────────────────────────────────────

describe('useProjection 钩子优先于 prop', () => {
  it('两者都给时以钩子为准', () => {
    render(
      <ComposerCreditsGate
        useProjection={() => ({ next: { provider: 'connect-trae-models' } })}
        modelSelection={{ next: { provider: 'workbuddy-models' } }}
        fetchImpl={neverFetch}
      />,
    )
    // 钩子说别家 → 不渲染，尽管 prop 说我们家。
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('只有钩子时用钩子的值', () => {
    render(
      <ComposerCreditsGate
        useProjection={() => ({ next: { provider: 'workbuddy-models' } })}
        fetchImpl={neverFetch}
      />,
    )
    expect(screen.getByRole('button')).toBeDefined()
  })

  it('钩子返回 undefined 时不渲染', () => {
    const { container } = render(
      <ComposerCreditsGate useProjection={() => undefined} fetchImpl={neverFetch} />,
    )
    expect(container.innerHTML).toBe('')
  })
})
