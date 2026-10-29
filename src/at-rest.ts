/**
 * WorkBuddy 桌面端「静态加密」凭据的解密。
 *
 * 从 5.6.0 起，桌面端不再把 `auth.accessToken` / `auth.refreshToken` 写成明文字符串，
 * 而是写一个字段信封：
 *
 *   { "$wbEncrypted": 1, "envelope": "<base64 of a JSON envelope>" }
 *
 * 信封本身是 `{suite, keyId, nonce, authTag, ciphertext}`，即 AES-256-GCM（12 字节
 * nonce、16 字节 tag）。AAD 是一段长度前缀转录，把 scheme / suite / keyId / framing
 * 一起绑进去，所以密文只能在它被封的那个「字段形状」下打开——换个 framing 解不开，
 * 而不是解出垃圾。
 *
 * ## 为什么本插件要自己实现，而不是复用 dsh-connect-workbuddy 的那份
 *
 * 那份实现在 `plugins/dsh-connect-workbuddy/src/at-rest.ts`，与 dsh-workbuddy-xdpool
 * 里另有一份。跨插件 `import` 会引入一个**加载顺序依赖**：对方没装、版本不匹配、或
 * 将来改了导出，本插件就在启动期炸掉，而用户只是想用模型池。所以这里是一份独立
 * 实现：约 400 行、零第三方依赖、只碰 node: 内置模块，代价是同一套协议有两处副本，
 * 好处是任一插件单独安装都成立。
 *
 * ## 密钥从哪来（关键约束）
 *
 * 字段密钥**不是用户秘密**：它是编译进桌面端自己的 Electron 原生模块
 * （`electron_browser_workbuddy_storage`）里的构建期常量。应用通过 `loggerGet()` 取到
 * 一段 base64 **字符串**，再对它做 SHA-256 得到 32 字节密钥（注意是哈希那个字符串本身，
 * 不是解码后的字节——哈希错对象会得到另一把钥匙，每个字段都解不开）。
 *
 * 因此本模块的做法是：**问装在同一台机器上的那个构建要它自己的密钥**——把桌面端二
 * 进制当成普通 Node 跑（`ELECTRON_RUN_AS_NODE`），调它自己的 binding。这带来一个
 * 必须如实承认的后果：
 *
 *   **本机没装桌面端，就拿不到密钥，加密账号就解不开。**
 *
 * 这不是 bug 而是协议的性质。所以本模块把「拿不到密钥」当成一等结果
 * （`readAtRestKey()` 返回 `undefined`），让上游照旧把账号报成 `reason:'encrypted'`
 * 并给出可操作提示，而不是假装解密成功或静默丢掉账号。
 *
 * @module dsh-connect-workbuddy-models/at-rest
 */

