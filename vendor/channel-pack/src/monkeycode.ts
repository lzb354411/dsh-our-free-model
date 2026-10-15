/**
 * MonkeyCode 渠道的协议常量与模型表（**纯函数，无网络、无凭据**）。
 *
 * ## 渠道形态（与插件里其它渠道的关键差别）
 *
 * MonkeyCode **没有浏览器登录接口**：凭据只能从本机官方客户端 `ohmyagent`
 * 的 `settings.json` 里导入（一对 `oma_` api_key + `omas_` signing_secret）。
 * 上游说的是 **Anthropic 方言**，故本渠道要走 `anthropic-messages.ts` +
 * `anthropic-sse.ts` 那一族（不是 `openai-compat.ts`）。
 *
 * ## 三个域（必须分清，混用一律 401）
 *
 * | 域 | 用途 | 鉴权 |
 * |---|---|---|
 * | `proxy.monkeycode-ai.com/v1` | **推理**（`/messages`、`/responses`） | `X-Api-Key`(oma_) + `X-Ohmyagent-Signature` |
 * | `monkeycode-ai.com` | **控制台**（钱包/额度） | **Cookie**（`monkeycode_ai_session`） |
 * | `baizhi.cloud` | **身份提供方**（派生控制台会话） | Cookie（`baizhi_session`） |
 *
 * ⚠️ oma_ key 在**控制台域一律 401** —— 钱包查询只认 Cookie。
 *
 * ## 移植来源
 *
 * 逐点对齐 `wild-work/internal/monkeycode/constants.go`（Go，只读参考）。
 * 取证来源：官方客户端 `ohmyagent` 经 `--model-config` 重定向抓包。
 */

import { createHash } from 'node:crypto'
import { LlmError } from '@deepseek-ai/dsh-llm'

// ===== 端点与协议常量 =====

/** 推理端点前缀（请求打到 `{base}/messages` 或 `{base}/responses`）。 */
export const MONKEYCODE_DEFAULT_BASE = 'https://proxy.monkeycode-ai.com/v1'

/** 控制台站点（钱包等接口只在 console 域，且只认 Cookie）。 */
export const MONKEYCODE_CONSOLE_BASE = 'https://monkeycode-ai.com'

/** 百智云站点（MonkeyCode 的身份提供方）。 */
export const MONKEYCODE_BAIZHI_BASE = 'https://baizhi.cloud'

/** 控制台钱包接口（GET，Cookie 认证）。 */
export const MONKEYCODE_WALLET_PATH = '/api/v1/users/wallet'

/** 百智云 OAuth 授权端点（GET，需 baizhi 会话）。 */
export const MONKEYCODE_OAUTH_AUTHORIZE_PATH = '/api/v1/oauth/authorize'
/** OAuth client_id（官方前端跳转 URL 同款）。 */
export const MONKEYCODE_OAUTH_CLIENT_ID = 'monkeycode-ai'
/** OAuth scope（官方前端跳转 URL 同款）。 */
export const MONKEYCODE_OAUTH_SCOPE = 'user phone'
/** 控制台域的 OAuth 回调（把 code 换成会话）。 */
export const MONKEYCODE_OAUTH_CALLBACK_PATH = '/api/v1/users/baizhi/callback'

/** Anthropic 协议版本头（与官方客户端一致，抓包实测）。 */
export const MONKEYCODE_ANTHROPIC_VERSION = '2023-06-01'

/**
 * User-Agent 官方客户端形态：`ohmyagent <版本>`。
 *
 * ⚠️ 版本号是客户端构建标识（抓包实测），**不是凭据**。
 */
export const MONKEYCODE_USER_AGENT = 'ohmyagent f6b21ad'

/** 签名头名（HTTP 头名大小写不敏感；官方下发形态为小写 H 之外的原样）。 */
export const MONKEYCODE_SIGNATURE_HEADER = 'X-Ohmyagent-Signature'

/** API key 头名。 */
export const MONKEYCODE_API_KEY_HEADER = 'X-Api-Key'

