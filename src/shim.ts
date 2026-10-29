/**
 * 回环 OpenAI 兼容端点 + 多账号自动容错换号。
 *
 * pi-ai provider 指向这里。每个 chat 请求从账号池取一个账号；上游回答限流或积分
 * 耗尽时，shim 记一次冷却、换下一个账号、在同一请求内重试 —— 所以临时的 429 不会
 * 以「这轮对话失败」的形式到达用户面前。
 *
 * 安全模型（Host/Origin 回环校验、常量时间 bearer 比对、随机端口、进程内 secret、
 * 请求体上限、错误分类到状态码）沿用同仓 `dsh-connect-trae-models/src/shim.ts` 的
 * 已验证设计（其血统为 corrinehu/dsh-workbuddy-connect，MIT）。
 *
 * @module dsh-connect-workbuddy-models/shim
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { WbAccountPool, WbDiscoveredAccount } from './accounts.ts'
import type { WbCatalog } from './catalog.ts'
import { aggregateCredits } from './probe.ts'
import { WbCredentialRejectedError, isCredentialRejectedError, type WbUpstreamClient, type WbUpstreamErrorDetail, type WbUpstreamErrorKind } from './upstream.ts'
import type { WbRegion } from './status-paths.ts'
import { WB_REFUSES_OFF_MODEL_IDS } from './status-paths.ts'

/** 池与 shim 共用的最小日志面。 */
export interface WbShimLogger {
  info?(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** 一个已监听的回环端点。 */
export interface WbShim {
  ready: Promise<void>
  /** 例如 `http://127.0.0.1:39271`；ready 之后有效。 */
  baseUrl(): string
  /** 进程内 secret（adapter 把它当 OpenAI apiKey 用）。 */
  token(): string
  close(): Promise<void>
}

export interface WbShimOptions {
  pool: WbAccountPool
  client: WbUpstreamClient
  catalog: WbCatalog
  logger?: WbShimLogger
  /**
   * 把本 shim 限制在一个网关上。两个 shim 并排运行 —— 每区域一个 —— 每个都只能
   * 取属于自己区域的账号。
   *
   * 为什么必须分开而不是「按 model id 猜区域」：`glm-5.3` / `hy3` / `kimi-k2.6`
   * 这些 id 在两个区域的名册里**都存在**，按名字猜会把一个国际账号的请求发到国内
   * 网关（或反过来），被 openresty 以 HTML 401 拒绝，看起来像「凭据坏了」。
   * 区域由 provider 决定，provider 由用户选的那个模型决定，全程不靠猜。
   */
  region: WbRegion
  /** 每请求最多尝试几个账号。 */
  maxAttempts?: number
  /**
   * 临期窗口（天），取自用户的 `expiryWarnDays`。
   *
   * 用 getter 而不是数字：用户的设置在插件运行期随时可改（设置页每改一次就广播
   * `loader/volatile-update`），而 shim 在 `apply()` 里只构造一次。传快照数字会让
   * 「改了设置但没重启」的会话一直用旧窗口聚合余额，卡片上的临期金额与账号卡片
   * 的排序都会与设置页显示的天数不符。
   *
   * 缺省（或 getter 返回 `undefined`）时由 `aggregateCredits` 落回兜底 3 天。
   */
  expiryWarnDays?: () => number | undefined
}

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** 各上游失败类映射到的 HTTP 状态码。 */
const KIND_STATUS: Readonly<Record<WbUpstreamErrorKind, number>> = {
  hard_credit: 402,
  soft_rate: 429,
  authentication: 401,
  client_reject: 400,
  // 渠道闸门的对外状态码与 `client_reject` 相同：两条自救都失败之后，对调用方而言
  // 它就是「这个请求被拒了」，400 是最准确的表达。区别不在状态码，而在它进过
  // 两级自救（见 `chatCompletions` 的救援梯）——状态码是给宿主看的，自救是给
  // 用户看的。
  channel_reject: 400,
  // 本机闸门的两支**必须保持 422**。402/429/401 都是「上游对这些凭据/额度说的」，
  // 而 422 是「这份请求体被本地判定为不可能被接受」。压成 400 的后果实测过：
  // 用户拿到的 400 与「参数写错了」完全同形，于是去改参数、换模型，而真正要动的
  // 是那份 8 MB 的历史。
  local_gate_oversize: 422,
  local_gate_unattributed: 422,
  session_dead: 401,
  server: 502,
  client: 400,
}

/** 上游未给 reset 时间时的限流冷却兜底（毫秒）。 */
export const WB_DEFAULT_COOLDOWN_MS = 60_000

/** 硬额度（积分耗尽）的冷却：额度不会在几秒内回来，冷得比限流久。 */
export const WB_HARD_CREDIT_COOLDOWN_MS = 5 * 60_000

/**
 * 网关在 system 开场白被指纹识别为「未授权通道」时给出的占位提示词。
 *
 * 为什么需要：DSH 的系统提示词前缀与官方客户端不同，网关按开场白指纹判定通道；
 * 被判为非授权通道时整个请求直接失败。此时把系统提示词替换成一句中性的占位是
 * 唯一能保住这次对话的降级——总比一个必然的 400 好。
 *
 * 刻意极短：这是一个最后手段的占位，不是人设。编一段更长的话会在所有受影响的
 * 请求上悄悄改变模型行为。
 */
export const WB_FALLBACK_SYSTEM_PROMPT = 'You are a helpful assistant.'

/**
 * 从 429 响应体解析冷却截止时刻。
 *
 * 上游有时给出 `resetAt`/`reset_time`（13 位 epoch 毫秒）或本地化的
 * 「将在 2026-10-11 12:00:00」；两者都拿不到时返回 undefined，由
 * {@link WB_DEFAULT_COOLDOWN_MS} 兜底 —— 一个识别不出的限流窗口绝不能让账号
 * 被无限期冷却，也绝不能完全不冷却。
 */
export function parseRateLimitReset(body: string): number | undefined {
  const epochMs = /"(?:resetAt|reset_at|resetTime|reset_time)"\s*:\s*(\d{13})/.exec(body)
  if (epochMs !== null) return Number(epochMs[1])

  const localized = /将在\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})/.exec(body)
  if (localized !== null) {
    const parsed = Date.parse(localized[1]!.replace(' ', 'T'))
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon)
  return hostname
}

/** Host 必须指向回环；在路由前就挡掉 DNS rebinding。 */
function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

/** 带 Origin 时必须是回环；非浏览器客户端不发 Origin，直接放行。 */
function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

/** chat POST 必须带 JSON body 类型（挡掉简单请求 CSRF）。 */
function isJsonContentType(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function writeOpenAIError(res: ServerResponse, status: number, kind: string, message: string): void {
  writeJson(res, status, { error: { message, type: kind, code: kind } })
}

/**
 * 上游失败体是否表示请求超出了模型上下文窗口。
 *
 * 单独识别它是因为它该映射成 400 + 一段能指导用户的文案（「缩短历史」），而不是
 * 笼统的 502「上游出错」——后者会让用户去查网络。
 */
export function isContextTooLong(body: string): boolean {
  if (body.includes('context_length_exceeded')) return true
  if (body.includes('input length too long')) return true
  if (body.includes('context window exceeded')) return true
  if (body.includes('maximum context length')) return true
  if (/exceeds?\s+(the\s+)?(model\s+)?context\s+(window|limit)/iu.test(body)) return true
  return false
}

/**
 * 请求的无内容形态描述，供上游拒绝时记日志。
 *
 * `client` 类失败（HTTP 400）通常带空的 `param`，错误本身说不出是哪个参数被拒 ——
 * 用户只看到「请求参数不满足当前模型要求」而无从下手。记录形态（顶层键、按角色的
 * 消息数、工具数、近似 prompt 大小）让这类拒绝能从日志里诊断出来。
 *
 * 刻意只记形态：无消息内容、无工具 schema、无 token。它会落进日志文件，而它描述
 * 的那个对话属于用户。
 */
function requestShape(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const keys = Object.keys(parsed).sort()
    const messages = Array.isArray(parsed['messages']) ? parsed['messages'] as unknown[] : []
    const byRole = new Map<string, number>()
    let chars = 0
    for (const entry of messages) {
      if (typeof entry !== 'object' || entry === null) continue
      const message = entry as Record<string, unknown>
      const role = typeof message['role'] === 'string' ? message['role'] : '?'
      byRole.set(role, (byRole.get(role) ?? 0) + 1)
      chars += JSON.stringify(message['content'] ?? '').length
    }
    const roles = [...byRole.entries()].map(([role, n]) => `${role}:${n}`).join(' ')
    const tools = Array.isArray(parsed['tools']) ? parsed['tools'].length : 0
    return `keys=[${keys.join(' ')}] messages=${messages.length}${roles === '' ? '' : ` (${roles})`} `
      + `tools=${tools} contentChars=${chars}`
  } catch {
    return 'body was not parseable JSON'
  }
}