import { execFile, execFileSync } from 'node:child_process'
import { createDecipheriv, createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'

/** `{$wbEncrypted:1,envelope}` 字段信封；本模块只开这一种形状。 */
export interface WbEncryptedField {
  $wbEncrypted: 1
  envelope: string
}

/** 信封 framing 名 → 转录里的单字节码。 */
const FRAMING_CODE: Readonly<Record<string, number>> = {
  file: 1,
  field: 2,
  record: 3,
  stream: 4,
}

/** 对称信封的标准格式标识，参与 AAD 转录。 */
const STANDARD_FORMAT_ID: Readonly<Record<string, string>> = {
  file: 'WBEF1',
  field: 'WBEV1',
  record: 'WBER1',
  stream: 'WBES1',
}

/** AAD 转录的域分隔符。 */
const AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii')

/** 本模块打开的信封 scheme。 */
const SYMMETRIC_SCHEME = 'sym-v1'

/** 指向桌面端可执行文件的环境变量（用户手工覆盖）。 */
export const WB_APP_EXECUTABLE_ENV = 'WORKBUDDY_APP_EXECUTABLE'

/**
 * 同 {@link WB_APP_EXECUTABLE_ENV} 的别名。
 *
 * 两个名字并存是为了与参考插件（`plugins/dsh-connect-workbuddy/src/at-rest.ts:74`、
 * `plugins/dsh-workbuddy-xdpool/src/at-rest.ts`）的 `WORKBUDDY_APP_EXECUTABLE_ENV`
 * 对齐：诊断脚本与用户文档跨插件抄常量名时，别名让它们都能 import 到，而不必先
 * 查这份实现里叫什么。两个标识符指向同一个**值**（都是那个字符串字面量），所以
 * 不存在「哪个才是真的」的问题。
 */
export const WORKBUDDY_APP_EXECUTABLE_ENV = WB_APP_EXECUTABLE_ENV

/** 等桌面端交出 payload 的上限。 */
const KEY_FETCH_TIMEOUT_MS = 10_000

/**
 * Windows 上桌面端二进制的文件名。
 *
 * `WorkBuddy.exe` 是国内版；国际版是 `WorkBuddyAI` 目录下的 **`WorkBuddyAI.exe`**。
 * 保留成**列表**而不是第二个常量，因为同一个名字判断用在两处且必须一致：下面的
 * 目录拼接，以及注册表取值校验（`DisplayIcon` 可能指向任一个）。
 */
const APP_EXECUTABLE_NAMES: readonly string[] = ['WorkBuddy.exe', 'WorkBuddyAI.exe']

/**
 * Windows 安装目录，按探测顺序，相对 `%LOCALAPPDATA%` / `%ProgramFiles%`。
 *
 * `Programs\WorkBuddy` 是常见的按用户布局，`WorkBuddy` 是某些安装器的扁平布局，
 * `WorkBuddyAI` 那两对是国际版的。两种拼写都带，因为目录名与二进制名可能各自
 * 不一致——而这里 miss 掉是**看不见的**（表现为「凭据读不了」而非「找不到程序」）。
 */
const WINDOWS_APP_SUBDIRECTORIES: readonly (readonly string[])[] = [
  ['Programs', 'WorkBuddy'],
  ['WorkBuddy'],
  ['Programs', 'WorkBuddyAI'],
  ['WorkBuddyAI'],
]

/** macOS 上桌面端可能安装成的 bundle 名，按探测顺序。 */
const MACOS_APP_BUNDLE_NAMES: readonly string[] = ['WorkBuddy.app', 'WorkBuddy AI.app']

function encodeUint32(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(4)
  bytes.writeUInt32BE(value)
  return bytes
}

/** 长度前缀 UTF-8：uint32 大端长度 + 字节。 */
function encodeLengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  return Buffer.concat([encodeUint32(bytes.length), bytes])
}

/**
 * 一个 `sym-v1` FIELD-framed 信封的 AAD。
 *
 * 只实现字段 framing：桌面端对凭据字段就用这个形状，而它也无法与整文件信封混淆，
 * 所以遇到意外 framing 是解析错误，而不是悄悄用错的转录。
 *
 * 导出是为了让加密侧（测试里造合成信封、以及将来若有人要写盘）能与解密侧用**同一份**
 * 拼装顺序。给测试独写一份拼装逻辑会让「两边一起错」通过所有断言——那种测试只证明
 * 自洽，不证明与桌面端兼容。因此另有一条黄金字节断言钉住这里的实际输出。
 */
export function fieldAad(keyId: string, suite: number, scheme: string = SYMMETRIC_SCHEME): Buffer {
  if (!/^[0-9a-f]{16}$/u.test(keyId)) throw new Error('workbuddy: 信封 keyId 格式不合法')
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    encodeLengthPrefixed(STANDARD_FORMAT_ID['field']!),
    encodeLengthPrefixed(scheme),
    encodeUint32(suite),
    encodeLengthPrefixed(keyId),
    Buffer.from([FRAMING_CODE['field']!]),
    // encodeOptionalUint64(undefined)：字段 framing 不带序号。
    Buffer.from([0]),
    // final === undefined
    Buffer.from([0]),
  ])
}

