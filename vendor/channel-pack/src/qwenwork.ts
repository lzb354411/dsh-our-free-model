/**
 * 千问办公（QwenWork）协议常量与纯函数。
 *
 * ## 上游形态
 *
 * 千问办公是 **Qoder 系 COSY 框架**的成员（与 `qoder` 渠道同一把 RSA 公钥、
 * 同一签名串格式），但**完全独立**：独立 Kind、独立凭据 ref、独立模型表、
 * 独立鉴权组合。
 *
 * ## ⚠️ 双轨鉴权：COSY 域与 Bearer 域**不可混用**
 *
 * | 域 | 用途 | 鉴权 |
 * |---|---|---|
 * | `gateway.qwenwork.cn` | 推理、模型列表 | COSY 四件套 |
 * | `qwenwork.cn` | 余额、钱包、账单、费率 | 纯 Bearer |
 *
 * 实测混用必失败（COSY 打网页域会 401）。这是本渠道与其它渠道最大的结构差异 ——
 * 大多数渠道只有一个域、一种鉴权。
 *
 * ## ⚠️ 服务端无状态
 *
 * 多轮对话必须由客户端携带全量 messages（`session_id` 不承载上下文）。
 * 故本渠道**不做任何消息改写**（`developer` 角色实测也可接受）。
 *
 * ## ⚠️ 每日 100 积分：无领取接口
 *
 * 服务端 00:00（UTC+8）**被动发放**，没有任何领取/签到端点。故：
 * - 本渠道**不提供**手动签到入口；
 * - **禁止定时保活** —— token 由 `deviceToken/refresh` 按需轮换，定时保活反而
 *   会与千问办公 App 高频互踩，可能导致 refresh token 作废、账号被禁用
 *  （Go 侧 `main.go` 特意传显式空切片关闭全部定时任务）。
 */

/** 推理网关（COSY 签名域）。 */
export const QWENWORK_GATEWAY_BASE = 'https://gateway.qwenwork.cn'

/** 网页域（Bearer 域：余额/费率/账单）。 */
export const QWENWORK_WEB_BASE = 'https://qwenwork.cn'

/** 推理端点（SSE-only）。 */
export const QWENWORK_CHAT_PATH =
  '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common'

/** 模型列表端点（COSY GET，无 body，签名传空串）。 */
export const QWENWORK_MODELS_PATH = '/api/v2/model/list'

/** token 轮换端点（COSY POST，body 带 `target:"c"`）。 */
export const QWENWORK_DEVICE_TOKEN_REFRESH_PATH = '/api/v1/deviceToken/refresh'

/** 余额端点（Bearer GET）。 */
export const QWENWORK_BALANCE_PATH = '/user/balance'

/** 钱包明细端点（Bearer GET，含各钱包到期时间）。 */
export const QWENWORK_WALLETS_PATH = '/user/wallets'

/** 用户信息端点（Bearer GET，昵称兜底）。 */
export const QWENWORK_USER_INFO_PATH = '/user/info'

/** 费率表端点（Bearer GET）。 */
export const QWENWORK_CHAT_MODES_PATH = '/api/chat-modes'

/** OAuth 授权基址（与网页域同源）。 */
export const QWENWORK_OAUTH_BASE = 'https://qwenwork.cn'

/** OAuth 令牌端点（Ory Hydra 标准端点）。 */
export const QWENWORK_TOKEN_PATH = '/oauth2/token'

/** OAuth 授权端点。 */
export const QWENWORK_AUTHORIZE_PATH = '/oauth2/auth'

/** 桌面客户端公开 client_id（IDE 桌面版同款，public client 无 secret）。 */
export const QWENWORK_CLIENT_ID = 'qwenwork-desktop-app'

/** 授权 scope（逐字照抄桌面客户端）。 */
export const QWENWORK_SCOPE = 'openid profile email offline_access qwen_work'

/** 请求超时（毫秒）；与 Go 侧 180s 同口径。 */
export const QWENWORK_REQUEST_TIMEOUT_MS = 180_000

/**
 * 推理 body 的 `business` 段取值（与 `Cosy-Business-*` 静态头同源，官方 1.0.4 取值）。
 *
 * ⚠️ **必须放进 body，不能只放头**。2026-09-24 上游 1.0.4 起，网关按
 * `body.business.{product,type}` 解析模型目录；缺失时对话**恒返回 HTTP 200 +
 * 信封 503 `Model catalog unavailable`**（模型列表/余额/费率均不受影响，只有推理受影响）。
 *
 * Go 侧做过四组对照实验隔离变量：body 缺 business 时「本项目透传 body」与
 * 「上游原生重构 body」**均 503**，补上后均 200 —— 证明原生 body 结构、
 * 官方 `Encode=1` WASM 组包、机器指纹**都不是必要条件**，故本渠道只补字段、
 * 不引入 wasmtime 级依赖。
 */
export const QWENWORK_BUSINESS_PRODUCT = 'qoder_work'

