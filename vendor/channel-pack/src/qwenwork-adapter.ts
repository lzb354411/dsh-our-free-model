/**
 * 千问办公 LLM 适配器。
 *
 * ## 数据流（与 Go 侧分层同构）
 *
 * ```
 * DSH GenerateOptions
 *   → 构造 OpenAI body（messages 原样透传，本渠道不改写消息）
 *   → prepareChatBody 等价变换：model 映射 + request_id/session_id + business 段 + stream 强制
 *   → COSY 签名（Authorization/Cosy-Key/Cosy-User/Cosy-Date）+ x-model-key
 *   → POST gateway.qwenwork.cn/…/agent_chat_generation
 *   → 拆壳（信封剥离，qwenwork-sse.ts）
 *   → consumeOpenAiSse（通用 OpenAI SSE 消费器）
 *   → StreamChunk
 * ```
 *
 * ## ⚠️ 三个必须真的做到的点
 *
 * 1. **`business` 段必须进 body**：缺失时上游恒返回 HTTP 200 + 信封
 *    503 `Model catalog unavailable`（看起来像「模型不可用」，实为缺字段）。
 * 2. **`x-model-key` 必须与 body 的 model 一致**：它决定实际路由且**优先级高于
 *    body.model**。二者不一致会让「日志里记的模型」与「实际路由的模型」不符。
 * 3. **`listAllModels()` 必须实现**：设置页要显示被关闭的模型及其倍率；
 *    缺了它会退化为裸 id（仓库记录的真实缺陷）。
 *
 * ## 不复用 `openai-compat.ts` 的哪部分
 *
 * `consumeOpenAiSse` **复用**（它承载了大量实测修复）。但它的**请求侧**序列化
 * （`serializeMessages` 等）不复用 —— 本渠道不改写 messages，直接透传客户端的
 * wire 消息即可（Go 侧同样不做改写）。少一层翻译就少一处失真。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { AccountPool, providerCatalogVisible } from './account-pool.js'
import { RemoteCatalogGate } from './remote-catalog-gate.js'
import { collectImages, consumeOpenAiSse, errorDetail, httpErrorCode, isTransportError } from './openai-compat.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'
import { QWENWORK, type QwenworkProduct } from './qwenwork-product.js'
import {
  QWENWORK_BUSINESS_PRODUCT,
  QWENWORK_BUSINESS_TYPE,
  QWENWORK_CHAT_PATH,
  QWENWORK_REQUEST_TIMEOUT_MS,
  isQwenworkExpired,
  isQwenworkRefreshable,
  qwenworkModelKey,
  type QwenworkCredential,
} from './qwenwork.js'
import { cosyAuthHeader, createCosySession } from './qwenwork-cosy.js'
import { deEnvelopeQwenworkSse } from './qwenwork-sse.js'
import type { QwenworkRemoteModel } from './qwenwork-auth.js'

/** 本适配器注册的 provider 路由名（等价于 `QWENWORK.id`）。 */
export const PROVIDER = 'qwenwork'

/** 适配器选项。 */
export interface QwenworkAdapterOptions {
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  credentialRef: CredentialRef
  /**
   * 解析一次请求要用的凭据。
   *
   * ⚠️ 入参 `modelId` 必须透传：账号池要按「账号 × 模型」的限流状态过滤候选。
   */
  resolveCredential: (modelId?: string) => Promise<QwenworkCredential | undefined>
  /** 续期（过期或 401/403 时调用）。 */
  refresh: () => Promise<void>
  /** 拉远端模型目录；失败时适配器回退兜底表。 */
  fetchRemoteModels?: () => Promise<readonly QwenworkRemoteModel[]>
  /** 读取图片字节（支持图片的模型需要）。 */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 账号池（目录可见性与黑名单过滤用）。 */
  accountPool?: AccountPool
  /** 产品配置。 */
  product?: QwenworkProduct
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
}

/** 把兜底模型条目转成远端条目形状（两条路径共用一个渲染口径）。 */
function fallbackToRemote(model: {
  id: string
  name: string
  contextWindow: number
  supportsImage: boolean
  priceFactor: number
}): QwenworkRemoteModel {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    supportsImage: model.supportsImage,
    priceFactor: model.priceFactor,
  }
}

