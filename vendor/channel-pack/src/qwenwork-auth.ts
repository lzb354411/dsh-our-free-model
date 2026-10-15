/**
 * 千问办公认证服务：登录编排、凭据续期、余额与费率、模型目录。
 *
 * ## ⚠️ 本渠道的三条硬约束（改代码前必读）
 *
 * ### 1. `expires_in` 单位是秒，且必须用 JWT `exp` 校正脏值
 *
 * 历史实现把它当毫秒 ⇒ 落盘 `expiresAt` 比真实寿命少约 7 天 ⇒ `NeedsRefresh`
 * 恒为真 ⇒ **每次请求都刷 token** ⇒ 与千问办公 App 高频互踩，直至 refresh token
 * 被作废、账号被禁用。Go 侧因此专门加了 `Auth.AdoptJWTExpiry()` 做「只增不减」的
 * 内存校正。本实现的等价物是 `qwenworkCredentialExpiresAtMs`（优先取
 * `expires_at` 与 JWT `exp` 的**较大值**）。
 *
 * ### 2. 禁止定时保活
 *
 * token 由 `deviceToken/refresh` **按需**轮换。定时保活会与官方 App 抢着刷新
 * （refresh token 是轮换的），导致账号失效。故本服务**不提供** `scheduleRefresh()`，
 * 调用方也不得为本渠道注册定时器（Go 侧特意传显式空切片关闭全部定时任务）。
 *
 * ### 3. 无签到端点
 *
 * 每日 100 积分由服务端 00:00（UTC+8）**被动发放**，没有任何领取接口。
 * 故 `claimDailyCheckin` 直接返回「不支持」，**不发任何上游请求**
 *（`isUnsupportedCheckin` 的判据串必须逐字匹配 `'不支持每日签到'`，
 *  否则自动签到引擎会把它计为失败而非跳过）。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { AccountPool } from './account-pool.js'
import type { ClaimOutcome, CreditBalance, CreditPackage } from './credits.js'
import { syncAccountExpiry, type ExpiryAccessors } from './expiry-sync.js'
import { QWENWORK, type QwenworkProduct } from './qwenwork-product.js'
import {
  QWENWORK_BALANCE_PATH,
  QWENWORK_CHAT_MODES_PATH,
  QWENWORK_DEVICE_TOKEN_REFRESH_PATH,
  QWENWORK_GATEWAY_BASE,
  QWENWORK_MODELS_PATH,
  QWENWORK_REQUEST_TIMEOUT_MS,
  QWENWORK_USER_INFO_PATH,
  QWENWORK_WALLETS_PATH,
  isQwenworkExpired,
  isQwenworkRefreshable,
  parseQwenworkCredential,
  qwenworkCredentialExpiresAtMs,
  qwenworkDisplayName,
  qwenworkModelKey,
  qwenworkStaticPriceFactor,
  type QwenworkCredential,
  type QwenworkFallbackModel,
} from './qwenwork.js'
import { createCosySession, cosyHeaders } from './qwenwork-cosy.js'
import { refreshQwenworkToken, startQwenworkOAuthFlow, type StartedQwenworkLoginFlow } from './qwenwork-oauth.js'

/**
 * 「该渠道不支持每日签到」的稳定文案。
 *
 * ⚠️ **必须逐字使用这句话**：`auto-checkin.ts` 的 `isUnsupportedCheckin()` 只匹配
 * `'不支持每日签到'` 与 `'unsupported provider'` 两个串，写成别的措辞会被自动签到
 * 引擎计为「失败」而非「跳过」，于是每天产生一轮假警报。
 */
export const QWENWORK_NO_CHECKIN_MESSAGE =
  '不支持每日签到（千问办公每日积分由服务端 00:00 自动发放，无领取接口）'

/** 凭据过期/无过期信息时的提取器（供写回账号池用）。 */
const QWENWORK_EXPIRY_ACCESSORS: ExpiryAccessors<QwenworkCredential> = {
  expiresAtOf: qwenworkCredentialExpiresAtMs,
  refreshableOf: isQwenworkRefreshable,
  identityOf: (credential) => credential.uid ?? credential.access_token,
}

/** 远端模型条目（已归一）。 */
export interface QwenworkRemoteModel {
  id: string
  name: string
  contextWindow: number
  supportsImage: boolean
  priceFactor: number | undefined
}

