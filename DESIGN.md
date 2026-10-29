# dsh-connect-workbuddy-models 实施规格

> 本文档是团队成员的共享契约。所有结论均来自对
> `plugins/dsh-connect-workbuddy`（4.15.1）、`plugins/dsh-workbuddy-xdpool`（dsh-xdpool 2.4.2）、
> `plugins/dsh-connect-trae-models`（0.1.2）三个参考插件源码的实际阅读，
> 文中每条都标注了出处路径与行号。**不要凭记忆修改任何一条**，改动前先回源核对。

## 0. 目标（用户 5 条需求）

| 编号 | 需求 |
| --- | --- |
| R1 | 加一个设置菜单，菜单名「workbuddy模型」。配置页含：自动获取所有登录 workbuddy 的账号、签到、显示积分、积分到期时间、积分临期提醒、自动执行签到和其他任务获取积分、显示所有模型及模型使用倍率、配置需要显示的模型（默认全部显示）、账户使用方式 |
| R2 | 对话框（输入框）下方显示可切换用户信息；模型列表显示 workbuddy 所有配置的模型；显示用户剩余总积分 |
| R3 | 选中 workbuddy 模型时，优先自动切换到「最先有积分过期」的用户 |
| R4 | 账户使用方式（AccountDistribution）必须真正生效 |
| R5 | 装插件 + 全功能实测：手动签到、自动签到、模型调用、账户切换、账户使用方式、配置页显示模型 |

## 1. 包身份

- 包名 `dsh-connect-workbuddy-models`，版本 `0.1.0`，`main: lib/index.js`
- `cordis.patch.yml`：
  ```yaml
  - insert:
      - id: workbuddy-models
        name: dsh-connect-workbuddy-models
  ```
- **Provider id 必须与本机已装的 `dsh-connect-workbuddy`（provider `workbuddy` / `workbuddy-global`，
  见 `plugins/dsh-connect-workbuddy/src/adapter.ts:46,49`）不冲突**。本插件用
  `workbuddy-models`（CN）与 `workbuddy-models-global`（国际）。重复注册同一 provider 会抛
  `service "…" has been registered`。
- 设置命名空间 `wbmodels`，客户端 locale 命名空间 `settings.wbmodels`，设置页 `order: 442`
  （xdpool 占 440、trae-models 占 441，见两插件 `src/client/index.tsx`）。

## 2. 目录与文件职责（写入范围互不重叠）

```
package.json  tsconfig.json  tsconfig.client.json  tsdown.config.ts  vitest.config.ts  cordis.patch.yml
src/status-paths.ts     共享契约：路由前缀、查询参数、投影类型、unwrapVolatileDeep
src/version.ts          构建期版本常量（__DSH_WB_MODELS_VERSION__）
src/upstream.ts         上游 HTTP 客户端：目录/积分/签到/benefits/token 刷新
src/accounts.ts         账号发现（桌面端 auth 目录 + dsh vault 双源）、解析与解封凭据、AccountDistribution 排序
src/at-rest.ts          桌面端「静态加密」凭据的解封：at-rest 密钥派生 + AES-256-GCM 开信封
src/account-store.ts    账号状态持久化（可选；无则内存）
src/probe.ts            积分探测与到期信息聚合
src/catalog.ts          模型目录（静态 fallback + 实时刷新 + 用户选择过滤）
src/adapter.ts          pi-ai 适配器（provider id + 转发到 shim）
src/shim.ts             与 pi-ai 的桥接层（参考 dsh-connect-workbuddy/src/shim.ts）
src/scheduler.ts        自动签到与其他积分任务（北京时间自然日幂等）
src/web-status.ts       web 路由处理函数
src/index.ts            宿主入口：settings 双线、provider 注册、web 路由、scheduler 启停
src/client/index.tsx    浏览器入口：settings.section + conversation.input.left 两处注册
src/client/WbModelsCard.tsx   配置页组件
src/client/ComposerCredits.tsx 输入框下方读数与账号切换面板
src/client/ComposerCreditsGate.tsx 归属与开关判定
src/client/locales.ts   中英文文案
src/client/styles.ts    内联 CSS（data-plugin-css 幂等注入）
tests/*.test.ts(x)      单元与集成测试
```

