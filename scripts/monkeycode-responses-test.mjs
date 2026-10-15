/**
 * MonkeyCode **OpenAI Responses 面**的离线回归（请求投影 + 流式转换）。
 *
 * 直接 import `vendor/channel-pack/src/*.ts`（走 `stripTypeScriptTypes`，
 * 与 `anthropic-sse-test.mjs` 同一范式），**不打网络、不碰凭据**。
 *
 * ## 覆盖的真实缺陷（每条都对应一次现场踩坑）
 *
 * - **签名对象不在 `input[0]`**：放进 `instructions` / 顶层 `system` 一律 403；
 * - **`stream` 透传 false**：上游回单个 JSON 被 SSE 消费器整包丢弃 ⇒
 *   HTTP 200 但 content 空、usage 0 的**静默失败**；
 * - **字段名写成 `max_tokens`**：Responses 面认 `max_output_tokens`；
 * - **未表达思考却凭空补档位**：等于替客户端决定思考强度；
 * - **流尾残留事件被丢弃**：末帧不带换行时 `response.completed`（带 status 与
 *   usage）被静默丢弃 ⇒ usage 恒 0、截断被误报成 `stop`；
 * - **流内 error / response.failed 被当正常结束**：UI 表现为「干净地停止」；
 * - **空响应静默结束**：harness 认为「模型正常回答但没内容」而**不重试**；
 * - **空名字 tool-call 落进会话**：被 harness 执行成 `unknown tool ""` 并
 *   持久化，此后每次请求原样重放 → 整条会话报废（`sse.ts:211-231`）。
 *
 * ## 移植对齐
 *
 * 逐条对齐 `wild-work/internal/monkeycode/responses.go`（Go，只读参考）与
 * `monkeycode_test.go` 的 `TestBuildResponsesBody` / `TestResponsesStreamToOpenAI`
 * / `TestResponsesStreamFunctionCall` / `TestResponsesJSONFallback` /
 * `TestThinkingProjection`（responses 面那一半）。
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

const {
  buildMonkeycodeResponsesBody,
  consumeMonkeycodeResponsesSse,
  mapResponsesFinishReason,
} = await import('../vendor/channel-pack/src/monkeycode-responses.ts')
const { MONKEYCODE_SIGNATURE_SYSTEM_PROMPT } = await import('../vendor/channel-pack/src/monkeycode.ts')

const ERROR_LABEL = 'monkeycode'
const EMPTY_MESSAGE = '模型未返回任何内容'

/** 收集整条流。 */
async function collect(stream, signal) {
  const out = []
  for await (const chunk of consumeMonkeycodeResponsesSse({
    body: stream,
    errorLabel: ERROR_LABEL,
    emptyMessage: EMPTY_MESSAGE,
    ...(signal === undefined ? {} : { signal }),
  })) {
    out.push(chunk)
  }
  return out
}

/** DSH 消息构造器（工具结果用 0.1.7 的一等形状：`role:'tool'` + 顶层 toolCallId）。 */
const msg = (role, content, extra = {}) => ({ role, content, ...extra })

// ═══════════════════════════════════════════════════════════════════════════
// 1. 请求投影
// ═══════════════════════════════════════════════════════════════════════════

// ── 1.1 签名对象恒为 input[0]；客户端 system 在后 ─────────────────────────

{
  const body = buildMonkeycodeResponsesBody({
    model: 'monkeycode/basic/qwen3.8-flash',
    messages: [
      msg('system', [{ type: 'text', text: '你是客服' }]),
      msg('user', [{ type: 'text', text: '你好' }]),
    ],
    system: '顶层系统提示',
  })
  const input = body.input
  check('input[0] 恒为签名常量对象', input[0], {
    role: 'system', content: MONKEYCODE_SIGNATURE_SYSTEM_PROMPT,
  })
  check('签名串恰好 28 字符（与 Go 常量一致，改动即签名失配）',
    MONKEYCODE_SIGNATURE_SYSTEM_PROMPT.length, 28)
  check('客户端 system（options.system）紧随签名对象之后',
    input[1], { role: 'system', content: '顶层系统提示' })
  check('messages 里的 system 角色也被投影（排在签名对象之后）',
    input[2], { role: 'system', content: '你是客服' })
  check('user 消息在最后', input[3], {
    role: 'user', content: [{ type: 'input_text', text: '你好' }],
  })
  check('不下发顶层 instructions（上游不认，会让签名校验失败）',
    Object.hasOwn(body, 'instructions'), false)
  check('不下发顶层 system 字段（同上）', Object.hasOwn(body, 'system'), false)
}