/** 值是不是桌面端的加密字段信封。 */
export function isEncryptedFieldWrapper(value: unknown): value is WbEncryptedField {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const wrapper = value as Record<string, unknown>
  const keys = Object.keys(wrapper).sort()
  return keys.length === 2
    && keys[0] === '$wbEncrypted'
    && keys[1] === 'envelope'
    && wrapper['$wbEncrypted'] === 1
    && typeof wrapper['envelope'] === 'string'
}

/**
 * 32 字节密钥的 keyId：其 SHA-256 的前 16 个十六进制字符。
 *
 * 信封里的 `keyId` 就是跟它比对，所以「钥匙不对」会响亮失败，而不是返回垃圾。
 */
export function deriveAtRestKeyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/**
 * 从桌面端的 key payload JSON 派生 32 字节字段密钥。
 *
 * 应用哈希的是 payload 里那个 base64 **字符串**——不是它解码后的字节——所以这里必须
 * 同样拼法；哈希错对象会得到另一把钥匙，每个字段都解不开。
 */
export function deriveAtRestKey(payloadJson: string): Buffer {
  let payload: unknown
  try {
    payload = JSON.parse(payloadJson)
  } catch {
    throw new Error('workbuddy: at-rest key payload 不是合法 JSON')
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('workbuddy: at-rest key payload 不是对象')
  }
  const secret = (payload as Record<string, unknown>)['atRestSecretKey']
  if (typeof secret !== 'string' || secret === '') {
    throw new Error('workbuddy: at-rest key payload 里没有 atRestSecretKey')
  }
  return createHash('sha256').update(secret, 'utf8').digest()
}

/**
 * 用一个派生密钥打开一个加密字段，返回明文。
 *
 * 信封畸形、属于另一把钥匙、或认证失败时抛错——GCM tag 不匹配正是「转录或密钥不对」
 * 的信号，它绝不能被降级成一个被截断的 token。
 */
