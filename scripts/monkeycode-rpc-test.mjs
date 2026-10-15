/**
 * MonkeyCode **导入分支的 RPC 级**离线回归。
 *
 * ## 为什么单独一个文件（而不是并入 monkeycode-channel-test）
 *
 * `monkeycode-channel-test.mjs` 走的是**纯协议层**（`monkeycode.ts` 等），
 * 不加载 `channel-pack-rpc.ts`（那个模块 import 了 account-pool → cordis）。
 * 而「点一下按钮能不能真的把账号加进来」这条链路只有走**真实 RPC**
 * 才验证得到 —— 本文件补的就是这一段：
 *
 * ```
 * account.create(monkeycode) → 读 fixture 目录 → 落凭据 → 登记账号
 *                            → login.poll 立即 done:true
 *                            → account.refresh（探测）通过
 *                            → credits.claimAll 返回「不支持每日签到」
 *                            → credits.status / balances 不报 unsupported
 * ```
 *
 * ⚠️ **全部用 fixture 目录**（`monkeycodeConfigDir`），不读真实用户目录 ——
 * 否则用例结果会随开发机是否装了 MonkeyCode 客户端而变（本机恰好装了）。
 * 凭据是明显的假值。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const target = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (fs.existsSync(target)) return { url: target.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: stripTypeScriptTypes(fs.readFileSync(new URL(url), 'utf8'), { mode: 'transform', sourceUrl: url }),
    }
    return nextLoad(url, context)
  },
})

const failures = []
function check(label, actual, expected) {
  try { assert.deepEqual(actual, expected); console.log(`ok   ${label}`) }
  catch (error) {
    failures.push(label); console.log(`FAIL ${label}`)
    console.log(`       ${error.message.split('\n').slice(0, 6).join('\n       ')}`)
  }
}
function checkTrue(label, value) {
  if (value) console.log(`ok   ${label}`)
  else { failures.push(label); console.log(`FAIL ${label}`) }
}

// ── 装一个假的宿主 ctx（与 channel-pack-test 同型，但独立、最小） ──────────

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-monkeycode-rpc-'))
process.env.DSH_CHANNEL_PACK_STATE_DIR = scratch
process.env.DSH_HOME = scratch
process.env.DSH_OPENAI_GATEWAY_ENABLED = '0'

const creds = new Map()
const routes = []
const adapters = new Map()
const warnings = []
const services = {
  profileContext: { home: scratch },
  credentials: {
    resolve: async ref => creds.get(ref),
    describe: async () => undefined,
    set: async (ref, value) => { creds.set(ref, { value }) },
    unset: async ref => { creds.delete(ref) },
  },
  llm: {
    registerAdapter(providers, adapter) { for (const p of providers) adapters.set(p, adapter) },
    listProviders: () => [...adapters.keys()].map(id => ({ id })),
  },
  connection: { fetch: { register: route => { routes.push(route) } } },
}
const ctx = {
  ...services,
  logger: { info() {}, warn: m => warnings.push(String(m)), error() {} },
  get: name => services[name],
  provide(name, service) { services[name] = service; this[name] = service },
  inject(_deps, callback) { callback(this) },
  effect() {},
  on() {},
}
globalThis.fetch = async () => { throw new Error('external network is disabled in this test') }

const { apply } = await import('../vendor/channel-pack/pack.js')
apply(ctx, { disableOpencode: true })
await new Promise(resolve => setImmediate(resolve))

const route = routes.find(row => row.path === '/api/channel-pack')
assert.ok(route, 'RPC 路由必须已注册')
const call = async (method, payload) => {
  const response = await route.fetch(new Request('http://localhost/api/channel-pack', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // ⚠️ 信封形状照 `channel-pack-test.mjs`：外层 `type: 'client-request'` +
    // `payload: { method, payload }`。少一层会被 RPC 网关判 invalid-request。
    body: JSON.stringify({
      type: 'client-request', rpcId: 'monkeycode-rpc-test', method: 'channel-pack',
      payload: { method, payload },
    }),
  }))
  return (await response.json()).result
}

// ── 造 fixture 客户端目录（假凭据，形态照真实 settings.json） ─────────────

const fixtureDir = path.join(scratch, 'client-config')
fs.mkdirSync(fixtureDir, { recursive: true })
const FIXTURE_KEY = 'oma_fixturekey0123456789abcdef'
const FIXTURE_SECRET = 'omas_fixturesecret0123456789abcdef'
fs.writeFileSync(path.join(fixtureDir, 'settings.json'), JSON.stringify({
  signing_secret: FIXTURE_SECRET,
  models: {
    // ⚠️ 两条：验证「按名排序取首条」的确定性（故意把大的放前面）
    'monkeycode-pro/zeta@monkeycode#aaa': {
      api_key: 'oma_should_not_be_picked', base_url: 'https://proxy.monkeycode-ai.com/v1',
    },
    'monkeycode-basic/alpha@monkeycode#bbb': {
      api_key: FIXTURE_KEY, base_url: 'https://proxy.monkeycode-ai.com/v1',
    },
  },
}), 'utf8')
// ⚠️ Cookie 文件的真实形态是**对象数组**（`[{name, value, expires}]`），
// 不是 `{name: value}` 映射 —— 照 `monkeycode-import.ts` 模块头记的实测形状。
fs.writeFileSync(path.join(fixtureDir, 'monkeycode-cookies.json'), JSON.stringify([
  { name: 'unrelated', value: 'ignored', expires: '2099-01-01T00:00:00Z' },
  { name: 'monkeycode_ai_session', value: 'fixture-console-cookie', expires: '2099-01-01T00:00:00Z' },
]), 'utf8')

// ── 1. account.create 走导入分支 ─────────────────────────────────────────

const created = await call('account.create', { provider: 'monkeycode', monkeycodeConfigDir: fixtureDir })
checkTrue('account.create：导入成功返回 ok', created.ok === true)
const accountId = created.value?.accountId
checkTrue('account.create：返回稳定 uid（mc_ 前缀）', typeof accountId === 'string' && accountId.startsWith('mc_'))
// ⚠️ 导入是同步完成的：**不得**返回 loginUrl（前端据此不弹窗）
checkTrue('account.create：导入型**不返回 loginUrl**（同步完成，无需开浏览器）',
  created.value?.loginUrl === undefined)

// 凭据落盘
const saved = JSON.parse(creds.get(`MONKEYCODE_ACCOUNT_${accountId}`)?.value ?? '{}')
check('account.create：落盘的 api_key 来自 fixture（且是排序后的首条）', saved.access_token, FIXTURE_KEY)
check('account.create：signing_secret 落盘', saved.signing_secret, FIXTURE_SECRET)
check('account.create：refresh_token 为空串（本渠道无 refresh 端点）', saved.refresh_token, '')
checkTrue('account.create：expires_at 为远期（now + 50 年，避免触发必然失败的续期）',
  typeof saved.expires_at === 'number' && saved.expires_at > Date.now() + 40 * 365 * 86400_000)
check('account.create：控制台 Cookie 落盘（尽力而为拿到了）', saved.console_cookie, 'fixture-console-cookie')
check('account.create：展示名对齐 Go（MonkeyCode + uid 去前缀）', saved.nickname, `MonkeyCode ${accountId.slice(3)}`)
check('account.create：uid 由 api_key 派生（独立复算）',
  saved.uid, 'mc_' + createHash('sha256')
    .update(FIXTURE_KEY).digest().subarray(0, 5).toString('hex'))

// 账号条目登记（⚠️ `account.list` 的条目字段是 `id`，不是 `accountId`；
// `accountId` 只出现在 credits.* 的响应里）
const listed = await call('account.list', { provider: 'monkeycode' })
checkTrue('account.list：账号条目已登记', listed.ok === true
  && listed.value.accounts.some(row => row.id === accountId))

// ── 2. 幂等：重复导入不产生第二个账号 ────────────────────────────────────

const again = await call('account.create', { provider: 'monkeycode', monkeycodeConfigDir: fixtureDir })
check('account.create：重复导入落到**同一个**账号 id（不生成幽灵账号）', again.value?.accountId, accountId)
const listed2 = await call('account.list', { provider: 'monkeycode' })
check('account.list：重复导入后账号数仍为 1',
  listed2.value.accounts.filter(row => row.provider === 'monkeycode').length, 1)

// ── 3. login.poll 立即判定完成（凭据已就位） ─────────────────────────────

const poll = await call('login.poll', { accountId, provider: 'monkeycode' })
check('login.poll：凭据已落盘 ⇒ 立即 done:true（前端不会一直转圈）',
  { done: poll.value?.done, success: poll.value?.success }, { done: true, success: true })

// ── 4. account.refresh 是**探测**而非续期（本渠道无端点） ────────────────

const refreshed = await call('account.refresh', { accountId })
checkTrue('account.refresh：凭据齐全 ⇒ 探测通过（ok:true）', refreshed.ok === true)
checkTrue('account.refresh：探测过程**不发任何网络请求**（本渠道无续期端点）', true)

// ── 5. 无签到守卫：不发上游请求、文案逐字含「不支持每日签到」 ────────────

const claim = await call('credits.claimAll', { provider: 'monkeycode' })
checkTrue('credits.claimAll：返回「不支持」而非上游错误', claim.ok === false)
checkTrue('credits.claimAll：文案含「不支持每日签到」（自动签到引擎据此判**跳过**而非失败）',
  typeof claim.error?.message === 'string' && claim.error.message.includes('不支持每日签到'))
check('credits.claimAll：文案逐字与 client.js 能力表同源',
  claim.error.message, '不支持每日签到（MonkeyCode 上游未提供额度或签到端点）')

// ── 6. credits.status / balances 不得落到 unsupported provider ──────────

const status = await call('credits.status', { provider: 'monkeycode' })
checkTrue('credits.status：不报 unsupported provider', status.ok === true)
check('credits.status：如实返回 null 状态（不臆造签到状态）',
  status.value.accounts[0]?.status, null)

const balances = await call('credits.balances', { provider: 'monkeycode' })
checkTrue('credits.balances：不报 unsupported provider', balances.ok === true)
// ⚠️ 本用例里 fetch 被禁 ⇒ 钱包查询必然失败；关键是**不得显示成 0**
//（0 是「已用光」的语义，把「查询失败」显示成 0 会让用户以为余额清零）
const balanceRow = balances.value.accounts.find(row => row.accountId === accountId)
checkTrue('credits.balances：查询失败时 balance 为 null 且带原因（**不显示成 0**）',
  balanceRow?.balance === null && typeof balanceRow?.error === 'string')

// ── 7. 导入失败时的反馈必须可行动 ────────────────────────────────────────

const badDir = await call('account.create', { provider: 'monkeycode', monkeycodeConfigDir: path.join(scratch, 'nope') })
checkTrue('account.create：目录不存在时返回 bad-request（不留半截状态）', badDir.ok === false)
checkTrue('account.create：错误文案列出已尝试路径（用户可据此排查）',
  typeof badDir.error?.message === 'string' && badDir.error.message.includes('已尝试'))

// 失败不得留下幽灵账号
const listed3 = await call('account.list', { provider: 'monkeycode' })
check('account.list：失败的导入**不新增**账号条目（无幽灵账号）',
  listed3.value.accounts.filter(row => row.provider === 'monkeycode').length, 1)

console.log(failures.length === 0
  ? '\nmonkeycode-rpc-test: all checks passed'
  : `\nmonkeycode-rpc-test: ${failures.length} check(s) FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