/** 过滤掉非正整数（远端非法值 `null`/`0`/负数一律不声明，让 DSH 用默认值）。 */
function positiveInt(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * 千问办公 LLM 适配器。
 *
 * 服务的 provider id 与模型 id 都**不含**渠道前缀（DSH 与其余渠道一致，
 * 前缀由模型目录层负责）。
 */
export class QwenworkAdapter extends LlmAdapter {
  private readonly product: QwenworkProduct
  private readonly fetchImpl: typeof fetch
  /** 兜底模型索引（id → 条目）。 */
  private readonly fallbackIndex: ReadonlyMap<string, QwenworkRemoteModel>
  /** 远端模型缓存；未拉取时为 undefined。 */
  private remoteModels: QwenworkRemoteModel[] | undefined
  /** 目录加载闸门：并发去重 + 失败/空结果冷却（见 `remote-catalog-gate.ts`）。 */
  private readonly catalogGate = new RemoteCatalogGate()

  constructor(private readonly options: QwenworkAdapterOptions) {
    super()
    this.product = options.product ?? QWENWORK
    this.fetchImpl = options.fetchImpl ?? fetch
    this.fallbackIndex = new Map(
      this.product.fallbackModels.map((model) => [model.id, fallbackToRemote(model)]),
    )
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，
   * 而模型设置页会用该 id 计算 `deriveKeyRef(provider)`（内部调
   * `provider.toUpperCase()`）。一旦 provider 不是字符串，回退到本产品 id。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 完整目录（**不套黑名单**），带最终展示名。
   *
   * 设置页需要它渲染被关闭的模型 —— 否则那些条目只能凭 `disabledMap` 的 key 补回，
   * 而那条路径拿不到展示名，会退化成裸 id（倍率与模型名随之丢失）。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    const source = this.remoteModels ?? this.product.fallbackModels.map(fallbackToRemote)
    return source.map((model) => ({ id: model.id, name: model.name }))
  }

  /**
   * 取远端模型目录；**失败时不把兜底表写进缓存**。
   *
   * ⚠️ 不缓存兜底表：否则一次瞬时失败会让该 provider **整个进程生命周期**都只剩
   * 兜底模型（用户看不到自己的模型，且无从触发重试，只能重启）。
   * 只缓存**真实远端目录**，兜底表每次现算（纯本地、零成本），并用
   * {@link RemoteCatalogGate} 的冷却挡住「每模型重试一次」的放大。
   */
  private async loadModels(): Promise<QwenworkRemoteModel[]> {
    if (this.remoteModels !== undefined) return this.remoteModels
    const fetchRemote = this.options.fetchRemoteModels
    if (fetchRemote !== undefined) {
      await this.catalogGate.run(async () => {
        const fetched = await fetchRemote()
        if (fetched.length === 0) return false
        this.remoteModels = [...fetched]
        return true
      })
      if (this.remoteModels !== undefined) return this.remoteModels
    }
    return this.product.fallbackModels.map(fallbackToRemote)
  }

  private inputModalitiesFor(model: QwenworkRemoteModel | undefined): readonly ('text' | 'image')[] {
    return model?.supportsImage === true ? ['text', 'image'] : ['text']
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️ 无已登录账号时返回 `[]` → DSH 的 buildModelCatalog 把整个 provider 分组隐藏。
    // **必须返回空数组而不能抛错**（抛错会被归入 catalog 的 failures，
    // 界面上反而多一条 provider 报错）。
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return []

    const all = await this.loadModels()
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? all
      : all.filter((model) => !disabled.has(model.id))

    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      // 倍率拼进 name（不是 description）：composer 的模型切换菜单只渲染 name。
      name: model.name,
      inputModalities: this.inputModalitiesFor(model),
    }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const all = await this.loadModels()
    const entry = all.find((item) => item.id === model)
    const fallback = this.fallbackIndex.get(model)
    // ⚠️ name **不带倍率**（与 qoder/trae/loomy 一致）：价格只属于选择列表语境。
    const bareName = fallback !== undefined ? fallback.name.replace(/ · .*$/, '') : model
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry !== undefined ? entry.name.replace(/ · .*$/, '') : bareName,
      inputModalities: this.inputModalitiesFor(entry),
    }
    const contextWindow = entry?.contextWindow ?? fallback?.contextWindow
    // 未知模型不编造 context（宁可让 DSH 用默认值，也不报一个假窗口）。
    if (contextWindow !== undefined && contextWindow > 0) {
      resolved.context = { contextWindow }
    }
    void positiveInt(undefined)
    // ⚠️ 本渠道**不声明**思考档位：上游模型目录没有下发任何档位声明。
    // 「把未声明显示成具体档位」就是编造（见仓库对思考档位的一贯口径）。
    return resolved
  }

  /**
   * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
   * 基类尚未提供该方法。与其余适配器同款 shim。
   */
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

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 图片能力按**模型**判定。不能放宽成「总是接受」：DSH 在 LlmRuntime 里
    // 按适配器播报的 inputModalities 决定要不要把图片投影成文本占位符，
    // 声明支持就必须真支持。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    const all = await this.loadModels()
    const entry = all.find((item) => item.id === options.model)
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      if (!this.inputModalitiesFor(entry).includes('image')) {
        throw new LlmError(`qwenwork: 模型 "${options.model}" 不支持图片输入`, 'UNSUPPORTED_CONTENT')
      }
      if (this.options.readImage === undefined) {
        throw new LlmError('qwenwork: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT')
      }
      // 保留**空 Map**（而非降级为 undefined）：图片存在但全部读取失败时，
      // 空 Map 仍会让消息序列化产出占位符，而不是静默丢图。
      imageUrls = new Map()
      const readImage = this.options.readImage
      for (const [id, ref] of imageRefs) {
        const image = await readImage(ref)
        if (image === undefined) continue
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
      }
    }

    // 步骤 1: 取凭据（过期则先续期一次）
    let credential = await this.options.resolveCredential(options.model)
    if (credential === undefined || isQwenworkExpired(credential)) {
      if (credential !== undefined && isQwenworkRefreshable(credential)) {
        await this.options.refresh()
      }
      credential = await this.options.resolveCredential(options.model)
    }
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError('qwenwork: 无可用凭据，请先登录', 'MISSING_CREDENTIAL')
    }
    if (credential.uid === undefined || credential.uid === '') {
      throw new LlmError('qwenwork: 凭据缺少 uid，无法签名（请重新登录该账号）', 'MISSING_CREDENTIAL')
    }

    /**
     * 构造请求体。
     *
     * ⚠️ **必须在重试时重建**（不是重算一次就够）：`request_id` 每次新生成，
     * 而签名覆盖整个 body —— 复用旧 body 会让 `request_id` 与签名不匹配
     *（实际上签名仍会重算，但 request_id 复用会撞上游的去重逻辑）。
     */
    const buildBody = (): string => {
      const upstreamModel = qwenworkModelKey(options.model)
      // messages 原样透传：本渠道服务端无状态、不改写消息（developer 角色实测可接受）。
      const messages = options.messages.map((message) => {
        const content = imageUrls === undefined || imageUrls.size === 0
          ? message.content
          : substituteImages(message.content, imageUrls)
        return { role: message.role, content }
      })
      const wireMessages = options.system !== undefined && options.system.length > 0
        ? [{ role: 'system', content: options.system }, ...messages]
        : messages

      return JSON.stringify({
        model: upstreamModel,
        messages: wireMessages,
        // ⚠️ 必填：缺失时上游返回信封 400（HTTP 仍 200）
        request_id: crypto.randomUUID(),
        session_id: crypto.randomUUID(),
        // ⚠️ 必填：上游 1.0.4 起按 body.business 解析模型目录；
        // 缺失 → 对话恒 HTTP 200 + 信封 503 "Model catalog unavailable"。
        // **仅补 Cosy-Business-* 头不能替代**（Go 侧四组对照实测）。
        business: {
          product: QWENWORK_BUSINESS_PRODUCT,
          type: QWENWORK_BUSINESS_TYPE,
          version: '1',
          feature_switches: {},
        },
        // 强制 stream：上游是 SSE-only 端点；非流式由 DSH 上层收敛。
        stream: true,
        ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.stop === undefined || options.stop.length === 0 ? {} : { stop: options.stop },
        // ⚠️ tools 必须真的下发到请求体顶层：漏发会让模型在正文里臆造 XML 工具调用，
        // harness 认不出 → 任务终止（Qoder/TRAE 都踩过）。
        ...options.tools === undefined || options.tools.length === 0
          ? {}
          : {
              tools: options.tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  ...tool.description.length > 0 ? { description: tool.description } : {},
                  ...tool.parameters === undefined ? {} : { parameters: tool.parameters },
                },
              })),
            },
      })
    }

    /**
     * 发送一次请求。
     *
     * ⚠️ **签名覆盖 body，故签名必须在这里做**（与 body 构造紧邻）：
     * 调用方拿到 headers 之后不得再动 body —— 本函数内不返回 body 给外部，
     * 杜绝了这种可能。
     */
    const send = async (active: QwenworkCredential): Promise<Response> => {
      const body = buildBody()
      const rawUrl = `${this.product.gatewayBase}${QWENWORK_CHAT_PATH}`
      const uid = active.uid ?? ''
      const session = createCosySession(uid, active.nickname ?? '', '', active.access_token)
      // 签名 + 四件套头（Authorization/Cosy-Key/Cosy-User/Cosy-Date）
      const { auth, date } = cosyAuthHeader(session, body, rawUrl)
      const upstreamModel = qwenworkModelKey(options.model)
      const headers: Record<string, string> = {
        Authorization: auth,
        'Cosy-Key': session.cosyKey,
        'Cosy-User': uid,
        'Cosy-Date': date,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        // ⚠️ 决定实际路由，**优先级高于 body.model**；缺省/非法档位时上游在信封内
        // 回 403 "Model is not available for this user"（HTTP 仍 200，只看状态码会漏判）。
        'x-model-key': upstreamModel,
      }
      try {
        return await this.fetchImpl(rawUrl, {
          method: 'POST',
          headers,
          body,
          signal: options.signal ?? AbortSignal.timeout(QWENWORK_REQUEST_TIMEOUT_MS),
        })
      } catch (error) {
        if (options.signal?.aborted) throw error
        if (isTransportError(error)) {
          throw new LlmError(
            `qwenwork: transport error: ${error instanceof Error ? error.message : String(error)}`,
            'TRANSPORT',
            { cause: error as Error },
          )
        }
        throw error
      }
    }

    let response = await send(credential)

    // 步骤 2: 401/403 时续期一次并重试。
    // ⚠️ 千问办公的 403 `Signature invalid` 常见成因就是 token 过期/被轮换
    //（与「签名算错」无法区分），故续期重试是对的。
    if (response.status === 401 || response.status === 403) {
      const text = await response.text().catch(() => '')
      try {
        if (isQwenworkRefreshable(credential)) {
          await this.options.refresh()
          const refreshed = await this.options.resolveCredential(options.model)
          if (refreshed !== undefined && refreshed.access_token.length > 0) {
            credential = refreshed
            response = await send(credential)
          }
        }
      } catch {
        // 续期失败：保留原始的 401/403 响应体，让下面的分支给出**首因**
        //（不得用第二次尝试的错误掩盖第一次）。
        throw new LlmError(`qwenwork: 认证失败且续期未成功：${errorDetail(text)}`, 'AUTH', { status: 403 })
      }
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new LlmError(
        `qwenwork: ${errorDetail(errorText)}`,
        httpErrorCode(response.status),
        { status: response.status },
      )
    }

    // 步骤 3: 拆壳 → 通用消费器
    // ⚠️ 业务失败也可能以 HTTP 200 + 信封错误返回，由拆壳层转成 error 帧，
    //    再由 consumeOpenAiSse 抛出（单一错误出口）。
    const deEnveloped = deEnvelopeQwenworkSse(response, { label: 'qwenwork', model: options.model })
    const synthesized = new Response(deEnveloped, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
    yield* consumeOpenAiSse(synthesized, { signal: options.signal }, {
      label: 'qwenwork',
      firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
      chunkTimeoutMs: resolveChunkTimeoutMs(),
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
    })
  }
}

