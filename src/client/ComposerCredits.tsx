/**
 * 输入框下方的 WorkBuddy 积分读数（`conversation.input.left`）。
 *
 * ## 形态
 *
 * 一行可点的小读数：`WB 模型 · 1,072` 后面跟着当前账号名。行内**没有**刷新
 * 按钮——这一行与外壳自己的权限 / 模型 / 代理控件共享宽度，每多一个控件都是别人
 * 的空间，手动刷新放在展开的面板里。
 *
 * 点击展开一个锚定在读数上方的面板：一张表，该区域每个账号一行（昵称 + 剩余积分
 * + 到期时间），点行即切换账号。
 *
 * ## 三个刻意的选择
 *
 * 1. **每账号数字只在面板打开时抓。** 读数本身 5 分钟刷一次；如果顺带把每个账号
 *    都读一遍，上游读请求数会乘以账号数——一个没人看的表格不该收这份钱。
 * 2. **读不到的余额显示 `—`，绝不显示 `0`。** 上游在那种情况下就是不返回该字段，
 *    正是为了让这里没法替账号断言一个错误的数字。
 * 3. **失败保留上一次成功的数值**，并在面板底部说明「刷新失败」。读不到 ≠ 余额
 *    变成 0；一个几乎肯定没变的余额，旧数字比空白有用。
 *
 * ## 锚定与关闭
 *
 * `useAnchoredPosition` / `useDismissOnOutsidePointer` 在本文件内就地实现（约 80
 * 行 DOM 几何），不从 `@deepseek-ai/dsh-client-ui-primitives` 导入：那会让这个组件
 * 在 Node 测试里无法渲染（该包会拉 `*.module.css` 与更多 DSH 依赖）。判断逻辑照
 * `plugins/dsh-connect-workbuddy/src/client/popover.ts` 逐条沿用——向上展开、视口
 * 收边、`scroll` capture/resize/自身尺寸变化重测、pointerdown 落在触发器与面板
 * 之外即关闭。
 *
 * @module dsh-connect-workbuddy-models/client/ComposerCredits
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'
import { createPortal } from 'react-dom'
import {
  DEFAULT_EXPIRY_WARN_DAYS,
  DAY_MS,
  EXPIRY_WARN_DAYS_MAX,
  EXPIRY_WARN_DAYS_MIN,
  WB_ACCOUNT_CREDITS_PATH,
  WB_ACCOUNTS_SELECT_PATH,
  WB_PROVIDERS,
  WB_PROVIDER_REGIONS,
  WB_STATUS_PATH,
  wbRegionOfProvider,
  withAccountAndRegion,
  withAccountCleared,
  withAccountId,
  withRegion,
} from '../status-paths.ts'
import type { WbAccountReading, WbCredits, WbRegion, WbStatusSnapshot } from '../status-paths.ts'
import type { WbModelsSettingsKey } from './locales.ts'
import { WB_MODELS_COMPOSER_CSS } from './styles.ts'

/**
 * 读数样式在**模块求值阶段**就注入。
 *
 * 设置卡片可能永远不被渲染（用户没打开设置面板），而读数要立刻可用。参考项目
 * 当年把两段样式揉在卡片里，结果在没有卡片渲染的宿主上，读数渲染成一个默认按钮框、
 * 面板因为没有 `position: fixed` 而出现在任何地方都不在的位置上。
 *
 * 幂等靠 `data-plugin-css` 去重：宿主可能把同一个 bundle 求值两次（热重载、
 * profile 里两份条目），重复 `<style>` 不会重复生效，但会让后来者无法判断是否
 * 已经注入过。
 */
if (typeof document !== 'undefined') {
  const cssId = 'dsh-connect-workbuddy-models/composer-credits.css'
  if (document.querySelector(`style[data-plugin-css="${cssId}"]`) === null) {
    const styleTag = document.createElement('style')
    styleTag.dataset['plugin'] = 'dsh-connect-workbuddy-models'
    styleTag.dataset['pluginCss'] = cssId
    styleTag.textContent = WB_MODELS_COMPOSER_CSS
    document.head.appendChild(styleTag)
  }
}

/**
 * 读数自动刷新周期：5 分钟。
 *
 * 积分余额变化的尺度是「多少次模型调用」，不是秒；每次读都是一次上游只读调用。
 */