// ── 1.2 model 补成上游形态 ────────────────────────────────────────────────

{
  const upstream = (id) => buildMonkeycodeResponsesBody({
    model: id, messages: [msg('user', 'hi')],
  }).model
  check('model：对外 ID → 上游形态（补 monkeycode-）',
    upstream('monkeycode/ultra/gpt-6-astra'), 'monkeycode-ultra/gpt-6-astra')
  check('model：渠道内 ID 同样补前缀',
    upstream('ultra/gpt-6-astra'), 'monkeycode-ultra/gpt-6-astra')
  check('model：裸名条目不加前缀（避免静默回落默认模型）',
    upstream('monkeycode/deepseek-flash'), 'deepseek-flash')
  check('model：已是上游形态则原样透传',
    upstream('monkeycode-pro/gpt-5.6-terra'), 'monkeycode-pro/gpt-5.6-terra')
}

// ── 1.3 强制 stream: true（入参根本没有 stream 字段） ──────────────────────

{
  const body = buildMonkeycodeResponsesBody({ model: 'pro/gpt-5.6-terra', messages: [msg('user', 'hi')] })
  check('出站 stream 恒为 true（透传 false 会静默丢内容）', body.stream, true)
  check('接口没有 stream 入参，客户端无法关掉它', Object.hasOwn(body, 'stream'), true)
}

// ── 1.4 max_output_tokens：缺省 16384 / 超 32000 夹到 32000 ────────────────

{
  const tokens = (options) => buildMonkeycodeResponsesBody({
    model: 'ultra/gpt-6-astra', messages: [msg('user', 'hi')], ...options,
  })
  const base = tokens({})
  check('max_output_tokens 缺省 = 16384', base.max_output_tokens, 16384)
  check('缺省时不下发 max_tokens（字段名是 max_output_tokens）',
    Object.hasOwn(base, 'max_tokens'), false)
  check('max_output_tokens 超 32000 被夹到 32000', tokens({ maxTokens: 999_999 }).max_output_tokens, 32_000)
  check('max_output_tokens 合法值原样透传', tokens({ maxTokens: 4096 }).max_output_tokens, 4096)
  check('max_output_tokens 非法值（0）回落缺省', tokens({ maxTokens: 0 }).max_output_tokens, 16_384)
}

// ── 1.5 reasoning 只在明确表达时下发 ──────────────────────────────────────

{
  const reasoning = (reasoningEffort) => buildMonkeycodeResponsesBody({
    model: 'ultra/gpt-6-astra',
    messages: [msg('user', 'hi')],
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }).reasoning
  check('未表达 reasoningEffort → 不下发 reasoning（= 上游默认档，即开）',
    reasoning(undefined), undefined)
  check('空串视为未表达（不凭空补档位）', reasoning('   '), undefined)
  check('reasoningEffort="none" 原样转发（实测 reasoning_tokens=0）',
    reasoning('none'), { effort: 'none' })
  check('reasoningEffort="high" 原样转发', reasoning('high'), { effort: 'high' })
  check('reasoningEffort 归一为小写（对齐 Go 的 reasoningLevel）',
    reasoning(' HIGH '), { effort: 'high' })
}

// ── 1.6 temperature 与 tools 形态 ─────────────────────────────────────────

