/**
 * 通用 **Anthropic Messages SSE 消费层**。
 *
 * ## 为什么现在才抽（这是上游作者留下的明确指示）
 *
 * `minimax-messages.ts:6-13` 原话：本 provider 是本插件**唯一**使用 Anthropic
 * Messages 协议族的成员，故「**不做**通用 Anthropic 层抽象 —— 目前只有一个
 * 消费者，抽象会凭空多一层间接（Qoder 的教训是『同族第二个产品出现时再抽』）」。
 *
 * MonkeyCode 是**第二个** Anthropic 消费者（它可以走 `/messages` 面，也会走
 * `/responses` 面），条件已成立 ⇒ 按既定口径抽出本层。minimax 改为委托，
 * 对外 API 与错误语义**逐字不变**（由 `scripts/anthropic-sse-test.mjs` 的
 * 23 条断言锁死等价性 —— 该文件在重构前即全绿，重构后必须仍全绿）。
 *
 * ## 事件契约（两个渠道实测一致）
 *
 * | 事件 | 用途 |
 * |---|---|
 * | `message_start` | `usage.input_tokens` / `cache_read_input_tokens` |
 * | `ping` | 保活（**必须忽略**） |
 * | `content_block_start` | `content_block.type` ∈ `thinking` / `text` / `tool_use` |
 * | `content_block_delta` | `thinking_delta` / `text_delta` / `signature_delta` / `input_json_delta` |
 * | `content_block_stop` | 该块结束 |
 * | `message_delta` | `stop_reason`、`usage.output_tokens` |
 * | `message_stop` | 结束 |
 * | `error` | `{type:'error', error:{type,message}}` |
 *
 * ## 四条必须保留的既有行为（每条都对应一次现场踩坑）
 *
 * 1. **流尾残留事件必须按整行再走一遍**：SSE 末帧若不带换行，`message_delta`
 *    （携带 `stop_reason` 与 `usage` 的那帧）会被静默丢弃 ⇒ `max_tokens` 被误报
 *    成 `stop`、usage 永远是 0。
 * 2. **`signature_delta` 必须忽略**：它是 thinking 块的签名，当文本会把一串
 *    十六进制注入回答正文。
 * 3. **流内 `error` 帧必须抛错**：静默结束会让 UI 表现为「干净地停止、无任何
 *    报错」（Qoder 早期缺陷）。
 * 4. **空响应必须抛错**：静默结束会让 harness 认为「模型正常回答但没内容」而
 *    **不重试**（与 Qoder / CodeArts 的既有约定一致）。
 *
 * ## 与 Go 侧的对齐
 *
 * 逐点对齐 `wild-work/internal/monkeycode/sse.go` 的事件集（`text` / `thinking`
 * / `tool_use` / `message_start` / `content_block_start` / `content_block_delta`
 * / `content_block_stop` / `message_delta` / `message_stop` / `error`），
 * 以及 `stop_reason` 的映射表（`sse.go:400-406`）。
 */

