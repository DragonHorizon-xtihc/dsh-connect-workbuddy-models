/**
 * 上下文窗口修正 + 发前裁剪的回归测试。
 *
 * 两个根因：
 * 1. 目录把 hy3 的窗口写成 192000，但上游真实硬上限是 144000（实测 preflight 报错
 *    `model window 144000 (model=hy3)`）。报大窗口会让 DSH 一直把历史堆过真实窗口才压缩，
 *    上游紧急压缩被 429 限流 → `preflight_compress_failed`。`effectiveContextWindow` 必须
 *    把广告窗口压到真实窗口 × 安全边际之下。
 * 2. 即便窗口修正了，极端长会话仍可能越过窗口。shim 必须在本地把最旧历史裁掉，使发出的
 *    请求始终在窗口内，从源头消除上游 preflight 失败。
 */
import { describe, expect, it } from 'vitest'
import { effectiveContextWindow } from '../src/catalog.ts'
import { isContextTooLong, trimToWindow, MIN_KEEP_RECENT_MESSAGES } from '../src/shim.ts'

describe('effectiveContextWindow 窗口修正', () => {
  it('hy3 必须被压到真实窗口 144000 × 0.9 之下', () => {
    // 目录给 192000，真实 144000 → min = 144000，×0.9 = 129600。
    expect(effectiveContextWindow(192_000, 'hy3')).toBe(129_600)
    expect(effectiveContextWindow(192_000, 'hy3')).toBeLessThan(144_000)
  })

  it('未知模型按目录值 × 0.9，且缺失值落回兜底 × 0.9', () => {
    expect(effectiveContextWindow(200_000, 'glm-5.1')).toBe(180_000)
    expect(effectiveContextWindow(undefined, 'some-model')).toBe(115_200) // 128000 × 0.9
    expect(effectiveContextWindow(0, 'some-model')).toBe(115_200)
  })

  it('安全边际对 1M 窗口模型也成立（仍为安全值，且远小于真实 1M）', () => {
    expect(effectiveContextWindow(1_000_000, 'hy4-preview')).toBe(900_000)
  })
})

describe('isContextTooLong 识别 preflight 压缩失败', () => {
  it('命中 preflight_compress_failed / model window / not forwarded', () => {
    expect(isContextTooLong('context ~248379 tokens exceeds the model window 144000 (model=hy3)')).toBe(true)
    expect(isContextTooLong('preflight_compress_failed')).toBe(true)
    expect(isContextTooLong('The over-window payload was NOT forwarded.')).toBe(true)
    expect(isContextTooLong('{"type":"server_error","code":"preflight_compress_failed"}')).toBe(true)
  })

  it('无关文本不被误判', () => {
    expect(isContextTooLong('upstream returned 200 with a normal reply')).toBe(false)
    expect(isContextTooLong('rate limited (HTTP 429)')).toBe(false)
  })
})

/** 估算一条纯拉丁消息的 token（与 shim 的 estimateTokens 同口径：4 字符 ≈ 1 token + 4 结构开销）。 */
function plainUser(text: string): Record<string, unknown> {
  return { role: 'user', content: text }
}

function buildBody(messageCount: number, perMsgChars = 400): string {
  const messages = [{ role: 'system', content: 'You are a helpful assistant.' }]
  for (let i = 0; i < messageCount; i += 1) messages.push(plainUser('x'.repeat(perMsgChars)))
  return JSON.stringify({ model: 'hy3', messages })
}

describe('trimToWindow 发前裁剪', () => {
  // 每条 400 拉丁字符 ≈ 100 token；窗口 1000 → 预算 850。system + 少量消息就超。
  const WINDOW = 1000
  const BUDGET = Math.floor(WINDOW * 0.85)

  it('上下文在预算内时不改动（返回 undefined）', () => {
    const body = buildBody(2)
    expect(trimToWindow(body, WINDOW)).toBeUndefined()
  })

  it('超预算时裁掉最旧历史，使总 token 估计 ≤ 预算', () => {
    const body = buildBody(40)
    const trimmed = trimToWindow(body, WINDOW)
    expect(trimmed).toBeDefined()
    const parsed = JSON.parse(trimmed!) as { messages: unknown[] }
    // 首条 system 与最近 MIN_KEEP_RECENT_MESSAGES 条必须保留。
    expect(parsed.messages[0]).toMatchObject({ role: 'system' })
    expect(parsed.messages.length).toBeLessThan(41)
    // 重新估算裁剪后的总量（CJK=0 这里全拉丁）：每条 ~104 token。
    let total = 0
    for (const m of parsed.messages) {
      const content = (m as Record<string, unknown>)['content']
      if (typeof content === 'string') total += Math.ceil(content.length * 0.25) + 4
    }
    expect(total).toBeLessThanOrEqual(BUDGET)
  })

  it('首条 system 与最近 N 条不被裁', () => {
    const body = buildBody(40)
    const trimmed = JSON.parse(trimToWindow(body, WINDOW)!) as { messages: Record<string, unknown>[] }
    expect(trimmed.messages[0]['role']).toBe('system')
    const last = trimmed.messages[trimmed.messages.length - 1]
    expect(last['content']).toBe('x'.repeat(400))
    // 最近 MIN_KEEP_RECENT_MESSAGES 条里至少包含原始最后一条。
    const tail = trimmed.messages.slice(-MIN_KEEP_RECENT_MESSAGES)
    expect(tail.some(m => m['content'] === 'x'.repeat(400))).toBe(true)
  })

  it('历史全是工具交换（不可丢）时放弃裁剪，返回 undefined', () => {
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', content: 'x'.repeat(400), tool_call_id: 'c1' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c2', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', content: 'x'.repeat(400), tool_call_id: 'c2' },
    ]
    const body = JSON.stringify({ model: 'hy3', messages })
    // 预算设得很小，逼它想裁；但没有可丢的纯文本消息，应原样返回 undefined。
    expect(trimToWindow(body, 50)).toBeUndefined()
  })
})