export const COMPOSER_CREDITS_REFRESH_INTERVAL_MS = 300_000

/** 读数与面板共用的注入面。 */
export interface ComposerCreditsInjected {
  t: (key: WbModelsSettingsKey, params?: Record<string, unknown>) => string
  /**
   * 设置分区，来自 configForms / settingsScope 镜像。
   *
   * 放在注入面里（而不仅是组件 props），是因为入口的 `inject()` 要按这个键名
   * 回值；面板里的行只在它可写时才可点。
   */
  settingsScope?: ComposerCreditsSettingsScope
}

/** 面板用到的设置分区面（已收窄，与卡片同一形状）。 */
export interface ComposerCreditsSettingsScope {
  getSnapshot(): { writable?: boolean; value?: unknown }
  subscribe?(listener: () => void): () => void
  set?(field: string, value: unknown): Promise<void> | void
}

export interface ComposerCreditsProps extends Partial<ComposerCreditsInjected> {
  /**
   * 会话当前选中模型所属的 provider route。
   *
   * 不是本插件的 provider 时（或投影还没落地时）什么都不渲染。
   */
  provider?: string
  /** 该读哪个区域的余额；缺省从 `provider` 反查。 */
  region?: WbRegion
  /**
   * 设置分区，来自 configForms / settingsScope 镜像。
   *
   * 存在时面板里的行才可点——一个切不动账号的面板不能装作能切。
   */
  settingsScope?: ComposerCreditsSettingsScope
  /** 测试注入的 fetch；生产走全局 fetch。 */
  fetchImpl?: typeof fetch
}

/**
 * 本插件负责的 provider 集合，来自共享契约层。
 *
 * 刻意**不**在这里再抄一份字面量表：`workbuddy-models` 这个 id 与
 * `dsh-connect-workbuddy` 的 `workbuddy` 只差一个后缀，两边各抄一份极容易抄错，
 * 而抄错的后果是读数挂到别的插件的模型上。这里只是把契约层的表重新导出一次，
 * 方便调用方按「provider 集合」的语义使用它。
 */
export const WB_COMPOSER_PROVIDERS: Readonly<Record<string, WbRegion>> = WB_PROVIDER_REGIONS

/** 千分位格式化。非有限数返回 `—`，绝不返回 `0`。 */
export function formatCredits(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  const rounded = Math.round(value)
  try {
    return rounded.toLocaleString('zh-CN')
  } catch {
    return String(rounded)
  }
}

/** 把一个毫秒时刻格式化成时钟；无效返回 undefined。 */
function formatClock(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined
  try {
    return new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return undefined
  }
}

/** 把一个毫秒时刻格式成本地日期时间；无效返回 undefined。 */
export function formatExpiry(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined
  try {
    return new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return undefined
  }
}

/** 距离某个时刻还有多少整天（向下取整，最小 0）。 */
export function daysUntil(ms: number | undefined, nowMs: number): number | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined
  return Math.max(0, Math.floor((ms - nowMs) / DAY_MS))
}

/**
 * 从 `/status` 的配置回显里取临期窗口（天）。
 *
 * 这里曾经硬编码 `DEFAULT_EXPIRY_WARN_DAYS`，于是同一个数字在三个地方各算一遍：
 * 宿主的排序层按用户窗口选号、宿主探测层按用户窗口算 `expiringSoon`，而面板的
 * 「还有 N 天」标红判据永远是 3 天。用户把提醒改成 30 天，卡片与设置页显示 30 天，
 * 面板却只在 3 天内标红——看起来像「有的账号没被算进临期」。
 *
 * 取值顺序：`config.expiryWarnDays` → 兜底 `DEFAULT_EXPIRY_WARN_DAYS`。读不到配置
 * （老宿主、`/status` 还没回来、字段缺失）时用兜底是**正确**的退化，而不是隐藏：
 * 它不是「账号不可用」这类会让用户困惑的状态，只是标红判据的一个默认值。
 */
export function warnDaysOf(snapshot: WbStatusSnapshot | undefined): number {
  const configured = snapshot?.config?.expiryWarnDays
  if (typeof configured !== 'number' || !Number.isFinite(configured)) {
    return DEFAULT_EXPIRY_WARN_DAYS
  }
  return Math.min(EXPIRY_WARN_DAYS_MAX, Math.max(EXPIRY_WARN_DAYS_MIN, Math.round(configured)))
}

