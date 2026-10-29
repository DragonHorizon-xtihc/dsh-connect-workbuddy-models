/**
 * 包版本号。
 *
 * 值由构建期 define 注入（见 `tsdown.config.ts` 的 `VERSION_DEFINE`）：
 * 发布包里只带 `lib/`，没有可解析的 `package.json`，所以不能运行时读。
 * 做法沿用 `plugins/dsh-connect-workbuddy/src/version.ts`。
 *
 * @module dsh-connect-workbuddy-models/version
 */

/**
 * 构建期注入的全局常量。
 *
 * 声明成 `declare const` 而不是类型字段：它是 bundler 的 define 文本替换，
 * 在源码里并不存在这个绑定。`typeof` 守卫是必须的——直接用会在
 * 「忘了跑构建的测试环境」里抛 `ReferenceError`，而那种环境本来就该拿到
 * 一个 dev 版本号而不是崩掉。
 */
declare const __DSH_WB_MODELS_VERSION__: string

/** 本份构建产出的 npm 包版本；未注入时回落到 `0.0.0-dev`。 */
export const WB_MODELS_VERSION: string =
  typeof __DSH_WB_MODELS_VERSION__ === 'string' && __DSH_WB_MODELS_VERSION__ !== ''
    ? __DSH_WB_MODELS_VERSION__
    : '0.0.0-dev'