{
  const withTemp = buildMonkeycodeResponsesBody({
    model: 'pro/gpt-5.6-terra', messages: [msg('user', 'hi')], temperature: 0.3,
  })
  check('temperature 存在时透传', withTemp.temperature, 0.3)
  check('temperature 缺失时不下发该键',
    Object.hasOwn(buildMonkeycodeResponsesBody({ model: 'pro/gpt-5.6-terra', messages: [msg('user', 'hi')] }), 'temperature'),
    false)

  const withTools = buildMonkeycodeResponsesBody({
    model: 'pro/gpt-5.6-terra',
    messages: [msg('user', 'hi')],
    tools: [
      { name: 'lookup', description: 'd', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
      { name: 'noargs' },
      { name: '', parameters: { type: 'object' } },
    ],
  })
  check('tools 用 Responses 形态（顶层 type/name/parameters，无 function 包裹）', withTools.tools, [
    { type: 'function', name: 'lookup', description: 'd', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
    { type: 'function', name: 'noargs', parameters: { type: 'object', properties: {} } },
  ])
  check('无 tools 时不下发该键',
    Object.hasOwn(buildMonkeycodeResponsesBody({ model: 'pro/gpt-5.6-terra', messages: [msg('user', 'hi')] }), 'tools'),
    false)
}

// ── 1.6b stop 不下发（Go 的 responses 面没有该字段） ───────────────────────

{
  const withStop = buildMonkeycodeResponsesBody({
    model: 'basic/qwen3.8-flash',
    messages: [msg('user', 'hi')],
    stop: ['END'],
  })
  check('stop 传入也不进 body（Go 的 responses 面没有任何 stop 处理）',
    Object.hasOwn(withStop, 'stop'), false)
  check('stop 字段名不叫 stop_sequences（那是 Anthropic 面的）',
    Object.hasOwn(withStop, 'stop_sequences'), false)
}

// ── 1.7 消息投影：assistant 拆成消息条目 + function_call 顶层条目 ──────────

{
  const body = buildMonkeycodeResponsesBody({
    model: 'ultra/gpt-5.6-sol',
    messages: [
      msg('user', [{ type: 'text', text: '读 a.txt' }]),
      msg('assistant', [
        { type: 'text', text: '好的' },
        { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' },
      ]),
      msg('tool', [{ type: 'text', text: '文件内容' }], { toolCallId: 'call-1' }),
    ],
  })
  const input = body.input
  check('assistant 正文 → {role:assistant,content:[output_text]} 条目', input[2], {
    role: 'assistant', content: [{ type: 'output_text', text: '好的' }],
  })
  check('工具调用 → 顶层 function_call 条目（call_id/name/arguments 字符串）', input[3], {
    type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}',
  })
  check('工具结果 → 顶层 function_call_output 条目（不是消息里的块）', input[4], {
    type: 'function_call_output', call_id: 'call-1', output: '文件内容',
  })
  // 签名对象 + user + assistant 正文 + function_call + function_call_output = 5。
  check('条目总数 = 签名对象 + 4 条投影（工具调用与结果都是顶层条目）', input.length, 5)
}

// ── 1.8 user 纯文本的部件形态（对齐 Go 的 allText 快路径） ─────────────────

{
  // ⚠️ 快路径只吃**裸字符串**数组（Go 的 `b.(string)` 判据）：字符串内容合并成
  // 一个 input_text 部件，省字节。
  const rawStrings = buildMonkeycodeResponsesBody({
    model: 'basic/qwen3.8-flash',
    messages: [msg('user', ['第一段', '第二段'])],
  })
  check('裸字符串内容合并成一个 input_text 部件（Go allText 快路径）',
    rawStrings.input[1], { role: 'user', content: [{ type: 'input_text', text: '第一段第二段' }] })

  // ⚠️ 块数组形态**不合并**（Go 同样如此：`contentBlocks` 原样返回数组，块是 map
  // ⇒ allText 判据为 false）。逐块下发不会丢内容，只是字节多一些。
  const blockForm = buildMonkeycodeResponsesBody({
    model: 'basic/qwen3.8-flash',
    messages: [msg('user', [
      { type: 'text', text: '第一段' },
      { type: 'text', text: '第二段' },
    ])],
  })
  check('块数组形态逐块下发 input_text（与 Go 的 allText 判据一致，不合并）',
    blockForm.input[1], {
      role: 'user',
      content: [
        { type: 'input_text', text: '第一段' },
        { type: 'input_text', text: '第二段' },
      ],
    })

  const mixed = buildMonkeycodeResponsesBody({
    model: 'basic/qwen3.8-flash',
    messages: [msg('user', [
      { type: 'text', text: '看图' },
      { type: 'image', attachment: { attachmentId: 'att-1' } },
    ])],
    images: new Map([['att-1', { mediaType: 'image/png', data: 'QUJD' }]]),
  })
  check('含图片时不合并：文本部件 + input_image 部件（data URL）', mixed.input[1], {
    role: 'user',
    content: [
      { type: 'input_text', text: '看图' },
      { type: 'input_image', image_url: 'data:image/png;base64,QUJD' },
    ],
  })

  await checkRejects('图片未内联时抛错（不静默丢图）', async () => buildMonkeycodeResponsesBody({
    model: 'basic/qwen3.8-flash',
    messages: [msg('user', [{ type: 'image', attachment: { attachmentId: 'missing' } }])],
  }), /图片未能内联[\s\S]*拒绝发出缺少图片的请求/)
}

// ── 1.9 工具配对：孤儿调用 / 孤儿结果都必须剔除 ───────────────────────────

{
  const orphanCall = buildMonkeycodeResponsesBody({
    model: 'ultra/gpt-5.6-sol',
    messages: [
      msg('user', [{ type: 'text', text: 'x' }]),
      msg('assistant', [{ type: 'tool-call', id: 'call-orphan', name: 'f', arguments: '{}' }]),
    ],
  })
  check('孤儿 tool-call 不下发 function_call（上游会 400）',
    orphanCall.input.some((item) => item.type === 'function_call'), false)
  check('孤儿调用只留下 user 条目（assistant 无正文）', orphanCall.input.length, 2)

  const orphanResult = buildMonkeycodeResponsesBody({
    model: 'ultra/gpt-5.6-sol',
    messages: [
      msg('user', [{ type: 'text', text: 'x' }]),
      msg('tool', [{ type: 'text', text: '无主结果' }], { toolCallId: 'call-nobody' }),
    ],
  })
  check('孤儿工具结果不下发 function_call_output',
    orphanResult.input.some((item) => item.type === 'function_call_output'), false)
}

// ── 1.10 边界：空消息 / 空名字调用 / 非法 arguments ───────────────────────

await checkRejects('没有任何可用消息时抛错（不发出空 input）',
  async () => buildMonkeycodeResponsesBody({ model: 'basic/qwen3.8-flash', messages: [] }),
  /请求里没有可用消息/)

{
  const emptyName = buildMonkeycodeResponsesBody({
    model: 'ultra/gpt-5.6-sol',
    messages: [
      msg('user', [{ type: 'text', text: 'x' }]),
      msg('assistant', [{ type: 'tool-call', id: 'call-9', name: '', arguments: '{}' }]),
      msg('tool', [{ type: 'text', text: 'r' }], { toolCallId: 'call-9' }),
    ],
  })
  check('空名字调用不下发（`sse.ts` 记载的 400/11133 毒块）',
    emptyName.input.some((item) => item.type === 'function_call'), false)

  const badArgs = buildMonkeycodeResponsesBody({
    model: 'ultra/gpt-5.6-sol',
    messages: [
      msg('user', [{ type: 'text', text: 'x' }]),
      msg('assistant', [{ type: 'tool-call', id: 'call-2', name: 'f', arguments: '{"a":' }]),
      msg('tool', [{ type: 'text', text: 'r' }], { toolCallId: 'call-2' }),
    ],
  })
  const call = badArgs.input.find((item) => item.type === 'function_call')
  check('非法 arguments 退化为 "{}"（不编造参数，也不丢条目）', call.arguments, '{}')
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. 流式转换
// ═══════════════════════════════════════════════════════════════════════════

// ── 2.1 纯文本 happy path（对齐 Go 的 responsesFixture 顺序） ──────────────

{
  const run = await collect(sseStream([
    { type: 'response.created', response: { id: 'resp-1', created_at: 1790191381 } },
    { type: 'response.in_progress', response: { id: 'resp-1', status: 'in_progress' } },
    { type: 'response.output_item.added', item: { id: 'rs_x', type: 'reasoning', summary: [] }, output_index: 0 },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs_x', delta: 'The user said' },
    { type: 'response.reasoning_summary_text.done', item_id: 'rs_x', text: 'The user said' },
    { type: 'response.output_item.added', item: { id: 'msg_x', role: 'assistant', type: 'message', content: [] }, output_index: 1 },
    { type: 'response.content_part.added', item_id: 'msg_x', part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', item_id: 'msg_x', delta: 'P' },
    { type: 'response.output_text.delta', item_id: 'msg_x', delta: 'ONG' },
    { type: 'response.output_text.done', item_id: 'msg_x', text: 'PONG' },
    {
      type: 'response.completed',
      response: {
        id: 'resp-1',
        status: 'completed',
        usage: {
          input_tokens: 651,
          input_tokens_details: { cached_tokens: 512 },
          output_tokens: 131,
          output_tokens_details: { reasoning_tokens: 129 },
          total_tokens: 782,
        },
      },
    },
  ]))
  check('思考增量 → reasoning 块 + reasoning-delta（先于正文块）', run.slice(0, 2), [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'The user said' },
  ])
  check('文本增量 → text 块 + text-delta', run.slice(2, 5), [
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'P' },
    { type: 'text-delta', index: 1, text: 'ONG' },
  ])
  check('收尾按 index 顺序交出完整块', run.slice(5, 7), [
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'The user said' } },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'PONG' } },
  ])
  check('usage：input_tokens 扣减缓存命中，命中部分单列 cacheReadTokens', run.at(-2), {
    type: 'usage',
    usage: { inputTokens: 139, outputTokens: 131, cacheReadTokens: 512, reasoningTokens: 129 },
  })
  check('finish 为 stop（无工具调用、incomplete_details 缺失）', run.at(-1), {
    type: 'finish', reason: { kind: 'stop' },
  })
  check('output_text.done 的全文不重复拼接（只认 delta）',
    run.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'PONG'), false)
  check('事件流里没有任何内容块被漏掉（chunk 总数）', run.length, 9)
}

