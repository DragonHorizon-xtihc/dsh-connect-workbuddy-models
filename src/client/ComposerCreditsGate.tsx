/**
 * `conversation.input.left` 槽位的**门控**。
 *
 * 槽位注册是无条件的：宿主把组件挂进输入框下方之后，它会一直渲染。但我们只在该
 * 会话正用一个本插件的模型时才想露面。这个文件负责这次归属判定，判定通过才渲染
 * `ComposerCredits`，因此读数本身的代码里没有「我该不该出现」这类分支。
 *
 * ## 为什么用宿主的 `modelSelection` 投影
 *
 * 投影是模型选择器写入、也是下一次请求真正要用的，所以读数不可能与实际生效的
 * 模型不一致——不需要本插件自己维护第二份「现在用的是谁」的状态。
 *
 * `next` 优先于 `lastUsed`：用户刚在模型选择器里点了一下、会话还没发出第一条消息
 * 时，`lastUsed` 仍指向上一个用过（或上游解析器默认）的模型。以 `lastUsed` 为准
 * 会让读数短暂挂在**别的** provider 上，是一个用户看得见的错挂。
 *
 * ## 为什么与 `ComposerCredits` 分成两个文件
 *
 * 让「归属判定」可以在没有宿主的测试环境里单独测：入口 import 的是浏览器专属
 * DSH 包，测试环境加载不了，而本模块只依赖 React 与一个窄投影形状。
 *
 * ## 与参考插件的一处差异
 *
 * 参考实现只接受 `useProjection` 钩子（由插槽框架注入）。这里**同时**接受
 * `useProjection` 与一个现成的 `modelSelection` 值：前者是宿主的真实契约，后者让
 * 测试与未来的直接挂载不必伪造一个 Hook。两者都给时以钩子为准——钩子是宿主为
 * 本会话算出来的，比任何调用方传入的快照都新。
 *
 * @module dsh-connect-workbuddy-models/client/ComposerCreditsGate
 */

import { ComposerCredits } from './ComposerCredits.tsx'
import type { ComposerCreditsInjected, ComposerCreditsSettingsScope } from './ComposerCredits.tsx'
import { unwrapVolatileDeep, wbRegionOfProvider } from '../status-paths.ts'
import type { WbRegion } from '../status-paths.ts'

/** 宿主 `modelSelection` 投影的最小形状。 */
export interface ModelSelectionProjectionLike {
  lastUsed?: unknown
  next?: unknown
}

/** 一次选择的槽位形状；字段都可能缺席，所以一律按 `unknown` 收。 */
interface ModelSlotLike {
  provider?: unknown
}

/** 从任意投影值里取出 provider 字符串。裸字符串也接受（宿主某版本就是它）。 */
function providerOf(candidate: unknown): string | undefined {
  if (typeof candidate === 'string') return candidate === '' ? undefined : candidate
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const provider = (candidate as ModelSlotLike).provider
  return typeof provider === 'string' && provider !== '' ? provider : undefined
}

/**
 * 取出「当前」那次选择：`next` 优先于 `lastUsed`。
 *
 * 导出便于单测：这条优先级是本文件唯一的业务判断。
 */
export function selectedProviderOf(projection: ModelSelectionProjectionLike | undefined): string | undefined {
  if (projection === undefined) return undefined
  // `next` 存在但 provider 读不出来时**不**回落到 lastUsed：那说明用户刚换过选择，
  // 回落到上一个会把读数挂到已经不被选中的模型上。
  if (projection.next !== undefined) return providerOf(projection.next)
  return providerOf(projection.lastUsed)
}

/**
 * 把宿主给的 provider id 映射到本插件的区域。
 *
 * 只做一次精确查表，不做前缀/大小写归一化：`workbuddy-models` 与
 * `workbuddy-models-global` 是前缀关系，任何「宽松匹配」都会让国内版把国际版的
 * 读数当成自己的。查表本身用 `hasOwnProperty`（见契约层 `wbRegionOfProvider`），
 * 所以 `constructor` 这类原型键也不会误命中。
 *
 * 不属于本插件时返回 undefined —— 门控据此什么都不渲染。
 */
export function regionOfProvider(provider: string | undefined): WbRegion | undefined {
  return wbRegionOfProvider(provider)
}