/** 两侧会话 Cookie 名（导入器按名取值，客户端与服务端写法必须一致）。 */
export const MONKEYCODE_COOKIE_CONSOLE = 'monkeycode_ai_session'
export const MONKEYCODE_COOKIE_BAIZHI = 'baizhi_session'

/**
 * 参与签名的第一条 system（`system[0].text` / `input[0].content`）。
 *
 * ## 为什么用固定短句而不是复刻官方那段 5170 字提示词
 *
 * 服务端只校验「签名与所发内容互相匹配」，**不校验内容是否为官方原文**
 * （2026-09-23 端到端实测：28 字符自定义 system[0] + 自算签名 → HTTP 200）。
 * 固定一条常量即可，好处是同一账号的签名**恒定**，可按 secret 缓存复用。
 *
 * ⚠️ 该字符串**不得包含 CRLF**，也不得在运行时被改写 —— 一旦内容变了签名
 * 必须重算（见 `monkeycode-sign.ts` 与固定向量测试）。
 * ⚠️ 长度恰好 28 字符。
 */
export const MONKEYCODE_SIGNATURE_SYSTEM_PROMPT = 'You are a helpful assistant.'

/** 客户端未指定 `max_tokens` 时的兜底值。 */
export const MONKEYCODE_MAX_TOKENS_DEFAULT = 16_384
/** 单次请求 `max_tokens` 上限（上游模型 max_output 32000）。 */
export const MONKEYCODE_MAX_TOKENS_CAP = 32_000
/** 单次请求上限（毫秒）：上游是流式长响应，给足 10 分钟。 */
export const MONKEYCODE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000
/** 流式空闲看门狗默认值（毫秒，对齐 Go 侧 90s）。 */
export const MONKEYCODE_STREAM_IDLE_TIMEOUT_MS = 90_000

/** 对外模型 ID 的渠道前缀（`monkeycode/basic/x`）。 */
export const MONKEYCODE_CHANNEL_PREFIX = 'monkeycode/'

/** 上游模型名的必备前缀（发给上游时对带档位条目补上）。 */
export const MONKEYCODE_UPSTREAM_PREFIX = 'monkeycode-'

/** 三档托管模型前缀（对外 ID 的形态）。 */
const TIER_BASIC = 'basic/'
const TIER_PRO = 'pro/'
const TIER_ULTRA = 'ultra/'

/**
 * 静态兜底模型表（上游无 `GET /models`，返回 405）。
 *
 * 条目 ID 采用「去 `monkeycode-` 前缀」的形态（如 `basic/deepseek-flash`），
 * 对外模型名为 `monkeycode/basic/deepseek-flash`；发给上游时再补回前缀。
 * 这样既避免 `monkeycode/monkeycode-basic/...` 的重复，又保留档位语义。
 *
 * 清单来自客户端 `settings.json` 的托管条目（2026-09-23 抓取）。
 */
export const MONKEYCODE_STATIC_MODELS: readonly string[] = [
  // basic（6）
  'basic/deepseek-flash',
  'basic/glm-5.3-flash',
  'basic/kimi-k2.5',
  'basic/minimax-m2.5',
  'basic/qwen3.5-plus',
  'basic/qwen3.8-flash',
  // pro（7）
  'pro/deepseek-flash',
  'pro/glm-5',
  'pro/hy3',
  'pro/kimi-k2.6',
  'pro/minimax-m3',
  'pro/qwen3.6-plus',
  'pro/gpt-5.6-terra',
  // ultra（4）
  'ultra/glm-5.1',
  'ultra/qwen3.7-max',
  'ultra/gpt-5.6-sol',
  'ultra/gpt-6-astra',
  // 无档位前缀组（客户端里以裸名出现，8）
  'deepseek-flash',
  'glm-5.1',
  'glm-5',
  'kimi-k2.6',
  'minimax-m2.5',
  'minimax-m3',
  'qwen3.6-plus',
  'qwen3.7-max',
]

