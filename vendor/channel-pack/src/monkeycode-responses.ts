/**
 * MonkeyCode 的 **OpenAI Responses 面**（`POST {base}/responses`）。
 *
 * ## 为什么这支必须与 `/messages` 面分开实现
 *
 * 官方客户端 `settings.json` 把 25 个托管模型分成两类，**实测行为完全不同**
 * （2026-09-24，wild-work 评估文档 §3.9）：
 *
 * | 模型类型 | 端点 | 签名对象 |
 * |---|---|---|
 * | `anthropic` | `POST {base}/messages` | `system[0].text` |
 * | `openai-responses` | `POST {base}/responses` | **`input[0]`（role=system）的 `content`** |
 *
 * 本渠道走 Responses 面的 4 个模型（见 `monkeycode.ts` 的
 * `MONKEYCODE_RESPONSES_MODELS`）：`basic/qwen3.8-flash`、
 * `pro/gpt-5.6-terra`、`ultra/gpt-5.6-sol`、`ultra/gpt-6-astra`。
 *
 * 把 responses 型模型的请求打到 `/messages` 会得到 **404「路由不存在」**；
 * 反过来把签名串放进 `instructions` 或顶层 `system` 则 **一律 403**
 * —— 上游只校验 `input[0]` 的 `role=system` 条目。
 *
 * ## 六条必须保留的行为（每条都对应一次实测踩坑，勿"优化"掉）
 *
 * 1. **签名对象恒为 `input[0]`**：`{role:'system', content:<签名常量>}` 必须是
 *    `input` 的第一条，客户端消息全部排在其后（`buildMonkeycodeResponsesBody`）。
 * 2. **强制 `stream: true`**：按客户端意图透传 `false` 时上游回**单个 JSON
 *    对象**，会被 SSE 消费器整包丢弃 ⇒ **HTTP 200 但 content 空、usage 0 的
 *    静默失败**（Go `request.go:55-60` 记录的实测踩坑）。非流式由上层聚合。
 * 3. **长度上限字段是 `max_output_tokens`**（不是 `max_tokens`）：取值逻辑
 *    直接复用 Anthropic 面已导出的 `resolveMaxTokens`（缺省 16384 / 上限 32000），
 *    两面口径必须同源。
 * 4. **`reasoning` 只在客户端明确表达时下发**：上游 `reasoning.effort` 是
 *    **有效**的（2026-09-24 VM 实测：`none` → `reasoning_tokens` 0，即**确实
 *    能关掉**；low/minimal ≈ 130~150；medium/high ≈ 180~800）。非法值上游
 *    **不报错、静默回落默认档**（`bogus` → 293，与不传等价）⇒ 只转发客户端
 *    明确表达的值，既不本地猜测也不静默吞掉；**未表达则不下发该字段**
 *    （= 上游默认档，实测即开）。这里不补默认档是因为本面的"开"必须附带档位
 *    值，凭空选档等于替客户端决定思考强度。
 * 5. **`input` 是「条目流」而不是纯消息流**：assistant 的正文与工具调用要拆成
 *    `{role:'assistant',content:[{type:'output_text',…}]}` 与**顶层**
 *    `{type:'function_call',call_id,name,arguments}` 两类条目；工具结果不是
 *    `message.content` 里的块，而是**顶层** `{type:'function_call_output',…}`。
 * 6. **消息必须先归一化 + 工具配对必须先剔除孤儿**：复用
 *    `normalizeHarnessMessages` 与 `resolveToolPairing`（全仓唯一口径）。
 *    dsh 0.1.7+ 把工具结果改成一等 `role:'tool'` 消息，不归一化会让
 *    `tool-result` 判据恒不命中 ⇒ **工具调用被整体剔除**。
 *
 * ## 与 Go 侧的三处已知差异（有意为之，逐条有据）
 *
 * | 项 | Go（`internal/monkeycode/responses.go`） | 本文件 | 依据 |
 * |---|---|---|---|
 * | user 纯文本 `content` 形态 | 注释写「用字符串形态」，**代码实际下发单元素 `input_text` 部件数组** | 与 Go **代码**一致（部件数组） | 上游两种形态都接受，以代码为准 |
 * | `tool_choice: "none"` → 裁掉 tools | 有（`responses.go:88`） | **不移植** | DSH `GenerateOptions` 没有 `toolChoice` 字段（见 `anthropic-messages.ts` 文件头），该字段天然不会出现 |
 * | 空名字 `function_call` | 照发（有持久化毒块风险） | **整块压制** | 空名字工具块会被 harness 执行成 `unknown tool ""` 并**持久化进会话**，此后每次请求原样重放 → 整条会话报废（`sse.ts:211-231` 记载的 400/11133） |
 *
 * ⚠️ **`stop` 不下发**：Go 的 `buildResponsesBody` **没有**任何 `stop` 处理
 * （对比 Anthropic 面有 `stop_sequences`）⇒ 本面同样不下发。接口保留该字段
 * 只是为了对齐调用方签名，传了也不进 body。
 *
 * 移植来源：`wild-work/internal/monkeycode/responses.go`（Go，只读参考）。
 */

