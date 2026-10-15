/**
 * MonkeyCode「从本机官方客户端导入凭据」的**离线**回归。
 *
 * 直接 import `vendor/channel-pack/src/monkeycode-import.ts`（走
 * `stripTypeScriptTypes`，与 `anthropic-sse-test.mjs` / `gateway-source-test.mjs`
 * 同一范式），**只读写自己造的临时 fixture 目录**：
 *
 * - 不读真实用户目录（`%APPDATA%` / `~/Library/…`）—— 所有用例都把
 *   `configDir` 或注入的 `env` 指向 fixture，否则结果会随
 *   「开发机是否装了 MonkeyCode 客户端」而变，这是最典型的假绿/假红来源；
 * - 不打网络（本模块本身也没有任何网络调用）；
 * - 凭据一律是明显的假值（`oma_test` / `omas_test_secret`），不含任何真实凭据。
 *
 * 退出码 0 = 全过。
 *
 * ## 覆盖的判据（每条都对应 Go `internal/app/import_local.go` 的一个行为）
 *
 * 1. 正常导入：api_key / signing_secret / base_url 读出，host 与 path 正确拆分；
 * 2. uid 派生稳定（同一 api_key 两次导入同一个 uid）且公式逐字节对齐 Go；
 * 3. `models` 里多条 `monkeycode-` 条目时**按名排序取首条**（结果确定）；
 * 4. 只有非 `monkeycode-` 前缀条目时报错（文案指向「先登录客户端」）；
 * 5. 缺 `signing_secret` 时报错且文案**可行动**；
 * 6. 配置目录不存在时报错，并**列出已尝试的全部路径**；
 * 7. Cookie 存在时读到；不存在时**不报错**（note 说明降级）；
 * 8. `MONKEYCODE_CONFIG_DIR` 环境变量优先于其它候选。
 *
 * 另有若干「Go 边界行为」用例（host 拆分、非 Windows 候选集、过期 Cookie、
 * 解析失败、`note` 键的存在性），它们锁的是**移植时不直观**的口径，
 * 详见各用例注释。
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import os from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
      source: stripTypeScriptTypes(fs.readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform', sourceUrl: url }),
    }
    return nextLoad(url, context)
  },
})

const { importMonkeycodeLocalCredentials } = await import('../vendor/channel-pack/src/monkeycode-import.ts')

const failures = []
function check(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected)
    console.log(`ok   ${label}`)
  } catch (error) {
    failures.push(label)
    console.log(`FAIL ${label}`)
    console.log(`       ${error.message.split('\n').slice(0, 8).join('\n       ')}`)
  }
}

/** 断言导入**抛错**，且文案匹配（`matcher` 为正则或字符串数组，全部须命中）。 */
function checkRejects(label, run, matcher) {
  try {
    run()
    failures.push(label)
    console.log(`FAIL ${label} —— 期望抛错但没有抛`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const patterns = Array.isArray(matcher) ? matcher : [matcher]
    const missing = patterns.filter((p) => (p instanceof RegExp ? !p.test(message) : !message.includes(p)))
    if (missing.length === 0) console.log(`ok   ${label}`)
    else {
      failures.push(label)
      console.log(`FAIL ${label}`)
      console.log(`       文案缺少 ${missing.map(String).join(' / ')}：${message}`)
    }
  }
}

// ===== fixture =====

/** 临时根目录（用例结束后整体删除）。 */
const root = fs.mkdtempSync(join(os.tmpdir(), 'monkeycode-import-test-'))

/** 造一个 fixture 目录，写入给定文件。 */
function fixture(name, files) {
  const dir = join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(join(dir, file), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`, 'utf8')
  }
  return dir
}

/**
 * 完整可用的 `settings.json`。
 *
 * ⚠️ 两个 `monkeycode-` 条目的**插入顺序刻意与字母序相反**
 * （先 `ultra/zzz` 后 `basic/aaa`）：只有真的按名排序才会选出 `aaa`。
 * 第三条不带 `monkeycode-` 前缀，用来验证前缀过滤。
 */
const FULL_SETTINGS = {
  signing_secret: 'omas_test_secret',
  models: {
    'monkeycode-ultra/zzz@monkeycode#uuid-2': {
      api_key: 'oma_zzz_should_not_win',
      base_url: 'https://example.invalid/v9',
      type: 'anthropic',
      model: 'zzz',
    },
    'monkeycode-basic/aaa@monkeycode#uuid-1': {
      api_key: 'oma_test_first',
      base_url: 'https://proxy.monkeycode-ai.com/v1',
      type: 'anthropic',
      model: 'aaa',
    },
    'some-other-provider/plain@other#uuid-3': {
      api_key: 'oma_ignored',
      base_url: 'https://example.invalid/v1',
      type: 'anthropic',
      model: 'plain',
    },
  },
}

const CONSOLE_COOKIE = [
  { name: 'unrelated_cookie', value: 'ignored', expires: '2099-01-01T00:00:00Z' },
  { name: 'monkeycode_ai_session', value: 'console-session-value', expires: '2099-01-01T00:00:00Z' },
]
const BAIZHI_COOKIE = [
  { name: 'baizhi_session', value: 'baizhi-session-value', expires: '2099-01-01T00:00:00Z' },
]

// ===== 1 + 2 + 3：正常导入 / uid 稳定 / 按名排序取首条 =====

const fullDir = fixture('full', {
  'settings.json': FULL_SETTINGS,
  'monkeycode-cookies.json': CONSOLE_COOKIE,
  'baizhi-cookies.json': BAIZHI_COOKIE,
})

const first = importMonkeycodeLocalCredentials({ configDir: fullDir, env: {} })

check('正常导入：api_key 取自排序后的首条 monkeycode- 条目', first.apiKey, 'oma_test_first')
check('正常导入：signing_secret 取自顶层（与 api_key 是两把不同的密钥）', first.signingSecret, 'omas_test_secret')
check('正常导入：base_url 原样带回', first.baseUrl, 'https://proxy.monkeycode-ai.com/v1')
check('正常导入：apiHost 拆出（含协议）', first.apiHost, 'https://proxy.monkeycode-ai.com')
check('正常导入：apiPath 拆出', first.apiPath, '/v1')
check('正常导入：configPath 指向命中的 settings.json', first.configPath, join(fullDir, 'settings.json'))
check('正常导入：控制台 Cookie 读到', first.consoleCookie, 'console-session-value')
check('正常导入：百智云 Cookie 读到', first.baizhiCookie, 'baizhi-session-value')

// uid 公式独立复算（**不用被测实现**）：'mc_' + hex(sha256(apiKey))[:5 字节]
const expectedUid = `mc_${createHash('sha256').update(Buffer.from('oma_test_first', 'utf8')).digest().subarray(0, 5).toString('hex')}`
check('uid 派生：逐字节对齐 Go 的 mc_ + sha256 前 5 字节', first.uid, expectedUid)
check('uid 形状：mc_ + 10 位十六进制', /^mc_[0-9a-f]{10}$/.test(first.uid), true)

const second = importMonkeycodeLocalCredentials({ configDir: fullDir, env: {} })
check('uid 稳定：同一份配置两次导入 uid 相同', second.uid, first.uid)
check('正常导入：全绿时**没有** note 降级提示', Object.hasOwn(second, 'note'), false)

// 排序确定性：把条目**倒序**写一遍（同一组 key），仍应选中同一条
const reorderedDir = fixture('reordered', {
  'settings.json': {
    signing_secret: 'omas_test_secret',
    models: {
      'monkeycode-basic/aaa@monkeycode#uuid-1': { api_key: 'oma_test_first', base_url: 'https://proxy.monkeycode-ai.com/v1' },
      'monkeycode-ultra/zzz@monkeycode#uuid-2': { api_key: 'oma_zzz_should_not_win', base_url: 'https://example.invalid/v9' },
    },
  },
})
check(
  '按名排序取首条：换写入顺序仍选同一条（结果确定）',
  importMonkeycodeLocalCredentials({ configDir: reorderedDir, env: {} }).apiKey,
  'oma_test_first',
)

// ===== 4：只有非 monkeycode- 前缀条目 → 报错并提示先登录客户端 =====

const untaggedDir = fixture('untagged', {
  'settings.json': {
    signing_secret: 'omas_test_secret',
    models: { 'other-vendor/model#uuid': { api_key: 'oma_other', base_url: 'https://example.invalid/v1' } },
  },
})
checkRejects(
  '只有非 monkeycode- 条目：报错并请用户先在客户端登录',
  () => importMonkeycodeLocalCredentials({ configDir: untaggedDir, env: {} }),
  ['没有平台托管模型', '请先在 MonkeyCode 客户端登录', join(untaggedDir, 'settings.json')],
)

// `models` 缺省（没有该键）与空对象同义
const noModelsDir = fixture('no-models', { 'settings.json': { signing_secret: 'omas_test_secret' } })
checkRejects(
  'models 缺省：与「没有托管模型」同一条文案',
  () => importMonkeycodeLocalCredentials({ configDir: noModelsDir, env: {} }),
  '没有平台托管模型',
)

// ===== 5：缺 signing_secret → 可行动文案 =====

const noSecretDir = fixture('no-secret', {
  'settings.json': {
    models: { 'monkeycode-basic/aaa@monkeycode#uuid-1': { api_key: 'oma_test_first', base_url: 'https://proxy.monkeycode-ai.com/v1' } },
  },
})
checkRejects(
  '缺 signing_secret：报错指明字段并提示先在客户端登录',
  () => importMonkeycodeLocalCredentials({ configDir: noSecretDir, env: {} }),
  ['没有 signing_secret', join(noSecretDir, 'settings.json'), '请先在 MonkeyCode 客户端登录'],
)

// `signing_secret` 为空白串也算缺（Go 侧 strings.TrimSpace 后判空）
const blankSecretDir = fixture('blank-secret', {
  'settings.json': {
    signing_secret: '   ',
    models: { 'monkeycode-basic/aaa@monkeycode#uuid-1': { api_key: 'oma_test_first' } },
  },
})
checkRejects(
  'signing_secret 只有空白：同样判缺失',
  () => importMonkeycodeLocalCredentials({ configDir: blankSecretDir, env: {} }),
  '没有 signing_secret',
)

// 托管条目缺 api_key
const noKeyDir = fixture('no-key', {
  'settings.json': {
    signing_secret: 'omas_test_secret',
    models: { 'monkeycode-basic/aaa@monkeycode#uuid-1': { base_url: 'https://proxy.monkeycode-ai.com/v1' } },
  },
})
checkRejects(
  '托管条目没有 api_key：报错带文件路径',
  () => importMonkeycodeLocalCredentials({ configDir: noKeyDir, env: {} }),
  ['托管条目没有 api_key', join(noKeyDir, 'settings.json')],
)

// ===== 6：配置目录不存在 → 列出已尝试路径 =====

const missingDir = join(root, 'does-not-exist')
checkRejects(
  '配置目录不存在：报错并列出已尝试路径',
  () => importMonkeycodeLocalCredentials({ configDir: missingDir, env: {} }),
  ['未找到 MonkeyCode 客户端配置', '已尝试 1 个路径', join(missingDir, 'settings.json')],
)

// 多候选：注入假 APPDATA / LOCALAPPDATA / 家目录（**全部不存在**），
// 断言四条候选都被列出来 —— 这正是 Go 「已尝试 N 个路径」口径的完整版。
const fakeEnv = {
  APPDATA: join(root, 'fake-appdata'),
  LOCALAPPDATA: join(root, 'fake-local'),
  // 两个家目录变量给同一个值：实现按平台在其中二选一，结果都一样
  USERPROFILE: join(root, 'fake-home'),
  HOME: join(root, 'fake-home'),
}
const candidatesInError = [
  join(fakeEnv.APPDATA, 'com.chaitin.baizhi.monkeycode', 'ohmyagent', 'settings.json'),
  join(fakeEnv.LOCALAPPDATA, 'com.chaitin.baizhi.monkeycode', 'ohmyagent', 'settings.json'),
  join(fakeEnv.LOCALAPPDATA, 'MonkeyCode', 'ohmyagent', 'settings.json'),
  join(fakeEnv.HOME, 'Library', 'Application Support', 'com.chaitin.baizhi.monkeycode', 'ohmyagent', 'settings.json'),
]
checkRejects(
  '多候选全不命中：报错逐个列出已尝试的路径（APPDATA/LOCALAPPDATA×2/macOS）',
  () => importMonkeycodeLocalCredentials({ env: fakeEnv }),
  ['未找到 MonkeyCode 客户端配置', '已尝试 4 个路径', ...candidatesInError],
)

// 非 Windows 口径（issue #75）：**不做平台门禁**，没有 Win 环境变量时
// 仍按 macOS 标准目录尽力探测，找不到给明确报错而不是直接拒绝。
checkRejects(
  '非 Windows 口径：无 Win 环境变量时仍探测 macOS 路径并明确报错',
  () => importMonkeycodeLocalCredentials({ env: { HOME: join(root, 'fake-home-only') } }),
  ['未找到 MonkeyCode 客户端配置', join(root, 'fake-home-only', 'Library', 'Application Support', 'com.chaitin.baizhi.monkeycode', 'ohmyagent', 'settings.json')],
)

// ===== 7：Cookie 尽力而为 =====

// 只给 settings.json：Cookie 缺失必须**不影响导入本身**，只体现在 note
const noCookieDir = fixture('no-cookie', { 'settings.json': FULL_SETTINGS })
const noCookie = importMonkeycodeLocalCredentials({ configDir: noCookieDir, env: {} })
check('Cookie 缺失：导入照常成功（api_key 仍读出）', noCookie.apiKey, 'oma_test_first')
check('Cookie 缺失：consoleCookie 为 undefined', noCookie.consoleCookie, undefined)
check('Cookie 缺失：baizhiCookie 为 undefined', noCookie.baizhiCookie, undefined)
check('Cookie 缺失：note 说明控制台会话降级', noCookie.note?.includes('未取到控制台会话（文件缺失）'), true)
check('Cookie 缺失：note 说明百智云会话降级', noCookie.note?.includes('未取到百智云会话（文件缺失）'), true)

// 只有一支 Cookie：另一支独立降级，不互相影响
const oneCookieDir = fixture('one-cookie', {
  'settings.json': FULL_SETTINGS,
  'baizhi-cookies.json': BAIZHI_COOKIE,
})
const oneCookie = importMonkeycodeLocalCredentials({ configDir: oneCookieDir, env: {} })
check('只有百智云 Cookie：该支读到', oneCookie.baizhiCookie, 'baizhi-session-value')
check('只有百智云 Cookie：控制台支仍为 undefined', oneCookie.consoleCookie, undefined)
check(
  '只有百智云 Cookie：note **只**含控制台那一句（不过度报告）',
  oneCookie.note,
  '未取到控制台会话（文件缺失），积分暂不可用（不影响对话）。',
)

// 过期 Cookie（Go：先判过期，过期即降级并给出「已过期」）
const expiredDir = fixture('expired-cookie', {
  'settings.json': FULL_SETTINGS,
  'monkeycode-cookies.json': [{ name: 'monkeycode_ai_session', value: 'stale', expires: '2000-01-01T00:00:00Z' }],
  'baizhi-cookies.json': [{ name: 'baizhi_session', value: 'alive', expires: '2099-01-01T00:00:00Z' }],
})
const expired = importMonkeycodeLocalCredentials({ configDir: expiredDir, env: {} })
check('过期 Cookie：不返回该值', expired.consoleCookie, undefined)
check('过期 Cookie：note 写明「已过期」', expired.note?.includes('未取到控制台会话（已过期）'), true)
check('过期 Cookie：不影响另一支', expired.baizhiCookie, 'alive')

// Cookie 文件里没有该名字
const wrongNameDir = fixture('cookie-wrong-name', {
  'settings.json': FULL_SETTINGS,
  'monkeycode-cookies.json': [{ name: 'someone_else', value: 'nope' }],
})
check(
  'Cookie 名不匹配：note 点名缺失的 Cookie',
  importMonkeycodeLocalCredentials({ configDir: wrongNameDir, env: {} }).note?.includes('文件里没有 monkeycode_ai_session'),
  true,
)

// Cookie 文件不是合法 JSON：降级为「解析失败」，仍不报错
const badCookieDir = fixture('cookie-bad-json', {
  'settings.json': FULL_SETTINGS,
  'monkeycode-cookies.json': '{ not json',
})
check(
  'Cookie 文件损坏：降级为「解析失败」且导入照常',
  importMonkeycodeLocalCredentials({ configDir: badCookieDir, env: {} }).note?.includes('未取到控制台会话（解析失败）'),
  true,
)

// ===== 8：MONKEYCODE_CONFIG_DIR 优先 =====

// env 目录已有完整 fixture、APPDATA 指向另一份 api_key 不同的完整 fixture：
// 必须命中 env 那份，证明**环境变量候选排在 APPDATA 之前**。
const envDir = fixture('env-dir', {
  'settings.json': {
    signing_secret: 'omas_from_env',
    models: { 'monkeycode-basic/aaa@monkeycode#uuid-env': { api_key: 'oma_from_env', base_url: 'https://env.example.com/v1' } },
  },
})
// APPDATA 下再造一份完整 fixture（api_key 与 env 那份不同），用于对照。
const appDataRoot = join(root, 'fake-appdata')
fs.mkdirSync(join(appDataRoot, 'com.chaitin.baizhi.monkeycode', 'ohmyagent'), { recursive: true })
fs.writeFileSync(
  join(appDataRoot, 'com.chaitin.baizhi.monkeycode', 'ohmyagent', 'settings.json'),
  JSON.stringify(FULL_SETTINGS, null, 2),
  'utf8',
)

const fromEnv = importMonkeycodeLocalCredentials({ env: { MONKEYCODE_CONFIG_DIR: envDir, APPDATA: appDataRoot } })
check('MONKEYCODE_CONFIG_DIR 优先：取 env 目录那份 api_key', fromEnv.apiKey, 'oma_from_env')
check('MONKEYCODE_CONFIG_DIR 优先：configPath 指向 env 目录', fromEnv.configPath, join(envDir, 'settings.json'))
check('MONKEYCODE_CONFIG_DIR 优先：signing_secret 同源', fromEnv.signingSecret, 'omas_from_env')

// 同一套候选下，**没有** env 覆盖时必须命中 APPDATA 那份（证明上一条不是巧合）
const fromAppData = importMonkeycodeLocalCredentials({ env: { APPDATA: appDataRoot } })
check('无 env 覆盖时命中 APPDATA 候选（对照）', fromAppData.apiKey, 'oma_test_first')
check('无 env 覆盖时 configPath 落在 APPDATA 候选上', fromAppData.configPath, join(appDataRoot, 'com.chaitin.baizhi.monkeycode', 'ohmyagent', 'settings.json'))

// ===== 真实 Windows 目录布局（最贴近生产的一次演练）=====
//
// 客户端实际落盘是**两级不同的目录**（Go 注释记载的实测事实）：
//   settings.json        → %APPDATA%\<bundle>\ohmyagent\settings.json
//   *-cookies.json       → %APPDATA%\<bundle>\*.json          ← 与 settings 不同级
// 只在 env 里给 APPDATA、不碰 configDir：走的正是生产那条候选路径。
const realAppData = join(root, 'real-appdata')
const realBundle = join(realAppData, 'com.chaitin.baizhi.monkeycode')
fs.mkdirSync(join(realBundle, 'ohmyagent'), { recursive: true })
fs.writeFileSync(join(realBundle, 'ohmyagent', 'settings.json'), JSON.stringify(FULL_SETTINGS, null, 2), 'utf8')
fs.writeFileSync(join(realBundle, 'monkeycode-cookies.json'), JSON.stringify(CONSOLE_COOKIE, null, 2), 'utf8')
fs.writeFileSync(join(realBundle, 'baizhi-cookies.json'), JSON.stringify(BAIZHI_COOKIE, null, 2), 'utf8')

const real = importMonkeycodeLocalCredentials({ env: { APPDATA: realAppData } })
check('真实布局：settings.json 从 <bundle>/ohmyagent 读到', real.apiKey, 'oma_test_first')
check('真实布局：configPath 是 ohmyagent 子目录那份', real.configPath, join(realBundle, 'ohmyagent', 'settings.json'))
check('真实布局：Cookie 从 bundle **根目录**读到（与 settings 不同级）', real.consoleCookie, 'console-session-value')
check('真实布局：百智云 Cookie 同样从根目录读到', real.baizhiCookie, 'baizhi-session-value')
check('真实布局：全绿无降级提示', Object.hasOwn(real, 'note'), false)

// ===== Go 边界行为（移植时不直观，单独锁住）=====

// splitBaseURL：只有主机没有路径 → path 取 '/v1'（Go 的 `https://host` 分支）
const hostOnlyDir = fixture('host-only', {
  'settings.json': {
    signing_secret: 'omas_test_secret',
    models: { 'monkeycode-basic/aaa@monkeycode#uuid-1': { api_key: 'oma_test_first', base_url: 'https://only-host.example' } },
  },
})
const hostOnly = importMonkeycodeLocalCredentials({ configDir: hostOnlyDir, env: {} })
check('base_url 无路径：host 原样', hostOnly.apiHost, 'https://only-host.example')
check('base_url 无路径：path 回落 /v1', hostOnly.apiPath, '/v1')

// splitBaseURL：尾斜杠被去掉（`https://host/v1/` → path '/v1'）
const trailingDir = fixture('trailing-slash', {
  'settings.json': {
    signing_secret: 'omas_test_secret',
    models: { 'monkeycode-basic/aaa@monkeycode#uuid-1': { api_key: 'oma_test_first', base_url: 'https://host.example/v1/' } },
  },
})
const trailing = importMonkeycodeLocalCredentials({ configDir: trailingDir, env: {} })
check('base_url 尾斜杠：去尾斜杠后拆分', [trailing.baseUrl, trailing.apiHost, trailing.apiPath], ['https://host.example/v1', 'https://host.example', '/v1'])

// splitBaseURL：base_url 缺失 → 回落内置默认端点（**baseUrl 也一并回落**，
// 否则返回的 baseUrl 空串会与 host/path 自相矛盾）
const noBaseDir = fixture('no-base-url', {
  'settings.json': {
    signing_secret: 'omas_test_secret',
    models: { 'monkeycode-basic/aaa@monkeycode#uuid-1': { api_key: 'oma_test_first' } },
  },
})
const noBase = importMonkeycodeLocalCredentials({ configDir: noBaseDir, env: {} })
check('base_url 缺失：baseUrl/host/path 一并回落默认端点', [noBase.baseUrl, noBase.apiHost, noBase.apiPath], ['https://proxy.monkeycode-ai.com/v1', 'https://proxy.monkeycode-ai.com', '/v1'])

// JSON 损坏 → 「解析客户端配置失败」带路径（与「找不到」区分开，便于用户排查）
const brokenDir = fixture('broken-json', { 'settings.json': '{ "signing_secret": ' })
checkRejects(
  'settings.json 损坏：报「解析失败」并带文件路径',
  () => importMonkeycodeLocalCredentials({ configDir: brokenDir, env: {} }),
  ['解析客户端配置失败', join(brokenDir, 'settings.json')],
)

// models 是**数组**而非对象 → 解析失败（对齐 Go 的强类型 json.Unmarshal，
// 若静默当成「没有条目」，用户会拿到「请先登录客户端」这种指错方向的提示）
const arrayModelsDir = fixture('array-models', {
  'settings.json': { signing_secret: 'omas_test_secret', models: [{ api_key: 'oma_test_first' }] },
})
checkRejects(
  'models 是数组：判「解析失败」而不是「没登录」',
  () => importMonkeycodeLocalCredentials({ configDir: arrayModelsDir, env: {} }),
  ['解析客户端配置失败', 'models 不是 JSON 对象'],
)

// JSON 里的 null 按 Go 语义视作零值（**不算类型错误**），落到「缺字段」分支
const nullSecretDir = fixture('null-secret', {
  'settings.json': {
    signing_secret: null,
    models: { 'monkeycode-basic/aaa@monkeycode#uuid-1': { api_key: 'oma_test_first' } },
  },
})
checkRejects(
  'signing_secret 为 null：按 Go 语义当零值 → 「没有 signing_secret」',
  () => importMonkeycodeLocalCredentials({ configDir: nullSecretDir, env: {} }),
  '没有 signing_secret',
)

// 无副作用：连续两次导入同一 fixture，结果一致（不被内部缓存/写盘污染）
check(
  '无副作用：重复导入结果一致',
  JSON.stringify(importMonkeycodeLocalCredentials({ configDir: fullDir, env: {} })),
  JSON.stringify(importMonkeycodeLocalCredentials({ configDir: fullDir, env: {} })),
)

// ===== 收尾 =====

try {
  fs.rmSync(root, { recursive: true, force: true })
} catch {
  // 清理失败不影响判定
}

if (failures.length > 0) {
  console.log(`\n${failures.length} 项失败：`)
  for (const label of failures) console.log(`  - ${label}`)
  process.exitCode = 1
} else {
  console.log('\n全部通过（MonkeyCode 客户端凭据导入）')
}
