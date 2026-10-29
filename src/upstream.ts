/**
 * WorkBuddy 上游 HTTP 客户端：纯传输 + 解析，**不持有 logger、不读 cordis 上下文**。
 *
 * 每个端点、每个 header、每个字段名都是回源核对的（不是凭记忆写的）：
 * 出处 `plugins/dsh-connect-workbuddy/src/upstream.ts`（4.15.1）。核对的锚点：
 * - 基址常量 `:334-336`（CN_CHAT_BASE / CN_BILLING_BASE / GLOBAL_BASE）
 * - 两个 User-Agent 的通道机制 `:382-408`（`/v3/config` 按 UA 通道回答不同文档）
 * - header 族 `:900-1000`（chat / refresh / billing 三套，各含 X-No-* 约定）
 * - `parseCreditMultiplier` `:1878`、`parseUpstreamModel` `:1956`、`selectCliModels` `:2018`
 * - `fetchModels` `:2245`、`fetchCheckinStatus` `:2307`、`fetchBenefits` `:2353`、
 *   `claimBenefit` `:2424`、`claimDailyCheckin` `:2438`、`fetchCredits` `:2465`
 *
 * 为什么模块不持 logger：它要能在测试与 CLI 里被直接 import 而不带一个 cordis
 * context。需要上报的降级（CN 目录回退）通过构造参数回调，宿主接
 * `ctx.logger.warn`，没宿主就静默——与参考实现同口径。
 *
 * @module dsh-connect-workbuddy-models/upstream
 */

import { createHash, randomUUID } from 'node:crypto'
import { loadRefreshedCredentials, saveRefreshedCredential } from './account-store.ts'
import { attachPromos, parseWorkBuddyPromos, type WbPromo } from './promo.ts'
import { PLUGIN_ID, type WbBusyLevel, type WbCreditPackage, type WbReasoning, type WbRegion } from './status-paths.ts'

// ── 凭据 ──────────────────────────────────────────────────────────────────

/**
 * 一份解析好的 WorkBuddy 凭据。
 *
 * 字段名与来源对齐 `plugins/dsh-workbuddy-xdpool/src/accounts.ts:62-100` 的
 * `WorkBuddyCredential`；本插件只做只读发现，所以**不含**任何写回桌面端的能力。
 */
export interface WbCredential {
  accessToken: string
  refreshToken: string
  /** 凭据到期时刻（ms）；0 表示文件里没有该字段。 */
  expiresAtMs: number
  refreshExpiresAtMs?: number
  /**
   * 上游自己记录的签发时刻（`auth.lastRefreshTime`）。
   *
   * 这是**唯一可信的新鲜度信号**，不是 `expiresAtMs`：上游吊销 token 时不会改写
   * 已存的到期时间，于是一份早已死掉的备份可以声称比真正可用的 token 到期更晚。
   * 按到期时间选号会让每次上游调用都 401，而同一个目录里明明躺着一份好凭据。
   */
  lastRefreshAtMs?: number
  nickname?: string
  /** 计费身份，重新登录后不变；账号 id 优先取它。 */
  uin?: string
  uid?: string
  enterpriseId?: string
  /** 上游域名，用于判定区域。空串 = 未知（按国内处理）。 */
  domain: string
  /** 凭据文件路径。只读诊断用，响应里绝不下发。 */
  sourcePath: string
}

/**
 * 稳定的账号 id：`uin` 是上游计费的身份，重新登录后不变；回退 `uid`。
 *
 * 定义在凭据类型旁边而不是 `accounts.ts` 里，因为**写入侧也要用它**：刷新后的
 * token 要按账号落盘（`account-store.ts` 的 `credential-refresh.json`），而写
 * 发生在 `chatStream` 内部、读发生在账号发现里。两处各抄一份 sha256 公式，改前
 * 缀或改截断时只改一处，读写两侧就会永久性地互相找不到对方写的记录——故障形态
 * 是「刷新成功了但重启后又失效」，且任何单侧测试都是绿的。
 *
 * 用 `uin` 优先而不是文件名：多份快照是**同一个**账号的不同时刻，它们必须折叠成
 * 一个池成员，否则池里「4 个账号」其实是 2 个人，选号与积分合计都会翻倍。
 */
export function workbuddyAccountId(credential: Pick<WbCredential, 'uin' | 'uid' | 'nickname'>): string {
  const stable = credential.uin ?? credential.uid ?? credential.nickname ?? 'unknown'
  return createHash('sha256').update(`workbuddy\0${stable}`).digest('hex').slice(0, 16)
}

// ── 错误分类 ──────────────────────────────────────────────────────────────

/**
 * 上游失败的种类。
 *
 * 只保留本插件会**分支**的种类：每一类都对应一句不同的用户可执行建议，没有
 * 分支的种类留在这里只会让每种失败都退化成同一句话。
 */
export type WbUpstreamErrorKind =
  /** 402 / 余额耗尽：换号有意义，重试无意义。 */
  | 'hard_credit'
  /** 429 / 限流：等一会儿，或换号。 */
  | 'soft_rate'
  /** 401/403：凭据本身被拒，等没用，必须重新登录。 */
  | 'authentication'
  /** 会话/登录态失效（上游业务码），与上者的区别是可能靠 refresh 恢复。 */
  | 'session_dead'
  /** 内容/渠道拒绝：请求本身被拒，换号不会有帮助。 */
  | 'client_reject'
  /**
   * 渠道闸门（业务码 11128 家族里「未授权通道」那一支）：网关按**请求内容**判定
   * 通道，换账号、换区域都不改变结论。
   *
   * 为什么必须与 {@link WbUpstreamErrorKind} 的 `client_reject` 分开：这一支是
   * 11128 家族里唯一**可以自愈**的。请求被拒是因为 system 开场白被当成第三方
   * agent 的指纹，把开场白换成中性占位、或在句子边界插不可见字符破坏精确子串
   * 匹配，同一个账号同一个模型就能过（实测：只加一行 `You are a helpful
   * assistant.` 就从 400 变 200）。压成 `client_reject` 的话，调用方拿到的结论
   * 是「请求形状有问题，别换了」，于是唯一那条能救回来的路也一并关掉。
   *
   * 两者都**不值得换号**，区别只在「要不要先自救一次」。换号规则仍由
   * `worthRetrying` 统一回答 false。
   */
  | 'channel_reject'
  /**
   * 本机 billion-context 的本地闸门拒绝了请求，**请求根本没到 WorkBuddy 上游**。
   *
   * 两支的成因不同，所以不合并：
   * - `local_gate_unattributed`：这次请求没有归属到任何受管会话，而请求体本身可证明
   *   超过 1,000,000 token —— 塞给上游也只会被拒，每一次重试都重发同一份超长历史；
   * - `local_gate_oversize`：闸门查询会话归属时抛了错（agent 作用域已释放/正在关闭），
   *   超长历史折叠不进模型窗口，作用域恢复前同一次调用会一直失败。
   *
   * 为什么必须与 {@link WbUpstreamErrorKind} 的 `client` 分开：`client` 的处置建议是
   * 「按上面的提示调整参数」，而这支的处置是**裁剪历史或新开会话**，两者不可互换。
   * 更要紧的是 `client` 那句附带「换账号也不会改变结果」在本支属于纯误导 —— 用户会
   * 去换账号、换模型，而唯一能解决的三件事（接入受管会话 / 裁掉超大内容 / 新开会话）
   * 一件都没被说出来。闸门给的 `error.code`、`error.message`、`error.retryable` 是它
   * 自己写的可执行建议，必须原样透出而不是压成一句通用话。
   *
   * 也别指望状态码能区分：两支都是 422，而 422 在这套分类里原本落到 `client`，
   * 对外还会被 `KIND_STATUS` 再压成 400 —— 用户看到的 400 与「参数写错了」完全同形。
   */
  | 'local_gate_oversize'
  /** 同上，未归属那一支（`bili_gate_oversize_refusal_unattributed`）。 */
  | 'local_gate_unattributed'
  /** 其余 4xx：请求形态问题。 */
  | 'client'
  /** 5xx / 传输失败：上游坏了。 */
  | 'server'

/** 上游拒绝凭据。独立的错误类，让调用方能给出「请重新登录」而不是 HTTP 码。 */
export class WbCredentialRejectedError extends Error {
  readonly code = 'WB_CREDENTIAL_REJECTED'
  readonly status: number

  constructor(status: number, detail = '') {
    super(
      `workbuddy: 上游拒绝了这份登录凭据（http ${status}）。`
      + '最可能的原因是选中了一份更早登录留下的历史快照。请重新登录 WorkBuddy 桌面端后重新选择账号。'
      + (detail === '' ? '' : ` 上游原文：${detail}`),
    )
    this.name = 'WbCredentialRejectedError'
    this.status = status
  }
}

/** 判断一个错误是否是「上游拒绝凭据」；按 code 判定，跨 bundle 安全。 */
export function isCredentialRejectedError(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && (value as { code?: unknown }).code === 'WB_CREDENTIAL_REJECTED'
}

const HARD_CREDIT_MARKERS: readonly string[] = ['insufficient credit', 'credits exhausted', 'quota exceeded']
/** 上游把「余额花光」也编成业务码；实测 14018 的 body 写的是 `Credits exhausted.`。 */
const CREDITS_EXHAUSTED_CODE = '14018'

