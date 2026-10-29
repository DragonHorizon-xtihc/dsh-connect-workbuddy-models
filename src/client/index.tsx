/**
 * 浏览器半区入口：把「workbuddy模型」页注册进设置面板，把积分读数注册进输入框下方。
 *
 * ## 注册形状（每一项的理由）
 *
 * - `inject` **只**列 `['slots', 'locale']` 两条。cordis 的依赖闸门是硬的：一个
 *   运行线不提供的 inject 条目会让 `apply` 永不执行，该条目永远停在 PENDING，
 *   于是宿主报 "renderer boot failed (plugins: dsh-connect-workbuddy-models)" 并
 *   拒绝打开整个界面。`settingsScope`（0.1.5）与 `configForms`（0.1.7）是同一件
 *   事在两个版本上的**互斥**命名，所以二者都不能写进 inject；哪一个存在由
 *   `apply` 内的 `ctx.get()` 探测。
 * - 设置页注册进 `settings.section`：两条宿主线都声明它，也正是它会在设置面板
 *   左侧导航里放一行 —— 与内置的「通用 / 模型 / 插件」页用的是同一个槽位。
 * - 输入框读数注册进 `conversation.input.left`：这一行常驻，但**是否渲染由 Gate
 *   决定**（读宿主的 `modelSelection` 投影），所以本插件的读数与相邻 connector
 *   插件的读数不会争抢同一行。
 *
 * 整个 `apply` 包在 try/catch 里：槽位 API 变化时降级成 `console.error`，而不是
 * 触发宿主的 "Failed to load plugins" 横幅——设置页挂了不该连带把模型服务也挂掉。
 *
 * ## `settingsScope` 只能用 `ctx.get()` 软探测
 *
 * 直接属性访问一个未声明的服务会**抛错**（"cannot get property X without inject"），
 * 而 `?.` 只挡 null/undefined，挡不住抛错的 getter。所以永远不要写
 * `ctx.settingsScope` / `ctx.configForms`。
 *
 * @module dsh-connect-workbuddy-models/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// `settings.section` 与 `conversation.input.left` 的 SlotMap key 由宿主的设置外壳
// / 对话外壳声明，而它们只是宿主提供的 peer、不是本包的构建依赖：钉住会让本
// bundle 的类型跟随某一条宿主线而破坏另一条。下面 import 的两个包声明了本文件
// 用到的两个座位（slots、locale），两个槽位注册则在调用点就地收窄。
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { WbModelsCard } from './WbModelsCard.tsx'
import type { WbModelsCardInjected } from './WbModelsCard.tsx'
import { ComposerCreditsGate } from './ComposerCreditsGate.tsx'
import type { ComposerCreditsInjected } from './ComposerCredits.tsx'
import { MODEL_LABEL_PRIORITY, WbModelLabel } from './WbModelLabel.tsx'
import type { WbModelLabelProps } from './WbModelLabel.tsx'
import { en, zh } from './locales.ts'
import type { WbModelsSettingsKey } from './locales.ts'
import {
  PLUGIN_ID,
  WB_MODELS_LOCALE_NS,
  WB_MODELS_SETTINGS_NS,
  WB_MODELS_SETTINGS_ORDER,
} from '../status-paths.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 「workbuddy模型」设置页与输入框读数的文案。命名空间见 `WB_MODELS_LOCALE_NS`。 */
    'settings.wbmodels': WbModelsSettingsKey
  }

  interface SlotMap {
    /**
     * 每个列表项一个设置页，渲染为设置面板左侧导航里的一行。由宿主的设置外壳
     * 声明，此处就地重申契约，让下面的注册在两条宿主线上都有类型。
     */
    'settings.section': {
      kind: 'list'
      scope: 'root'
      owner: { close: () => void }
    }
    /**
     * 输入框左侧的一个座位。同样由外壳声明，此处就地重申。
     *
     * 键名是宿主的原样字符串（`conversation.input.left`），不是本插件发明的：
     * 写成别的名字会静默注册进一个没人渲染的槽位。
     */
    'conversation.input.left': {
      kind: 'list'
      scope: 'session'
      owner: { close: () => void }
    }
    /**
     * 模型选择器里「一行标签」的座位（宿主的 `conversation.input.model.label`）。
     *
     * `kind: 'single'` —— 一个单元格只有一个占用者，渲染它的返回值。与上面两个
     * 列表座位不同，这里不是「附加一个控件」，而是**接管那一行的内容**：所以本插件
     * 必须为不属于自己的 provider 也返回正确的东西（纯模型名），否则等于顺手把邻居
     * 的显示弄没了。优先级必须避开 0（宿主自带 1017）/ -1（qoder）/ -0.5（已安装
     * 的参考插件），见 `WbModelLabel.tsx` 文件头。
     */
    'conversation.input.model.label': {
      kind: 'single'
      scope: 'session'
      owner: { close: () => void }
    }
  }
}