/** 登录结果（供 RPC 层回填账号池）。 */
export interface QwenworkLoginResult {
  /** 序列化后的凭据（写入凭据库的值）。 */
  access: string
  /** 过期时刻（毫秒）；0 表示未知。 */
  expires: number
  /** 凭据 ref。 */
  ref: CredentialRef
  refreshable: boolean
}

/** 余额明细（`/user/balance` + `/user/wallets`）。 */
export interface QwenworkBalanceDetail {
  /** 总余额（截断小数，与面板显示口径一致）。 */
  total: number
  /** 各钱包分项。 */
  items: CreditPackage[]
}

/** `QwenworkAuth` 的构造选项。 */
export interface QwenworkAuthOptions {
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 产品配置；默认 {@link QWENWORK}。 */
  product?: QwenworkProduct
  /** 服务名覆盖（默认由产品 id 派生为 `qwenworkAuth`）。 */
  serviceName?: string
}

/** 远端 `/api/v2/model/list` 单条（`scene=qwork`）。 */
interface RemoteModelEntry {
  key?: unknown
  display_name?: unknown
  enable?: unknown
  price_factor?: unknown
  max_input_tokens?: unknown
}

/** 读成有限数字；非法返回 `undefined`（**不编造 0**）。 */
function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 千问办公认证服务。
 *
 * 登录走 **OAuth 授权码 + PKCE + 本机回调**（见 `qwenwork-oauth.ts`）；
 * 续期走 `deviceToken/refresh`（refresh token **会轮换**，续期后必须落盘）。
 */
export class QwenworkAuth extends Service {
  /** 本实例所属的产品配置。 */
  readonly product: QwenworkProduct
  /** 本实例默认读写的凭据 ref 名称。 */
  readonly credentialRefName: string

  /** 最近一次续期失败的原因（供 `status()` 暴露给 UI）。 */
  private lastRefreshError: string | undefined

  constructor(ctx: Context, private readonly options: QwenworkAuthOptions = {}) {
    const product = options.product ?? QWENWORK
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = this.product.defaultCredentialRef
  }

  /** 注入的 fetch（测试用）；默认为全局 fetch。 */
  private get fetchImpl(): typeof fetch {
    return this.options.fetcher ?? fetch
  }

  /**
   * 启动登录（OAuth 授权码 + PKCE + 本机回调）。
   *
   * 立即返回 `loginUrl` —— 与其余 provider 的「两步式」契约一致
   *（`window.open` 只在用户手势窗口内有效，不能等流程跑完再返回）。
   */
  async startLogin(): Promise<StartedQwenworkLoginFlow> {
    return startQwenworkOAuthFlow({
      ...this.options.fetcher === undefined ? {} : { fetcher: this.options.fetcher },
    })
  }