/**
 * 走 **OpenAI Responses 面**的托管模型（4 个）。
 *
 * 2026-09-24 实测：这类模型在 `{base}/messages` 上返回 404「路由不存在」，
 * 必须走 `{base}/responses`，且**签名对象是 `input[0]`（role=system）的
 * content** —— 把签名串放进 `instructions` 或顶层 `system` 一律 403。
 */
export const MONKEYCODE_RESPONSES_MODELS: ReadonlySet<string> = new Set([
  'basic/qwen3.8-flash',
  'pro/gpt-5.6-terra',
  'ultra/gpt-5.6-sol',
  'ultra/gpt-6-astra',
])

/**
 * 「上游 API 名 ≠ 客户端展示名」那几个模型的中文展示名。
 *
 * ⚠️ 客户端 `settings.json` 里这几条以中文作 key（`专业模型-5.6-terra`），
 * 但真正要发给上游的是条目里 `model` 字段的 ASCII 名（`gpt-5.6-terra`）。
 * 对外 ID 必须用 ASCII 名 —— 用中文展示名请求会被上游回**纯文本
 * `Forbidden`**（2026-09-24 实测；与签名错的
 * `{"error":"invalid ohmyagent request"}` 是两种不同的 403）。
 */
export const MONKEYCODE_MODEL_DISPLAY_NAMES: ReadonlyMap<string, string> = new Map([
  ['pro/gpt-5.6-terra', '专业模型 5.6 terra'],
  ['ultra/gpt-5.6-sol', '极致模型 5.6 sol'],
  ['ultra/gpt-6-astra', '极致模型 6 astra'],
])

/** 静态表集合视图（本地校验用）。 */
const STATIC_SET: ReadonlySet<string> = new Set(MONKEYCODE_STATIC_MODELS)

/**
 * 把对外模型 ID 还原成上游模型名。
 *
 * 规则（三层）：
 * - 已带 `monkeycode-` 前缀 → **原样透传**；
 * - 带档位前缀（`basic/` / `pro/` / `ultra/`）→ 补 `monkeycode-`；
 * - 裸名（如 `deepseek-flash`）→ **不加前缀**。
 *
 * ⚠️ 少了这步上游会**静默回落默认模型**并返回 200 —— 用户以为在用 A，
 * 实际扣 B 的额度（这也是必须本地校验模型名的原因之一）。
 */
export function upstreamModelName(id: string): string {
  const trimmed = id.trim()
  if (trimmed.startsWith(MONKEYCODE_UPSTREAM_PREFIX)) return trimmed
  if (trimmed.startsWith(TIER_BASIC) || trimmed.startsWith(TIER_PRO) || trimmed.startsWith(TIER_ULTRA)) {
    return MONKEYCODE_UPSTREAM_PREFIX + trimmed
  }
  return trimmed
}

/**
 * 归一化成静态表里的条目 ID：剥掉渠道前缀与上游 `monkeycode-` 前缀。
 *
 * 三个来源都要能吃：
 * - 对外 ID（`monkeycode/basic/x`）；
 * - 渠道内 ID（`basic/x`，handler 剥过前缀的形态）；
 * - 客户端原样 ID（`monkeycode-basic/x`，手填凭据时可能出现的形态）。
 */
export function bareModelId(id: string): string {
  let out = id.trim()
  if (out.startsWith(MONKEYCODE_CHANNEL_PREFIX)) out = out.slice(MONKEYCODE_CHANNEL_PREFIX.length)
  if (out.startsWith(MONKEYCODE_UPSTREAM_PREFIX)) {
    out = out.slice(MONKEYCODE_UPSTREAM_PREFIX.length)
  }
  return out
}

/** 报告该模型是否走 OpenAI Responses 面。 */
export function usesResponsesApi(id: string): boolean {
  return MONKEYCODE_RESPONSES_MODELS.has(bareModelId(id))
}

