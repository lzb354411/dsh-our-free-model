/**
 * MonkeyCode 渠道的离线回归：签名固定向量、模型表与三层名称转换、Anthropic 面
 * body 构造、错误分类。
 *
 * 全部**不打网络**、不读真实凭据。固定向量逐字对齐 Go 侧
 * `internal/monkeycode/monkeycode_test.go` 的 `TestSignFixedVector` /
 * `TestSignPreservesCRLF`（签名对不上只会得到 403，且错误信息不区分原因 ——
 * 所以必须有逐字节的参照值，不能"断言自己产出的值"）。
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
function checkTrue(label, value) {
  try {
    assert.ok(value)
    console.log(`ok   ${label}`)
  } catch {
    failures.push(label)
    console.log(`FAIL ${label}`)
  }
}
function checkThrows(label, run, matcher) {
  try {
    run()
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

const mc = await import('../vendor/channel-pack/src/monkeycode.ts')
const sign = await import('../vendor/channel-pack/src/monkeycode-sign.ts')
const anthropic = await import('../vendor/channel-pack/src/monkeycode-anthropic.ts')
const product = await import('../vendor/channel-pack/src/monkeycode-product.ts')
// ⚠️ 面选择从**协议层**取（适配器模块 import 了 account-pool → cordis，
// 离线测试的 kernel 桩不提供宿主服务）。协议层与适配器用的是同一个纯函数。
const { usesResponsesApi: faceUsesResponsesApi } = mc
const { classifyMonkeycodeHttpFailure } = mc

// ── 1. 签名固定向量（逐字节对齐 Go） ──────────────────────────────────────

check('签名固定向量：对齐 Go TestSignFixedVector',
  sign.signMonkeycodePrompt('omas_test_secret', 'You are a helpful assistant.'),
  'v1=a62052ff54bed4f362590aeab65922c85ffefa88b455b71559895fd9c77b53ca')

// ⚠️ 本渠道**最关键**的回归点：官方提示词含 44 个 CRLF，
// 任何换行归一化都会让签名与内容不匹配 → 上游 403（且错误不指向真实原因）。
const crlf = sign.signMonkeycodePrompt('omas_test_secret', 'a\r\nb')
const lf = sign.signMonkeycodePrompt('omas_test_secret', 'a\nb')
checkTrue('签名不得归一化换行：CRLF 与 LF 必须得到不同签名', crlf !== lf)
check('签名固定向量：CRLF 输入对齐 Go TestSignPreservesCRLF',
  crlf, 'v1=709a1e4a08a739619cd1b47e9cf7bf5b85f6c394259209e5ab7b93fa5bd4647b')

check('签名带 v1= 前缀且为小写 hex（不是 base64）',
  /^v1=[0-9a-f]{64}$/.test(sign.signMonkeycodePrompt('omas_x', 'You are a helpful assistant.')), true)

// secret 缓存：同一 secret 两次取签名必须一致
sign.clearMonkeycodeSignatureCache()
const s1 = sign.monkeycodeSignature('omas_test_secret')
const s2 = sign.monkeycodeSignature('omas_test_secret')
checkTrue('签名按 secret 缓存：两次结果一致', s1 === s2 && s1.startsWith('v1='))
checkThrows('空 signing_secret 抛可行动错误（提示重新导入）',
  () => sign.monkeycodeSignature('   '), /缺少 signing_secret[\s\S]*重新导入/)

// ── 2. 模型表与三层名称转换 ───────────────────────────────────────────────

check('静态模型表恰好 25 条', mc.MONKEYCODE_STATIC_MODELS.length, 25)

// 三层：对外 monkeycode/basic/x → 渠道内 basic/x → 上游 monkeycode-basic/x
check('三层名称转换：带档位条目补 monkeycode- 前缀',
  mc.toUpstreamModelId('monkeycode/basic/deepseek-flash'), 'monkeycode-basic/deepseek-flash')
check('三层名称转换：裸名不加前缀',
  mc.toUpstreamModelId('monkeycode/deepseek-flash'), 'deepseek-flash')
check('三层名称转换：已带上游前缀的原样透传',
  mc.upstreamModelName('monkeycode-basic/x'), 'monkeycode-basic/x')
check('裸 ID 归一：剥渠道前缀与上游前缀',
  mc.bareModelId('monkeycode/monkeycode-basic/x'), 'basic/x')

// Responses 面恰好 4 个（对齐 Go TestUsesResponsesAPI）
const responsesYes = [
  'basic/qwen3.8-flash', 'pro/gpt-5.6-terra', 'ultra/gpt-5.6-sol', 'ultra/gpt-6-astra',
  'monkeycode/basic/qwen3.8-flash', 'monkeycode-ultra/gpt-6-astra',
]
const responsesNo = ['basic/deepseek-flash', 'monkeycode/basic/deepseek-flash', 'pro/glm-5', 'ultra/glm-5.1']
checkTrue('Responses 面判定：6 种形态（含对外/渠道内/上游形态）全部命中',
  responsesYes.every((id) => mc.usesResponsesApi(id)))
checkTrue('Responses 面判定：非 Responses 模型全部不命中',
  responsesNo.every((id) => !mc.usesResponsesApi(id)))
check('Responses 面模型数为 4',
  mc.MONKEYCODE_STATIC_MODELS.filter((id) => mc.usesResponsesApi(id)).length, 4)

// 本地模型校验（上游对未知模型静默回落默认模型 ⇒ 必须本地拒绝）
checkTrue('本地校验：静态表内模型通过', mc.modelAllowed('monkeycode/basic/deepseek-flash'))
checkTrue('本地校验：未知模型被拒', !mc.modelAllowed('definitely-not-a-model'))
// 中文展示名**不是**合法 ID（发给上游会得到纯文本 Forbidden）
checkTrue('本地校验：中文展示名不是合法模型 ID',
  !mc.modelAllowed('pro/专业模型-5.6-terra'))
checkTrue('展示名映射存在（3 个中文名模型）',
  mc.modelDisplayName('pro/gpt-5.6-terra') === '专业模型 5.6 terra')

// ── 3. Anthropic 面 body 构造 ─────────────────────────────────────────────

const payload = anthropic.buildMonkeycodeAnthropicBody({
  model: 'monkeycode/basic/deepseek-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
  system: '你是客服',
})
check('Anthropic 面：model 补成上游形态', payload.model, 'monkeycode-basic/deepseek-flash')
check('Anthropic 面：强制 stream:true', payload.stream, true)
check('Anthropic 面：max_tokens 缺省 16384', payload.max_tokens, 16_384)
check('Anthropic 面：system[0] 恒为签名常量（28 字符，无 CRLF）', payload.system[0], {
  type: 'text', text: 'You are a helpful assistant.',
})
check('Anthropic 面：客户端 system 排在 system[1]',
  payload.system[1], { type: 'text', text: '你是客服' })
checkTrue('Anthropic 面：签名常量不可含 CRLF',
  !mc.MONKEYCODE_SIGNATURE_SYSTEM_PROMPT.includes('\r')
  && !mc.MONKEYCODE_SIGNATURE_SYSTEM_PROMPT.includes('\n'))
check('Anthropic 面：签名常量长 28 字符', mc.MONKEYCODE_SIGNATURE_SYSTEM_PROMPT.length, 28)

check('max_tokens 钳制：超上限夹到 32000', anthropic.resolveMaxTokens(999_999), 32_000)
check('max_tokens 钳制：非正数回缺省', anthropic.resolveMaxTokens(0), 16_384)
check('max_tokens 钳制：缺失回缺省', anthropic.resolveMaxTokens(undefined), 16_384)
check('max_tokens 钳制：区间内原样', anthropic.resolveMaxTokens(64), 64)

// thinking：两面统一「未表达即开」，仅 none 关（对齐 Go TestThinkingProjection）
check('thinking：未表达 → enabled（显式补，不依赖上游默认）',
  anthropic.thinkingForEffort(undefined), { type: 'enabled' })
check('thinking：none → disabled', anthropic.thinkingForEffort('none'), { type: 'disabled' })
check('thinking：low → enabled（本面无档位，压成开关两态）',
  anthropic.thinkingForEffort('low'), { type: 'enabled' })

// tools：必须转成 Anthropic 的 input_schema 形态
const withTools = anthropic.buildMonkeycodeAnthropicBody({
  model: 'monkeycode/basic/deepseek-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
  tools: [{ name: 'lookup', description: '查', parameters: { type: 'object', properties: {} } }],
})
check('Anthropic 面：tools → {name, description, input_schema}',
  withTools.tools, [{ name: 'lookup', description: '查', input_schema: { type: 'object', properties: {} } }])
checkTrue('Anthropic 面：无 tools 时不下发该字段',
  !('tools' in anthropic.buildMonkeycodeAnthropicBody({
    model: 'monkeycode/basic/deepseek-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
  })))

// 请求头：anthropic 面带 anthropic-version，responses 面不带
const hAnthropic = anthropic.monkeycodeInferHeaders({
  apiKey: 'oma_test', signature: 'v1=abc', responsesFace: false,
})
const hResponses = anthropic.monkeycodeInferHeaders({
  apiKey: 'oma_test', signature: 'v1=abc', responsesFace: true,
})
check('请求头：X-Api-Key 与签名头就位',
  { key: hAnthropic['X-Api-Key'], sig: hAnthropic['X-Ohmyagent-Signature'] },
  { key: 'oma_test', sig: 'v1=abc' })
check('请求头：anthropic 面带 anthropic-version', hAnthropic['anthropic-version'], '2023-06-01')
checkTrue('请求头：Responses 面不带 anthropic-version', !('anthropic-version' in hResponses))
check('请求头：UA 为官方客户端形态', hAnthropic['user-agent'], 'ohmyagent f6b21ad')

// ── 4. 面选择与错误分类 ───────────────────────────────────────────────────

check('面选择：21 个模型走 messages', faceUsesResponsesApi('monkeycode/basic/deepseek-flash') ? 'responses' : 'messages', 'messages')
check('面选择：4 个模型走 responses', faceUsesResponsesApi('monkeycode/ultra/gpt-6-astra') ? 'responses' : 'messages', 'responses')

// ⚠️ 403 必须与 401 分开：403 是签名/协议错（请求级），不得当账号失效。
const e403 = classifyMonkeycodeHttpFailure(403, '{"error":"invalid ohmyagent request"}')
check('错误分类：403 → PERMISSION_DENIED（不是 AUTH）', e403.code, 'PERMISSION_DENIED')
checkTrue('错误分类：403 文案给出「检查 signing_secret」的可行动指引',
  /signing_secret/.test(e403.message))
const e403b = classifyMonkeycodeHttpFailure(403, 'Forbidden')
checkTrue('错误分类：纯文本 403（展示名当 ID）文案指向模型 ID',
  /模型 ID/.test(e403b.message))
check('错误分类：401 → AUTH', classifyMonkeycodeHttpFailure(401, '').code, 'AUTH')
check('错误分类：429 → RATE_LIMIT', classifyMonkeycodeHttpFailure(429, '').code, 'RATE_LIMIT')
check('错误分类：400 → INVALID_REQUEST', classifyMonkeycodeHttpFailure(400, '').code, 'INVALID_REQUEST')
check('错误分类：500 → SERVER', classifyMonkeycodeHttpFailure(500, '').code, 'SERVER')

// ── 5. 凭据形状与「无续期」不变式 ─────────────────────────────────────────

checkTrue('凭据可用判据：两把密钥齐全', mc.isUsableMonkeycodeCredential({
  access_token: 'oma_x', signing_secret: 'omas_y',
}))
checkTrue('凭据可用判据：缺 signing_secret 时判不可用',
  !mc.isUsableMonkeycodeCredential({ access_token: 'oma_x', signing_secret: '  ' }))
checkTrue('凭据可用判据：缺 api_key 时判不可用',
  !mc.isUsableMonkeycodeCredential({ access_token: '', signing_secret: 'omas_y' }))
// ⚠️ 本渠道**没有 refresh 端点**，故恒不可续期（挂上调度器只会每天产生必然失败）。
checkTrue('无续期不变式：isMonkeycodeRefreshable 恒 false',
  mc.isMonkeycodeRefreshable({ access_token: 'oma_x', signing_secret: 'omas_y' }) === false)
checkTrue('无续期不变式：导入凭据写远期（now + 50 年）⇒ 不判过期',
  mc.isMonkeycodeExpired({
    access_token: 'oma_x', signing_secret: 'omas_y',
    expires_at: mc.monkeycodeImportedExpiresAt(),
  }) === false)
checkTrue('过期判定：手工写入过去时刻时如实报过期',
  mc.isMonkeycodeExpired({
    access_token: 'oma_x', signing_secret: 'omas_y', expires_at: Date.now() - 1000,
  }) === true)
checkTrue('过期判定：无过期信息时视为可用（不凭猜测阻止使用）',
  mc.isMonkeycodeExpired({ access_token: 'oma_x', signing_secret: 'omas_y' }) === false)

// uid 派生：稳定且形如 mc_+10 hex（上游无 uid）
const uid = mc.monkeycodeUidFromApiKey('oma_test_key')
check('uid 派生：形如 mc_ + sha256 前 5 字节 hex', /^mc_[0-9a-f]{10}$/.test(uid), true)
check('uid 派生：同一 api_key 稳定', mc.monkeycodeUidFromApiKey('oma_test_key'), uid)
checkTrue('uid 派生：不同 api_key 得到不同 uid',
  mc.monkeycodeUidFromApiKey('oma_other') !== uid)

checkTrue('凭据解析：缺 signing_secret 也能解析（宽松口径，供账号池身份标识）',
  mc.parseMonkeycodeCredential('{"access_token":"oma_x"}') !== undefined)
checkTrue('凭据解析：缺 access_token 时判失败',
  mc.parseMonkeycodeCredential('{"signing_secret":"omas_y"}') === undefined)
checkTrue('凭据解析：非 JSON 判失败', mc.parseMonkeycodeCredential('not-json') === undefined)

// ── 6. 产品定义与三个域 ───────────────────────────────────────────────────

check('产品：三个域各自独立（推理 / 控制台 / 百智云）', {
  infer: product.MONKEYCODE.inferBase,
  console: product.MONKEYCODE.consoleBase,
  baizhi: product.MONKEYCODE.baizhiBase,
}, {
  infer: 'https://proxy.monkeycode-ai.com/v1',
  console: 'https://monkeycode-ai.com',
  baizhi: 'https://baizhi.cloud',
})
check('产品：id 为 monkeycode', product.MONKEYCODE.id, 'monkeycode')
check('产品：兜底表条目数 = 静态表', product.MONKEYCODE.models.length, 25)
checkTrue('产品：条目 id 一律带渠道前缀（与 /v1/models 口径一致）',
  product.MONKEYCODE.models.every((m) => m.id.startsWith('monkeycode/')))
checkTrue('产品：不编造 contextWindow / maxTokens（上游无目录接口）',
  product.MONKEYCODE.models.every((m) => m.contextWindow === undefined && m.maxTokens === undefined))
checkTrue('产品：两个 Cookie 名与 Go 常量一致',
  product.MONKEYCODE.id === 'monkeycode'
  && mc.MONKEYCODE_COOKIE_CONSOLE === 'monkeycode_ai_session'
  && mc.MONKEYCODE_COOKIE_BAIZHI === 'baizhi_session')

console.log(failures.length === 0
  ? '\nmonkeycode-channel-test: all checks passed'
  : `\nmonkeycode-channel-test: ${failures.length} check(s) FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
