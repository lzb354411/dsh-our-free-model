/**
 * 千问办公 COSY 请求签名（纯 TypeScript 实现）。
 *
 * ## 这段代码是整个渠道最关键、也最难调试的部分
 *
 * 网关（`gateway.qwenwork.cn`）用「RSA 包裹一把一次性 AES 密钥 + AES 加密身份 +
 * MD5 签请求」三段式校验「请求是否来自官方桌面客户端」。它**不看 UA、不看版本号**
 *（实测 `cosyVersion`/`ideVersion` 取值网关根本不校验）。
 *
 * ## ⚠️ 为什么必须新写而不是复用 qoder 的实现
 *
 * 仓库里 `qoder` 渠道走的是**同一套 COSY 协议**（同一把 RSA 公钥、同一签名串格式），
 * 但它的签名与加解密**全部封在 `qoder-auth-wasm.wasm` 里**（`qoder-wasm.ts` 只是
 * wasm-bindgen 桥）。千问办公需要的是**纯签名 + 明文 body**（不带 `Encode=1` 组包），
 * 且 WASM 那条路径是为「加密推理端点」设计的，套不到这里。
 *
 * 故本文件用 `node:crypto` 从零实现，与 Go 侧 `internal/qwenwork/cosy.go` **逐字节对齐**。
 *
 * ## ⚠️ 三个只有实测才能发现的坑（改动时务必保留）
 *
 * 1. **GET 请求的签名 body 必须是空串 `""`，不是 `"{}"`**。二者仅差两个字符，
 *    但结果从 200 变成 403 `Signature invalid`，且错误文本与「密钥算错」完全相同。
 * 2. **签名时间戳必须与 `Cosy-Date` 头逐字符一致**。若签名与头各自取一次时间，
 *    跨秒时会出现「签名用自己算的时间、头用另一个时间」，服务端重算必然不匹配
 *    —— 概率虽小但会随机复现，极难排查（Go 侧专门有 `TestCosyDateMatchesSignature`）。
 * 3. **签名后不得再修改 body**。本模块把「序列化 → 签名 → 发送」做成一个不可分割的
 *    流程：`signChatRequest` 接收的是**最终字节**，调用方不得在拿到头之后再动 body。
 *
 * ## 三段式流程
 *
 * ```
 * ① tempKey = 16 个 ASCII hex 字符（恰好满足 AES-128 的 key/iv 长度）
 *    CosyKey = base64(RSA_PKCS1v15(serverPubKey, tempKey))
 *
 * ② info 明文 = 紧凑 JSON {uid, aid:"", name, email, security_oauth_token}
 *    Info = base64(AES-128-CBC(key=iv=tempKey, PKCS7)(info 明文))
 *
 * ③ header = base64(JSON{version, requestId, info, cosyVersion, ideVersion})
 *    签名串 = headerB64 + "\n" + CosyKey + "\n" + date + "\n" + body + "\n" + path
 *    Authorization = "Bearer COSY." + headerB64 + "." + hex(MD5(签名串))
 * ```
 */

import {
  createCipheriv,
  createHash,
  createPublicKey,
  publicEncrypt,
  randomBytes,
  randomUUID,
  type KeyObject,
} from 'node:crypto'

/**
 * Qoder 系共享 RSA 公钥（桌面客户端硬编码，与 `internal/qoder/cosy.go` 逐字节相同）。
 *
 * ⚠️ 这是**公开信息**（在客户端包里），不是秘密 —— 服务端持对应私钥。
 * 客户端用公钥加密，服务端用私钥解开，因此客户端不需要任何预置秘密。
 */
export const QWENWORK_RSA_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

/**
 * COSY 协议版本号（进入 `header.cosyVersion`）。
 *
 * ⚠️ 取值与 Go 侧一致（`1.1.18`）。**实测网关不校验该字段** —— 它与
 * `qoder-wasm.ts` 里的 `1.1.49` 不同，两个值都能通过。保留是为了与已验证的实现
 * 逐字节一致：签名串的自包含性意味着服务端只校验「收到什么就签什么」。
 */
