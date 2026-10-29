/**
 * 账号发现：把本机上每一份可用的 WorkBuddy 登录变成账号。
 *
 * 出处（逐条回源核对，不是凭记忆）：
 * - `plugins/dsh-workbuddy-xdpool/src/accounts.ts:131-165` `defaultDesktopAuthDirs`
 * - 同文件 `:543-552` `candidateAuthDirs`（`WORKBUDDY_AUTH_FILE` 可指文件或目录）
 * - 同文件 `:235-310` `parseWorkBuddyAuth`（`auth` / `account` 两段形状）
 * - 同文件 `:350-360` `workbuddyAccountId`（sha256 取计费身份前 16 位）
 * - 同文件 `:314-336` `authFilesIn`：目录下**所有** `*.info`，不只时间戳快照
 * - `plugins/dsh-connect-workbuddy/src/auth.ts:231` `WORKBUDDY_VAULT_DIRNAME`、
 *   `:264` `workbuddyVaultDir(region)`（`<dshHome>/workbuddy-vault/<region>`）
 * - `plugins/dsh-connect-workbuddy/src/host-peers.ts:132-155,287` `resolveDshHome`
 * - `plugins/dsh-connect-workbuddy/src/account-pool.ts:429-520` 排序键（已固化在
 *   `status-paths.ts` 的 `rankAccounts`，这里直接调用，不重写）
 *
 * ## 两处凭据来源，缺一不可
 *
 * 1. **桌面端 auth 目录**（`*.info`）：用户最近一次登录写下的文件。签名机制下
 *    较新的 Windows 构建把 `accessToken` 存成 `$wbEncrypted` 信封（见
 *    `at-rest.ts`），而**只有**「唯一那份文件是信封」的账号会因此整体读不出来。
 * 2. **dsh 凭据 vault**（`<dshHome>/workbuddy-vault/<region>/*.json`）：
 *    `dsh-connect-workbuddy` 把每个已知账号的**明文**凭据持久化在这里。装了它的
 *    机器（本机就是）因此有一份不受桌面包加密影响的副本。
 *
 * 只扫桌面端目录曾让本机 4 个账号里 2 个彻底消失（它们的唯一文件是加密快照），
 * 而 vault 里明明有这 4 个账号的明文 token 且上游全部可用——这是 F1 的根因：
 * `authFilesIn` 只收 `.info`，vault 的 `.json` 被无声滤掉，界面显示「0 个账号」
 * 且**跳过列表也是空的**，连「凭据被加密了」这条诊断都没有。
 *
 * 后缀因此按**目录语义**收：桌面端目录只收 `.info`（同目录里的
 * `*.observation.json` 是诊断产物，不是登录），vault 目录只收 `.json`。无差别收
 * `.json` 会把 `observation.json` 当成账号读进来。
 *
 * ## 加密字段怎么处理
 *
 * 先问 `at-rest.ts` 要 at-rest 密钥并尝试解密；解不开就照旧按
 * `reason: 'encrypted'` 上报并给出可操作提示（打开桌面端 / 设
 * `WORKBUDDY_APP_EXECUTABLE`）。**绝不**把打不开的加密字段降级成空 token ——
 * 那会让调用方以为用户没登录。
 *
 * @module dsh-connect-workbuddy-models/accounts
 */

import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { isEncryptedFieldWrapper, openEncryptedField, readAtRestKey } from './at-rest.ts'
import {
  DEFAULT_ACCOUNT_DISTRIBUTION,
  DEFAULT_EXPIRY_WARN_DAYS,
  PLUGIN_ID,
  rankAccounts,
  WB_REGIONS,
  type AccountDistribution,
  type WbAccountSource,
  type WbCheckinStatus,
  type WbCredits,
  type WbRankAccountRef,
  type WbRankedAccount,
  type WbRegion,
  type WbSkippedFile,
} from './status-paths.ts'
import { loadRefreshedCredentials } from './account-store.ts'
import {
  parseCreditMultiplier,
  regionOf,
  selectCliModels,
  workbuddyAccountId,
  type WbCredential,
  type WbUpstreamModel,
} from './upstream.ts'

/** 桌面端正在使用的那份登录文件名。它永远优先被选。 */
export const WORKBUDDY_LIVE_FILENAME = 'workbuddy-desktop.info'

/**
 * 覆盖登录文件（或它所在目录）的环境变量。
 *
 * 允许指目录，是因为用户在 issue 里报自己的路径时通常给的是目录；只认文件会让
 * 「我明明设了变量」变成一个静默的空池。
 */
export const WORKBUDDY_AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE'