export function openEncryptedField(field: WbEncryptedField, key: Buffer): string {
  let envelope: unknown
  try {
    envelope = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8'))
  } catch {
    throw new Error('workbuddy: 加密字段的 envelope 不是合法 JSON')
  }
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw new Error('workbuddy: 加密字段的 envelope 不是对象')
  }
  const record = envelope as Record<string, unknown>
  const suite = record['suite']
  const keyId = record['keyId']
  const nonce = record['nonce']
  const authTag = record['authTag']
  const ciphertext = record['ciphertext']
  if (typeof suite !== 'number' || typeof keyId !== 'string') {
    throw new Error('workbuddy: 加密字段的 envelope 缺 suite 或 keyId')
  }
  if (typeof nonce !== 'string' || typeof authTag !== 'string' || typeof ciphertext !== 'string') {
    throw new Error('workbuddy: 加密字段的 envelope 缺 nonce、authTag 或 ciphertext')
  }
  const expectedKeyId = deriveAtRestKeyId(key)
  if (keyId !== expectedKeyId) {
    throw new Error(`workbuddy: 该字段属于密钥 ${keyId}，不是本机可得的密钥 ${expectedKeyId}`)
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'), { authTagLength: 16 })
  decipher.setAAD(fieldAad(keyId, suite))
  decipher.setAuthTag(Buffer.from(authTag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

/**
 * 一个 macOS bundle 里的可执行文件，从它自己的 `Info.plist` 读。
 *
 * 二进制**不**可靠地跟 App 同名：WorkBuddy 的 bundle 把 `CFBundleExecutable` 设成了
 * `Electron`，所以拼出来的 `<bundle>/Contents/MacOS/WorkBuddy` 并不存在，App 即使
 * 装在默认位置也像是没装。bundle 自己写着真名，问它比猜它稳。
 */
export function macosBundleExecutable(bundle: string): string | undefined {
  let plist: string
  try {
    plist = readFileSync(join(bundle, 'Contents', 'Info.plist'), 'utf8')
  } catch {
    return undefined
  }
  const match = /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]*)<\/string>/u.exec(plist)
  const name = match?.[1]?.trim()
  return name === undefined || name === '' ? undefined : join(bundle, 'Contents', 'MacOS', name)
}

/**
 * 桌面端可执行文件的候选路径，按探测顺序。
 *
 * Windows 在前（加密策略最早落在那里），macOS bundle 也列上——同一个原生模块在
 * macOS 构建里也有且同样加密（实测自 5.6.x）。`undefined` 项（未设的环境变量）被丢掉。
 *
 * `readBundleExecutable` 做成可注入，理由同 `platform`/`home`/`env`：macOS 分支会读
 * 真实文件系统，没有缝的话预期候选就取决于这台机器恰好装没装 App——测试会在开发机
 * 上通过、在 CI 上失败。
 */
export function wbAppExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  readBundleExecutable: (bundle: string) => string | undefined = macosBundleExecutable,
): string[] {
  const candidates: (string | undefined)[] = [env[WB_APP_EXECUTABLE_ENV]?.trim()]
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA']?.trim()
    const programFiles = env['ProgramFiles']?.trim()
    const programFilesX86 = env['ProgramFiles(x86)']?.trim()
    // 用 `win32.join` 而不是宿主的 `join`：这些按构造就是 Windows 路径，而
    // `path.join` 跟着**运行平台**走。在非 Windows 宿主上它会插 `/`
    //（`C:\Users\x\AppData\Local/…`），那个路径在 Windows 上永远不存在——于是这个
    // 分支存在的意义（找到按用户布局）被静默抹掉了。
    const bases = [
      local === undefined || local === '' ? undefined : local,
      programFiles === undefined || programFiles === '' ? undefined : programFiles,
      programFilesX86 === undefined || programFilesX86 === '' ? undefined : programFilesX86,
    ]
    for (const base of bases) {
      if (base === undefined) continue
      for (const subdirectory of WINDOWS_APP_SUBDIRECTORIES) {
        for (const name of APP_EXECUTABLE_NAMES) {
          candidates.push(win32.join(base, ...subdirectory, name))
        }
      }
    }
  } else if (platform === 'darwin') {
    for (const name of MACOS_APP_BUNDLE_NAMES) {
      candidates.push(
        readBundleExecutable(join('/Applications', name)),
        readBundleExecutable(join(home, 'Applications', name)),
      )
    }
  }
  return candidates.filter((candidate): candidate is string => candidate !== undefined && candidate !== '')
}

/**
 * bundle 标识的**前缀**——`com.tencent.workbuddy`（国内，实测 `…workbuddy.mac`）与
 * `com.workbuddy`（国际，实测 `com.workbuddy.workbuddy-ai`）。
 *
 * 用来在启动一个被扫描发现的可执行文件之前**确认**它真是 WorkBuddy。这很重要：
 * 每个 Electron 应用的二进制都叫 `Electron`，只按名字匹配可能启到别的产品。
 */
const APP_BUNDLE_IDENTIFIER_PREFIXES: readonly string[] = ['com.tencent.workbuddy', 'com.workbuddy']

/**
 * 一个 bundle 是否自称是 WorkBuddy 桌面端。
 *
 * 按点边界匹配，所以假想的 `com.workbuddyish` 混不过 `com.workbuddy`。
 * 读不出或没有标识的 plist 一律当**不是**：拒绝一个候选只是多走一个回退路径，
 * 而接受错的那个会执行一个无关应用。
 */
export function isWorkbuddyBundle(bundle: string): boolean {
  let plist: string
  try {
    plist = readFileSync(join(bundle, 'Contents', 'Info.plist'), 'utf8')
  } catch {
    return false
  }
  const match = /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>([^<]*)<\/string>/u.exec(plist)
  const identifier = match?.[1]?.trim().toLowerCase()
  if (identifier === undefined || identifier === '') return false
  return APP_BUNDLE_IDENTIFIER_PREFIXES.some(prefix =>
    identifier === prefix || identifier.startsWith(`${prefix}.`))
}

/** 一个 applications 目录下、按标识确认过身份的 bundle，按名字排序。 */
export function macosNestedAppBundles(parent: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(parent)
  } catch {
    return []
  }
  const bundles: string[] = []
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.app')) continue
    const bundle = join(parent, entry)
    if (isWorkbuddyBundle(bundle)) bundles.push(bundle)
  }
  return bundles
}

