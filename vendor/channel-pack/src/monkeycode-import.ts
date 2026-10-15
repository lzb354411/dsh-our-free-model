/**
 * MonkeyCode「从本机官方客户端导入凭据」—— 本插件里**第一个导入型渠道**。
 *
 * ## 为什么需要它（渠道形态决定的，不是实现偷懒）
 *
 * MonkeyCode **没有浏览器登录接口**，也没有 OAuth / 设备码可走：
 * 凭据只能从本机已安装的官方客户端 `ohmyagent`
 * （bundle id `com.chaitin.baizhi.monkeycode`）落盘的配置里读出来 ——
 * 一对 `oma_` 开头的 api_key ＋ `omas_` 开头的 signing_secret。
 * 其余渠道（buddy / trae / qoder / glm / raccoon / loomy …）都是
 * 浏览器 OAuth、扫码或设备码，本渠道**必须**换一种取凭据的方式。
 *
 * ## 本模块只做「读出来 + 派生 + 返回」
 *
 * **不做**凭据落盘（那是调用方 `channel-pack-rpc.ts` 的事）、
 * **不做**网络请求、**不做**凭据前缀校验（Go 侧也只校验非空，见下）、
 * 不写任何文件 —— 除 `readFileSync` 外无副作用。
 * 这样它可以在离线测试里被反复调用，也便于 RPC 层决定落盘格式。
 *
 * ## 客户端落盘实测事实（从 Go 侧移植，勿凭猜改写）
 *
 * `settings.json` 结构（**2026-09-23 实测**）：
 *
 * ```json
 * {
 *   "signing_secret": "omas_…",            // 顶层字段，与 api_key 是**两把不同的密钥**
 *   "models": {                            // ⚠️ 对象而非数组
 *     "monkeycode-basic/deepseek-flash@monkeycode#<uuid>": {
 *       "api_key": "oma_…", "base_url": "https://proxy.monkeycode-ai.com/v1",
 *       "type": "anthropic", "model": "…"
 *     }, …
 *   }
 * }
 * ```
 *
 * Cookie 文件结构（**2026-09-24 实测**）：
 *
 * ```json
 * [{"name":"monkeycode_ai_session","value":"…","expires":"2026-10-01T10:17:37Z"}, …]
 * ```
 *
 * 三处**容易踩**的路径事实：
 *
 * 1. `settings.json` 在 **`<bundle>/ohmyagent/`** 子目录里；
 * 2. 两支 Cookie 文件（`monkeycode-cookies.json` / `baizhi-cookies.json`）
 *    **直接在 bundle 根目录**，与 `settings.json` **不同级**；
 * 3. macOS 版客户端（**2026-10-08 实测**）目录名与 Windows 版**同名**，
 *    只是根换成 `~/Library/Application Support/`，Cookie 文件格式一致。
 *
 * ## 跨平台口径（对齐 Go 侧 issue #75）
 *
 * **不做 Windows 门禁**：候选路径以通用环境变量为主，客户端落在标准目录即可命中；
 * 非 Windows 上找不到时给出**明确报错**（而不是假装成功）。
 * 真正仅 Windows 的是别的渠道（小浣熊的桌面协议登录），与本模块无关。
 *
 * ## 移植来源
 *
 * 逐点对齐 `wild-work/internal/app/import_local.go` 的
 * `importMonkeyCode` / `monkeyCodeSettingsPath` / `monkeyCodeCookie` /
 * `monkeyCodeCookiePath` / `monkeyCodeImportNote` / `splitBaseURL`
 * 与 `wild-work/internal/monkeycode/constants.go` 的两个 Cookie 名常量
 * （Go 仓库只读参考）。
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  MONKEYCODE_COOKIE_BAIZHI,
  MONKEYCODE_COOKIE_CONSOLE,
  MONKEYCODE_DEFAULT_BASE,
  monkeycodeUidFromApiKey,
} from './monkeycode.js'

/** 官方客户端的 bundle id（Windows 与 macOS 版同名）。 */
const BUNDLE_ID = 'com.chaitin.baizhi.monkeycode'

/** 客户端把 `settings.json` 放在 bundle 目录下的这个子目录里。 */
const AGENT_DIR = 'ohmyagent'

