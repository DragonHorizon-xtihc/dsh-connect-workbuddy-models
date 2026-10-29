# dsh-connect-workbuddy-models

把本机**所有**登录过的 WorkBuddy 账号聚合成 DeepSeek Harness 里的一个模型池：自动发现账号、
签到、积分与到期、临期提醒、自动签到、模型倍率与促销徽标，并在输入框下方直接切换账号、查看剩余总积分。

装上之后模型选择器里出现两个分组：**WorkBuddy Models（国内版）** 与 **WorkBuddy Models（国际版）**
（provider id `workbuddy-models` / `workbuddy-models-global`）。

> **和 `dsh-connect-workbuddy` 的关系**：那个插件一次用一个账号；本插件把**多账号当默认情况**——
> 本机所有历史登录快照全部收进一个池，对外一个 provider 分组，池内自动换号。两者的 provider id
> 刻意不重叠（它占 `workbuddy` / `workbuddy-global`），因此**可以同时安装**，互不抢占。

---

## 功能

### 一、账号自动发现

不挑号、不手动导入。插件扫描 WorkBuddy 桌面端留下的登录文件，同时兼容多个来源：

| 平台 | 路径 |
| --- | --- |
| Windows | `%LOCALAPPDATA%` 与 `%APPDATA%` 下的 `CodeBuddyExtension\Data\Public\auth\`（两处都探，只探一处会得到「没有账号」） |
| macOS | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/` |
| Linux | `$XDG_CONFIG_HOME/CodeBuddyExtension/Data/Public/auth/`（回落 `~/.config`） |

- 活文件 `workbuddy-desktop.info`；带时间戳的 `*.info` 是历史快照，每一个都能解析成一个账号候选；
- 第二个来源是 DSH 自己的 vault（`$DSH_HOME` → 回落 `~/.dsh`）；
- `WORKBUDDY_AUTH_FILE` 环境变量可指定单个文件或目录。

所以 **多账号 = 在 WorkBuddy 客户端里换着登几次**，之后点设置页的「重新检测账号」或重启 DSH，
新号就自动进池。凭据只读，插件从不索要密码。

读不了的文件会被**列出来并说明原因**（`encrypted` / `unreadable` / `malformed`），而不是悄悄少几个账号：
Windows 构建会加密令牌字段，这种情况让用户「重新登录」是错的——他本来就登着。

### 二、积分、到期与临期提醒

| 能力 | 说明 |
| --- | --- |
| 积分读数 | 剩余总积分、每个积分包的余额与到期 |
| 到期时间 | 一次性包的到期时刻；周期包显示下次刷新时刻 |
| 临期提醒 | 阈值内会过期的额度单独标出（默认 3 天，可配 1–90 天） |
| 手动签到 | 设置页按账号点「签到」，走上游签到端点 |
| 自动签到 | 按北京时间自然日幂等执行，重复调用不会重复领取 |
| 权益领取 | 可选顺带领取补偿 / 赠礼积分（`claimBenefits`） |

余额读的是上游 `CycleCapacityRemainPrecise` 家族，**不是** `CapacityRemain`——后者是 pool 家族，
整月额度已经花完时仍会报满额。

### 三、账户使用方式

设置页的「账户使用方式」下拉，五种，**真正影响换号行为**：

| 方式 | 行为 | 适合 |
| --- | --- | --- |
| `expiry`（默认） | 一次性积分包**最先到期**的账号先服务，无到期信息的排最后 | 怕积分过期作废 |
| `priority` | 一直打同一个号，直到被限流或积分耗尽才换下一个 | 单号额度大，想尽快用完一个 |
| `round-robin` | 连续请求依次轮过每个号，花费均摊 | 多个号额度差不多 |
| `balanced` | 按权重抽取，冷清时也不会把第一个号抽干 | 想长期均匀消耗 |
| `sticky` | 一个会话钉一个号，新会话换下一个 | 想保住上游 prompt 缓存 |

