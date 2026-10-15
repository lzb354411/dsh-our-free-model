/**
 * MonkeyCode 的 LLM 适配器。
 *
 * ## 渠道形态速览
 *
 * | 项 | 值 |
 * |---|---|
 * | 协议 | **Anthropic Messages**（21 个模型）+ **OpenAI Responses**（4 个模型） |
 * | 鉴权 | `X-Api-Key`(oma_) + `X-Ohmyagent-Signature`(HMAC) |
 * | 账号来源 | **导入型**（本机官方客户端，无登录流程） |
 * | 续期 | **无**（上游无 refresh 端点） |
 * | 签到 | **无**（上游未提供额度或签到端点） |
 * | 模型目录 | **静态表**（上游 `GET /models` 返回 405） |
 *
 * ## 三条必须保留的上游约束（每条都对应一次实测踩坑）
 *
 * 1. **强制 `stream: true`**：透传 `false` 时上游回单个 JSON，被 SSE 消费器
 *    整包丢弃 ⇒ HTTP 200 但 content 空、usage 0 的**静默失败**。
 * 2. **未知模型必须本地拒绝**：上游对未知模型**静默回落默认模型**并返回 200
 *    —— 不校验会让用户以为在用 A 实际扣 B 的额度。
 * 3. **403 / 400 是请求级，不得当账号失效**：
 *    `403 {"error":"invalid ohmyagent request"}`（签名/协议错）必须归请求级；
 *    否则健康账号被冷却、甚至整渠道下线（Go 侧 `Classify` 把它归 `ErrPassthrough`）。
 *
 * ## ⚠️ 错误码选择：为什么 403 不取 `AUTH`
 *
 * 仓库既有结论（`buddy-adapter.ts:471-498`，有实测出处）：DSH 聊天 UI 对
 * `AUTH` 会把整条 message **替换成固定文案「API 密钥无效」**，
 * 精心写的中文说明一个字都到不了用户眼前。而 MonkeyCode 的 403 根本不是
 * 「密钥无效」——它是**签名/协议不匹配**，用户该做的是重新导入客户端凭据，
 * 不是去改 Key。故取 `PERMISSION_DENIED`（与 `cline-adapter.ts` 的地域限制
 * 分支同惯例），它同时**不在** harness 的 `DEFAULT_RETRYABLE_CODES` 里：
 * 确定性拒绝没必要白退避 5 次。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { providerCatalogVisible } from './account-pool.js'
import type { AccountPool } from './account-pool.js'
import { collectImages } from './openai-compat.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'
import { consumeAnthropicSse } from './anthropic-sse.js'
import {
  isMonkeycodeExpired,
  isUsableMonkeycodeCredential,
  type MonkeycodeCredential,
} from './monkeycode.js'
import { monkeycodeSignature } from './monkeycode-sign.js'
import { bareModelId, modelAllowed, usesResponsesApi } from './monkeycode.js'
import {
  buildMonkeycodeAnthropicBody,
  monkeycodeInferHeaders,
} from './monkeycode-anthropic.js'
import {
  MONKEYCODE,
  MONKEYCODE_MESSAGES_PATH,
  MONKEYCODE_RESPONSES_PATH,
  type MonkeycodeModelEntry,
  type MonkeycodeProduct,
} from './monkeycode-product.js'
import {
  buildMonkeycodeResponsesBody,
  consumeMonkeycodeResponsesSse,
} from './monkeycode-responses.js'

export interface MonkeycodeAdapterOptions {
  credentialRef: CredentialRef
  /** 解析当前该用哪个凭据（优先账号池，回退默认单凭据 ref）。 */
  resolveCredential: (modelId?: string) => Promise<MonkeycodeCredential | undefined>
  /**
   * 本渠道**恒为 no-op**。
   *
   * ⚠️ 保留它只为满足与其它适配器一致的调用形状；MonkeyCode **没有 refresh
   * 端点**（上游 `RefreshToken` 是空实现）。任何实现都不应真去发续期请求。
   */
  refresh?: () => Promise<void>
  /** 网络出口（按次解析 `globalThis.fetch` + 系统代理）。 */
  fetchImpl?: typeof fetch
  /** 图片字节桥接；未提供时遇图报错。 */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 账号池（用于 `listModels` 的可见性判定）。 */
  accountPool?: AccountPool
  /** 产品配置；默认 {@link MONKEYCODE}。 */
  product?: MonkeycodeProduct
}

/** MonkeyCode 模型适配器。 */
export class MonkeycodeAdapter extends LlmAdapter {
  private readonly product: MonkeycodeProduct