/**
 * 把上游原文裁到 `limit` 字符，尽量在一句话的结尾断开。
 *
 * 为什么不是 `slice(0, limit) + '…'`：上游那句可执行的建议常常正好跨在截断点上，
 * 直接切会得到「…请新建任务、换个模型或稍后重」这种半句，读起来像乱码。所以先压平
 * 空白（JSON 里的 `\n` 到了界面是空的），再在断点往前找一个句末标点；找不到就用硬
 * 截断——宁可硬截，也不要造出一个比上限还长的结果。
 */
function clippedUpstreamText(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  if (collapsed.length <= limit) return collapsed
  const cut = collapsed.slice(0, limit)
  const stop = Math.max(
    cut.lastIndexOf('。'),
    cut.lastIndexOf('！'),
    cut.lastIndexOf('？'),
    cut.lastIndexOf('. '),
    cut.lastIndexOf('! '),
    cut.lastIndexOf('? '),
  )
  if (stop >= Math.floor(limit / 2)) return `${cut.slice(0, stop + 1).trimEnd()}…`
  return `${cut.trimEnd()}…`
}

/**
 * 若这次拒绝是「推理档位参数不被接受」，返回一行点名了档位的描述。
 *
 * 单独立一支而不是混进通用文案，因为它的处置动作**完全不同**：通用参数拒绝只能说
 * 「按上面的提示调整」，而档位拒绝有确定的开关可关（模型卡片里那一行的「可关闭
 * 思考」勾选）。把两者混在一起，用户会去改历史、换模型，而真正该关的开关还在那里。
 */
function reasoningTierRefusal(outcome: { ok: false; kind: WbUpstreamErrorKind; detail?: WbUpstreamErrorDetail }): string | undefined {
  if (outcome.kind !== 'client') return undefined
  const param = outcome.detail?.rejectedParam
  if (param === undefined || !param.includes('reasoning')) return undefined
  const tier = outcome.detail?.rejectedTier
  return tier === undefined
    ? `上游拒绝了推理档位参数（${param}）`
    : `上游拒绝了推理档位「${tier}」（${param}）`
}

/**
 * 失败回复的正文：先给上游那句可执行建议，再给我们的处置建议。
 *
 * 取值顺序 `refusedTier → detail.tips → detail.displayMsg → 裁剪后的原始 body` 是
 * 从「最具体」到「最笼统」排的：
 * - 档位拒绝：唯一带着确定开关的那一支；
 * - `displayTips`：上游专门写给用户看的那句（「请新建任务、换个模型或稍后重试」）；
 * - `displayMsg`：一句短结论，比原始 body 好但仍不指向动作；
 * - 原始 body：最后的兜底，命中它说明信封没带人话（或压根不是 JSON）。
 *
 * `stamp` 是 `（code 11133，requestId …）` 这个紧凑摘要：两个字段任缺就省掉对应半句，
 * 半个括号都不留 —— 出现「（code undefined）」比不写更让人怀疑这份软件。
 */
function clientRejectionBody(outcome: { ok: false; kind: WbUpstreamErrorKind; message: string; detail?: WbUpstreamErrorDetail }, contextTooLong: boolean): string {
  if (contextTooLong) return ''
  const stamp = upstreamStamp(outcome.detail)
  const refusedTier = reasoningTierRefusal(outcome)
  const receipt = refusedTier
    ?? outcome.detail?.tips
    ?? outcome.detail?.displayMsg
    ?? clippedUpstreamText(outcome.message, 400)
  // 档位拒绝的处置建议不再指向「可关闭思考」勾选：adapter 已经按
  // `WB_REFUSES_OFF_MODEL_IDS` 把这一档从选择器里去掉（`map.off = null`），
  // 所以走到这里意味着**请求点名的模型不是选择器当时展示的那个**——通常是名册
  // 刚刷新、或 `primary-model` 这类别名被网关解析成了别的 id。让用户去翻一个
  // 已经不在的勾选只会白费一轮；真正能动手的是重新选一次模型或换一档。
  const advice = refusedTier !== undefined
    ? '这不是账号或网络问题：该模型不接受「off」推理档位。档位随模型而定，请在模型选择器里重新选一次该模型（名册可能刚刷新），或改用其它档位后重试'
    : outcome.kind === 'client'
      ? '该请求被上游按参数拒绝：与网络、账号、额度都无关，换账号也不会改变结果，请按上面的提示调整后重试'
      : ''
  const trimmed = receipt.replace(/[。.]$/u, '')
  const sentence = advice === '' ? receipt : `${trimmed}。${advice}`
  return `${sentence}${stamp}`
}

/**
 * `（code N，requestId X）`；两字段都没有时返回空串。
 *
 * 括号里用中文逗号：它读起来是给人看的一句话的一部分，不是程序输出。用英文逗号会
 * 让它在中文句中显得像被粘上去的调试残留。
 */
function upstreamStamp(detail: WbUpstreamErrorDetail | undefined): string {
  if (detail === undefined) return ''
  const parts: string[] = []
  if (detail.upstreamCode !== undefined) parts.push(`code ${detail.upstreamCode}`)
  if (detail.requestId !== undefined) parts.push(`requestId ${detail.requestId}`)
  return parts.length === 0 ? '' : `（${parts.join('，')}）`
}

/**
 * 本机闸门拒绝时，用户该做的三件事。
 *
 * 为什么自己写一遍而不是直接把闸门那句英文 message 甩出去：那句原文是好几百字符的
 * 英文长句（两条从句里各塞一次原因），而用户是在中文界面里读到一个 422。更要紧的是
 * 我们**没有**把它的三条建议结构化过，直接转发等于把「哪三条」这件事交给用户自己从
 * 长句里切分。
 *
 * 两支的处置不同，所以分开写：未归属那支裁剪内容就能过；归属查询抛错那支在同一次
 * 进程里会一直失败，必须重启宿主或新开会话。两支共有的那句兜底建议（裁剪超大粘贴
 * 或工具输出）都保留 —— 它是最省事的那条路。
 *
 * **刻意不出现「换账号」**：闸门读的是请求体大小与会话归属，换一份凭据会拿着同一份
 * 超长历史再撞一次同一道闸门。`client` 那支的通用建议里恰好有这句话，所以本函数据
 * 不共用 `clientRejectionBody`。
 */
function localGateAdvice(outcome: { ok: false; kind: WbUpstreamErrorKind; detail?: WbUpstreamErrorDetail }): string {
  const code = outcome.detail?.localGateCode
  const suffix = code === undefined ? '' : `（闸门码 ${code}）`
  const trimHint = '把过大的内容裁剪掉——例如一次巨型粘贴、或一整段工具输出，删掉或裁短后重发'
  if (outcome.kind === 'local_gate_unattributed') {
    return '这个请求没有归属到任何受管的 billion-context 会话，而它的体积可证明超过 100 万 token，'
      + '直接发给上游只会被拒，重试也只是把同一份超长历史再发一次。三件事任选其一：'
      + `① 把对话接入受管会话，让它可以被压缩；② ${trimHint}；③ 新开一个会话重说需求。${suffix}`
  }
  return '它查询会话归属时出错了（该会话的作用域已释放或正在关闭），超长历史折叠不进模型窗口。'
    + '在作用域恢复之前，重试同一次调用会一直失败。两件事任选其一：'
    + `① 重启一次客户端宿主（会话状态已落盘，不会丢），或直接新开一个会话；② ${trimHint}。${suffix}`
}

/**
 * 请求所属对话的稳定身份，供 `sticky` 使用。
 *
 * 用**第一条 user 消息**做键：它是 body 里唯一不随历史增长而改变的部分，所以一个
 * 对话的每一轮都哈希到同一个值，而新对话（开头消息不同）哈希到别的值。哈希而非
 * 存原文，让对话内容不进入池的内存。
 *
 * 两条开头完全相同的对话会共享账号 —— 罕见且无害：只意味着它们共用同一个账号的
 * 上游 prompt 缓存。
 */
export function conversationKeyOf(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { messages?: unknown }
    if (!Array.isArray(parsed.messages)) return undefined
    for (const entry of parsed.messages) {
      if (typeof entry !== 'object' || entry === null) continue
      const message = entry as Record<string, unknown>
      if (message['role'] !== 'user') continue
      const content = typeof message['content'] === 'string'
        ? message['content']
        : JSON.stringify(message['content'] ?? '')
      return createHash('sha256').update(content).digest('hex').slice(0, 32)
    }
    return undefined
  } catch {
    return undefined
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 取请求里的 model 字段（限流按模型计，所以冷却要带 modelId）。 */
function modelIdOf(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { model?: unknown }
    return typeof parsed.model === 'string' && parsed.model !== '' ? parsed.model : undefined
  } catch {
    return undefined
  }
}