## 3. 必须遵守的宿主契约（违反会导致插件静默不加载）

### 3.1 浏览器半区注册形状
出自 `plugins/dsh-workbuddy-xdpool/src/client/index.tsx:1-140`、
`plugins/dsh-connect-trae-models/src/client/index.tsx:1-60`：

- `export const inject = ['slots', 'locale']` —— **只能列这两条**。cordis 依赖闸门是硬的：
  运行线不提供的 inject 条目会让 `apply` 永不执行。`settingsScope`（0.1.5）与
  `configForms`（0.1.7）互斥，必须用 `ctx.get(name)` 软探测。
- 直接属性访问未注入的服务会抛 `cannot get property X without inject`，`?.` 挡不住。
- 设置页注册进槽位 `'settings.section'`，`{ name, id, order, label: () => t(...), inject: () => ({ t, settingsScope? }) }`。
- 整个 `apply` 包 try/catch，失败只 `console.error`，不触发宿主 "Failed to load plugins" 横幅。
- 输入框读数注册进 `'conversation.input.left'`（**不是** `sidebar.footer.action`，那是 root 级共享行），
  注册形状见 `plugins/dsh-connect-workbuddy/src/client/index.tsx`（registerComposerCredits），
  `order: 4`，`inject: () => ({ t, position: 'composer', settingsScope? })`。
- 归属判定读宿主 `modelSelection` 投影，`projection?.next ?? projection?.lastUsed` 取 provider
  （见 `plugins/dsh-connect-workbuddy/src/client/ComposerCreditsGate.tsx` 的 `selectedProviderOf`）。

### 3.2 宿主配置双线兼容
出自 `plugins/dsh-connect-trae-models/src/index.ts:335-410`、`plugins/dsh-workbuddy-xdpool/src/index.ts:836`：

```ts
const settingsService = (ctx as any).settings
if (typeof settingsService?.installSection === 'function') {
  // 0.1.5：installSection(ctx, NS, Schema, unwrapVolatileDeep(config), { onChange() { applyConfigFromSource() } })
} else if (typeof settingsService?.configure === 'function') {
  // 0.1.7：ctx.effect(() => settingsService.configure({ auto: true }, ctx.fiber) ?? (() => {}))
  //        并 .on('loader/volatile-update', () => applyConfigFromSource())
}
```

- `settingsWriteNs`：0.1.5 用 `WB_MODELS_SETTINGS_NS`；0.1.7 **必须** `ctx.fiber.entry.options.id`
  （硬猜 namespace 会抛 `No configurable plugin entry`）。
- 启动时必须显式 `applyConfigFromSource()`，否则重启静默回退。
- `unwrapVolatile` / `unwrapVolatileDeep`：volatile 字段是活 `{ get(): T }`，传给 settings 服务前
  必须深剥，否则 `structuredClone` 校验失败、命名空间注册不上、卡片静默消失。

### 3.3 Provider 注册
出自 `plugins/dsh-connect-trae-models/src/index.ts:531-566`：
`ctx.llm.registerAdapter([providerId], adapter)` +
`ctx.llm.registerConfigurableProviders([{ provider, displayName, settingsNs, settingsPath: [], declared: false }])`，
返回释放函数；中途抛错必须撤销已注册部分。宿主入口 `export const inject = ['llm', 'settings']`。

### 3.4 web 路由
`ctx.inject(['webServer'], webCtx => webCtx.webServer.register({ ... }))`，路径前缀
`/plugins/dsh-connect-workbuddy-models/`。路由清单见 §6。

## 4. 上游协议（WorkBuddy）

