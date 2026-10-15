/**
 * MonkeyCode 产品配置。
 *
 * ## 为什么新建 `MonkeycodeProduct` 而不复用既有类型
 *
 * 与 `qwenwork-product.ts` / `minimax-product.ts` 同理：`BuddyProduct` /
 * `QoderProduct` / `RaccoonProduct` 的字段全部围绕各自协议设计（归属头、
 * WASM 签名参数、手机号加密密钥…），对 MonkeyCode 无一有意义。本渠道需要的
 * 是**三个域的基址** + 一张静态模型表 + 导入路径声明。
 * 共用的是架构**模式**（产品差异收敛到单一真相源），不是那个类型。
 *
 * ## 数据来源
 *
 * Go 侧 `internal/monkeycode/constants.go`（同一套实测结论）。
 */

import {
  MONKEYCODE_BAIZHI_BASE,
  MONKEYCODE_CONSOLE_BASE,
  MONKEYCODE_DEFAULT_BASE,
  MONKEYCODE_STATIC_MODELS,
} from './monkeycode.js'

/** 兜底模型目录中的一个条目。 */
export interface MonkeycodeModelEntry {
  /** 对外模型 ID（`monkeycode/basic/x`）。 */
  id: string
  /** 展示名（静态表无名字，按档位生成；3 个中文名模型用映射覆盖）。 */
  name: string
  /**
   * 上下文窗口。
   *
   * ⚠️ 上游**没有目录接口**（`GET /models` 返回 405），故拿不到真实窗口，
   * 这里**不编造**：留 `undefined` 让 DSH 用默认值。
   * 把「未知」填成任何具体数字都是编造（与仓库对思考档位的一贯口径一致）。
   */
  contextWindow?: number
  /** 单次输出上限。同样无上游来源，留 `undefined`。 */
  maxTokens?: number
  /** 是否支持图片输入。上游无声明 ⇒ `false`（不猜测）。 */
  supportsImage: boolean
}

/** MonkeyCode 产品配置。 */
export interface MonkeycodeProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'monkeycode'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /**
   * 推理端点基址（**agent 域**）。
   *
   * ⚠️ 可被客户端 `base_url` 覆盖（导入时以客户端值为准，对齐 Go
   * `importDefaultBase` 的注释：常量只作缺省与静态兜底）。
   */
  inferBase: string
  /** 控制台基址（**Cookie 域**：钱包/额度）。 */
  consoleBase: string
  /** 百智云基址（**身份提供方**：派生控制台会话）。 */
  baizhiBase: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /** 静态模型表（上游无目录接口，这是唯一来源）。 */
  models: readonly MonkeycodeModelEntry[]
}

/** 静态模型表 → 产品条目（展示名按档位生成）。 */
function staticEntries(): readonly MonkeycodeModelEntry[] {
  return MONKEYCODE_STATIC_MODELS.map((bare) => ({
    // 对外 ID 一律带渠道前缀，与 `/v1/models` 的 buildModelEntry 口径一致。
    id: `monkeycode/${bare}`,
    name: bare,
    // ⚠️ 不填 contextWindow / maxTokens / supportsImage：上游没有这些声明，
    // 编造会让 DSH 的压缩时机与图片投影基于假数据。
    supportsImage: false,
  }))
}

/** MonkeyCode provider 配置。 */
export const MONKEYCODE: MonkeycodeProduct = {
  id: 'monkeycode',
  displayName: 'MonkeyCode (百智云)',
  inferBase: MONKEYCODE_DEFAULT_BASE,
  consoleBase: MONKEYCODE_CONSOLE_BASE,
  baizhiBase: MONKEYCODE_BAIZHI_BASE,
  defaultCredentialRef: 'MONKEYCODE_ACCESS_TOKEN',
  models: staticEntries(),
}

/** 全部 MonkeyCode 产品配置（当前只有一个，保留数组以便将来扩展）。 */
export const ALL_MONKEYCODE_PRODUCTS: readonly MonkeycodeProduct[] = [MONKEYCODE]

/** 按 provider id 取产品配置；未知 id 返回 `undefined`。 */
export function monkeycodeProductById(id: string): MonkeycodeProduct | undefined {
  return ALL_MONKEYCODE_PRODUCTS.find((product) => product.id === id)
}

// ===== 端点路径 =====

/** Anthropic Messages 面（21 个模型）。 */
export const MONKEYCODE_MESSAGES_PATH = '/messages'
/** OpenAI Responses 面（4 个模型）。 */
export const MONKEYCODE_RESPONSES_PATH = '/responses'

/** 请求超时（毫秒）：上游是流式长响应，对齐 Go 的 10 分钟。 */
export const MONKEYCODE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000