export const COSY_VERSION = '1.1.18'

/** IDE 版本号（进入 `header.ideVersion`）。同样实测不校验。 */
export const COSY_IDE_VERSION = '0.1.8'

/**
 * 公钥只解析一次（模块级缓存）。
 *
 * `createPublicKey` 每次调用都要解析 PEM、构造 KeyObject，属纯开销；
 * 而公钥是编译期常量，解析结果不可能变。故按模块生命周期缓存一次。
 */
let cachedPublicKey: KeyObject | undefined

function serverPublicKey(): KeyObject {
  if (cachedPublicKey === undefined) {
    cachedPublicKey = createPublicKey(QWENWORK_RSA_PUBLIC_KEY_PEM)
  }
  return cachedPublicKey
}

/**
 * 生成 `n` 个字符的随机 hex 串（`tempKey` 用）。
 *
 * WHY 用 ASCII hex 而不是随机二进制：AES-128 的 key 与 iv 都要求**恰好 16 字节**，
 * 而 `tempKey` 同时充当两者。16 个 ASCII 字符 = 16 字节，长度天然确定；
 * 若用随机二进制再 base64，长度会随填充浮动，且难以在 JSON 里安全承载。
 * 对齐桌面端的 `uuid.hex[:16]` 做法。
 */
export function cosyTempKey(n = 16): string {
  return randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n)
}

/**
 * AES-128-CBC 加密，key = iv = tempKey，PKCS7 填充。
 *
 * ⚠️ Node 的 `createCipheriv` **默认就是 PKCS7 且自动填充**（`autoPadding` 默认
 * `true`），这与 Go 侧手写的 PKCS7 逻辑等价（16 字节块下 PKCS7 == PKCS5）。
 * **不要**显式关掉 `autoPadding` —— 那会产出长度不是 16 倍数的密文，服务端解不开。
 */
export function cosyAesCbcEncrypt(plain: Buffer, tempKey: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-cbc', tempKey, tempKey)
  return Buffer.concat([cipher.update(plain), cipher.final()])
}

/** 单次请求的签名材料（每次请求新建；一次 RSA + 一次 AES，成本低）。 */
export interface CosySession {
  /** 16 个 ASCII hex 字符（与桌面端 `uuid.hex[:16]` 对齐）。 */
  readonly tempKey: string
  /** `base64(RSA_PKCS1(tempKey))` —— 要原样放进 `Cosy-Key` 头。 */
  readonly cosyKey: string
  /** `base64(AES-128-CBC(tempKey, info))` —— 进入签名载荷。 */
  readonly info: string
}

/**
 * 构建签名材料。
 *
 * `identity` 内嵌 access token，故**token 续期后必须重建**（否则 `info` 里的
 * `security_oauth_token` 是旧的，服务端校验身份时失败）。
 *
 * @param uid 账号 uid（`Cosy-User` 头与 `info.uid` 都用它）。
 * @param name 展示昵称（上游不校验具体值，只要求字段存在）。
 * @param email 邮箱。**传空串**：token 端点不返回 email，且实测网关不校验该字段
 *   （桌面端 `auth-v2.dat` 里的 email 本就是 `phone_xxx@phone.local` 占位形）。
 * @param accessToken 当前 access token。
 */
export function createCosySession(
  uid: string,
  name: string,
  email: string,
  accessToken: string,
): CosySession {
  const tempKey = cosyTempKey(16)
  const keyBytes = Buffer.from(tempKey, 'ascii')

  // 步骤 1: 用服务端公钥包裹临时密钥
  // ⚠️ 必须显式指定 RSA_PKCS1_PADDING —— Node 的默认是 OAEP，与上游不匹配。
  const wrapped = publicEncrypt(
    { key: serverPublicKey(), padding: 1 /* RSA_PKCS1_PADDING */ },
    keyBytes,
  )

  // 步骤 2: AES 加密身份信息
  // WHY aid 传空串：本渠道没有 aid 概念，上游不校验（Go 侧同样传 ""）。
  // ⚠️ 字段顺序对齐 Go 的 map 序列化结果（Go 对 map key 排序），
  //    虽然服务端按 key 取值、顺序无关，但对齐能减少排查时的干扰变量。
  const infoPlain = Buffer.from(JSON.stringify({
    aid: '',
    email,
    name,
    security_oauth_token: accessToken,
    uid,
  }), 'utf8')

  return {
    tempKey,
    cosyKey: wrapped.toString('base64'),
    info: cosyAesCbcEncrypt(infoPlain, keyBytes).toString('base64'),
  }
}