出自 `plugins/dsh-connect-workbuddy/src/upstream.ts`：

- 区域：CN `chatBase=https://copilot.tencent.com`、`billingBase=https://www.codebuddy.cn`；
  国际 `https://www.workbuddy.ai`。`regionOf(domain)`：`domain === 'workbuddy.ai'` 或
  以 `.workbuddy.ai` 结尾 → `global`，否则 `cn`。
- 模型目录：`MODELS_CATALOG_PATH = '/v2/enterprises/personal/models'`（src/upstream.ts:197）。
- 全局配置：`GLOBAL_CONFIG_PATH = '/v3/config'`（src/upstream.ts:204）。
- 积分：`POST {billingBase}/v2/billing/meter/get-user-resource`，
  body `{ PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca', Status: [0, 3] }`。
- **余额必须读 `CycleCapacityRemainPrecise` 家族**（issue #58 定论）：`CapacityRemain` 是 pool 家族，
  会在整月额度已花完时仍报满额（高报）。
- 签到（两个端点都在 **billingBase** 上，不是 chatBase）：
  `POST {billingBase}/v2/billing/meter/checkin-activity-status`（src/upstream.ts:896，读今日状态）
  与 `POST {billingBase}/v2/billing/meter/daily-checkin`（src/upstream.ts:1004，领奖）。
  状态形状见 `WbCheckinStatus`。
- 权益领取：`BENEFIT_CLAIM_PATHS = { compensation: '/billing/meter/claim-compensation', gift: '/billing/meter/claim-gift' }`，
  claimable = `active && !claimed`。
- 数据形状（src/status-paths.ts:214-236）：
  ```ts
  interface WbCreditPackage { packageName: string; remain: number; size: number; monthly: boolean; refreshAtMs?: number; expiresAtMs?: number }
  interface WbCredits { total: number; packages: readonly WbCreditPackage[]; expiringSoon: number; nearestExpiryMs?: number }
  ```
- 倍率：上游模型 `credits` 字符串 `'x0.00'`，由 `parseCreditMultiplier`（src/upstream.ts:428）解析。
  **`undefined ≠ 0`**：CN fallback 整份没有该字段，把 undefined 当 0 会把收费模型显示成免费。
- 请求头常用：`User-Agent: CLI/2.63.2 CodeBuddy/2.63.2`、`X-User-Id`、`X-Domain`、
  `X-Requested-With`、`Origin`、`Referer`。

## 5. 账号发现与排序

出自 `plugins/dsh-workbuddy-xdpool/src/accounts.ts:1-140,540-720`：