/** 见 {@link QWENWORK_BUSINESS_PRODUCT}。 */
export const QWENWORK_BUSINESS_TYPE = 'agent'

/**
 * 客户端模型名 → 上游档位 key。
 *
 * 上游 `model` 与 `/api/chat-modes` 的档位 key 一致（两处 `price_factor` 相同）。
 * 保留旧 key 兼容：`qwork-advanced` 实测仍被网关接受（路由到 glm-5.2）。
 *
 * ⚠️ **不是所有客户端名都等于上游 key**：`qwen3.8-max` 映射到
 * `qwen3.8-max-preview`（名字不同），漏了这条映射会让该模型走错档位。
 */
const QWENWORK_MODEL_KEYS: Readonly<Record<string, string>> = Object.freeze({
  auto: 'pro',
  'qwork-advanced': 'pro',
  pro: 'pro',
  'qwork-auto': 'pro',
  flash: 'flash',
  'qwork-lite': 'flash',
  'qwen3.8-max': 'qwen3.8-max-preview',
  'qwen3.8-max-preview': 'qwen3.8-max-preview',
  qmodel_latest: 'qwen3.8-max-preview',
})

/**
 * 把客户端模型名映射成上游档位 key；未知时**原样返回**（让上游给权威错误）。
 *
 * WHY 不本地拒绝未知模型：与 MonkeyCode 不同，千问办公的上游模型表是**动态**的
 * （`/api/v2/model/list`），本地静态表只是兜底。把未知名拒在本地会让上游新增的
 * 档位永远用不了。
 */
export function qwenworkModelKey(clientName: string): string {
  const key = QWENWORK_MODEL_KEYS[clientName]
  return key ?? clientName
}

/** 静态兜底模型表条目。 */
export interface QwenworkFallbackModel {
  /** 上游档位 key（也是对外模型 id）。 */
  id: string
  /** 展示名。 */
  name: string
  /** 上下文窗口。 */
  contextWindow: number
  /** 是否支持图片输入。 */
  supportsImage: boolean
  /** 相对倍率（`pro` = 1.0 基准）。 */
  priceFactor: number
}

/**
 * 静态兜底模型表（动态模型接口不可用时的 fallback）。
 *
 * 来源：Go 侧 `internal/qwenwork/constants.go` 的 `staticModels` + `priceFactorOf`。
 *
 * ⚠️ **上下文窗口取 180_000 而不是网页 `chat-modes` 宣称的 1M**：上游真实上限
 * 实测约 180K（175K 通过 / 179K 返回 424 `All models failed`），网页那个 1M 是
 * **前端档位选择器的最大值**，不是单次请求能力。报 1M 会让 DSH 远晚于真实能力
 * 才触发压缩，用户拿到的是上游的硬失败。
 */
export const QWENWORK_FALLBACK_MODELS: readonly QwenworkFallbackModel[] = Object.freeze([
  Object.freeze({ id: 'pro', name: '高级 · x1', contextWindow: 180_000, supportsImage: false, priceFactor: 1.0 }),
  Object.freeze({ id: 'flash', name: '标准 · x0.1', contextWindow: 180_000, supportsImage: true, priceFactor: 0.1 }),
  Object.freeze({
    id: 'qwen3.8-max-preview',
    name: 'Qwen3.8-Max · x1.8',
    contextWindow: 180_000,
    supportsImage: true,
    priceFactor: 1.8,
  }),
])

/** 静态倍率查询（动态费率优先；此处仅兜底）。未知返回 `undefined`（不编造 0）。 */
export function qwenworkStaticPriceFactor(id: string): number | undefined {
  return QWENWORK_FALLBACK_MODELS.find((model) => model.id === id)?.priceFactor
}

/**
 * 倍率格式化：去掉浮点噪声（`0.1` → `0.1`、`1` → `1`、`1.8` → `1.8`）。
 *
 * 与 `raccoon.ts` 的 `formatMultiplier` 同口径。**1 倍也要显示**（用户曾报障
 * 「为什么某模型没有倍率」——省略会让用户无法区分「它就是 1 倍」与「没取到倍率」）。
 */
function formatFactor(value: number): string {
  return String(Number(value.toFixed(4)))
}

/**
 * 组装展示名：`高级 · x1`。倍率拼进 `name`（**不是** `description`）——
 * composer 的模型切换菜单只渲染 `name`。
 *
 * @param displayName 上游 `display_name`（可能为空）。
 * @param key 上游档位 key（`display_name` 缺失时用它）。
 * @param factor 生效倍率；`undefined` 时不追加后缀（避免产出「名字 · 」这种孤立分隔符）。
 */
export function qwenworkDisplayName(
  displayName: string,
  key: string,
  factor: number | undefined,
): string {
  const base = displayName.trim().length > 0 ? displayName : key
  if (factor === undefined || !Number.isFinite(factor) || factor < 0) return base
  if (factor === 0) return `${base} · 免费`
  return `${base} · x${formatFactor(factor)}`
}