import type {
  ContentBlock,
  FinishReason,
  Message,
  StreamChunk,
  TokenUsage,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AnthropicInlineImage } from './anthropic-messages.js'
import { normalizeHarnessMessages } from './message-shape.js'
import { hasUsableToolName, normalizeToolArguments, resolveToolPairing } from './sse.js'
import { MONKEYCODE_SIGNATURE_SYSTEM_PROMPT, toUpstreamModelId } from './monkeycode.js'
import { resolveMaxTokens } from './monkeycode-anthropic.js'

/** 出站 body 里的自由记录（Responses 的 entry 是弱结构，逐键构造最清楚）。 */
type AnyRecord = Record<string, unknown>

/** 只认真正的对象（数组/null 都不算）。 */
function asRecord(value: unknown): AnyRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as AnyRecord)
    : undefined
}

/** 只认字符串（其余一律 undefined，避免把数字/对象当文本拼进去）。 */
function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 非负整数（上游 usage 可能给小数/负数）。 */
function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined
}

/** 把内容归一成块数组（字符串 → 单元素数组；对齐 Go 的 `contentBlocks`）。 */
function contentBlocks(value: unknown): readonly unknown[] {
  if (typeof value === 'string') return value === '' ? [] : [value]
  if (Array.isArray(value)) return value
  return []
}

/**
 * 把内容（字符串或块数组）压成纯文本（对齐 Go 的 `flattenText`）。
 *
 * ⚠️ 只取 `text` 字段：图片/工具结果里的二进制不进 `function_call_output.output`
 *（Responses 的该字段是文本；Go 同样只拼文本）。
 */
function flattenText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  let out = ''
  for (const block of value) {
    if (typeof block === 'string') {
      out += block
      continue
    }
    const record = asRecord(block)
    if (record === undefined) continue
    const text = asText(record.text)
    if (text !== undefined) out += text
  }
  return out
}

/** {@link buildMonkeycodeResponsesBody} 的入参。 */
export interface BuildMonkeycodeResponsesBodyOptions {
  /** **对外**模型 ID（`monkeycode/ultra/gpt-6-astra`）；函数内部转成上游形态。 */
  model: string
  /** DSH 的会话消息（内部先做形状归一化与工具配对剔除）。 */
  messages: readonly Message[]
  /**
   * 客户端 system 提示；作为 `input[1]`（紧跟签名对象）下发。
   *
   * ⚠️ **绝不能**塞进 `instructions` 或顶层 `system` 字段 —— 上游只对
   * `input[0]` 做签名校验，那两处一律 403。
   */
  system?: string
  tools?: readonly ToolSchema[]
  temperature?: number
  maxTokens?: number
  /** ⚠️ 接受但**不下发**（Go 的 responses 面没有该字段，见文件头差异表）。 */
  stop?: readonly string[]
  /** 已解析的思考档位（`'none'` 表示关闭，**原样转发**）。 */
  reasoningEffort?: string
  /** 已内联的图片（attachmentId → base64），转成 `input_image` 的 data URL。 */
  images?: ReadonlyMap<string, AnthropicInlineImage>
}

/**
 * 图片块 → Responses 的 `input_image.image_url`（data URL）。
 *
 * ⚠️ 内联失败**显式抛错，不静默丢图** —— 与 `serializeAnthropicMessages`
 * 同一原则：静默丢弃会让用户以为图片被模型看到了。
 *
 * ⚠️ 与 Go 的差异：Go 从客户端原始 OpenAI body 里取 `image_url` 字符串
 *（`responses.go:207-214` 只认 `source.url`，故 data: URL 那条路径**实测会被
 * 静默丢掉**）；本文件吃的是 DSH 的 `attachment` 引用 + 已内联的 base64，
 * 没有"原样透传 URL"这一说，故合成 data URL。
 */
function inlineImageUrl(block: AnyRecord, images?: ReadonlyMap<string, AnthropicInlineImage>): string {
  const ref = asRecord(block.attachment)
  const attachmentId = ref === undefined ? undefined : asText(ref.attachmentId)
  const inline = attachmentId === undefined ? undefined : images?.get(attachmentId)
  if (inline === undefined) {
    throw new Error(
      'monkeycode: 图片未能内联（附件服务不可用或读取失败），拒绝发出缺少图片的请求',
    )
  }
  return `data:${inline.mediaType};base64,${inline.data}`
}

