// Minimal host contracts for the generated channel pack's offline mount test.
// Provider implementation, pool persistence and RPC handlers remain real.
export class Service {
  constructor(ctx, name) { this.ctx = ctx; ctx.provide(name, this) }
}
export class LlmAdapter {}
/**
 * ⚠️ 参数顺序**必须**与真实 `@deepseek-ai/dsh-llm` 一致：`(message, code, options)`。
 *
 * 本桩早期写成 `(code, message)`（顺序相反），于是所有走本桩的离线测试里
 * `error.code` 实际拿到的是**人类可读消息**、`error.message` 拿到的是**机器码** ——
 * 而全仓有 167 处 `new LlmError('…中文说明…', 'PERMISSION_DENIED', {status})`
 * 这种「消息在前」的调用，在错桩下 `code` 全都不是真码。
 *
 * 该缺陷由 `scripts/monkeycode-channel-test.mjs` 的「403 不得取 AUTH」断言暴露
 * （它断言 `error.code`，在错桩下拿到的是消息文本）。真实宿主定义见
 * `dsh-llm/lib/types/index.js` 的 `class LlmError`。
 */
export class LlmError extends Error {
  constructor(message, code, options) {
    super(typeof message === 'string' ? message : String(code))
    this.name = 'LlmError'
    this.code = typeof code === 'string' ? code : undefined
    if (options !== undefined) this.failure = options
  }
}
export const credentialRef = value => value
export const ReasoningEffortId = value => value
export const ToolCallId = value => value
export const createUserMessage = value => value
export const attributionHeaders = () => ({})
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'
export const QUOTA_EXCEEDED_CODE = 'QUOTA_EXCEEDED'
export const isContextWindowExceededError = error => error?.code === CONTEXT_WINDOW_EXCEEDED_CODE
export const isQuotaExceededError = error => error?.code === QUOTA_EXCEEDED_CODE
const schema = new Proxy(() => schema, { get: () => schema })
export default schema
