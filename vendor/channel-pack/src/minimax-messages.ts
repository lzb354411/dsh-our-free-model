/**
 * MiniMax **Anthropic Messages** 协议层：请求体构造 + SSE 消费。
 *
 * ## 为什么单独一个文件
 *
 * 本 provider 的 Anthropic 族协议层，拆开后可用单测逐字节锁死形状。
 * **不复用** `openai-compat.ts`（那是 OpenAI 形状，硬套会把 `tools`/
 * `tool_calls`/`input_json_delta` 全部翻译错）。
 *
 * ## ⚠️ A 阶段重构：通用部分已抽到共享层
 *
 * 本文件原注释写「**不做**通用 Anthropic 层抽象 —— 目前只有一个消费者，
 * 抽象会凭空多一层间接（Qoder 的教训是『同族第二个产品出现时再抽』）」。
 * **MonkeyCode 就是第二个消费者**（走 Anthropic `/messages` 面）⇒ 依约抽出：
 *
 * | 通用部分 | 新落点 |
 * |---|---|
 * | 消息序列化（DSH `Message[]` → Anthropic `messages`） | `anthropic-messages.ts` |
 * | SSE 消费、`stop_reason` 映射、usage 解析 | `anthropic-sse.ts` |
 *
 * ⚠️ 本文件保留**对外 API 别名**（`serializeMinimaxMessages` /
 * `MinimaxInlineImage` / `readMinimaxUsage` / `mapMinimaxStopReason` /
 * `consumeMinimaxSse`），签名与**错误文案逐字不变**：
 * - `'minimax: 图片未能内联（附件服务不可用或读取失败），拒绝发出缺少图片的请求'`
 * - `'minimax: 流内错误：…'` / `'minimax: 模型未返回任何内容块'`
 *
 * 等价性由 `scripts/anthropic-sse-test.mjs` 锁死（重构前即全绿，重构后仍全绿）。
 *
 * ## 实测确认的协议事实（2026-09-29，真实请求）
 *
 * 端点 `POST {apiHost}/mavis/api/v1/llm/v1/messages`，`stream: true`：
 *
 * | 事件 | 用途 |
 * |---|---|
 * | `message_start` | `usage.input_tokens`、`cache_read_input_tokens` |
 * | `ping` | 保活（**必须忽略**） |
 * | `content_block_start` | `content_block.type` ∈ `thinking` / `text` / `tool_use` |
 * | `content_block_delta` | `thinking_delta` / `text_delta` / `signature_delta` / `input_json_delta` |
 * | `content_block_stop` | 该块结束 |
 * | `message_delta` | `stop_reason`、`usage.output_tokens`（含 `thinking_tokens`） |
 * | `message_stop` | 结束 |
 * | `error` | `{type:'error', error:{type,message}}` |
 *
 * ⚠️ **`signature_delta` 必须忽略**（那是 thinking 块的签名，不是正文）；
 * 把它当文本会往回答里注入一串十六进制。
 *
 * ⚠️ **`thinking` 块要映射成 `reasoning` 块**（DSH 的 `ReasoningBlock`），
 * 否则思考内容会污染正文。
 *
 * ## ⚠️ 思考档位：`effort` 的两种下发形态（实测）
 *
 * - `MiniMax-M3.1-Flash-Preview`：**必须** `thinking.type='adaptive'`；
 *   传 `disabled` 会被服务端拒：
 *   `400 invalid_request_error ... requires adaptive thinking; thinking.type="disabled"
 *   (including reasoning.effort=none) is not allowed (2013)`。
 *   档位通过 **`output_config.effort`** 下发（客户端 `requestPatch` 同款）。
 * - M3 / M2.7 / M2.7-highspeed：**不传 `thinking` 即接受**（实测 200），
 *   且服务端**默认就会思考**（M2.7 实测 `thinking_tokens: 250`）。
 *   它们没有 `effort_options`，故不发 `output_config`。
 *
 * ⚠️ **所以「不发 thinking」是安全默认**（实测 200），
 * 不要为了「显式关闭」而发 `disabled` —— 那对 M3.1 是**硬 400**。
 */