/**
 * 定位桌面端可执行文件**以及它是怎么被找到的**。
 *
 * 与 `findWbAppExecutable` 并列而不是合并：凭据路径只想要路径，而诊断必须解释发现
 * 过程。共用候选列表让两者不会漂移。
 */
export type WbAppExecutableSource = 'env' | 'default-layout' | 'registry' | 'nested-bundle'

export function findWbAppExecutableWithSource(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  readRegistryAppPath: () => string | undefined = windowsRegistryAppExecutable,
): { executable: string; source: WbAppExecutableSource } | undefined {
  const fromEnv = env[WB_APP_EXECUTABLE_ENV]?.trim()
  for (const candidate of wbAppExecutableCandidates(platform, home, env)) {
    try {
      if (!existsSync(candidate)) continue
    } catch {
      continue
    }
    // `env` 单独报告，因为用户是**故意**设的：手工覆盖正是「为什么用的是那个二进制」
    // 的答案，报成 default-layout 会把覆盖藏起来。
    const isEnv = fromEnv !== undefined && fromEnv !== '' && candidate === fromEnv
    return { executable: candidate, source: isEnv ? 'env' : 'default-layout' }
  }
  if (platform === 'win32') {
    const fromRegistry = readRegistryAppPath()
    if (fromRegistry !== undefined) {
      try {
        if (existsSync(fromRegistry)) return { executable: fromRegistry, source: 'registry' }
      } catch {
        // 读不了就继续往下。
      }
    }
  }
  const executable = findWbAppExecutable(platform, home, env, readRegistryAppPath)
  // 发现成功于一个本函数没亲自分类的路径（macOS 嵌套 bundle 扫描），按排除法命名。
  return executable === undefined ? undefined : { executable, source: 'nested-bundle' }
}

/** 第一个存在的候选；桌面端没装在平台预期位置时返回 undefined。 */
export function findWbAppExecutable(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  readRegistryAppPath: () => string | undefined = windowsRegistryAppExecutable,
): string | undefined {
  for (const candidate of wbAppExecutableCandidates(platform, home, env)) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // 候选读不了就试下一个。
    }
  }
  // Windows 兜底：装在四个默认布局之外的 App，上面的精确路径候选看不见。这条路只在
  // 每个便宜候选都 miss 之后才跑，所以默认安装永远不会为注册表查询付出代价。
  if (platform === 'win32') {
    const fromRegistry = readRegistryAppPath()
    if (fromRegistry !== undefined) {
      try {
        if (existsSync(fromRegistry)) return fromRegistry
      } catch {
        // 读不了就落到 undefined。
      }
    }
  }
  // macOS 兜底：被归入 applications 目录子文件夹的 App。
  if (platform === 'darwin') {
    for (const parent of ['/Applications', join(home, 'Applications')]) {
      for (const bundle of macosNestedAppBundles(parent)) {
        const executable = macosBundleExecutable(bundle)
        if (executable === undefined) continue
        try {
          if (existsSync(executable)) return executable
        } catch {
          // 读不了就试下一个 bundle。
        }
      }
    }
  }
  return undefined
}

/**
 * 同 {@link findWbAppExecutable} 的别名，签名逐字相同。
 *
 * 参考插件把这个函数叫 `findWorkbuddyAppExecutable`（
 * `plugins/dsh-connect-workbuddy/src/at-rest.ts:618`）。本模块内部的 `Wb` 缩写与
 * 本插件其他文件（`WbCredential`、`WbAccountPool`）一致，但诊断脚本会跨插件抄
 * 调用点，所以两个名字都给。别名是**同一个函数对象**——不是包装——所以缓存、
 * 参数默认值与错误口径完全共享，不会出现两份行为。
 */
export const findWorkbuddyAppExecutable = findWbAppExecutable

