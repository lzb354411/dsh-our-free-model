/**
 * 千问办公嵌套 SSE 拆壳：把双层信封流**转成标准 OpenAI SSE**，再交给
 * `consumeOpenAiSse` 消费。
 *
 * ## ⚠️ 本渠道最危险的特性：错误也走 HTTP 200
 *
 * 上游每帧是**双层**结构：
 *
 * ```
 * data:{"headers":{…},"body":"<内层 JSON 字符串>","statusCodeValue":200,"statusCode":"OK"}
 * ```
 *
 * `body` 里才是真正的 OpenAI chunk，而且**多以字符串承载**（需二次解析）。
 * 更关键：网关对错误（缺 `request_id`、权益不足、模型目录不可用）**同样返回
 * HTTP 200**，真实状态码藏在 `statusCodeValue` 里。
 *
 * ⇒ **只看 HTTP 状态码会把失败当成「正常但内容为空」**。Go 侧模块注释明确记录了这个坑。
 *
 * ## 为什么「拆壳 + 复用通用消费器」而不是自己写一套消费器
 *
 * 与 Go 的分层完全同构：Go 里 `parseNestedSSE`（拆壳）与 `streamAsOpenAI`（转写）
 * 是两层，而 `consumeOpenAiSse` 就是 TS 侧的 `streamAsOpenAI` 等价物 —— 它已经承载了
 * 大量实测修复：思考/正文双通道死循环守卫、块组装、tool_calls 按 index 合并、
 * usage 归一、截断检测（无 finish_reason 且无 `[DONE]` → 报 `max-tokens` 而非
 * 谎报 `stop`）、空响应判定。
 *
 * **自己重写那 1200 行等于把这些修复全部丢掉** —— 它们每一条都对应一次真实报障。
 * 故本文件只做「拆壳」这一件事：产出标准 OpenAI SSE 文本，其余全部委托。
 *
 * ## 截断语义（与前一层对齐的关键）
 *
 * 上游的正常收尾是**信封内的** `body:"[DONE]"`（注意：不是客户端可见的
 * `data: [DONE]` 帧）。本模块据此决定是否向消费器补一个真正的 `data: [DONE]`：
 *
 * - 正常收尾（含上游漏发 `[DONE]` 但帧完整）→ 补 `data: [DONE]`；
 * - **读流中断 / 半帧** → **不补** `[DONE]` ⇒ 消费器据此判 `truncatedStream`
 *   并报 `max-tokens`（而不是谎报 `stop`，让客户端拿着半截 tool_call 参数去解析）。
 */

import { LlmError } from '@deepseek-ai/dsh-llm'

/**
 * 上游信封。
 *
 * ⚠️ `body` 用 `unknown` 承接：实测可能是**字符串**（最常见）、**对象**、
 * 空串、`"[DONE]"` 或 `"{}"` 五种形态。用具体类型会在某些形态下丢内容或解析失败。
 */
export interface QwenworkEnvelope {
  headers?: Record<string, unknown>
  body?: unknown
  statusCodeValue?: number
  statusCode?: string
}

/**
 * 从信封提取错误文案；非错误返回空串。
 *
 * 判据是 `statusCodeValue >= 400`（**不是** HTTP 状态码）。
 */
export function qwenworkEnvelopeError(envelope: QwenworkEnvelope): string {
  const status = envelope.statusCodeValue
  if (typeof status !== 'number' || status < 400) return ''
  const body = envelope.body
  // 形态一：{"code":"402","message":"..."}
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const record = body as Record<string, unknown>
    const message = record.message
    if (typeof message === 'string' && message.length > 0) return message
    const code = record.code
    if (typeof code === 'string' && code.length > 0) return code
  }
  // 形态二：纯字符串
  if (typeof body === 'string') return body.trim().slice(0, 200)
  return '上游返回未知错误'
}

/**
 * 解出内层 OpenAI chunk；无有效内容返回 `undefined`。
 *
 * 五种 `body` 形态：
 * - **字符串**（最常见）：先解字符串、再解 JSON。空串 / `[DONE]` / `{}` 视为无内容。
 * - **对象**：直接用；空对象视为无内容。
 * - **其它**（数字、布尔、null、数组）：视为无内容（不报错）。
 *
 * ⚠️ 内层解析失败**返回 undefined 而不是抛错**：个别畸形帧不该中断整个流
 *（中断会让用户「回答到一半停住」，而跳过只损失一帧）。
 */
