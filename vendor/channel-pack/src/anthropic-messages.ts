/**
 * 通用 **Anthropic Messages 请求体序列化层**：DSH `Message[]` → Anthropic `messages`。
 *
 * ## 为什么抽（上游作者留下的既定口径）
 *
 * `minimax-messages.ts` 原注释写「**不做**通用 Anthropic 层抽象 —— 目前只有一个
 * 消费者，抽象会凭空多一层间接（Qoder 的教训是『同族第二个产品出现时再抽』）」。
 * **MonkeyCode 就是第二个消费者**（它走 Anthropic `/messages` 面）⇒ 依约抽出。
 *
 * ⚠️ 与 `openai-compat.ts` **不可互换**：那是 OpenAI 形状，硬套会把 `tools` /
 * `tool_calls` / `input_json_delta` 全部翻译错（`minimax-messages.ts:5-8` 记录）。
 *
 * ## 六条必须保留的行为（每条都对应一次现场踩坑）
 *
 * 1. **先做 harness 形状归一化**（`normalizeHarnessMessages`）：dsh 0.1.7+ 把工具
 *    结果改成**一等 `role:'tool'` 消息**（`toolCallId` 在顶层），不归一化会让
 *    `tool-result` 判据恒不命中 ⇒ 工具调用被整体剔除 ⇒ 提前结束或循环思考。
 * 2. **剔除孤儿 `tool_use` / `tool_result`**（`resolveToolPairing`）：服务端拒绝孤儿。
 * 3. **assistant 与它的工具结果成对提交**：Anthropic 要求 `tool_result` 紧跟产生它的
 *    assistant；逐条下发会产生连续 user ⇒ `400 ... does not follow tool call (2013)`。
 *    ⚠️ **不得跨 assistant 边界累积**（同样 2013）。
 * 4. **`input` 必须解析成对象**（Anthropic 收对象，收字符串会被拒）；解析失败退化
 *    `{}` —— 不编造参数，但也不能丢块（丢了后续 `tool_result` 变孤儿）。
 * 5. **历史里的 `reasoning` 不回传**：Anthropic 要求 thinking 块带 `signature`，
 *    而本插件不持久化签名 ⇒ 回传无签名 thinking 会被拒。与官方客户端行为一致。
 * 6. **图片走 Anthropic `image` 块 + 裸 base64**，**不是** OpenAI `image_url`
 *    （实测被明确拒：`unsupported content type 'image_url' (2013)`）。
 *    ⚠️ 消息体里的图片内联失败要**显式抛错**（不静默丢图）；工具结果里的图片
 *    读不到则**跳过**（文本仍有价值）—— 两者有意区别对待。
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { normalizeHarnessMessages } from './message-shape.js'
import { resolveToolPairing } from './sse.js'

/** 已内联的图片（attachmentId → base64 与 mediaType）。 */
export interface AnthropicInlineImage {
  mediaType: string
  /** **裸 base64**（不含 `data:` 前缀）—— Anthropic `source.data` 要的就是它。 */
  data: string
}

/** 一条消息里的文本（Anthropic 的 content 可以是字符串或块数组）。 */
function blockText(block: ContentBlock): string {
  if (block.type === 'text') return block.text
  if (block.type === 'reasoning') return block.text
  return ''
}

/** 工具结果的内容块（图片同样要内联）。 */
function serializeToolResultContent(
  blocks: readonly ContentBlock[],
  images?: ReadonlyMap<string, AnthropicInlineImage>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const block of blocks) {
    if (block.type === 'image') {
      const ref = block.attachment as { attachmentId?: unknown } | undefined
      const attachmentId = typeof ref?.attachmentId === 'string' ? ref.attachmentId : undefined
      const inline = attachmentId === undefined ? undefined : images?.get(attachmentId)
      if (inline !== undefined) {
        out.push({
          type: 'image',
          source: { type: 'base64', media_type: inline.mediaType, data: inline.data },
        })
      }
      // ⚠️ 工具结果里的图片读不到时**跳过**（不抛错）：工具结果本身
      //（文本）仍有价值，为一个附件让整轮失败不划算 —— 与「消息体里的图片
      // 读不到就抛错」有意区别对待，因为后者是用户**显式**发送的意图。
      continue
    }
    const text = blockText(block)
    if (text !== '') out.push({ type: 'text', text })
  }
  return out
}