/**
 * 把桌面端的**注册表登记**读成可执行文件路径，或 undefined。
 *
 * 只查 `DisplayIcon` 与 `InstallLocation`：安装器记录了自己把二进制放哪儿，问登记
 * 是让「装在非默认目录的机器」也能取到密钥的唯一办法。
 */
const REGISTRY_PROBE_OPTIONS = { encoding: 'utf8', windowsHide: true, timeout: 10_000 } as const

/** `reg` 在键或值不存在时非零退出——这是没有登记 WorkBuddy 的机器上的预期情况。 */
function queryRegistry(args: readonly string[]): string | undefined {
  try {
    return execFileSync('reg', [...args], REGISTRY_PROBE_OPTIONS)
  } catch {
    return undefined
  }
}

/** 注册表查询里认作「桌面端二进制」的路径。 */
export function normalizeRegistryExecutable(value: string): string | undefined {
  const unquoted = stripRegistryQuotes(value)
  if (unquoted === undefined) return undefined
  const lower = unquoted.toLowerCase()
  const wanted = APP_EXECUTABLE_NAMES.map(name => name.toLowerCase())
  if (wanted.some(name => lower.endsWith(name))) return unquoted
  // `DisplayIcon` 有时带 `,0` 图标索引，有时直接给目录。
  if (lower.endsWith('.exe')) return undefined
  for (const name of APP_EXECUTABLE_NAMES) {
    const candidate = win32.join(unquoted, name)
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // 继续试下一个名字。
    }
  }
  return undefined
}

/** 去掉注册表值外面可能包的一层引号，并拒绝空值。 */
export function stripRegistryQuotes(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  // `"C:\Program Files\WorkBuddy\WorkBuddy.exe",0`
  const match = /^"([^"]+)"/u.exec(trimmed)
  const unquoted = match?.[1] ?? trimmed.replace(/,\s*-?\d+$/u, '')
  return unquoted.trim() === '' ? undefined : unquoted.trim()
}

/** 从 `reg query` 的输出里取 `DisplayIcon` / `InstallLocation`，转成可执行文件路径。 */
export function registryExecutableFromQuery(output: string): string | undefined {
  for (const key of ['DisplayIcon', 'InstallLocation']) {
    const match = new RegExp(`"${key}"\\s+REG_SZ\\s+([^\\r\\n]+)`, 'iu').exec(output)
    if (match?.[1] === undefined) continue
    const normalized = normalizeRegistryExecutable(match[1])
    if (normalized !== undefined) return normalized
  }
  return undefined
}

/** 注销表里挂着的全部 WorkBuddy 卸载项。 */
function windowsRegistryAppExecutable(): string | undefined {
  if (process.platform !== 'win32') return undefined
  const hives = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]
  for (const hive of hives) {
    const output = queryRegistry(['query', hive, '/s', '/f', 'WorkBuddy', '/d'])
    if (output === undefined) continue
    const executable = registryExecutableFromQuery(output)
    if (executable !== undefined) return executable
  }
  return undefined
}

/**
 * 跑桌面端自己的二进制（当普通 Node 用）向它的原生模块要 key payload。
 *
 * 那个 binding 是应用对外的合法表面，所以插件不必携带一份构建期常量的副本：它问
 * 写出这个文件的那个构建。子进程不给 stdin，硬超时，只读它的 stdout。
 */
export function fetchAtRestKeyPayload(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const source = "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}"
      + "catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}"
    execFile(
      executable,
      ['-e', source],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: KEY_FETCH_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`workbuddy: 桌面端没有交出 at-rest 密钥（${stderr.trim() || error.message}）`))
          return
        }
        const payload = stdout.trim()
        if (payload === '') {
          reject(new Error('workbuddy: 桌面端返回了空的 at-rest key payload'))
          return
        }
        resolve(payload)
      },
    )
  })
}

/** 派生密钥的进程级缓存；永不落盘。 */
let cachedKey: Buffer | undefined
let inflightKey: Promise<Buffer | undefined> | undefined
/** 上一次**失败**的时刻；0 表示近期没失败过。 */
let failedKeyAtMs = 0
/** 最近一次成功发现的可执行文件（`undefined` 表示还没成功过）。 */
let cachedAppExecutable: string | undefined
/** 最近一次**否定**发现的时刻；0 表示近期没失败过。 */
let appExecutableMissedAtMs = 0