/** 一个账号在面板里的一行。 */
export interface ComposerAccountRow {
  id: string
  name: string
  selected: boolean
  /** 读不到时缺省——**不是** `0`。 */
  credits?: number
  expiryMs?: number
}

/** 把状态快照摊成面板行：账号来自快照，数字优先用面板自己抓到的读数。 */
export function accountRowsOf(
  snapshot: WbStatusSnapshot | undefined,
  creditsById: Readonly<Record<string, WbCredits>>,
): readonly ComposerAccountRow[] {
  const accounts: readonly WbAccountReading[] = snapshot?.accounts ?? []
  return accounts.map(reading => {
    const fetched = creditsById[reading.account.id]
    const credits = fetched ?? reading.credits
    const total = credits?.total
    const expiry = credits?.nearestExpiryMs
    return {
      id: reading.account.id,
      name: reading.account.accountName === '' ? reading.account.id.slice(0, 8) : reading.account.accountName,
      selected: reading.account.selected,
      ...total === undefined || !Number.isFinite(total) ? {} : { credits: total },
      ...expiry === undefined || !Number.isFinite(expiry) ? {} : { expiryMs: expiry },
    }
  })
}

// ── 锚定与关闭（就地实现，理由见文件头）──────────────────────────────────

interface AnchoredOptions {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  panelRef: RefObject<HTMLElement | null>
  side: 'top' | 'bottom'
  gap: number
  margin: number
}

/**
 * 让一个 `position: fixed` 的浮动元素贴住它的触发器。
 *
 * 用 `useLayoutEffect`：第一次测量发生在打开面板的那次提交里，于是收边用的是真实
 * 尺寸，面板不会先在错的位置闪一下。
 */
function useAnchoredPosition(options: AnchoredOptions): CSSProperties | null {
  const { open, anchorRef, panelRef, side, gap, margin } = options
  const [position, setPosition] = useState<CSSProperties | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return undefined
    }
    const place = (): void => {
      const rect = anchorRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const panel = panelRef.current
      const width = panel?.offsetWidth ?? 0
      const height = panel?.offsetHeight ?? 0
      let left = rect.left
      let top = side === 'top' ? rect.top - gap - height : rect.bottom + gap
      // 只在尺寸已知的那个轴上收边：测到 0 会把它钉死在 margin 上。
      if (width > 0) left = Math.min(Math.max(left, margin), window.innerWidth - width - margin)
      if (height > 0) top = Math.min(Math.max(top, margin), window.innerHeight - height - margin)
      setPosition({ left, top })
    }
    place()
    // capture 阶段：祖先滚动容器也会移动触发器，冒泡阶段的 window 监听看不到。
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    // 面板自身高度会在两个事件之外变化（多出一行状态），过期的收边会让它越过
    // 必须保持的 margin。jsdom 里没有 ResizeObserver，所以要有守卫。
    const panel = panelRef.current
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined' && panel !== null) {
      observer = new ResizeObserver(place)
      observer.observe(panel)
    }
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, anchorRef, panelRef, side, gap, margin])

  return position
}

/** pointerdown 落在触发器与面板之外就关闭。面板被 portal 到 body，所以算「里面」。 */
function useDismissOnOutsidePointer(
  root: RefObject<HTMLElement | null>,
  open: boolean,
  setOpen: (open: boolean) => void,
  portal?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return undefined
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node
        && root.current?.contains(event.target) !== true
        && portal?.current?.contains(event.target) !== true) {
        setOpen(false)
      }
    }
    // `pointerdown` 而不是 `click`：按下即收，与外壳自己的浮层手感一致，且早于
    // 底部元素的 click 生效。
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('pointerdown', closeOutside) }
  }, [root, open, setOpen, portal])
}

// ── 组件 ─────────────────────────────────────────────────────────────────

const identityT = (key: WbModelsSettingsKey): string => key

/** 尽力解析一份 JSON；失败给出可读错误。 */
async function readJson(response: Response): Promise<Record<string, unknown>> {
  let payload: Record<string, unknown> = {}
  try {
    payload = await response.json() as Record<string, unknown>
  } catch {
    payload = {}
  }
  if (!response.ok) {
    const message = typeof payload['error'] === 'string' ? payload['error'] : `HTTP ${response.status}`
    throw new Error(message)
  }
  return payload
}

