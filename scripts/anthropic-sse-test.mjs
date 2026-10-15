/**
 * Anthropic Messages **SSE 消费层**的离线回归（A 阶段等价重构的安全网）。
 *
 * 直接 import `vendor/channel-pack/src/*.ts`（走 `stripTypeScriptTypes`，
 * 与 `gateway-source-test.mjs` 同一范式），不碰网络、不碰凭据。
 *
 * ## 为什么先有这个文件
 *
 * 阶段 A1 要把 `consumeMinimaxSse` 的**通用部分**抽成共享层（MonkeyCode 是
 * 第二个 Anthropic 消费者）。但既有测试**没有一条**直接覆盖该函数（全仓核实：
 * 只有 `recovery-test.mjs` 走 fake-kernel 的另一条路径），故重构没有安全网。
 * 本文件按「先锁行为、再重构」的顺序建立网：
 *
 *   1. 每条断言都描述**当前实现的既有行为**（重构前即全绿）；
 *   2. 重构后必须**逐条仍绿** —— 这才叫等价重构。
 *
 * ## 覆盖的真实缺陷（每条都对应一次现场踩坑）
 *
 * - **流尾残留事件被丢弃**：SSE 末帧若不带换行，旧实现会丢 `message_delta`
 *   ⇒ `max_tokens` 被误报成 `stop`、usage 永远是 0（`processLine` 头注释记载）。
 * - **`signature_delta` 当正文**：会把一串十六进制注入回答（thinking 块签名）。
 * - **流内 `error` 帧被当正常结束**：UI 表现为「干净地停止、无任何报错」。
 * - **空响应静默结束**：harness 会认为「模型正常回答但没内容」而**不重试**。
 * - **`thinking_delta` 必须映射成 `reasoning`**：否则思考内容污染正文。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const target = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (fs.existsSync(target)) return { url: target.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: stripTypeScriptTypes(fs.readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform', sourceUrl: url }),
    }
    return nextLoad(url, context)
  },
})

const failures = []
function check(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected)
    console.log(`ok   ${label}`)
  } catch (error) {
    failures.push(label)
    console.log(`FAIL ${label}`)
    console.log(`       ${error.message.split('\n').slice(0, 8).join('\n       ')}`)
  }
}
async function checkRejects(label, run, matcher) {
  try {
    await run()
    failures.push(label)
    console.log(`FAIL ${label} —— 期望抛错但没有抛`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (matcher.test(message)) console.log(`ok   ${label}`)
    else {
      failures.push(label)
      console.log(`FAIL ${label}`)
      console.log(`       错误文案不匹配 ${matcher}：${message}`)
    }
  }
}

/** 把若干 SSE 帧拼成字节流（`frame` 为对象时自动 JSON 串化）。 */
function sseStream(frames, { trailingNewline = true } = {}) {
  const text = frames.map((frame) => {
    const body = typeof frame === 'string' ? frame : JSON.stringify(frame)
    return `data: ${body}\n\n`
  }).join('')
  const payload = trailingNewline ? text : text.replace(/\n\n$/, '')
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload))
      controller.close()
    },
  })
}

const { consumeMinimaxSse, mapMinimaxStopReason, readMinimaxUsage, serializeMinimaxMessages } =
  await import('../vendor/channel-pack/src/minimax-messages.ts')
const { serializeAnthropicMessages } = await import('../vendor/channel-pack/src/anthropic-messages.ts')

/** 收集整条流。 */
async function collect(stream, signal) {
  const out = []
  for await (const chunk of consumeMinimaxSse({ body: stream, ...(signal === undefined ? {} : { signal }) })) {
    out.push(chunk)
  }
  return out
}

// ── 1. 纯文本 happy path：块映射 + usage + 收尾 ────────────────────────────

const textRun = await collect(sseStream([
  { type: 'message_start', message: { usage: { input_tokens: 12, cache_read_input_tokens: 4 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '，世界' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
  { type: 'message_stop' },
]))
check('纯文本：产出 block-start / 增量 / block-end', textRun.slice(0, 4), [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '你好' },
  { type: 'text-delta', index: 0, text: '，世界' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '你好，世界' } },
])
check('纯文本：usage 合并 message_start 与 message_delta（含缓存命中）', textRun.at(-2), {
  type: 'usage',
  usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 4 },
})
check('纯文本：finish 为 stop', textRun.at(-1), { type: 'finish', reason: { kind: 'stop' } })