function nonEmptyEnv(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * 平台默认的登录目录。
 *
 * Windows 先探 Local 再探 Roaming：重定向过配置文件的机器上，登录文件可能在
 * Roaming 里，而 `LOCALAPPDATA` 指向一个空目录——只探一个会得到「没有账号」。
 */
export function defaultDesktopAuthDirs(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  }
  if (platform === 'win32') {
    const local = nonEmptyEnv(env['LOCALAPPDATA']) ?? join(home, 'AppData', 'Local')
    const roaming = nonEmptyEnv(env['APPDATA']) ?? join(home, 'AppData', 'Roaming')
    return [
      join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
      join(roaming, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    ]
  }
  if (platform === 'linux') {
    const config = nonEmptyEnv(env['XDG_CONFIG_HOME']) ?? join(home, '.config')
    return [join(config, 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  }
  return []
}

// ── dsh 凭据 vault ────────────────────────────────────────────────────────

/** Harness home 的默认目录名。 */
const DSH_HOME_DIR_NAME = '.dsh'
/** 覆盖 Harness home 的环境变量。 */
const DSH_HOME_ENV = 'DSH_HOME'
/** vault 在 Harness home 下的目录名（与 `dsh-connect-workbuddy` 共用同一份磁盘格式）。 */
export const WORKBUDDY_VAULT_DIRNAME = 'workbuddy-vault'

/** 展开 `~`、`~/`、`~\`。其余路径原样返回（随后由 `resolve` 归一）。 */
function expandHomePath(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
}

/**
 * 解析 Harness home，判定顺序（高到低）：`$DSH_HOME` → `~/.dsh`。
 *
 * 逐条转写自 `plugins/dsh-connect-workbuddy/src/host-peers.ts:132-155` 的
 * `fallbackResolveDshHome`，**不**从那个包 import：跨包相对导入在本插件打包成
 * `lib/index.js` 之后会指到一个不存在的路径（两个插件各自独立发布）。转写而不是
 * 猜，是因为错了会**静默**扫错目录——表现为「vault 里明明有 4 个账号，插件报
 * 0 个」，而这与「这台机器确实没登录过」在界面上长得一模一样。
 *
 * 空白 `$DSH_HOME` 当作未设置：否则 `DSH_HOME=""` 会让 home 落到当前工作目录，
 * 于是我在一个随机目录里找 `workbuddy-vault`。
 */
export function resolveDshHome(
  configured?: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const fromEnv = nonEmptyEnv(env[DSH_HOME_ENV])
  const chosen = configured ?? fromEnv ?? join(home, DSH_HOME_DIR_NAME)
  return resolve(expandHomePath(chosen, home))
}

/** vault 里某个区域的目录：`<dshHome>/workbuddy-vault/<region>`。 */
export function workbuddyVaultDir(
  region: WbRegion,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return join(resolveDshHome(undefined, env, home), WORKBUDDY_VAULT_DIRNAME, region)
}

/** vault 的两个区域目录，顺序固定 `cn` → `global`。 */
export function workbuddyVaultDirs(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  return WB_REGIONS.map(region => workbuddyVaultDir(region, env, home))
}

/**
 * 一个候选目录，以及它是哪一类来源。
 *
 * 只带路径不够：后缀策略取决于目录**是**什么。桌面端目录里的
 * `workbuddy-desktop.observation.json` 是诊断产物，vault 目录里的 `.json` 才是
 * 登录；用同一套后缀规则必然在其中一边读错。
 */
export interface WbAuthSource {
  dir: string
  kind: 'desktop' | 'vault'
}

/** 该目录该收的后缀。 */
function suffixesOf(kind: WbAuthSource['kind']): readonly string[] {
  return kind === 'vault' ? ['.json'] : ['.info']
}

/**
 * 目录语义 → 给人看的登录出处。
 *
 * 两套词表故意不同名：`WbAuthSource.kind` 说的是「这个目录怎么读」（后缀策略），
 * `WbAccountSource` 说的是「这份凭据来自哪次登录」（决定该去重登桌面端还是重登
 * dsh-connect-workbuddy）。直接在这里给出 `'dsh'` 字面量，既是 `WbAccountSource`
 * 里那个成员唯一的产出点，也是这一层唯一的映射表。
 */
const SOURCE_OF_KIND: Readonly<Record<WbAuthSource['kind'], WbAccountSource>> = {
  vault: 'dsh',
  desktop: 'desktop',
}

/**
 * 要扫描的目录列表：环境变量覆盖量 → 平台默认桌面端目录 → vault 两区域（去重）。
 *
 * vault 排**最后**：桌面端是唯一能反映「用户刚登录过」的来源，让它先被读到，
 * 同一后缀轮内的粗排才是「活文件在前」。
 */
export function candidateAuthSources(env: NodeJS.ProcessEnv = process.env): WbAuthSource[] {
  const sources: WbAuthSource[] = []
  const seen = new Set<string>()
  const push = (dir: string, kind: WbAuthSource['kind']): void => {
    if (seen.has(dir)) return
    seen.add(dir)
    sources.push({ dir, kind })
  }
  const override = nonEmptyEnv(env[WORKBUDDY_AUTH_FILE_ENV])
  if (override !== undefined) {
    // 覆盖量可能是 `.info` 文件、vault 的 `.json` 快照，或一个目录。按后缀判定它是
    // 哪一类，好让「用户手工指向自己那份 vault 拷贝」也能读到 `.json`。
    const lower = override.toLowerCase()
    const isFile = lower.endsWith('.info') || lower.endsWith('.json')
    push(isFile ? resolve(override, '..') : resolve(override), lower.endsWith('.json') ? 'vault' : 'desktop')
  }
  for (const dir of defaultDesktopAuthDirs()) push(dir, 'desktop')
  for (const dir of workbuddyVaultDirs(env)) push(dir, 'vault')
  return sources
}

/** 同 {@link candidateAuthSources} 的纯路径视图（既有调用点与诊断脚本用）。 */
export function candidateAuthDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return candidateAuthSources(env).map(source => source.dir)
}

// ── 解析 ──────────────────────────────────────────────────────────────────

/**
 * 凭据里存在加密字段，且本机打不开。
 *
 * 独立错误类而不是返回 `undefined`：调用方必须能区分「没登录」与「登录了，但持有
 * 密钥的应用不在」——后者让用户「重新登录」是错的（他本来就登着）。
 *
 * 文案给出两**条**互斥的出路，因为这是两种不同的机器状态：装过
 * `dsh-connect-workbuddy` 的机器上有 vault 明文副本（那就不会走到这里，除非 vault
 * 也被删了）；只装了桌面端的机器必须让桌面端在场，密钥只存在于它的进程里。
 */
export class WbEncryptedCredentialError extends Error {
  constructor(readonly sourcePath: string) {
    super(
      `workbuddy: ${sourcePath} 的登录令牌被桌面端加密了（$wbEncrypted），本机取不到解密的 at-rest 密钥。`
      + '请启动 WorkBuddy 桌面端并完成一次登录（密钥在它的进程里），'
      + '或设置 WORKBUDDY_APP_EXECUTABLE 指向桌面端可执行文件。',
    )
    this.name = 'WbEncryptedCredentialError'
  }
}

/** 秒或毫秒的到期时间统一成毫秒。 */
function expiryToMs(value: number): number {
  if (value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 打开一个字段的信封实现，或 `undefined`（没有 at-rest 密钥）。
 *
 * 这个签名就是 {@link parseWorkBuddyAuth} 第三个参数的类型：把「怎么开信封」注入
 * 而不是在解析器里直接 `import` 密钥读取，解析才是一个**纯函数**——单测可以喂一
 * 份合成信封和一个假密钥，不必在这台机器上装 WorkBuddy 桌面端。
 */
export type WbFieldDecrypt = (field: unknown) => string

/** 一个字段读出来的三态。 */
interface WbFieldRead {
  /** 明文值；空串表示「没有值」。 */
  value: string
  /** 字段是 `$wbEncrypted` 信封。 */
  encrypted: boolean
  /** 是信封且**解不开**（没有密钥，或密钥/信封不匹配）。 */
  failed: boolean
}

/**
 * 读一个字符串字段：可能是普通字符串（旧构建），也可能是桌面包出来的
 * `$wbEncrypted` 信封。
 *
 * 三态而不是两态：`failed` 让调用方能区分「字段就是空的」与「字段加密了但我打不
 * 开」——后者要按 `reason: 'encrypted'` 上报并让用户去开桌面端，前者才是「没登录」。
 *
 * 解密失败**不降级成空串**：那会让一份完好（只是本机没密钥）的凭据看起来像空的，
 * 于是用户在界面上看到「没有账号」而跳过列表里也没有任何解释。
 */
function fieldOf(value: unknown, decrypt: WbFieldDecrypt | undefined): WbFieldRead {
  if (typeof value === 'string') return { value, encrypted: false, failed: false }
  if (isEncryptedFieldWrapper(value)) {
    if (decrypt === undefined) return { value: '', encrypted: true, failed: true }
    try {
      return { value: decrypt(value), encrypted: true, failed: false }
    } catch {
      // 密钥不对、信封被截断、GCM 校验失败都走这里。认证失败必须抛（见 at-rest.ts），
      // 所以这里捕获的是「确实打不开」，而不是「打了但内容可疑」。
      return { value: '', encrypted: true, failed: true }
    }
  }
  return { value: '', encrypted: false, failed: false }
}

/**
 * 解析一个登录文件。
 *
 * 形状两种都认：`{ auth: {...}, account: {...} }`（桌面端与 vault 都是这个）与平铺
 * 的一层（插件自己导出的）。身份字段优先读 `account` 段。
 *
 * `decrypt` 是**可选**第三参：不传就是「只认明文构建」，这与每个拿不到 at-rest 密钥
 * 的调用点应当传入的东西一致（`undefined` 而非抛错的实现）。因此既有两参调用点
 * 行为不变。
 *
 * 报价：`accessToken` 是信封且打不开 → 抛 {@link WbEncryptedCredentialError}，
 * **绝不**当成「空 token 的可读凭据」。
 */
export function parseWorkBuddyAuth(
  text: string,
  sourcePath: string,
  decrypt?: WbFieldDecrypt,
): WbCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>

  let auth: Record<string, unknown>
  let identity: Record<string, unknown>
  if (typeof document['auth'] === 'object' && document['auth'] !== null) {
    auth = document['auth'] as Record<string, unknown>
    identity = typeof document['account'] === 'object' && document['account'] !== null
      ? document['account'] as Record<string, unknown>
      : {}
  } else {
    auth = document
    identity = document
  }

  const accessField = fieldOf(auth['accessToken'], decrypt)
  // accessToken 是账号可用的必要条件：它是每个上游调用都带的那个 token。打不开就
  // 没有别的办法替它——refreshToken 只能换新 token，而刷新本身也要先能读它。
  if (accessField.failed) throw new WbEncryptedCredentialError(sourcePath)
  if (accessField.value === '') return undefined

  const refreshExpiresAtMs = typeof auth['refreshExpiresAt'] === 'number'
    ? expiryToMs(auth['refreshExpiresAt'])
    : undefined
  const lastRefreshAtMs = typeof auth['lastRefreshTime'] === 'number'
    ? expiryToMs(auth['lastRefreshTime'])
    : undefined
  // 昵称加密读不开**不**影响账号可用：它是显示用的，且上游 `/v2/billing` 不认它。
  // 所以这里静默取空即可——把整份凭据判成不可用会为了一个装饰字段丢掉一个账号。
  const nickname = fieldOf(identity['nickname'], decrypt).value
  // refreshToken 同理接上解密：它加密且打不开时该账号仍可用（现有 accessToken 还能
  // 用一阵），所以失败**不**抛；能解开就一定要拿到，否则刷新窗口一到就救不回来。
  const refreshToken = fieldOf(auth['refreshToken'], decrypt).value

  return {
    accessToken: accessField.value,
    refreshToken,
    expiresAtMs: typeof auth['expiresAt'] === 'number' ? expiryToMs(auth['expiresAt']) : 0,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    ...lastRefreshAtMs === undefined ? {} : { lastRefreshAtMs },
    ...optionalString(nickname) === undefined ? {} : { nickname: optionalString(nickname) },
    ...optionalString(identity['uin']) === undefined ? {} : { uin: optionalString(identity['uin']) },
    ...optionalString(identity['uid']) === undefined ? {} : { uid: optionalString(identity['uid']) },
    ...optionalString(identity['enterpriseId']) === undefined
      ? {}
      : { enterpriseId: optionalString(identity['enterpriseId']) },
    domain: typeof auth['domain'] === 'string' ? auth['domain'] : '',
    sourcePath,
  }
}

/**
 * 稳定的账号 id：`uin` 是上游计费的身份，重新登录后不变；回退 `uid`。
 *
 * 实现搬到了 `upstream.ts`（紧挨 `WbCredential`），因为**写入侧也要用它**：刷新后
 * 的 token 按账号落盘发生在 `chatStream` 里，而读回发生在账号发现里。这里保留同名
 * 再导出，让「id 属于账号发现」的既有调用点与测试不必改，同时两边共用同一份公式。
 */
export { workbuddyAccountId } from './upstream.ts'

/** 人话名字；同名账号用 uid 前缀区分。 */
export function accountLabel(credential: WbCredential): string {
  const name = credential.nickname ?? 'WorkBuddy'
  const discriminator = (credential.uid ?? credential.uin ?? '').slice(0, 8)
  return discriminator === '' ? name : `${name}#${discriminator}`
}

/** 该文件是否是桌面端正在使用的登录（相对历史快照而言）。 */
function isLiveAuthFile(path: string): boolean {
  return basename(path) === WORKBUDDY_LIVE_FILENAME
}

/**
 * 同一账号两份额度凭据里该留哪一份，最高优先在前：
 *
 * 1. 桌面端正在用的活文件；
 * 2. 上游最近签发的那份（`lastRefreshAtMs`）；
 * 3. 更晚的存储到期时间（只用于完全没有签发时间的文档）。
 *
 * 单看存储到期时间**不是**新鲜度信号：上游吊销 token 时不改写它，所以一份早已
 * 死掉的备份可以声称比真正能用的 token 到期更晚。按它选号曾让每次调用都 401，
 * 而同一个目录里明明躺着好凭据。
 *
 * 刷新窗口已关闭的文件排在最后：它救不回来（`refreshExpiresAt` 都过了），把它
 * 排在同账号的有效凭据之前只会让这个账号彻底不可用。
 */
function compareFreshness(a: WbDiscoveredAccount, b: WbDiscoveredAccount): number {
  if (a.refreshExpired !== b.refreshExpired) return a.refreshExpired ? 1 : -1
  const aLive = isLiveAuthFile(a.sourcePath) ? 1 : 0
  const bLive = isLiveAuthFile(b.sourcePath) ? 1 : 0
  if (aLive !== bLive) return bLive - aLive
  const aIssued = a.credential.lastRefreshAtMs ?? 0
  const bIssued = b.credential.lastRefreshAtMs ?? 0
  if (aIssued !== bIssued) return bIssued - aIssued
  return b.credential.expiresAtMs - a.credential.expiresAtMs
}

/**
 * 两次发现拿到的，还是不是同一份登录凭据。
 *
 * 判据取 `accessToken` 与 `refreshToken` 两条——只有它们变了才算「换了一份凭据」。
 * 不能用 `expiresAtMs`：上游刷新 token 时只改到期时间不改字符串的构建是存在的，
 * 那种情况下凭据其实还是被拒的那一份。也不能只比 `accessToken`：一次「上游拒绝
 * refresh token」之后，用户可能只重新签发了 refresh 那一条。
 *
 * 只在 `credentialDead === true` 时被调用，所以「空串对空串」这类退化比较不必
 * 防御：真死掉的凭据至少有一个非空 token，否则它连请求都发不出去。
 */
function credentialRotated(previous: WbDiscoveredAccount, next: WbDiscoveredAccount): boolean {
  return previous.credential.accessToken !== next.credential.accessToken
    || previous.credential.refreshToken !== next.credential.refreshToken
}

// ── 发现 ──────────────────────────────────────────────────────────────────

/**
 * 一个被发现并解析成功的账号。
 *
 * 显式满足 `WbRankAccountRef`：`rankAccounts` 用 `tokenExpiresAtMs` 做最后的平局
 * 判定，少这个字段会让所有同余额账号退化成按 id 排——而 id 是哈希，等于随机。
 */
export interface WbDiscoveredAccount extends WbRankAccountRef {
  id: string
  /** 凭据到期时刻（ms）；0 或缺失表示上游没给。 */
  tokenExpiresAtMs?: number
  /** 人话名字；桌面包里没有昵称时是 `WorkBuddy`。 */
  label: string
  credential: WbCredential
  region: WbRegion
  sourcePath: string
  /**
   * 这份凭据是从哪类来源读到的。
   *
   * 必填且不下默认值：桌面端 `.info` 与 dsh vault `.json` 的续期方式完全不同——
   * 前者要用户回桌面端重登，后者重新登录 `dsh-connect-workbuddy` 也可能救回来。
   * 让这个字段缺省成 `'desktop'` 会把「没接通」伪装成「接通了」，正是这一缺陷
   * 当初躲过复核的方式。
   */
  source: WbAccountSource
  /** 是否是桌面端正在使用的那份登录。 */
  live: boolean
  /**
   * 刷新窗口已关闭：这份凭据救不回来了。
   *
   * 不当作「跳过文件」而是当成一个**账号状态**：用户看到「某某账号的登录窗口已于
   * X 关闭」比看到「你的 4 个文件里有 1 个读不了」更能采取行动。
   */
  refreshExpired: boolean
}

export interface WbDiscoveryResult {
  accounts: readonly WbDiscoveredAccount[]
  skipped: readonly WbSkippedFile[]
}

/**
 * 一个目录里该收的全部登录文件，名字新的在前（同 uid 冲突时的第一轮粗排）。
 *
 * 后缀来自目录**语义**（`suffixesOf`），不是一张全局白名单：桌面端目录只收
 * `.info`，vault 目录只收 `.json`。无差别收 `.json` 会把桌面端目录里的
 * `workbuddy-desktop.observation.json` 当成账号读进来。
 */
async function authFilesIn(source: WbAuthSource): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(source.dir)
  } catch {
    return []
  }
  const suffixes = suffixesOf(source.kind)
  return entries
    .filter(name => suffixes.some(suffix => name.toLowerCase().endsWith(suffix)))
    // `.info.<hash>.observation.json` 这类诊断文件在桌面端目录里不以 `.info` 结尾，
    // 自然排除；而 `.Tencent-Cloud….info.workbuddy.lock` 是一个目录，readFile 会
    // 失败——那时按 'unreadable' 上报，用户能看出是什么占着那个名字。
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .map(name => join(source.dir, name))
}

/**
 * 读一个文件，返回账号 / 跳过原因。
 *
 * 失败一律**返回原因而不是抛错**：一个坏文件不能让整次扫描返回空池。旧实现把
 * 加密错误一路抛出 scan，把已经解析成功的账号全丢了——用户看到「4 个账号变成 2 个」。
 */
async function readAccount(
  path: string,
  decrypt: WbFieldDecrypt | undefined,
  kind: WbAuthSource['kind'],
): Promise<WbDiscoveredAccount | WbSkippedFile> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { path, reason: 'unreadable' }
  }
  let credential: WbCredential | undefined
  try {
    credential = parseWorkBuddyAuth(text, path, decrypt)
  } catch (error: unknown) {
    // 加密凭据打不开是**一等结果**：用户能据此去开桌面端，或去装
    // `dsh-connect-workbuddy` 让 vault 里有明文副本。绝不能静默丢掉。
    if (error instanceof WbEncryptedCredentialError) return { path, reason: 'encrypted' }
    return { path, reason: 'malformed' }
  }
  if (credential === undefined) return { path, reason: 'malformed' }
  const refreshExpired = credential.refreshExpiresAtMs !== undefined
    && credential.refreshExpiresAtMs > 0
    && credential.refreshExpiresAtMs < Date.now()
  return {
    id: workbuddyAccountId(credential),
    label: accountLabel(credential),
    credential,
    region: regionOf(credential.domain),
    sourcePath: path,
    source: SOURCE_OF_KIND[kind],
    live: isLiveAuthFile(path),
    refreshExpired,
    ...credential.expiresAtMs > 0 ? { tokenExpiresAtMs: credential.expiresAtMs } : {},
  }
}