import type {
  ContentBlock,
  FinishReason,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

/** {@link consumeAnthropicSse} 的入参。 */
export interface ConsumeAnthropicSseOptions {
  /** SSE 字节流（`response.body`）。 */
  body: ReadableStream<Uint8Array>
  /** 外部中止信号。 */
  signal?: AbortSignal
  /**
   * 错误文案前缀（如 `'minimax'`），用于拼 `"<label>: 流内错误：…"`。
   *
   * ⚠️ 保留它而不是统一成固定文案：两个渠道的既有文案已被现场日志与测试
   * 依赖（`recovery-test.mjs` 断言 `'流内错误'`），换前缀会改变可读反馈。
   */
  errorLabel: string
  /** 空响应时的错误文案（不含前缀），如 `'模型未返回任何内容块'`。 */
  emptyMessage: string
}

/** `stop_reason` → DSH {@link FinishReason}（对齐 Go 的 `sse.go:400-406`）。 */
export function mapAnthropicStopReason(reason: unknown): FinishReason {
  const text = typeof reason === 'string' ? reason : ''
  if (text === 'tool_use') return { kind: 'tool-calls' }
  if (text === 'max_tokens') return { kind: 'max-tokens' }
  if (text === 'refusal') return { kind: 'stop' }
  // ⚠️ 未知/缺失一律 `stop`：不能编造成 `error`（那会让 harness 重试
  // 一个其实成功的响应）。
  return { kind: 'stop' }
}

/** 解析 `usage`（`message_start` 与 `message_delta` 各带一半）。 */
export function readAnthropicUsage(raw: unknown): Partial<TokenUsage> {
  if (typeof raw !== 'object' || raw === null) return {}
  const u = raw as Record<string, unknown>
  const out: Partial<TokenUsage> = {}
  const input = nonNegativeInt(u.input_tokens)
  if (input !== undefined) out.inputTokens = input
  const output = nonNegativeInt(u.output_tokens)
  if (output !== undefined) out.outputTokens = output
  const cacheRead = nonNegativeInt(u.cache_read_input_tokens)
  if (cacheRead !== undefined) out.cacheReadTokens = cacheRead
  const cacheWrite = nonNegativeInt(u.cache_creation_input_tokens)
  if (cacheWrite !== undefined) out.cacheWriteTokens = cacheWrite
  // ⚠️ `output_tokens_details.thinking_tokens` 是**output 的子集**，
  // 故映射到 `reasoningTokens`（不是加到 outputTokens 上）。
  const details = u.output_tokens_details
  if (typeof details === 'object' && details !== null) {
    const thinking = nonNegativeInt((details as Record<string, unknown>).thinking_tokens)
    if (thinking !== undefined) out.reasoningTokens = thinking
  }
  return out
}

export function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined
}

/**
 * 消费 Anthropic Messages SSE，产出 DSH 的 {@link StreamChunk}。
 *
 * ⚠️ 块的 `index` 直接用**服务端下发的 `index`**（不自己计数）：
 * 服务端从 0 开始为每个 content block 分配，重排会与 `block-end` 对不上。
 */