// ── 2.2 工具调用：分片参数拼接 + finish_reason = tool-calls ────────────────

{
  const run = await collect(sseStream([
    { type: 'response.created', response: { id: 'r1', created_at: 1 } },
    {
      type: 'response.output_item.added',
      item: { id: 'fc_1', call_id: 'call_9', name: 'lookup', type: 'function_call', arguments: '' },
      output_index: 0,
    },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"q":' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"x"}' },
    {
      type: 'response.output_item.done',
      item: { id: 'fc_1', call_id: 'call_9', name: 'lookup', type: 'function_call', arguments: '{"q":"x"}' },
      output_index: 0,
    },
    { type: 'response.completed', response: { id: 'r1', status: 'completed', usage: { input_tokens: 3, output_tokens: 7 } } },
  ]))
  check('function_call 起块 → block-start(tool-call)', run[0], {
    type: 'block-start', index: 0, blockType: 'tool-call',
  })
  check('起块即带 id/name 与空参数（Go 同款首帧）', run[1], {
    type: 'tool-call-delta', index: 0, id: 'call_9', name: 'lookup', argumentsDelta: '',
  })
  check('参数分片原样下发（按 item_id 定位块）', run.slice(2, 4), [
    { type: 'tool-call-delta', index: 0, id: 'call_9', name: 'lookup', argumentsDelta: '{"q":' },
    { type: 'tool-call-delta', index: 0, id: 'call_9', name: 'lookup', argumentsDelta: '"x"}' },
  ])
  check('block-end 交出拼接后的完整 arguments', run[4], {
    type: 'block-end', index: 0,
    block: { type: 'tool-call', id: 'call_9', name: 'lookup', arguments: '{"q":"x"}' },
  })
  check('finish 为 tool-calls（优先于长度判定）', run.at(-1), {
    type: 'finish', reason: { kind: 'tool-calls' },
  })
  check('usage 无缓存字段时不写 cacheReadTokens', run.at(-2), {
    type: 'usage', usage: { inputTokens: 3, outputTokens: 7 },
  })

  // added 事件直接带完整 arguments（部分实现如此）
  const eager = await collect(sseStream([
    { type: 'response.output_item.added', item: { id: 'fc_e', call_id: 'c_e', name: 'f', type: 'function_call', arguments: '{"a":1}' } },
    { type: 'response.completed', response: { id: 'r', status: 'completed', usage: {} } },
  ]))
  check('added 直接带完整 arguments 时首帧就带上（Go 同款兜底）', eager[1], {
    type: 'tool-call-delta', index: 0, id: 'c_e', name: 'f', argumentsDelta: '{"a":1}',
  })
  check('added 带参数后不再重复下发', eager.filter((c) => c.type === 'tool-call-delta').length, 1)
}

