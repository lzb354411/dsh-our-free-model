/**
 * MonkeyCode 鉴权服务（`ctx.monkeycodeAuth`）。
 *
 * ## 与其它渠道 Auth 的根本差别
 *
 * 本渠道**没有登录流程**：凭据来自本机官方客户端 `ohmyagent` 的导入
 * （见 `monkeycode-import.ts`）。故本类**没有** `startLogin` / `persistLogin`，
 * 只有「落盘导入结果」「判可用」「查钱包额度」三件事。
 *
 * ## ⚠️ 禁止为本渠道注册续期定时器 / 保活
 *
 * 上游 `RefreshToken` 是**空实现**（直接返回 nil），即**没有 refresh 端点**。
 * 若照其它渠道的形态把它挂进 `index.ts` 的续期调度表，调度器会每天发起一次
 * **必然失败**的刷新请求，并在面板上渲染成红色「续期失败」——而本渠道的凭据
 * 根本不会过期（导入时写 now + 50 年）。
 *
 * 同理**不得**注册定时保活：Go 侧对本渠道传的是显式空切片
 * （`main.go:376-377` 关闭全部定时任务）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  MONKEYCODE_COOKIE_BAIZHI,
  MONKEYCODE_COOKIE_CONSOLE,
  type MonkeycodeCredential,
  isUsableMonkeycodeCredential,
} from './monkeycode.js'
import { MONKEYCODE_WALLET_PATH } from './monkeycode.js'
import { MONKEYCODE, type MonkeycodeProduct } from './monkeycode-product.js'

/** 钱包余额（控制台接口返回）。 */
export interface MonkeycodeWallet {
  /**
   * 余额。
   *
   * ⚠️ 上游返回的是**毫积分**（console 前端做 `balance/1e3`），
   * 这里已换算成积分（`(milli + 999) / 1000`，向上取整）。
   */
  balance: number
  /** 毫积分原值（保留供诊断/展示精度用）。 */
  balanceMilli: number
  /** 当日 token 余额（上游 `daily_token_balance`）。 */
  dailyTokenBalance?: number
  /** 当日 token 上限（上游 `daily_token_limit`）。 */
  dailyTokenLimit?: number
}

/** 钱包查询结果：成功、无 Cookie、或失败（**调用方据此决定是否罚号**）。 */
export type MonkeycodeWalletOutcome =
  | { kind: 'ok'; wallet: MonkeycodeWallet }
  | { kind: 'no-cookie'; reason: string }
  | { kind: 'error'; reason: string; status?: number }

export interface MonkeycodeAuthOptions {
  /**
   * 网络出口。
   *
   * ⚠️ **必须传入**（按次解析 `globalThis.fetch` 并套系统代理），
   * 与其余渠道一致；省略会让代理失效且测试拦不住。
   */
  fetcher?: typeof fetch
  /** 产品配置；默认 {@link MONKEYCODE}。 */
  product?: MonkeycodeProduct
}

/**
 * MonkeyCode 鉴权服务。
 *
 * 服务名由 `product.id` 派生 ⇒ `ctx.monkeycodeAuth`。
 */
export class MonkeycodeAuth extends Service {
  private readonly product: MonkeycodeProduct

  constructor(ctx: Context, private readonly options: MonkeycodeAuthOptions = {}) {
    super(ctx, `${(options.product ?? MONKEYCODE).id}Auth`)
    this.product = options.product ?? MONKEYCODE
  }

  private get fetcher(): typeof fetch {
    return this.options.fetcher ?? globalThis.fetch
  }