/**
 * assistant 消息 → `output_text` 消息条目 + 若干 `function_call` 顶层条目。
 *
 * ⚠️ 顺序与 Go 一致：先整段正文（若存在），再依次下发工具调用条目。
 * 每条工具调用都是**独立顶层条目**（不带 `role`），这是 Responses 的硬形态。
 */
function projectAssistantItems(
  blocks: readonly unknown[],
  keepCallIds: ReadonlySet<string>,
  out: AnyRecord[],
): void {
  const parts: AnyRecord[] = []
  for (const block of blocks) {
    const record = asRecord(block)
    if (record === undefined || record.type !== 'text') continue
    const text = asText(record.text)
    if (text !== undefined && text !== '') parts.push({ type: 'output_text', text })
  }
  if (parts.length > 0) out.push({ role: 'assistant', content: parts })

  for (const block of blocks) {
    const record = asRecord(block)
    if (record === undefined || record.type !== 'tool-call') continue
    const id = asText(record.id) ?? ''
    // ⚠️ 孤儿调用不下发（否则其后的 function_call_output 成为孤儿条目）。
    if (!keepCallIds.has(id)) continue
    const name = asText(record.name) ?? ''
    // ⚠️ Go 同样跳过空名字（`responses.go:146-150` 只在 text 分支，但
    // `assistantBlocks`/`parseArgs` 链路会把空名调用丢掉）；这里显式跳过。
    if (name === '') continue
    out.push({
      type: 'function_call',
      // Go 的 id 兜底：id 为空时用 `call_<name>`（不能留空，否则结果对不上）。
      call_id: id !== '' ? id : `call_${name}`,
      name,
      // ⚠️ `arguments` 必须是**字符串**（JSON 文本），不是对象。非法 JSON 退化为
      // `{}` —— 不编造参数，但也不能丢条目（丢了后续 output 变孤儿）。
      arguments: normalizeToolArguments(asText(record.arguments) ?? ''),
    })
  }
}

/** 工具结果条目要回的调用 ID（对齐 Go 的 `responsesCallID`）。 */
function toolResultCallId(block: AnyRecord): string {
  const direct = asText(block.toolCallId) ?? asText(block.tool_call_id) ?? asText(block.call_id)
  if (direct !== undefined && direct !== '') return direct
  const name = asText(block.name)
  if (name !== undefined && name !== '') return name
  return 'call_unknown'
}

/**
 * user / 工具结果消息 → `function_call_output` 条目与 `user` 条目。
 *
 * ⚠️ 工具结果在归一化后落在 **user 消息里的 `tool-result` 块**（dsh 0.1.7 的
 * 一等 `role:'tool'` 被 `normalizeHarnessMessages` 降级回包裹形状），故这里按块
 * 判定，而不是按消息角色。
 */
function projectUserAndToolItems(
  blocks: readonly unknown[],
  keepResultIds: ReadonlySet<string>,
  images: ReadonlyMap<string, AnthropicInlineImage> | undefined,
  out: AnyRecord[],
): void {
  const plain: unknown[] = []
  for (const block of blocks) {
    const record = asRecord(block)
    if (record !== undefined && record.type === 'tool-result') {
      const callId = toolResultCallId(record)
      // ⚠️ 孤儿结果不下发（上游同样拒）；配对由 resolveToolPairing 统一裁决。
      if (!keepResultIds.has(callId)) continue
      out.push({
        type: 'function_call_output',
        call_id: callId,
        output: flattenText(record.content),
      })
      continue
    }
    plain.push(block)
  }

  const parts: AnyRecord[] = []
  // 「全是纯文本」时合并成**一个** input_text 部件（对齐 Go `responsesUserParts`
  // 的 allText 快路径；注意 Go 的注释说"用字符串形态"，但代码下发的是单元素
  // 部件数组，本文件与代码一致）。
  if (plain.length > 0 && plain.every((block) => typeof block === 'string')) {
    const joined = (plain as string[]).join('')
    if (joined !== '') parts.push({ type: 'input_text', text: joined })
  } else {
    for (const block of plain) {
      if (typeof block === 'string') {
        if (block !== '') parts.push({ type: 'input_text', text: block })
        continue
      }
      const record = asRecord(block)
      if (record === undefined) continue
      const type = asText(record.type) ?? ''
      if (type === 'text' || type === '') {
        const text = asText(record.text)
        if (text !== undefined && text !== '') parts.push({ type: 'input_text', text })
        continue
      }
      if (type === 'image') {
        parts.push({ type: 'input_image', image_url: inlineImageUrl(record, images) })
        continue
      }
      // `reasoning` 等：Responses 的 input 里没有对应形态，且历史思考**不回传**
      //（与 Anthropic 面同口径：本插件不持久化思考签名），故丢弃。
    }
  }
  if (parts.length > 0) out.push({ role: 'user', content: parts })
}