/**
 * 把调用方给的裸目录补成带来源语义的条目。
 *
 * `discoverAccounts({ authDirs })` 是既有 API（诊断脚本与单测都用它），只给路径。
 * 判定规则只看**形状**：`<...>/workbuddy-vault/<region>` 才算 vault，其余当桌面端。
 * 于是临时目录里的 `observation.json` 仍被排除，而「手工指向 vault 拷贝」也能读。
 */
function sourceOf(dir: string): WbAuthSource {
  const isVault = basename(resolve(dir, '..')) === WORKBUDDY_VAULT_DIRNAME
  return { dir, kind: isVault ? 'vault' : 'desktop' }
}

/**
 * 用 at-rest 密钥构造一次信封解密器。
 *
 * 取密钥可能失败（本机没装桌面端 / 装了但没登录过），也可能抛错；两种情况都返回
 * `undefined`，由 {@link fieldOf} 把加密字段报成 `failed` 而不是把整次扫描炸掉。
 * 每次扫描只取一次密钥：{@link readAtRestKey} 自己缓存，但一次扫描里重复调它会
 * 在同一次 miss 上串行等同一份子进程结果。
 */
async function defaultDecrypt(): Promise<WbFieldDecrypt | undefined> {
  let key: Buffer | undefined
  try {
    key = await readAtRestKey()
  } catch {
    return undefined
  }
  if (key === undefined) return undefined
  return (field: unknown) => {
    if (!isEncryptedFieldWrapper(field)) {
      // 调用方只该在检测为信封时才问解密器；真的问到非信封，按明文原样返回比抛错
      // 更安全（抛错会被 fieldOf 记成 failed，把一个明明可读的字段判死）。
      return typeof field === 'string' ? field : ''
    }
    return openEncryptedField(field, key)
  }
}