默认是 `expiry` 而不是 `priority`：`priority` 的第一个排序键是 `atRisk`，而 `atRisk` 由
`expiryWarnDays`（默认 3 天）现算——10 天后才到期的积分不算 `atRisk`，排序会退回「谁分多谁先」，
变成「积分多的号被优先抽干」。`expiry` 直接按最近到期时间升序，全时段都成立。
`expiryWarnDays` 只决定**提醒**窗口，不再决定**排序**。

排序键（`rankAccounts`）依次是：可服务 → 有额度正在流失 → 用户手动序 → 最先到期 → 流失额度大 →
积分多 → 凭据更晚到期 → 账号 id（保证全序）。

### 四、模型列表、倍率与促销徽标

- 模型列表来自上游实时目录，设置页可点「刷新模型」重拉，并显示每个模型的积分倍率。
- **`undefined ≠ 0`**：国内版的 fallback 目录整份没有倍率字段。把未知当 0 会把收费模型显示成免费，
  所以未知一律显示为「—」。
- 「需要显示的模型」默认全部显示；**空选择 = 全选**（不是全不选）。
- 模型选择器那一行会画上本次生效的**促销徽标**与倍率。徽标数据就躺在本插件已经在读的
  `/v3/config` 里（`modelPromotions` / `modelTiers`），**不额外发请求**；且是**按时钟现算**的——
  命名时区的墙钟窗口（如 `Asia/Shanghai` 23:00–7:50）与绝对窗口（`validFrom` / `validUntil`）
  都在渲染那一刻判定，不会出现「22:59 读到的夜间折扣到次日 08:00 还自称夜间」。
- 该槽位是宿主的 `kind: 'single'` 座位（一个单元格只有一个占用者），本插件用 `-0.25` 优先级插入，
  避开宿主自带（`0`）、`dsh-connect-qoder`（`-1`）与 `dsh-connect-workbuddy`（`-0.5`）；
  遇到不属于自己的 provider 返回纯模型名，不把邻居的显示弄没。

### 五、输入框下方读数与账号切换

对话输入框下方（`conversation.input.left` 槽位，`order: 4`）显示：

- 当前 provider 对应的账号名；
- 该账号 / 整个池的**剩余总积分**；
- 点开可切换当前使用账号（按区域）。

读数只在选中的模型属于本插件时才出现——归属判定读宿主 `modelSelection` 投影的 `next ?? lastUsed`。
开关在设置页（`showCreditsInComposer`），默认开。

---

## 安装

### 方式一：npm 安装（推荐）

在目标 profile 目录（如 `~/.dsh/profiles/<profile>/package.json`）中：

1. 在 `dependencies` 加入：

   ```json
   "dsh-connect-workbuddy-models": "^0.1.0"
   ```

2. 在同一文件的 `dsh.profile.bundles` 数组里加入包名（`cordis.patch.yml` 的 `insert` 就作用在这里）：

   ```json
   "dsh.profile.bundles": ["...", "dsh-connect-workbuddy-models"]
   ```

3. 执行 `pnpm install`（或 `npm install`）。
4. 重启 DSH（Web GUI 默认 3080 端口）。设置页左侧导航会出现「workbuddy模型」。

### 方式二：从 GitHub 安装

```json
"dsh-connect-workbuddy-models": "github:DragonHorizon-xtihc/dsh-connect-workbuddy-models"
```

仓库**已提交构建产物** `lib/`，安装期不需要跑构建脚本（pnpm 高版本默认拦截安装期脚本，
这也正是产物入库的原因）。

### 方式三：从源码运行（开发态）

```bash
git clone https://github.com/DragonHorizon-xtihc/dsh-connect-workbuddy-models.git
cd dsh-connect-workbuddy-models
pnpm install
pnpm build
```

然后在 profile 的 `dependencies` 里用 `link:` 指向本地目录：