/**
 * DSH `Message[]` → Responses `input` 条目（**不含**签名对象）。
 *
 * 投影规则（逐条对齐 Go `convertResponsesInput`）：
 *
 * | 输入 | 产出 |
 * |---|---|
 * | `system` / `developer` | `{role:'system', content:<纯文本>}`（空则丢） |
 * | `assistant` | `{role:'assistant',content:[output_text…]}` + `{type:'function_call',…}` |
 * | 工具结果块 | `{type:'function_call_output', call_id, output}` |
 * | user 及其它未知角色 | `{role:'user', content:[input_text / input_image…]}` |
 */
function projectResponsesInput(options: BuildMonkeycodeResponsesBodyOptions): AnyRecord[] {
  // ⚠️⚠️ 步骤 1：归一化 harness 形状（`role:'tool'` + 顶层 `toolCallId` →
  // 内嵌 `tool-result` 块）。不做这步，下面的工具结果判据恒不命中，
  // `resolveToolPairing` 的 keepResultIds 恒为空 ⇒ **工具调用被整体剔除**。
  // 入参签名保持 `readonly Message[]`，但归一化层吃的是宽松的
  // `{role; content?}[]` —— `Message` 没有索引签名，直接传会报 TS2352。
  const normalized = normalizeHarnessMessages(
    options.messages as unknown as readonly { role: string; content?: unknown }[],
  )
  // ⚠️⚠️ 步骤 2：剔除无法配对的工具调用/结果（全仓唯一口径，勿自行实现）。
  const { keepCallIds, keepResultIds } = resolveToolPairing(normalized)

  const out: AnyRecord[] = []
  for (const message of normalized) {
    const blocks = contentBlocks(message.content)
    switch (message.role) {
      case 'system':
      case 'developer': {
        const text = flattenText(message.content)
        if (text.trim() !== '') out.push({ role: 'system', content: text })
        continue
      }
      case 'assistant':
        projectAssistantItems(blocks, keepCallIds, out)
        continue
      case 'tool':
      case 'function': {
        // 归一化后一般走不到这里（已被降级成 user + tool-result 块），
        // 但保留分支以覆盖未归一化的调用方。
        out.push({
          type: 'function_call_output',
          call_id: toolResultCallId(asRecord(message) ?? {}),
          output: flattenText(message.content),
        })
        continue
      }
      default:
        projectUserAndToolItems(blocks, keepResultIds, options.images, out)
    }
  }
  return out
}

/**
 * 构造 Responses 形状的出站 body。
 *
 * ⚠️ 纯函数（不碰网络、不碰凭据），便于单测逐字节锁死形状。
 *
 * ⚠️ **签名对象恒为 `input[0]`**：`instructions` / 顶层 `system` 一律 403。
 */
export function buildMonkeycodeResponsesBody(
  options: BuildMonkeycodeResponsesBodyOptions,
): Record<string, unknown> {
  const items = projectResponsesInput(options)
  if (items.length === 0) throw new Error('monkeycode: 请求里没有可用消息')

  // ⚠️ 顺序敏感：签名对象必须是第一条，客户端 system 紧随其后，再是会话消息。
  const input: AnyRecord[] = [{ role: 'system', content: MONKEYCODE_SIGNATURE_SYSTEM_PROMPT }]
  if (options.system !== undefined && options.system.trim() !== '') {
    input.push({ role: 'system', content: options.system })
  }
  input.push(...items)

  const payload: Record<string, unknown> = {
    model: toUpstreamModelId(options.model),
    input,
    // ⚠️ Responses 面的字段名是 `max_output_tokens`；写 `max_tokens` 上游不认。
    max_output_tokens: resolveMaxTokens(options.maxTokens),
    // ⚠️ 恒为 true（见文件头第 2 条：透传 false 会静默丢内容）。
    stream: true,
  }

  // 思考档位：**只在客户端明确表达时下发**（未表达 = 上游默认档，即开）。
  // ⚠️ `'none'` 要原样转发（实测 reasoning_tokens=0，确实能关）。
  const effort = options.reasoningEffort === undefined
    ? ''
    : options.reasoningEffort.trim().toLowerCase()
  if (effort !== '') payload.reasoning = { effort }

  if (options.temperature !== undefined) payload.temperature = options.temperature

  // ⚠️ 不移植 Go 的 `tool_choice:'none'` → 裁 tools：DSH 的 GenerateOptions 没有
  // `toolChoice` 字段（见 anthropic-messages.ts 文件头），该字段天然不出现。
  if (options.tools !== undefined && options.tools.length > 0) {
    const tools: AnyRecord[] = []
    for (const tool of options.tools) {
      const name = asText(tool.name) ?? ''
      if (name === '') continue
      const entry: AnyRecord = { type: 'function', name }
      const description = asText(tool.description)
      if (description !== undefined && description !== '') entry.description = description
      // ⚠️ `parameters` 缺省时给空 object schema（不能省略，否则上游 400）。
      const parameters = asRecord(tool.parameters)
      entry.parameters = parameters !== undefined && Object.keys(parameters).length > 0
        ? parameters
        : { type: 'object', properties: {} }
      tools.push(entry)
    }
    if (tools.length > 0) payload.tools = tools
  }
  return payload
}