/**
 * 把「本插件自己刷新过的那份凭据」盖到磁盘读出来的账号上。
 *
 * 为什么必须有这一步：刷新只发生在内存里（`chatStream` 原地改写 credential），而
 * 磁盘上的 `.info` / vault `.json` 仍是旧 token——本插件**不回写**桌面端文件（那
 * 是它的私有状态，且加密信封根本回写不了）。于是一旦重新扫描，`applyDiscovery`
 * 用磁盘内容整体替换 `account`，刚换来的新 token 就被旧值盖回去了，表现为「明明
 * 刚刷新成功，过一会儿又全部 401」。刷新记录因此必须先于折叠/排序生效。
 *
 * 谁赢用两个问题判定，都不看存储到期时间：
 *
 * 1. **磁盘那份是不是用户重新登录写的？** 刷新记录里的 `refreshedAtMs` 早于凭据
 *    自带的 `lastRefreshAtMs` 时，说明桌面端/vault 在那之后又签发过一次，用户的
 *    新登录必须赢——否则换了账号密码还是用旧 token。
 * 2. **记录里的 token 自己是不是已经过期？** 过期了但磁盘那份还没过期，就用磁盘
 *    的；两层都过期就照旧用记录（它带着旋转后的 refresh token，是唯一还能续期的
 *    凭据），让 `chatStream` 的到期即刷把它救回来。
 */