/**
 * 本地模型名校验（**必须做**）。
 *
 * ⚠️ 上游对未知模型**静默回落到默认模型**并返回 200 —— 不校验会让用户以为
 * 在用 A 实际扣 B 的额度（与 raccoon/loomy 的既有教训同型）。
 *
 * ⚠️ 判据是**静态表 ∪ 上游目录**的并集（对齐 R42）：
 * 本渠道上游没有 `GET /models`（405），故目前并集退化为静态表；
 * 但接口留出 `liveIds` 以便将来上游提供目录时不必改调用方。
 */
export function modelAllowed(id: string, liveIds?: ReadonlySet<string>): boolean {
  const bare = bareModelId(id)
  if (STATIC_SET.has(bare)) return true
  if (liveIds !== undefined && liveIds.has(bare)) return true
  return false
}

/**
 * 对外模型 ID（`monkeycode/<bare>`）→ 上游模型 ID（`monkeycode-basic/x`）。
 *
 * 这是发给上游 body 里 `model` 字段的最终形态。
 */
export function toUpstreamModelId(publicId: string): string {
  return upstreamModelName(bareModelId(publicId))
}

/**
 * 上游目录条目的展示名。
 *
 * 静态表里没有名字字段（上游无目录接口），故按档位生成可读名；
 * 那 3 个中文展示名模型用 `MONKEYCODE_MODEL_DISPLAY_NAMES` 覆盖。
 */
export function modelDisplayName(bareOrPublicId: string): string {
  const bare = bareModelId(bareOrPublicId)
  return MONKEYCODE_MODEL_DISPLAY_NAMES.get(bare) ?? bare
}

// ===== 凭据 =====

/**
 * MonkeyCode 凭据（**导入型**，本插件里第一个非 OAuth 渠道）。
 *
 * 来源是本机官方客户端 `ohmyagent` 的 `settings.json`：
 * 一对 `oma_` api_key + `omas_` signing_secret（外加两个可选的 Cookie）。
 *
 * ⚠️ 与其它渠道的三点不同：
 * 1. **没有 refresh 端点**（上游 `RefreshToken` 是空实现直接返回 nil）⇒
 *    `refresh_token` 恒为空，续期调度器必须**跳过**本渠道（否则每天产生
 *    必然失败的假警报）。
 * 2. **`expires_at` 是远期值**（导入时写 `now + 50 年`）—— 目的正是让
 *    「是否需要续期」恒为 false，不去触发那次必然失败的刷新。
 * 3. 鉴权靠**两把密钥**：`access_token`（oma_，进 `X-Api-Key`）与
 *    `signing_secret`（omas_，用于 HMAC 签名）。缺后者无法发出任何请求。
 */
export interface MonkeycodeCredential {
  /**
   * API key（`oma_` 前缀），进 `X-Api-Key` 头。
   *
   * ⚠️ 字段名**必须**是 `access_token` —— 账号池的
   * `findAccountIdByCredential` 对非 `codearts` 的 provider 统一取该字段作
   * 身份标识（与 `qwenwork.ts` 的同名约定一致）。
   */
  access_token: string
  /** 签名密钥（`omas_` 前缀），用于 `X-Ohmyagent-Signature`。 */
  signing_secret: string
  /**
   * 刷新令牌：**本渠道恒为空**（上游无 refresh 端点）。
   *
   * ⚠️ 保留字段是为了与账号池/其它渠道的凭据形状一致；**不得**填任何值，
   * 否则调度器会尝试一次必然失败的续期。
   */
  refresh_token?: string
  /**
   * 过期时刻（**毫秒时间戳**）。
   *
   * ⚠️ 导入时写**远期**（now + 50 年，对齐 Go `import_local.go:167`）：
   * 目的正是让 `NeedsRefresh` 恒为 false，避免触发必然失败的刷新。
   */
  expires_at?: number
  /** 账号 uid（`mc_` + sha256(api_key) 前 5 字节；上游无 uid）。 */
  uid?: string
  /** 展示昵称。 */
  nickname?: string
  /** 上游基址（来自客户端 `base_url`，可覆盖默认）。 */
  base_url?: string
  /** 控制台会话 Cookie（`monkeycode_ai_session`，**尽力而为**，可缺失）。 */
  console_cookie?: string
  /** 百智云会话 Cookie（`baizhi_session`，**尽力而为**，可缺失）。 */
  baizhi_cookie?: string
}