/**
 * 这个 body 是不是「未授权通道」那一支的 11128。
 *
 * **必须匹配带引号的键形式** `"code":11128`，不能用裸 `11128`。业务码在响应体里
 * 只以 JSON 成员出现，而裸数字会被无关字段里一段十六进制命中：实测上游的
 * `requestId` 形如 `9f4e685b-e16d-4693-b2a6-7863e832f885`，其中 `11128` 这种
 * 短串出现的概率并不低。一次巧合命中会把一次网络错误升级成「渠道闸门」，
 * 进而触发两条注定失败的自救请求——用更贵的代价把一条红鲱鱼写成诊断。
 *
 * 11128 家族有三支（同源实测）：未授权通道、`conversation id missing`、首条不是
 * system 提示词。只有第一支归这里；后两支归 `client_reject`，因为它们的修法
 * 是改请求形状（本插件已在 {@link prepareChatBody} 里修掉），不是改写开场白。
 */
export function isChannelGateFamilyBody(body: string): boolean {
  return body.includes('"code":11128')
}

/**
 * 本机 billion-context 闸门的两支 422 的业务码。
 *
 * 注意 `..._unattributed` 把另一个码**整个包含**进去，所以判断顺序必须是长的在前
 * —— 反过来会让「未归属」那一支永远认成「归属查询抛错」，而两者的处置完全不同
 * （前者裁剪内容就能过，后者要重启宿主）。
 */
const LOCAL_GATE_UNATTRIBUTED_CODE = 'bili_gate_oversize_refusal_unattributed'
const LOCAL_GATE_OVERSIZE_CODE = 'bili_gate_oversize_refusal'

/**
 * 闸门原文的开场白。Anthropic 形状（`/messages`）的拒绝体里**只有 message 没有
 * code**，所以光靠业务码认不全；这句开场白是两种形状共有的。
 */
const LOCAL_GATE_BRAND = 'billion-context refused this request locally'

/** 两支各自的判别句（同 `LOCAL_GATE_BRAND`，用于缺 code 的形状）。 */
const LOCAL_GATE_UNATTRIBUTED_MARK = 'not attributed to any bili-managed session'
const LOCAL_GATE_OVERSIZE_MARK = 'attribution lookup threw'

/** 本机闸门的两个分支。 */
export type WbLocalGateKind = 'local_gate_oversize' | 'local_gate_unattributed'

/**
 * 这个 body 是不是本机闸门的拒绝，是的话是哪一支。
 *
 * **刻意不看状态码**：两支都是 422，而 422 在别处也可能出现；反过来，同一份 body
 * 被包成 400、500 或 200 都不改变「这是本机闸门拒绝、请求没到上游」这个事实，
 * 而整条处置建议都建立在那个事实上。按状态码分流会让一次中间层改写就把结论打断。
 *
 * 三个判据从强到弱：业务码 → 分支判别句 → 开场白。开场白单独出现时按未归属那一支
 * 处理：它的处置建议更保守（裁剪内容），对另一支也基本适用。
 */
export function localGateKindOf(body: string): WbLocalGateKind | undefined {
  const branded = body.includes(LOCAL_GATE_BRAND)
  if (!branded && !body.includes(LOCAL_GATE_UNATTRIBUTED_CODE) && !body.includes(LOCAL_GATE_OVERSIZE_CODE)) {
    return undefined
  }
  if (body.includes(LOCAL_GATE_UNATTRIBUTED_CODE) || body.includes(LOCAL_GATE_UNATTRIBUTED_MARK)) {
    return 'local_gate_unattributed'
  }
  if (body.includes(LOCAL_GATE_OVERSIZE_CODE) || body.includes(LOCAL_GATE_OVERSIZE_MARK)) {
    return 'local_gate_oversize'
  }
  return 'local_gate_unattributed'
}

/**
 * 把一个 HTTP 失败归类。
 *
 * 顺序是有理由的：先按**状态码**给出确定答案（402 就是钱的问题），再看 body 里
 * 的标记；`CREDITS_EXHAUSTED_CODE` 排在软限流之前，因为同时带「耗尽」与「节流」
 * 两种码的 body 应当给出可执行的那个结论（去充值/换号），而不是「等一会儿」。
 */
export function classifyUpstreamError(status: number, body: string): WbUpstreamErrorKind {
  // 本机闸门的判断排在最前：它描述的是一次**没有离开本进程**的拒绝，与上游状态码
  // 无关。放在后面会被 `status >= 500` 抢先（闸门在某些中间层里会被包成 5xx），
  // 那时用户拿到的结论是「上游坏了，等一等」，而实际要动的是历史长度。
  const localGate = localGateKindOf(body)
  if (localGate !== undefined) return localGate
  if (status === 401 || status === 403) return 'authentication'
  if (status === 402) return 'hard_credit'
  const lower = body.toLowerCase()
  for (const marker of HARD_CREDIT_MARKERS) {
    if (lower.includes(marker)) return 'hard_credit'
  }
  if (body.includes(CREDITS_EXHAUSTED_CODE)) return 'hard_credit'
  if (status === 429) return 'soft_rate'
  // 顺序有理由：`conversation id missing` 排在渠道闸门**之前**。两者同属 11128
  // 家族，理论上互斥，但如果上游哪天把两个理由写进同一个 body，本条是已经修好的
  // 那一支（`prepareChatBody` 会补 conversation id），应当先认出它；否则它会
  // 被当成渠道闸门、触发两条注定失败的自救请求，而真正的修法一个字都没被用上。
  if (lower.includes('conversation id missing')) return 'client_reject'
  if (isChannelGateFamilyBody(body)) return 'channel_reject'
  if (lower.includes('session') && (lower.includes('expired') || lower.includes('invalid'))) return 'session_dead'
  if (status >= 500) return 'server'
  return 'client'
}

// ── 区域与基址 ────────────────────────────────────────────────────────────

const CN_CHAT_BASE = 'https://copilot.tencent.com'
const CN_BILLING_BASE = 'https://www.codebuddy.cn'
const GLOBAL_BASE = 'https://www.workbuddy.ai'

/**
 * 旧版模型目录路径，**只作国内区域的兜底**。
 *
 * 这是 WorkBuddy *插件* 当年读的文档，不是 WorkBuddy *应用* 读的文档：网关用它
 * 回答 CLI 通道的名册，既没有应用的 `auto` 槽也没有促销 feed。保留它只为「网关
 * 哪天不再供应新文档时降级，而不是让整个区域没有模型」。
 */
const MODELS_CATALOG_PATH = '/v2/enterprises/personal/models'

/**
 * 产品配置路径——应用自己读的那份文档（模型名册 + 价格 + 促销徽标）。
 *
 * 字段与旧路径对 `parseUpstreamModel` 读的每个键都兼容，所以一个解析器服务两者。
 */
const GLOBAL_CONFIG_PATH = '/v3/config'

/** 聊天通道的 UA：插件在对话时**就是** CLI agent，计费与限流都按这个身份。 */
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

/**
 * 产品配置通道的 UA：WorkBuddy 应用自己的产品身份。
 *
 * 为什么必须区分：`/v3/config` **按 UA 声称的通道**回答不同文档。实测（同一
 * token、同一 URL，只改这一个 header，国内网关）：
 *
 * | User-Agent                                    | 答案                          |
 * | ---                                           | ---                           |
 * | `CLI/2.63.2 CodeBuddy/2.63.2`（CLI 通道）      | 5 键 / 35 模型 / **无**促销 feed |
 * | `WorkBuddy/5.8.3`（应用通道，无 CLI 段）        | 18 键 / 37 模型 / 无促销 feed   |
 * | `WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0` | 22 键 / 62 模型 / 8 促销 + 1 档 |
 *
 * 版本后缀是惰性的（`WorkBuddy/1.0.0 …` 答案相同），起作用的是通道，不是版本。
 */
const PRODUCT_UA = 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0'

const JSON_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 4096

/**
 * 登录域名 → 区域。
 *
 * 国际产品在**两个**品牌域名下可达：WorkBuddy AI 桌面端登录在 `workbuddy.ai`，
 * CodeBuddy CLI 把同一个国际账号登录在 `codebuddy.ai`。两者背后是同一套网关。
 * 漏掉 `codebuddy.ai` 会把那些 token 发到国内网关，被 openresty 层以 HTML 401
 * 拒绝——看起来像「凭据坏了」。
 */
export function regionOf(domain: string): WbRegion {
  const lowered = domain.trim().toLowerCase()
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global'
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return 'global'
  return 'cn'
}

/**
 * 国际网关基址。
 *
 * 国际账号**不能跨品牌域名互换**：在 `codebuddy.ai` 签发的 token 会被
 * `workbuddy.ai` 网关拒绝（反之亦然），所以基址必须跟着凭据自己的域名走。
 */
export function globalBase(domain: string): string {
  const lowered = domain.trim().toLowerCase()
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return 'https://www.codebuddy.ai'
  return GLOBAL_BASE
}

function chatBase(credential: WbCredential): string {
  return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_CHAT_BASE
}

function billingBase(credential: WbCredential): string {
  return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_BILLING_BASE
}

function originReferer(credential: WbCredential): string {
  return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_BILLING_BASE
}

// ── header 族 ─────────────────────────────────────────────────────────────

function commonHeaders(credential: WbCredential): Record<string, string> {
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': originReferer(credential),
    'Referer': `${originReferer(credential)}/`,
    'User-Agent': CLIENT_UA,
  }
}

