/**
 * 千问办公 OAuth 授权码登录（PKCE S256 + 本机回调）。
 *
 * ## 链路（逆向自桌面 IDE 的 Ory Hydra 授权码流）
 *
 * ```
 * 1. 起本机回调 server（127.0.0.1:<随机端口>/callback），生成 PKCE + state
 * 2. 用户在浏览器打开授权 URL：
 *    - 浏览器**已有**千问办公 session → 自动跳回本机回调（连扫码都不用）
 *    - 未登录 → 展示 QR/手机号登录页，用户操作后自动跳回
 * 3. 本机回调收 ?code=… → 立即用 code_verifier 兑换 token（Hydra 标准 /oauth2/token）
 * 4. 关闭回调 server
 * ```
 *
 * ## ⚠️ 与桌面客户端的差异（有意为之）
 *
 * 桌面 IDE 的 `redirect_uri` 是 `https://gateway.qwenwork.cn/oauth/callback`
 *（在桌面进程内兑换）。本工具改用**本机回调自兑** —— 实测 Hydra 接受本机 http
 * 回调与自造 state，且 token 等价（同 client_id / scope）。
 *
 * ## ⚠️ 三条工程约束
 *
 * 1. **必须「先监听、再拼 URL」**：端口被占时会回退到别的端口；若先拼 URL 再监听，
 *    回调地址与实际监听端口不一致，授权码永远送不到（Go 侧同款教训）。
 * 2. **`state` 必须校验**：回调里 state 不匹配一律拒绝（防伪造回调）。
 * 3. **public client 无 secret**：兑换表单只带 `client_id` + `code_verifier`，
 *    不要画蛇添足加 `client_secret`。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import {
  QWENWORK_AUTHORIZE_PATH,
  QWENWORK_CLIENT_ID,
  QWENWORK_OAUTH_BASE,
  QWENWORK_SCOPE,
  QWENWORK_TOKEN_PATH,
  type QwenworkCredential,
} from './qwenwork.js'

/** 授权流程总预算（毫秒）。与 Go 侧回调 server 的 5 分钟 TTL 同口径。 */
export const QWENWORK_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/** 用户在浏览器里点了「取消」/ 拒绝授权。 */
export class QwenworkLoginCancelledError extends Error {
  constructor(message = '千问办公授权已取消') {
    super(message)
    this.name = 'QwenworkLoginCancelledError'
  }
}

/** 授权窗口超时（没人来点）。 */
export class QwenworkLoginExpiredError extends Error {
  constructor(message = '千问办公授权超时，请重新发起') {
    super(message)
    this.name = 'QwenworkLoginExpiredError'
  }
}

/** PKCE 配对（RFC 7636 S256）。 */
export interface QwenworkPkcePair {
  verifier: string
  challenge: string
}

/**
 * 生成 PKCE 配对。
 *
 * verifier 取 48 字节随机数的 base64url（≈64 字符，落在 RFC 允许的 43–128 内）；
 * challenge 是 `base64url(SHA256(verifier))`，与 Go 侧 `makePKCE` 逐字节同构。
 */
export function makeQwenworkPkce(): QwenworkPkcePair {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url')
  return { verifier, challenge }
}

/**
 * 构造授权 URL。
 *
 * ⚠️ `code_challenge_method` 必须是 `S256`（不是 plain）。
 */
export function buildQwenworkAuthUrl(input: {
  redirectUri: string
  challenge: string
  state: string
}): string {
  const query = new URLSearchParams({
    client_id: QWENWORK_CLIENT_ID,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: QWENWORK_SCOPE,
    state: input.state,
  })
  return `${QWENWORK_OAUTH_BASE}${QWENWORK_AUTHORIZE_PATH}?${query.toString()}`
}