/** 解析凭据 JSON；形状不对返回 `undefined`（不抛错）。 */
export function parseMonkeycodeCredential(value: string): MonkeycodeCredential | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    // ⚠️ 两把密钥缺一不可：只有 api_key 时签名会拿空密钥算（必然 403），
    // 只有 secret 时请求无法通过 `X-Api-Key`。
    if (typeof record.access_token !== 'string' || record.access_token.length === 0) return undefined
    return parsed as MonkeycodeCredential
  } catch {
    return undefined
  }
}

/**
 * 判断凭据是否可用（两把密钥都在）。
 *
 * ⚠️ **不复用 `parseMonkeycodeCredential` 的宽松口径**：那个只校验
 * `access_token`（保持与账号池身份标识的兼容），而发请求需要
 * `signing_secret` 非空 —— 缺它就应当**明确报错提示重新导入**，
 * 而不是拿空密钥去签名换来一个 403（错误信息完全不指向真实原因）。
 */
export function isUsableMonkeycodeCredential(
  credential: MonkeycodeCredential | undefined,
): boolean {
  return credential !== undefined
    && typeof credential.access_token === 'string' && credential.access_token.length > 0
    && typeof credential.signing_secret === 'string' && credential.signing_secret.trim().length > 0
}

/**
 * 本渠道**永不需要续期**，故恒返回 false。
 *
 * ⚠️ 存在的意义是把「无 refresh 端点」这件事写进代码，避免后来者照抄别的渠道
 * 加上续期判断 —— 那样会让调度器每天发起必然失败的刷新请求（并在面板上
 * 渲染成红色的「续期失败」），而本渠道的凭据根本不会过期。
 */
export function isMonkeycodeRefreshable(_credential: MonkeycodeCredential | undefined): boolean {
  return false
}

/**
 * 判断凭据是否已过期。
 *
 * ⚠️ 与其它渠道不同，这里**恒为 false**：
 * 本渠道没有续期端点，凭据要么由客户端导入时写远期，要么本就不可修复。
 * 报告「已过期」只会让 UI 提示一个用户无法执行的「重新登录」动作 ——
 * 用户真正该做的是**重新导入客户端凭据**（那是另一条路径，见 `retry` 提示）。
 *
 * ⚠️ 刻意仍读 `expires_at`：若将来有人手工写入一个过去的时刻，
 * 这里会如实报过期（而不是无条件 false），便于诊断。
 */
export function isMonkeycodeExpired(credential: MonkeycodeCredential | undefined): boolean {
  if (credential === undefined) return true
  const expiresAt = credential.expires_at
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    // 无过期信息 → 视为**可用**（与 qwenwork 的「宁可用可能过期的凭据去试」
    // 同哲学：不凭猜测阻止使用）。
    return false
  }
  return Date.now() >= expiresAt
}

/** 计算 uid：`'mc_' + hex(sha256(apiKey)) 的前 5 字节`（对齐 Go `import_local.go:159-160`）。 */
export function monkeycodeUidFromApiKey(apiKey: string): string {
  const digest = createHash('sha256').update(Buffer.from(apiKey, 'utf8')).digest()
  return `mc_${digest.subarray(0, 5).toString('hex')}`
}

/**
 * 导入凭据的默认过期时刻：**now + 50 年**（毫秒）。
 *
 * 对齐 Go `import_local.go:167` 的 `time.Now().AddDate(50, 0, 0)`：
 * 远期到期让 `NeedsRefresh` 恒为 false，避免触发一次必然失败的刷新。
 */
export function monkeycodeImportedExpiresAt(now = Date.now()): number {
  const fiftyYearsMs = 50 * 365.2425 * 24 * 60 * 60 * 1000
  return now + Math.round(fiftyYearsMs)
}