export function qwenworkInnerChunk(envelope: QwenworkEnvelope): Record<string, unknown> | undefined {
  const body = envelope.body
  if (body === undefined || body === null) return undefined

  // 场景 1: body 是字符串（内层 JSON 文本）
  if (typeof body === 'string') {
    const text = body.trim()
    if (text === '' || text === '[DONE]' || text === '{}') return undefined
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
      const record = parsed as Record<string, unknown>
      return Object.keys(record).length === 0 ? undefined : record
    } catch {
      return undefined
    }
  }

  // 场景 2: body 已是对象
  if (typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>
    return Object.keys(record).length === 0 ? undefined : record
  }

  return undefined
}

/**
 * 上游是否在这一帧宣告结束（信封内 `body` 为 `"[DONE]"`）。
 *
 * ⚠️ 这是**上游的**结束信号，与客户端可见的 `data: [DONE]` 不是一回事。
 * 本模块用它决定是否补发客户端可见的收尾帧。
 */
export function qwenworkEnvelopeSaysDone(envelope: QwenworkEnvelope): boolean {
  return typeof envelope.body === 'string' && envelope.body.trim() === '[DONE]'
}

/** 一帧解析结果。 */
export type QwenworkFrame =
  /** 正常内容帧（已剥壳）。 */
  | { kind: 'chunk'; chunk: Record<string, unknown> }
  /** 业务错误帧（`statusCodeValue >= 400`）。 */
  | { kind: 'error'; status: number; message: string }
  /** 上游宣告结束（信封内 `[DONE]`）。 */
  | { kind: 'done' }
  /** 无内容帧（空 body / `{}`），跳过即可。 */
  | { kind: 'empty' }
  /** 外层不是合法 JSON（畸形帧），跳过。 */
  | { kind: 'malformed' }

/**
 * 解析一帧 `data:` 载荷。
 *
 * ⚠️ 顺序很重要：**先判错误、再判结束、最后取内容** —— 上游的错误帧与结束帧
 * 也可能带 `body`，先取内容会把它们当正常 chunk 透传。
 */
export function parseQwenworkFrame(payload: string): QwenworkFrame {
  let envelope: QwenworkEnvelope
  try {
    const parsed: unknown = JSON.parse(payload)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { kind: 'malformed' }
    }
    envelope = parsed as QwenworkEnvelope
  } catch {
    return { kind: 'malformed' }
  }

  const status = typeof envelope.statusCodeValue === 'number' ? envelope.statusCodeValue : 0
  // 步骤 1: 剥壳判错（本模块的核心价值）
  if (status >= 400) {
    return { kind: 'error', status, message: qwenworkEnvelopeError(envelope) }
  }
  // 步骤 2: 上游宣告结束
  if (qwenworkEnvelopeSaysDone(envelope)) return { kind: 'done' }
  // 步骤 3: 取内层内容
  const chunk = qwenworkInnerChunk(envelope)
  return chunk === undefined ? { kind: 'empty' } : { kind: 'chunk', chunk }
}

/** {@link deEnvelopeQwenworkSse} 的选项。 */
export interface DeEnvelopeOptions {
  /** 错误消息前缀（`qwenwork`）。 */
  label?: string
  /** 客户端模型名；用于把 chunk 里的 `model` 改写成客户端侧的名字。 */
  model?: string
  /**
   * 上游是否**可证实地**截断（读流报错 / 停在半帧）。
   *
   * 由本模块在流结束时回填，供调用方判断（诊断用）。
   */
  truncatedRef?: { value: boolean }
}

/**
 * 把千问办公嵌套 SSE 流转成标准 OpenAI SSE 文本流。
 *
 * 产出保证：
 * 1. 内容帧一律形如 `data: <OpenAI chunk JSON>\n\n`，并已把 `model` 改写成客户端模型名
 *（上游回显的是档位 key）；
 * 2. 业务错误（信封 ≥400）转成 `data: {"error":{"message":…,"code":…}}` 帧 ——
 *    `consumeOpenAiSse` 见到顶层 `error` 会抛 `LlmError`（SERVER）；
 * 3. 正常收尾补**恰好一个** `data: [DONE]`；
 * 4. **截断时不补** `[DONE]`，让消费器判出 `max-tokens` 而不是谎报正常结束。
 */
