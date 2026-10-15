/**
 * MonkeyCode 的 **Prompt 签名**（官方称 promptauth）。
 *
 * ## 算法（2026-09-23 字节级确认）
 *
 * ```
 * X-Ohmyagent-Signature = "v1=" + hex(HMAC-SHA256(signing_secret, system[0].text))
 * ```
 *
 * ## 四个要点
 *
 * 1. **只签第一条 system 的纯文本** —— 后续 system 条目、`messages`、`tools`
 *    都不参与。所以客户端可以自由追加动态 system 内容（放在 `system[1..]`）。
 * 2. 编码是**小写 hex**，带 `v1=` 前缀（不是裸 hex，也不是 base64 —— 两者都 403）。
 * 3. **签名输入按原样字节参与计算**：官方提示词含 44 个 CRLF，任何换行归一化
 *    （`\r\n` → `\n`）都会让签名对不上。本实现**不对输入做任何改写**。
 * 4. 因为本渠道固定用 `MONKEYCODE_SIGNATURE_SYSTEM_PROMPT` 作为 `system[0]`，
 *    签名**只依赖 secret** ⇒ 可按 secret 缓存，同一账号只算一次。
 *
 * ## 缓存安全性
 *
 * 签名输入是编译期常量，故同一 secret 的签名恒定；换账号/换 secret 会自然
 * 出现新 key，旧条目无副作用（进程生命周期内不清理，泄漏量 = 账号数）。
 *
 * 移植来源：`wild-work/internal/monkeycode/sign.go`（Go，只读参考）。
 */

import { createHmac } from 'node:crypto'
import { MONKEYCODE_SIGNATURE_SYSTEM_PROMPT } from './monkeycode.js'

/**
 * 计算签名头取值（含 `v1=` 前缀）。
 *
 * ⚠️ `text` 必须与出站请求里 `system[0].text`（Responses 面是
 * `input[0].content`）**逐字节一致**。
 *
 * @param secret - `omas_` 前缀的 signing_secret。
 * @param text - 被签内容（本渠道恒为固定 short prompt，见调用方）。
 */
export function signMonkeycodePrompt(secret: string, text: string): string {
  const mac = createHmac('sha256', Buffer.from(secret, 'utf8'))
  mac.update(Buffer.from(text, 'utf8'))
  // 小写 hex：`digest('hex')` 本身就是小写。
  return `v1=${mac.digest('hex')}`
}

/**
 * 按 secret 缓存签名。
 *
 * ⚠️ 用 `Map` 而非「按请求重算」：签名输入是常量，每次请求重算 HMAC 是纯浪费
 * （Go 侧用 `sync.Map` 出于并发考量；Node 单线程，`Map` 语义等价）。
 */
const signatureCache = new Map<string, string>()

/**
 * 返回该 secret 对应固定 system prompt 的签名。
 *
 * @throws 当 `secret` 为空白时给出**可行动**的错误文案（提示去重新导入），
 *   而不是笼统的「认证失败」—— 用户据此知道怎么修。
 */
export function monkeycodeSignature(secret: string): string {
  const normalized = secret.trim()
  if (normalized === '') {
    throw new Error('monkeycode: 缺少 signing_secret（请在面板重新导入客户端凭据）')
  }
  const cached = signatureCache.get(normalized)
  if (cached !== undefined) return cached
  const signature = signMonkeycodePrompt(normalized, MONKEYCODE_SIGNATURE_SYSTEM_PROMPT)
  signatureCache.set(normalized, signature)
  return signature
}

/** 清空签名缓存（仅测试用；生产路径不需要）。 */
export function clearMonkeycodeSignatureCache(): void {
  signatureCache.clear()
}