/**
 * HTTP 失败 → `LlmError`（错误码选择见下）。
 *
 * ⚠️ 放在本模块（而非适配器）是刻意的：本函数是**纯函数**，只依赖协议语义，
 * 不需要 cordis / 账号池等宿主服务 —— 放在协议层才能被离线单测直接锁住
 * （适配器模块因 import `account-pool` 会连带牵引宿主类型）。
 *
 * ## 分类（对齐 Go `Classify` 的语义）
 *
 * | 状态 | 含义 | 错误码 | 理由 |
 * |---|---|---|---|
 * | 401 | 凭据无效 | `AUTH` | 唯一真正指向「凭据」的码 |
 * | **403** | **签名/协议错** | **`PERMISSION_DENIED`** | **不是密钥问题**，见下 |
 * | 400 | 请求不合法（含 `model_not_found`） | `INVALID_REQUEST` | 改动请求才有用 |
 * | 429 | 限流 | `RATE_LIMIT` | 可退避重试 |
 * | ≥500 | 上游故障 | `SERVER` | 可退避重试 |
 *
 * ## ⚠️ 为什么 403 不取 `AUTH`
 *
 * 仓库既有结论（`buddy-adapter.ts:471-498`，有实测出处）：DSH 聊天 UI 对
 * `AUTH` 会把整条 message **替换成固定文案「API 密钥无效」**，精心写的中文
 * 说明一个字都到不了用户眼前。而 MonkeyCode 的 403 根本不是「密钥无效」——
 * 它是**签名/协议不匹配**，用户该做的是重新导入客户端凭据。
 * 故取 `PERMISSION_DENIED`（与 `cline-adapter.ts` 的地域限制分支同惯例），
 * 它同时**不在** harness 的 `DEFAULT_RETRYABLE_CODES` 里：确定性拒绝没必要
 * 白退避 5 次。
 *
 * ⚠️ **403 必须与 401 分开**：Go 侧 `Classify` 把 403 归 `ErrPassthrough`
 * （请求级、**不冷却账号**），而 401 才归 `ErrSessionDead`。归错会让健康账号
 * 被冷却、整渠道下线，而真实原因是签名不匹配。
 */
export function classifyMonkeycodeHttpFailure(status: number, body: string): LlmError {
  const detail = body === '' ? '' : ` — ${body.slice(0, 500)}`
  if (status === 403) {
    // ⚠️ 两种 403 语义不同（Go 侧实测）：
    //  - `{"error":"invalid ohmyagent request"}` = 签名/协议不匹配；
    //  - 纯文本 `Forbidden` = 用了中文展示名当模型 ID（客户端 settings.json 的 key）。
    // 两者都指向「请求构造」，故文案里都给出可行动指引。
    const hint = body.includes('invalid ohmyagent request')
      ? '签名或请求格式不被上游接受。请检查 signing_secret 是否与客户端一致'
      : '上游拒绝了该请求（常见原因：把展示名当成了模型 ID）。请确认模型 ID 用的是列出值'
    return new LlmError(
      `monkeycode: 上游拒绝请求（HTTP 403）${hint}${detail}`,
      'PERMISSION_DENIED',
      { status },
    )
  }
  if (status === 401) {
    return new LlmError(
      `monkeycode: 凭据无效（HTTP 401），请重新导入客户端凭据${detail}`,
      'AUTH',
      { status },
    )
  }
  if (status === 429) {
    return new LlmError(`monkeycode: 上游限流（HTTP 429）${detail}`, 'RATE_LIMIT', { status })
  }
  if (status === 400) {
    return new LlmError(
      `monkeycode: 请求不合法（HTTP 400）${detail}`,
      'INVALID_REQUEST',
      { status },
    )
  }
  if (status >= 500) {
    return new LlmError(`monkeycode: 上游故障（HTTP ${status}）${detail}`, 'SERVER', { status })
  }
  return new LlmError(`monkeycode: HTTP ${status}${detail}`, `HTTP_${status}`, { status })
}