export async function* consumeAnthropicSse(
  options: ConsumeAnthropicSseOptions,
): AsyncGenerator<StreamChunk> {
  const reader = options.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  /** 最近一个 `event:` 行（帧自带 `type` 时不用它）。 */
  let eventName = ''
  /** 每个 index 的累积状态（`block-end` 要交出完整块）。 */
  const blocks = new Map<number, {
    type: 'text' | 'reasoning' | 'tool-call'
    text: string
    toolId?: string
    toolName?: string
    toolArgs: string
  }>()
  let stopReason: unknown
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  let sawAnyChunk = false

  /**
   * 处理一行 SSE。
   *
   * ⚠️ **抽成嵌套生成器是有原因的**（真实缺陷，2026-09-29 由单测抓到）：
   * 原实现只在 `while (!done)` 里按行处理，而**流结束时 `buffer` 里残留的
   * 最后一条事件永远不会被处理**。真实 SSE 大多以空行结尾（恰好掩盖了它），
   * 但**被截断的流**（连接提前关闭）会让最后那条 `message_delta`
   * —— 正是携带 `stop_reason` 与 `usage` 的那一帧 —— 被静默丢弃。
   */
  const processLine = async function* (rawLine: string): AsyncGenerator<StreamChunk> {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    // ⚠️ 空行是 SSE 的**事件终止符** ⇒ 重置 `eventName`。
    if (line === '') {
      eventName = ''
      return
    }
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
      return
    }
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const frame = parsed as Record<string, unknown>
    // ⚠️ 帧自带 `type`，优先用它（`event:` 行可能缺失或被代理吞掉）。
    const type = typeof frame.type === 'string' ? frame.type : eventName

    if (type === 'error') {
      const error = frame.error
      const message = typeof error === 'object' && error !== null
        ? String((error as Record<string, unknown>).message ?? '未知错误')
        : '未知错误'
      throw new Error(`${options.errorLabel}: 流内错误：${message}`)
    }
    if (type === 'message_start') {
      const message = frame.message
      if (typeof message === 'object' && message !== null) {
        usage = { ...usage, ...readAnthropicUsage((message as Record<string, unknown>).usage) }
      }
      return
    }
    if (type === 'content_block_start') {
      const index = nonNegativeInt(frame.index) ?? 0
      const block = frame.content_block
      if (typeof block !== 'object' || block === null) return
      const b = block as Record<string, unknown>
      const kind = b.type
      if (kind === 'thinking') {
        blocks.set(index, { type: 'reasoning', text: '', toolArgs: '' })
        sawAnyChunk = true
        yield { type: 'block-start', index, blockType: 'reasoning' }
      } else if (kind === 'text') {
        blocks.set(index, { type: 'text', text: '', toolArgs: '' })
        sawAnyChunk = true
        yield { type: 'block-start', index, blockType: 'text' }
      } else if (kind === 'tool_use') {
        const id = typeof b.id === 'string' ? b.id : ''
        const name = typeof b.name === 'string' ? b.name : ''
        blocks.set(index, { type: 'tool-call', text: '', toolId: id, toolName: name, toolArgs: '' })
        sawAnyChunk = true
        yield { type: 'block-start', index, blockType: 'tool-call' }
      }
      return
    }
    if (type === 'content_block_delta') {
      const index = nonNegativeInt(frame.index) ?? 0
      const delta = frame.delta
      if (typeof delta !== 'object' || delta === null) return
      const d = delta as Record<string, unknown>
      const state = blocks.get(index)
      if (d.type === 'text_delta' && typeof d.text === 'string') {
        if (state !== undefined) state.text += d.text
        yield { type: 'text-delta', index, text: d.text }
      } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
        if (state !== undefined) state.text += d.thinking
        yield { type: 'reasoning-delta', index, text: d.thinking }
      } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
        if (state !== undefined) state.toolArgs += d.partial_json
        yield {
          type: 'tool-call-delta',
          index,
          id: ToolCallId(state?.toolId ?? ''),
          argumentsDelta: d.partial_json,
        }
      }
      // ⚠️ `signature_delta` 刻意**不处理**：它是 thinking 块的签名，
      // 不是正文。当初把它当文本会往回答里注入一串十六进制。
      return
    }
    if (type === 'content_block_stop') {
      const index = nonNegativeInt(frame.index) ?? 0
      const state = blocks.get(index)
      if (state === undefined) return
      let block: ContentBlock
      if (state.type === 'text') {
        block = { type: 'text', text: state.text }
      } else if (state.type === 'reasoning') {
        block = { type: 'reasoning', text: state.text }
      } else {
        block = {
          type: 'tool-call',
          id: ToolCallId(state.toolId ?? ''),
          name: state.toolName ?? '',
          arguments: state.toolArgs,
        }
      }
      blocks.delete(index)
      yield { type: 'block-end', index, block }
      return
    }
    if (type === 'message_delta') {
      const delta = frame.delta
      if (typeof delta === 'object' && delta !== null) {
        stopReason = (delta as Record<string, unknown>).stop_reason
      }
      usage = { ...usage, ...readAnthropicUsage(frame.usage) }
      return
    }
    // `message_stop` / `ping` / 未知帧：忽略。
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        // ⚠️ 收尾：先刷出解码器里可能残留的不完整多字节序列，
        // 再把 buffer 余量**按整行**走一遍 —— 否则最后一条事件被丢弃。
        buffer += decoder.decode()
        if (buffer !== '') {
          const tail = buffer.split('\n')
          buffer = ''
          for (const rawLine of tail) yield* processLine(rawLine)
        }
        break
      }
      buffer += decoder.decode(value, { stream: true })
      // SSE 以空行分隔事件；按行处理，末尾不成行的部分留在 buffer 里。
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const rawLine of lines) yield* processLine(rawLine)
    }
  } finally {
    reader.releaseLock?.()
  }

  // ⚠️ 空响应必须报错：静默结束会让 harness 认为「模型正常回答但没内容」，
  // **不会重试**（与 Qoder/CodeArts 的既有约定一致）。
  if (!sawAnyChunk) {
    throw new Error(`${options.errorLabel}: ${options.emptyMessage}`)
  }
  yield { type: 'usage', usage }
  yield { type: 'finish', reason: mapAnthropicStopReason(stopReason) }
}