/**
 * 本入口需要的浏览器插件上下文。
 *
 * `slots` / `locale` 两个座位由上面 import 的客户端子路径模块声明，cordis 自己的
 * `Context` 承载 `effect` fiber API。
 */
export type WbModelsClientContext = Context & {
  /** 槽位注册面（由宿主客户端运行时增强到 cordis 的 Context 上）。 */
  slots: {
    inject(key: string, callback: () => unknown): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  /** 本地化绑定面（同样来自宿主运行时增强）。 */
  locale: {
    register(namespace: string, dictionaries: { zh: unknown; en: unknown }): () => void
    bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
  }
}

/** 稳定的浏览器插件名。 */
export const name = 'dsh-connect-workbuddy-models-client'

/**
 * 设置页与读数需要的客户端服务。
 *
 * 刻意只列两条宿主线都提供的服务，理由见文件头。
 */
export const inject = ['slots', 'locale']

/**
 * `cordis.patch.yml` 里挂载本 bundle 的宿主插件条目 id。
 *
 * 0.1.7 线上 `configForms` 以这个 id 寻址。
 */
const WB_MODELS_ENTRY_ID = 'workbuddy-models'

/** 注册设置页与输入框读数。 */
export function apply(ctx: WbModelsClientContext): void {
  try {
    const namespace = WB_MODELS_LOCALE_NS
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), `${PLUGIN_ID}: settings copy`)
    // 断言成窄键集而不是 `(key: string) => string`：绑定的翻译器本来就只认这些键，
    // 声明成宽类型会让编译器失去「键写错就报错」这道护栏（参数逆变）。
    const t = ctx.locale.bind(namespace) as WbModelsCardInjected['t']

    // 软探测服务。理由见文件头：直接属性访问未声明的服务会抛错，而 `?.` 挡不住
    // 抛错的 getter；`ctx.get()` 对缺失服务返回 undefined，从不抛。
    const softGet = (serviceName: string): unknown =>
      (ctx as unknown as { get(name: string): unknown }).get(serviceName)

    const settingsScope = resolveSettingsScope(softGet)

    // ── 设置页 ───────────────────────────────────────────────────────────
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: WB_MODELS_SETTINGS_NS,
      // 排在 xdpool 的 440、trae-models 的 441 之后（两个值抄自它们的
      // `src/client/index.tsx`），让账号池类页面并列，而不是把别人挤下去。
      order: WB_MODELS_SETTINGS_ORDER,
      // 传 thunk 而不是解析好的字符串：外壳每次投影都会重读它，于是语言切换后
      // 导航行会跟着变，而不需要本条目重新注册。
      //
      // 导航标签刻意短（「workbuddy模型」）：设置面板左侧导航列很窄，完整产品名
      // 由页面标题承担。
      label: () => t('row.navLabel'),
      inject: (): Partial<WbModelsCardInjected> => settingsScope === undefined
        ? { t }
        : { t, settingsScope },
    }, WbModelsCard))

    // ── 输入框下方的读数 + 切换账号 ──────────────────────────────────────
    //
    // 注册是无条件的，**是否渲染由 Gate 决定**：Gate 读宿主的 `modelSelection`
    // 投影，只在当前会话选中的模型属于本插件时才画——这样相邻 connector 插件的
    // 读数不会争抢同一行，切到别的 provider 时既不渲染也不启动拉取循环。
    //
    // 软探测该插槽：宿主或外壳版本不提供它时整段跳过，而不是抛错让整个客户端
    // 半区加载失败——那会连设置页一起赔进去。
    const composerSlot = 'conversation.input.left'
    try {
      ctx.slots.inject(composerSlot, () => ctx.slots.register({
        name: composerSlot,
        id: `${WB_MODELS_SETTINGS_NS}-composer`,
        // 排在外壳自带控件之后（外壳自己占 0–3），避免挤占内置按钮。
        order: 4,
        locale: namespace,
        // 只回 `t` 与 `settingsScope`：Gate 用来读宿主投影的 `useProjection` 钩子
        // 是**插槽框架自己注入**到组件 props 上的（与参考插件一致），不从这里
        // 返回——这里也没有那个符号可引。
        inject: (): Partial<ComposerCreditsInjected> => settingsScope === undefined
          ? { t }
          : { t, settingsScope },
      }, ComposerCreditsGate))
    } catch (error: unknown) {
      console.error(`[${PLUGIN_ID}] 输入框读数插槽注册失败（宿主 provider 不受影响）：`, error)
    }

    // ── 模型选择器里的标签（模型名 + 倍率 + 促销徽标）────────────────────
    //
    // 这是本插件唯一会**接管别人显示**的座位：`kind: 'single'` 意味着整行内容由
    // 占用者决定，而不是在它旁边加一个控件。因此组件对非本插件的 provider 返回纯
    // 模型名（座位契约的最小输出），见 `WbModelLabel.tsx` 文件头。
    //
    // 与读数条同理软探测：宿主没有这个座位时整段跳过，别把设置页一起赔进去。
    const labelSlot = 'conversation.input.model.label'
    try {
      ctx.slots.inject(labelSlot, () => ctx.slots.register({
        name: labelSlot,
        id: `${WB_MODELS_SETTINGS_NS}-model-label`,
        priority: MODEL_LABEL_PRIORITY,
        locale: namespace,
        inject: (): Partial<WbModelLabelProps> => ({ t }),
      }, WbModelLabel))
    } catch (error: unknown) {
      console.error(`[${PLUGIN_ID}] 模型标签插槽注册失败（宿主 provider 不受影响）：`, error)
    }
  } catch (error: unknown) {
    // 页面上静默降级：模型服务仍然在跑。
    // 开发者能在浏览器控制台看到完整原因；用户看不到横幅。
    console.error(`[${PLUGIN_ID}] 客户端页面加载失败（宿主 provider 不受影响）：`, error)
  }
}