```json
"dsh-connect-workbuddy-models": "link:/absolute/path/to/dsh-connect-workbuddy-models"
```

### 验证

```bash
# 汇总状态：账号 / 积分 / 到期 / 签到 / 模型 / 配置
curl http://127.0.0.1:3080/plugins/dsh-connect-workbuddy-models/status

# 重新扫描本机登录账号
curl -X POST http://127.0.0.1:3080/plugins/dsh-connect-workbuddy-models/accounts/refresh
```

---

## 配置项

设置页「workbuddy模型」的字段（持久化在设置命名空间 `wbmodels`）：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 是否启用本 provider |
| `distribution` | 枚举 | `expiry` | 账户使用方式，见上表 |
| `enabledModelIds` | string[] | `[]` | 需要显示的模型（国内版）；**空数组 = 全部显示** |
| `enabledModelIdsGlobal` | string[] | `[]` | 同上，国际版 |
| `accountsEnabled` | string[] | `[]` | 参与池的账号 id；空 = 全部发现的账号都参与 |
| `orderAccountIds` | string[] | `[]` | 手动排序的账号 id，`[0]` 排最前 |
| `showCreditsInComposer` | boolean | `true` | 输入框下方读数开关 |
| `expiryWarnDays` | number | `3` | 临期提醒阈值（天），范围 1–90 |
| `automation.enabled` | boolean | `false` | 自动签到总开关 |
| `automation.checkinHours` | number[] | `[9]` | 北京时间整点执行 |
| `automation.claimBenefits` | boolean | `false` | 是否顺带领取补偿 / 赠礼积分 |
| `accounts.cn` / `accounts.global` | string | `''` | 当前使用账号（按区域）；空 = 交给 `distribution` 决定 |

自动签到的时间常量：`AUTOMATION_TIME_ZONE = 'Asia/Shanghai'`、`AUTOMATION_TICK_MS = 60_000`、
`AUTOMATION_ACCOUNT_DELAY_MS = 800`、`DEFAULT_CHECKIN_HOURS = [9]`。

---

## HTTP 路由

全部挂在 `/plugins/dsh-connect-workbuddy-models/` 下：

| 路径 | 方法 | 参数 | 用途 |
| --- | --- | --- | --- |
| `/status` | GET | `region` | 汇总状态：账号 / 积分 / 到期 / 签到 / 模型 / 配置 |
| `/accounts/refresh` | POST | — | 重新扫描本机登录账号 |
| `/account/credits` | GET | `accountId` | 单账号积分明细 |
| `/checkin` | POST | `accountId`（可省 = 全部） | 手动签到 |
| `/benefit/claim` | POST | `accountId`、`kind` | 领取补偿 / 赠礼积分 |
| `/models/refresh` | POST | — | 拉取实时模型目录与倍率 |
| `/models/save` | POST | — | 保存需要显示的模型选择 |
| `/accounts/select` | POST | `accountId`、`region` | 切换当前使用账号 |
| `/automation` | GET / POST | — | 自动签到开关与时段 |

查询参数名常量集中在 `src/status-paths.ts`（`WB_ACCOUNT_ID_PARAM` / `WB_KIND_PARAM` /
`WB_REGION_PARAM`），路由处理函数与浏览器请求方共用同一份，改名单点生效。

---

## 兼容性与依赖

| 项 | 要求 |
| --- | --- |
| Node.js | `^22.19.0` 或 `>=24.0.0` |
| DSH | 0.2.0-rc.1 线（peer：`@deepseek-ai/dsh-llm`、`dsh-llm-pi-ai`、`dsh-host-webserver`、`dsh-settings`、`dsh-client-ui-*` 等） |
| React | `^18.2.0`（由宿主 shell 提供，不随包分发） |
| 操作系统 | Windows / macOS / Linux（账号发现三平台均可；Windows 另有桌面端静态加密凭据的解封支持） |

