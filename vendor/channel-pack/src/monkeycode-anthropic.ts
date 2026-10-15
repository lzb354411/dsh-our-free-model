/**
 * MonkeyCode 的 **Anthropic Messages 面**请求体构造。
 *
 * ## 与 MiniMax 的同异（这是能复用共享层的原因）
 *
 * | | MiniMax | MonkeyCode |
 * |---|---|---|
 * | 协议族 | Anthropic Messages | Anthropic Messages（**同族**） |
 * | 消息投影 | `serializeAnthropicMessages` | **完全复用同一个** |
 * | 鉴权 | Bearer | **`X-Api-Key` + `X-Ohmyagent-Signature`** |
 * | `system[0]` | 客户端 system | **恒为固定签名常量**，客户端 system 排到后 |
 * | `thinking` | 按 `effort` 决策表 | 只需「开/关」两态（本面**无档位**） |
 *
 * ## ⚠️ 与 Go 侧的关键差异：`tool_choice` **在 TS 侧根本不存在**
 *
 * Go 的 `buildAnthropicBody` 里有一整段 `tool_choice: "none"` → 裁掉整个 `tools`
 * 的逻辑（`request.go:82-90`）。那段存在的原因是 **Go 侧转发客户端的原始
 * OpenAI body**，body 里可能带 `tool_choice`。
 *
 * TS 侧不同：本插件自己构造 body，而 DSH 的 `GenerateOptions` **没有
 * `toolChoice` 字段**（已核实 `dsh-llm` 类型与仓库既有结论
 * `lobsterai-adapter.ts:14` / `gemini-adapter.ts:17-18`）⇒ 该字段天然不会出现，
 * 故**不需要**（也无法）移植那段逻辑。
 *
 * ## ⚠️ 必须强制 `stream: true`
 *
 * 渠道层契约是「`stream()` 产出 SSE 帧」；透传 `false` 时上游回**单个 JSON
 * 对象**，会被 SSE 消费器当作非 `data:` 行整包丢弃 ⇒ **HTTP 200 但 content
 * 空、usage 0 的静默失败**（`request.go:55-60` 记录的实测踩坑）。
 *
 * 移植来源：`wild-work/internal/monkeycode/request.go`（Go，只读参考）。
 */

import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { serializeAnthropicMessages, type AnthropicInlineImage } from './anthropic-messages.js'
import {
  MONKEYCODE_ANTHROPIC_VERSION,
  MONKEYCODE_MAX_TOKENS_CAP,
  MONKEYCODE_MAX_TOKENS_DEFAULT,
  MONKEYCODE_SIGNATURE_SYSTEM_PROMPT,
  MONKEYCODE_USER_AGENT,
  toUpstreamModelId,
} from './monkeycode.js'

/** `max_tokens` 的取值与钳制（对齐 Go 的 `maxTokens`）。 */
export function resolveMaxTokens(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined
  if (n === undefined || n <= 0) return MONKEYCODE_MAX_TOKENS_DEFAULT
  return n > MONKEYCODE_MAX_TOKENS_CAP ? MONKEYCODE_MAX_TOKENS_CAP : n
}

/**
 * Anthropic 面的 `thinking` 投影（**只有开/关两态**）。
 *
 * ## 实测依据（2026-09-24 VM 真实上游）
 *
 * - 上游**默认开着**思考（不传 `thinking`：64 个 thinking 帧 / output 69）；
 * - `{type:"disabled"}` 确实关掉（0 帧 / output 14）；
 * - `{type:"enabled"}` 与「不传」等价（65 帧 / output 70）；
 * - `budget_tokens` 被接受但**对思考量无可测影响** ⇒ **不下发**；
 * - `effort` 型模型（25 个托管模型里仅 `pro/kimi-k2.6`）官方客户端会发
 *   `{type:"adaptive"}` + `output_config.effort`，本面按「开/关」简化处理
 *   （Go 侧同样如此，见 `request.go:127-129` 的已知缺口说明）。
 *
 * 策略（两面统一，2026-09-24 拍板）：
 * - 客户端明确表达任何档位（`low`/`medium`/`high`…）→ **开**；
 * - `none` → **关**；
 * - **未表达 → 开**（显式补 `enabled`，不依赖上游默认值不变）。
 */