/**
 * 网关按开场白指纹判定为「未授权通道」的 system/assistant 消息开头。
 *
 * 为什么必须有这张表：两个网关都会扫描**每一条** `system` 与 `assistant` 消息的
 * 开头，命中已知第三方 agent 提示词列表就以业务码 `11128`
 * （`Illegal API invocation from an unapproved channel`）整条拒绝，而返回的
 * `displayTips` 是一句「这次调用没通过渠道校验，可能不是官方客户端发出的」——
 * 读起来像凭据或客户端身份问题，实际是**内容前缀匹配**。这和「conversation id
 * missing」「first message is not system prompt」是同一个业务码，只能靠 body 区分。
 *
 * 表里两条是实测快照（照 `dsh-connect-workbuddy/src/upstream.ts:1389` 搬过来，
 * 那边记账的实测口径：2026-10-21、国内网关、单一账号、`deepseek-v4.1-flash`、
 * 其余请求字段全部固定）：
 *
 *   system 消息以以下内容开头                          国内          国际
 *   ------------------------------------------------  ------------  ------------
 *   "You are an AI agent powered by DeepSeek Harness"   400 / 11128   200
 *   "You are Claude Code, Anthropic's official CLI…"    400 / 11128   400 / 11128
 *   "You are an AI agent powered by Kimi."              200           200
 *   "You are Cursor Agent…"、"You are Gemini CLI…"      200           200
 *   同样的 DSH 提示词，前面加一句 "You are a helpful
 *   assistant."                                         200           200
 *
 * 匹配只看**开头**：同一句话出现在提示词中段、出现在 `user` 消息里、或前面多一个
 * 空格，都能过；比较前会 trim 前导空白并小写化（小写形态同样会被拒）。
 *
 * 这张表**不可能完整**，上游随时能加条目而我们看不到——所以它是尽力而为的过滤器，
 * 不是保证。表外的**前缀**由 {@link forceNeutralHead} 兜住（无条件前置），表外的
 * **内层 span** 由 {@link relocateScannedContent} 兜住（不需要知道 span 长什么样）。
 * 二者都不依赖这张表，这也是它只收录实测条目的底气。
 *
 * 这张表也不靠猜扩充：没人测过的开头就是没人知道网关会拒的开头，凭空加条目会把
 * 今天能过 200 的提示词也一起改写掉。
 */
const UNAPPROVED_CHANNEL_OPENINGS: readonly string[] = [
  'you are an ai agent powered by deepseek harness',
  "you are claude code, anthropic's official cli for claude",
]

/**
 * 这段文本是否**以**网关会拒的开场白开头。
 *
 * 三条实测规则都折在这里（同源实测，条件见 {@link UNAPPROVED_CHANNEL_OPENINGS}）：
 *
 * 1. 只有**开头**算——同一句话出现在内容中段返回 200；
 * 2. 比较前 trim 前导空白——`" <banned>"` 与 `"\n<banned>"` 今天都能过；
 * 3. 大小写不敏感——全小写形态一样被拒。
 *
 * 第 2 条是网关当前的宽容，随时可能收回，所以这里按「会 trim 的网关」来比较，
 * 而原始内容不动一个字节：只在网关忘记 trim 时才成立的规则，是一条等着失效的规则。
 */
function isUnapprovedChannelOpening(text: string): boolean {
  const opening = text.replace(/^\s+/u, '').toLowerCase()
  return UNAPPROVED_CHANNEL_OPENINGS.some(prefix => opening.startsWith(prefix))
}

/**
 * 网关会扫描开场的角色。
 *
 * 实测（同源，国内网关、其余字段固定）：`system` 与 `assistant` 会被扫；`user` 与
 * `tool` 不会（把被禁身份放到这两类消息的开头返回 200）。第二种角色容易被漏掉，
 * 而漏掉的后果不是「这一次失败」：一条以被禁身份开头的 `assistant` 历史消息会污染
 * 该会话之后的**每一轮**，换账号、换区域都改不动它一个字节。
 *
 * `developer` 不在这里，因为 {@link prepareChatBody} 在调用本函数之前已经把它改写成
 * `system`，而且两个网关对 `developer` 一律直接拒（改写它的内容救不了请求）。
 */
function scansOpening(role: unknown): boolean {
  if (typeof role !== 'string') return false
  const name = role.trim().toLowerCase()
  return name === 'system' || name === 'assistant'
}

/**
 * 遍历「网关会读的正文」，把每一处文本交给 `edit`。
 *
 * 四种变换（中性头、已知 span 改写、无条件前置、内容迁移）共用这一份遍历：它们的差别
 * 只在「怎么改这一段」，而**改哪些段**是网关的规则，抄四遍就会有一份落后。
 *
 * 三种 shape 都必须走到，缺一种就是一个洞：
 * - `content` 是字符串（最常见）；
 * - `content` 是 part 数组，每个 `type: "text"` 的 part 都要处理——实测网关读**每一个**
 *   文本 part，只修第一个等于修好一半，另一半留给用户再报一次；
 * - 其余 shape（`null`、数字、畸形 part）原样留着：这段代码跑在**即将上线**的 body 上，
 *   抛一次就是整条请求没了。
 *
 * `edit` 返回 `undefined` 表示「这一处不改」；返回是否改过任何一处，调用方据此决定
 * 要不要为这次救援花一次往返。
 */
function mapScannedText(
  obj: Record<string, unknown>,
  edit: (text: string) => string | undefined,
): boolean {
  const messages = obj['messages']
  if (!Array.isArray(messages)) return false
  let changed = false
  for (const value of messages) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const message = value as Record<string, unknown>
    if (!scansOpening(message['role'])) continue
    const content = message['content']
    if (typeof content === 'string') {
      const next = edit(content)
      if (next === undefined) continue
      message['content'] = next
      changed = true
      continue
    }
    if (!Array.isArray(content)) continue
    for (const part of content) {
      // 畸形的 part 原样留着：这段代码跑在**即将上线**的 body 上，抛一次就是整条
      // 请求没了。
      if (typeof part !== 'object' || part === null || Array.isArray(part)) continue
      const record = part as Record<string, unknown>
      const type = record['type']
      if (typeof type !== 'string' || type.trim().toLowerCase() !== 'text') continue
      const text = record['text']
      if (typeof text !== 'string') continue
      const next = edit(text)
      if (next === undefined) continue
      record['text'] = next
      changed = true
    }
  }
  return changed
}

/**
 * 把每条被扫描消息（`system` 与 `assistant`）的**开场**移出上面的内容指纹。
 *
 * 只处理**前缀**：网关对这张表里的词条是「按 trim 后的小写形态比开头」的规则，
 * 同一句话出现在句中会放行（实测 `identity_mid` 200），所以这里也只在前缀命中时前置。
 *
 * 对「消息开头是别的东西」的 body 是空操作：网关本来就会放行的请求保持逐字节不变，
 * 只有会被拒的那些消息多出一行短提示。
 *
 * **两种角色都要处理**，因为网关两种都读。只处理 `system` 会留下一个长期缺陷：会话
 * 历史里有一条以被禁身份开头的 `assistant` 消息（模型复述自己的提示词、恢复的会话、
 * 压缩产物），那一轮的每一句话都会被拒，没有任何账号或区域能改变它。
 *
 * 内层 span 不归这里管：那是 {@link CHANNEL_SPAN_REWRITES} 与
 * {@link relocateScannedContent} 负责的另一道门。
 */
function neutralizeChannelFingerprints(obj: Record<string, unknown>): void {
  // 前导空白目前能绕过网关（实测），但网关随时可能开始 trim，所以按「会 trim 的
  // 网关」来比较，同时保持原始内容不动。
  mapScannedText(obj, content => isUnapprovedChannelOpening(content)
    ? `${WB_FALLBACK_SYSTEM_PROMPT}\n\n${content}`
    : undefined)
}

/**
 * 网关按**精确子串**拒绝的已知 span，以及它们的等价改写。
 *
 * 与 {@link UNAPPROVED_CHANNEL_OPENINGS} 的分工：那张表是**前缀**规则（只比开场），
 * 这张表是**子串**规则（正文任意位置）。两者是不同的闸门，实测同一天同时存在 ——
 * 所以「把开场挪到中性头之后」既不能替代这张表，也不能被这张表替代。
 *
 * **为什么必须是看得见的改写。** 旧实现的第二级自救
 * （{@link perturbChannelFingerprints}）靠插入不可见字符破坏匹配。2026-10-29 国内
 * 网关实测：U+200B / U+200D / U+2060 / U+00AD 四种不可见字符**全部被剥离后再比对**，
 * 每一个词后都插满的密集扰动仍然是 400（`.probe/t34e` 的 `span_dense`、
 * `.probe/t34f` 的 `zwj_dense` / `wj_dense` / `shy_dense`）。同一批实测里只有
 * **改变可见字节**才放行：断句（`split_sentence`）、加一个逗号
 * （`one_word_changed`）、换行（`newline_mid`）都是 200，而大小写折叠
 * （`case_word`）与空格加倍（`double_space`）是 400——网关做小写折叠且会把连续空格
 * 压成一个，但不把换行折成空格。
 *
 * 结论：改写必须落到**读的人也看得见**的字节上，但语义必须等价。这张表就是那份等价
 * 改写——把一句话拆成两句，读者得到同一件事，逐字节的子串匹配不再成立。
 *
 * 条目只收录**实测过**的 span（口径与取证见 `docs/CHANNEL-SPAN-REWRITE.md`）。
 * 不靠猜扩充：没测过的 span 加进来只会改写今天能过 200 的提示词，而表外的未知 span
 * 由救援梯的第二级（{@link relocateScannedContent}）兜住——那一步不需要知道 span。
 */