/** 从 JWT 解出 uid / 昵称（token 端点**不返回** userinfo）。 */
export function parseQwenworkJwtIdentity(token: string): { uid: string; nickname: string } {
  const empty = { uid: '', nickname: '' }
  if (typeof token !== 'string' || token.length === 0) return empty
  const parts = token.split('.')
  if (parts.length < 2) return empty
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'))
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return empty
    const record = payload as Record<string, unknown>
    // uid 优先 `user_id`，回退 `sub`（与 Go 侧口径一致）
    const userId = typeof record.user_id === 'string' ? record.user_id : ''
    const sub = typeof record.sub === 'string' ? record.sub : ''
    const nickname = typeof record.username === 'string' ? record.username : ''
    return { uid: userId !== '' ? userId : sub, nickname }
  } catch {
    return empty
  }
}

/** 令牌端点响应（已归一）。 */
export interface QwenworkTokenGrant {
  accessToken: string
  refreshToken: string
  /** **秒**（不要当毫秒用，见 `qwenworkAuth` 的续期换算）。 */
  expiresIn: number
  uid: string
  nickname: string
}

/**
 * 解析令牌端点响应。
 *
 * ⚠️ `expires_in` 的**单位是秒** —— 本渠道最大的历史坑就是把它当毫秒，
 * 导致落盘过期时刻比真实寿命少约 7 天 ⇒ 每次请求都刷 token ⇒ 与官方 App
 * 高频互踩直至 refresh token 作废、账号被禁用。解析处**不做任何换算**，
 * 换算集中在 `qwenwork-auth.ts` 一处并显式标注单位。
 */
export function parseQwenworkTokenGrant(payload: unknown): QwenworkTokenGrant {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('令牌端点返回无法解析（非 JSON 对象）')
  }
  const record = payload as Record<string, unknown>
  const errorCode = typeof record.error === 'string' ? record.error : ''
  if (errorCode !== '') {
    const description = typeof record.error_description === 'string' ? record.error_description : ''
    throw new Error(description === '' ? errorCode : `${errorCode}: ${description}`)
  }
  const accessToken = typeof record.access_token === 'string' ? record.access_token : ''
  if (accessToken === '') throw new Error('令牌端点未返回 access_token')

  const refreshToken = typeof record.refresh_token === 'string' ? record.refresh_token : ''
  // expires_in 缺失或非法时**不编造**：用 0 表示「未知」，由上层决定回退值。
  const rawExpiresIn = record.expires_in
  const expiresIn = typeof rawExpiresIn === 'number' && Number.isFinite(rawExpiresIn) && rawExpiresIn > 0
    ? Math.floor(rawExpiresIn)
    : 0

  // token 端点不返回 userinfo ⇒ 从 access_token 的 JWT 解身份。
  // ⚠️ **必须回退到 id_token**：Go 侧实测 OAuth 兑换出的 access token
  // 偶发不含 username，而 id_token 里有。
  let identity = parseQwenworkJwtIdentity(accessToken)
  const idToken = typeof record.id_token === 'string' ? record.id_token : ''
  if (identity.uid === '' && idToken !== '') identity = parseQwenworkJwtIdentity(idToken)

  return {
    accessToken,
    refreshToken,
    expiresIn,
    uid: identity.uid,
    nickname: identity.nickname,
  }
}

/** 用授权码兑换令牌（**public client，不带 client_secret**）。 */
export async function exchangeQwenworkCode(
  code: string,
  redirectUri: string,
  verifier: string,
  options: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<QwenworkTokenGrant> {
  const fetcher = options.fetcher ?? fetch
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: QWENWORK_CLIENT_ID,
    code_verifier: verifier,
  })
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
  }
  if (options.signal !== undefined) init.signal = options.signal
  const response = await fetcher(`${QWENWORK_OAUTH_BASE}${QWENWORK_TOKEN_PATH}`, init)
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`令牌端点返回无法解析（HTTP ${response.status}）`)
  }
  if (!response.ok) {
    const record = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
    const code2 = typeof record.error === 'string' ? record.error : `HTTP ${response.status}`
    const description = typeof record.error_description === 'string' ? record.error_description : ''
    throw new Error(description === '' ? code2 : `${code2}: ${description}`)
  }
  return parseQwenworkTokenGrant(parsed)
}