/** 客户端凭据文件名。 */
const SETTINGS_FILE = 'settings.json'

/**
 * 两支会话 Cookie 的落盘文件名。
 *
 * ⚠️ 它们**在 bundle 根目录**，不在 `ohmyagent/` 下（见模块头部事实 2），
 * 故候选路径**不能**直接复用 `settings.json` 那一套。
 */
const CONSOLE_COOKIE_FILE = 'monkeycode-cookies.json'
const BAIZHI_COOKIE_FILE = 'baizhi-cookies.json'

/**
 * 候选目录的环境变量覆盖名（与 Go 同名同义）。
 *
 * ⚠️ **它在 Go 里对两类文件是「两个不同的根」**：
 * `settings.json` 取 `<dir>/settings.json`，而 Cookie 取 `<dir>/<cookieFile>`。
 * 真实 Windows 上 `%APPDATA%\<bundle>` 根目录放 Cookie、
 * `<bundle>\ohmyagent\` 放 settings.json，所以想用一个环境变量同时命中两者，
 * 需要让该目录**同时**直接含这三份文件（测试 fixture 正是这么造的）。
 */
const CONFIG_DIR_ENV = 'MONKEYCODE_CONFIG_DIR'

/** 导入结果（供调用方落成凭据文件 / 展示）。 */
export interface MonkeycodeImportedCredential {
  /** API key，`oma_` 开头（进 `X-Api-Key` 头）。 */
  apiKey: string
  /** 签名密钥，`omas_` 开头（用于 `X-Ohmyagent-Signature`）。 */
  signingSecret: string
  /** 客户端 `settings.json` 里的 `base_url`（客户端未写时回落内置默认端点）。 */
  baseUrl: string
  /** `baseUrl` 拆出的 host（**含协议**）。 */
  apiHost: string
  /** `baseUrl` 拆出的路径（如 `/v1`）。 */
  apiPath: string
  /** `'mc_' + hex(sha256(apiKey)) 的前 5 字节`（上游无 uid，见下）。 */
  uid: string
  /** 控制台会话 Cookie（`monkeycode_ai_session`，**尽力而为**，拿不到为 `undefined`）。 */
  consoleCookie?: string
  /** 百智云会话 Cookie（`baizhi_session`，**尽力而为**，拿不到为 `undefined`）。 */
  baizhiCookie?: string
  /** 实际命中的配置文件路径（便于报错与面板展示）。 */
  configPath: string
  /** 降级提示（**只在有降级时非空**，正常导入为 `undefined`）。 */
  note?: string
}

/** 导入选项。 */
export interface ImportLocalOptions {
  /** 覆盖候选路径（**测试必须用这个**，否则结果随开发机是否装了客户端而变）。 */
  configDir?: string
  /** 环境变量替身（测试注入用），默认 `process.env`。 */
  env?: Record<string, string | undefined>
}

// ===== 内部工具 =====

/** 读一个环境变量并 trim；空串按「未设置」处理（对齐 Go 的 `strings.TrimSpace(os.Getenv(...))`）。 */
function envValue(env: Record<string, string | undefined>, key: string): string {
  const raw = env[key]
  return typeof raw === 'string' ? raw.trim() : ''
}

/**
 * 取「家目录」，用于 macOS 候选路径。
 *
 * Go 侧用的是 `os.UserHomeDir()` —— Windows 上读 `%USERPROFILE%`、
 * POSIX 上读 `$HOME`。这里按平台优先级从**注入的 env** 里取同名字段，
 * 取不到才回落到 Node 的 `homedir()`：这样测试能注入一个假 home，
 * 用例结果不会随开发机是否装了客户端而变。
 */
function homeDirectory(env: Record<string, string | undefined>): string {
  const keys = process.platform === 'win32'
    ? ['USERPROFILE', 'HOME']
    : ['HOME', 'USERPROFILE']
  for (const key of keys) {
    const value = envValue(env, key)
    if (value.length > 0) return value
  }
  try {
    return homedir()
  } catch {
    return ''
  }
}