// ── 2.3 空名字 tool-call 整块压制（Go 照发的真实缺陷） ────────────────────

{
  const run = await collect(sseStream([
    { type: 'response.output_item.added', item: { id: 'fc_bad', call_id: 'c_bad', name: '', type: 'function_call', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_bad', delta: '{"a":1}' },
    { type: 'response.output_text.delta', delta: '正文' },
    { type: 'response.completed', response: { id: 'r', status: 'completed', usage: { input_tokens: 1, output_tokens: 2 } } },
  ]))
  check('空名字调用不产 block-start（连块都不建，避免被 assembler 组装）',
    run.some((c) => c.type === 'block-start' && c.blockType === 'tool-call'), false)
  check('空名字调用的参数增量一并丢弃',
    run.some((c) => c.type === 'tool-call-delta'), false)
  check('同流里的正常正文不受影响', run.slice(0, 2), [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '正文' },
  ])
  check('空名字调用不把 finish 拉成 tool-calls', run.at(-1), {
    type: 'finish', reason: { kind: 'stop' },
  })
}

// ── 2.4 流尾残留事件必须被处理（末帧无换行时 completed 不丢） ─────────────

{
  const run = await collect(sseStream([
    { type: 'response.created', response: { id: 'r', created_at: 1 } },
    { type: 'response.output_text.delta', delta: 'x' },
    {
      type: 'response.completed',
      response: {
        id: 'r',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        usage: { input_tokens: 3, output_tokens: 9 },
      },
    },
  ], { trailingNewline: false }))
  check('流尾无换行：末帧 completed 的 status 不丢（截断不被误报成 stop）',
    run.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
  check('流尾无换行：末帧 usage 不丢', run.at(-2), {
    type: 'usage', usage: { inputTokens: 3, outputTokens: 9 },
  })
  check('流尾无换行：正文块的 block-end 仍在', run.at(-3), {
    type: 'block-end', index: 0, block: { type: 'text', text: 'x' },
  })
}

// ── 2.5 未收到 completed 的正常 EOF 仍要收尾 ──────────────────────────────

{
  const run = await collect(sseStream([
    { type: 'response.output_text.delta', delta: 'abc' },
  ]))
  check('上游漏发 completed：EOF 仍补 block-end + usage + finish',
    run.slice(-3), [
      { type: 'block-end', index: 0, block: { type: 'text', text: 'abc' } },
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
}

// ── 2.6 流内 error / response.failed 必须抛错 ─────────────────────────────

await checkRejects('流内 error 帧抛错（不静默结束）', () => collect(sseStream([
  { type: 'response.created', response: { id: 'r' } },
  { type: 'error', error: { type: 'server_error', message: '上游过载' } },
])), /monkeycode: 流内错误：上游过载/)

await checkRejects('error 帧只有 type 时用 type 兜底文案', () => collect(sseStream([
  { type: 'error', error: { type: 'rate_limit_exceeded' } },
])), /monkeycode: 流内错误：rate_limit_exceeded/)

await checkRejects('response.failed 抛错（透传上游 error.message）', () => collect(sseStream([
  { type: 'response.output_text.delta', delta: '半截' },
  { type: 'response.failed', response: { id: 'r', status: 'failed', error: { code: 'server_error', message: '上游崩了' } } },
])), /monkeycode: 流内错误：上游崩了/)

await checkRejects('response.failed 缺 error.message 时有兜底文案', () => collect(sseStream([
  { type: 'response.failed', response: { id: 'r', status: 'failed' } },
])), /monkeycode: 流内错误：upstream response failed/)

// ── 2.7 空响应必须抛错（否则 harness 不会重试） ───────────────────────────

await checkRejects('空响应抛错（只有 created / completed，无任何内容块）', () => collect(sseStream([
  { type: 'response.created', response: { id: 'r' } },
  { type: 'response.in_progress', response: { id: 'r' } },
  { type: 'response.completed', response: { id: 'r', status: 'completed', usage: { input_tokens: 5, output_tokens: 0 } } },
])), /monkeycode: 模型未返回任何内容/)

await checkRejects('完全空流抛错（连一帧都没有）', () => collect(sseStream([])),
  /monkeycode: 模型未返回任何内容/)

// ── 2.8 单个 Responses JSON 兜底（上游忽略 stream 时） ────────────────────

{
  const json = JSON.stringify({
    id: 'r_json',
    object: 'response',
    status: 'completed',
    output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: '想了想' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'PONG' }] },
    ],
    usage: { input_tokens: 17, output_tokens: 2, total_tokens: 19 },
  })
  const run = await collect(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(json))
      controller.close()
    },
  }))
  check('JSON 兜底：reasoning 摘要 + 正文都投影', run.slice(0, 4), [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '想了想' },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'PONG' },
  ])
  check('JSON 兜底：usage 与 finish 与流式同形', run.slice(-2), [
    { type: 'usage', usage: { inputTokens: 17, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])

  const wrapped = await collect(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({
        response: {
          id: 'r_wrap', status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      })))
      controller.close()
    },
  }))
  check('JSON 兜底：外层 response 包裹也能解析', wrapped.at(-3), {
    type: 'block-end', index: 0, block: { type: 'text', text: 'hi' },
  })

  // JSON 里的 error 信封同样必须抛错
  await checkRejects('JSON 兜底的 error 信封抛错', async () => collect(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({
        id: 'r_err', status: 'failed', error: { message: 'JSON 里的错误' },
      })))
      controller.close()
    },
  })), /monkeycode: 流内错误：JSON 里的错误/)
}