/**
 * 对话身份三元组，聊天端点的第二道闸门。
 *
 * 国际网关在 `system` 开头规则之上又加了一道：聊天请求必须携带官方客户端的
 * 会话身份，否则每一步都被拒（业务码 `11128` / `conversation id missing`）。
 * 三个 id 缺一不可——只带 `X-Conversation-ID` 仍然失败。
 *
 * 网关不校验这三个值从哪来（任何合法 UUID 都过），所以它们**不是秘密、不持久化**，
 * 且每次请求重新生成：复用同一个值等于伪造一段自己并不拥有的会话身份，最先坏掉
 * 的就是上游对「同一个 id 报了两次」的关联。
 *
 * 两个区域都发：国内网关今天容忍它们缺失，一条只在单边发出的 header 正是让上
 * 一次缺陷「只在国际暴露、从国内看不见」的原因。
 */
function conversationHeaders(): Record<string, string> {
  return {
    'X-Conversation-ID': randomUUID(),
    'X-Conversation-Request-ID': randomUUID(),
    'X-Conversation-Message-ID': randomUUID(),
  }
}

function chatHeaders(credential: WbCredential): Record<string, string> {
  return {
    ...commonHeaders(credential),
    'Content-Type': 'application/json',
    // 安全红线：chat 请求绝不携带 refresh token。
    ...credential.uid === undefined || credential.uid === ''
      ? { 'X-No-User-Id': '1' }
      : { 'X-User-Id': credential.uid },
    ...credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': credential.enterpriseId },
    ...credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain },
    'X-Product': 'SaaS',
    ...conversationHeaders(),
  }
}

/** refresh token 只在这里出现，别处一律不出现。 */
function refreshHeaders(credential: WbCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  }
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
  }
  return headers
}

function billingHeaders(credential: WbCredential): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${credential.accessToken}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
  if (credential.uid !== undefined && credential.uid !== '') headers['X-User-Id'] = credential.uid
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
    headers['X-Tenant-Id'] = credential.enterpriseId
  }
  if (credential.domain !== '') headers['X-Domain'] = credential.domain
  return headers
}

// ── 信封解析 ──────────────────────────────────────────────────────────────

interface Envelope {
  code: number
  msg: string
  data: unknown
}

/** 边缘层拒绝（openresty / apisix 的 HTML 401）也属于「凭据被拒」。 */
function isGatewayAuthRejection(status: number, text: string): boolean {
  if (status !== 401 && status !== 403) return false
  const lower = text.toLowerCase()
  return lower.includes('openresty') || lower.includes('apisix') || lower.includes('authorization required')
}

