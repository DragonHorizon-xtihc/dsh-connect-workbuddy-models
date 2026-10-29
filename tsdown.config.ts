import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'
import type { UserConfig } from 'tsdown'

/** 插件 id：与 package.json 的 name、cordis.patch.yml 的 name 必须一致。 */
const PLUGIN_ID = 'dsh-connect-workbuddy-models'

/**
 * 构建期注入的版本号。
 *
 * 发布包里只有 `lib/`，没有可解析的 `package.json`，所以版本不能运行时读——
 * 由这里读一次并 define 进产物，`src/version.ts` 据此导出常量。
 * 做法沿用 `plugins/dsh-connect-workbuddy/tsdown.config.ts:11-18`。
 */
const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version as string

const VERSION_DEFINE = { __DSH_WB_MODELS_VERSION__: JSON.stringify(PACKAGE_VERSION) }

/**
 * 客户端（浏览器）半区必须外部化的包。
 *
 * 宿主通过 `window.__ModuleLoader__` 在运行时提供这些模块，客户端 bundle 绝不能
 * 把它们打进来——loader 是用宿主自己的模块注册表来 `require` 它们的。
 *
 * **`react-dom` 必须外部化**：它是宿主 shell 模块加载器（`staticModules`）注册
 * 的，外部化后 import 变成浏览器可解析的 require。若把 react-dom 打进 bundle，
 * 会内联它的 CJS 构建，其开头是
 *
 *   if (process.env.NODE_ENV !== "production") …
 *
 * 浏览器里没有 `process`，于是在**模块求值阶段**就抛
 * `ReferenceError: process is not defined`，导致整个客户端半区加载失败：
 * 设置页不出现、输入框下方读数不出现，宿主只报
 * `web boot: 1 entry did not activate`。
 * 这是一个已经发生过的真实故障（dsh-connect-trae 2.12.0/2.13.0 引入
 * `createPortal` 后），所以这里逐条列出，不做「按需收集」。
 *
 * `react-dom/client` 同样外部化：子路径若被漏掉，将来某处 `createRoot` /
 * portal 辅助函数就会把整个 DOM 渲染器悄悄拉回 bundle。
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-settings-plugins/client',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

/**
 * 宿主半区必须外部化的包：一律借用 DSH 安装里的那一份（peer），
 * 自己不再带一份副本，否则会出现「两份 cordis / 两份 llm 服务」。
 */
const HOST_EXTERNALS = [
  '@earendil-works/pi-ai',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-atomic-write',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-settings',
] as const

export default defineConfig([
  {
    // 宿主入口：`package.json` 的 types 指向 lib/index.d.ts，所以这一半出 dts。
    // 浏览器半区由宿主 loader 直接消费，不需要类型产物。
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: true,
    outExtensions: () => ({ js: '.js' }),
    // 先清空：两段产物共用 outDir，clean 只在第一段开，第二段必须关掉。
    clean: true,
    sourcemap: false,
    define: VERSION_DEFINE,
    deps: { neverBundle: [...HOST_EXTERNALS] },
  },
  {
    // 浏览器半区：产出 lib/client.js（CJS bundle），用 window.__ModuleLoader__
    // 自注册。`platform: 'browser'` 让 bundler 选中浏览器条件导出分支。
    entry: ['src/client/index.tsx'],
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    // 必须 false：否则第二段会把第一段刚产出的宿主体删掉。
    clean: false,
    outExtensions: () => ({ js: '.js' }),
    sourcemap: false,
    define: VERSION_DEFINE,
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
    outputOptions: {
      // 固定文件名：package.json 的 exports["./client"] 指向 ./lib/client.js。
      entryFileNames: 'client.js',
      // loader 的加载协议：banner 打开工厂函数，footer 关掉并把 exports 交回去。
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      // CJS 产物里的 module / exports 由这行 intro 提供，factory 内有自己的作用域。
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[])