  /**
   * 落盘一份导入的凭据。
   *
   * ⚠️ **只写凭据，不动账号池** —— 账号条目的增删由 `channel-pack-rpc.ts`
   * 的导入分支负责（那层要处理占位条目、昵称回填、失败清理）。
   *
   * @returns 写好的凭据对象（供调用方回填昵称/uid）。
   */
  async persistImportedCredential(
    credential: MonkeycodeCredential,
    credentialRef: CredentialRef,
  ): Promise<MonkeycodeCredential> {
    if (!isUsableMonkeycodeCredential(credential)) {
      throw new Error('monkeycode: 导入的凭据缺少 api_key 或 signing_secret（请重新导入客户端凭据）')
    }
    // ⚠️ 字段顺序无关紧要，但**必须**去掉 undefined 字段：把
    // `console_cookie: undefined` 写进 JSON 会让「有 Cookie」的判据
    // （`typeof === 'string'`）失真。
    const document: Record<string, unknown> = {
      access_token: credential.access_token,
      signing_secret: credential.signing_secret,
      // ⚠️ refresh_token 恒为空串（无 refresh 端点），显式写入以免账号池
      // 把「字段缺失」与「空串」当成两种状态（既有渠道用空串表示「不可续期」）。
      refresh_token: '',
    }
    if (typeof credential.expires_at === 'number') document.expires_at = credential.expires_at
    if (typeof credential.uid === 'string' && credential.uid !== '') document.uid = credential.uid
    if (typeof credential.nickname === 'string' && credential.nickname !== '') {
      document.nickname = credential.nickname
    }
    if (typeof credential.base_url === 'string' && credential.base_url !== '') {
      document.base_url = credential.base_url
    }
    if (typeof credential.console_cookie === 'string' && credential.console_cookie !== '') {
      document.console_cookie = credential.console_cookie
    }
    if (typeof credential.baizhi_cookie === 'string' && credential.baizhi_cookie !== '') {
      document.baizhi_cookie = credential.baizhi_cookie
    }
    await this.ctx.credentials.set(credentialRef, JSON.stringify(document))
    return document as unknown as MonkeycodeCredential
  }

  /** 服务状态（面板用）。 */
  async status(): Promise<{ configured: boolean; refreshable: boolean }> {
    const resolved = await this.ctx.credentials.resolve(
      credentialRef(this.product.defaultCredentialRef),
    )
    if (!resolved) return { configured: false, refreshable: false }
    try {
      const parsed = JSON.parse(resolved.value) as MonkeycodeCredential
      return {
        configured: isUsableMonkeycodeCredential(parsed),
        // ⚠️ 恒 false：本渠道没有 refresh 端点（见文件头）。
        refreshable: false,
      }
    } catch {
      return { configured: false, refreshable: false }
    }
  }

  /**
   * 「续期」的**有效性探测**（本渠道没有真正的续期，见文件头）。
   *
   * 供 `account.refresh` RPC 分支调用：重读该 ref 的凭据，校验两把密钥是否
   * 齐全。齐全即成功（**不做任何网络请求**）；不齐则抛**可行动**的错误，
   * 引导用户重新导入客户端凭据。
   *
   * ⚠️ 与「真续期」的语义差别要说清：其它渠道的 `refreshAccountCredential`
   * 会换回新 token 并写回账号池；本渠道**不换 token**（没有端点可换），
   * 故这里唯一能做的就是如实报告凭据是否可用。
   */
  async probeAccountCredential(ref: CredentialRef | string): Promise<void> {
    const resolved = await this.ctx.credentials.resolve(
      typeof ref === 'string' ? credentialRef(ref) : ref,
    )
    if (!resolved) {
      throw new Error('monkeycode: 凭据未配置，请在面板点击「导入客户端凭据」')
    }
    let parsed: MonkeycodeCredential
    try {
      parsed = JSON.parse(resolved.value) as MonkeycodeCredential
    } catch {
      throw new Error('monkeycode: 凭据解析失败，请在面板点击「导入客户端凭据」重新导入')
    }
    if (!isUsableMonkeycodeCredential(parsed)) {
      throw new Error(
        'monkeycode: 凭据缺少 api_key 或 signing_secret，'
        + '请在面板点击「导入客户端凭据」重新导入',
      )
    }
  }