export function thinkingForEffort(
  reasoningEffort: string | undefined,
): { type: 'disabled' | 'enabled' } {
  const level = typeof reasoningEffort === 'string' ? reasoningEffort.trim().toLowerCase() : ''
  if (level === 'none') return { type: 'disabled' }
  return { type: 'enabled' }
}

/** {@link buildMonkeycodeAnthropicBody} 的入参。 */
export interface BuildMonkeycodeAnthropicBodyOptions {
  /** **对外**模型 ID（`monkeycode/basic/x`）；函数内部转成上游形态。 */
  model: string
  messages: readonly Message[]
  /** 客户端 system 提示；会被放到 `system[1..]`（`system[0]` 恒为签名常量）。 */
  system?: string
  tools?: readonly ToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: readonly string[]
  /** 已解析的思考档位（`'none'` 表示关闭）。 */
  reasoningEffort?: string
  /** 已内联的图片（attachmentId → base64）。 */
  images?: ReadonlyMap<string, AnthropicInlineImage>
}

/**
 * 构造 Anthropic Messages 形状的出站 body。
 *
 * ⚠️ 纯函数（不碰网络、不碰凭据），便于单测逐字节锁死形状。
 *
 * ⚠️ **`system` 走顶层数组**（Anthropic 协议），**不是**一条 `{role:'system'}`
 * 消息 —— Anthropic Messages 端点不接受 system 角色消息。
 */
export function buildMonkeycodeAnthropicBody(
  options: BuildMonkeycodeAnthropicBodyOptions,
): Record<string, unknown> {
  // system：第 0 条恒为签名对象（它的 text 参与 HMAC），客户端内容排在其后。
  const system: Array<Record<string, unknown>> = [
    { type: 'text', text: MONKEYCODE_SIGNATURE_SYSTEM_PROMPT },
  ]
  if (options.system !== undefined && options.system.trim() !== '') {
    system.push({ type: 'text', text: options.system })
  }

  const payload: Record<string, unknown> = {
    model: toUpstreamModelId(options.model),
    max_tokens: resolveMaxTokens(options.maxTokens),
    system,
    messages: serializeAnthropicMessages(options.messages, options.images, 'monkeycode'),
    // ⚠️ 恒为 true（见文件头「必须强制 stream」）。
    stream: true,
    thinking: thinkingForEffort(options.reasoningEffort),
  }
  if (options.temperature !== undefined) payload.temperature = options.temperature
  if (options.stop !== undefined && options.stop.length > 0) payload.stop_sequences = [...options.stop]
  if (options.tools !== undefined && options.tools.length > 0) {
    payload.tools = options.tools.map((tool) => ({
      name: tool.name,
      ...(typeof tool.description === 'string' && tool.description !== ''
        ? { description: tool.description }
        : {}),
      // ⚠️ Anthropic 要求 `input_schema` 是对象；缺参数时给空 object schema
      //（不能省略，否则上游 400）。
      input_schema: tool.parameters ?? { type: 'object', properties: {} },
    }))
  }
  return payload
}

/** MonkeyCode 推理请求头。 */
export function monkeycodeInferHeaders(options: {
  apiKey: string
  signature: string
  /** 该模型是否走 Responses 面（决定是否带 `anthropic-version`）。 */
  responsesFace: boolean
}): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'X-Api-Key': options.apiKey,
    'X-Ohmyagent-Signature': options.signature,
    'user-agent': MONKEYCODE_USER_AGENT,
  }
  // ⚠️ `anthropic-version` **只在 anthropic 面发送**（Go `client.go:228-236`）；
  // Responses 面带上它没有意义（上游按 OpenAI Responses 解析）。
  if (!options.responsesFace) headers['anthropic-version'] = MONKEYCODE_ANTHROPIC_VERSION
  return headers
}