function withRefreshedCredential(
  account: WbDiscoveredAccount,
  entry: { accessToken: string; refreshToken?: string; expiresAtMs: number; refreshedAtMs: number } | undefined,
  nowMs: number,
): WbDiscoveredAccount {
  if (entry === undefined) return account
  const diskIssuedAtMs = account.credential.lastRefreshAtMs ?? 0
  if (entry.refreshedAtMs <= diskIssuedAtMs) return account
  const recordedExpired = entry.expiresAtMs > 0 && entry.expiresAtMs <= nowMs
  const diskUsable = account.credential.expiresAtMs > nowMs
  if (recordedExpired && diskUsable) return account
  const credential: WbCredential = {
    ...account.credential,
    accessToken: entry.accessToken,
    ...entry.refreshToken === undefined ? {} : { refreshToken: entry.refreshToken },
    expiresAtMs: entry.expiresAtMs,
    lastRefreshAtMs: entry.refreshedAtMs,
  }
  return {
    ...account,
    credential,
    // 派生字段跟着凭据走，否则选号会按「旧 token 的到期时刻」排序。
    ...credential.expiresAtMs > 0 ? { tokenExpiresAtMs: credential.expiresAtMs } : { tokenExpiresAtMs: undefined },
  }
}

/**
 * 扫描全部候选目录，把每个可解析文件变成一个账号。
 *
 * 同一账号的多份快照折叠成一份（见 {@link compareFreshness}）：池里一个账号只能
 * 出现一次，否则「剩余总积分」会把同一个人的历史快照重复相加。
 *
 * `decrypt` 不接受外部注入——它是内部实现细节；单测要喂合成信封时直接测
 * {@link parseWorkBuddyAuth} 的三参形态，那条路径才是真正的契约面。
 */