  /**
   * 查询控制台钱包额度。
   *
   * ## 三个域的关键约束
   *
   * 控制台接口（`{consoleBase}/api/v1/users/wallet`）**只认 Cookie**
   * （`monkeycode_ai_session`）—— oma_ key 在该域**一律 401**。
   * Cookie 由导入时尽力而为地取得，拿不到时本方法返回 `no-cookie`，
   * 调用方应据此**按「无额度信息」处理、不罚号**（对齐 Go
   * `client.go:309-310,390` 的口径）。
   *
   * ⚠️ 单位换算：上游 `balance` 是**毫积分**，返回给上层的是积分。
   */
  async fetchWallet(credential: MonkeycodeCredential): Promise<MonkeycodeWalletOutcome> {
    const cookie = credential.console_cookie
    if (typeof cookie !== 'string' || cookie.trim() === '') {
      return {
        kind: 'no-cookie',
        reason: '未导入控制台 Cookie，无法查询额度（不影响对话）',
      }
    }
    const url = `${this.product.consoleBase}${MONKEYCODE_WALLET_PATH}`
    try {
      const response = await this.fetcher(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          cookie: `${MONKEYCODE_COOKIE_CONSOLE}=${cookie}`,
          'user-agent': 'ohmyagent f6b21ad',
        },
      })
      if (!response.ok) {
        return {
          kind: 'error',
          reason: `钱包查询失败（HTTP ${response.status}）`,
          status: response.status,
        }
      }
      const payload: unknown = await response.json()
      if (typeof payload !== 'object' || payload === null) {
        return { kind: 'error', reason: '钱包响应不是 JSON 对象' }
      }
      const data = (payload as Record<string, unknown>).data
      if (typeof data !== 'object' || data === null) {
        return { kind: 'error', reason: '钱包响应缺少 data 段' }
      }
      const record = data as Record<string, unknown>
      const balanceMilli = toNumber(record.balance)
      if (balanceMilli === undefined) {
        return { kind: 'error', reason: '钱包响应缺少 balance' }
      }
      const wallet: MonkeycodeWallet = {
        // ⚠️ 向上取整（对齐 Go `client.go:558-563` 的 `(milli+999)/1000`）：
        // 向下取整会让 1 毫积分的余额显示成 0，看起来像「额度耗尽」。
        balance: Math.ceil(balanceMilli / 1000),
        balanceMilli,
      }
      const dailyBalance = toNumber(record.daily_token_balance)
      if (dailyBalance !== undefined) wallet.dailyTokenBalance = dailyBalance
      const dailyLimit = toNumber(record.daily_token_limit)
      if (dailyLimit !== undefined) wallet.dailyTokenLimit = dailyLimit
      return { kind: 'ok', wallet }
    } catch (error) {
      return {
        kind: 'error',
        reason: `钱包查询异常：${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  /**
   * 派生出可用 Cookie 的说明（面板/错误文案用）。
   *
   * ⚠️ Go 侧还会用 `baizhi_session` 经 OAuth 派生控制台会话
   * （`client.go:439-517`，**必须禁用自动重定向**才能拿到 `Set-Cookie`）。
   * 本轮**不实现**该派生：它需要一次额外的、带 Cookie 的 OAuth 往返，
   * 且派生失败时的降级路径（「无额度信息、不罚号」）已经完全可用。
   * 保留本方法与常量引用，便于将来补齐时定位到对应字段。
   */
  cookieNames(): { console: string; baizhi: string } {
    return { console: MONKEYCODE_COOKIE_CONSOLE, baizhi: MONKEYCODE_COOKIE_BAIZHI }
  }
}

/** 数值字段容错（上游可能给字符串或缺失）。 */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** 默认凭据 ref（供调用方使用，避免各处写字符串）。 */
export const MONKEYCODE_DEFAULT_CREDENTIAL_REF = MONKEYCODE.defaultCredentialRef

/**
 * 「不支持每日签到」的守卫文案。
 *
 * ⚠️ **必须逐字包含 `'不支持每日签到'`**：自动签到引擎的 `isUnsupportedCheckin()`
 * 只匹配该串与 `'unsupported provider'` —— 写成别的措辞会被计为「失败」而非
 * 「跳过」，于是引擎每天真发一轮必然失败的请求并生成假警报
 * （`channel-pack-rpc.ts` 里 WorkBuddy 国际版那条守卫记录了这个教训）。
 *
 * ⚠️ 本常量与 `client.js` 的 `CHANNEL_CREDITS` 能力表是**同源改动，别只改一半**：
 * 前端不给「领取」按钮、后端不发上游请求，缺一都会让用户看到假失败。
 */
export const MONKEYCODE_NO_CHECKIN_MESSAGE =
  '不支持每日签到（MonkeyCode 上游未提供额度或签到端点）'