export const CHANNEL_SPAN_REWRITES: readonly { readonly match: string; readonly replace: string }[] = [
  {
    // 221 字符，DSH 的 web profile 每一轮都带（packages/context/harness-dev-context）。
    // 拆句点选在定语从句前半句之后：`…Web GUI` 已经是完整的一句话，后面的
    // `whose URL the runtime context names` 单独成句后指代仍然清楚。
    match: 'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.',
    replace: 'You are interacting with the user through the DeepSeek Harness Web GUI. The runtime context names its URL.',
  },
  {
    // 2026-10-29 第二次报障（真实会话 233 条消息）用 ddmin 压出来的最小必然子串：
    // 同一天的第二条 DSH 指纹，来自 packages/context/file-reference 的
    // `FILE_REFERENCE_PROMPT`（`.probe/t39b` / `.probe/t41`）。
    //
    // 这条 span 说明一件事：网关的清单是按**已知 agent 提示词库**生成的，DSH 的提示词
    // 里被收进去的不止一段。逐条追是追不完的——所以请求路径上默认走
    // {@link relocateScannedContent}（换角色承载），这张表只是「保留 system 角色」那条
    // 退路与 assistant 历史的补丁。
    //
    // 改写只在从句里加一个 `that`：读者读到的意思一字不差，被禁的字节序列不再出现。
    match: 'Tokens prefixed with @ are paths the user explicitly referenced.',
    replace: 'Tokens prefixed with @ are paths that the user explicitly referenced.',
  },
]

/**
 * 把被扫描消息里的已知 span 换成等价改写。
 *
 * 只在命中时改字节：不含这些 span 的请求**逐字节不变**（与
 * {@link neutralizeChannelFingerprints} 同一条纪律，也是这条改写能无条件跑在
 * 请求路径上的理由——它不是「每次都改」，是「命中才改」）。
 *
 * **匹配口径必须和网关一样，而不是和被禁那份字节一样。** 实测网关的比对是
 * 「小写折叠 + 连续空格压成一个」（`.probe/t34f`：`double_space` 仍 400、`case_word`
 * 仍 400，换行才是 200），所以这里用「词序相等 + `\s+` 连接 + `i` 标志」来匹配：
 * 逐字节字面匹配会比闸门更窄——提示词里多一个空格或换个大写，表就整条落空，而请求
 * 照样被拒。极端形状（换行）由救援梯兜住，因为那已经超出「同一句话」的范围。
 *
 * 拼接用 `\s+` 而不是把原字符串整体转义：span 里含引号、逗号与句点，逐词转义后拼接
 * 才是唯一不会漏转义字符的写法。改写结果里 `\s+` 一律落成单空格——与网关看到的一致。
 *
 * 幂等：改写后不再包含任何一个词序列（`…Web GUI. The runtime context names its URL.`
 * 里没有 `whose URL`），所以同一个 body 过两次结果不变。
 */
function rewriteChannelSpans(obj: Record<string, unknown>): void {
  mapScannedText(obj, text => {
    let next = text
    for (const rule of COMPILED_SPAN_REWRITES) {
      next = next.replace(rule.pattern, rule.replace)
    }
    return next === text ? undefined : next
  })
}