// ── 2. 流尾残留事件必须被处理（真实缺陷：末帧无换行时丢 message_delta） ────

const truncatedRun = await collect(sseStream([
  { type: 'message_start', message: { usage: { input_tokens: 3 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
  { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 9 } },
], { trailingNewline: false }))
check('流尾无换行：末帧 message_delta 的 stop_reason 不丢（max_tokens 不被误报成 stop）',
  truncatedRun.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
check('流尾无换行：末帧 usage 不丢',
  truncatedRun.at(-2), { type: 'usage', usage: { inputTokens: 3, outputTokens: 9 } })

// ── 3. thinking 块 → reasoning，且 signature_delta 必须被忽略 ──────────────

const thinkingRun = await collect(sseStream([
  { type: 'message_start', message: { usage: { input_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '推理' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'deadbeefcafe' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
]))
check('thinking：映射为 reasoning 块（不污染正文）', thinkingRun[0], { type: 'block-start', index: 0, blockType: 'reasoning' })
check('thinking：增量映射为 reasoning-delta', thinkingRun[1], { type: 'reasoning-delta', index: 0, text: '推理' })
check('signature_delta 被忽略：块内文本只含 thinking 内容，不含十六进制签名',
  thinkingRun[2], { type: 'block-end', index: 0, block: { type: 'reasoning', text: '推理' } })
// 帧序列：block-start / reasoning-delta / block-end / usage / finish = 5。
// signature_delta 不产出任何 chunk，故总数仍是 5（多出则说明它被当成了内容）。
check('signature_delta 不产出额外 chunk（总数仍为 5）', thinkingRun.length, 5)

// ── 4. 工具调用：input_json_delta 分片累加，block-end 交出完整 arguments ──

const toolRun = await collect(sseStream([
  { type: 'message_start', message: { usage: { input_tokens: 5 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"a.txt"}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
]))
check('工具调用：block-start 为 tool-call', toolRun[0], { type: 'block-start', index: 0, blockType: 'tool-call' })
check('工具调用：分片 arguments 原样下发', toolRun.slice(1, 3), [
  { type: 'tool-call-delta', index: 0, id: 'toolu_1', argumentsDelta: '{"path":' },
  { type: 'tool-call-delta', index: 0, id: 'toolu_1', argumentsDelta: '"a.txt"}' },
])
check('工具调用：block-end 交出拼接后的完整 arguments', toolRun[3], {
  type: 'block-end', index: 0,
  block: { type: 'tool-call', id: 'toolu_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
})
check('工具调用：finish 为 tool-calls', toolRun.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })

// ── 5. 流内 error 帧必须抛错（不能静默当正常结束） ─────────────────────────

await checkRejects('流内 error 帧抛错（不静默结束）', () => collect(sseStream([
  { type: 'message_start', message: { usage: {} } },
  { type: 'error', error: { type: 'overloaded_error', message: '上游过载' } },
])), /流内错误[\s\S]*上游过载/)

// ── 6. 空响应必须抛错（否则 harness 不会重试） ─────────────────────────────

await checkRejects('空流抛错（无任何内容块）', () => collect(sseStream([
  { type: 'message_start', message: { usage: { input_tokens: 1 } } },
  { type: 'message_stop' },
])), /未返回任何内容块/)

// ── 7. 帧自带 type 优先；event: 行缺失也能工作 ─────────────────────────────

const typedRun = await collect(sseStream([
  '{"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
  '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
  '{"type":"content_block_stop","index":0}',
]))
// 流尾固定追加 usage + finish 两帧，故 block-end 在倒数第三个。
check('帧自带 type：event: 行缺失时仍能识别', typedRun.at(-3), { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } })

// ── 8. 畸形帧不得中断整条流（个别坏 JSON 跳过） ───────────────────────────

const malformedRun = await collect(sseStream([
  { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  'not-json-at-all',
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'survived' } },
  { type: 'content_block_stop', index: 0 },
]))
// 流尾固定追加 usage + finish 两帧，故 block-end 在倒数第三个。
check('畸形 JSON 帧被跳过，流继续', malformedRun.at(-3), {
  type: 'block-end', index: 0, block: { type: 'text', text: 'survived' },
})

// ── 9. 纯函数：stop_reason 与 usage 的边界 ───────────────────────────────

check('stop_reason=refusal → stop', mapMinimaxStopReason('refusal'), { kind: 'stop' })
check('stop_reason 未知 → stop（不编造成 error）', mapMinimaxStopReason('who_knows'), { kind: 'stop' })
check('stop_reason 缺失 → stop', mapMinimaxStopReason(undefined), { kind: 'stop' })
check('usage：thinking_tokens 映射到 reasoningTokens（是 output 的子集，不叠加）',
  readMinimaxUsage({ output_tokens: 100, output_tokens_details: { thinking_tokens: 40 } }),
  { outputTokens: 100, reasoningTokens: 40 })
check('usage：非法值被忽略', readMinimaxUsage({ input_tokens: -1, output_tokens: 'x' }), {})
check('usage：非对象返回空', readMinimaxUsage(null), {})

// ── 10. 消息序列化层：别名与通用层必须逐字等价，且保留下述既有行为 ─────────

/**
 * 构造 DSH 消息（内容用简化块，够覆盖分支即可）。
 *
 * ⚠️ 工具结果用 **0.1.7+ 的一等形状**（`role:'tool'` + **顶层** `toolCallId`），
 * 这正是 `normalizeHarnessMessages` 要处理的形态（也是真实会话的形状）。
 */
const msg = (role, content, extra = {}) => ({ role, content, ...extra })

const SAMPLE = [
  msg('user', [{ type: 'text', text: '读一下 a.txt' }]),
  msg('assistant', [
    { type: 'text', text: '好的' },
    { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' },
  ]),
  msg('tool', [{ type: 'text', text: '文件内容' }], { toolCallId: 'call-1' }),
]

const viaAlias = serializeMinimaxMessages(SAMPLE)
const viaGeneric = serializeAnthropicMessages(SAMPLE, undefined, 'minimax')
check('序列化：别名与通用层输出逐字相同（等价重构）', viaAlias, viaGeneric)

check('序列化：assistant 与它的 tool_result 成对相邻（Anthropic 硬约束）',
  viaAlias.map((m) => m.role), ['user', 'assistant', 'user'])
check('序列化：tool-call → tool_use，arguments 解析成对象', viaAlias[1].content[1], {
  type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'a.txt' },
})
check('序列化：tool-result → user 里的 tool_result 块（带 tool_use_id）', viaAlias[2].content[0], {
  type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'text', text: '文件内容' }],
})

// 孤儿配对剔除：没有结果的 tool_use 不得下发（服务端 400）
const orphanCall = serializeMinimaxMessages([
  msg('user', [{ type: 'text', text: 'x' }]),
  msg('assistant', [{ type: 'tool-call', id: 'call-orphan', name: 'f', arguments: '{}' }]),
])
check('序列化：孤儿 tool_use 被剔除（不下发无结果的调用）', orphanCall.length, 1)

// 历史 reasoning 不回传（无签名 thinking 会被拒）
const withReasoning = serializeMinimaxMessages([
  msg('user', [{ type: 'text', text: 'x' }]),
  msg('assistant', [
    { type: 'reasoning', text: '内部思考' },
    { type: 'text', text: '正文' },
  ]),
])
check('序列化：历史 reasoning 不回传，正文保留',
  withReasoning[1].content, [{ type: 'text', text: '正文' }])

// 图片内联失败必须抛错（不静默丢图）
await checkRejects('序列化：消息体图片未内联时抛错（不静默丢图）',
  async () => serializeAnthropicMessages([
    msg('user', [{ type: 'image', attachment: { attachmentId: 'att-1' } }]),
  ]), /图片未能内联[\s\S]*拒绝发出缺少图片的请求/)

// 工具结果里的图片读不到则跳过（不抛错）
const toolImageMissing = serializeAnthropicMessages([
  msg('user', [{ type: 'text', text: 'x' }]),
  msg('assistant', [{ type: 'tool-call', id: 'c9', name: 'shot', arguments: '{}' }]),
  msg('tool', [
    { type: 'image', attachment: { attachmentId: 'missing' } },
    { type: 'text', text: 'ok' },
  ], { toolCallId: 'c9' }),
])
check('序列化：工具结果里的图片读不到则跳过，文本保留',
  toolImageMissing[2].content[0].content, [{ type: 'text', text: 'ok' }])

console.log(failures.length === 0
  ? '\nanthropic-sse-test: all checks passed'
  : `\nanthropic-sse-test: ${failures.length} check(s) FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