  constructor(private readonly options: MonkeycodeAdapterOptions) {
    super()
    this.product = options.product ?? MONKEYCODE
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? globalThis.fetch
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 完整目录（**不套黑名单**），供 Channel Pack「显示列表」用。
   *
   * ⚠️ **必须同步返回数组，不能是 `async`**（`minimax-adapter.ts:218-246` 记录了
   * 写成 async 会让「显示列表」与「关闭全部」同时崩的真实缺陷）。
   * 本渠道目录是纯静态表，无缓存/无 IO，天然同步。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    return this.product.models.map((model) => ({ id: model.id, name: model.name }))
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️ 无已登录账号时返回 `[]` → DSH 把整个 provider 分组隐藏。
    // **必须返回空数组而不能抛错**（抛错会多一条 provider 报错）。
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return []
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? this.product.models
      : this.product.models.filter((model) => !disabled.has(model.id))
    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      name: model.name,
      // 上游未声明模态 ⇒ 统一 text（不猜测图片能力）。
      inputModalities: ['text'] as const,
    }))
  }

  async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const entry = this.product.models.find((item) => item.id === model)
    return {
      provider,
      id: model,
      name: entry?.name ?? model,
      inputModalities: ['text'] as const,
    }
  }

  /** 兼容 0.1.1-rc.2 的 `prepareCall` shim（与其余适配器同款）。 */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  /**
   * 发一次流式请求（按模型选面）。
   *
   * ⚠️ 凭据**不需要**续期（本渠道无 refresh 端点）——故这里不做
   * 「过期先刷新」那一步，与其它适配器有意不同。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // ⚠️ 未知模型**本地拒绝**（上游会静默回落默认模型并返回 200）。
    if (!modelAllowed(options.model)) {
      throw new LlmError(
        `monkeycode: 未知模型 "${options.model}"（本渠道模型清单见面板；`
        + '上游对未知模型会静默回落到默认模型，故这里本地拒绝以免误扣额度）',
        'INVALID_REQUEST',
      )
    }

    const credential = await this.options.resolveCredential(options.model)
    if (!isUsableMonkeycodeCredential(credential)) {
      throw new LlmError(
        'monkeycode: 无可用凭据（需要 api_key + signing_secret），'
        + '请在面板点击「导入客户端凭据」',
        'MISSING_CREDENTIAL',
      )
    }
    // 判过期：本渠道凭据导入时写远期，正常不会过期；手工改坏时报明确错误。
    if (isMonkeycodeExpired(credential)) {
      throw new LlmError(
        'monkeycode: 凭据已过期（请重新导入客户端凭据）',
        'MISSING_CREDENTIAL',
      )
    }

    // 图片：上游未声明任何模型支持图片 ⇒ 收到图片一律**报错**
    //（不静默丢弃，否则用户以为图片被看到了）。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    if (imageRefs.size > 0) {
      throw new LlmError(
        'monkeycode: 本渠道上游未声明图片输入能力，拒绝发送带图片的请求',
        'UNSUPPORTED_CONTENT',
      )
    }

    // 签名按 secret 缓存（签名输入是常量，同一账号只算一次）。
    let signature: string
    try {
      signature = monkeycodeSignature(credential.signing_secret)
    } catch (error) {
      throw new LlmError(
        error instanceof Error ? error.message : String(error),
        'MISSING_CREDENTIAL',
      )
    }

    const responsesFace = usesResponsesApi(options.model)
    const base = this.inferBase(credential)
    const url = `${base}${responsesFace ? MONKEYCODE_RESPONSES_PATH : MONKEYCODE_MESSAGES_PATH}`

    const body = responsesFace
      ? buildMonkeycodeResponsesBody({
        model: options.model,
        messages: options.messages,
        ...(options.system === undefined ? {} : { system: options.system }),
        ...(options.tools === undefined ? {} : { tools: options.tools }),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        ...(options.stop === undefined ? {} : { stop: options.stop }),
        ...(options.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: String(options.reasoningEffort) }),
      })
      : buildMonkeycodeAnthropicBody({
        model: options.model,
        messages: options.messages,
        ...(options.system === undefined ? {} : { system: options.system }),
        ...(options.tools === undefined ? {} : { tools: options.tools }),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        ...(options.stop === undefined ? {} : { stop: options.stop }),
        ...(options.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: String(options.reasoningEffort) }),
      })

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: monkeycodeInferHeaders({
        apiKey: credential.access_token,
        signature,
        responsesFace,
      }),
      body: JSON.stringify(body),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw classifyMonkeycodeHttpFailure(response.status, text)
    }
    if (response.body === null) {
      throw new LlmError('monkeycode: 响应缺少 body', 'EMPTY_RESPONSE')
    }

    yield* responsesFace
      ? consumeMonkeycodeResponsesSse({
        body: response.body,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        errorLabel: 'monkeycode',
        emptyMessage: '模型未返回任何内容块',
      })
      : consumeAnthropicSse({
        body: response.body,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        // ⚠️ 用 monkeycode 作前缀（不是 minimax）：错误文案要指向本渠道，
        // 否则用户看到 "minimax: 流内错误" 会去查错误的渠道。
        errorLabel: 'monkeycode',
        emptyMessage: '模型未返回任何内容块',
      })
  }

  /** 推理基址：客户端 `base_url` 优先，回退产品常量。 */
  private inferBase(credential: MonkeycodeCredential): string {
    const fromClient = credential.base_url
    if (typeof fromClient === 'string' && fromClient.trim() !== '') {
      return fromClient.trim().replace(/\/+$/, '')
    }
    return this.product.inferBase
  }
}

/**
 * HTTP 失败 → `LlmError`。
 *
 * ⚠️ 实现与完整理由在 `monkeycode.ts` 的 `classifyMonkeycodeHttpFailure`
 * （那里是纯协议层，可被离线单测直接锁住，不必牵引 cordis/账号池）。
 * 此处 re-export 供既有调用方与测试按模块就近使用。
 */
export { classifyMonkeycodeHttpFailure } from './monkeycode.js'

/** 在 `ctx.llm` 上注册 monkeycode provider 路由与适配器。 */
export function registerMonkeycodeLlm(
  ctx: Context,
  options: MonkeycodeAdapterOptions,
): MonkeycodeAdapter {
  const product = options.product ?? MONKEYCODE
  const adapter = new MonkeycodeAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter, (message) => {
    ctx.logger?.warn?.(message)
  })
  return adapter
}

/** 供测试直接检查面选择（不导出到其它模块使用）。 */
export function monkeycodeFaceOf(model: string): 'messages' | 'responses' {
  return usesResponsesApi(model) ? 'responses' : 'messages'
}

/** 供测试/诊断：裸模型 ID。 */
export const monkeycodeBareModelId = bareModelId

/** 模型条目类型再导出（避免调用方从多文件 import）。 */
export type { MonkeycodeModelEntry }