import type {
  FinishReason,
  Message,
  StreamChunk,
  ToolSchema,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import {
  consumeAnthropicSse,
  mapAnthropicStopReason,
  readAnthropicUsage,
} from './anthropic-sse.js'
import {
  serializeAnthropicMessages,
  type AnthropicInlineImage,
} from './anthropic-messages.js'

/** 已内联的图片（attachmentId → base64 与 mediaType）。 */
export type MinimaxInlineImage = AnthropicInlineImage

/**
 * 把 DSH 消息序列化为 Anthropic Messages 形状。
 *
 * ⚠️ 对外 API 别名，实现在 `anthropic-messages.ts`（见文件头）。
 */
export function serializeMinimaxMessages(
  messages: readonly Message[],
  images?: ReadonlyMap<string, MinimaxInlineImage>,
): Array<Record<string, unknown>> {
  return serializeAnthropicMessages(messages, images, 'minimax')
}

/**
 * 构造 Anthropic Messages 请求体。
 *
 * ⚠️ 纯函数（不碰网络），便于单测锁死形状 —— 与 `buildQoderInferPayload` 同思路。
 *
 * ⚠️ **`system` 走顶层 `system` 字段**（Anthropic 协议），**不是**一条
 * `{role:'system'}` 消息 —— Anthropic Messages 端点不接受 system 角色消息。
 */
export function buildMinimaxMessagesPayload(options: {
  model: string
  messages: readonly Message[]
  system?: string
  tools?: readonly ToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: readonly string[]
  /** 已解析的思考档位；`undefined` 表示不发（服务端默认行为）。 */
  effort?: string
  /** 该模型是否**必须** adaptive thinking（只有 M3.1-Flash-Preview 是）。 */
  requiresAdaptiveThinking?: boolean
  /** 已内联的图片（attachmentId → base64）。缺失时遇图**抛错**。 */
  images?: ReadonlyMap<string, MinimaxInlineImage>
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: options.model,
    stream: true,
    messages: serializeMinimaxMessages(options.messages, options.images),
  }
  if (options.maxTokens !== undefined) payload.max_tokens = options.maxTokens
  if (options.system !== undefined && options.system !== '') payload.system = options.system
  if (options.temperature !== undefined) payload.temperature = options.temperature
  if (options.stop !== undefined && options.stop.length > 0) payload.stop_sequences = [...options.stop]
  if (options.tools !== undefined && options.tools.length > 0) {
    payload.tools = options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }))
  }
  // ⚠️ 思考形态，决策表（依据真机实测，见 AGENTS.md 8.1）：
  //
  // | 情形 | 请求体 | 实测行为 |
  // |---|---|---|
  // | `effort === 'none'`（用户选「关闭思考」） | `thinking:{type:'disabled'}` | 0 思考字符 |
  // | `effort === 'on'`（用户选「开启思考」，M3 的 `switchable`） | `thinking:{type:'adaptive'}` | 2785+ 字符 |
  // | 有档位 effort | `thinking:{type:'adaptive'}` + `output_config.effort` | 档位真的改变思考量 |
  // | `requiresAdaptiveThinking`（M3.1，无 effort） | `thinking:{type:'adaptive'}` | 必须，否则 400 |
  // | 其余（M2.7 系，无档位） | **整个不发** | 服务端默认思考（forced_on） |
  //
  // ⚠️⚠️ **M3 不发 `thinking` 时默认「不思考」**（两轮实测各 0 字符），
  // 所以「开启思考」**必须显式发 `adaptive`** —— 这正是 `on` 档存在的理由。
  //
  // ⚠️ `none` / `on` **只对 `switchable` 的模型可达**：`minimaxReasoningInfo`
  // 只给 switchable 追加这两档。故这里不会把 `disabled` 发给 M3.1
  //（那会被硬拒 400）或 M2.7（那会被静默忽略）。
  if (options.effort === 'none') {
    payload.thinking = { type: 'disabled' }
    return payload
  }
  if (options.effort === 'on') {
    payload.thinking = { type: 'adaptive' }
    return payload
  }
  if (options.requiresAdaptiveThinking === true) {
    payload.thinking = { type: 'adaptive' }
    if (options.effort !== undefined) payload.output_config = { effort: options.effort }
  } else if (options.effort !== undefined) {
    payload.thinking = { type: 'adaptive' }
    payload.output_config = { effort: options.effort }
  }
  return payload
}

/**
 * 把 Anthropic 的 `stop_reason` 映射为 DSH 的 {@link FinishReason}。
 *
 * ⚠️ A 阶段起委托通用层 `anthropic-sse.ts` 的 `mapAnthropicStopReason`：
 * 两张映射表**必须同源**，否则同族两个渠道对同一个 `stop_reason` 会给出
 * 不同结果（`max_tokens` 被误判成 `stop` 会让 harness 误以为正常收尾）。
 */
export function mapMinimaxStopReason(reason: unknown): FinishReason {
  return mapAnthropicStopReason(reason)
}

/**
 * 解析 `usage` 字段（`message_start` 与 `message_delta` 各带一半）。
 *
 * ⚠️ A 阶段起委托通用层 `anthropic-sse.ts`，本函数保留为**对外 API 的稳定
 * 别名**，行为逐字不变。
 */
export function readMinimaxUsage(raw: unknown): Partial<TokenUsage> {
  return readAnthropicUsage(raw)
}

/** {@link consumeMinimaxSse} 的入参。 */
export interface ConsumeMinimaxSseOptions {
  /** SSE 字节流（`response.body`）。 */
  body: ReadableStream<Uint8Array>
  /** 外部中止信号。 */
  signal?: AbortSignal
}

/**
 * 消费 Anthropic Messages SSE，产出 DSH 的 {@link StreamChunk}。
 *
 * ⚠️ **薄委托**：实现在 `anthropic-sse.ts` 的 `consumeAnthropicSse`。
 * 本函数只把 `errorLabel` / `emptyMessage` 固定为 MiniMax 的既有文案，
 * 从而保证**对外行为与文案逐字不变**：
 *
 * - `'minimax: 流内错误：…'`（`error` 帧）
 * - `'minimax: 模型未返回任何内容块'`（空响应）
 *
 * ⚠️ 保留这两条文案是刻意的：`recovery-test.mjs` 与现场日志依赖它们，
 * 换成通用文案会改变可读反馈（见 `anthropic-sse.ts` 的 `errorLabel` 注释）。
 */
export async function* consumeMinimaxSse(
  options: ConsumeMinimaxSseOptions,
): AsyncGenerator<StreamChunk> {
  yield* consumeAnthropicSse({
    body: options.body,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    errorLabel: 'minimax',
    emptyMessage: '模型未返回任何内容块',
  })
}