export async function discoverAccounts(
  options: { authDirs?: readonly string[]; env?: NodeJS.ProcessEnv } = {},
): Promise<WbDiscoveryResult> {
  const sources = options.authDirs === undefined
    ? candidateAuthSources(options.env ?? process.env)
    : options.authDirs.map(sourceOf)
  const decrypt = await defaultDecrypt()
  const byId = new Map<string, WbDiscoveredAccount>()
  const skipped: WbSkippedFile[] = []
  for (const source of sources) {
    for (const path of await authFilesIn(source)) {
      const read = await readAccount(path, decrypt, source.kind)
      if ('reason' in read) {
        skipped.push(read)
        continue
      }
      const incumbent = byId.get(read.id)
      if (incumbent === undefined || compareFreshness(read, incumbent) < 0) byId.set(read.id, read)
    }
  }
  // 刷新记录盖在磁盘内容之上（理由见 withRefreshedCredential）：这一步必须在折叠
  // 之后、返回之前，因为折叠已经按「磁盘新鲜度」选出了代表，而现在要问的是「本插件
  // 刷新过的那份是不是更新」。
  const refreshed = await loadRefreshedCredentials(PLUGIN_ID)
  const nowMs = Date.now()
  // 排序只求稳定：真正的「下一个该谁服务」由 rankAccounts 决定，这里让同一份磁盘
  // 内容两次扫描给出同一个顺序，便于断言与日志比对。
  const accounts = [...byId.values()]
    .map(account => withRefreshedCredential(account, refreshed[account.id], nowMs))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { accounts, skipped }
}

// ── 池 ────────────────────────────────────────────────────────────────────

/** 一轮选号的结果：选中谁，以及整份名次（界面要显示「为什么它排在后面」）。 */
export interface WbPickResult<TAccount extends WbRankAccountRef = WbDiscoveredAccount> {
  account?: TAccount
  ranked: readonly WbRankedAccount<TAccount>[]
}

/** `sticky` 记住多少个会话→账号绑定。只是内存上限：淘汰最老的一条只花一次重选。 */
const STICKY_AFFINITY_LIMIT = 200

/** 一个账号此刻的池状态。 */
export interface WbPoolEntry {
  account: WbDiscoveredAccount
  /** 最近一次读到的积分；没读过时缺省（**不是** 0）。 */
  credits?: WbCredits
  /**
   * 最近一次读到的签到状态。
   *
   * 和 `credits` 一样缓存在池里而不是每次现问：卡片靠 `/status` 轮询，而签到状态
   * 一天只变一次。探测层拿到它就存进来，卡片与调度器共用同一份读数。
   */
  checkin?: WbCheckinStatus
  /** 上游明确拒绝过这份凭据后置位；只有重新登录才该清除。 */
  credentialDead?: boolean
}

/**
 * 账号池：持有发现结果、积分读数与选号策略。
 *
 * 选号**一定**走 `rankAccounts`（status-paths 的纯函数）——五种 `distribution` 的
 * 差别在于「怎么消费这份有序列表」，而不是「谁是下一个」。把分布塞进比较器会让
 * 同一份顺序对五种模式给出五种互不相同的解释，其中四种是错的。
 */
export class WbAccountPool {
  private entries: WbPoolEntry[] = []
  private skipped: readonly WbSkippedFile[] = []
  private scannedAtMs = 0
  /** 每个区域的轮转游标（`round-robin`）。 */
  private readonly cursors = new Map<WbRegion, number>()
  /** 会话 → 账号绑定（`sticky`）。Map 的插入序即 LRU 序。 */
  private readonly affinity = new Map<string, string>()
  /** 用户手动指定的当前账号（按区域），优先级高于任何分布。 */
  private readonly preferred = new Map<WbRegion, string>()

  constructor(
    private readonly options: {
      /** 参与池的账号 id；空数组合义由调用方决定（本类视为「全部参与」）。 */
      enabledIds?: readonly string[]
      orderIds?: readonly string[]
      distribution?: AccountDistribution
      /**
       * 临期窗口（天），取自用户的 `expiryWarnDays`。
       *
       * 池不读配置（那是 `index.ts` 的职责），只把它**转交**给排序层：`rank()`
       * 会作为 `rankAccounts` 的第 5 个实参传出。缺省时排序层用自己的兜底 3 天。
       */
      expiryWarnDays?: number
      logger?: { warn(...args: unknown[]): void; info?(...args: unknown[]): void }
    } = {},
  ) {}

  /** 用一次发现结果替换池内容，保留同一账号的积分读数与死凭据标记。 */
  applyDiscovery(result: WbDiscoveryResult): void {
    const previous = new Map(this.entries.map(entry => [entry.account.id, entry]))
    // 重登后该恢复服务的账号。收集起来在替换 entries 之后再清标记：`clear` 走
    // `find()`，在 map 回调里调它清的是**正在被替换掉的那一份**，虽然结果一样，
    // 但读代码的人会以为它没见过新凭据。
    const revived: string[] = []
    this.entries = result.accounts.map(account => {
      const kept = previous.get(account.id)
      if (kept === undefined) return { account }
      // 死凭据标记只在**同一个凭据**上成立。
      //
      // `credentialDead` 的含义是「上游明确拒绝了这份 accessToken / refreshToken」。
      // 用户回桌面端重登一次，磁盘上的凭据就换了，这个判断随之作废——不变量是
      // 「标记属于凭据，不属于账号 id」。以前这里无条件 `{ ...kept, account }`，
      // 于是标记跟着 id 走，一次拒绝在用户重登之后依然生效，而排障路径上没有任何
      // 地方会清它（`clearCredentialDead` 当时零调用者），只能重启 DSH。
      //
      // 反过来也不能无条件清：真被拒的凭据每 10 分钟 rescan 一次就重新参选一次，
      // 每次都撞一次 401，卡片上「上游已拒绝」的提示会一闪一闪。所以判据是
      // **凭据指纹变了没有**，而不是「rescan 过没有」。
      if (kept.credentialDead === true && credentialRotated(kept.account, account)) {
        revived.push(account.id)
        return { ...kept, account, credentialDead: undefined }
      }
      return { ...kept, account }
    })
    for (const accountId of revived) this.clearCredentialDead(accountId)
    this.skipped = result.skipped
    this.scannedAtMs = Date.now()
  }

  /**
   * 施加一次配置。
   *
   * 单独一个方法而不是让调用方重建池：池持有**积分读数**、会话亲和与轮转游标，
   * 换号设置一次就可能被改一次，重建池会把用户刚看到的余额全部清空（卡片忽然
   * 变成「余额未知」），并把 `sticky` 的会话绑定丢掉。
   *
   * 字段为 `undefined` 时保持原值（来自「这次配置里没有这一项」，而不是「清空」）。
   */
  applyConfig(config: {
    enabledIds?: readonly string[] | undefined
    orderIds?: readonly string[] | undefined
    distribution?: AccountDistribution | undefined
    expiryWarnDays?: number | undefined
  }): void {
    if (config.enabledIds !== undefined) this.options.enabledIds = config.enabledIds
    if (config.orderIds !== undefined) this.options.orderIds = config.orderIds
    if (config.distribution !== undefined) this.options.distribution = config.distribution
    if (config.expiryWarnDays !== undefined) this.options.expiryWarnDays = config.expiryWarnDays
  }