// ---------------------------------------------------------------------------
// 响应投影：Responses 事件流 → DSH StreamChunk
// ---------------------------------------------------------------------------

/** {@link consumeMonkeycodeResponsesSse} 的入参。 */
export interface ConsumeMonkeycodeResponsesSseOptions {
  /** SSE 字节流（`response.body`）。 */
  body: ReadableStream<Uint8Array>
  /** 外部中止信号（中止时取消 reader）。 */
  signal?: AbortSignal
  /** 错误文案前缀（如 `'monkeycode'`），拼 `"<label>: 流内错误：…"`。 */
  errorLabel: string
  /** 空响应时的错误文案（不含前缀），如 `'模型未返回任何内容'`。 */
  emptyMessage: string
}

/** 一个正在累积的 DSH 块。 */
interface BlockState {
  type: 'text' | 'reasoning' | 'tool-call'
  text: string
  toolId?: string
  toolName?: string
  toolArgs: string
}

/**
 * 由 Responses 的 status / incomplete_details 推 DSH {@link FinishReason}。
 *
 * 对齐 Go 的 `finishReason`（`responses.go:538-548`）：
 * 1. 出现过工具调用 → `tool-calls`（**优先于** 长度判定，与 Go 一致）；
 * 2. `incomplete_details.reason === 'max_output_tokens'` → `max-tokens`；
 * 3. 其余（含 `content_filter`、未知、缺失）→ `stop`。
 *
 * ⚠️ 未知一律 `stop`：不能编造成 `error`（那会让 harness 重试一个其实成功的响应）。
 */