/** 路径是否为**存在的普通文件**（Go 的 `fileExists`：`stat` 成功且非目录）。 */
function isFile(path: string): boolean {
  if (path.length === 0) return false
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * `settings.json` 的候选路径（**按 Go 的顺序**，逐个尝试，命中即用）。
 *
 * 1. `$MONKEYCODE_CONFIG_DIR/settings.json`
 * 2. `%APPDATA%/com.chaitin.baizhi.monkeycode/ohmyagent/settings.json`
 * 3. `%LOCALAPPDATA%/com.chaitin.baizhi.monkeycode/ohmyagent/settings.json`
 * 4. `%LOCALAPPDATA%/MonkeyCode/ohmyagent/settings.json`
 * 5. `~/Library/Application Support/com.chaitin.baizhi.monkeycode/ohmyagent/settings.json`
 *
 * `configDir` 选项是**完全覆盖**（只认这一条候选）—— 与 qoder-machine.ts 的
 * `QODER_MACHINE_TOKEN_PATH` 同一套「测试注入」范式；而环境变量
 * `MONKEYCODE_CONFIG_DIR` 是 Go 的**前置候选**（后面那些仍会尝试）。
 * 两者是不同机制，别混用。
 */
function settingsCandidates(configDir: string | undefined, env: Record<string, string | undefined>): string[] {
  if (configDir !== undefined && configDir.length > 0) {
    return [join(configDir, SETTINGS_FILE)]
  }
  const candidates: string[] = []
  const fromEnv = envValue(env, CONFIG_DIR_ENV)
  if (fromEnv.length > 0) candidates.push(join(fromEnv, SETTINGS_FILE))
  const appData = envValue(env, 'APPDATA')
  if (appData.length > 0) candidates.push(join(appData, BUNDLE_ID, AGENT_DIR, SETTINGS_FILE))
  const localAppData = envValue(env, 'LOCALAPPDATA')
  if (localAppData.length > 0) {
    candidates.push(join(localAppData, BUNDLE_ID, AGENT_DIR, SETTINGS_FILE))
    candidates.push(join(localAppData, 'MonkeyCode', AGENT_DIR, SETTINGS_FILE))
  }
  const home = homeDirectory(env)
  if (home.length > 0) {
    candidates.push(join(home, 'Library', 'Application Support', BUNDLE_ID, AGENT_DIR, SETTINGS_FILE))
  }
  return candidates
}

/**
 * Cookie 文件的候选路径（**按 Go 的顺序**，与 settings.json **不同级**）。
 *
 * 1. `$MONKEYCODE_CONFIG_DIR/<file>`
 * 2. `%APPDATA%/com.chaitin.baizhi.monkeycode/<file>`
 * 3. `%LOCALAPPDATA%/com.chaitin.baizhi.monkeycode/<file>`
 * 4. `%LOCALAPPDATA%/MonkeyCode/<file>`
 * 5. `~/Library/Application Support/com.chaitin.baizhi.monkeycode/<file>`
 */
function cookieCandidates(
  file: string,
  configDir: string | undefined,
  env: Record<string, string | undefined>,
): string[] {
  if (configDir !== undefined && configDir.length > 0) {
    return [join(configDir, file)]
  }
  const candidates: string[] = []
  const fromEnv = envValue(env, CONFIG_DIR_ENV)
  if (fromEnv.length > 0) candidates.push(join(fromEnv, file))
  const appData = envValue(env, 'APPDATA')
  if (appData.length > 0) candidates.push(join(appData, BUNDLE_ID, file))
  const localAppData = envValue(env, 'LOCALAPPDATA')
  if (localAppData.length > 0) {
    candidates.push(join(localAppData, BUNDLE_ID, file))
    candidates.push(join(localAppData, 'MonkeyCode', file))
  }
  const home = homeDirectory(env)
  if (home.length > 0) {
    candidates.push(join(home, 'Library', 'Application Support', BUNDLE_ID, file))
  }
  return candidates
}

/** 按 Go 的字节序比较两个字符串（`sort.Strings` 是**字节序**，不是本地化序）。 */
function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/** 取错误文本（用于拼进可读错误）。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 把客户端 `base_url` 拆成 `(host, path)`。
 *
 * 例：`https://proxy.monkeycode-ai.com/v1`
 * → `('https://proxy.monkeycode-ai.com', '/v1')`。
 *
 * 边界行为**照 Go**：
 * - 先 `trim` 再去掉**尾部所有** `/`；结果为空 → 回落 `MONKEYCODE_DEFAULT_BASE`
 *   （否则 host/path 会与 `baseUrl` 自相矛盾）；
 * - 有 `://` 且其后再无 `/`（如 `https://host`、`https://host/`）→ path 取 `/v1`；
 * - 完全没有 `://`（如 `proxy.example.com/v1`）→ host 原样、path 取 `/v1`。
 */
function splitBaseUrl(base: string): { baseUrl: string; apiHost: string; apiPath: string } {
  let value = base.trim()
  while (value.endsWith('/')) value = value.slice(0, -1)
  if (value.length === 0) value = MONKEYCODE_DEFAULT_BASE
  const scheme = value.indexOf('://')
  if (scheme >= 0) {
    const rest = value.slice(scheme + 3)
    const slash = rest.indexOf('/')
    if (slash >= 0) {
      return {
        baseUrl: value,
        apiHost: value.slice(0, scheme + 3 + slash),
        apiPath: rest.slice(slash),
      }
    }
    return { baseUrl: value, apiHost: value, apiPath: '/v1' }
  }
  return { baseUrl: value, apiHost: value, apiPath: '/v1' }
}

/** 解析后的托管条目（只关心 Go 用到的两个字段）。 */
interface RawModelEntry {
  apiKey: string
  baseUrl: string
}

/** 把一个可选字段读成 trim 后的字符串；`null`/缺失算空，**类型不符则算解析失败**（对齐 Go 的 json.Unmarshal）。 */
function optionalString(value: unknown, field: string, path: string): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    throw new Error(`解析客户端配置失败（${path}）：${field} 不是字符串`)
  }
  return value.trim()
}