/**
 * 用 refresh_token 轮换新令牌。
 *
 * ⚠️ 千问办公的 refresh token **会轮换**，响应里的新值必须落盘，
 * 否则下次续期用的是已作废的旧值（表现为「昨天还好好的，今天突然要重新登录」）。
 *
 * ⚠️ 请求体形态是 `{refresh_token, target:"c"}`（与 Go 侧一致）——
 * 不是标准 OAuth 的 `grant_type=refresh_token` 表单。
 */
export async function refreshQwenworkToken(
  refreshToken: string,
  options: { fetcher?: typeof fetch; signal?: AbortSignal; gatewayBase?: string } = {},
): Promise<QwenworkTokenGrant> {
  if (refreshToken === '') throw new Error('没有 refresh_token，需要重新登录')
  const fetcher = options.fetcher ?? fetch
  const gateway = options.gatewayBase ?? 'https://gateway.qwenwork.cn'
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken, target: 'c' }),
  }
  if (options.signal !== undefined) init.signal = options.signal
  const response = await fetcher(`${gateway}/api/v1/deviceToken/refresh`, init)
  const text = await response.text()
  if (response.status === 401 || response.status === 403) {
    throw new Error('refresh token 已失效，请重新登录千问办公')
  }
  if (!response.ok) {
    throw new Error(`token 轮换失败 HTTP ${response.status}: ${text.slice(0, 200)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`token 轮换响应无法解析（body: ${text.slice(0, 200)}）`)
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('token 轮换响应形状异常')
  const record = parsed as Record<string, unknown>
  // 上游字段名不统一：`device_token` 优先，回退 `token`
  const upstream = typeof record.device_token === 'string' && record.device_token !== ''
    ? record.device_token
    : typeof record.token === 'string' ? record.token : ''
  if (upstream === '') throw new Error('token 轮换响应缺少 device_token/token')
  const next = typeof record.refresh_token === 'string' ? record.refresh_token : ''
  if (next === '') throw new Error('token 轮换响应缺少 refresh_token')

  const rawExpiresAt = typeof record.expires_at === 'string' ? record.expires_at : ''
  const rawExpiresIn = record.expires_in
  const expiresIn = typeof rawExpiresIn === 'number' && Number.isFinite(rawExpiresIn) && rawExpiresIn > 0
    ? Math.floor(rawExpiresIn)
    : 0
  // 绝对字段优先：它能避开「expires_in 单位理解错」这类问题
  if (rawExpiresAt !== '') {
    const parsedMs = Date.parse(rawExpiresAt)
    if (Number.isFinite(parsedMs)) {
      const identity = parseQwenworkJwtIdentity(upstream)
      return {
        accessToken: upstream,
        refreshToken: next,
        // 换算成「距现在多少秒」，让上层统一按 expires_in 处理
        expiresIn: Math.max(0, Math.floor((parsedMs - Date.now()) / 1000)),
        uid: identity.uid,
        nickname: identity.nickname,
      }
    }
  }
  const identity = parseQwenworkJwtIdentity(upstream)
  return { accessToken: upstream, refreshToken: next, expiresIn, uid: identity.uid, nickname: identity.nickname }
}

/** 回调成功后展示的页面。 */
const QWENWORK_CALLBACK_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>授权完成</title><style>body{font:15px/1.7 -apple-system,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f1115;color:#e6e8eb}.b{text-align:center}.k{font-size:34px;margin-bottom:8px}</style></head><body><div class="b"><div class="k">✓</div><div>授权已完成，可以关闭此页回到面板。</div></div></body></html>`

/** 已启动但尚未完成的授权流程。 */
export interface StartedQwenworkLoginFlow {
  /** 展示给用户的授权 URL。 */
  loginUrl: string
  /** 用户完成授权后落定的凭据。 */
  result: Promise<QwenworkCredential>
  /** 关闭回调服务器；**幂等**。 */
  close: () => Promise<void>
}

/** {@link startQwenworkOAuthFlow} 的选项。 */
export interface QwenworkOAuthOptions {
  /** 自定义 fetch（单测注入）。 */
  fetcher?: typeof fetch
  /** 固定回调端口；默认 0 = 动态分配。 */
  callbackPort?: number
  /** 授权总预算，默认 {@link QWENWORK_LOGIN_TIMEOUT_MS}。 */
  timeoutMs?: number
}

/**
 * 启动授权流程并**立即返回** `loginUrl`。
 *
 * 两步式的原因与其余渠道一致：浏览器只在用户点击后的短暂窗口内允许 `window.open`，
 * 阻塞式流程会让调用方拿到 URL 时手势已过期、弹窗被拦截。
 */
export async function startQwenworkOAuthFlow(
  options: QwenworkOAuthOptions = {},
): Promise<StartedQwenworkLoginFlow> {
  const pkce = makeQwenworkPkce()
  const state = randomUUID()
  const fetcher = options.fetcher ?? fetch

  let resolveCode: (code: string) => void = () => {}
  let rejectCode: (error: Error) => void = () => {}
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })

  const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      res.writeHead(404).end('Not found')
      return
    }
    const failure = url.searchParams.get('error')
    if (failure !== null && failure !== '') {
      const description = url.searchParams.get('error_description') ?? ''
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`授权被拒绝: ${failure}`)
      rejectCode(new QwenworkLoginCancelledError(description === '' ? failure : `${failure}: ${description}`))
      return
    }
    // 场景: state 不匹配（防伪造回调）
    if (url.searchParams.get('state') !== state) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('state 校验失败')
      rejectCode(new Error('state 校验失败，可能是伪造的回调'))
      return
    }
    const code = url.searchParams.get('code')
    if (code === null || code === '') {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('缺少 authorization code')
      rejectCode(new Error('回调缺少 authorization code'))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(QWENWORK_CALLBACK_HTML)
    resolveCode(code)
  }

  // ⚠️ 必须「先监听、再拼 URL」（见文件头第 1 条）
  const server: Server = createServer(handler)
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.callbackPort ?? 0, '127.0.0.1', () => {
      const address = server.address()
      const assigned = typeof address === 'object' && address !== null ? address.port : 0
      if (assigned <= 0) reject(new Error('无法分配回调端口'))
      else resolve(assigned)
    })
  })

  const redirectUri = `http://127.0.0.1:${port}/callback`
  const loginUrl = buildQwenworkAuthUrl({ redirectUri, challenge: pkce.challenge, state })

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  const timeoutMs = options.timeoutMs ?? QWENWORK_LOGIN_TIMEOUT_MS
  const result = Promise.race([
    codePromise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new QwenworkLoginExpiredError()), timeoutMs)
      timer.unref?.()
    }),
  ]).then(async (code) => {
    const grant = await exchangeQwenworkCode(code, redirectUri, pkce.verifier, { fetcher })
    return grant
  }).then((grant): QwenworkCredential => {
    if (grant.accessToken === '') throw new Error('授权成功但未拿到 access_token')
    return {
      access_token: grant.accessToken,
      refresh_token: grant.refreshToken,
      // ⚠️ 上游 `expires_in` 单位是**秒**，此处显式 ×1000 换算成毫秒。
      // 真实寿命实测 604800 秒（7 天）；缺失时回退 84 小时（JWT 实测寿命的一半），
      // 与 Go 侧 client.go 的回退口径一致。
      expires_at: Date.now() + (grant.expiresIn > 0 ? grant.expiresIn : 84 * 3600) * 1000,
      uid: grant.uid,
      nickname: grant.nickname,
    }
  })

  // 先挂空处理器：结果可能在调用方 await 之前就落定（用户授权极快或立刻超时），
  // 那一段窗口里 Node 会把它当成未处理拒绝并打印告警。
  result.catch(() => {}).finally(() => { void close() })

  return { loginUrl, result, close }
}
