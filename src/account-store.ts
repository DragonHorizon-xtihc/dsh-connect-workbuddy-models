/**
 * 宿主侧持久化：自动化账本。
 *
 * 账本回答的唯一问题是「今天这个时段跑过没有」。它存在磁盘上而不是内存里，因为
 * DSH 常常一天被重启好几次——纯内存账本会让每次重启都重跑一遍签到，而签到是**写
 * 上游**的动作，无谓重跑既慢又容易触发限流。
 *
 * 为什么不放进 settings 文档：账本是机器状态（每次运行都在变），settings 是用户
 * 可编辑的配置。把每天变几十次的东西塞进用户的配置文档，会让设置页的 diff 永远
 * 有噪音，也让用户可能手改出一个自己看不懂的状态。
 */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

import type { AutomationLedger } from './scheduler.ts'

/** 账本文件名。放在 dsh home 下：跨进程重启有意义，但不属于用户可编辑的配置。 */
const LEDGER_FILENAME = 'automation-ledger.json'

/** 账本的绝对路径。 */
export function ledgerPath(pluginId: string): string {
  return dshHomePath(pluginId, LEDGER_FILENAME)
}

/**
 * 读回账本。
 *
 * 读失败一律返回 `undefined`：账本只回答「今天是不是已经签过」，丢了最多多签一次
 * （上游按北京自然日幂等，多签是无害的空操作），而**读失败让插件起不来**是不可
 * 接受的。JSON 结构不对也一样按空账本处理——手改坏的文件不该变成启动故障。
 */
export async function loadLedger(pluginId: string): Promise<AutomationLedger | undefined> {
  try {
    const text = await readFile(ledgerPath(pluginId), 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const row = parsed as Record<string, unknown>
    const firedSlots = Array.isArray(row['firedSlots'])
      ? row['firedSlots'].filter((entry): entry is string => typeof entry === 'string')
      : []
    return {
      firedSlots,
      ...typeof row['lastRunDate'] === 'string' ? { lastRunDate: row['lastRunDate'] } : {},
      ...typeof row['lastRunSlot'] === 'string' ? { lastRunSlot: row['lastRunSlot'] } : {},
    }
  } catch {
    return undefined
  }
}

/**
 * 保存账本。
 *
 * 写失败只记一条 warn：账本是「省一次空操作」的优化，绝不能因为磁盘满或权限问题
 * 打断了正在进行中的签到循环。
 */
export async function saveLedger(
  pluginId: string,
  ledger: AutomationLedger,
  logger?: { warn(...args: unknown[]): void },
): Promise<void> {
  try {
    const path = ledgerPath(pluginId)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    // 0o600：账本里有账号 id 与所得积分，属于本机私有数据。
    await writeFileAtomic(path, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  } catch (error: unknown) {
    logger?.warn('dsh-connect-workbuddy-models: 自动化账本写入失败', error)
  }
}

// ── 刷新后的凭据 ──────────────────────────────────────────────────────────

/**
 * 一份被刷新过的凭据里**只有**上游能重新签发的部分。
 *
 * 不存整份 `WbCredential`：`uin` / `nickname` / `domain` 这些身份字段属于桌面端
 * 与 vault 的凭据文件，重存一遍等于让本插件成为第二个凭据来源，两份迟早不一致。
 */
export interface WbRefreshedCredential {
  accessToken: string
  /** 上游旋转 refresh token 时的新值；没旋转就沿用磁盘上那份。 */
  refreshToken?: string
  /** 新 access token 的到期时刻（ms）；0 表示上游没给 `expiresIn`。 */
  expiresAtMs: number
  /** 本插件写这条记录的时刻。只用于同一条记录的世代比较，不是上游时钟。 */
  refreshedAtMs: number
}

/** 账号 id → 刷新记录。 */
export type WbRefreshStore = Readonly<Record<string, WbRefreshedCredential>>

/** 刷新记录文件名。与账本同目录、同权限：里面是 bearer token，属于本机私有数据。 */
const REFRESH_FILENAME = 'credential-refresh.json'

/** 刷新记录的绝对路径。 */
export function credentialRefreshPath(pluginId: string): string {
  return dshHomePath(pluginId, REFRESH_FILENAME)
}

/**
 * 进程内串行化刷新记录的读改写。
 *
 * 两个账号同时被上游 401 时会并发走到这里，而保存是「读整份 → 改一条 → 写回」：
 * 不串行化就会丢掉先写那条，表现为「刷新过但重启后又回到旧 token」——比不刷新
 * 更难查，因为它只在多账号同时过期时出现。
 */
let refreshWriteChain: Promise<unknown> = Promise.resolve()

function serializeRefreshWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = refreshWriteChain.then(task, task)
  // 链上只保留完成信号，永远不 reject：否则一次写失败会让后续所有写入短路。
  refreshWriteChain = next.then(() => undefined, () => undefined)
  return next
}

/**
 * 读回刷新记录。
 *
 * 与 {@link loadLedger} 同口径：读失败、JSON 坏、结构不对一律当空表。这里更不
 * 能抛——它跑在**每次账号发现**里，抛错就等于磁盘上有个坏文件让整个插件起不来。
 */
export async function loadRefreshedCredentials(pluginId: string): Promise<WbRefreshStore> {
  try {
    const text = await readFile(credentialRefreshPath(pluginId), 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const store: Record<string, WbRefreshedCredential> = {}
    for (const [accountId, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof raw !== 'object' || raw === null) continue
      const row = raw as Record<string, unknown>
      const accessToken = row['accessToken']
      // 一条没有 token 的记录毫无用处；留着它只会在覆盖判断里赢过磁盘上的好凭据。
      if (typeof accessToken !== 'string' || accessToken === '') continue
      store[accountId] = {
        accessToken,
        ...typeof row['refreshToken'] === 'string' && row['refreshToken'] !== ''
          ? { refreshToken: row['refreshToken'] }
          : {},
        expiresAtMs: typeof row['expiresAtMs'] === 'number' && Number.isFinite(row['expiresAtMs'])
          ? row['expiresAtMs']
          : 0,
        refreshedAtMs: typeof row['refreshedAtMs'] === 'number' && Number.isFinite(row['refreshedAtMs'])
          ? row['refreshedAtMs']
          : 0,
      }
    }
    return store
  } catch {
    return {}
  }
}

/**
 * 记下一个账号刷新后的凭据。
 *
 * 写失败只记一条 warn：磁盘满或权限问题不该让一次**已经成功**的刷新连带失掉聊天
 * 能力——内存里的新 token 仍然有效，最坏结果只是重启后回到旧 token 再刷一次。
 */
export async function saveRefreshedCredential(
  pluginId: string,
  accountId: string,
  entry: WbRefreshedCredential,
  logger?: { warn(...args: unknown[]): void },
): Promise<void> {
  await serializeRefreshWrite(async () => {
    try {
      const path = credentialRefreshPath(pluginId)
      // 读改写：别的账号的记录必须原样留下，否则每次刷新都会把其它账号的刷新结果清掉。
      const current = await loadRefreshedCredentials(pluginId)
      const merged: Record<string, WbRefreshedCredential> = { ...current, [accountId]: entry }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      // 0o600：文件里是 bearer token。
      await writeFileAtomic(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    } catch (error: unknown) {
      logger?.warn('dsh-connect-workbuddy-models: 刷新后的凭据写入失败', error)
    }
  })
}