async function readEnvelope(response: Response): Promise<Envelope> {
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    if (isGatewayAuthRejection(response.status, text)) {
      throw new WbCredentialRejectedError(response.status, text.slice(0, 200))
    }
    throw new Error(`workbuddy 上游返回了非 JSON（http ${response.status}）：${text.slice(0, 160)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`workbuddy 上游返回了意外的文档（http ${response.status}）`)
  }
  const document = parsed as Record<string, unknown>
  return {
    code: typeof document['code'] === 'number' ? document['code'] : 0,
    msg: typeof document['msg'] === 'string' ? document['msg'] : '',
    data: 'data' in document ? document['data'] : undefined,
  }
}

/**
 * 业务码非 0 的信封按 HTTP 错误同等对待。
 *
 * 401/403 上的 JSON body 仍然是凭据拒绝：边缘层用业务形状回答，但 token 同样
 * 不可用，所以映射到同一个可执行错误，而不是笼统的「客户端错误」。
 */
function envelopeError(status: number, envelope: Envelope): Error {
  if (status === 401 || status === 403) return new WbCredentialRejectedError(status, envelope.msg.slice(0, 200))
  const kind = classifyUpstreamError(status, envelope.msg)
  return new Error(`workbuddy 上游 ${kind}（http ${status}）：${envelope.msg.slice(0, 160)}`)
}

function dataOf(envelope: Envelope): Record<string, unknown> {
  return typeof envelope.data === 'object' && envelope.data !== null
    ? envelope.data as Record<string, unknown>
    : {}
}

// ── 目录解析 ──────────────────────────────────────────────────────────────

/** 一个上游模型条目（解析后）。 */
export interface WbUpstreamModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  /**
   * 积分倍率。
   *
   * **`undefined ≠ 0`**：上游 CN 的静态 fallback 名册整份没有 `credits` 字段，
   * 把 `undefined` 当 0 会把收费模型显示成「免费」——用户会按免费模型去用，然后
   * 发现积分在掉。所以解析器宁可返回 `undefined`（未知），也绝不补默认值 0。
   */
  creditMultiplier?: number
  supportsImages?: boolean
  description?: string
  supportsToolCall?: boolean
  /**
   * 拥挤度（`/v2/chat/busy` 给的）。
   *
   * `undefined` 表示**没问过**（国际网关没有这个端点，或探测失败降级），与
   * `'unknown'`（问过但上游答了个我们不认识的值）是两件事。两者都不渲染。
   */
  busyLevel?: WbBusyLevel
  /**
   * 点名了这个模型的促销/档位条目（**未解析**，按 priority 降序）。
   *
   * 与 `busyLevel` 一样只是「取数那一刻的快照」，本层不做选择：徽标要对着时钟选，
   * 选择逻辑在 `promo.ts` 的 `selectPromoBadge`。
   */
  promos?: readonly WbPromo[]
  /**
   * 上游宣告的推理档位（两种拼写已归一，见 {@link parseReasoning}）。
   *
   * `undefined` = 上游没给这个字段 = 未知。**绝不补 `{}`**：空对象读起来像「宣告了
   * 零个档位」，而下游（`adapter.ts`）对这两者的处置不同——没宣告就不提供选择器，
   * 宣告了空名单同样不提供，但诊断文案要说清楚是上游没给还是上游给了个空的。
   */
  reasoning?: WbReasoning
}

/**
 * 上游的档位阶梯，从低到高。
 *
 * 与 pi-ai 的 `EXTENDED_THINKING_LEVELS` 同序但不含 `off`：`off` 不是「一档思考」，
 * 而是「不思考」，由 `reasoning.canDisableThinking` 单独表达。
 */
const EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * 上游名册的 `reasoning` 有两种拼写，这里认第二（单数）种。
 *
 * 复数形宣告完整名单：`{ canDisableThinking, defaultEffort, supportedEfforts: [...] }`。
 * 单数形只说它默认落在哪一档：`{ effort: 'high', summary: 'auto' }`——**`summary`
 * 是给用户看的思考摘要开关，与本插件无关，故意不读。**
 *
 * 判据必须是「没有复数形专有字段」而不只是「有 `effort`」：实测上游确实存在
 * `model` 条目同时带 `effort` 与其它字段的组合，只看 `effort` 会把复数形误判成单数。
 */
function isSingularEffortForm(raw: Record<string, unknown>): boolean {
  return typeof raw['effort'] === 'string'
    && !Array.isArray(raw['supportedEfforts'])
    && typeof raw['defaultEffort'] !== 'string'
    && typeof raw['canDisableThinking'] !== 'boolean'
}

/**
 * 把单数形展开成一条阶梯。
 *
 * 单数形只报一个锚点（`effort`），不报全部档位。上游这么写是因为这些模型的档位
 * 是**连续**的：能跑 `high` 的必然能跑比它低的每一档。所以从锚点向上补到阶梯顶。
 *
 * 锚点不认识就**原样单档**返回：猜一个它可能不接受的高档，会让用户选到一个必失败
 * 的选项；只给一个确定的档位是保守且诚实的。
 */
function singularEffortLadder(effort: string): readonly string[] {
  const index = EFFORT_LADDER.indexOf(effort as (typeof EFFORT_LADDER)[number])
  if (index < 0) return [effort]
  return EFFORT_LADDER.slice(0, index + 1)
}

/**
 * 解析 `reasoning` 字段，把两种拼写折叠成一种形状。
 *
 * 三个字段全都没给时返回 `undefined`（上游没宣告）而不是 `{}`：空对象会被下游读成
 * 「宣告了零个档位」，而「没宣告」与「宣告了空」在诊断上是两件不同的事。
 */
export function parseReasoning(value: unknown): WbReasoning | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const supportedEfforts = Array.isArray(raw['supportedEfforts'])
    ? raw['supportedEfforts'].filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    : undefined
  const defaultEffort = typeof raw['defaultEffort'] === 'string' && raw['defaultEffort'] !== ''
    ? raw['defaultEffort']
    : undefined
  const canDisableThinking = typeof raw['canDisableThinking'] === 'boolean' ? raw['canDisableThinking'] : undefined
  if (isSingularEffortForm(raw)) {
    // 单数形没有 `canDisableThinking`，但**它是一个可关闭的宣告**：上游用单数形
    // 描述的都是「默认思考、可关」的模型（实测 hy3 / deepseek-v4-flash / v4-pro
    // 三档全部接受 `reasoning_effort: "off"`）。所以这里补 `true` 而不是留空。
    return { supportedEfforts: singularEffortLadder(raw['effort'] as string), canDisableThinking: true }
  }
  if (supportedEfforts === undefined && defaultEffort === undefined && canDisableThinking === undefined) {
    return undefined
  }
  return {
    ...supportedEfforts === undefined ? {} : { supportedEfforts },
    ...defaultEffort === undefined ? {} : { defaultEffort },
    ...canDisableThinking === undefined ? {} : { canDisableThinking },
  }
}

/**
 * 解析 `credits` 字段（形如 `'x0.00'` / `'x3.31'`）。
 *
 * 只认字符串：上游把倍率编成带 `x` 前缀的字符串，数字形状在实践中没出现过。
 * 非字符串一律 `undefined`（未知），不猜。
 */
export function parseCreditMultiplier(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = /x\s*([0-9]*\.?[0-9]+)/iu.exec(value)
  if (match === null) return undefined
  const parsed = Number(match[1])
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 * 解析一个目录条目；没有可用 token 限额的条目直接丢弃。
 *
 * 丢弃而不是补默认值：`contextWindow` 是 DSH 派发前的压缩依据，编一个数字会
 * 让 DSH 按错误的窗口决定截断多少历史。
 */
export function parseUpstreamModel(value: unknown): WbUpstreamModel | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const id = typeof raw['id'] === 'string' ? raw['id'] : ''
  if (id === '' || raw['disabled'] === true) return undefined
  const input = typeof raw['maxInputTokens'] === 'number' ? raw['maxInputTokens'] : 0
  const output = typeof raw['maxOutputTokens'] === 'number' ? raw['maxOutputTokens'] : 0
  if (input <= 0 || output <= 0) return undefined
  const name = typeof raw['name'] === 'string' && raw['name'] !== '' ? raw['name'] : id
  const creditMultiplier = parseCreditMultiplier(raw['credits'])
  const supportsImages = raw['disabledMultimodal'] === true
    ? false
    : typeof raw['supportsImages'] === 'boolean' ? raw['supportsImages'] : undefined
  const descriptionZh = typeof raw['descriptionZh'] === 'string' && raw['descriptionZh'] !== ''
    ? raw['descriptionZh']
    : undefined
  const reasoning = parseReasoning(raw['reasoning'])
  return {
    id,
    name,
    contextWindow: input,
    maxTokens: output,
    ...creditMultiplier === undefined ? {} : { creditMultiplier },
    ...supportsImages === undefined ? {} : { supportsImages },
    ...descriptionZh === undefined ? {} : { description: descriptionZh },
    ...typeof raw['supportsToolCall'] === 'boolean' ? { supportsToolCall: raw['supportsToolCall'] } : {},
    ...reasoning === undefined ? {} : { reasoning },
  }
}

/**
 * 路由条目不是模型。
 *
 * 上游名册里混着 `auto`（国内）这类条目，它们是**路由决策**：网关按请求自行
 * 决定落到哪个模型，价格、窗口、行为全是请求时由别人定的。当模型列出来等于在
 * 宣传一个本插件无法说明条款的东西。显式表而不是启发式：靠名字猜，迟早会藏起
 * 一个真模型。
 */
export const ROUTER_MODEL_IDS: ReadonlySet<string> = new Set(['auto'])

/**
 * 从目录形状的文档里挑出可对话的模型。
 *
 * 两种文档（国内个人模型文档、国际 `/v3/config`）都带 `models` 与一个 `agents`
 * 名册，同条目形状，所以一个选择器服务两者。没有可用 `cli` 名册时放出整份解析
 * 结果而不是空：名册是上游细节，空答案会让 provider 静默失效。
 *
 * `keepIds` 是用户自己的选择随刷新一起带过来。上游名册可能撤掉用户正在用的模型
 * （实测：app 通道的 `cli` 名册撤掉了 `minimax-m2.7`，而**同一份文档**仍在发布
 * 它、聊天端点仍答 200）。所以名册 = 上游名册 + 这份文档仍列出的 keepIds：刷新
 * 可以增删上游模型，但绝不静默撤掉用户正在用的模型。
 */
export function selectCliModels(
  rawModels: unknown,
  agents: unknown,
  keepIds: readonly string[] = [],
): WbUpstreamModel[] {
  const byId = new Map<string, WbUpstreamModel>()
  for (const model of Array.isArray(rawModels) ? rawModels : []) {
    const parsed = parseUpstreamModel(model)
    if (parsed !== undefined) byId.set(parsed.id, parsed)
  }
  let cliIds: readonly string[] | undefined
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (typeof agent === 'object' && agent !== null) {
      const wrapped = agent as Record<string, unknown>
      if (wrapped['name'] === 'cli' && Array.isArray(wrapped['models'])) {
        cliIds = wrapped['models'].filter((id): id is string => typeof id === 'string')
        break
      }
    }
  }
  const ids = cliIds !== undefined && cliIds.length > 0 ? cliIds : [...byId.keys()]
  const models = ids
    .filter(id => !ROUTER_MODEL_IDS.has(id))
    .map(id => byId.get(id))
    .filter((model): model is WbUpstreamModel => model !== undefined)
  const kept = keepIds
    .filter(id => !ids.includes(id))
    .map(id => byId.get(id))
    .filter((model): model is WbUpstreamModel => model !== undefined)
  // 守住**答案**而不是上游那一半：整份名册都是路由条目时，keptIds 仍能让区域
  // 可用；在合并 kept 之前抛错会把「上游改了路由条目」变成「这个区域没有模型」。
  const resolved = [...models, ...kept]
  if (resolved.length === 0) throw new Error('workbuddy 模型目录解析结果为空')
  return resolved
}

/**
 * 把同一份文档里的促销/档位条目挂到名册上。
 *
 * 两个数组（`modelPromotions` / `modelTiers`）与 `models`/`agents` **在同一个
 * `/v3/config` 响应里**，所以这一步零额外请求。它们**只有应用通道（`PRODUCT_UA`）
 * 才发布**：`CLI_UA` 打同一个 URL 回来的文档里这两个键是 `undefined`（实测 CN
 * `[CLI] 200 keys=5 models=34 promos=undefined` vs `[PRODUCT] 200 keys=22 models=61
 * promos=8 tiers=1`）。本插件读目录一直用 `PRODUCT_UA`，因此本来就拿得到 —— 这是
 * 「不用改请求头、不用加端点」的事实依据。
 *
 * 解析失败或一个条目都没有时**原样返回**：促销是装饰，不能让它决定名册能不能用。
 */
function withPromos(
  models: readonly WbUpstreamModel[],
  data: Record<string, unknown>,
): WbUpstreamModel[] {
  const promos = parseWorkBuddyPromos(data['modelPromotions'], data['modelTiers'])
  if (promos.length === 0) return [...models]
  return attachPromos(models, promos)
}

// ── 上游错误信封 ──────────────────────────────────────────────────────────

/**
 * 上游 400 信封里**给用户看的那部分**。
 *
 * 为什么需要单独解析：`chat()` 失败时 `message` 带的是上游原始 body 全文（最多
 * 4096 字符），前 400 字符恰好是 `code`/`requestId`/`extError` 的 JSON 骨架
 * （`"param":""`、`"Request":null`…）。直接截断送给用户，等于把唯一一句可执行的
 * 建议（`displayTips`）切在句子中间，而用户读到的是一个 `{` 开头的信封。
 *
 * 字段名与语义照抄参考实现
 * （`plugins/dsh-connect-workbuddy/src/upstream.ts:1273-1306`），因为两边面对的是
 * 同一份上游协议；改名的代价是下次对照取证时要重新翻译一遍。
 */
export interface WbUpstreamErrorDetail {
  /** 上游业务码（这里出现的典型值是 11133 = 参数被拒）。 */
  upstreamCode?: number
  /** 上游请求 id，报障时唯一能对上他们日志的东西。 */
  requestId?: string
  /** 上游 `msg`（英文短句，通常是 `the request parameters were rejected…`）。 */
  rawMsg?: string
  /** `displayMsg` 的中文（或英文）版：一句短结论。 */
  displayMsg?: string
  /** `displayTips` 的中文（或英文）版：一句可执行的建议。 */
  tips?: string
  /** `extError.param`：哪个参数被拒（空串不记，空串等于没说）。 */
  rejectedParam?: string
  /** `extError.value`：该参数被拒时用的值（`off` 之类）。 */
  rejectedTier?: string
  /**
   * 本机闸门把它自己的业务码写在 `error.code` 里（字符串，如
   * `bili_gate_oversize_refusal_unattributed`），不是顶层数字 `code`。
   *
   * 单独一个字段而不是塞进 `upstreamCode`：后者是 number 且语义是「上游业务码」，
   * 而这串是**本机中间件**的标识，混在一起会让「这是谁拒的」这个判断在类型层面
   * 就丢失了。
   */
  localGateCode?: string
  /** `error.retryable`：闸门自己声明的可重试性（两支都是 `false`）。 */
  retryable?: boolean
}

/**
 * 读一个「可能是字符串、也可能是 `{zh,en}` 对象」的文案字段。
 *
 * 上游两种形态都出现过：`displayMsg` 在部分信封里是纯字符串，在另一些里是
 * `{en,zh}`。只认一种就会在另一半信封上静默丢掉那句建议 —— 而丢掉之后的表现是
 * 「回复里又变成裸 JSON」，看起来像没修。
 */
function localizedText(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const zh = raw['zh']
  if (typeof zh === 'string' && zh !== '') return zh
  const en = raw['en']
  if (typeof en === 'string' && en !== '') return en
  return undefined
}

/**
 * 解析上游错误信封；不是 JSON 对象就返回 `undefined`。
 *
 * 逐字段独立判断是刻意的：任何一个字段畸形都只丢它自己，不能让整份 detail 变
 * `undefined`。上游改一个字段的形状（例如 `code` 从数字变字符串）不应该把
 * `tips` 一起带走 —— 那正是用户最需要的那句。
 */
export function parseUpstreamErrorDetail(body: string): WbUpstreamErrorDetail | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const raw = parsed as Record<string, unknown>
  const detail: WbUpstreamErrorDetail = {}
  if (typeof raw['code'] === 'number') detail.upstreamCode = raw['code']
  if (typeof raw['requestId'] === 'string' && raw['requestId'] !== '') detail.requestId = raw['requestId']
  if (typeof raw['msg'] === 'string' && raw['msg'] !== '') detail.rawMsg = raw['msg']
  const displayMsg = localizedText(raw['displayMsg']) ?? localizedText(raw['msg'])
  if (displayMsg !== undefined) detail.displayMsg = displayMsg
  const tips = localizedText(raw['displayTips'])
  if (tips !== undefined) detail.tips = tips
  const ext = raw['extError']
  if (typeof ext === 'object' && ext !== null && !Array.isArray(ext)) {
    const extRaw = ext as Record<string, unknown>
    const param = extRaw['param']
    if (typeof param === 'string' && param !== '') detail.rejectedParam = param
    const value = extRaw['value']
    if (typeof value === 'string' && value !== '') detail.rejectedTier = value
  }
  // 本机闸门把码与可重试性放在 `error` 那层（`{"error":{"type","code","message","retryable"}}`）。
  // 不在这里下探的话，它的拒绝会解析出空 detail —— 于是调用方只能退回原始 body，
  // 用户看到的就是那段被截断的裸 JSON，而闸门自己写的三条建议全丢。
  const error = raw['error']
  if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
    const errorRaw = error as Record<string, unknown>
    const gateCode = errorRaw['code']
    if (typeof gateCode === 'string' && gateCode !== '') detail.localGateCode = gateCode
    if (typeof errorRaw['retryable'] === 'boolean') detail.retryable = errorRaw['retryable']
    // `error` 层也带 message；只有在顶层没人话时才采用它，否则同一句话会被算两遍
    // （顶层的 `msg` 更短，通常更适合当结论）。
    const errorMessage = localizedText(errorRaw['message'])
    if (detail.displayMsg === undefined && errorMessage !== undefined) detail.displayMsg = errorMessage
  }
  return detail
}

// ── 模型拥挤度 ────────────────────────────────────────────────────────────

// 六态的定义在 `status-paths.ts`（浏览器半区也 import 的共享契约模块）：本文件拖得
// 动 `node:crypto` 与账号发现，反方向的类型依赖会让浏览器那一侧的 tsc 去编译整个宿主
// 链路。这里重新导出，既有 `from './upstream.ts'` 的 import 路径继续成立。
export type { WbBusyLevel }

/** 六态全集，顺序即从空闲到不可用。 */
export const WB_BUSY_LEVELS: readonly WbBusyLevel[] = ['idle', 'normal', 'busy', 'congested', 'unavailable', 'unknown']

/**
 * 一次 `/v2/chat/busy` 最多问多少个模型。
 *
 * app bundle 里同一个数是 50（`PAt=50`）。CN 名册有 20-62 个模型，超过它就必须
 * 分批而不是截断 —— 截断会让后半个名册永远显示不出拥挤度，而用户看不出为什么。
 */
export const WORKBUDDY_BUSY_BATCH_SIZE = 50

/** 拥挤度端点。 */
export const MODEL_BUSY_PATH = '/v2/chat/busy'

/**
 * 拥挤度探测超时。
 *
 * app 自己的 `useModelBusyLevels` 用 `timeout: 5e3`。挤青年度是**装饰性**信息：
 * 为了它把模型名册刷新拖慢十秒，等于让一个可选提示决定插件能不能用。
 */
export const MODEL_BUSY_TIMEOUT_MS = 5_000

/** 把上游那个字符串收进六态；越界一律 `unknown`（丢弃等于丢掉「问过了但没答案」）。 */
export function normalizeBusyLevel(value: unknown): WbBusyLevel {
  if (typeof value !== 'string') return 'unknown'
  return (WB_BUSY_LEVELS as readonly string[]).includes(value) ? value as WbBusyLevel : 'unknown'
}

/**
 * 解析 `/v2/chat/busy` 的 `data`。
 *
 * 非对象条目与没有 `model` 字段的条目跳过（它们不指向任何模型，收下来也无处安放）；
 * **值**越界则记 `unknown` 而不是跳过 —— 后者会让那个模型在我们的名册里显示成
 * 「没问过」，与「问过但它答了个新值」混为一谈。
 */
export function parseBusyLevels(entries: unknown): Map<string, WbBusyLevel> {
  const levels = new Map<string, WbBusyLevel>()
  if (!Array.isArray(entries)) return levels
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const raw = entry as Record<string, unknown>
    const id = typeof raw['model'] === 'string' ? raw['model'] : ''
    if (id === '') continue
    levels.set(id, normalizeBusyLevel(raw['busy_level']))
  }
  return levels
}

/**
 * 把 id 列表切成批次：**先按首次出现去重、再切**。
 *
 * 去重不是洁癖：模型名册 = cli agent 名册 + 用户保留的 id，同一个 id 合法地出现两次，
 * 而上游按「被问的数量」计配额。保序是为了让日志里的批次顺序与名册一致。
 */
export function batchModelIds(ids: readonly string[], size: number = WORKBUDDY_BUSY_BATCH_SIZE): string[][] {
  const unique = [...new Set(ids.filter(id => id !== ''))]
  const limit = size > 0 ? size : WORKBUDDY_BUSY_BATCH_SIZE
  const batches: string[][] = []
  for (let index = 0; index < unique.length; index += limit) batches.push(unique.slice(index, index + limit))
  return batches
}

/**
 * 每个等级在模型名后面跟的符号。
 *
 * 用符号而不是文字，是因为它要把等级带过 `src/catalog.ts` 的 `toModelInfo()` ——
 * 那个投影只搬运 `id`/`name`/`contextWindow`/`maxTokens`/`creditMultiplier`/
 * `supportsImages`/`description`，而 `WbModelInfo` 上没有拥挤度字段、该类型所在的
 * `src/status-paths.ts` 也不在本任务的改动范围内。`name` 是唯一能原样到达界面的
 * 字段（DSH 原样渲染它，参考实现的 `busyDisplaySuffix` 也是这么做的）。
 */
const BUSY_SYMBOLS: Readonly<Record<WbBusyLevel, string>> = {
  idle: '🚀',
  normal: '🧍',
  busy: '🧍🧍',
  congested: '🧍🧍🧍',
  unavailable: '🚫',
  unknown: '',
}

/**
 * 需要画出来的等级：**唯独排除 `unknown`**。
 *
 * 两条理由：每行都挂一个标记会让标记退化成装饰，用户学会忽略它；而 `unknown` 更
 * 不该画 —— 那是「本插件没问到」，画出来就是替上游声称了一个它没说过的事实。
 */
const DRAWN_IN_PICKER: ReadonlySet<WbBusyLevel> = new Set(['idle', 'busy', 'congested', 'unavailable'])

/** 该等级对应的符号；`unknown`/`undefined` 一律空串（调用方据此不渲染）。 */
export function busySymbol(level: WbBusyLevel | undefined): string {
  if (level === undefined || !DRAWN_IN_PICKER.has(level)) return ''
  return BUSY_SYMBOLS[level]
}

/**
 * 把等级挂到名册条目上（**复制不改写**）。
 *
 * 名册条目与设置卡片保存的快照是同一批对象；就地改 `name` 会让「刷新一次」与
 * 「刷新两次」得到不同的名字，而用户看到的是名字越来越长。
 */
export function attachBusyLevels(
  models: readonly WbUpstreamModel[],
  levels: ReadonlyMap<string, WbBusyLevel>,
): WbUpstreamModel[] {
  return models.map(model => {
    const level = levels.get(model.id)
    if (level === undefined || level === model.busyLevel) return model
    return { ...model, busyLevel: level }
  })
}

/**
 * 把拥挤度写进 `name` 的那一个后缀。
 *
 * 返回空串表示「不加」——`undefined` 与 `unknown` 都走这里，所以名册里没问过拥挤度
 * 的模型名字逐字节不变。
 */
export function busyDisplaySuffix(level: WbBusyLevel | undefined): string {
  const symbol = busySymbol(level)
  return symbol === '' ? '' : ` ${symbol}`
}

// ── 聊天结果 ──────────────────────────────────────────────────────────────

/**
 * 一次聊天请求的结果：要么是活的 SSE，要么是已归类的失败。
 *
 * `retryable` 是**池级策略**信号，只在上游客户端自己没能把凭据救回来时置位：它回答
 * 「这份凭据还有没有救」。`kind` 回答的是另一个问题——「这次请求为什么失败」。
 *
 * 两者必须分开，因为它们曾经共用一个字段：刷新时网络抖一下也报
 * `kind: 'authentication'`，而 shim 见 `authentication` 就把账号标成凭据已死，
 * 且判死之后没有任何恢复路径（要重启 DSH 才回到池里）——一次网络抖动被升级成一次
 * 完全不必要的重新登录。
 */
export type WbChatResult =
  | { ok: true; response: Response }
  | {
      ok: false
      status: number
      kind: WbUpstreamErrorKind
      message: string
      retryable?: boolean
      /**
       * 上游信封里给用户看的那部分。
       *
       * 只有 HTTP 非 2xx 且 body 是 JSON 对象时才有值；网络层失败、非 JSON 边缘层
       * 错误页都给不出它。缺省是常态，调用方必须能只靠 `message` 工作。
       */
      detail?: WbUpstreamErrorDetail
    }

/** 积分读取的原始产物：只到「包 + 总量」，窗口聚合交给探测层。 */
export interface WbRawCredits {
  total: number
  packages: readonly WbCreditPackage[]
}

/** 签到状态（投影类型见 status-paths）。 */
export interface WbUpstreamCheckin {
  active: boolean
  todayCheckedIn: boolean
  streakDays: number
  dailyCredit: number
  todayCredit: number
  isStreakDay: boolean
  nextStreakDay: number
  streakBonusDays: number
  streakBonusCredit: number
  claimButtonText?: string
}

/** 领取签到奖励的回执。 */
export interface WbCheckinClaim {
  credit: number
  streakDays: number
  isStreakDay: boolean
}

/** 一个促销权益（补偿 / 赠礼）。 */
export interface WbBenefit {
  kind: 'compensation' | 'gift'
  /** 活动窗口是否开着。 */
  active: boolean
  /** 本账号是否已领。 */
  claimed: boolean
  creditNum: number
  endsAtMs?: number
  startsAtMs?: number
  claimedAtMs?: number
}

/** 权益领取路径。两个都**不带** `/v2` 前缀——那是另一族端点（探测 `/v2/...` 回 404）。 */
export const BENEFIT_CLAIM_PATHS: Readonly<Record<WbBenefit['kind'], string>> = {
  compensation: '/billing/meter/claim-compensation',
  gift: '/billing/meter/claim-gift',
}

/**
 * 一个权益是否可领。
 *
 * `active && !claimed` 两个标志都要，且**都不够**：实测活动结束后端点持续回
 * `claimed:false` + `active:false`，而**已领取**的赠礼仍报 `active:true`。只看
 * 一个，卡片就会永远挂着一个点了没反应、或者该亮却灰掉的按钮。
 */
export function benefitIsClaimable(benefit: WbBenefit): boolean {
  return benefit.active && !benefit.claimed
}

// ── 登录态自愈 ────────────────────────────────────────────────────────────

/** 这份凭据自己声明的到期时刻是否已经过去。`expiresAtMs === 0` 表示文件没写，按未知处理。 */
function credentialExpired(credential: WbCredential, nowMs: number = Date.now()): boolean {
  return credential.expiresAtMs > 0 && credential.expiresAtMs <= nowMs
}

/**
 * 这次失败是不是「换一份 token 就能好」。
 *
 * 只看这两种：`authentication`（401/403，凭据被拒）与 `session_dead`（上游业务码
 * 说登录态失效）。其余种类刷新一律无意义——`hard_credit` 换 token 还是没钱，
 * `soft_rate` 换 token 还是被限流，而 `client_reject` 是请求形状问题。
 */
function isCredentialFailure(result: WbChatResult): boolean {
  return !result.ok && (result.kind === 'authentication' || result.kind === 'session_dead')
}

/**
 * 自愈的结果：要么换到了，要么带着一句用户能执行的话失败。
 *
 * `retryable` 只在「刷新没能完成，但**换一次时机就可能成**」时置位（网络、超时、
 * 边缘层 5xx/HTML）。它和 `kind` 一起交出去，让调用方能分开处理两件事：
 * 「这次请求为什么失败」（kind，决定状态码与文案）与「这份凭据还有没有救」
 * （retryable，决定要不要把账号判死）。
 */
type WbRenewResult =
  | { ok: true }
  | {
      ok: false
      retryable: boolean
      failure: { ok: false; status: number; kind: WbUpstreamErrorKind; message: string; retryable?: boolean }
    }

/**
 * 构造一次刷新失败。
 *
 * `retryable` 决定 shim 拿去冷却还是判死，所以它必须由**知道原因**的调用方给出：
 * 网络/超时/边缘层错误是 `true`（稍后自动重试），凭据被上游明确拒绝、refresh token
 * 本身缺失或已过期是 `false`（只能重新登录）。
 *
 * `kind` 一律保持 `authentication`，只有 `retryable` 变：这次请求确实因为「登录态没
 * 拿到」而失败，这是事实；差别只在**这份凭据还有没有救**。让 kind 跟着一起变会丢掉
 * 一个信息——「被上游拒了」和「没打通」都会变成 `server`，卡片上就再也分不出哪次该
 * 去重新登录。所以状态码也保持 401：一个请求恰好赶上刷新失败时，401 是诚实的；而
 * 一次抖动在池层面走冷却，等冷却到期账号自动回到参选名单，用户看到的最终答复来自
 * `exhaustedReason` 的 429「都在冷却」，不会有人被叫去重新登录。
 */
function renewFailed(message: string, retryable: boolean): WbRenewResult {
  return {
    ok: false,
    retryable,
    failure: {
      ok: false,
      status: 401,
      kind: 'authentication',
      message,
      ...retryable ? { retryable: true } : {},
    },
  }
}

/**
 * 把刷新失败的异常翻成一句话。
 *
 * 两类必须分开：上游**明确拒绝**了 refresh token（`WbCredentialRejectedError`）意味
 * 着只能重新登录；网络/超时/边缘层 HTML 错误意味着稍后还能再试，此时说「请重新登录」
 * 是把人赶去做不必要的操作。两种都以「无法自动续期」结尾，因为这次请求确实没救了。
 */
function describeRefreshFailure(error: unknown): string {
  if (error instanceof WbCredentialRejectedError) {
    const detail = error.message.trim()
    return `refresh token 被上游拒绝${detail === '' ? '' : `（${detail}）`}，无法自动续期；请重新登录 WorkBuddy 桌面端。`
  }
  const detail = error instanceof Error ? error.message : String(error)
  return `刷新登录态失败（${detail}），本轮无法自动续期；稍后自动重试，持续失败请重新登录 WorkBuddy 桌面端。`
}

// ── 客户端 ────────────────────────────────────────────────────────────────

/**
 * 上游客户端。一个实例服务整个插件；请求显式接收凭据，所以 token 刷新在下一次
 * 调用里自然生效。
 */
export class WbUpstreamClient {
  /**
   * 上报一次不得不采取的降级。
   *
   * 注入而不是在这里打日志：本模块不持 logger（理由见文件头）。宿主把它接到
   * `ctx.logger.warn`；没有宿主时事件被丢弃——与只有单一读取方的旧实现同等的安静。
   */
  constructor(private readonly onFallback?: (message: string) => void) {}

  /**
   * POST 聊天端点；成功的答案是原始 SSE 响应。
   *
   * 这是**唯一**会在失败后自愈的请求：登录态过期在这里最贵（用户正对着输入框等
   * 回答），而在余额/签到路径上过期只是少一个读数。自愈规则是「一次请求最多换一次
   * token」——`refreshed` 是这次调用的局部量而不是客户端上的标志位，所以并发中的
   * 十个请求各换各的一次，而每个请求自己绝不换第二次。上游对 refresh 端点有频次
   * 限制，重试环里再刷就变成用一个已经被拒的 token 反复敲门。
   */
  async chatStream(
    credential: WbCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<WbChatResult> {
    let refreshed = false
    // 已知过期就先换：省掉一个必然 401 的往返，也省掉上游那侧的失败计数。
    if (credentialExpired(credential)) {
      const renewed = await this.renewCredential(credential)
      if (!renewed.ok) return renewed.failure
      refreshed = true
    }
    const first = await this.postChat(credential, bodyJson, signal)
    if (first.ok) return first
    if (!isCredentialFailure(first) || refreshed) return first
    const renewed = await this.renewCredential(credential)
    if (!renewed.ok) return renewed.failure
    // 只重试一次，且第二次的结果原样返回：再失败就是上游真的不行，不是凭据问题。
    return await this.postChat(credential, bodyJson, signal)
  }

  /** 一次不带自愈的聊天 POST。自愈逻辑在 {@link chatStream} 里，这里只负责发。 */
  private async postChat(
    credential: WbCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<WbChatResult> {
    let response: Response
    // 刻意**不设**自己的超时上限（与 probeChat 不同）：一次对话要先预填整个
    // prompt 才有首字节，耗时随上下文规模差一个数量级；卡得太紧迟早会砍断一个
    // 真实回答，而砍断回答比等一个慢回答更糟。剩下的是调用方取消（shim 在客户端
    // 断开时 abort）与 HTTP 客户端自身的 header 超时。
    try {
      response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers: { ...chatHeaders(credential), 'Authorization': `Bearer ${credential.accessToken}` },
        body: bodyJson,
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      return { ok: false, status: 0, kind: 'server', message: `传输失败：${String(error)}` }
    }
    if (response.ok) return { ok: true, response }
    const text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    // 解析放在这里而不是让每个调用方自己 parse：`message` 与 `detail` 必须来自**同
    // 一次读取**。body 流只能读一次，第二个调用方再 parse 只能拿到空串。
    const detail = parseUpstreamErrorDetail(text)
    return {
      ok: false,
      status: response.status,
      kind: classifyUpstreamError(response.status, text),
      message: text,
      ...detail === undefined ? {} : { detail },
    }
  }

  /** POST token 刷新端点。调用方负责合并结果。 */
  async refreshToken(credential: WbCredential): Promise<{ accessToken?: string; refreshToken?: string; expiresInSec?: number }> {
    const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: refreshHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = dataOf(envelope)
    return {
      ...typeof data['accessToken'] === 'string' && data['accessToken'] !== ''
        ? { accessToken: data['accessToken'] }
        : {},
      ...typeof data['refreshToken'] === 'string' && data['refreshToken'] !== ''
        ? { refreshToken: data['refreshToken'] }
        : {},
      ...typeof data['expiresIn'] === 'number' && data['expiresIn'] > 0
        ? { expiresInSec: data['expiresIn'] }
        : {},
    }
  }

  /**
   * 用 refresh token 换一份新登录态，**原地改写** `credential`。
   *
   * 原地改而不是返回新对象：池里那份 `WbDiscoveredAccount.credential` 与 shim 手里
   * 的是同一个引用，换对象只会让这次请求用上新 token、下一次调用又回到旧的那份。
   *
   * 顺序是「先改内存再落盘」：即使磁盘满或权限不对，本次请求仍然可用；反过来先落盘
   * 再改内存，写失败会连带失掉一次本来能成功的回答。
   */
  private async renewCredential(credential: WbCredential): Promise<WbRenewResult> {
    // 空串是「这份凭据里拿不到 refresh token」的确定信号（加密信封解不开时就落成
    // 空串，见 accounts.ts 的 fieldOf）。拿空串去敲上游只会换来一个 401。
    // 不可重试：没有任何一次重试能凭空变出一个 refresh token，只能重新登录。
    if (credential.refreshToken === '') {
      return renewFailed('这份登录凭据里没有 refresh token，无法自动续期；请重新登录 WorkBuddy 桌面端。', false)
    }
    const refreshExpiresAtMs = credential.refreshExpiresAtMs
    if (refreshExpiresAtMs !== undefined && refreshExpiresAtMs > 0 && refreshExpiresAtMs <= Date.now()) {
      const when = new Date(refreshExpiresAtMs).toLocaleString('zh-CN')
      return renewFailed(`refresh token 已于 ${when} 失效，无法自动续期；请重新登录 WorkBuddy 桌面端。`, false)
    }
    let issued: { accessToken?: string; refreshToken?: string; expiresInSec?: number }
    try {
      issued = await this.refreshToken(credential)
    } catch (error: unknown) {
      // 可重试与否由「谁拒绝的」决定，而这里正是唯一知道答案的地方：
      // - WbCredentialRejectedError 是上游**明确拒绝**了这份 refresh token（401/403
      //   或非零信封），再试还是同一份 token，只能重新登录；
      // - 其余（TypeError: fetch failed、AbortError 超时、边缘层回的 HTML 502）
      //   都是「这一次没打通」，稍后再试就可能成。
      // 这条区分以前只写在 describeRefreshFailure 的注释里，返回值却一律标成
      // authentication —— 于是一次网络抖动被判成「凭据已死」且永不恢复。
      return renewFailed(describeRefreshFailure(error), !(error instanceof WbCredentialRejectedError))
    }
    if (issued.accessToken === undefined) {
      return renewFailed('上游的刷新接口没有返回新的 access token；请重新登录 WorkBuddy 桌面端。', false)
    }
    credential.accessToken = issued.accessToken
    if (issued.refreshToken !== undefined) credential.refreshToken = issued.refreshToken
    // 上游没给有效期就记 0（未知）：下次靠真实的 401 触发，而不是靠一个编出来的时刻。
    credential.expiresAtMs = issued.expiresInSec === undefined ? 0 : Date.now() + issued.expiresInSec * 1000
    credential.lastRefreshAtMs = Date.now()
    await saveRefreshedCredential(
      PLUGIN_ID,
      workbuddyAccountId(credential),
      {
        accessToken: credential.accessToken,
        ...credential.refreshToken === '' ? {} : { refreshToken: credential.refreshToken },
        expiresAtMs: credential.expiresAtMs,
        refreshedAtMs: credential.lastRefreshAtMs,
      },
      { warn: (message: unknown) => { this.onFallback?.(String(message)) } },
    )
    return { ok: true }
  }

  /**
   * 读模型目录。
   *
   * 两个区域一律先读 `/v3/config`（应用通道文档）；国内失败时回退旧路径。三种失败
   * 都要回退——传输错误、非零信封、以及**空名册**（`selectCliModels` 对空名册抛错），
   * 让「/v3 停止列出模型」退化成少一点功能，而不是整个区域没有模型。
   */
  async fetchModels(
    credential: WbCredential,
    signal?: AbortSignal,
    keepModelIds: readonly string[] = [],
  ): Promise<readonly WbUpstreamModel[]> {
    const models = await this.readCatalogModels(credential, signal, keepModelIds)
    return await this.withBusyLevels(credential, models, signal)
  }

  /**
   * 问一次上游「这些模型现在挤不挤」。
   *
   * 一个请求问一整批（`WORKBUDDY_BUSY_BATCH_SIZE` 个），绝不逐个轮询：名册 20-62 个
   * 模型逐个问就是 20-62 个往返，而这条信息只是给人看的装饰。
   *
   * 非零信封与传输失败一律抛错，由 {@link withBusyLevels} 统一兜成「不挂等级」——
   * 与同类 reader 的分工一致：解析层只负责如实报告，降级策略留给调用方决定。
   */
  async fetchModelBusy(
    credential: WbCredential,
    modelIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<Map<string, WbBusyLevel>> {
    const levels = new Map<string, WbBusyLevel>()
    const batches = batchModelIds(modelIds)
    // 空名册不发请求：上游对空 `models` 数组回 400，那不是降级，是一次注定失败的往返。
    for (const batch of batches) {
      const response = await fetch(`${chatBase(credential)}${MODEL_BUSY_PATH}`, {
        method: 'POST',
        headers: {
          ...commonHeaders(credential),
          'Authorization': `Bearer ${credential.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ models: batch }),
        signal: signal ?? AbortSignal.timeout(MODEL_BUSY_TIMEOUT_MS),
      })
      const envelope = await readEnvelope(response)
      if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
      for (const [id, level] of parseBusyLevels(envelope.data)) levels.set(id, level)
    }
    return levels
  }

  /**
   * 给名册挂上拥挤度；问不到就原样返回名册。
   *
   * 三层防线都在这里，顺序刻意：
   * 1. **按区短路**：国际网关没有 `/v2/chat/busy`（实测 404）。发出去再吞错会让每次
   *    刷新多一个注定失败的往返，还会在国际区的日志里留下一条永远为真的告警。
   * 2. **失败静默降级**：超时/404/非零信封都只 warn 一次，名册原样返回。拥挤度是
   *    装饰性信息，它失败不该让「刷新模型」这件事失败，也不该让名册少一个模型。
   * 3. **写进 `name`**：`WbModelInfo`（`status-paths.ts`）没有拥挤度字段，而
   *    `catalog.toModelInfo()` 只搬运固定几个字段——`name` 是唯一能原样到达界面的
   *    字段。所以符号拼在名字后面，`unknown`/`undefined` 拼空串（名字逐字节不变）。
   */
  async withBusyLevels(
    credential: WbCredential,
    models: readonly WbUpstreamModel[],
    signal?: AbortSignal,
  ): Promise<WbUpstreamModel[]> {
    if (regionOf(credential.domain) !== 'cn' || models.length === 0) return [...models]
    let levels: Map<string, WbBusyLevel>
    try {
      levels = await this.fetchModelBusy(credential, models.map(model => model.id), signal)
    } catch (error: unknown) {
      this.onFallback?.(
        '模型拥挤度读取失败，本次名册不带拥挤度：'
        + (error instanceof Error ? error.message : String(error)),
      )
      return [...models]
    }
    return attachBusyLevels(models, levels).map(model => {
      const suffix = busyDisplaySuffix(model.busyLevel)
      return suffix === '' ? model : { ...model, name: `${model.name}${suffix}` }
    })
  }

  /** 读一份原始名册（不含拥挤度）。拆分出来只为了让 `fetchModels` 的降级链保持原样。 */
  private async readCatalogModels(
    credential: WbCredential,
    signal?: AbortSignal,
    keepModelIds: readonly string[] = [],
  ): Promise<readonly WbUpstreamModel[]> {
    const timeout = signal ?? AbortSignal.timeout(JSON_TIMEOUT_MS)
    if (regionOf(credential.domain) === 'global') {
      const response = await fetch(`${globalBase(credential.domain)}${GLOBAL_CONFIG_PATH}`, {
        headers: {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
          ...credential.uid === undefined || credential.uid === '' ? {} : { 'X-User-Id': credential.uid },
          ...credential.domain === '' ? {} : { 'X-Domain': credential.domain },
          'X-Product': 'SaaS',
          'X-Requested-With': 'XMLHttpRequest',
          'Connection': 'close',
          'User-Agent': PRODUCT_UA,
        },
        signal: timeout,
      })
      const envelope = await readEnvelope(response)
      if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
      const data = dataOf(envelope)
      return withPromos(selectCliModels(data['models'], data['agents'], keepModelIds), data)
    }
    const readCatalog = async (path: string): Promise<readonly WbUpstreamModel[]> => {
      const response = await fetch(`${chatBase(credential)}${path}`, {
        headers: {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
          'Origin': originReferer(credential),
          'Referer': `${originReferer(credential)}/`,
          'User-Agent': PRODUCT_UA,
        },
        signal: timeout,
      })
      const envelope = await readEnvelope(response)
      if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
      const data = dataOf(envelope)
      return withPromos(selectCliModels(data['models'], data['agents'], keepModelIds), data)
    }
    try {
      return await readCatalog(GLOBAL_CONFIG_PATH)
    } catch (error: unknown) {
      this.onFallback?.(
        `国内模型目录 ${GLOBAL_CONFIG_PATH} 读取失败，回退 ${MODELS_CATALOG_PATH}：`
        + (error instanceof Error ? error.message : String(error)),
      )
      return await readCatalog(MODELS_CATALOG_PATH)
    }
  }

  /** 读今日签到状态，不改账号状态。 */
  async fetchCheckinStatus(credential: WbCredential): Promise<WbUpstreamCheckin> {
    const response = await fetch(`${billingBase(credential)}/v2/billing/meter/checkin-activity-status`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = dataOf(envelope)
    const numberField = (key: string): number => typeof data[key] === 'number' ? data[key] as number : 0
    return {
      active: data['active'] === true,
      todayCheckedIn: data['today_checked_in'] === true,
      streakDays: numberField('streak_days'),
      dailyCredit: numberField('daily_credit'),
      todayCredit: numberField('today_credit'),
      isStreakDay: data['is_streak_day'] === true,
      nextStreakDay: numberField('next_streak_day'),
      streakBonusDays: numberField('streak_bonus_days'),
      streakBonusCredit: numberField('streak_bonus_credit'),
      ...typeof data['claim_button_text'] === 'string' && data['claim_button_text'] !== ''
        ? { claimButtonText: data['claim_button_text'] }
        : {},
    }
  }

  /**
   * 读这个账号还能看到的全部促销权益，**不领取任何东西**。
   *
   * 活动清单刻意是封闭且小的：网关每个活动一个状态端点，所以「发现权益」是一次
   * 固定的扇出，不是搜索。新活动类型意味着在这里加一个 `/billing/meter/*-status`
   * ——插件从不猜未公开的端点。
   *
   * 每个端点独立读、失败按端点隔离：一个活动回 5xx 不能让另一个消失。调用方只
   * 拿到真正读到的东西。
   */
  async fetchBenefits(credential: WbCredential): Promise<readonly WbBenefit[]> {
    const read = async (kind: WbBenefit['kind'], path: string): Promise<WbBenefit | undefined> => {
      try {
        return await this.readBenefitStatus(kind, credential, path)
      } catch {
        return undefined
      }
    }
    const [compensation, gift] = await Promise.all([
      read('compensation', '/billing/meter/compensation-status'),
      read('gift', '/billing/meter/check-gift-claimed'),
    ])
    return [compensation, gift].filter((benefit): benefit is WbBenefit => benefit !== undefined)
  }

  private async readBenefitStatus(
    kind: WbBenefit['kind'],
    credential: WbCredential,
    path: string,
  ): Promise<WbBenefit> {
    const response = await fetch(`${billingBase(credential)}${path}`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = dataOf(envelope)
    const numberField = (key: string): number => typeof data[key] === 'number' ? data[key] as number : 0
    /** 网关把时间写成本地时区的 `YYYY-MM-DD HH:MM:SS`。 */
    const timeField = (key: string): number | undefined => {
      const raw = data[key]
      if (typeof raw !== 'string' || raw.trim() === '') return undefined
      const parsed = Date.parse(raw.replace(' ', 'T'))
      return Number.isNaN(parsed) ? undefined : parsed
    }
    const endsAtMs = timeField('end_time')
    const startsAtMs = timeField('start_time')
    const claimedAtMs = timeField('claimed_at')
    return {
      kind,
      active: data['active'] === true,
      claimed: data['claimed'] === true,
      creditNum: numberField('credit_num'),
      ...endsAtMs === undefined ? {} : { endsAtMs },
      ...startsAtMs === undefined ? {} : { startsAtMs },
      ...claimedAtMs === undefined ? {} : { claimedAtMs },
    }
  }

  /**
   * 在**一个**账号上领取一个权益。
   *
   * 这是一次真实的积分发放，所以除交给它的凭据之外不接受任何账号参数：由调用方
   * 决定是哪一个账号，且刻意没有批量形式。响应不解析——这两个端点的文档信封是
   * 空成功，调用方事后重读状态；那次重读才是给用户看的东西，所以「点了没生效」
   * 不会让卡片一直停在待领取。
   */
  async claimBenefit(credential: WbCredential, kind: WbBenefit['kind']): Promise<void> {
    const response = await fetch(`${billingBase(credential)}${BENEFIT_CLAIM_PATHS[kind]}`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
  }

  /** 领取今日签到奖励。浏览器路由守着这次写操作。 */
  async claimDailyCheckin(credential: WbCredential): Promise<WbCheckinClaim> {
    const response = await fetch(`${billingBase(credential)}/v2/billing/meter/daily-checkin`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = dataOf(envelope)
    const numberField = (key: string): number => typeof data[key] === 'number' ? data[key] as number : 0
    return {
      credit: numberField('credit'),
      streakDays: numberField('streak_days'),
      isStreakDay: data['is_streak_day'] === true,
    }
  }

  /**
   * 读剩余积分，**每个包单独保留**。
   *
   * 不在这里聚合（总量之外的任何汇合都会丢掉卡片排序需要的日期），窗口聚合交给
   * `probe.ts` —— 因为临期窗口必须用**用户配置的** `expiryWarnDays`，而这个模块
   * 不应该知道用户设置。
   *
   * 余额取 `CycleCapacityRemain` 家族（issue #58 定论）：`CapacityRemain` 是
   * pool 家族，整月额度花完时仍报满额（高报）；国际网关实测三账号报
   * `CapacityRemain=100`，而 chat 直接回 `14018 Credits exhausted`。用高报的那个
   * 当余额，排在第一的永远是一个已经用光的账号。
   */
  async fetchCredits(credential: WbCredential): Promise<WbRawCredits> {
    const now = new Date()
    const format = (date: Date): string => [
      date.getFullYear().toString().padStart(4, '0'),
      (date.getMonth() + 1).toString().padStart(2, '0'),
      date.getDate().toString().padStart(2, '0'),
    ].join('-') + ' ' + [
      date.getHours().toString().padStart(2, '0'),
      date.getMinutes().toString().padStart(2, '0'),
      date.getSeconds().toString().padStart(2, '0'),
    ].join(':')
    const response = await fetch(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: 'p_tcaca',
        Status: [0, 3],
        PackageEndTimeRangeBegin: format(now),
        PackageEndTimeRangeEnd: format(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
      }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const responseWrapper = dataOf(envelope)
    const data = typeof responseWrapper['Response'] === 'object' && responseWrapper['Response'] !== null
      ? responseWrapper['Response'] as Record<string, unknown>
      : {}
    const inner = typeof data['Data'] === 'object' && data['Data'] !== null
      ? data['Data'] as Record<string, unknown>
      : {}
    const rawAccounts = Array.isArray(inner['Accounts']) ? inner['Accounts'] : []

    const parseDate = (raw: unknown): number | undefined => {
      if (typeof raw === 'number' && raw > 1_000_000_000_000) return raw
      if (typeof raw === 'string' && raw !== '') {
        const parsed = Date.parse(raw)
        if (!Number.isNaN(parsed)) return parsed
      }
      return undefined
    }

    let total = 0
    const packages: WbCreditPackage[] = []
    for (const raw of rawAccounts) {
      if (typeof raw !== 'object' || raw === null) continue
      const account = raw as Record<string, unknown>
      const numberField = (key: string): number => (typeof account[key] === 'number' ? account[key] as number : 0)
      // 每个容量同时以 `*Precise` 字符串再发一份，带整数版丢掉的分数
      // （"96.61000218" 与 96 并列）。官方客户端读的是 precise——它的总额带小数
      // （2,196.61），任何整数之和都凑不出来。优先 precise，回退整数，让一个不带
      // precise 的响应仍能解析。
      const preciseField = (key: string): number => {
        const rawValue = account[`${key}Precise`]
        if (typeof rawValue === 'string' && rawValue !== '') {
          const parsed = Number.parseFloat(rawValue)
          if (Number.isFinite(parsed)) return parsed
        }
        if (typeof rawValue === 'number' && Number.isFinite(rawValue)) return rawValue
        return numberField(key)
      }
      // CapacityType 4 = 月周期资源（按周期刷新、永不过期）；1 = 扣减式赠礼
      // （余额会扣到 0，带 ExpiredTime）。两者都有 CycleEndTime，所以它单独分不出来。
      const monthly = numberField('CapacityType') === 4
      const size = preciseField('CycleCapacitySize') || preciseField('CapacitySize')
      const hasCycle = account['CycleCapacityRemain'] !== undefined
        || account['CycleCapacityRemainPrecise'] !== undefined
      const remain = hasCycle ? preciseField('CycleCapacityRemain') : preciseField('CapacityRemain')
      const cappedRemain = remain < 0 ? 0 : remain
      const cycleEndMs = parseDate(account['CycleEndTime'])
      // 月周期资源的 cycleEnd 是刷新点，展示下一次周期的开始（end + 1s），否则
      // 「08/31 23:59:59 刷新」读起来像包那时就没了。赠礼的 ExpiredTime 就是消失时刻。
      const expiresAtMs = monthly ? undefined : parseDate(account['ExpiredTime']) ?? cycleEndMs
      const refreshAtMs = monthly
        ? cycleEndMs === undefined ? undefined : cycleEndMs + 1_000
        : undefined
      // 丢掉已用光 / 已过期的一次性赠礼：它们没有可用余额，只会占满临期列表。
      // 月周期资源永远保留。
      if (!monthly && (cappedRemain <= 0 || (expiresAtMs !== undefined && expiresAtMs <= Date.now()))) continue
      total += cappedRemain
      packages.push({
        packageName: typeof account['PackageName'] === 'string' ? account['PackageName'] : '(unnamed)',
        remain: cappedRemain,
        size,
        monthly,
        ...refreshAtMs === undefined ? {} : { refreshAtMs },
        ...expiresAtMs === undefined ? {} : { expiresAtMs },
      })
    }
    return { total, packages }
  }
}