// ── 2.9 畸形帧不得中断整条流 ──────────────────────────────────────────────

{
  const run = await collect(sseStream([
    { type: 'response.output_text.delta', delta: 'a' },
    'not-json-at-all',
    { type: 'response.output_text.delta', delta: 'b' },
    'data: [DONE]',
    { type: 'response.completed', response: { id: 'r', status: 'completed', usage: {} } },
  ]))
  check('畸形 JSON 与 [DONE] 被跳过，流继续', run.filter((c) => c.type === 'text-delta'), [
    { type: 'text-delta', index: 0, text: 'a' },
    { type: 'text-delta', index: 0, text: 'b' },
  ])
  check('跳过坏帧后 finish 仍正常', run.at(-1), { type: 'finish', reason: { kind: 'stop' } })
}

// ── 2.10 event: 行、空行、CRLF、逐字节分块 ────────────────────────────────

{
  // 带 `event:` 行 + CRLF（真实抓包形态）
  const raw = [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"r1"}}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"hi"}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}',
    '',
  ].join('\r\n')
  const run = await collect(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(raw))
      controller.close()
    },
  }))
  check('CRLF + event: 行形态能解析（只认 data: 的 JSON）', run, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'hi' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
}

// ── 2.11 usage 的缓存 / 思考字段边界 ──────────────────────────────────────