/**
 * 一次失败的密钥查询被记住多久。
 *
 * 只记住成功是不够的：拿不到密钥的机器上，`scanAll()` 会逐个文件探测，而一次页面
 * 打开会扫好几遍——每一遍都重跑整套发现，在没装桌面端的机器上就是每次若干次
 * **同步** `reg query` 子进程。失败答案在一次页面打开内不可能变化，所以记 60s；
 * 用户装好或启动 App 后仍能在这个窗口内被拾起，而不必重启。
 */
const AT_REST_KEY_FAILURE_TTL_MS = 60_000

/**
 * 一次**否定**的可执行文件发现被记住多久。
 *
 * 否定答案才贵：每个候选路径都 miss，然后 Windows 兜底按卸载 hive 逐个 shell out。
 * 肯定答案则整个进程生命周期缓存——它的路径每次调用本来就会用 `existsSync` 重验，
 * 所以被移动或删除的 App 仍会落到一次新的发现。
 */
const APP_EXECUTABLE_MISS_TTL_MS = 60_000

/**
 * 经 `findWbAppExecutable` 定位桌面端，并把一次 miss 记住
 * `APP_EXECUTABLE_MISS_TTL_MS`。
 *
 * 只缓存本模块自己的查询，且只在走真实缝的时候：`findWbAppExecutable` 对其参数
 * 保持纯函数，诊断与注入平台的测试必须继续看到机器此刻的样子。
 */
function discoverAppExecutable(): string | undefined {
  if (cachedAppExecutable !== undefined) return cachedAppExecutable
  const now = Date.now()
  if (appExecutableMissedAtMs !== 0 && now - appExecutableMissedAtMs < APP_EXECUTABLE_MISS_TTL_MS) {
    return undefined
  }
  const executable = findWbAppExecutable()
  if (executable === undefined) {
    appExecutableMissedAtMs = now
    return undefined
  }
  cachedAppExecutable = executable
  return executable
}

/**
 * 桌面端的 at-rest 字段密钥；取不到时返回 undefined（App 没装、构建太旧没有原生
 * 模块、或将来的构建换了 payload）。
 *
 * 两种结果都缓存：成功缓整个进程生命周期（App 至多被启动一次），失败缓
 * `AT_REST_KEY_FAILURE_TTL_MS`。失败 TTL 正是让**没装 App** 的机器不为每个凭据
 * 文件都付一次同步注册表探测的东西。
 */
export function readAtRestKey(): Promise<Buffer | undefined> {
  if (cachedKey !== undefined) return Promise.resolve(cachedKey)
  if (inflightKey !== undefined) return inflightKey
  if (failedKeyAtMs !== 0 && Date.now() - failedKeyAtMs < AT_REST_KEY_FAILURE_TTL_MS) {
    return Promise.resolve(undefined)
  }
  inflightKey = (async (): Promise<Buffer | undefined> => {
    const executable = discoverAppExecutable()
    if (executable === undefined) return undefined
    const payload = await fetchAtRestKeyPayload(executable)
    return deriveAtRestKey(payload)
  })().then(key => {
    cachedKey = key
    failedKeyAtMs = key === undefined ? Date.now() : 0
    return key
  }, (error: unknown) => {
    // 抛出的失败与空答案同样缓存：App 装了却没交出密钥，逐文件重试正是这个缓存
    // 存在的理由。错误仍重抛，好让调用方的 encrypted 诊断保住它的原话。
    failedKeyAtMs = Date.now()
    throw error
  }).finally(() => {
    inflightKey = undefined
  })
  return inflightKey
}

/** 丢掉缓存的密钥；只给测试与诊断用。 */
export function clearAtRestKeyCache(): void {
  cachedKey = undefined
  inflightKey = undefined
  failedKeyAtMs = 0
  cachedAppExecutable = undefined
}