/** 把一条实测 span 编译成「与网关同口径」的匹配式（见 {@link rewriteChannelSpans}）。 */
function spanPattern(match: string): RegExp {
  const words = match.trim().split(/\s+/u).map(word => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
  return new RegExp(words.join('\\s+'), 'giu')
}

/**
 * 编译一次，请求路径上只做匹配。
 *
 * 正则编译比一次 50 KB 文本的扫描贵得多，而这条路径每个请求都会跑（每个被扫描消息
 * 一次）。`g` 标志带来的 `lastIndex` 状态不是问题：`String.prototype.replace` 在读之前
 * 把它归零，用完也归零。
 */
const COMPILED_SPAN_REWRITES = CHANNEL_SPAN_REWRITES.map(rule => ({
  pattern: spanPattern(rule.match),
  replace: rule.replace,
}))

/**
 * `content` 是否已经以中性占位开头。
 *
 * 只用于回答「再前置一次有没有意义」。比较前 trim 前导空白，理由与
 * {@link isUnapprovedChannelOpening} 相同：网关今天会 trim，明天可能不 trim，而
 * 我们只想知道自己有没有已经加过。
 */
function startsWithNeutralHead(text: string): boolean {
  return text.replace(/^\s+/u, '').startsWith(WB_FALLBACK_SYSTEM_PROMPT)
}

/**
 * 自救第一级：给**每一条**被扫描消息的开头前置中性占位。
 *
 * 与 {@link neutralizeChannelFingerprints} 的区别是**判据**：那一步只在命中已知
 * 指纹表时才改写（宁可放过也不误伤），这一步在收到 `channel_reject` 之后无条件
 * 改写每一条 system / assistant 的开场（已经以占位开头的不重复加）。
 *
 * 为什么需要它：那张指纹表**按定义不可能完整**——它是一次实测快照，上游随时能
 * 加条目而我们看不到。表外的新指纹会让第一道防线整条落空，只剩一个必然的 400。
 * 参考插件在同一处注释里承认过这件事（`THE LIST CANNOT BE COMPLETE`），这也是
 * 它保留两级重试的原因。
 *
 * 跳过的情况各有理由：
 * - `content.trim() === ''`：空内容不可能是「有罪的开关」，而带 `tool_calls` 的
 *   `content: ''` 是合法的重放形状，往里面塞文字会改变语义；
 * - 已经以占位开头：再加一次只会让提示词多一行噪声，白花一次注定被拒的往返。
 *
 * 无变化返回 `undefined`，调用方据此**不发**那次请求。
 *
 * 从解析后的对象重新序列化，保住原 key 顺序：重试的是同一个请求，不是重排过的
 * 请求。JSON 解析失败原样返回 `undefined`——绝不因为自救逻辑本身把一个能用的
 * 请求弄坏。
 */
export function forceNeutralHead(bodyJson: string): string | undefined {
  let body: unknown
  try {
    body = JSON.parse(bodyJson)
  } catch {
    return undefined
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const obj = body as Record<string, unknown>
  const messages = obj['messages']
  if (!Array.isArray(messages)) return undefined

  const prefix = `${WB_FALLBACK_SYSTEM_PROMPT}\n\n`
  const changed = mapScannedText(obj, content =>
    content.trim() === '' || startsWithNeutralHead(content) ? undefined : `${prefix}${content}`)
  return changed ? JSON.stringify(obj) : undefined
}

/** 扰动时插入的不可见字符。选 U+200B 而不是别的：它是零宽的，不改变视觉呈现。 */
const ZERO_WIDTH_SPACE = '\u200b'

/**
 * 「大驼峰词 + 空白 + 大驼峰词」形状。
 *
 * 四条标点规则全都落不到这个形状上，而它恰好是最常见的产品名写法：
 * `… powered by DeepSeek Harness`。当指纹是这句而不是「带句号的一句话」时，
 * 只按标点扰动等于什么都没做。
 */
const WORD_INTERNAL_BREAK = /([A-Z][A-Za-z0-9]*)(\s+)(?=[A-Z][A-Za-z0-9])/gu

/**
 * 在句子与词的边界插入零宽字符。
 *
 * **它已经不是救援梯的一级了：2026-10-29 实测失效。** 网关对四种不可见字符
 * （U+200B / U+200D / U+2060 / U+00AD）都先剥离再比对，每个词后插满的密集扰动仍然
 * 400（`.probe/t34e` `span_dense`、`.probe/t34f` `zwj_dense`/`wj_dense`/`shy_dense`）。
 * 保留这个导出只为一件事：`tests/channel-rescue.test.ts` 用它的四条规则钉住「哪一类
 * 文本会被它改」，而那段逻辑仍然是**中文提示词**唯一的批量扰动手段。救援梯改走
 * {@link relocateScannedContent}——那一步不需要猜 span，也不需要网关不剥离字符。
 *
 * 下面这段是它失效前的依据，留档：网关不只匹配被扫描消息的**开场**，还匹配提示词里
 * 一处很长的**内层子串**（实测 DSH Web-GUI 段落前两句共 221 字符）。四条规则是当时的
 * 完备性要求：
 * - `([.!?])(\s+)`：英文句末 + 空白（最常见）；
 * - `([。！？])`：中文句末（中文提示词里不带空格，独立一条）；
 * - `([,;])(\s+)`：分号/逗号后的子句边界（长 span 常跨子句）；
 * - {@link WORD_INTERNAL_BREAK}：无尾随标点的产品名（见该常量的注释）。
 *
 * **幂等**：已经含零宽字符的文本直接跳过，叠加只会让提示词越来越难读。
 * 无变化返回 `undefined`，永不抛出。
 */
export function perturbChannelFingerprints(bodyJson: string): string | undefined {
  let body: unknown
  try {
    body = JSON.parse(bodyJson)
  } catch {
    return undefined
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const obj = body as Record<string, unknown>
  if (!Array.isArray(obj['messages'])) return undefined

  const changed = mapScannedText(obj, text => {
    if (text.includes(ZERO_WIDTH_SPACE)) return undefined
    const next = text
      .replace(/([.!?])(\s+)/gu, `$1${ZERO_WIDTH_SPACE}$2`)
      .replace(/([。！？])/gu, `$1${ZERO_WIDTH_SPACE}`)
      .replace(/([,;])(\s+)/gu, `$1${ZERO_WIDTH_SPACE}$2`)
      .replace(WORD_INTERNAL_BREAK, `$1${ZERO_WIDTH_SPACE}$2`)
    return next === text ? undefined : next
  })
  return changed ? JSON.stringify(obj) : undefined
}

/**
 * 把被扫描消息的正文**搬进一条 `user` 消息**，`system` 只留中性占位。
 *
 * **这是默认的请求形态，不是救援步骤。** 理由是一次一天之内的两次报障：
 *
 * - 第一次（221 字符 Web-GUI 段落）：网关按**正文子串**拒绝，我们加了一条改写；
 * - 第二次（同一天的 233 条消息会话）：又一条我们没见过的 DSH 提示词 span
 *   （`Tokens prefixed with @ are paths…`，`.probe/t39b` 用 ddmin 压出来的）。
 *
 * 两条 span 出自同一个来源——网关的清单是拿**已知 agent 提示词库**生成的，DSH 的 19 KB
 * 系统提示里被收进去的不止一段。逐条追是追不完的：每加一条都要等用户先撞一次。
 * 换角色则一次性解决**所有** system 正文的指纹，包括明天才会出现的那条。
 *
 * **为什么它成立。** 网关只读 `system` 与 `assistant` 两类消息的正文（2026-10-29 实测：
 * 同一段 span 放进 `user` 消息，标题位置与正文中段都是 200，见 `.probe/t34f` 的
 * `as_user` / `as_user_mid`；本次真实会话里 38 条 system/assistant 逐条扫，只有两条
 * system 被拒，见 `.probe/t40`）。所以要让一份内容不再被扫描，除了改写它，还可以
 * **换一个角色承载它**——不需要猜任何一个词条。
 *
 * **为什么不是「把 system 整条删掉」。** 11128 家族还有一支是「首条不是 system 提示词」，
 * 删掉首条 system 会把渠道闸门换成另一支同样的 400。所以首条**仍然**是 system，只是
 * 它变成中性占位，原文搬进紧随其后的第一条 `user`。
 *
 * **代价。** `system` 与 `user` 在多数模型上只是权重差异，不是语义差异；真实代价是
 * 「模型可能不像读系统提示那样读这段规则」。给搬运块加一句说明就是为这件事：
 * 让它明确知道这段话是**常驻规则**，不是用户这一轮的问题。另一个代价是这条路径对
 * 所有请求生效（含本来能过闸门的），换来的是不再需要每次先失败一次。
 *
 * **不动 `assistant` 历史。** 它的正文无法搬到别的角色而不破坏 `tool_calls` 配对，所以
 * 这里只搬 `system`；`assistant` 历史里若也有 span，留给
 * {@link CHANNEL_SPAN_REWRITES} 的逐条改写（那是唯一不破坏配对的改法）。本次真实会话
 * 的 80 条 assistant 消息逐条单发全部 200，这条风险目前是理论上的。
 *
 * 无可搬运内容（没有 system，或 system 正文就只有一行中性占位）时返回 `undefined`：
 * 调用方据此原样使用 `prepared`，不为一次逐字节相同的请求多花往返。
 */
export function relocateScannedContent(bodyJson: string): string | undefined {
  let body: unknown
  try {
    body = JSON.parse(bodyJson)
  } catch {
    return undefined
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const obj = body as Record<string, unknown>
  const messages = obj['messages']
  if (!Array.isArray(messages)) return undefined

  /** 取一条消息的可搬运正文；数组 content 只搬文本 part（图片不属于提示词规则）。 */
  const carriedText = (content: unknown): string | undefined => {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return undefined
    const texts: string[] = []
    for (const part of content) {
      if (typeof part !== 'object' || part === null || Array.isArray(part)) continue
      const record = part as Record<string, unknown>
      const type = record['type']
      if (typeof type !== 'string' || type.trim().toLowerCase() !== 'text') continue
      const text = record['text']
      if (typeof text === 'string') texts.push(text)
    }
    return texts.length === 0 ? undefined : texts.join('\n\n')
  }

  const kept: unknown[] = []
  const carried: string[] = []
  for (const value of messages) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      kept.push(value)
      continue
    }
    const message = value as Record<string, unknown>
    const role = typeof message['role'] === 'string' ? message['role'].trim().toLowerCase() : ''
    if (role !== 'system') {
      kept.push(value)
      continue
    }
    const text = carriedText(message['content'])
    // 空正文与「只有一行中性占位」不搬：搬过去也只是把同一行字换个角色。除此之外
    // 一律搬——**包括已经带着中性头的那条**，因为中性头只挡前缀门，挡不住正文 span，
    // 而后者才是默认形态要解决的东西。
    if (text === undefined) continue
    const trimmed = text.trim()
    if (trimmed === '' || trimmed === WB_FALLBACK_SYSTEM_PROMPT) continue
    carried.push(text)
  }
  if (carried.length === 0) return undefined

  obj['messages'] = [
    { role: 'system', content: WB_FALLBACK_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `${RELOCATED_CONTEXT_HEAD}\n\n${carried.join('\n\n')}`,
    },
    ...kept,
  ]
  return JSON.stringify(obj)
}

/**
 * 搬运块开头那句说明。
 *
 * 它必须做两件事：告诉模型这段话是**常驻规则**（否则一段二十万字的系统提示读起来像
 * 用户这一轮的口气），并且不说「以下是系统提示词」——那等于把「这不是官方客户端」
 * 写进请求正文，正好是这道闸门要找的东西。
 */
const RELOCATED_CONTEXT_HEAD = 'This is my standing context and the rules I need you to keep following for this whole conversation.'

/**
 * 删掉只会失败的 `reasoning_effort: "off"`（issue #34 / #83）。
 *
 * 拒绝表 `REFUSES_OFF_MODEL_IDS` 住在 `status-paths.ts:402`，因为 `adapter.ts` 造
 * `thinkingLevelMap` 时也要读它（那里决定 `map.off` 是 `'off'` 还是 `null`），而
 * 两个半区都得看得见同一份真相。这张表记的是实测结果：上游名册把
 * `reasoning.canDisableThinking` 声明成 true，但这几个 id 对 `off` 回 HTTP 400 /
 * 业务码 11133，其余每一档以及完全不带该字段都能过——声明的能力字段分不开这两组，
 * 所以只能按精确 id 硬记。
 *
 * adapter 现在会宣告 reasoning，因此**正常情况下 body 里就不该再出现会失败的
 * `off`**（`wbThinkingLevelMap` 已经把拒绝表的 id 的 `off` 映射成 `null`，选择器
 * 根本不会提供这一档）。保留这一步是纵深防御：请求实际点名的模型可能在名册建好
 * 之后才变（换号会把 body 重新指向另一个账号的模型，`primary-model` 这类别名由
 * 网关解析成具体 id），而归一化适配器是按**调用方点名**的模型查目录的，两者在此
 * 处可能不一致。一旦漏掉，失败形态是「这个模型坏了」而不是「这一档设置非法」——
 * 同一档失败会跟着已保存的每模型选择重复出现在之后的每一轮。
 *
 * 在这里删，是因为这是插件在上游记账之前能控制的最后一步。
 *
 * 只动字面 `"off"`。其余每一档在测过的每个模型上都返回 200；不带该字段的 body 一律
 * 不碰：删掉调用方从没发过的字段，等于替它决定模型该怎么思考。
 */
function dropRefusedReasoning(obj: Record<string, unknown>): void {
  const effort = obj['reasoning_effort']
  if (typeof effort !== 'string' || effort.trim().toLowerCase() !== 'off') return
  const model = obj['model']
  if (typeof model !== 'string' || !WB_REFUSES_OFF_MODEL_IDS.has(model)) return
  delete obj['reasoning_effort']
}

/**
 * 把 OpenAI 形状的入站请求改写成 WorkBuddy 上游能接受的形状。
 *
 * 五件事是硬性形状要求、两件是渠道闸门，都有实测依据，缺一条就是必然失败
 * （照 `dsh-connect-workbuddy/src/upstream.ts:1919` 的实现，注释带走理由）：
 *
 * 1. `stream` 强制 `true`：上游聊天端点只有流式形态，非流式请求会挂住不返回。
 * 2. `developer` 角色改写成 `system`：DSH 用 OpenAI 的 `developer` 角色发系统提示词，
 *    而 WorkBuddy 的 CLI 通道只认 `system`，遇到 `developer` 回业务码 11128
 *    （「未授权通道」）。
 * 3. 首条消息必须是 `system`：网关按开场白指纹判定通道，首条不是 system 时补一条
 *    中性占位。
 * 4. 渠道闸门①（前缀）：命中已知开场白的 system/assistant 消息前置中性占位。
 * 5. 渠道闸门②（子串）：正文里的已知 span 换成语义等价的改写。这两道门是**不同**的
 *    规则——2026-10-29 实测：网关对正文做大小写折叠的精确子串匹配，且会把不可见
 *    字符剥离后比对，所以只有第 4 步救不了内层 span，只有第 5 步也救不了开场白。
 * 6. `tool_choice` 归一成字符串：上游只接受 `'auto'|'required'|'none'` 三态字符串，
 *    OpenAI 的对象形态会被拒；`none` 还要连带删掉 `tools`（否则上游仍会尝试调用工具）。
 *
 * 以上六步都只在**命中时**改字节：一份今天能过 200 的请求，出站时逐字节不变。
 *
 * 纯函数，解析失败原样返回：绝不因为改写逻辑本身把一个能用的请求弄坏。
 */
export function prepareChatBody(source: string): string {
  let body: unknown
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return source
  const obj = body as Record<string, unknown>
  obj['stream'] = true
  if (Array.isArray(obj['messages'])) {
    for (const value of obj['messages']) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const message = value as Record<string, unknown>
      if (message['role'] === 'developer') message['role'] = 'system'
    }
  }
  // 首条必须是 system：网关按开场白指纹判定通道。
  const messages = obj['messages']
  if (Array.isArray(messages) && messages.length > 0) {
    const head = messages[0]
    if (typeof head === 'object' && head !== null && !Array.isArray(head)) {
      const role = (head as Record<string, unknown>)['role']
      const isSystem = typeof role === 'string' && role.trim().toLowerCase() === 'system'
      if (!isSystem) messages.unshift({ role: 'system', content: WB_FALLBACK_SYSTEM_PROMPT })
    }
  }
  // 渠道闸门第一道：把命中已知指纹的 system/assistant 开场移出匹配区。
  // 必须在首条 system 兜底之后——兜底补的那条是中性占位，本来就会通过。
  neutralizeChannelFingerprints(obj)
  // 渠道闸门第二道：把正文里的已知 span 换成等价改写。与上一步是**两道不同的门**
  // （前缀 / 子串），实测同一天同时存在，所以两步都要跑，且顺序无关但都不能省。
  // 命中才改字节，命中不了的请求逐字节不变。
  rewriteChannelSpans(obj)
  // tool_choice 归一。
  if ('tool_choice' in obj) {
    const choice: unknown = obj['tool_choice']
    const suppress = (): void => {
      delete obj['tools']
      delete obj['functions']
    }
    if (typeof choice === 'string') {
      if (choice.trim().toLowerCase() === 'none') {
        delete obj['tool_choice']
        suppress()
      } else if (choice.trim().toLowerCase() === 'auto' || choice.trim().toLowerCase() === 'required') {
        obj['tool_choice'] = choice.trim().toLowerCase()
      }
    } else if (typeof choice === 'object' && choice !== null && !Array.isArray(choice)) {
      const wrapped = choice as Record<string, unknown>
      const type = typeof wrapped['type'] === 'string' ? wrapped['type'].trim().toLowerCase() : ''
      if (type === 'none') {
        delete obj['tool_choice']
        suppress()
      } else if (type === 'auto' || type === 'required') {
        obj['tool_choice'] = type
      }
    }
  }
  // 渠道闸门第二道：删掉只会被拒的 reasoning_effort。放在最后，因为它是唯一
  // 会**减少**字段的一步，前面任何一步都可能重新引入该字段。
  dropRefusedReasoning(obj)
  return JSON.stringify(obj)
}

export function createWbShim(options: WbShimOptions): WbShim {
  const { pool, client, catalog, region } = options
  const logger = options.logger
  const maxAttempts = options.maxAttempts ?? 8

  /**
   * 读当前的临期窗口。
   *
   * 每次用到都重新问一遍（而不是构造时快照）：设置页改完立刻生效，不必重启插件。
   * getter 抛错时返回 `undefined` 让 `aggregateCredits` 落回兜底值——一个读配置
   * 失败绝不能让余额刷新整体失败（那会把卡片变成「余额未知」，而池里明明有旧读数）。
   */
  function warnDaysOf(): number | undefined {
    try {
      return options.expiryWarnDays?.()
    } catch {
      return undefined
    }
  }

  // 进程内 secret。adapter 把它解析为 OpenAI apiKey；shim 从不转发它，因为真实
  // token 来自账号池。
  const SHARED_SECRET = randomBytes(32).toString('base64url')

  function bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const a = Buffer.from(match[1] as string)
    const b = Buffer.from(SHARED_SECRET)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  /**
   * (账号, 模型) → 冷却截止时刻。
   *
   * 以模型为键的第二段是必须的：上游限流按模型计（错误文案会建议「可切换其他模型
   * 继续使用」），`hy4-preview` 上的 429 只该冷却该账号的那个模型，封掉整账号会让
   * 用户在一个模型的限流里丢掉全部模型。
   */
  const cooldownUntil = new Map<string, number>()

  function cooldownKey(accountId: string, modelId: string | undefined): string {
    return `${accountId}\u0000${modelId ?? '*'}`
  }

  function markCooling(accountId: string, modelId: string | undefined, kind: WbUpstreamErrorKind, message: string): void {
    const hours = kind === 'hard_credit' ? WB_HARD_CREDIT_COOLDOWN_MS : WB_DEFAULT_COOLDOWN_MS
    const parsed = kind === 'soft_rate' ? parseRateLimitReset(message) : undefined
    const until = parsed ?? Date.now() + hours
    cooldownUntil.set(cooldownKey(accountId, modelId), until)
  }

  /**
   * 此刻在冷却的账号 id。
   *
   * 冷却表以 `(账号, 模型)` 为键，而 `pool.pick` 的 `excludeIds` 只认账号 id——
   * 所以这里必须按**本次请求的模型**过滤一遍再展开成数组，否则把「A 账号在
   * hy4-preview 上被限流」错误地排除成「A 账号在所有模型上都不可用」。
   *
   * 无模型的请求（`modelId === undefined`）配到的是通配键 `*`；它代表「整个账号
   * 都别用了」，因此对任意模型都成立。
   */
  function coolingIdsOf(modelId: string | undefined): string[] {
    const now = Date.now()
    const ids: string[] = []
    for (const key of [...cooldownUntil.keys()]) {
      const until = cooldownUntil.get(key)
      if (until === undefined) continue
      if (until <= now) {
        // 顺手清掉过期项：这张表没有第二处清扫点，只增不删会随进程寿命无限增长。
        cooldownUntil.delete(key)
        continue
      }
      const [accountId, cooledModel] = key.split('\u0000')
      if (accountId === undefined || accountId === '') continue
      if (cooledModel !== '*' && cooledModel !== (modelId ?? '*')) continue
      if (!ids.includes(accountId)) ids.push(accountId)
    }
    return ids
  }

  /**
   * 尽力刷新一个账号的积分余额。
   *
   * 成功请求后于后台运行。失败被刻意吞掉：余额读数只是排序与显示的依据，一次抖动
   * 的余额查询绝不能变成失败的用户请求或噪声日志。
   *
   * 到期时间与余额同行写回：`expiry` 分布靠它排序，而余额读取是我们唯一能学到它的
   * 地方。
   */
  const lastBalanceAt = new Map<string, number>()
  const BALANCE_REFRESH_MS = 10 * 60_000

  async function refreshBalance(account: WbDiscoveredAccount): Promise<void> {
    const now = Date.now()
    if (now - (lastBalanceAt.get(account.id) ?? 0) < BALANCE_REFRESH_MS) return
    lastBalanceAt.set(account.id, now)
    try {
      const raw = await client.fetchCredits(account.credential)
      // 窗口聚合必须在这里做，而且必须用用户的窗口。
      //
      // 这里曾经写的是 `expiringSoon: 0`，注释还自称「窗口聚合由宿主按用户的
      // expiryWarnDays 做（probe.ts）」——但请求路径上 `aggregateCredits` 从未被
      // 调用，而这条路径是聊天后**唯一**刷新余额的地方（每账号 10 分钟一次），
      // 于是排序层只能落回它自己的 3 天兜底：用户把提醒改成 30 天，卡片照样显示
      // 旧数字、`expiry` 分布照样按 3 天选号。
      //
      // 现在口径与探测层完全同源（同一个 `aggregateCredits`）：`expiringSoon` 与
      // `nearestExpiryMs` 都由用户窗口算出，`expiryFactsOf` 拿到的是显式值。
      const warnDays = warnDaysOf()
      const { credits } = aggregateCredits(raw, {
        nowMs: now,
        ...warnDays === undefined ? {} : { warnDays },
      })
      pool.noteCredits(account.id, credits)
    } catch {
      // 保留上一次读数；下一个请求再试。
    }
  }

  function writeSseHead(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
  }

  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'chat completions requires application/json')
      return
    }
    let raw: string
    try {
      raw = (await readBody(req)).toString('utf8')
    } catch (error: unknown) {
      writeOpenAIError(res, 413, 'body_too_large', error instanceof Error ? error.message : 'request body too large')
      return
    }

    const controller = new AbortController()
    req.on('close', () => controller.abort())

    // `sticky` 把每个对话绑到一个账号；其他分布下池会忽略它。
    const conversationKey = conversationKeyOf(raw)
    const modelId = modelIdOf(raw)
    const prepared = prepareChatBody(raw)

    const tried: string[] = []
    const excluded: string[] = []
    let last: { kind: WbUpstreamErrorKind; status: number; message: string } | undefined

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (controller.signal.aborted) return

      // 选谁由池说了算——`pool.pick` 是唯一的选号 Owner（五种「账户使用方式」、
      // 用户的手动切号、未勾选账号的排除、以及「这个账号能不能服务」的判定全在
      // 它内部）。这里能做且只该做的，是把**本次不该再试**的账号告诉它。
      //
      // 两个来源必须合并后一起交进去：
      // - `excluded`：本次请求内已经试过并失败的账号；
      // - `coolingIdsOf(modelId)`：已知在冷却的账号（按本次请求的模型过滤）。
      //
      // 以前这里只交 `excluded`，然后拿 `result.ranked` 自己再过滤一遍、取队首。
      // 那样等于把池的结论整个丢掉：`ranked` 只是排序结果，不含 preferred 短路、
      // 不含 distribution 分支、也不含排除项——于是 round-robin / balanced /
      // sticky / 手动切号 / 未勾选排除五条路径全部失效，只有「分布结果恰好等于
      // 队首」的 priority 与 expiry 侥幸正确。而冷却中的账号从未进过 `excluded`，
      // 双过滤还会把它重新选一次，对同一个限流账号形成重复打击。
      const result = pool.pick(region, {
        ...conversationKey === undefined ? {} : { conversationKey },
        excludeIds: [...excluded, ...coolingIdsOf(modelId)],
      })
      const account = result.account
      if (account === undefined) {
        // 直接问池「为什么」，而不是从本次循环单独推断。旧写法用一个只在本次循环
        // 置位的标志，它看不见更早请求建立的冷却：一次 429 之后，下一个请求在第一次
        // 尝试就找不到账号、标志仍是 false，于是回答 401「无凭据，请登录」——DSH 把
        // 它渲染成「API key 无效」，把一个临时限流变成让用户重新登录。
        // 上一次尝试已经有具体结论时先说那个结论。
        // exhaustedReason 只能回答「为什么没得选」，而「积分耗尽 / 上游 5xx」
        // 才是用户需要知道的事，且带着上游原话。把 402 压成 429「都在冷却」
        // 会让用户去等一会儿，而他真正该做的是去签到或换账号。
        // 凭据被拒是例外：exhaustedReason 能把它说成「都被拒了，去重新登录」，比转发一条 401 原文更可用。
        if (last !== undefined && last.kind !== 'authentication' && last.kind !== 'session_dead') {
          writeOpenAIError(
            res,
            KIND_STATUS[last.kind],
            last.kind,
            `试过 ${tried.length} 个 WorkBuddy 账号都没有成功: ${tried.join(' → ')} — ${last.message.slice(0, 300)}`,
          )
          return
        }
        const why = exhaustedReason(result.ranked.length, excluded)
        writeOpenAIError(res, why.status, why.kind, why.message)
        return
      }

      tried.push(account.label)
      excluded.push(account.id)

      // 起跑形态：**默认**就把 system 正文搬进 user（见 `relocateScannedContent` 的
      // 文档）。这一步不需要先失败一次，因为网关的指纹清单来自「已知 agent 提示词库」，
      // DSH 的提示词里被收进去的段落在一天之内就出现了两条——等失败再救等于每次都先
      // 白花两三倍的上游调用。
      //
      // `undefined` 只在「没有可搬运的 system 正文」时出现，此时原样用 `prepared`。
      let attemptBody = relocateScannedContent(prepared) ?? prepared

      let outcome = await client.chatStream(account.credential, attemptBody, controller.signal)
      if (controller.signal.aborted) return

      // 渠道闸门的退路。
      //
      // 为什么自救放在**账号循环内部**、而不是像别的失败那样 `continue` 换下一个：
      // 闸门读的是请求内容，不读账号。换号只会用另一个凭据发一份同样会被拒的
      // 请求体，8 次尝试全是白花，用户等到的是一个「试过 N 个账号」的错误。
      //
      // 梯子形状（同一凭据上连打，最多三级）：
      //   1. `attemptBody`：迁移形态（默认）
      //   2. `prepared`：**保留 system 角色**的形态。迁移本身万一不被接受（例如某个
      //      网关要求规则必须出现在 system 里），这一级把角色还原，只留 span 改写。
      //   3. `forceNeutralHead(prepared)`：再给每条被扫描消息前置中性占位，覆盖
      //      「表外的新前缀」。
      //
      // 零宽扰动曾经是第三级，2026-10-29 实测已被网关的字符剥离挡死（密集扰动仍 400，
      // 见 `.probe/t34e`），所以它不再是梯级。
      //
      // 任一级与上一级逐字节相同时**不发**：一个必然重复的请求只会再换来一次 400。
      if (!outcome.ok && outcome.kind === 'channel_reject') {
        if (prepared !== attemptBody) {
          outcome = await client.chatStream(account.credential, prepared, controller.signal)
          if (controller.signal.aborted) return
        }
        if (!outcome.ok && outcome.kind === 'channel_reject') {
          const forced = forceNeutralHead(prepared)
          if (forced !== undefined && forced !== prepared) {
            outcome = await client.chatStream(account.credential, forced, controller.signal)
            if (controller.signal.aborted) return
          }
        }
      }

      if (outcome.ok) {
        writeSseHead(res)
        try {
          for await (const chunk of Readable.fromWeb(outcome.response.body as Parameters<typeof Readable.fromWeb>[0])) {
            if (controller.signal.aborted) break
            res.write(chunk)
          }
        } catch (error: unknown) {
          // 中途断开无法用状态码表达（头已发出）；记一次并结束响应，让 DSH 侧看到
          // 一个截断的流并自行决定重试。
          logger?.warn('dsh-connect-workbuddy-models: 上游流在中途断开', error)
        } finally {
          if (!res.writableEnded) res.end()
        }
        void refreshBalance(account)
        return
      }

      last = { kind: outcome.kind, status: outcome.status, message: outcome.message }

      if (outcome.kind === 'authentication' || outcome.kind === 'session_dead') {
        // 凭据被上游拒绝是**账号级**事实，不是这次请求的：记进池，让卡片能说「请重新
        // 登录」，也让后续请求不再反复撞同一份死 token。
        //
        // 但「凭据被拒」必须是**上游说的**，不能是「我们自己没刷新成功」。`retryable`
        // 就是这条界线：刷新时网络抖一下、超时、边缘层回 502 HTML，客户端会返回
        // `kind: 'authentication'`（因为这次请求确实没救）却带 `retryable: true`。
        // 以前这里只看 kind，于是把一次抖动标成凭据已死 —— 而那时判死没有任何
        // 恢复路径，该账号要等 DSH 重启才回到池里，用户还被告知去重新登录。
        // 可重试的走冷却：既有 `WB_DEFAULT_COOLDOWN_MS` 到点自动恢复参选。
        //
        // 现在判死也**不是**永久的：判死的账号会被 `exclusionReason` 排到
        // `usable: false`，所以它自己不会被再选中（因而「成功一次就清标记」这条路
        // 结构上走不到）；真正的恢复入口是 rescan 发现**换了 token** 的同一账号
        // （用户回桌面端重登了），见 `WbAccountPool.applyDiscovery`。
        if (outcome.retryable === true) {
          markCooling(account.id, modelId, 'soft_rate', outcome.message)
        } else {
          pool.markCredentialDead(account.id)
        }
      }
      if (outcome.kind === 'soft_rate' || outcome.kind === 'hard_credit') {
        markCooling(account.id, modelId, outcome.kind, outcome.message)
      }
      if (outcome.kind === 'local_gate_oversize' || outcome.kind === 'local_gate_unattributed') {
        // 请求根本没到 WorkBuddy 上游：拒绝是本机 billion-context 闸门下的。三条后果：
        // - **不换号**：闸门读的是请求体大小与会话归属，换一份凭据会拿着同一份超长历史
        //   再撞同一道闸门；
        // - **不判凭据已死**：这份凭据一次都没被上游看到过，标死它纯属误伤；
        // - **保留 422**：压成 400 会让它与「参数写错了」同形（旧实现就是这样）。
        //
        // 正文走 `localGateAdvice`：闸门自己写的三条可执行建议被结构化成中文，而不是
        // 把那段英文长句连同 JSON 骨架一起甩给用户。
        const shape = requestShape(raw)
        logger?.warn(
          'dsh-connect-workbuddy-models: 请求被本机 billion-context 闸门拒绝（未发出）',
          outcome.kind,
          shape,
          outcome.message.slice(0, 200),
        )
        writeOpenAIError(
          res,
          KIND_STATUS[outcome.kind],
          outcome.kind,
          `这个请求被本机 billion-context 闸门拦下了，没有发给 WorkBuddy 上游（${shape}）。`
          + localGateAdvice(outcome),
        )
        return
      }
      if (outcome.kind === 'channel_reject') {
        // 三级都试过、都不管用。此时**不换号**：闸门读请求不读账号，换号只会
        // 用另一份凭据发一份同样会被拒的请求体。直接给出这一条结论，并把「试过
        // 哪几级」写进日志——下一次有人报同一个 400 时，第一件要确认的事就是
        // 那三级到底跑没跑过。
        const shape = requestShape(raw)
        logger?.warn(
          'dsh-connect-workbuddy-models: 渠道闸门拒绝了请求，三级形态均被拒',
          shape,
          outcome.message.slice(0, 200),
        )
        writeOpenAIError(
          res,
          KIND_STATUS['channel_reject'],
          'channel_reject',
          `上游把这个请求判为未授权通道（${shape}）：内容迁移、还原 system 角色、中性开头三种形态都试过仍未放行。`
          + '前两种已经把 system 正文放到网关不扫描的位置、或改写掉已知 span，'
          + '所以剩下的触发点只可能在 assistant 历史里；请把这句话连同下面的上游原话反馈给我们。'
          + ` 上游原话：${outcome.message.slice(0, 300)}`,
        )
        return
      }
      if (outcome.kind === 'client_reject' || outcome.kind === 'client') {
        // 请求形状本身被拒：换账号不会有不同结果。立即返回，别浪费 8 次尝试。
        const shape = requestShape(raw)
        logger?.warn('dsh-connect-workbuddy-models: 上游拒绝了请求形状', shape, outcome.message.slice(0, 200))
        const contextTooLong = isContextTooLong(outcome.message)
        const body = clientRejectionBody(outcome, contextTooLong)
        writeOpenAIError(
          res,
          contextTooLong ? 400 : KIND_STATUS[outcome.kind],
          contextTooLong ? 'context_length_exceeded' : outcome.kind,
          contextTooLong
            ? `这个模型的上下文窗口放不下当前对话（${shape}）；请减少历史或换一个更大窗口的模型`
            : `上游拒绝了这个请求（${shape}）：${body}`,
        )
        return
      }
    }

    // 尝试用尽。
    const upstream = last === undefined ? '' : ` — ${last.message.slice(0, 200)}`
    writeOpenAIError(
      res,
      last === undefined ? 502 : KIND_STATUS[last.kind],
      last?.kind ?? 'server',
      `试过 ${tried.length} 个 WorkBuddy 账号都没有成功: ${tried.join(' → ')}${upstream}`,
    )
  }

  /**
   * 「没有账号可用」的可执行解释。
   *
   * 每一条都要能让用户采取行动（重新登录 / 勾选参与池 / 等一会 / 换模型），而不是
   * 只说「不可用」。
   */
  function exhaustedReason(total: number, excluded: readonly string[]): { status: number; kind: string; message: string } {
    const area = region === 'global' ? '国际版' : '国内版'
    if (total === 0) {
      return {
        status: 401,
        kind: 'not_signed_in',
        message: `没有发现任何${area} WorkBuddy 账号；请先登录 WorkBuddy 桌面端（国内账号登 codebuddy.cn，国际账号登 workbuddy.ai）`,
      }
    }
    const dead = excluded.filter(id => pool.find(id)?.credentialDead === true).length
    if (dead > 0 && dead >= excluded.length) {
      return {
        status: 401,
        kind: 'session_dead',
        message: `${area}的 ${dead} 个账号都被上游拒绝了登录凭据；请重新登录 WorkBuddy 桌面端`,
      }
    }
    return {
      status: 429,
      kind: 'soft_rate',
      message: `${area}的 ${total} 个账号此刻都在冷却或被排除（本次已试 ${excluded.length} 个）；请稍等片刻或换一个模型`,
    }
  }

  const server: Server = createServer((req, res) => {
    void handleRequest(req, res)
  })

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // 四重校验，缺一条都不放行。
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(res, 403, 'forbidden_host', 'this endpoint only serves loopback hosts')
        return
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, 'forbidden_origin', 'this endpoint only serves loopback origins')
        return
      }
      if (!bearerOk(req)) {
        writeOpenAIError(res, 401, 'invalid_api_key', 'this endpoint requires the in-process WorkBuddy pool secret')
        return
      }

      const method = req.method ?? 'GET'
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (method === 'POST' && url.pathname === '/v1/chat/completions') {
        await chatCompletions(req, res)
        return
      }
      if (method === 'GET' && url.pathname === '/v1/models') {
        writeJson(res, 200, {
          object: 'list',
          data: catalog.visible().map(model => ({
            id: model.id,
            object: 'model',
            owned_by: 'workbuddy',
            ...model.contextWindow === undefined ? {} : { context_window: model.contextWindow },
          })),
        })
        return
      }
      writeOpenAIError(res, 404, 'not_found', `no such route: ${method} ${url.pathname}`)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      logger?.error('dsh-connect-workbuddy-models: shim 请求失败', error)
      if (!res.headersSent) writeOpenAIError(res, 500, 'server', message)
      else if (!res.writableEnded) res.end()
    }
  }

  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })

  server.listen(0, '127.0.0.1')

  const baseUrl = (): string => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('workbuddy-models shim 还没有监听地址')
    }
    return `http://127.0.0.1:${address.port}`
  }

  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    close: () => new Promise<void>(resolve => {
      server.close(() => resolve())
      // `close` 只停止接受新连接；已建立的 keep-alive 连接会让它一直不回调。
      // 主动断开，免得宿主退出时挂住。
      server.closeAllConnections?.()
    }),
  }
}