/**
 * 读设置分区的当前快照；读不出来就当「不可写」。
 *
 * 分区的 `getSnapshot()` 在它还没挂上、或上游实现换过形状时会抛。这个异常**不能**
 * 冒到渲染层：那条路会把整个读数条（连同账号切换面板）一起炸掉，而用户只是想看
 * 一眼积分。判成「不可写」的后果只是面板里的行不可点，比整块消失轻得多。
 */
function snapshotOf(
  scope: ComposerCreditsSettingsScope | undefined,
): { writable?: boolean; value?: unknown } | undefined {
  if (scope === undefined) return undefined
  try {
    return scope.getSnapshot()
  } catch {
    return undefined
  }
}

export function ComposerCredits(props: ComposerCreditsProps) {
  const t = props.t ?? identityT
  const fetchImpl = props.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined)
  const settingsScope = props.settingsScope

  // provider → 区域，一次查表：归属判定与区域选择是**同一个**查询，于是不存在
  // 两份会各自漂移的规则副本。`wbRegionOfProvider` 用的是 `hasOwnProperty` 而不是
  // `in`/真值判断，所以 `constructor`、`toString` 这类原型链上的键不会被误判成
  // 本插件的 provider。
  const region = props.region
    ?? (props.provider === undefined ? undefined : wbRegionOfProvider(props.provider))

  const [snapshot, setSnapshot] = useState<WbStatusSnapshot | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [switching, setSwitching] = useState<string | undefined>(undefined)
  const [lastRefresh, setLastRefresh] = useState<number | undefined>(undefined)
  const [open, setOpen] = useState(false)
  /** 面板自己抓到的每账号读数；只在面板打开期间累积。 */
  const [creditsById, setCreditsById] = useState<Record<string, WbCredits>>({})
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const position = useAnchoredPosition({
    open: open && region !== undefined,
    anchorRef: rootRef,
    panelRef,
    // 输入框在窗口底部，向下展开会开到屏幕外。
    side: 'top',
    gap: 8,
    margin: 12,
  })
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

  /**
   * 读一次该区域的状态文档。
   *
   * 失败时**保留**上一次的值并置 `failed`：读不到不等于余额变成 0。一个几乎肯定
   * 没变的余额，旧数字比空白有用。
   */
  const fetchStatus = useCallback(async (signal?: AbortSignal): Promise<void> => {
    if (fetchImpl === undefined || region === undefined || inFlight.current) return
    inFlight.current = true
    if (mounted.current) setBusy(true)
    try {
      const response = await fetchImpl(withRegion(WB_STATUS_PATH, region), {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      const payload = await readJson(response)
      if (!mounted.current || signal?.aborted === true) return
      setSnapshot(payload as unknown as WbStatusSnapshot)
      setLastRefresh(Date.now())
      setFailed(false)
    } catch {
      if (mounted.current && signal?.aborted !== true) setFailed(true)
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }, [fetchImpl, region])

  /**
   * 拉每个账号的积分明细，只在面板打开期间付这份钱。
   *
   * 单账号路由逐个读（`/account/credits?accountId=`），不做并发上限以外的优化：
   * 账号数就是本机登录数，个位数。
   *
   * 任一账号失败就跳过它、保留它上一次的值——表格退回状态文档里的数字，于是
   * 「读失败」不会连带把那一行**删掉**或清零。
   */
  const fetchAccountCredits = useCallback(async (signal?: AbortSignal): Promise<void> => {
    if (fetchImpl === undefined || region === undefined) return
    const accounts = snapshot?.accounts ?? []
    if (accounts.length === 0) return
    const settled = await Promise.all(accounts.map(async reading => {
      try {
        const response = await fetchImpl(withAccountId(WB_ACCOUNT_CREDITS_PATH, reading.account.id), {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
          ...signal === undefined ? {} : { signal },
        })
        const payload = await readJson(response)
        const credits = payload['credits']
        return typeof credits === 'object' && credits !== null
          ? [reading.account.id, credits as WbCredits] as const
          : undefined
      } catch {
        return undefined
      }
    }))
    if (!mounted.current || signal?.aborted === true) return
    const readable = settled.filter((entry): entry is readonly [string, WbCredits] => entry !== undefined)
    if (readable.length === 0) {
      // 一个都没读到：这是失败，不是「所有账号余额都是 0」。置 failed 让面板底部
      // 说话，表格继续用状态文档里的数字。
      setFailed(true)
      return
    }
    setCreditsById(current => {
      const next = { ...current }
      for (const [id, credits] of readable) next[id] = credits
      return next
    })
    setLastRefresh(Date.now())
  }, [fetchImpl, region, snapshot])

  // 挂载即读一次，之后按 5 分钟续。定时器在第一次读**落地之后**才启动，慢上游不会
  // 叠出多个并发读。
  useEffect(() => {
    if (region === undefined) return undefined
    let cancelled = false
    let timer: number | undefined
    const controller = new AbortController()
    void fetchStatus(controller.signal).finally(() => {
      if (cancelled) return
      timer = window.setInterval(() => { void fetchStatus(controller.signal) }, COMPOSER_CREDITS_REFRESH_INTERVAL_MS)
    })
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearInterval(timer)
      controller.abort()
    }
  }, [region, fetchStatus])

  // 面板打开：立刻抓每账号数字，并在面板开着的时候重新校验一次——面板可能被
  // 长时间打开，读数会过期。关闭即 abort，没人看就不付钱。
  useEffect(() => {
    if (!open || region === undefined) return undefined
    const controller = new AbortController()
    void fetchAccountCredits(controller.signal)
    return () => { controller.abort() }
  }, [open, region, fetchAccountCredits])

  // Escape 关闭面板，与相邻浮层一致。
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  /**
   * 切换账号，然后立刻重抓。
   *
   * 走 `/accounts/select?accountId=&region=`。写完之后**必须**重抓：不重抓的话，
   * 读数与面板上的「当前选用」还会描述切换前的那个账号。
   *
   * 空串是一条正式指令：「交还给账户使用方式」。它必须真的出现在 query 里
   * （`?accountId=`），所以不能走 `withAccountAndRegion` —— 那个函数在
   * `accountId === ''` 时会把参数整个丢掉，后端收到的是「参数没传」，只能回 400，
   * 于是「交还」这个能力在 HTTP 面上根本表达不出来。拼 URL 走 `withAccountCleared`。
   */
  const switchTo = useCallback(async (accountId: string): Promise<void> => {
    if (fetchImpl === undefined || region === undefined || switching !== undefined) return
    setSwitching(accountId)
    try {
      const url = accountId === ''
        ? withAccountCleared(WB_ACCOUNTS_SELECT_PATH, region)
        : withAccountAndRegion(WB_ACCOUNTS_SELECT_PATH, accountId, region)
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
      })
      await readJson(response)
      await fetchStatus()
      await fetchAccountCredits()
    } catch {
      if (mounted.current) setFailed(true)
    } finally {
      if (mounted.current) setSwitching(undefined)
    }
  }, [fetchImpl, region, switching, fetchStatus, fetchAccountCredits])

  if (region === undefined) return null

  const rows = accountRowsOf(snapshot, creditsById)
  const currentRow = rows.find(row => row.selected)
  /**
   * 读数上的数字。
   *
   * 优先用当前账号的读数，没有才用池子的总和：这一行回答的是「我现在还能用多少」，
   * 而池子总和是卡片上的口径。两者都在同一个状态文档里，所以不会互相矛盾。
   */
  const total = currentRow?.credits ?? snapshot?.totalCredits
  const valueText = formatCredits(total)
  const label = t(region === 'cn' ? 'composer.pointsCn' : 'composer.pointsGlobal')
  const canSwitch = snapshotOf(settingsScope)?.writable === true
  const nowMs = Date.now()
  const warnDays = warnDaysOf(snapshot)

  return (
    <span ref={rootRef} className="wbm-composer-credits">
      <button
        type="button"
        className="wbm-composer-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={failed ? t('composer.refreshFailed') : undefined}
        onClick={() => { setOpen(!open) }}
      >
        <span>{label}</span>
        <span aria-hidden="true">·</span>
        <span className="wbm-composer-amount">{valueText}</span>
        {currentRow === undefined ? null : (
          <span className="wbm-composer-user">{currentRow.name}</span>
        )}
        {failed ? <span className="wbm-composer-stale" aria-hidden="true">!</span> : null}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className="wbm-composer-panel"
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          role="dialog"
          aria-label={t('composer.panelTitle')}
        >
          <div className="wbm-composer-panel-head">
            <span className="wbm-composer-panel-title">
              {t(region === 'cn' ? 'composer.panelTitleCn' : 'composer.panelTitleGlobal')}
            </span>
            <button
              type="button"
              className="wbm-composer-panel-refresh"
              disabled={busy || switching !== undefined}
              onClick={() => {
                void (async () => {
                  await fetchStatus()
                  await fetchAccountCredits()
                })()
              }}
            >
              {t('composer.refresh')}
            </button>
          </div>
          {rows.length === 0
            ? <p className="wbm-composer-panel-empty">{t('composer.noAccounts')}</p>
            : (
              <table className="wbm-composer-panel-table">
                <thead>
                  <tr>
                    <th scope="col">{t('composer.account')}</th>
                    <th scope="col" className="wbm-composer-panel-num">{t('composer.credits')}</th>
                    <th scope="col" className="wbm-composer-panel-num">{t('composer.expiry')}</th>
                  </tr>
                </thead>
                <tbody>
                  {/*
                   * 「自动（按账户使用方式）」必须是可见的一行。
                   *
                   * 手动选号会短路掉五种 distribution（这是刻意设计：显式指令优先于
                   * 采样），而在此之前界面上只有「切到某个账号」没有「切回去」——
                   * 用户点过一次号，同一区域的 expiry / priority / round-robin /
                   * balanced / sticky 就永久失效且无从撤销。这一行就是那个撤销入口。
                   *
                   * 没有任何账号处于 selected 时它自己是当前项：那正好是「正在按
                   * 账户使用方式选号」的状态。
                   */}
                  <tr className={currentRow === undefined ? 'wbm-composer-panel-row-current' : undefined}>
                    <th scope="row">
                      <button
                        type="button"
                        className="wbm-composer-row-switch"
                        disabled={!canSwitch || switching !== undefined || currentRow === undefined}
                        aria-label={t('composer.switchToAuto')}
                        onClick={() => { void switchTo('') }}
                      >
                        <span className="wbm-composer-row-who">
                          <span className="wbm-composer-row-name">{t('composer.auto')}</span>
                          <span className="wbm-composer-row-mark">
                            {currentRow === undefined ? (
                              <span className="wbm-composer-row-mark-current">{t('composer.current')}</span>
                            ) : switching === '' ? (
                              <span>{t('composer.switching')}</span>
                            ) : null}
                          </span>
                        </span>
                      </button>
                    </th>
                    <td className="wbm-composer-panel-num">—</td>
                    <td className="wbm-composer-panel-num">—</td>
                  </tr>
                  {rows.map(row => {
                    const days = daysUntil(row.expiryMs, nowMs)
                    const soon = days !== undefined && days <= warnDays
                    return (
                      <tr key={row.id} className={row.selected ? 'wbm-composer-panel-row-current' : undefined}>
                        <th scope="row">
                          <button
                            type="button"
                            className="wbm-composer-row-switch"
                            disabled={!canSwitch || switching !== undefined || row.selected}
                            aria-label={t('composer.switchTo', { account: row.name })}
                            onClick={() => { void switchTo(row.id) }}
                          >
                            <span className="wbm-composer-row-who">
                              <span className="wbm-composer-row-name">{row.name}</span>
                              <span className="wbm-composer-row-mark">
                                {row.selected ? (
                                  <span className="wbm-composer-row-mark-current">{t('composer.current')}</span>
                                ) : switching === row.id ? (
                                  <span>{t('composer.switching')}</span>
                                ) : null}
                              </span>
                            </span>
                          </button>
                        </th>
                        <td className="wbm-composer-panel-num">
                          {row.credits === undefined ? '—' : formatCredits(row.credits)}
                        </td>
                        <td className={soon ? 'wbm-composer-panel-num wbm-warn' : 'wbm-composer-panel-num'}>
                          {formatExpiry(row.expiryMs) ?? '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          <div className="wbm-composer-panel-foot">
            <span>{t('composer.lastRefresh')} {formatClock(lastRefresh) ?? '—'}</span>
            <span>{region === 'cn' ? WB_PROVIDERS.cn : WB_PROVIDERS.global}</span>
          </div>
          {failed ? <p className="wbm-composer-panel-error" role="status">{t('composer.refreshFailed')}</p> : null}
        </div>,
        document.body,
      )}
    </span>
  )
}