/**
 * 计算 `Authorization` 头与签名时间戳。
 *
 * @param session 签名材料。
 * @param body **最终字节**（JSON 字符串）。GET 请求传空串 `''`。
 *   ⚠️ 本函数之后调用方**不得**再修改 body，否则签名失配。
 * @param rawUrl 完整请求 URL（用于取 path 段）。
 * @param nowSeconds 签名时间戳（秒）。**默认取当前时间**；参数化的唯一目的是单测
 *   注入固定值。返回值里的 `date` 必须原样用于 `Cosy-Date` 头。
 * @returns `auth`（Authorization 值）与 `date`（Cosy-Date 值，**同源**）。
 */
export function cosyAuthHeader(
  session: CosySession,
  body: string,
  rawUrl: string,
  nowSeconds?: number,
): { auth: string; date: string } {
  // 步骤 1: 组装载荷
  const header: Record<string, string> = {
    version: 'v1',
    requestId: randomUUID(),
    info: session.info,
    cosyVersion: COSY_VERSION,
    ideVersion: COSY_IDE_VERSION,
  }
  const headerB64 = Buffer.from(JSON.stringify(header), 'utf8').toString('base64')

  // 步骤 2: 取 path 并去掉 `/algo` 前缀
  // WHY 去前缀：服务端重组签名串时用的 path 不含 `/algo` —— 这是实测得出的。
  // ⚠️ 用「前缀剥离」而非 replace：`/algo` 只应出现在开头，replace 会误伤
  //    path 中偶然出现的同名字段。
  const pathSig = new URL(rawUrl).pathname.replace(/^\/algo/, '')

  // 步骤 3: 时间戳 —— 必须与 Cosy-Date 同源（见文件头第 2 条坑）
  const date = String(nowSeconds ?? Math.floor(Date.now() / 1000))

  // 步骤 4: 拼签名串并算 MD5 小写 hex
  const sigInput = `${headerB64}\n${session.cosyKey}\n${date}\n${body}\n${pathSig}`
  const digest = createHash('md5').update(sigInput, 'utf8').digest('hex')

  return { auth: `Bearer COSY.${headerB64}.${digest}`, date }
}

/**
 * 按 Go 侧 `ApplyHeadersWithUID` 的语义填出完整头集。
 *
 * ⚠️ **实测强校验的只有四件套**：`Authorization` / `Cosy-Key` / `Cosy-User` /
 * `Cosy-Date`（Go 注释与头容差矩阵证实）。`Cosy-*` 业务头、版本头、UA 全部可省略。
 * 这里**只发这四件套 + 内容协商头**，不擅自添加业务头 —— 少传头可规避未来版本漂移。
 *
 * @param accept 内容协商：推理要 `text/event-stream`，模型列表要 `application/json`。
 *   Go 侧在模型列表处显式覆盖该值（`headers["Accept"] = "application/json"`）。
 */
export function cosyHeaders(
  session: CosySession,
  body: string,
  rawUrl: string,
  uid: string,
  accept: 'text/event-stream' | 'application/json',
  nowSeconds?: number,
): Record<string, string> {
  const { auth, date } = cosyAuthHeader(session, body, rawUrl, nowSeconds)
  return {
    Authorization: auth,
    'Cosy-Key': session.cosyKey,
    'Cosy-User': uid,
    'Cosy-Date': date,
    'Content-Type': 'application/json',
    Accept: accept,
  }
}