  /** 当前的临期窗口（天）。缺省表示「从未配置」，排序层用兜底值。 */
  get expiryWarnDays(): number | undefined {
    return this.options.expiryWarnDays
  }

  /** 扫描时间（ms）；从未扫描时 0。 */
  get lastScannedAtMs(): number {
    return this.scannedAtMs
  }

  /** 被跳过的文件，原样上报。 */
  get skippedFiles(): readonly WbSkippedFile[] {
    return this.skipped
  }

  /** 全部账号（不论是否参与池），按 id 升序。 */
  list(): readonly WbPoolEntry[] {
    return this.entries
  }

  /** 某区域的账号。 */
  listRegion(region: WbRegion): readonly WbPoolEntry[] {
    return this.entries.filter(entry => entry.account.region === region)
  }

  find(accountId: string): WbPoolEntry | undefined {
    return this.entries.find(entry => entry.account.id === accountId)
  }

  /** 记一次积分读数。到期时间与余额同行——`expiry` 分布靠它排序。 */
  noteCredits(accountId: string, credits: WbCredits | undefined): void {
    const entry = this.find(accountId)
    if (entry === undefined) return
    if (credits === undefined) delete entry.credits
    else entry.credits = credits
  }

  /**
   * 记下签到状态。
   *
   * `undefined` 表示「这次没读到」，与 `undefined` 的积分同理：**不要**把它当作
   * 「今天没签到」——那会让卡片把一次网络失败渲染成「待签到」并怂恿用户去点。
   * 所以传 `undefined` 时保留旧读数而不是清除。
   */
  noteCheckin(accountId: string, checkin: WbCheckinStatus | undefined): void {
    const entry = this.find(accountId)
    if (entry === undefined || checkin === undefined) return
    entry.checkin = checkin
  }

  /** 上游拒绝过这份凭据。 */
  markCredentialDead(accountId: string): void {
    const entry = this.find(accountId)
    if (entry !== undefined) entry.credentialDead = true
  }

  /** 清掉死凭据标记（重新登录 / 重新扫描后）。 */
  clearCredentialDead(accountId: string): void {
    const entry = this.find(accountId)
    if (entry !== undefined) delete entry.credentialDead
  }

  /** 设置某区域的当前账号（用户显式选择）。 */
  setPreferred(region: WbRegion, accountId: string | undefined): void {
    if (accountId === undefined || accountId === '') this.preferred.delete(region)
    else this.preferred.set(region, accountId)
  }

  /** 当前账号（按区域）。 */
  preferredOf(region: WbRegion): string | undefined {
    return this.preferred.get(region)
  }

  /** 该账号是否参与池。`enabledIds` 为空 = 全部参与。 */
  isEnabled(accountId: string): boolean {
    const enabled = this.options.enabledIds
    if (enabled === undefined || enabled.length === 0) return true
    return enabled.includes(accountId)
  }

  /**
   * 一个账号此刻为什么不能服务；能服务时缺省。
   *
   * 这段话会**原样显示在账号卡片上**，所以每一条都要能让用户采取行动（「重新登录」、
   * 「加入池」、「等 X 分钟」），而不是只说「不可用」。
   */
  exclusionReason(entry: WbPoolEntry): string | undefined {
    if (!this.isEnabled(entry.account.id)) {
      return '未加入池（在「参与池的账号」里勾选它）'
    }
    if (entry.account.refreshExpired) {
      const at = entry.account.credential.refreshExpiresAtMs
      const when = at === undefined ? '' : `（${new Date(at).toLocaleString('zh-CN')}）`
      return `登录窗口已关闭${when}，请重新登录 WorkBuddy 桌面端`
    }
    if (entry.credentialDead === true) {
      return '上游已拒绝这份登录凭据，请重新登录 WorkBuddy 桌面端'
    }
    return undefined
  }

  /**
   * 排序一个区域的成员。`distribution` 的 `expiry` 语义在这里生效。
   *
   * `credits` 理想上由探测层按**用户配置的 `expiryWarnDays`** 聚合过（`probe.ts`
   * 负责），那样 `expiringSoon` 是显式值、`expiryFactsOf` 直接采信。但请求路径上
   * 余额是 `shim.ts` 写的——它拿得到原始包、拿不到聚合结果的历史——所以用户窗口
   * 还有第二条路：作为 `rankAccounts` 的第 5 个实参传下去，让排序层的兜底推算也
   * 按同一个窗口算。两条路都给，任何一条断了都不会静默退回 3 天。
   */
  rank(region: WbRegion, nowMs = Date.now()): readonly WbRankedAccount<WbDiscoveredAccount>[] {
    const members = this.listRegion(region).map(entry => ({
      account: entry.account,
      ...entry.credits === undefined ? {} : { credits: entry.credits },
      usable: this.exclusionReason(entry) === undefined,
    }))
    return rankAccounts(
      members,
      nowMs,
      this.options.orderIds ?? [],
      this.options.distribution ?? DEFAULT_ACCOUNT_DISTRIBUTION,
      this.options.expiryWarnDays ?? DEFAULT_EXPIRY_WARN_DAYS,
    )
  }

