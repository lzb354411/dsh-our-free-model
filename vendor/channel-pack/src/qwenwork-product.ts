/**
 * 千问办公（QwenWork）产品配置。
 *
 * ## 为什么新建 `QwenworkProduct` 而不复用既有类型
 *
 * 与 `raccoon-product.ts` / `minimax-product.ts` 同理：`BuddyProduct` /
 * `QoderProduct` / `RaccoonProduct` 的字段全部围绕各自协议设计（归属头、
 * WASM 签名参数、手机号加密密钥…），对千问办公无一有意义。本渠道需要的是一组
 * **双域**基址、COSY 协议常量、以及一张带倍率的兜底模型表。
 * 共用的是架构**模式**（产品差异收敛到单一真相源），不是那个类型。
 *
 * ## 数据来源
 *
 * Go 侧 `internal/qwenwork/constants.go` 与 `cosy.go`（同一套实测结论）。
 */

import { QWENWORK_FALLBACK_MODELS, type QwenworkFallbackModel } from './qwenwork.js'

/**
 * 千问办公产品配置。
 *
 * ⚠️ **双域结构是本渠道的核心特征**：COSY 域管推理与模型列表，Bearer 域管余额与费率。
 * 二者凭据相同但鉴权方式不同，混用必失败（COSY 打网页域 401）。
 */
export interface QwenworkProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'qwenwork'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /** 推理网关（**COSY 签名域**）。 */
  gatewayBase: string
  /** 网页域（**Bearer 域**：余额/费率/账单）。 */
  webBase: string
  /** OAuth 授权基址（与网页域同源）。 */
  oauthBase: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /** 远端模型目录不可用时的兜底目录。 */
  fallbackModels: readonly QwenworkFallbackModel[]
}

/** 兜底模型目录（3 个档位）。 */
export const QWENWORK_FALLBACK: readonly QwenworkFallbackModel[] = QWENWORK_FALLBACK_MODELS

/** 千问办公 provider 配置。 */
export const QWENWORK: QwenworkProduct = {
  id: 'qwenwork',
  displayName: '千问办公 (阿里)',
  gatewayBase: 'https://gateway.qwenwork.cn',
  webBase: 'https://qwenwork.cn',
  oauthBase: 'https://qwenwork.cn',
  defaultCredentialRef: 'QWENWORK_ACCESS_TOKEN',
  fallbackModels: QWENWORK_FALLBACK,
}

/** 全部千问办公产品配置（当前只有一个，保留数组以便将来扩展）。 */
export const ALL_QWENWORK_PRODUCTS: readonly QwenworkProduct[] = [QWENWORK]

/**
 * 按 provider id 取产品配置；未知 id 返回 `undefined`。
 *
 * 与 `raccoonProductById` / `minimaxProductById` 分开：各自返回**不同类型**，
 * 合并会让调用方拿到联合类型后再也不得不做类型收窄。
 */
export function qwenworkProductById(id: string): QwenworkProduct | undefined {
  return ALL_QWENWORK_PRODUCTS.find((product) => product.id === id)
}