export function deEnvelopeQwenworkSse(
  response: Response,
  options: DeEnvelopeOptions = {},
): ReadableStream<Uint8Array> {
  const label = options.label ?? 'qwenwork'
  const encoder = new TextEncoder()

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const body = response.body
      if (body === null) {
        controller.error(new LlmError(`${label}: empty model response body`, 'EMPTY_RESPONSE'))
        return
      }
      const reader = body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let sawDataFrame = false
      let sawUpstreamDone = false
      /** 可证实的截断（读流报错 / 停在半帧）。 */
      let truncated = false

      const emit = (line: string): void => {
        controller.enqueue(encoder.encode(line))
      }

      try {
        for (;;) {
          let result: ReadableStreamReadResult<Uint8Array>
          try {
            result = await reader.read()
          } catch (error) {
            // 传输层读错误 = 可证实的截断。不补 [DONE]，并原样抛出以便消费器
            // 判 TRANSPORT（`readWithIdleTimeout` 那一层）。
            truncated = true
            throw error
          }
          if (result.done) break
          buffer += decoder.decode(result.value, { stream: true })

          let newlineIndex = buffer.indexOf('\n')
          while (newlineIndex !== -1) {
            const rawLine = buffer.slice(0, newlineIndex)
            buffer = buffer.slice(newlineIndex + 1)
            const line = rawLine.replace(/\r$/, '')
            if (line.startsWith('data:')) {
              sawDataFrame = true
              const payload = line.slice(5).trim()
              if (payload.length > 0) {
                const frame = parseQwenworkFrame(payload)
                if (frame.kind === 'error') {
                  // 场景 1: 业务错误（HTTP 200 + 信封 ≥400）
                  // WHY 转成 error 帧而不是直接抛：**保持单一错误出口**。
                  // 消费器对 `data: {"error":…}` 的处理已经过实测（含 code/message
                  // 形态判定），从这里抛会是第二条路径、两处口径容易漂移。
                  emit(`data: ${JSON.stringify({
                    error: { message: frame.message, code: frame.status },
                  })}\n\n`)
                  sawUpstreamDone = true
                  return
                }
                if (frame.kind === 'done') {
                  // 场景 2: 上游宣告结束
                  sawUpstreamDone = true
                } else if (frame.kind === 'chunk') {
                  // 场景 3: 正常内容帧 —— 改写 model 后原样透传
                  const chunk = options.model === undefined
                    ? frame.chunk
                    : { ...frame.chunk, model: options.model }
                  emit(`data: ${JSON.stringify(chunk)}\n\n`)
                }
                // frame.kind === 'empty' / 'malformed' → 跳过
              }
            }
            newlineIndex = buffer.indexOf('\n')
          }
        }

        // 步骤: 收尾处理
        // ⚠️ 半帧判定：读完时 buffer 里还有非空残留 ⇒ 最后一帧没有换行收尾
        //    ⇒ 停在半个帧上，属可证实的截断。
        if (buffer.trim().length > 0) truncated = true

        if (options.truncatedRef !== undefined) options.truncatedRef.value = truncated

        if (truncated) {
          // **不补 [DONE]**：让消费器判出 max-tokens（见文件头「截断语义」）
        } else {
          // 正常收尾：补恰好一个 [DONE]。
          // ⚠️ 即使上游漏发 [DONE] 也要补 —— 帧完整时那是「上游省略」，不是截断。
          emit('data: [DONE]\n\n')
        }

        // 一帧 data 都没读到 ⇒ 这根本不是 SSE（网关回了 JSON 错误体）。
        // 静默结束会让客户端表现为「干净地停止、无任何报错」（真实缺陷同型）。
        if (!sawDataFrame) {
          controller.error(new LlmError(
            `${label}: 上游响应不是 SSE 流（未收到任何 data 帧）`,
            'EMPTY_RESPONSE',
          ))
          return
        }
        void sawUpstreamDone
        controller.close()
      } catch (error) {
        controller.error(error)
      } finally {
        // ⚠️ `.catch(() => {})` 不可省：连接已断时 cancel() 会抛错，
        // 不吞掉会把真正的错误盖掉。
        await reader.cancel().catch(() => {})
      }
    },
  })
}