  /**
   * 选下一个该服务的账号。
   *
   * 五种分布都**真正分支**（R4：不得只声明不生效），且都建立在同一份
   * {@link rank} 顺序之上：
   *
   * - `priority`：永远队首——单号额度大时「用完一个再换」最省事。
   * - `round-robin`：按游标依次轮过可用成员。
   * - `balanced`：按余额权重抽取，冷清时也不会把第一个号抽干。
   * - `sticky`：一个会话钉一个号；新会话换下一个可用号（保住上游 prompt 缓存）。
   * - `expiry`：队首即「一次性积分包最先到期」的账号（R3）。
   *
   * 用户在卡片上显式选的当前账号（{@link setPreferred}）优先于任何分布——那是
   * 一个明确指令，不是一次采样。
   */
  pick(
    region: WbRegion,
    options: { conversationKey?: string; nowMs?: number; excludeIds?: readonly string[] } = {},
  ): WbPickResult<WbDiscoveredAccount> {
    const ranked = this.rank(region, options.nowMs ?? Date.now())
    // `excludeIds` 是**本次请求内**已经试过并失败的账号（限流 / 硬额度）。它只影响
    // 这一次选号，不写进池状态：一次 429 不该让账号在整个进程生命周期里消失，
    // 下一次请求它仍应被考虑（上游的限流窗口很快滚过去）。冷却的长期记录在 shim
    // 里，按 (账号, 模型) 计，因为上游限流是按模型算的。
    const excluded = options.excludeIds === undefined ? undefined : new Set(options.excludeIds)
    const usable = ranked.filter(row =>
      this.exclusionReason(this.entryOf(row.account)) === undefined
      && (excluded === undefined || !excluded.has(row.account.id)))
    if (usable.length === 0) return { ranked }

    const preferredId = this.preferred.get(region)
    if (preferredId !== undefined) {
      const chosen = usable.find(row => row.account.id === preferredId)
      if (chosen !== undefined) return { account: chosen.account, ranked }
    }

    const distribution = this.options.distribution ?? DEFAULT_ACCOUNT_DISTRIBUTION
    switch (distribution) {
      case 'round-robin': {
        const cursor = this.cursors.get(region) ?? 0
        const chosen = usable[cursor % usable.length]
        this.cursors.set(region, cursor + 1)
        return chosen === undefined ? { ranked } : { account: chosen.account, ranked }
      }
      case 'balanced': {
        // 权重 = 余额 + 1：余额为 0（或未知）的账号仍有一点机会被选中，否则一个
        // 刚被抽干的账号会永久失去被探测的机会，用户永远看不到它其实又满额了。
        const weights = usable.map(row => Math.max(1, row.score))
        const total = weights.reduce((sum, weight) => sum + weight, 0)
        let ticket = Math.random() * total
        for (const [index, weight] of weights.entries()) {
          ticket -= weight
          if (ticket <= 0) {
            const chosen = usable[index]
            if (chosen !== undefined) return { account: chosen.account, ranked }
          }
        }
        const last = usable[usable.length - 1]
        return last === undefined ? { ranked } : { account: last.account, ranked }
      }
      case 'sticky': {
        const key = options.conversationKey
        if (key !== undefined) {
          const bound = this.affinity.get(key)
          if (bound !== undefined) {
            const chosen = usable.find(row => row.account.id === bound)
            if (chosen !== undefined) {
              // 命中即刷新 LRU 位置。
              this.affinity.delete(key)
              this.affinity.set(key, bound)
              return { account: chosen.account, ranked }
            }
          }
        }
        // 新会话：取「当前绑定最少的那个可用号」，让新对话把花费摊开。
        const loads = new Map<string, number>()
        for (const id of this.affinity.values()) loads.set(id, (loads.get(id) ?? 0) + 1)
        const chosen = [...usable].sort((a, b) => {
          const loadA = loads.get(a.account.id) ?? 0
          const loadB = loads.get(b.account.id) ?? 0
          if (loadA !== loadB) return loadA - loadB
          return 0
        })[0]
        if (chosen !== undefined && key !== undefined) {
          this.affinity.set(key, chosen.account.id)
          while (this.affinity.size > STICKY_AFFINITY_LIMIT) {
            const oldest = this.affinity.keys().next()
            if (oldest.done === true) break
            this.affinity.delete(oldest.value)
          }
        }
        return chosen === undefined ? { ranked } : { account: chosen.account, ranked }
      }
      case 'expiry':
      case 'priority':
      default: {
        const chosen = usable[0]
        return chosen === undefined ? { ranked } : { account: chosen.account, ranked }
      }
    }
  }

  /** 名次行 → 池条目。 */
  entryOf(account: WbDiscoveredAccount): WbPoolEntry {
    const entry = this.find(account.id)
    if (entry === undefined) {
      // 只可能在扫描与排序之间发生；返回一个临时条目而不是崩。
      return { account }
    }
    return entry
  }
}

// ── 目录与探测共用的辅助 ──────────────────────────────────────────────────

/**
 * 一次目录读取的结果。
 *
 * `source` 让卡片能说清「这 62 个模型是实时读到的，还是静态兜底的」——两者对
 * 倍率的可信度不同：静态 CN 名册整份没有 `credits` 字段，所以那里全都是「未知」。
 */
export interface WbCatalogFetch {
  models: readonly WbUpstreamModel[]
  source: 'live' | 'fallback'
  /** 读失败的原因（`source === 'fallback'` 时用于说明）。 */
  error?: string
}

/**
 * 从一批账号里找一个能读出目录的，逐个尝试。
 *
 * 逐账号而不是只赌队首：池里任一账号的凭据都可能已被上游吊销（401），而读目录
 * 只需要一个健康账号；只赌第一个会让一份死 token 拖垮整个区域的实时目录。
 */
export async function fetchCatalogFromAny(
  accounts: readonly WbDiscoveredAccount[],
  read: (account: WbDiscoveredAccount) => Promise<readonly WbUpstreamModel[]>,
): Promise<WbCatalogFetch> {
  const failures: string[] = []
  for (const account of accounts) {
    try {
      return { models: await read(account), source: 'live' }
    } catch (error: unknown) {
      failures.push(`${account.label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {
    models: [],
    source: 'fallback',
    error: failures.length === 0 ? '没有可用账号' : failures.join(' | '),
  }
}

/** 供测试与诊断：把一份上游条目列表按 user 选择过滤前的原始形态交出。 */
export function modelsOfDocument(document: unknown, keepIds: readonly string[] = []): WbUpstreamModel[] {
  if (typeof document !== 'object' || document === null) return []
  const data = document as Record<string, unknown>
  return selectCliModels(data['models'], data['agents'], keepIds)
}

/**
 * 一点二次导出的胶水：`parseCreditMultiplier` 在目录层也要用，集中从这里拿，
 * 免得下游再 import 一次 upstream（会让依赖图出现两个入口）。
 */
export { parseCreditMultiplier }