{
  const runWith = async (usage) => collect(sseStream([
    { type: 'response.output_text.delta', delta: 'x' },
    { type: 'response.completed', response: { id: 'r', status: 'completed', usage } },
  ]))

  check('cached_tokens 显式为 0 时仍写 cacheReadTokens（区分"未命中"与"未上报"）',
    (await runWith({ input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } })).at(-2),
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0 } })
  check('没有 input_tokens_details 时不写 cacheReadTokens',
    (await runWith({ input_tokens: 10, output_tokens: 1 })).at(-2),
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } })
  check('cached 超过 input 时 inputTokens 钳到 0（不产生负数）',
    (await runWith({ input_tokens: 3, output_tokens: 1, input_tokens_details: { cached_tokens: 9 } })).at(-2),
    { type: 'usage', usage: { inputTokens: 0, outputTokens: 1, cacheReadTokens: 9 } })
  check('reasoning_tokens 是 output 的子集，不叠加到 outputTokens',
    (await runWith({ input_tokens: 1, output_tokens: 100, output_tokens_details: { reasoning_tokens: 40 } })).at(-2),
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 100, reasoningTokens: 40 } })
  check('reasoning_tokens 为 0 时不写该键（省得前端显示"零思考"）',
    (await runWith({ input_tokens: 1, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 } })).at(-2),
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } })
  check('usage 非对象时不报错、按全 0 收尾',
    (await runWith(null)).at(-2), { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } })
}