所有 `@deepseek-ai/*` 依赖都是 **peer**，装的是 DSH 安装里的那一份——自带副本会出现「两份 cordis /
两份 llm 服务」。

---

## 开发

```bash
pnpm typecheck   # tsc -p tsconfig.json --noEmit && tsc -p tsconfig.client.json --noEmit
pnpm test        # vitest run
pnpm build       # tsdown → lib/index.js + lib/index.d.ts + lib/client.js
```

### 目录

```
src/status-paths.ts   共享契约：路由、查询参数、投影类型、unwrapVolatile(Deep)、rankAccounts
src/version.ts        构建期注入的版本常量
src/upstream.ts       上游 HTTP 客户端：目录 / 积分 / 签到 / benefits / token 刷新
src/accounts.ts       账号发现（桌面端 auth 目录 + DSH vault 双源）、凭据解封、排序
src/at-rest.ts        桌面端静态加密凭据的解封（at-rest 密钥派生 + AES-256-GCM）
src/catalog.ts        模型目录（静态 fallback + 实时刷新 + 用户选择过滤）
src/adapter.ts        pi-ai 适配器（provider 注册 + 转发到 shim）
src/shim.ts           与 pi-ai 的桥接层
src/scheduler.ts      自动签到与积分任务（北京时间自然日幂等）
src/web-status.ts     web 路由处理函数
src/index.ts          宿主入口：settings、provider 注册、web 路由、scheduler 启停
src/client/           浏览器半区（设置页 + 输入框读数 + 模型标签）
tests/                单元与集成测试
```

`src/status-paths.ts` **只放常量与纯函数，不 import 任何 `@deepseek-ai/*` 包**：它会被打进浏览器
bundle，一旦引入宿主侧依赖，客户端半区就在加载期失败。

### 两个必须记住的坑

1. **装配给设置的配置必须 `unwrapVolatileDeep`**。schemastery 的 volatile 字段解析出来是活引用
   `{ get(): T }`，`typeof === 'object'` 所以不会被当成异常。直接交给 settings 服务时，服务会
   `structuredClone` 整份对象做校验，活引用过不去 → 命名空间注册不上 → **设置页卡片静默消失**
   （无异常、无横幅）。浏览器侧 `{ ...reference }` 展开成 `{ get: <function> }`，会丢掉所有兄弟字段。
2. **客户端 bundle 必须把 `react-dom` 外部化**。`react-dom` 由宿主 shell 的模块加载器
   （`staticModules`）注册；打进 bundle 会内联它的 CJS 构建，开头是
   `if (process.env.NODE_ENV !== "production") …`，浏览器里没有 `process`，于是在模块求值阶段抛
   `ReferenceError: process is not defined`，整个客户端半区加载失败：
   `web boot: 1 entry did not activate`。详见 `tsdown.config.ts` 的注释。

---

## 设计取舍（已知限制）

- 纯月包账号（没有一次性积分包的到期信息）在 `expiry` 方式下会沉到有到期信息的账号之后。
  这是刻意的——月包会刷新，不存在「快要流失」的额度。设置页会用排序原因把这一点解释出来。
- 上游的促销徽标只有**应用通道**（`PRODUCT_UA`）才看得见；用 CLI 通道的身份读同一份 `/v3/config`
  回来的是严格子集，既没有 `modelPromotions` 也没有 `modelTiers`。
- 凭据来源**只读**：插件从不写回桌面端的 `.info` 登录文件，也不索要密码。上游 401 触发的 token 刷新
  结果单独写在 `$DSH_HOME/<plugin-id>/credential-refresh.json`（文件 `0600`、目录 `0700`，里面是
  bearer token，属于本机私有数据）；自动化账本 `automation-ledger.json` 同目录，只存「今天哪个时段
  跑过」，不含任何凭据。

---

## License

MIT。见 [LICENSE](./LICENSE)。