/** 解析工具参数 JSON；失败/非对象时退化为 `{}`。 */
function parseToolArguments(raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/**
 * 把 DSH 消息序列化为 Anthropic Messages 形状。
 *
 * ⚠️ 图片**必须**由调用方先内联好（`images` 映射）：本函数是**纯函数**，
 * 不允许触碰附件服务（便于单测锁死形状）。
 *
 * @param errorLabel 图片内联失败时的错误前缀（如 `'minimax'`）。
 *   保留按渠道区分是刻意的：现场日志与既有测试依赖该前缀可读性。
 */
export function serializeAnthropicMessages(
  messages: readonly Message[],
  images?: ReadonlyMap<string, AnthropicInlineImage>,
  errorLabel = 'anthropic',
): Array<Record<string, unknown>> {
  // ⚠️⚠️ 步骤 1：归一化「一等 tool 消息」形状（**调用方曾因此整轮 400**）。
  //
  // harness 把工具结果作为**独立的 `role:'tool'` 消息**下发（`toolCallId` 在
  // **顶层**），而**没有** `tool-result` 内容块 —— 于是下面
  // `block.type === 'tool-result'` 的判据恒不命中（`normalizeHarnessMessages`
  // 会把它降级回「user 消息内嵌 tool-result 块」的旧形状）。
  //
  // ⚠️ **别被版本号误导**（2026-10-01 实测纠正）：这套形状自 dsh 0.1.7 引入，
  // 但 **0.2.0-rc.2 仍然如此** —— 全量会话日志 34,659 条 tool/result 无一例外
  // 都是 `role:'tool'` + 顶层 `toolCallId`，`developer` 消息也仍在。
  //
  // 漏掉这一步的真实后果（2026-10-01 会话 `session-871fdf61` 报障）：
  // `400 invalid_request_error ... tool call result does not follow tool call (2013)`。
  //
  // ⚠️ 入参签名保持 `readonly Message[]`，但归一化层吃的是**宽松**的
  // `{role; content?}[]` —— `Message` 没有索引签名，直接传会报 TS2352。
  const normalized = normalizeHarnessMessages(
    messages as unknown as readonly { role: string; content?: unknown }[],
  ) as unknown as readonly Message[]

  // ⚠️ 步骤 2：剔除无法配对的 tool_use / tool_result（与既有适配器同口径）。
  //
  // Anthropic 与 OpenAI 一样拒绝孤儿：没有 tool_result 的 tool_use、指向不存在
  // tool_use 的 tool_result，都会被服务端拒。共用 `resolveToolPairing` 是为了
  // **一个口径**——它在内部也会先做同一套形状归一化，且已处理「空 name 的
  // tool-call 无条件 400」这个既有教训。
  const { keepCallIds, keepResultIds } = resolveToolPairing(normalized)

  const out: Array<Record<string, unknown>> = []
  /**
   * ⚠️ 待发的 assistant 消息（等它的工具结果到齐后**成对**提交）。
   *
   * Anthropic 协议要求：同批 `tool_result` 必须**合并进紧跟 assistant(tool_use)
   * 的那一条 user 消息**。harness 把**每个**工具调用落成**一条独立**的 tool 消息
   * （真实会话 `session-871fdf61` 一次 tool_use 批次对应 1~3 条），逐条下发会产出
   * **多条连续 user 消息** ⇒ 第二条前面是 user 而非 assistant ⇒ 2013。
   *
   * ⚠️⚠️ **不得跨 assistant 边界累积**（真实缺陷，第一版实现的错误）：
   * 那样会变成 `assistant A / assistant B / user(A+B 的结果)`，
   * A 的结果前面是 B 的 assistant ⇒ **同样** 2013。
   */
  let pendingAssistant: Record<string, unknown> | undefined
  let pendingToolResults: Array<Record<string, unknown>> = []
  /**
   * 把「待发 assistant + 已累积的工具结果」**成对**提交。
   *
   * ⚠️ 结果为空时**仍要提交 assistant** —— 那是模型只回了正文的历史消息。
   * ⚠️ 提交后 assistant 置空：它的结果已经配对完毕，不会再累积更多。
   */
  const commitPending = (): void => {
    if (pendingAssistant === undefined && pendingToolResults.length === 0) return
    if (pendingAssistant !== undefined) out.push(pendingAssistant)
    if (pendingToolResults.length > 0) {
      out.push({ role: 'user', content: pendingToolResults })
      pendingToolResults = []
    }
    pendingAssistant = undefined
  }

  for (const message of normalized) {
    // ⚠️ system 角色不可能出现在这里（DSH 把它放在 options.system），
    // 但真出现时按 user 处理会让模型把它当用户指令 —— 故显式跳过。
    // ⚠️ `developer`（只承载工具增删元数据的角色）由归一化层一并丢弃。
    if (message.role === 'system') continue

    const content: Array<Record<string, unknown>> = []
    /** 本条消息的**全部**块数（用于判定「纯工具结果消息」）。 */
    let blocks = 0
    for (const block of message.content) {
      blocks++
      if (block.type === 'tool-call') {
        // ⚠️ 孤儿/空名调用不产出 tool_use（否则下游 tool_result 变孤儿 → 400）。
        if (!keepCallIds.has(String(block.id))) continue
        content.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          // ⚠️ 解析成对象；失败退化 `{}`（不编造参数，也不丢块）
          input: parseToolArguments(block.arguments),
        })
        continue
      }
      if (block.type === 'tool-result') {
        // ⚠️ 孤儿结果不下发（服务端同样 400）。
        if (!keepResultIds.has(String(block.toolCallId))) continue
        pendingToolResults.push({
          type: 'tool_result',
          tool_use_id: block.toolCallId,
          // ⚠️ 工具结果内的图片也要内联（否则「工具返回截图」的场景会丢图）。
          content: serializeToolResultContent(block.content, images),
          ...(block.isError === true ? { is_error: true } : {}),
        })
        continue
      }
      if (block.type === 'image') {
        const ref = block.attachment as { attachmentId?: unknown } | undefined
        const attachmentId = typeof ref?.attachmentId === 'string' ? ref.attachmentId : undefined
        const inline = attachmentId === undefined ? undefined : images?.get(attachmentId)
        if (inline === undefined) {
          // ⚠️ **显式抛错，不静默丢弃**：静默丢弃会让用户以为图片被模型看到了
          //（与「图片能力未实现时抛错」同一原则）。
          throw new Error(
            `${errorLabel}: 图片未能内联（附件服务不可用或读取失败），`
            + '拒绝发出缺少图片的请求',
          )
        }
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: inline.mediaType,
            data: inline.data,
          },
        })
        continue
      }
      const text = blockText(block)
      if (text === '') continue
      if (message.role === 'assistant' && block.type === 'reasoning') {
        // ⚠️ 历史里的 reasoning **不回传**：Anthropic 要求 thinking 块带签名
        //（`signature`），而我们不持久化签名 ⇒ 回传无签名 thinking 会被拒。
        // 丢弃思考历史是安全的（它不影响正确答案），且与官方客户端行为一致
        //（客户端只在同一轮内回传带签名的 thinking）。
        continue
      }
      content.push({ type: 'text', text })
    }

    // ⚠️⚠️ **成对提交即配对关系（真实缺陷，2026-10-01 由真实会话重放定位）**。
    //
    // Anthropic 要求：`tool_result` 必须**紧跟产生它的那一条** assistant(tool_use)。
    // harness 侧形态是「一条 assistant（带 N 个 tool_use）+ N 条独立 tool 消息」。
    // 三种错误形态都会报 2013：
    //   ① 逐条下发 → N 条连续 user，第二条前面是 user；
    //   ② assistant 立即下发、结果攒到下一轮 → `assistant A / assistant B / user(A+B 结果)`；
    //   ③ 纯 reasoning 的空 assistant 被丢弃 → 其后结果失去锚点。
    //
    // ⇒ **assistant 与它的结果一起提交**：assistant 先进待发区，遇到它的结果
    // （或任何非工具消息）时，才把「assistant + 累积结果」成对 push。
    // 这样既合并了同批（不产生连续 user），也不跨 assistant 边界。
    const isPureToolMessage = message.role !== 'assistant'
      && content.length === 0
      && blocks > 0
    if (isPureToolMessage) continue

    if (message.role === 'assistant') {
      // ⚠️⚠️ 上一批若还没发出（assistant A 的结果已到齐但 A 本身待发），
      // 先把 A + A 的结果成对发出，再把当前 assistant 转入待发区。
      commitPending()
      if (content.length === 0) continue
      pendingAssistant = { role: 'assistant', content }
      continue
    }
    // user 消息：先把待发的 assistant 连同已累积的结果成对发出，再发正文。
    commitPending()
    if (content.length > 0) out.push({ role: 'user', content })
  }
  // ⚠️ 收尾：末尾的待发 assistant 与结果都要提交（否则留下无结果的 tool_use → 2013）。
  commitPending()
  return out
}