/**
 * 严格解析 `settings.json`（结构不符时抛「解析失败」并带文件路径）。
 *
 * 为什么把类型不符也归成**解析失败**而不是「没有凭据」：Go 侧是
 * `json.Unmarshal` 进强类型结构体，`models` 写成数组、条目写成字符串
 * 都会直接报 unmarshal 错误。若这里静默当成「条目不存在」，
 * 用户会拿到「请先在客户端登录」这种**指错方向**的提示。
 *
 * ⚠️ `null` 不算类型错误（Go 的 `encoding/json` 把 `null` 当零值），
 * 故 `signing_secret: null` / `models: null` 会落到后面「缺字段」的分支。
 */
function parseSettings(raw: string, path: string): { signingSecret: string; models: Map<string, RawModelEntry> } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`解析客户端配置失败（${path}）：${errorText(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`解析客户端配置失败（${path}）：顶层不是 JSON 对象`)
  }
  const record = parsed as Record<string, unknown>
  const signingSecret = optionalString(record.signing_secret, 'signing_secret', path)
  const models: Map<string, RawModelEntry> = new Map()
  const rawModels = record.models
  if (rawModels !== undefined && rawModels !== null) {
    if (typeof rawModels !== 'object' || Array.isArray(rawModels)) {
      throw new Error(`解析客户端配置失败（${path}）：models 不是 JSON 对象`)
    }
    for (const [name, value] of Object.entries(rawModels as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`解析客户端配置失败（${path}）：models["${name}"] 不是 JSON 对象`)
      }
      const entry = value as Record<string, unknown>
      models.set(name, {
        apiKey: optionalString(entry.api_key, `models["${name}"].api_key`, path),
        baseUrl: optionalString(entry.base_url, `models["${name}"].base_url`, path),
      })
    }
  }
  return { signingSecret, models }
}

/**
 * 从客户端 Cookie 文件里取指定名字的 Cookie 值（**尽力而为**）。
 *
 * 第二个返回值是**降级原因**（`''` = 取到了值），取值照 Go：
 * `文件缺失` / `读取失败` / `解析失败` / `已过期` / `文件里没有 <name>`。
 *
 * 为什么要取**两支**（控制台 ＋ 百智云）：控制台会话短寿（≈6 天）
 * 但**可由百智云会话（≈29 天）自动派生续期**，故两支都取。
 * 与 api_key / signing_secret 不同，控制台接口（积分钱包等）**只认 Cookie**，
 * 而本工具没有登录流程 —— 文件缺失、读取失败或已过期一律只降级、不报错。
 */
function readCookie(
  file: string,
  cookieName: string,
  configDir: string | undefined,
  env: Record<string, string | undefined>,
): { value?: string; why: string } {
  let path: string | undefined
  for (const candidate of cookieCandidates(file, configDir, env)) {
    if (isFile(candidate)) {
      path = candidate
      break
    }
  }
  if (path === undefined) return { why: '文件缺失' }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { why: '读取失败' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { why: '解析失败' }
  }
  if (!Array.isArray(parsed)) return { why: '解析失败' }
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (record.name !== cookieName) continue
    // ⚠️ 过期判定**在取值之前**，且命中即返回（与 Go 一致，不再看后面的同名条目）。
    const expires = typeof record.expires === 'string' ? parseRfc3339(record.expires) : undefined
    if (expires !== undefined && Date.now() > expires) return { why: '已过期' }
    const value = typeof record.value === 'string' ? record.value.trim() : ''
    if (value.length > 0) return { value, why: '' }
    // 同名但值为空的条目**不中断**（Go 的循环会继续找下一个同名条目）。
  }
  return { why: `文件里没有 ${cookieName}` }
}

/**
 * 解析客户端写下的 RFC3339 时间戳（毫秒）；**不合法就返回 `undefined`**。
 *
 * 为什么要自己挡一层：Go 用 `time.Parse(time.RFC3339, …)`，解析失败即
 * 「没有过期信息」而**不算过期**；而 JS 的 `Date.parse` 宽松得多
 * （`"2026-10-01"` 这种只有日期的串也会被解析成功），照它判会把
 * Go 视为「无过期信息」的条目误判成「已过期」而白白丢掉一支 Cookie。
 */
function parseRfc3339(text: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(text.trim())
  if (match === null) return undefined
  const millis = Date.parse(text.trim())
  return Number.isFinite(millis) ? millis : undefined
}

/**
 * 拼导入提示：**只在有降级时非空**（照 Go `monkeyCodeImportNote`）。
 *
 * 正常导入不必复述凭据来源（面板已经会说「已导入 MonkeyCode 账号 xxx」），
 * 而这句会原样进 toast（单行条、默认 3 秒），所以每句都要**短且可行动**。
 */
function buildNote(consoleWhy: string, baizhiWhy: string): string {
  let note = ''
  if (consoleWhy.length > 0) {
    note += `未取到控制台会话（${consoleWhy}），积分暂不可用（不影响对话）。`
  }
  if (baizhiWhy.length > 0) {
    note += `未取到百智云会话（${baizhiWhy}），控制台会话过期后需重新导入。`
  }
  return note
}

// ===== 主入口 =====

/**
 * 读取本机 MonkeyCode 官方客户端凭据，派生出导入结果。
 *
 * 出错时抛 `Error`，文案**面向用户且可行动**（照 Go 文案精神，中文）：
 *
 * | 情况 | 文案要点 |
 * |---|---|
 * | 找不到客户端配置 | 「未找到 MonkeyCode 客户端配置（已尝试 N 个路径…）」＋**逐个列出**候选路径 |
 * | 读了但解析失败 | 「解析客户端配置失败（<路径>）：<原因>」 |
 * | 缺 `signing_secret` | 「…请先在 MonkeyCode 客户端登录」 |
 * | 没有 `monkeycode-` 前缀条目 | 「…请先在 MonkeyCode 客户端登录」 |
 * | 托管条目缺 `api_key` | 「客户端配置里的托管条目没有 api_key（<路径>）」 |
 *
 * §1 候选路径**逐个尝试、命中即用**（顺序见 `settingsCandidates`）。
 * §2 `models` 是**对象**；只取 key 以 `monkeycode-` 开头的条目，
 *    并**按字节序排序取首条** —— 一个账号只有一对 `(api_key, signing_secret)`，
 *    与具体模型无关，故任取一条即可；排序是为了让**同一份配置多次导入结果一致**。
 * §3 `signing_secret`（顶层）与 `api_key`（托管条目内）是**两把不同的密钥**，不得混用。
 * §4 上游**没有 uid**，故用 `'mc_' + hex(sha256(apiKey)) 的前 5 字节` 派生稳定标识 ——
 *    目的是同一账号重复导入**不会**生成多个凭据文件。
 * §5 两支 Cookie 尽力而为，拿不到只降级（`undefined` ＋ `note` 说明）。
 * §6 **不做前缀校验**（Go 也只校验非空）：客户端理论上可能给出别的 key 形态，
 *    多一道前缀检查会把「能用但形态不同」的凭据挡在门外。
 * §7 本函数**无副作用**（除读文件），落盘由调用方负责。
 */
export function importMonkeycodeLocalCredentials(
  options?: ImportLocalOptions,
): MonkeycodeImportedCredential {
  const env = options?.env ?? process.env
  const rawConfigDir = options?.configDir
  const configDir = typeof rawConfigDir === 'string' ? rawConfigDir.trim() : undefined
  const override = configDir !== undefined && configDir.length > 0 ? configDir : undefined

  // ---- 1. 定位 settings.json（逐个候选，命中即用）----
  const candidates = settingsCandidates(override, env)
  let settingsPath: string | undefined
  for (const candidate of candidates) {
    if (isFile(candidate)) {
      settingsPath = candidate
      break
    }
  }
  if (settingsPath === undefined) {
    // 全部失败：把**试过的路径**都摆出来（照 Go 的「已尝试 N 个路径，最后一个是 X」
    // 口径，并额外列出完整清单 —— 只说「没找到」用户无从排查装在哪）。
    const last = candidates.length > 0 ? candidates[candidates.length - 1] : ''
    const tried = candidates.length > 0
      ? `（已尝试 ${candidates.length} 个路径，最后一个是 ${last}）`
      : '（没有任何候选路径可用：请设置 MONKEYCODE_CONFIG_DIR）'
    const list = candidates.length > 0 ? `。已尝试的路径：${candidates.join('；')}` : ''
    throw new Error(`未找到 MonkeyCode 客户端配置${tried}：请先安装并登录 MonkeyCode 客户端${list}`)
  }

  // ---- 2. 读 + 解析 ----
  let raw: string
  try {
    raw = readFileSync(settingsPath, 'utf8')
  } catch (error) {
    throw new Error(`读取客户端配置失败（${settingsPath}）：${errorText(error)}`)
  }
  const { signingSecret, models } = parseSettings(raw, settingsPath)

  // ---- 3. 两把密钥都要在 ----
  if (signingSecret.length === 0) {
    throw new Error(`客户端配置里没有 signing_secret（${settingsPath}）：请先在 MonkeyCode 客户端登录`)
  }

  // ---- 4. 挑一条平台托管条目（前缀 + 字节序排序，保证确定性）----
  const names = [...models.keys()].filter((name) => name.startsWith('monkeycode-')).sort(compareUtf8)
  if (names.length === 0) {
    throw new Error(`客户端配置里没有平台托管模型（${settingsPath}）：请先在 MonkeyCode 客户端登录`)
  }
  const entry = models.get(names[0])
  const apiKey = entry === undefined ? '' : entry.apiKey
  if (apiKey.length === 0) {
    throw new Error(`客户端配置里的托管条目没有 api_key（${settingsPath}）`)
  }

  // ---- 5. 基址拆分 + 两支 Cookie（尽力而为）+ uid 派生 ----
  const { baseUrl, apiHost, apiPath } = splitBaseUrl(entry === undefined ? '' : entry.baseUrl)
  const consoleSession = readCookie(CONSOLE_COOKIE_FILE, MONKEYCODE_COOKIE_CONSOLE, override, env)
  const baizhiSession = readCookie(BAIZHI_COOKIE_FILE, MONKEYCODE_COOKIE_BAIZHI, override, env)

  const result: MonkeycodeImportedCredential = {
    apiKey,
    signingSecret,
    baseUrl,
    apiHost,
    apiPath,
    // 复用 monkeycode.ts 的唯一实现，避免两处派生规则漂移。
    uid: monkeycodeUidFromApiKey(apiKey),
    configPath: settingsPath,
  }
  if (consoleSession.value !== undefined) result.consoleCookie = consoleSession.value
  if (baizhiSession.value !== undefined) result.baizhiCookie = baizhiSession.value
  const note = buildNote(consoleSession.why, baizhiSession.why)
  // ⚠️ 无降级时**不放** `note` 键（而不是放空串）：调用方以「有没有 note」判是否有话要说。
  if (note.length > 0) result.note = note
  return result
}