export function mapResponsesFinishReason(resp: AnyRecord, toolCount: number): FinishReason {
  if (toolCount > 0) return { kind: 'tool-calls' }
  const details = asRecord(resp.incomplete_details)
  if (details !== undefined && details.reason === 'max_output_tokens') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

/**
 * 消费上游 Responses 事件流，产出 DSH 的 {@link StreamChunk}。
 *
 * ## 事件映射表（对齐 Go `responsesStreamReader.convertLine`）
 *
 * | 上游事件 | 本函数产出 |
 * |---|---|
 * | `response.created` / `response.in_progress` | 无（DSH 的 chunk 没有消息 id） |
 * | `response.output_item.added(item.type='message')` | 无（DSH 没有 role chunk；文本块按首个增量惰性建立） |
 * | `response.output_item.added(item.type='function_call')` | `block-start`(tool-call) + `tool-call-delta`(id/name/已带参数) |
 * | `response.output_text.delta` | `block-start`(text, 首次) + `text-delta` |
 * | `response.reasoning_summary_text.delta` / `response.reasoning_text.delta` | `block-start`(reasoning, 首次) + `reasoning-delta` |
 * | `response.function_call_arguments.delta` | `tool-call-delta`（按 `item_id` 定位块） |
 * | `response.completed` / `response.incomplete` | 各块 `block-end` + `usage` + `finish` |
 * | `response.failed` | **抛错** `${errorLabel}: 流内错误：…` |
 * | `error` | **抛错** `${errorLabel}: 流内错误：…` |
 * | 其余（`…done` / `content_part.added` / `ping` 等） | 无（Go 同样忽略） |
 *
 * ## 四条必须保留的既有行为（每条都对应一次现场踩坑）
 *
 * 1. **流尾残留事件必须按整行再走一遍**：SSE 末帧若不带换行，携带
 *    `response.completed`（含 usage 与 status）的那帧会被静默丢弃 ⇒
 *    usage 永远是 0、`max_output_tokens` 截断被误报成 `stop`。
 * 2. **流内 `error` / `response.failed` 必须抛错**：静默结束会让 UI 表现为
 *    「干净地停止、无任何报错」。
 * 3. **空响应必须抛错**：静默结束会让 harness 认为「模型正常回答但没内容」而
 *    **不重试**（与 Anthropic / Qoder / CodeArts 面的既有约定一致）。
 * 4. **`response.output_text.done` 之类不取全文**：上游流已经把增量给全，取
 *    `.done` 的全文会**重复拼接**（Go 同样只认 delta）。
 *
 * ## 两处与 Go 的有意差异
 *
 * - **空名字 `function_call` 整块压制**（Go 照发）：空名字块会被 harness 执行成
 *   `unknown tool ""` 并持久化进会话，此后每次请求原样重放 → 整条会话报废
 *   （`sse.ts:211-231` 的 400/11133 实证）。
 * - **`input_tokens` 扣减缓存命中**：DSH 的 `inputTokens` 口径是"未命中缓存的
 *   输入"（见 `openai-compat.ts:890-894`、`anthropic-sse.ts:93-94`），而上游
 *   `input_tokens` 是总数 ⇒ 命中时相减，命中部分单列 `cacheReadTokens`，
 *   避免面板缓存命中率偏大。Go 那边产出的是 OpenAI 形状（`prompt_tokens`
 *   本就是总数），故不扣减。
 */
export async function* consumeMonkeycodeResponsesSse(
  options: ConsumeMonkeycodeResponsesSseOptions,
): AsyncGenerator<StreamChunk> {
  const reader = options.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  /** 方言探测：JSON 体以 `{` 开头，SSE 以 `event:` / `data:` 开头。 */
  let mode: 'unknown' | 'sse' | 'json' = 'unknown'
  let jsonText = ''

  /** 块索引按**首次出现顺序**分配（DSH 的 BlockAssembler 靠 index 认块）。 */
  let nextIndex = 0
  const blocks = new Map<number, BlockState>()
  let textIndex: number | undefined
  let reasoningIndex: number | undefined
  /** 上游 `item_id` → 本函数的块 index（对齐 Go 的 `toolIdx`）。 */
  const toolIndexByItem = new Map<string, number>()
  /** 名字不可用而被整体压制的 `item_id`（其参数增量必须一并丢弃）。 */
  const droppedToolItems = new Set<string>()
  let toolCount = 0

  let inputTokens = 0
  let outputTokens = 0
  let cachedTokens = 0
  let reasoningTokens = 0
  let cacheReported = false
  let reasoningReported = false

  let sawBlock = false
  let finished = false
  let pendingReason: FinishReason | undefined

  const captureUsage = (resp: AnyRecord): void => {
    const usage = asRecord(resp.usage)
    if (usage === undefined) return
    inputTokens += nonNegativeInt(usage.input_tokens) ?? 0
    outputTokens += nonNegativeInt(usage.output_tokens) ?? 0
    // ⚠️ 缓存判定认「字段存在」而非「值 > 0」：0 是有效观测（明确未命中），
    // 与「上游没上报」必须区分（对齐 Go `cacheusage.go:33-46` 与 R53 决议）。
    const details = asRecord(usage.input_tokens_details)
    if (details !== undefined && 'cached_tokens' in details) {
      cacheReported = true
      cachedTokens += nonNegativeInt(details.cached_tokens) ?? 0
    }
    // `output_tokens_details.reasoning_tokens` 是 **output 的子集**，故映射到
    // `reasoningTokens` 而不是加到 `outputTokens` 上。
    const outputDetails = asRecord(usage.output_tokens_details)
    if (outputDetails !== undefined && 'reasoning_tokens' in outputDetails) {
      reasoningReported = true
      reasoningTokens += nonNegativeInt(outputDetails.reasoning_tokens) ?? 0
    }
  }

  const buildUsage = (): TokenUsage => {
    const usage: TokenUsage = {
      // ⚠️ 扣减：DSH 的 inputTokens 指"未命中缓存"的部分，命中另列。
      inputTokens: cachedTokens > 0 ? Math.max(0, inputTokens - cachedTokens) : inputTokens,
      outputTokens,
    }
    // 上游明确上报过（含 0）才写该键：写 0 表示"确实没命中"，不写表示"未提供"。
    if (cacheReported) usage.cacheReadTokens = cachedTokens
    if (reasoningReported && reasoningTokens > 0) usage.reasoningTokens = reasoningTokens
    return usage
  }

  /** 惰性建块：首个增量到达时才发 `block-start`（避免产生空块）。 */
  const emitText = function* (text: string): Generator<StreamChunk> {
    if (text === '') return
    if (textIndex === undefined) {
      textIndex = nextIndex++
      blocks.set(textIndex, { type: 'text', text: '', toolArgs: '' })
      sawBlock = true
      yield { type: 'block-start', index: textIndex, blockType: 'text' }
    }
    const state = blocks.get(textIndex)
    if (state !== undefined) state.text += text
    yield { type: 'text-delta', index: textIndex, text }
  }

  const emitReasoning = function* (text: string): Generator<StreamChunk> {
    if (text === '') return
    if (reasoningIndex === undefined) {
      reasoningIndex = nextIndex++
      blocks.set(reasoningIndex, { type: 'reasoning', text: '', toolArgs: '' })
      sawBlock = true
      yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
    }
    const state = blocks.get(reasoningIndex)
    if (state !== undefined) state.text += text
    yield { type: 'reasoning-delta', index: reasoningIndex, text }
  }

  /**
   * `response.output_item.added(item.type='function_call')` → 起块 + 首次增量。
   *
   * ⚠️ 部分实现会在 added 事件里直接带完整 `arguments`，故首个 `tool-call-delta`
   * 就带上已到手的参数（后续分片走 arguments.delta 事件）。
   */
  const announceToolCall = function* (item: AnyRecord): Generator<StreamChunk> {
    const rawItemId = asText(item.id) ?? ''
    const callId = asText(item.call_id) ?? (rawItemId !== '' ? rawItemId : '')
    const name = asText(item.name) ?? ''
    const args = asText(item.arguments) ?? ''
    if (!hasUsableToolName(name)) {
      // ⚠️ 整块压制（连 block-start 都不发）：上游 BlockAssembler 对没有
      // `block-end` 的 partial 同样会组装出 `name: ''` 的块并持久化进会话。
      droppedToolItems.add(rawItemId)
      return
    }
    const index = nextIndex++
    toolIndexByItem.set(rawItemId, index)
    toolCount++
    blocks.set(index, { type: 'tool-call', text: '', toolId: callId, toolName: name, toolArgs: args })
    sawBlock = true
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield {
      type: 'tool-call-delta',
      index,
      id: ToolCallId(callId),
      name,
      argumentsDelta: args,
    }
  }

  /** 收尾：各块 `block-end` → `usage` → `finish`。幂等。 */
  const finalize = function* (reason: FinishReason): Generator<StreamChunk> {
    if (finished) return
    finished = true
    for (const [index, state] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
      const block: ContentBlock = state.type === 'text'
        ? { type: 'text', text: state.text }
        : state.type === 'reasoning'
          ? { type: 'reasoning', text: state.text }
          : {
              type: 'tool-call',
              id: ToolCallId(state.toolId ?? ''),
              name: state.toolName ?? '',
              arguments: state.toolArgs,
            }
      yield { type: 'block-end', index, block }
    }
    blocks.clear()
    yield { type: 'usage', usage: buildUsage() }
    yield { type: 'finish', reason }
  }

  /**
   * 收尾 + 空响应判定。
   *
   * ⚠️ 空检查必须**在**下发 `finish` 之前：静默结束（0 块）会让 harness 认为
   * 「模型正常回答但没内容」而**不重试**。
   */
  const complete = function* (reason: FinishReason): Generator<StreamChunk> {
    if (finished) return
    if (!sawBlock) throw new Error(`${options.errorLabel}: ${options.emptyMessage}`)
    yield* finalize(reason)
  }

  /** 单个 Responses 事件 → 若干 StreamChunk。 */
  const handleFrame = function* (ev: AnyRecord): Generator<StreamChunk> {
    // ⚠️ 只认帧内的 `type` 字段，**不回退**到 `event:` 行（Go 亦然）：
    // Responses 的每个 data 帧都自带 type，缺失即视为不可解析。
    const type = asText(ev.type) ?? ''
    switch (type) {
      case 'response.created':
      case 'response.in_progress':
        // 只带 id / created_at；DSH 的 StreamChunk 没有消息 id 字段，无处搬运。
        return

      case 'response.output_item.added': {
        const item = asRecord(ev.item)
        if (item === undefined) return
        // `message` / `reasoning` 不在此起块（Go 对 message 只发了个 role chunk，
        // DSH 没有该形态）—— 文本/思考块按首个增量惰性建立。
        if (item.type === 'function_call') yield* announceToolCall(item)
        return
      }

      case 'response.output_text.delta': {
        yield* emitText(asText(ev.delta) ?? '')
        return
      }

      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        yield* emitReasoning(asText(ev.delta) ?? '')
        return
      }

      case 'response.function_call_arguments.delta': {
        const partial = asText(ev.delta) ?? ''
        if (partial === '') return
        const itemId = asText(ev.item_id) ?? ''
        if (droppedToolItems.has(itemId)) return
        const index = toolIndexByItem.get(itemId)
        if (index === undefined) return
        const state = blocks.get(index)
        if (state === undefined) return
        state.toolArgs += partial
        yield {
          type: 'tool-call-delta',
          index,
          id: ToolCallId(state.toolId ?? ''),
          name: state.toolName ?? '',
          argumentsDelta: partial,
        }
        return
      }

      case 'response.completed':
      case 'response.incomplete': {
        const resp = asRecord(ev.response) ?? {}
        captureUsage(resp)
        pendingReason = mapResponsesFinishReason(resp, toolCount)
        yield* complete(pendingReason)
        return
      }

      case 'response.failed': {
        const resp = asRecord(ev.response)
        const error = resp === undefined ? undefined : asRecord(resp.error)
        const message = (error === undefined ? undefined : asText(error.message)) ?? 'upstream response failed'
        throw new Error(`${options.errorLabel}: 流内错误：${message}`)
      }

      case 'error': {
        const error = asRecord(ev.error)
        let message = error === undefined ? '' : asText(error.message) ?? ''
        if (message === '' && error !== undefined) message = asText(error.type) ?? ''
        if (message === '') message = asText(ev.message) ?? ''
        if (message === '') message = 'upstream error'
        throw new Error(`${options.errorLabel}: 流内错误：${message}`)
      }

      default:
        // `response.output_text.done` / `output_item.done` / `content_part.added`
        // / `*_text.done` / `ping` 等：忽略（内容已由增量给全，取 done 会重复拼接）。
        return
    }
  }

  /** 一行 SSE → 若干 StreamChunk。 */
  const processLine = function* (rawLine: string): Generator<StreamChunk> {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    // `event:` 行与空行丢弃 —— 输出侧不需要帧边界，事件类型在 data 的 JSON 里。
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') return
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    yield* handleFrame(parsed as AnyRecord)
  }

  /** 上游忽略 `stream` 时的兜底：整包单个 Responses JSON 对象。 */
  const handleJsonBody = function* (raw: string): Generator<StreamChunk> {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`${options.errorLabel}: 流内错误：上游响应体不是合法 JSON`)
    }
    const top = asRecord(parsed)
    if (top === undefined) {
      throw new Error(`${options.errorLabel}: 流内错误：上游响应体不是 JSON 对象`)
    }
    const resp = asRecord(top.response) ?? top
    const error = asRecord(resp.error)
    if (error !== undefined) {
      const message = asText(error.message) ?? 'upstream error'
      throw new Error(`${options.errorLabel}: 流内错误：${message}`)
    }
    captureUsage(resp)
    const output = resp.output
    if (Array.isArray(output)) {
      for (const rawItem of output) {
        const item = asRecord(rawItem)
        if (item === undefined) continue
        switch (asText(item.type) ?? '') {
          case 'reasoning': {
            // 思考摘要（`summary[].text`）→ reasoning 块。
            const summary = item.summary
            if (Array.isArray(summary)) {
              for (const rawPart of summary) {
                const part = asRecord(rawPart)
                if (part === undefined) continue
                yield* emitReasoning(asText(part.text) ?? '')
              }
            }
            break
          }
          case 'message': {
            const content = item.content
            if (Array.isArray(content)) {
              for (const rawPart of content) {
                const part = asRecord(rawPart)
                if (part === undefined || part.type !== 'output_text') continue
                yield* emitText(asText(part.text) ?? '')
              }
            }
            break
          }
          case 'function_call': {
            yield* announceToolCall(item)
            break
          }
          default:
            break
        }
      }
    }
    yield* complete(mapResponsesFinishReason(resp, toolCount))
  }

  const onAbort = (): void => {
    // ⚠️ 只 cancel reader，绝不 abort 调用方信号；`catch` 不可省
    //（连接已断时 cancel 会抛错，不吞掉会把"正常中止"变成一次失败）。
    void reader.cancel().catch(() => {})
  }
  if (options.signal?.aborted === true) onAbort()
  else options.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        // ⚠️ 收尾：先刷出解码器里残留的不完整多字节序列，再处理残余内容。
        buffer += decoder.decode()
        if (mode === 'json') {
          jsonText += buffer
          buffer = ''
          yield* handleJsonBody(jsonText)
        } else if (buffer !== '') {
          // ⚠️ **流尾残留事件按整行再走一遍**（真实缺陷的修法，见文件头第 1 条）：
          // 末帧不带换行时，携带 status/usage 的那条会被静默丢弃。
          const tail = buffer.split('\n')
          buffer = ''
          for (const rawLine of tail) yield* processLine(rawLine)
        }
        break
      }
      buffer += decoder.decode(value, { stream: true })

      if (mode === 'unknown') {
        const head = buffer.replace(/^\uFEFF/, '').trimStart()
        if (head === '') {
          // 只有空白：还判定不了，继续等（对流首恰好落在首个非空白字符前的情况必要）。
          continue
        }
        mode = head.startsWith('{') ? 'json' : 'sse'
      }
      if (mode === 'json') {
        // JSON 体不看行边界：整包攒到 EOF 再解析。
        jsonText += buffer
        buffer = ''
        continue
      }
      // SSE 以空行分隔事件；按行处理，末尾不成行的部分留在 buffer 里。
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const rawLine of lines) yield* processLine(rawLine)
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
    reader.releaseLock?.()
  }

  // ⚠️ 上游正常 EOF 但没发 completed（连接提前关闭 / 只发了增量）：仍要收尾，
  // 否则 usage 与 finish 全丢（`pendingReason` 已算出则沿用）。
  if (!finished) yield* complete(pendingReason ?? { kind: 'stop' })
}