/** 千问办公凭据。 */
export interface QwenworkCredential {
  /**
   * 访问令牌。
   *
   * ⚠️ 字段名**必须**是这个 —— 账号池的 `findAccountIdByCredential` 对非
   * `codearts` 的 provider 统一取该字段作身份标识。
   */
  access_token: string
  /** 刷新令牌（`ory_rt_` 前缀，**会被轮换**，续期后必须落盘）。 */
  refresh_token: string
  /**
   * 过期时刻（**毫秒时间戳**）。
   *
   * ⚠️ 上游别的渠道用秒、这里用毫秒，本仓库统一按毫秒存（与 raccoon 的
   * `expires_at` 同口径）——**在换算处必须显式标单位**，否则会踩
   * 「把 7 天压成 604 秒」那个坑（见 "token 刷新" 注释）。
   */
  expires_at?: number
  /** 账号 uid。 */
  uid?: string
  /** 展示昵称。 */
  nickname?: string
}

/** 解析凭据 JSON；形状不对返回 `undefined`（不抛错）。 */
export function parseQwenworkCredential(value: string): QwenworkCredential | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    if (typeof record.access_token !== 'string' || record.access_token.length === 0) return undefined
    return parsed as QwenworkCredential
  } catch {
    return undefined
  }
}

/**
 * 解码 JWT payload 的 `exp`，换算成**毫秒**时间戳。
 *
 * ⚠️ 只解码、**不验签** —— 只需要知道何时该续期，签名由服务端校验。
 * ⚠️ 任何解析失败返回 `undefined` 而**不抛错**：凭据可能被手工改坏，
 * 那时应降级成「无过期信息」（宁可用可能过期的凭据去试，也不要凭猜测阻止使用）。
 */
export function decodeQwenworkJwtExpMs(token: string): number | undefined {
  if (typeof token !== 'string' || token.length === 0) return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'))
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
    const exp = (payload as Record<string, unknown>).exp
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return undefined
    return exp * 1000
  } catch {
    return undefined
  }
}

/**
 * 凭据过期时刻（毫秒）。
 *
 * 取值优先级：`expires_at`（显式字段）→ **JWT 的 `exp`**。
 *
 * ⚠️ **回退到 JWT 是必需的**：`expires_at` 是可选字段，老凭据可能没有它。
 * 只读它会令过期判定恒为 false ⇒ 续期永远不触发 ⇒「凭据悄悄过期」这类静默失效。
 * 更重要的是：**用上游签名的 JWT `exp` 校正历史脏值**（见下）。
 */
export function qwenworkCredentialExpiresAtMs(credential: QwenworkCredential): number | undefined {
  const explicit = credential.expires_at
  const jwtExp = decodeQwenworkJwtExpMs(credential.access_token)
  // ⚠️ 用 JWT exp 做「只增不减」的校正：
  // 历史实现曾把 `expires_in`（**秒**）当毫秒处理，落盘的 expiresAt 比真实寿命
  // 少了约 7 天。若只信显式字段，那些脏值会让 NeedsRefresh 恒为真 ⇒ 每次请求都刷
  // token ⇒ 与千问办公 App 高频互踩直至 refresh token 作废、账号被禁用。
  // 取较大值即可自愈：脏值偏小，JWT 是上游签名的权威值。
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    if (jwtExp !== undefined && jwtExp > explicit) return jwtExp
    return explicit
  }
  return jwtExp
}

/**
 * 凭据是否已过期。
 *
 * 无任何过期信息时视为**不过期**：宁可用可能过期的凭据去试（服务端回 401 时
 * 我们能识别并续期），也不要凭猜测阻止使用。
 */
export function isQwenworkExpired(credential: QwenworkCredential): boolean {
  const expiresAt = qwenworkCredentialExpiresAtMs(credential)
  return expiresAt !== undefined && expiresAt <= Date.now()
}

/** 凭据是否可静默续期（`refresh_token` 非空；千问办公**有** refresh 端点）。 */
export function isQwenworkRefreshable(credential: QwenworkCredential): boolean {
  return typeof credential.refresh_token === 'string' && credential.refresh_token.trim().length > 0
}

/**
 * 续期提前窗口（毫秒）。
 *
 * 取 10 分钟：与 Go 侧 `NeedsRefresh(10min)` 同口径。access token 寿命 7 天，
 * 提前 10 分钟刷新足够宽裕，且不会像「误把秒当毫秒」那样恒为真。
 */
export const QWENWORK_REFRESH_WINDOW_MS = 10 * 60 * 1000

/** 凭据是否需要在发起请求前续期。 */
export function qwenworkNeedsRefresh(credential: QwenworkCredential): boolean {
  if (!isQwenworkRefreshable(credential)) return false
  const expiresAt = qwenworkCredentialExpiresAtMs(credential)
  // 无过期信息：不主动续期（让请求去试，401 时会触发续期）。
  if (expiresAt === undefined) return false
  return expiresAt - Date.now() <= QWENWORK_REFRESH_WINDOW_MS
}