- 扫描目录**两类来源**（`candidateAuthSources(env)` 返回 `{dir, kind}`，`kind` 决定后缀）：
  1. **桌面端登录目录**：`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\`
     （`defaultDesktopAuthDirs()`），只收 `.info`。
  2. **dsh 凭据 vault**：`<resolveDshHome()>/workbuddy-vault/{cn,global}/*.json`，只收 `.json`。
     `resolveDshHome()` 判定 `$DSH_HOME`（trim 非空）→ `~/.dsh`；`DSH_HOME` 指的是 Harness
     home **本身**，所以 vault 在 `$DSH_HOME/workbuddy-vault/…`，不是 `$DSH_HOME/.dsh/…`。
  环境变量覆盖 `WORKBUDDY_AUTH_FILE`（可指文件或目录，`.json` 结尾判为 vault 形态）。
  **后缀按目录语义收，不是一张全局白名单**：桌面端目录里的
  `workbuddy-desktop.observation.json` 是诊断产物，若也收 `.json` 就会被当成账号读进来。
- 活文件 `WORKBUDDY_LIVE_FILENAME = 'workbuddy-desktop.info'`；带时间戳的 `*.info` 是历史快照，
  每个都可解析成一个账号候选。
- `parseWorkBuddyAuth` 解析出 `{ accessToken, refreshToken, expiresAtMs, lastRefreshAtMs?,
  nickname?, uin?, uid?, enterpriseId?, domain, sourcePath }`；账号 id = sha256(计费身份
  `uin` 优先，回退 `uid`)。
- `WorkBuddySkippedFile{ path, reason: 'encrypted' | 'unreadable' | 'malformed' }` —— 跳过的文件必须暴露，
  否则「2 个账号」与「4 个文件里 2 个读不了」看起来一样。
- `AccountDistribution = 'priority' | 'round-robin' | 'balanced' | 'sticky' | 'expiry'`（src/status-paths.ts:165）。
  `'expiry'` 语义：一次性积分包最先到期的账号先服务，无到期信息的排最后。
  默认值是 `'expiry'`（`src/status-paths.ts:197`）——用户需求 R3「优先切到积分最先过期的账号」
  要求它默认成立，故不取 `'priority'`。
- 排序键（`plugins/dsh-connect-workbuddy/src/account-pool.ts:440-480`）：
  `_usable` → `_atRisk ((credits.expiringSoon ?? 0) > 0)` → `_order`（用户手动序）→
  `_expiring (nearestExpiryMs ?? Infinity，都 atRisk 时先到期者先)` → `_expiringAmount` 大者优先 → `score`。
  **这就是 R3「优先切到最先有积分过期的用户」的既有范式，直接复用。**

### 5.1 凭据形态（`accessToken` / `refreshToken` 的两种写盘形状）

同一个字段在磁盘上有**两种**形态，读侧必须都认：

| 形态 | 例子来源 | 读法 |
| --- | --- | --- |
| 明文字符串 | 旧构建写的 `.info`；vault 的 `.json`（`dsh-connect-workbuddy` 持久化的明文副本） | 直接用 |
| 字段信封 | 5.6.0 起的桌面端 `.info`：`{ "$wbEncrypted": 1, "envelope": "<base64>" }` | 先解封（见下），解不开就按 `reason:'encrypted'` 上报 |

信封内容是一段 JSON `{suite, keyId, nonce, authTag, ciphertext}`，即 AES-256-GCM（12 字节
nonce、16 字节 authTag）。AAD 是长度前缀转录，把 scheme / suite / keyId / framing 一起绑进
去，所以密文只能在它被封的那个「字段形状」下打开。

**密钥从哪来。** 字段密钥不是用户秘密，而是编译进桌面端自己的 Electron 原生模块
（`electron_browser_workbuddy_storage`）的构建期常量：应用经 `loggerGet()` 交出一段 base64
**字符串**，对**该字符串本身**做 SHA-256 得到 32 字节密钥（`deriveAtRestKey`；不是哈希它解码后
的字节——哈希错对象会得到另一把钥匙，每个字段都解不开）。`deriveAtRestKeyId` = 密钥
SHA-256 十六进制前 16 位，与信封里的 `keyId` 比对，所以「钥匙不对」会响亮失败而不是解出垃圾。

`src/at-rest.ts` 的做法是**问装在同一台机器上的那个构建要它自己的密钥**：把桌面端二进制当普通
Node 跑（`ELECTRON_RUN_AS_NODE=1`），调它自己的 binding。可执行文件按
`WORKBUDDY_APP_EXECUTABLE` → 默认安装布局 → Windows 注册表 `Uninstall` 三处依次探测
（`findWorkbuddyAppExecutable`，别名 `findWbAppExecutable`）。**因此：本机没装桌面端就取不到
密钥**——这是协议性质，不是缺陷。

**失败如何上报。** 分三层，任一环都不静默吞：

1. `openEncryptedField` 解不开（无密钥 / keyId 不匹配 / GCM 认证失败 / 信封畸形）→ 抛错。
   **认证失败必须抛**，绝不返回一个被截断的 token —— 截断的凭据会以「401」的形式在下游
   出现，把「本机缺密钥」误诊成「账号被禁」。
2. `parseWorkBuddyAuth(text, sourcePath, decrypt?)` 把可选的解密器注入解析，字段读出三态
   `{value, encrypted, failed}`。`accessToken.failed` → 抛 `WbEncryptedCredentialError`；
   `accessToken` 为空 → 返回 `undefined`（真的没登录）。`refreshToken` 与 `nickname` 的
   `failed` **不抛**：前者丢了只损失刷新能力（当前 token 还能用一阵），后者只是装饰字段——
   为一个字段把整账号判死会让用户看到账号消失。
3. `discoverAccounts` 把 `WbEncryptedCredentialError` 兜成
   `skipped: [{path, reason:'encrypted'}]`，消息指向两条出路（启动桌面端并登录，或设
   `WORKBUDDY_APP_EXECUTABLE`）。**一个坏文件不许让整次扫描返回空池。**

**为什么默认不依赖解密。** 有 `dsh-connect-workbuddy` 的机器上 vault 里就有明文副本，所以
`src/at-rest.ts` 是**兜底**而不是主路：它服务「只装了桌面端、没装那个插件」的机器。反过来，
只靠 vault 也不行——没有那个插件的机器上，信封是唯一凭据来源。

**去重。** 同一 `uin` 在桌面端与 vault 各有一份时按 `workbuddyAccountId` 折叠成**一个**池
成员（否则「剩余总积分」会把同一个人的余额重复相加）。取哪一份由 `compareFreshness` 四键决
定：`refreshExpired` → 活文件优先 → `lastRefreshAtMs` 大者优先 → `expiresAtMs` 大者优先。

## 6. web 路由清单（本插件）

| 路径 | 方法 | 用途 |
| --- | --- | --- |
| `/plugins/dsh-connect-workbuddy-models/status` | GET | 汇总状态：账号/积分/到期/签到/模型/配置 |
| `/plugins/dsh-connect-workbuddy-models/accounts/refresh` | POST | 重新扫描本机登录账号 |
| `/plugins/dsh-connect-workbuddy-models/account/credits` | GET `?accountId=` | 单账号积分明细 |
| `/plugins/dsh-connect-workbuddy-models/checkin` | POST `?region=&accountId=`（两者皆可省） | 手动签到 |
| `/plugins/dsh-connect-workbuddy-models/checkin` | POST `?region=global` | **400** `checkin-unsupported-region`（国际版没有签到活动） |
| `/plugins/dsh-connect-workbuddy-models/checkin` | POST `?region=cn&accountId=<global 账号>` | **409** `account-region-mismatch`（跨区拒绝） |
| `/plugins/dsh-connect-workbuddy-models/checkin` | POST `?accountId=<不存在>` | **404** `unknown account` |
| `/plugins/dsh-connect-workbuddy-models/checkin` | POST `?region=<非 cn/global>` | **400** `invalid region`（与 global 的 400 文案不同，两个 400 必须可区分） |
| `/plugins/dsh-connect-workbuddy-models/benefit/claim` | POST `?accountId=&kind=` | 领取补偿/赠礼积分 |
| `/plugins/dsh-connect-workbuddy-models/models/refresh` | POST | 拉取实时模型目录与倍率 |
| `/plugins/dsh-connect-workbuddy-models/models/save` | POST | 保存需要显示的模型选择 |
| `/plugins/dsh-connect-workbuddy-models/accounts/select` | POST `?accountId=&region=` | 切换当前使用账号 |
| `/plugins/dsh-connect-workbuddy-models/accounts/select` | POST `?accountId=（空串）` | **200**，清除手动选号，交还给「账户使用方式」（空串是合法值，不是「缺参数」） |
| `/plugins/dsh-connect-workbuddy-models/automation` | GET/POST | 自动签到开关与时段 |

签到路由的 `?region=` 缺省即 `cn`；无论传什么，参与账号一律归一到 `CHECKIN_REGION`
（`src/status-paths.ts:109`）收口，`undefined` **不再**表示「全池」。详见 §6 末尾。

`/status` 的 `?region=` 决定返回**哪个区域的账号**：`cn` 只回 cn 账号，`global` 只回 global
账号。混着返回会把国际版账号显示在国内版列表里（缺陷 B）。

## 7. 设置项（配置页字段）

```ts
interface WbModelsConfig {
  enabled: boolean                    // 是否启用本 provider
  distribution: 'priority' | 'round-robin' | 'balanced' | 'sticky' | 'expiry'  // 账户使用方式（R4）
  enabledModelIds: string[]           // 需要显示的模型；默认全部显示
  enabledModelIdsGlobal: string[]
  accountsEnabled: string[]           // 参与池的账号
  orderAccountIds: string[]           // 手动排序
  showCreditsInComposer: boolean      // 输入框下方读数开关
  expiryWarnDays: number              // 临期提醒阈值（天）
  automation: { enabled: boolean; checkinHours: number[]; claimBenefits: boolean }
  accounts: { cn?: string; global?: string }  // 当前使用账号（按区域）
}
```

「默认全部显示」= `enabledModelIds` 为空数组时视为全选（见
`plugins/dsh-connect-workbuddy/src/catalog.ts` 的选择过滤语义）。

## 8. 自动签到

出自 `plugins/dsh-connect-trae-models/src/scheduler.ts:56`、`plugins/dsh-connect-workbuddy/src/status-paths.ts:238`：

- `AUTOMATION_TIME_ZONE = 'Asia/Shanghai'`
- `AUTOMATION_TICK_MS = 60_000`
- `AUTOMATION_ACCOUNT_DELAY_MS = 800`
- `DEFAULT_CHECKIN_HOURS = [9]`
- 幂等：按北京时间自然日 + `todayCheckedIn` 判定，重复调用不会重复领取。

## 9. 测试与验收

1. `pnpm typecheck`（`tsc -p tsconfig.json --noEmit && tsc -p tsconfig.client.json --noEmit`）必须零错。
2. `pnpm test`（vitest）覆盖：账号解析与排序（含 expiry 分布）、积分聚合与到期、模型目录与倍率
   （`undefined ≠ 0`）、签到幂等、配置双线适配、客户端 gate 归属判定、凭据双源与信封解封
   （`tests/at-rest.test.ts`：AAD 黄金字节、密钥派生、信封检测、开信封的成败与篡改、
   `accessToken`/`refreshToken` 两字段接线、混装不误判、vault `.json` 被发现、双源折叠、
   `$DSH_HOME` 目录布局）。
3. 构建 `pnpm build` 产出 `lib/index.js` + `lib/client.js`。
4. 安装：`~/.dsh/profiles/<profile>/package.json` 加 `"dsh-connect-workbuddy-models": "link:/absolute/path/to/dsh-connect-workbuddy-models"`，
   `dsh.profile.bundles` 追加 `dsh-connect-workbuddy-models`，然后重启 3080 宿主。
5. 端到端实测（R5）：见 §6 路由逐个真实调用 + 浏览器验证设置页与输入框读数。

## 10. 明确的不适用范围

- 不实现 Trae 的 `checkin_credits` 端点族。
- 不把 `CapacityRemain` 当作余额。
- 不改写 WorkBuddy 桌面应用的登录文件（发现流程只读）。
- 不与 `dsh-connect-workbuddy` / `dsh-xdpool` 抢同一 provider id 或同一 sidebar 座位。
- **不解密钥就无法读凭据**：本机没装 WorkBuddy 桌面端（且没有 `dsh-connect-workbuddy` 的
  vault 明文副本）时，加密-only 的登录文件会以 `reason:'encrypted'` 显式跳过。这不是本插件
  能绕过的一步——密钥只存在于桌面端自己的进程里（见 §5.1）。此时「账号数变少」是正确结果，
  界面会把被跳过的文件与原因一起列出来。