/**
 * 把消息内容里的图片引用替换成 `image_url` 块。
 *
 * ⚠️ 只处理内容数组里的 image 块；文本块原样保留。找不到映射时**保留原文**
 *（不静默丢图）—— 上层已把「图片存在但全部读取失败」表达成空 Map，
 * 那时的正确行为是让原文里的占位符留着，而不是假装没有图片。
 */
function substituteImages(
  content: unknown,
  imageUrls: ReadonlyMap<string, string>,
): unknown {
  if (!Array.isArray(content)) return content
  return content.map((part) => {
    if (typeof part !== 'object' || part === null) return part
    const record = part as Record<string, unknown>
    if (record.type !== 'image') return part
    // DSH 的图片块用 attachment/attachmentId 标识；两种字段名都容错。
    const id = typeof record.attachmentId === 'string'
      ? record.attachmentId
      : typeof record.attachment === 'string' ? record.attachment : ''
    const url = id === '' ? undefined : imageUrls.get(id)
    if (url === undefined) return part
    return { type: 'image_url', image_url: { url } }
  })
}

/** 首 token 超时（毫秒）；可用环境变量覆盖（与其余适配器同约定）。 */
function resolveFirstTokenTimeoutMs(): number {
  const raw = Number(process.env.DSH_QWENWORK_FIRST_TOKEN_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 180_000
}

/** chunk 间隔超时（毫秒）。 */
function resolveChunkTimeoutMs(): number {
  const raw = Number(process.env.DSH_QWENWORK_CHUNK_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 180_000
}

/**
 * 在 `ctx.llm` 上注册千问办公 provider 路由与适配器。
 *
 * 返回适配器实例：Channel Pack「显示列表」需要 `listAllModels()`
 *（不受黑名单影响、带最终展示名）。`ctx.llm` 不透传自定义方法，
 * 故须由调用方持有引用并在 `index.ts` 的 `modelAdapters` 里登记。
 */
export function registerQwenworkLlm(ctx: Context, options: QwenworkAdapterOptions): QwenworkAdapter {
  const product = options.product ?? QWENWORK
  const adapter = new QwenworkAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