/**
 * 读出「在输入框下方显示积分」这个开关。
 *
 * 三条容易被写错的判定，都在这里收口：
 *
 * 1. **缺省是显示**，不是隐藏。只有用户明确关掉（`=== false`）才不渲染。反过来
 *    写（`!== true` 才显示）会让没有设置分区、分区还没读到值、或老版本配置里根本
 *    没有这个字段的会话集体消失——那是「装好了但什么都没出现」的故障形态。
 * 2. 分区不可用（`settingsScope === undefined`）时按缺省处理，**不**当成关闭：
 *    读不到用户的意愿不等于用户说了「不要」。
 * 3. `getSnapshot()` 会抛（分区还没挂上、或上游实现换过形状）。抛出来只说明
 *    「现在读不到」，同样回落到缺省——一个读数条不该因为读配置失败而消失。
 */
export function composerVisible(value: unknown): boolean {
  const live = unwrapVolatileDeep(value) as { showCreditsInComposer?: unknown } | undefined
  if (typeof live !== 'object' || live === null) return true
  return live.showCreditsInComposer !== false
}

/**
 * 安全地读一次设置分区里的当前配置值。
 *
 * `getSnapshot()` 在分区还没挂上、或宿主换过实现形状时会抛。这里吞掉异常并返回
 * `undefined`——调用方（`composerVisible`）把它当「读不到」处理，而不是当「关掉」。
 */
function readSettingsValue(scope: ComposerCreditsSettingsScope | undefined): unknown {
  if (scope === undefined) return undefined
  try {
    return scope.getSnapshot()?.value
  } catch {
    return undefined
  }
}

export interface ComposerCreditsGateProps extends Partial<ComposerCreditsInjected> {
  /**
   * 标准插槽钩子：读宿主为本会话计算的投影。
   *
   * 由插槽框架注入到组件 props 上，**不**从 `inject` 返回值里来（那里也没有这个
   * 符号可引）。直接渲染本组件（测试）时缺失。
   */
  useProjection?: (key: 'modelSelection') => unknown
  /** 现成的投影值；没有钩子时用它（测试与直接挂载）。 */
  modelSelection?: ModelSelectionProjectionLike
  /** 设置分区（软探测后的对象）；只用来判断面板里的行能不能点。 */
  settingsScope?: ComposerCreditsSettingsScope
  /** 测试注入的 fetch。 */
  fetchImpl?: typeof fetch
}

export function ComposerCreditsGate(props: ComposerCreditsGateProps) {
  // 钩子优先：它是宿主为**本会话**算出来的，比任何调用方传入的快照都新。
  // 钩子可选，所以这里要在「有没有 hook」这个轴上分支，而不能无条件调用它
  // —— 条件调用 Hook 会违反 Hooks 规则。
  const projection = props.useProjection === undefined
    ? props.modelSelection
    : props.useProjection('modelSelection') as ModelSelectionProjectionLike | undefined

  const selectedProvider = selectedProviderOf(projection)
  const region = regionOfProvider(selectedProvider)
  // 不是本插件的模型：什么都不渲染。输入框下方那一行的宽度属于外壳，一个空 div
  // 也会挤动右侧控件。
  if (region === undefined) return null

  // 用户关掉了这个读数条。判定放在门控里（而不是读数组件里）：本文件就是那个
  // 「我该不该出现」的地方，读数组件不应该长出一堆隐藏自己的分支。
  if (!composerVisible(readSettingsValue(props.settingsScope))) return null

  // 到这里 region 非 undefined，而它由 provider 派生，故 provider 必在；断言这一点，
  // 而不是把组件 prop 放宽成接受一个它永远见不到的缺失 provider。
  const provider = selectedProvider as string

  // exactOptionalPropertyTypes 下「属性缺席」与「显式 undefined」不是一回事：
  // 把 undefined 显式传进去反而过不了类型，所以按有无分别构造 props。
  return (
    <ComposerCredits
      {...props.t === undefined ? {} : { t: props.t }}
      provider={provider}
      region={region}
      {...props.settingsScope === undefined ? {} : { settingsScope: props.settingsScope }}
      {...props.fetchImpl === undefined ? {} : { fetchImpl: props.fetchImpl }}
    />
  )
}