  /**
   * 把登录结果落盘成凭据。
   *
   * 与 `startLogin` 分开：流程编排（回调服务器 + PKCE 兑换）在 `qwenwork-oauth.ts`，
   * 本方法负责「换 device_token + 补全昵称 + 写凭据」。
   *
   * ## ⚠️ 关键步骤：把 OAuth token 换成 `device_token`
   *
   * OAuth 授权码兑换出的 `access_token` **只对 COSY 域（推理/模型目录）有效**；
   * 网页域（余额/钱包/用户信息）认的是 `deviceToken/refresh` 换出的 `device_token`。
   * 不换的话，余额查询恒 401 `Invalid JWT token` —— 这正是用户 2026-10-15 现场报的
   *「凭据失效或响应异常」的根因。
   *
   * 顺带修掉两件事（同一趟请求）：
   * 1. **过期时刻**：OAuth 兑换出的 token 实测只有 **1 小时**寿命；
   *    `deviceToken/refresh` 返回的 `expires_in=604800`（**7 天**）才是真实寿命。
   *    不换就会「每分钟续期一次」，与官方 App 高频互踩。
   * 2. **昵称**：OAuth 兑换出的 JWT 实测**没有 `username` 字段**（只有 `sub`），
   *    而 refresh 后的 token 才有；`/user/info` 也要求有效 token。
   *    故**必须先换 token，再查昵称**（顺序敏感）。
   *
   * ⚠️ 换失败时**不阻断登录**：推理域两者皆可，用户至少能对话；
   * 余额会走「401 → 自愈重试」路径（见 `refreshIfUnauthorized`）。
   */
  async persistLogin(
    credential: QwenworkCredential,
    flowOptions: { refName?: string } = {},
  ): Promise<QwenworkLoginResult> {
    const refName = flowOptions.refName ?? this.credentialRefName

    // 步骤 1（**顺序敏感**）：先用 refresh_token 换出网页域可用的 device_token。
    let enriched: QwenworkCredential = credential
    try {
      const swapped = await this.refreshCredentialFor(credential)
      enriched = swapped
    } catch (error) {
      // 不阻断登录：推理域用 OAuth token 照样能出流（已实测），只是余额查询要等自愈。
      this.ctx.logger?.warn?.(
        `[qwenwork] 登录后换取 device_token 失败（不影响对话，余额可能显示异常）：${error instanceof Error ? error.message : String(error)}`,
      )
    }

    // 步骤 2：补全昵称。⚠️ 必须在换成 device_token **之后** ——
    // OAuth 兑换的 JWT 无 username，且 /user/info 要求有效 token。
    if (enriched.nickname === undefined || enriched.nickname === '') {
      try {
        const nickname = await this.fetchNickname(enriched)
        if (nickname !== '') enriched = { ...enriched, nickname }
      } catch (error) {
        this.ctx.logger?.warn?.(
          `[qwenwork] 登录后补全昵称失败（不影响登录）：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    const ref = credentialRef(refName)
    await this.ctx.credentials.set(ref, JSON.stringify(enriched))
    this.lastRefreshError = undefined

    return {
      access: JSON.stringify(enriched),
      expires: qwenworkCredentialExpiresAtMs(enriched) ?? 0,
      ref,
      refreshable: isQwenworkRefreshable(enriched),
    }
  }

  /** 只读登录状态。 */
  async status(): Promise<{ configured: boolean; refreshable: boolean; expiresAt?: number; refreshError?: string }> {
    const credential = await this.resolveDefaultCredential()
    if (credential === undefined) return { configured: false, refreshable: false }
    const expiresAt = qwenworkCredentialExpiresAtMs(credential)
    return {
      configured: true,
      refreshable: isQwenworkRefreshable(credential),
      ...expiresAt === undefined ? {} : { expiresAt },
      ...this.lastRefreshError === undefined ? {} : { refreshError: this.lastRefreshError },
    }
  }

  /** 解析默认 ref 的凭据。 */
  private async resolveDefaultCredential(): Promise<QwenworkCredential | undefined> {
    try {
      const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
      return resolved === undefined ? undefined : parseQwenworkCredential(resolved.value)
    } catch {
      return undefined
    }
  }

  /**
   * 续期**指定 ref**（RPC `account.refresh` 与请求路径共用）。
   *
   * ⚠️ 只读写传入的 ref，**不碰**默认单凭据 ref —— 账号池里的是
   * `QWENWORK_ACCOUNT_XXX`，用默认 ref 会刷错凭据。
   *
   * ⚠️ **必须把新过期时间写回账号池**：只更新凭据、不更新账号池，会让面板一直
   * 显示「已过期」，而实际发消息完全正常（raccoon 上踩过同类坑，相差 3.1 小时）。
   */
  async refreshAccountCredential(
    refName: string,
    pool?: AccountPool,
    accountId?: string,
  ): Promise<void> {
    const ref = credentialRef(refName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new Error('凭据未配置')
    const credential = parseQwenworkCredential(resolved.value)
    if (!credential) throw new Error('凭据解析失败')
    if (!isQwenworkRefreshable(credential)) {
      throw new Error('凭据缺少 refresh_token，请重新登录千问办公')
    }
    const next = await this.refreshCredentialFor(credential)
    await this.ctx.credentials.set(ref, JSON.stringify(next))
    await syncAccountExpiry({
      pool,
      provider: this.product.id,
      credential: next,
      accessors: QWENWORK_EXPIRY_ACCESSORS,
      accountId,
      tag: '[qwenwork]',
      warn: (message) => this.ctx.logger?.warn?.(message),
    })
  }

  /**
   * 用 refresh_token 换新凭据（**纯函数式**：不读写凭据库）。
   *
   * 返回的凭据已按毫秒口径算好 `expires_at`（换算集中在此处，见文件头第 1 条）。
   */
  async refreshCredentialFor(credential: QwenworkCredential): Promise<QwenworkCredential> {
    try {
      const grant = await refreshQwenworkToken(credential.refresh_token, {
        fetcher: this.fetchImpl,
        gatewayBase: this.product.gatewayBase,
      })
      return {
        ...credential,
        access_token: grant.accessToken,
        // ⚠️ 上游 refresh token **会轮换**，必须用响应里的新值
        refresh_token: grant.refreshToken,
        // ⚠️ grant.expiresIn 已是**秒**（`qwenwork-oauth.ts` 统一了口径），
        //    此处 ×1000 换算成毫秒。仅当 >0 时覆盖，否则保留原值（不编造）。
        ...grant.expiresIn > 0
          ? { expires_at: Date.now() + grant.expiresIn * 1000 }
          : {},
        ...grant.uid !== '' && (credential.uid === undefined || credential.uid === '')
          ? { uid: grant.uid }
          : {},
        ...grant.nickname !== '' && (credential.nickname === undefined || credential.nickname === '')
          ? { nickname: grant.nickname }
          : {},
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastRefreshError = message
      throw error
    }
  }

  /**
   * 批量续期本产品的账号（**按需**调用，不得注册定时器）。
   *
   * ⚠️ **只按 `refreshable` 过滤，不看 `enabled`**：停用只影响账号池的自动选号，
   * 与「凭据是否需要保持新鲜」无关。早期按 `enabled` 过滤导致停用账号的
   * refresh_token 在停用期间被放到失效（真实缺陷）。
   *
   * 单账号失败不影响其他账号，且**必须留日志**（完全静默会让「续期永远失败
   * 但 UI 显示可续期」无从排查）。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    const accounts = pool.listAccountsByProvider(this.product.id)
    for (const entry of accounts) {
      let credential: QwenworkCredential | undefined
      try {
        const resolved = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef))
        credential = resolved === undefined ? undefined : parseQwenworkCredential(resolved.value)
      } catch (error) {
        this.ctx.logger?.warn?.(`[qwenwork] 解析账号 ${entry.id} 凭据失败：${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      if (credential === undefined) continue
      // 只刷「可续期」的：没有 refresh_token 的账号刷不了，跳过而不是报错
      if (!isQwenworkRefreshable(credential)) continue
      try {
        await this.refreshAccountCredential(entry.credentialRef, pool, entry.id)
      } catch (error) {
        this.ctx.logger?.warn?.(
          `[qwenwork] 账号 ${entry.id} 续期失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  /** 登出（删除默认凭据）。 */
  async logout(): Promise<void> {
    await this.ctx.credentials.unset(credentialRef(this.credentialRefName))
    this.lastRefreshError = undefined
  }

  /**
   * 续期**默认单凭据 ref**（无账号池时的回退路径）。
   *
   * ⚠️ 账号池存在时**不要**用它 —— 池内条目是 `QWENWORK_ACCOUNT_XXX`，
   * 用默认 ref 会刷错凭据（见 `refreshAccountCredential` 的说明）。
   */
  async refreshAccountDefault(): Promise<void> {
    const credential = await this.resolveDefaultCredential()
    if (credential === undefined) throw new Error('凭据未配置，请先登录千问办公')
    if (!isQwenworkRefreshable(credential)) {
      throw new Error('凭据缺少 refresh_token，请重新登录千问办公')
    }
    const next = await this.refreshCredentialFor(credential)
    await this.ctx.credentials.set(credentialRef(this.credentialRefName), JSON.stringify(next))
  }

  /**
   * 拉取远端模型目录（COSY GET `/api/v2/model/list`，取 `scene=qwork`）。
   *
   * ⚠️ **GET 请求签名 body 必须是空串**（不是 `"{}"`），否则 403 Signature invalid。
   * ⚠️ `Accept` 要覆盖成 `application/json`（推理用的 `text/event-stream` 在这里不合适）。
   */
  async fetchModelsWith(credential: QwenworkCredential): Promise<readonly QwenworkRemoteModel[]> {
    const uid = credential.uid ?? ''
    if (uid === '') throw new Error('凭据缺少 uid，无法签名（请重新登录该账号）')
    const rawUrl = `${this.product.gatewayBase}${QWENWORK_MODELS_PATH}`
    const session = createCosySession(uid, credential.nickname ?? '', '', credential.access_token)
    const headers = cosyHeaders(session, '', rawUrl, uid, 'application/json')

    const response = await this.fetchImpl(rawUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(QWENWORK_REQUEST_TIMEOUT_MS),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`模型目录请求失败 HTTP ${response.status}: ${text.slice(0, 200)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('模型目录响应无法解析')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('模型目录响应形状异常')
    }
    const scenes = parsed as Record<string, unknown>
    const rows = Array.isArray(scenes.qwork) ? scenes.qwork : []
    const out: QwenworkRemoteModel[] = []
    for (const raw of rows) {
      if (typeof raw !== 'object' || raw === null) continue
      const entry = raw as RemoteModelEntry
      const key = typeof entry.key === 'string' ? entry.key.trim() : ''
      if (key === '') continue
      // ⚠️ `enable === false` 才排除（字段缺失视为启用，保守不隐藏模型）
      if (entry.enable === false) continue
      const displayName = typeof entry.display_name === 'string' ? entry.display_name : ''
      const factor = readNumber(entry.price_factor)
      const maxInput = readNumber(entry.max_input_tokens)
      out.push({
        id: key,
        name: qwenworkDisplayName(displayName, key, factor ?? qwenworkStaticPriceFactor(key)),
        // 上游真实上限约 180K（见 `qwenwork.ts` 的说明）；仅在缺失时兜底同值。
        contextWindow: maxInput !== undefined && maxInput > 0 ? maxInput : 180_000,
        // 能力：`/api/chat-modes` 声明三档均 is_reasoning；实测 `pro` 路由
        // 不支持图片（is_vl=false），其余两档支持。
        supportsImage: key !== 'pro',
        priceFactor: factor,
      })
    }
    if (out.length === 0) throw new Error('模型目录为空（scene=qwork）')
    return out
  }

  /** 拉取远端模型目录（账号池版本：取第一个可用账号）。 */
  async fetchModels(pool?: AccountPool): Promise<readonly QwenworkRemoteModel[]> {
    const credential = await this.resolvePoolCredential(pool)
    if (credential === undefined) return []
    return this.fetchModelsWith(credential)
  }

  /** 取一个可用账号的凭据（池优先，回退默认单凭据 ref）。 */
  private async resolvePoolCredential(pool?: AccountPool): Promise<QwenworkCredential | undefined> {
    if (pool !== undefined) {
      const available = await pool.getAvailableAccount(this.product.id, '')
      if (available !== null) {
        // ⚠️ `getAvailableAccount` 的凭据类型声明是
        // `CodeArtsCredential | BuddyCredential` 联合（历史遗留），与本渠道凭据
        // 无充分重叠，故经 `unknown` 转换。运行时安全性由 provider 过滤保证：
        // 查询用 `this.product.id`，取到的必是本渠道凭据。
        const credential = parseQwenworkCredential(JSON.stringify(available.credential))
        if (credential !== undefined) return credential
      }
    }
    return this.resolveDefaultCredential()
  }

  /** 拉取账号昵称（`/user/info` 的 nickname → name → username 首个非空）。 */
  async fetchNickname(
    credential: QwenworkCredential,
    pool?: AccountPool,
    accountId?: string,
  ): Promise<string> {
    const data = await this.bearerGet(QWENWORK_USER_INFO_PATH, credential, this.healerFor(pool, accountId))
    if (typeof data !== 'object' || data === null) return ''
    const record = data as Record<string, unknown>
    for (const key of ['nickname', 'name', 'username'] as const) {
      const value = record[key]
      if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    }
    return ''
  }

  /**
   * Bearer 域 GET 并解 `{code, data}` 信封。
   *
   * ⚠️ **网页域只认纯 Bearer**：COSY 打它会 401（反之亦然）。这是本渠道
   * 与其它渠道最大的结构差异，务必不要把两套头混用。
   *
   * ## 401 自愈（对齐 Go 侧 `refreshIfSessionDead`）
   *
   * OAuth 兑换出的 `access_token` 在网页域恒 401（见 {@link fetchBalanceDetail} 的说明）。
   * 提供 `onUnauthorized` 时：命中 401 **先换一次 token 再重试一次** ——
   * 这让**历史账号**（登录时还没做 device_token 交换的那些）无需重新登录即可自愈。
   *
   * ⚠️ 只重试**一次**：换完还 401 说明是 refresh_token 本身失效（需重新登录），
   * 再重试只是白打上游。
   * ⚠️ 重试失败时抛**首个**错误（不得用第二次的错误掩盖首因，同 R-37 家族口径）。
   */
  private async bearerGet(
    path: string,
    credential: QwenworkCredential,
    onUnauthorized?: () => Promise<QwenworkCredential | undefined>,
  ): Promise<unknown> {
    const attempt = async (token: string): Promise<{ status: number; text: string }> => {
      const rawUrl = `${this.product.webBase}${path}`
      const response = await this.fetchImpl(rawUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(QWENWORK_REQUEST_TIMEOUT_MS),
      })
      return { status: response.status, text: await response.text() }
    }

    let { status, text } = await attempt(credential.access_token)

    // 场景 1: 401/403 —— 尝试用 refresh_token 换一个网页域可用的 token 后重试一次
    if ((status === 401 || status === 403) && onUnauthorized !== undefined) {
      try {
        const healed = await onUnauthorized()
        if (healed !== undefined && healed.access_token !== credential.access_token) {
          ({ status, text } = await attempt(healed.access_token))
        }
      } catch {
        // 自愈失败：保留原始的 401 结果，让下面按首因报错。
      }
    }

    if (status === 401 || status === 403) {
      // ⚠️ 文案要指向**可行动的**动作：网页域 401 的两种成因是
      //「token 类型不对（需 refresh 换 device_token）」与「refresh_token 已失效」，
      // 前者自愈已试过，走到这里通常就是后者。
      throw new Error(`网页域鉴权失败（HTTP ${status}）：${text.slice(0, 160)}`)
    }
    if (status >= 400) {
      throw new Error(`HTTP ${status}: ${text.slice(0, 200)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`响应无法解析（body: ${text.slice(0, 120)}）`)
    }
    if (typeof parsed !== 'object' || parsed === null) throw new Error('响应形状异常')
    const envelope = parsed as Record<string, unknown>
    const code = typeof envelope.code === 'string' ? envelope.code : ''
    // `code === "ok"` 或字段缺失都视为成功（与 Go 侧 doBearer 口径一致）
    if (code !== '' && code !== 'ok') {
      const msg = typeof envelope.msg === 'string' ? envelope.msg : code
      throw new Error(`code=${code} msg=${msg}`)
    }
    return envelope.data
  }

  /**
   * 造一个「401 时自愈」的回调：按 ref 换 token 并回读新凭据。
   *
   * ⚠️ 必须读写**传入的 ref**（池内是 `QWENWORK_ACCOUNT_XXX`），
   * 不能用默认单凭据 ref —— 那会刷错凭据（raccoon 上踩过同类坑）。
   *
   * ⚠️ **必须把 pool + accountId 透传给 `refreshAccountCredential`**：
   * 只更新凭据、不回写账号池，面板会一直显示旧的过期时刻
   *（实测：凭据已续到 10/22，池里仍是当天 00:19 —— 与 raccoon 那个 3.1 小时的
   * 同类缺陷一模一样）。
   *
   * ⚠️ **不做「是否已新鲜」的短路判断**：OAuth token 与 device_token 都可能是
   * 未过期的合法 JWT，无法凭过期时间区分二者。故自愈就是**无条件换一次**
   *（refresh 幂等：换出的 token 可继续用，refresh_token 会被轮换并落盘）。
   */
  private healerFor(
    pool: AccountPool | undefined,
    accountId: string | undefined,
  ): (() => Promise<QwenworkCredential | undefined>) | undefined {
    return async () => {
      // accountId 缺失时按凭据身份反查（与 `syncAccountExpiry` 的既有能力一致）
      await this.refreshAccountCredentialById(accountId, pool)
      if (accountId === undefined || accountId === '') return undefined
      try {
        const entry = pool?.findAccount(accountId)
        if (entry === undefined) return undefined
        const after = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef))
        return after === undefined ? undefined : parseQwenworkCredential(after.value)
      } catch {
        return undefined
      }
    }
  }

  /**
   * 按 **accountId**（而非 ref 名）续期，供「401 自愈」用。
   *
   * WHY 不直接用 ref 名：`credits.balances` 只拿到账号条目（含 id 与 credentialRef），
   * 而自愈回调是在**凭据层**触发的；按 id 走能顺带把 `pool` + `accountId`
   * 交给 `refreshAccountCredential`，从而把新 `expiresAt` 写回账号池。
   */
  private async refreshAccountCredentialById(
    accountId: string | undefined,
    pool: AccountPool | undefined,
  ): Promise<void> {
    if (accountId === undefined || accountId === '' || pool === undefined) {
      throw new Error('自愈需要账号 id 与账号池')
    }
    const entry = pool.findAccount(accountId)
    if (entry === undefined) throw new Error(`账号 ${accountId} 不在账号池`)
    await this.refreshAccountCredential(entry.credentialRef, pool, entry.id)
  }

  /**
   * 查询总余额（`/user/balance`）。
   *
   * ⚠️ 上游直接下发「界面同源」的积分数（如 `2090.38`），
   * **不做 ×100 缩放** —— 那样面板会虚高 100 倍。小数截断（对话消耗的零头
   * 如 -0.0014 在截断后不可见，可接受）。
   */
  async fetchCreditBalance(
    credential: QwenworkCredential,
    pool?: AccountPool,
    accountId?: string,
  ): Promise<CreditBalance | null> {
    const detail = await this.fetchBalanceDetail(credential, pool, accountId)
    if (detail === null) return null
    return {
      total: detail.total,
      packages: detail.items,
      expiredTotal: 0,
    }
  }

  /**
   * 取「网页域可用」的 token。
   *
   * ## ⚠️ 为什么不能直接用 `credential.access_token`（真实缺陷，2026-10-15 现场）
   *
   * OAuth 授权码兑换出的 `access_token` **只对 COSY 域（推理/模型目录）有效**，
   * 拿它调 Bearer 网页域（`/user/balance`、`/user/wallets`、`/user/info`）
   * 一律 **HTTP 401 `{"code":"invalid-credential","msg":"Invalid JWT token"}`**。
   * 网页域认的是 `deviceToken/refresh` 换出的 **`device_token`**。
   *
   * 实证（同账号同档位对照）：
   *
   * | token | 余额（网页域） | 推理（COSY 域） |
   * |---|---|---|
   * | OAuth `access_token` | **401 Invalid JWT token** | ✅ 出流 |
   * | `device_token` | ✅ 200（余额 1521.84） | ✅ 出流 |
   *
   * ⇒ **只需在网页域换 token**，推理域两者皆可。故本类的修复是「登录落盘时
   * 就把 `access_token` 换成 `device_token`」（见 `persistLogin`），而不是在
   * 余额查询里临时换 —— 后者每次查询都多一个往返。
   *
   * Go 侧同款现象与其自愈方式见 `wild-work/internal/app/app.go:1253-1254`：
   * 「若 Poll 兑换的首个 token 无效（实测 OAuth 兑换 token 调 /user/info 会
   * 401 invalid-credential），refreshIfSessionDead 会自动换新 token」。
   */
  /**
   * 余额明细（总额 + 各钱包分项）。查不到返回 `null`（卡片显示原因，**不是** 0）。
   *
   * @param pool / @param accountId 提供时启用「401 自愈」
   *（先 refresh 换 device_token 再重试一次），使历史账号无需重新登录即可自愈，
   * 并把新过期时刻写回账号池。
   */
  async fetchBalanceDetail(
    credential: QwenworkCredential,
    pool?: AccountPool,
    accountId?: string,
  ): Promise<QwenworkBalanceDetail | null> {
    const heal = this.healerFor(pool, accountId)
    let balance: unknown
    try {
      balance = await this.bearerGet(QWENWORK_BALANCE_PATH, credential, heal)
    } catch (error) {
      this.ctx.logger?.warn?.(`[qwenwork] 余额查询失败：${error instanceof Error ? error.message : String(error)}`)
      return null
    }
    if (typeof balance !== 'object' || balance === null) return null
    const balanceRecord = balance as Record<string, unknown>
    const raw = readNumber(balanceRecord.balance)
    // `balance` 是核心字段：没有它就说明响应形状不对，不编造数字。
    if (raw === undefined) return null
    const total = Math.trunc(raw)

    // 钱包分项尽力而为：失败只回总额，不影响主流程。
    const items: CreditPackage[] = []
    try {
      const wallets = await this.bearerGet(QWENWORK_WALLETS_PATH, credential, heal)
      collectWallets(wallets, items)
    } catch {
      // 明细失败不影响总额
    }
    if (items.length === 0) {
      items.push(makePackage('全部钱包', total))
    }
    return { total, items }
  }

  /**
   * 查询费率（`/api/chat-modes` 的 `price_factor`）。
   *
   * 失败回退静态表 —— 费率只是展示信息，不该让整个渠道出错。
   */
  async fetchModelPricing(
    credential: QwenworkCredential,
    pool?: AccountPool,
    accountId?: string,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    try {
      const data = await this.bearerGet(QWENWORK_CHAT_MODES_PATH, credential, this.healerFor(pool, accountId))
      if (typeof data === 'object' && data !== null) {
        const rows = (data as Record<string, unknown>).qwork
        if (Array.isArray(rows)) {
          for (const raw of rows) {
            if (typeof raw !== 'object' || raw === null) continue
            const record = raw as Record<string, unknown>
            const key = typeof record.key === 'string' ? record.key.trim() : ''
            if (key === '' || record.enable === false) continue
            const factor = readNumber(record.price_factor) ?? readNumber(record.cost_factor)
            if (factor !== undefined) out.set(key, factor)
          }
        }
      }
    } catch {
      // 回退静态表
    }
    if (out.size === 0) {
      for (const model of this.product.fallbackModels) out.set(model.id, model.priceFactor)
    }
    return out
  }

  /**
   * **不提供**每日签到（本渠道无签到端点）。
   *
   * ⚠️ **不发任何上游请求就返回**：自动签到引擎靠「调用 `claimAll` 按返回的信封
   * 判跳过」来决定遍历范围，它**不维护第二份能力名单**。若这里真去发一个必然
   * 失败的请求，引擎每天会把它计为「失败」并重试（真实缺陷形态见 workbuddy 守卫）。
   *
   * 文案必须逐字匹配 {@link QWENWORK_NO_CHECKIN_MESSAGE} 的判据串。
   */
  async claimDailyCheckin(_credential: QwenworkCredential): Promise<ClaimOutcome> {
    return { kind: 'failed', code: 0, message: QWENWORK_NO_CHECKIN_MESSAGE }
  }

  /** 静态兜底模型表（动态目录不可用时）。 */
  fallbackModels(): readonly QwenworkFallbackModel[] {
    return this.product.fallbackModels
  }

  /** 把客户端模型名映射成上游档位 key（供适配器与 RPC 共用）。 */
  modelKey(clientName: string): string {
    return qwenworkModelKey(clientName)
  }
}

/** 构造一个资源包条目（分项余额用）。 */
function makePackage(name: string, remaining: number): CreditPackage {
  return {
    name,
    unit: '积分',
    remaining,
    total: remaining,
    used: 0,
    active: true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
  }
}

/**
 * 从 `/user/wallets` 响应收集分项钱包。
 *
 * 上游形状：`{active_wallets:{wallets:[{balance, valid_to}]}, daily_credits:{total_balance},
 * longterm_credits:{total_balance}, monthly_credits:{total_balance}}`。
 * 三个汇总字段各自代表一类来源，有效期与回补规则都不同，故**分开作 package**。
 */
function collectWallets(data: unknown, out: CreditPackage[]): void {
  if (typeof data !== 'object' || data === null) return
  const record = data as Record<string, unknown>
  const groups: ReadonlyArray<readonly [string, string]> = [
    ['daily_credits', '每日积分'],
    ['longterm_credits', '长期积分'],
    ['monthly_credits', '月度积分'],
  ]
  for (const [key, label] of groups) {
    const group = record[key]
    if (typeof group !== 'object' || group === null) continue
    const total = readNumber((group as Record<string, unknown>).total_balance)
    if (total !== undefined && total > 0) out.push(makePackage(label, Math.trunc(total)))
  }
  // active_wallets 是逐钱包明细（含到期时间），作为「其它钱包」汇总
  const active = record.active_wallets
  if (typeof active === 'object' && active !== null) {
    const wallets = (active as Record<string, unknown>).wallets
    if (Array.isArray(wallets) && wallets.length > 0) {
      let sum = 0
      for (const raw of wallets) {
        if (typeof raw !== 'object' || raw === null) continue
        const value = readNumber((raw as Record<string, unknown>).balance)
        if (value !== undefined) sum += value
      }
      if (sum > 0) out.push(makePackage('活动钱包', Math.trunc(sum)))
    }
  }
}

/** 未使用但保留：设备令牌刷新路径常量（供诊断/调试引用）。 */
export const QWENWORK_REFRESH_PATH = QWENWORK_DEVICE_TOKEN_REFRESH_PATH

/** 未使用但保留：默认网关（供诊断引用）。 */
export const QWENWORK_GATEWAY = QWENWORK_GATEWAY_BASE

/** 重新导出，避免调用方为「是否过期」再 import 一次。 */
export { isQwenworkExpired }