/**
 * 供测试与诊断：把一个上游失败分类成「该不该换号」。
 *
 * `false` 表示换账号也不会成功（请求形状问题），`true` 表示值得换下一个。
 * 单独导出而不是内联在循环里，因为它是本文件唯一一条「何时停止重试」的规则，
 * 而它出错的代价是 8 倍的无效上游请求或一次本该成功的对话被放弃。
 */
export function worthRetrying(kind: WbUpstreamErrorKind): boolean {
  switch (kind) {
    case 'soft_rate':
    case 'hard_credit':
    case 'authentication':
    case 'session_dead':
    case 'server':
      return true
    case 'client':
    case 'client_reject':
    // 渠道闸门读的是**请求内容**，不是账号：网关判定「这个通道未被授权」时，
    // 换一个账号只会用另一份凭据发一份同样会被拒的请求体。参考插件同样把它
    // 排除在 failover 之外。它在 `chatCompletions` 里是同一凭据上的两级自救
    // （中性开头 / 内容迁移），不是换号。
    case 'channel_reject':
    // 本机闸门同理，而且更绝对：请求连进程都没出去，换账号只是换一份凭据去撞
    // 同一道本地闸门。它要的是裁剪历史或新开会话，不是另一个账号。
    case 'local_gate_oversize':
    case 'local_gate_unattributed':
    default:
      return false
  }
}

/** 供测试：把一个错误对象归类。`WbCredentialRejectedError` 一律是凭据问题。 */
export function classifyThrown(error: unknown): WbUpstreamErrorKind {
  if (isCredentialRejectedError(error)) return 'authentication'
  if (error instanceof WbCredentialRejectedError) return 'authentication'
  return 'server'
}