// ── 2.12 纯函数：finish_reason 映射边界 ───────────────────────────────────

check('finish_reason：有工具调用 → tool-calls（即使 incomplete 是长度）',
  mapResponsesFinishReason({ incomplete_details: { reason: 'max_output_tokens' } }, 1),
  { kind: 'tool-calls' })
check('finish_reason：max_output_tokens → max-tokens',
  mapResponsesFinishReason({ incomplete_details: { reason: 'max_output_tokens' } }, 0),
  { kind: 'max-tokens' })
check('finish_reason：content_filter → stop（不编造成 error）',
  mapResponsesFinishReason({ incomplete_details: { reason: 'content_filter' } }, 0),
  { kind: 'stop' })
check('finish_reason：未知 reason → stop',
  mapResponsesFinishReason({ incomplete_details: { reason: 'who_knows' } }, 0),
  { kind: 'stop' })
check('finish_reason：completed 无 details → stop',
  mapResponsesFinishReason({ status: 'completed' }, 0), { kind: 'stop' })

// ── 2.13 多工具调用按到达顺序分配 index ───────────────────────────────────

{
  const run = await collect(sseStream([
    { type: 'response.output_item.added', item: { id: 'fc_a', call_id: 'c_a', name: 'a', type: 'function_call', arguments: '' } },
    { type: 'response.output_item.added', item: { id: 'fc_b', call_id: 'c_b', name: 'b', type: 'function_call', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_b', delta: '{"y":2}' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_a', delta: '{"x":1}' },
    { type: 'response.completed', response: { id: 'r', status: 'completed', usage: {} } },
  ]))
  const ends = run.filter((c) => c.type === 'block-end')
  check('多个工具调用各占一个 index，参数按 item_id 归位', ends, [
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c_a', name: 'a', arguments: '{"x":1}' } },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c_b', name: 'b', arguments: '{"y":2}' } },
  ])
}

// ── 2.14 abort 信号：取消 reader，不误报成功 ──────────────────────────────

{
  const controller = new AbortController()
  // 一个永不结束的流 + 已 abort 的信号：最终必须抛「空响应」而不是静默成功。
  const endless = new ReadableStream({
    start() { /* 不 close，模拟挂起的上游 */ },
    cancel() { /* 被 cancel 时命中 */ },
  })
  controller.abort()
  await checkRejects('已 abort 的信号：不静默成功（按空响应抛错）',
    () => collect(endless, controller.signal), /monkeycode: 模型未返回任何内容/)
}

console.log(failures.length === 0
  ? '\nmonkeycode-responses-test: all checks passed'
  : `\nmonkeycode-responses-test: ${failures.length} check(s) FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