/**
 * 绑定卡片读写所用的设置表单，取运行线上实际存在的那一条。
 *
 * 0.1.7 暴露 `configForms.get(entryId)`，以**宿主插件条目 id** 为键——即
 * `cordis.patch.yml` 里注册的 id，而不是 settings 命名空间。0.1.5 暴露
 * `settingsScope.bind({ namespace })`，以宿主侧 `installSection` 注册的命名空间
 * 为键。两个控制器回答同一对方法（`getSnapshot()`、`set(field, value)`），所以
 * 卡片自身不需要按线分支。
 *
 * 两者都不存在时返回 undefined（受限宿主）：卡片退化为只读，这是文档化的降级。
 */
function resolveSettingsScope(
  softGet: (serviceName: string) => unknown,
): WbModelsCardInjected['settingsScope'] | undefined {
  // 0.1.7 线。条目 id 由宿主决定（profile patch 可能把本插件挂成
  // `workbuddy-models`，也可能像线上桌面宿主那样挂成
  // `include:dsh-connect-workbuddy-models`），所以问镜像它服务哪个命名空间，
  // 而不是假定一个名字：猜错就把卡片绑到一个没人服务的命名空间上，每次保存都
  // 静默空转。
  const forms = softGet('configForms') as {
    describe(): { getSnapshot(): { view?: { namespaces?: { ns: string }[] } } }
    get(ns: string): WbModelsCardInjected['settingsScope']
  } | undefined
  if (forms !== undefined) {
    let entryId = WB_MODELS_ENTRY_ID
    try {
      const namespaces = forms.describe().getSnapshot().view?.namespaces ?? []
      const served = namespaces.find(entry => entry.ns === WB_MODELS_ENTRY_ID)
        ?? namespaces.find(entry => /connect-workbuddy-models/.test(entry.ns))
      if (served !== undefined) entryId = served.ns
    } catch {
      // 镜像尚未就绪：声明的条目 id 仍是正确答案。
    }
    return forms.get(entryId)
  }

  // 0.1.5 线。
  const scope = softGet('settingsScope') as {
    bind(spec: { namespace: string }): WbModelsCardInjected['settingsScope']
  } | undefined
  if (scope !== undefined) return scope.bind({ namespace: WB_MODELS_SETTINGS_NS })

  return undefined
}
