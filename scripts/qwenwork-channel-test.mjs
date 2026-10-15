/**
 * 千问办公渠道的离线回归：COSY 签名、body 改造、信封剥壳、余额与「无签到」守卫。
 *
 * 全部用假上游（`globalThis.fetch` 替身），**不打真实网络**。
 * 覆盖的四类真实缺陷（每条都对应 Go 侧一次实测踩坑）：
 *
 * 1. **`business` 段缺失** → 上游 HTTP 200 + 信封 503，表现为「模型不可用」；
 * 2. **信封错误被当正常空回答**（HTTP 200 里藏 statusCodeValue>=400）；
 * 3. **`expires_in` 单位理解错**（秒 vs 毫秒）→ 每次请求都刷 token；
 * 4. **「不支持签到」文案不匹配** → 自动签到引擎计为失败而非跳过。
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/** 从 COSY Authorization 头解出签名串，供断言使用。 */
function parseCosyAuth(auth) {
  const match = /^Bearer COSY\.([^.]+)\.([0-9a-f]{32})$/.exec(auth ?? '')
  assert.ok(match, `Authorization 形态非法：${String(auth).slice(0, 60)}`)
  return { headerB64: match[1], digest: match[2] }
}

/** 解出 COSY 载荷里的身份信息（用 Cosy-Key 无法解，密钥是临时随机的，故只校验结构）。 */
function parseCosyHeader(headerB64) {
  const parsed = JSON.parse(Buffer.from(headerB64, 'base64').toString('utf8'))
  assert.equal(parsed.version, 'v1')
  assert.equal(typeof parsed.requestId, 'string')
  assert.equal(parsed.cosyVersion, '1.1.18')
  assert.equal(parsed.ideVersion, '0.1.8')
  assert.equal(typeof parsed.info, 'string')
  return parsed
}

/**
 * 用**独立复算**校验签名：按 COSY 算法重算 MD5，证明实现与协议一致
 * （而不是「断言自己产出的值」这种同义反复）。
 */
function recomputeSignature({ headerB64, cosyKey, date, body, rawUrl }) {
  const pathSig = new URL(rawUrl).pathname.replace(/^\/algo/, '')
  return createHash('md5').update(`${headerB64}\n${cosyKey}\n${date}\n${body}\n${pathSig}`, 'utf8').digest('hex')
}

/** 生成一条嵌套信封 SSE 帧（上游真实形态）。 */
function envelopeFrame(inner, statusCodeValue = 200) {
  return `data: ${JSON.stringify({
    headers: {},
    body: typeof inner === 'string' ? inner : JSON.stringify(inner),
    statusCodeValue,
    statusCode: statusCodeValue === 200 ? 'OK' : 'ERROR',
  })}\n\n`
}

/** 一条标准 OpenAI chunk。 */
function chunkFrame(delta, extra = {}) {
  return envelopeFrame({ id: 'chatcmpl-x', object: 'chat.completion.chunk', model: 'pro', choices: [{ index: 0, delta, finish_reason: null }], ...extra })
}

/**
 * @param {{ ctx: any, adapters: Map<string, any>, creds: Map<string, any>, call: (m: string, p: unknown) => Promise<any>, warnings: string[], realFetch?: typeof fetch }} harness
 */
export async function verifyQwenworkChannel({ ctx, adapters, creds, call, warnings, realFetch }) {
  const originalFetch = globalThis.fetch
  // ⚠️ `realFetch` 是 harness 在被替换**之前**保存的真 fetch —— 本机回调 server
  // 必须用它访问（`globalThis.fetch` 此时已是「禁止外部网络」的抛错桩）。
  const loopbackFetch = realFetch ?? originalFetch
  const seen = []
  /** 让每个用例按需切换上游行为。 */
  let scenario = 'chat'

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    const headers = init.headers ?? {}
    const headerOf = (name) => {
      if (typeof headers.get === 'function') return headers.get(name)
      const found = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase())
      return found === undefined ? undefined : headers[found]
    }
    seen.push({ url, body: init.body, method: init.method ?? 'GET', headers, headerOf })

    // 本机回调 server（真实起在 127.0.0.1）必须放行 —— 它不是「外部网络」，
    // 而是被测代码自己开的回调端点，浏览器正是这样回放授权码的。
    if (url.startsWith('http://127.0.0.1:')) return loopbackFetch(input, init)

    // ---- 推理端点（COSY 域，SSE）----
    if (url.includes('/algo/api/v2/service/pro/sse/agent_chat_generation')) {
      if (scenario === 'chat-error-envelope') {
        // 场景：HTTP 200 + 信封 503（缺 business 的典型形态）
        return new Response(envelopeFrame({ code: '503', message: 'Model catalog unavailable' }, 503), {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        })
      }
      if (scenario === 'chat-truncated') {
        // 场景：停在**半个帧**上（最后一帧没有换行收尾就断流）
        // —— 这是 Go 侧判定的「可证实的截断」之一（另一种是读流报错）。
        const body = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder()
            controller.enqueue(encoder.encode(chunkFrame({ content: '半截' })))
            // 只发半帧：缺 `\n\n` 收尾
            controller.enqueue(encoder.encode('data: {"headers":{},"body":"{\\"choices\\":'))
            controller.close()
          },
        })
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      if (scenario === 'chat-clean-eof-no-done') {
        // 场景：帧完整、但上游漏发 [DONE] 就干净收尾。
        // ⚠️ 这**不是**截断（Go 侧刻意保留的行为）：应兜底补 [DONE] 并报正常结束，
        // 避免误伤「本就补 [DONE] 的渠道」。
        return new Response(chunkFrame({ content: '完整但没有收尾帧' }), {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        })
      }
      const frames = [
        chunkFrame({ role: 'assistant', content: '' }),
        chunkFrame({ reasoning_content: '让我想想…' }),
        chunkFrame({ content: '你好' }),
        chunkFrame({ content: '，世界' }),
        chunkFrame({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"p":' } }] }),
        chunkFrame({ tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }),
        envelopeFrame({ id: 'chatcmpl-x', object: 'chat.completion.chunk', model: 'pro', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 } }),
        envelopeFrame('[DONE]'),
      ].join('')
      return new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }

    // ---- 模型列表（COSY 域，JSON）----
    if (url.includes('/api/v2/model/list')) {
      return Response.json({ qwork: [
        { key: 'pro', display_name: '高级', enable: true, price_factor: 1, max_input_tokens: 180000 },
        { key: 'flash', display_name: '标准', enable: true, price_factor: 0.1, max_input_tokens: 180000 },
        { key: 'disabled-one', display_name: '停用档', enable: false },
      ] })
    }

    // ---- token 轮换（COSY 域）----
    if (url.includes('/api/v1/deviceToken/refresh')) {
      // ⚠️ 故意回 `expires_in`（**秒**）：验证实现不会把它当毫秒用。
      return Response.json({
        device_token: 'fixture-access-new',
        refresh_token: 'fixture-refresh-new',
        expires_in: 604800,
      })
    }

    // ---- 余额（Bearer 域）----
    if (url.includes('/user/balance')) {
      return Response.json({ code: 'ok', data: { balance: 2090.38, freeze_credit: 0 } })
    }
    // ---- 钱包分项（Bearer 域）----
    if (url.includes('/user/wallets')) {
      return Response.json({ code: 'ok', data: {
        active_wallets: { wallets: [{ balance: 90.38, valid_to: '2026-12-01' }] },
        daily_credits: { total_balance: 1000 },
        longterm_credits: { total_balance: 1000 },
        monthly_credits: { total_balance: 0 },
      } })
    }
    // ---- 用户信息（Bearer 域）----
    if (url.includes('/user/info')) {
      return Response.json({ code: 'ok', data: { nickname: '千问测试号' } })
    }
    // ---- 费率（Bearer 域）----
    if (url.includes('/api/chat-modes')) {
      return Response.json({ code: 'ok', data: { qwork: [
        { key: 'pro', price_factor: 1, enable: true },
        { key: 'flash', price_factor: 0.1, enable: true },
      ] } })
    }
    // ---- OAuth 令牌端点 ----
    if (url.includes('/oauth2/token')) {
      // 构造一个带 user_id/username 的 JWT（只解码不验签）
      const payload = Buffer.from(JSON.stringify({ user_id: 'u-fixture', username: '万问' })).toString('base64url')
      return Response.json({
        access_token: `header.${payload}.sig`,
        refresh_token: 'fixture-refresh',
        expires_in: 604800,
        id_token: `header.${payload}.sig`,
      })
    }
    throw new Error(`离线测试禁止外部请求：${url}`)
  }

  const provider = 'qwenwork'
  const adapter = adapters.get(provider)
  assert.ok(adapter, '千问办公 provider 必须已注册')

  try {
    // ===== 1. 模型目录 =====
    const models = adapter.listAllModels()
    assert.ok(models.length >= 3, `模型目录至少 3 个档位，实得 ${models.length}`)
    assert.ok(models.some((row) => row.id === 'pro'))
    // 展示名必须带倍率（1 倍也要显示）
    assert.match(models.find((row) => row.id === 'pro').name, /x1/, 'pro 必须显示 x1 倍率')

    const listed = await adapter.listModels(provider)
    // ⚠️ 此处**还没有**登录账号 ⇒ 目录门控返回空数组是**设计行为**：
    // DSH 的 buildModelCatalog 会过滤掉空分组，从而隐藏「一个账号都没有」的 provider。
    // 必须返回 `[]` 而非抛错（抛错会多出一条 provider 报错，比不显示更糟）。
    assert.deepEqual(listed, [], '无已登录账号时 listModels 必须返回空数组（门控），而不是抛错')

    // ===== 2. 建账号 + 走真实 RPC 的余额 =====
    const ref = 'QWENWORK_ACCOUNT_FIXTURE'
    creds.set(ref, { value: JSON.stringify({
      access_token: 'fixture-access', refresh_token: 'fixture-refresh',
      expires_at: Date.now() + 7 * 86400_000, uid: 'u-fixture', nickname: '万问',
    }) })
    await ctx.accountPool.addAccount({
      id: 'fixture-qwenwork', provider, nickname: '万问', credentialRef: ref,
      enabled: true, refreshable: true, createdAt: 1,
    })

    const balances = await call('credits.balances', { provider })
    assert.equal(balances.ok, true, JSON.stringify(balances.error))
    const balance = balances.value.accounts.find((row) => row.accountId === 'fixture-qwenwork')
    assert.ok(balance, '必须返回该账号的余额条目')
    assert.equal(balance.balance?.total, 2090, '余额必须按上游整数口径（截断小数，不 ×100）')
    assert.ok(balance.balance.packages.length >= 2, '钱包分项必须分开作 package')

    // ===== 2b. 有账号后目录门控放开，且 `enable:false` 的档位必须被过滤 =====
    seen.length = 0
    const listedWithAccount = await adapter.listModels(provider)
    assert.deepEqual(
      [...listedWithAccount].map((row) => row.id).sort(),
      ['flash', 'pro'],
      '`enable:false` 的档位必须被过滤（且必须走远端目录，不是兜底表）',
    )
    assert.ok(seen.some((row) => row.url.includes('/api/v2/model/list')), '模型目录必须走 COSY 端点')
    // COSY GET 的签名 body 必须是**空串**（传 `"{}"` 会 403 Signature invalid）
    const modelsCall = seen.find((row) => row.url.includes('/api/v2/model/list'))
    assert.equal(modelsCall.body, undefined, 'GET 请求不应有 body')
    assert.ok(parseCosyAuth(modelsCall.headerOf('Authorization')), '模型列表也必须带 COSY 四件套')
    assert.equal(modelsCall.headerOf('Accept'), 'application/json', '模型列表的 Accept 必须覆盖为 JSON')

    // ===== 3. 「不支持签到」守卫：**不发上游请求**且文案可被识别 =====
    const before = seen.length
    const claim = await call('credits.claimAll', { provider })
    assert.equal(claim.ok, false, '千问办公必须拒绝一键签到')
    assert.match(claim.error.message, /不支持每日签到/, '文案必须逐字含「不支持每日签到」，否则自动签到会计为失败')
    assert.equal(seen.length, before, '拒绝签到**不得**发出任何上游请求')

    // ===== 4. 推理：COSY 签名 + body 改造 + 信封剥壳 + 工具调用 =====
    seen.length = 0
    const chunks = []
    for await (const chunk of adapter.stream({
      provider, model: 'pro',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) chunks.push(chunk)

    const chatCall = seen.find((row) => row.url.includes('agent_chat_generation'))
    assert.ok(chatCall, '必须发出推理请求')

    // 4a. COSY 四件套必须齐全
    for (const name of ['Authorization', 'Cosy-Key', 'Cosy-User', 'Cosy-Date']) {
      assert.ok(chatCall.headerOf(name), `缺 COSY 头 ${name}`)
    }
    assert.equal(chatCall.headerOf('Cosy-User'), 'u-fixture')
    // 4b. `x-model-key` 必须与映射后的上游 key 一致（pro）
    assert.equal(chatCall.headerOf('x-model-key'), 'pro', 'x-model-key 决定实际路由')

    // 4c. 签名必须能被**独立复算**验证（不是断言自己）
    const { headerB64, digest } = parseCosyAuth(chatCall.headerOf('Authorization'))
    const parsedHeader = parseCosyHeader(headerB64)
    const expected = recomputeSignature({
      headerB64,
      cosyKey: chatCall.headerOf('Cosy-Key'),
      date: chatCall.headerOf('Cosy-Date'),
      body: chatCall.body,
      rawUrl: chatCall.url,
    })
    assert.equal(digest, expected, '签名必须等于按协议独立复算的结果')
    void parsedHeader

    // 4d. Cosy-Key 必须是 RSA-1024 密文（128 字节）
    assert.equal(Buffer.from(chatCall.headerOf('Cosy-Key'), 'base64').length, 128, 'Cosy-Key 应为 RSA-1024 密文')

    // 4e. body 必填字段
    const sentBody = JSON.parse(chatCall.body)
    assert.equal(sentBody.model, 'pro')
    assert.ok(sentBody.request_id, 'request_id 必填')
    assert.ok(sentBody.session_id, 'session_id 必填')
    assert.equal(sentBody.stream, true, 'stream 必须强制 true')
    // ⚠️ 最关键：business 段缺失会让上游回信封 503
    assert.deepEqual(sentBody.business, {
      product: 'qoder_work', type: 'agent', version: '1', feature_switches: {},
    }, 'business 段必须齐全（缺失 → HTTP 200 + 信封 503 Model catalog unavailable）')

    // 4f. 流式产出：思考、正文、工具调用、usage、finish
    assert.ok(chunks.some((c) => c.type === 'reasoning-delta' && c.text.includes('让我想想')), '思考必须映射成 reasoning')
    assert.ok(chunks.some((c) => c.type === 'text-delta' && c.text === '你好'), '正文必须透传')
    const toolDeltas = chunks.filter((c) => c.type === 'tool-call-delta')
    assert.ok(toolDeltas.length > 0, '工具调用分片必须产出')
    assert.equal(toolDeltas.map((c) => c.argumentsDelta).join(''), '{"p":"a.txt"}', 'arguments 分片必须拼成完整 JSON')
    // ⚠️ usage 是**独立**的 `{type:'usage'}` chunk（不是挂在 finish 上），
    // 且 `finish.reason` 是判别对象 `{kind}`（不是裸字符串）。
    const usageChunk = chunks.find((c) => c.type === 'usage')
    assert.ok(usageChunk, '必须产出独立的 usage chunk')
    assert.equal(usageChunk.usage.outputTokens, 22, 'usage 必须从末帧捕获')
    const finish = chunks.find((c) => c.type === 'finish')
    assert.ok(finish, '必须产出 finish')
    assert.equal(finish.reason.kind, 'tool-calls', '有工具调用时 finish 必须是 tool-calls')

    // ===== 5. 信封错误（HTTP 200 里藏 503）必须被识别为失败，而不是空回答 =====
    scenario = 'chat-error-envelope'
    await assert.rejects(
      async () => {
        for await (const _ of adapter.stream({
          provider, model: 'pro', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        })) { /* 只关心抛错 */ }
      },
      (error) => {
        // ⚠️ 离线测试内核的 `LlmError` 替身把签名写反了（`(code, message)`
        // 而真实 API 是 `(message, code)`，见 `scripts/lib/channel-pack-kernel.mjs`），
        // 故这里把 message 与 code 一起看：两种签名下都能验证「带上上游原文」。
        const text = `${error?.message ?? ''} ${error?.code ?? ''}`
        assert.match(text, /Model catalog unavailable/,
          `必须带上上游原始文案，实得：${text}`)
        return true
      },
      'HTTP 200 + 信封 503 必须抛错，不能伪装成正常空回答',
    )

    // ===== 6. 截断不得伪装成正常结束 =====
    scenario = 'chat-truncated'
    const truncatedChunks = []
    for await (const chunk of adapter.stream({
      provider, model: 'pro', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) truncatedChunks.push(chunk)
    const truncatedFinish = truncatedChunks.find((c) => c.type === 'finish')
    // 停在半帧上 ⇒ 无 finish_reason、无 [DONE] ⇒ 必须报 max-tokens 而不是 stop
    assert.ok(truncatedFinish, '截断也要有 finish（不能静默结束）')
    assert.notEqual(truncatedFinish.reason.kind, 'stop',
      '停在半个帧上时不得谎报正常结束（stop）—— 否则客户端会拿着半截 tool_call 参数去解析')

    // ===== 6b. 帧完整但漏发 [DONE] ⇒ 不是截断，应正常收尾 =====
    // ⚠️ 这条与 6 是一对：把「上游省略收尾帧」也判成截断会**误伤**本就补 [DONE] 的渠道。
    scenario = 'chat-clean-eof-no-done'
    const cleanChunks = []
    for await (const chunk of adapter.stream({
      provider, model: 'pro', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) cleanChunks.push(chunk)
    const cleanFinish = cleanChunks.find((c) => c.type === 'finish')
    assert.ok(cleanFinish, '完整帧也必须收尾')
    assert.equal(cleanFinish.reason.kind, 'stop', '帧完整时（即使上游漏发 [DONE]）应报正常结束')
    assert.ok(cleanChunks.some((c) => c.type === 'text-delta' && c.text === '完整但没有收尾帧'))

    // ===== 7. 续期：`expires_in` 是**秒** =====
    scenario = 'chat'
    seen.length = 0
    await ctx.qwenworkAuth.refreshAccountCredential(ref, ctx.accountPool, 'fixture-qwenwork')
    const refreshed = JSON.parse(creds.get(ref).value)
    assert.equal(refreshed.access_token, 'fixture-access-new')
    assert.equal(refreshed.refresh_token, 'fixture-refresh-new', 'refresh_token 轮换后必须落盘新值')
    const lifetimeMs = refreshed.expires_at - Date.now()
    assert.ok(lifetimeMs > 6.9 * 86400_000 && lifetimeMs <= 7.01 * 86400_000,
      `expires_in=604800 是秒 → 过期时刻应约 7 天后，实得 ${(lifetimeMs / 86400_000).toFixed(2)} 天（按毫秒解释会得到约 10 分钟）`)

    // 续期后账号池的 expiresAt 必须被写回（否则 UI 一直显示「已过期」）
    const account = ctx.accountPool.listAccountsByProvider(provider).find((row) => row.id === 'fixture-qwenwork')
    assert.ok(account.expiresAt > Date.now() + 6.9 * 86400_000, '续期后必须把新 expiresAt 写回账号池')

    // ===== 8. JWT exp 只增不减地校正脏值 =====
    // 构造「显式 expires_at 严重偏小」的历史脏值 + 一个 JWT exp 正确的 token
    const jwtPayload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7 * 86400 })).toString('base64url')
    const goodJwt = `header.${jwtPayload}.sig`
    // 脏值：被按毫秒误算过，只剩 604.8 秒
    const dirty = Date.now() + 604_800
    creds.set(ref, { value: JSON.stringify({
      access_token: goodJwt, refresh_token: 'fixture-refresh',
      expires_at: dirty, uid: 'u-fixture', nickname: '万问',
    }) })
    seen.length = 0
    const withDirty = []
    for await (const _ of adapter.stream({
      provider, model: 'pro', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) withDirty.push(_)
    // 脏值会让「是否过期」判定为不过期（604800 在未来），故不应触发续期
    assert.equal(seen.filter((row) => row.url.includes('deviceToken/refresh')).length, 0,
      '显式 expires_at 在未来时不主动续期')

    // 再把显式值设成已过期、但 JWT exp 在未来 → 必须用 JWT 校正出「未过期」
    creds.set(ref, { value: JSON.stringify({
      access_token: goodJwt, refresh_token: 'fixture-refresh',
      expires_at: Date.now() - 86_400_000, uid: 'u-fixture', nickname: '万问',
    }) })
    seen.length = 0
    const withStale = []
    for await (const _ of adapter.stream({
      provider, model: 'pro', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) withStale.push(_)
    assert.equal(seen.filter((row) => row.url.includes('deviceToken/refresh')).length, 0,
      'JWT exp 显示未过期时必须用它校正历史脏值（否则会每次请求都刷 token）')

    // ===== 9. 401/403 触发一次续期重试 =====
    creds.set(ref, { value: JSON.stringify({
      access_token: 'fixture-access', refresh_token: 'fixture-refresh',
      expires_at: Date.now() + 7 * 86400_000, uid: 'u-fixture', nickname: '万问',
    }) })
    let chatAttempts = 0
    const innerFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      if (String(input).includes('agent_chat_generation')) {
        chatAttempts += 1
        if (chatAttempts === 1) return new Response('Signature invalid', { status: 403 })
      }
      return innerFetch(input, init)
    }
    const afterRetry = []
    for await (const chunk of adapter.stream({
      provider, model: 'pro', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) afterRetry.push(chunk)
    assert.equal(chatAttempts, 2, '403 后必须续期并重试一次')
    assert.ok(afterRetry.some((c) => c.type === 'finish'), '重试后应正常收尾')

    // ===== 10. 凭据缺 uid 时必须给可行动错误 =====
    creds.set(ref, { value: JSON.stringify({
      access_token: 'fixture-access', refresh_token: 'fixture-refresh',
      expires_at: Date.now() + 7 * 86400_000, nickname: '无 uid',
    }) })
    await assert.rejects(
      async () => {
        for await (const _ of adapter.stream({
          provider, model: 'pro', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        })) { /* 只关心抛错 */ }
      },
      (error) => {
        // 同样兼容测试内核替身写反的 `LlmError(code, message)` 签名。
        const text = `${error?.message ?? ''} ${error?.code ?? ''}`
        assert.match(text, /uid/, `缺 uid 必须明确报错，实得：${text}`)
        return true
      },
      '缺 uid 无法签名，必须明确报错而不是发出必然 403 的请求',
    )

    // 未产生误报的续期失败日志
    assert.equal(warnings.some((row) => row.includes('[qwenwork]') && row.includes('续期失败')), false,
      `不应有续期失败日志：${warnings.join(' | ')}`)

    // ===== 11. 完整 OAuth 登录链路：account.create → 回调 → login.poll → 凭据落盘 =====
    // 走真实 RPC，验证「两步式」契约（立即返回 loginUrl）与回调落定。
    const loginStarted = (await call('account.create', { provider })).value
    assert.ok(loginStarted.accountId, 'account.create 必须返回 accountId')
    assert.ok(loginStarted.loginUrl, 'account.create 必须立即返回 loginUrl（window.open 手势窗口）')
    const authorizationUrl = new URL(loginStarted.loginUrl)
    // 授权 URL 必须带 PKCE S256 与桌面端 client_id
    assert.equal(authorizationUrl.searchParams.get('client_id'), 'qwenwork-desktop-app')
    assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256')
    assert.ok(authorizationUrl.searchParams.get('code_challenge'), '必须带 PKCE code_challenge')
    assert.match(authorizationUrl.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
      '必须是本机回调（不是官方 https 回调）')

    // 模拟浏览器回调：把 state 与 code 回放给本机回调 server。
    // ⚠️ 用本用例自己的假上游（`globalThis.fetch`）而不是 harness 的 `originalFetch`
    // —— 后者是「禁止外部网络」的抛错桩。
    const callbackUrl = new URL(authorizationUrl.searchParams.get('redirect_uri'))
    callbackUrl.searchParams.set('state', authorizationUrl.searchParams.get('state'))
    callbackUrl.searchParams.set('code', 'fixture-code')
    const callbackResponse = await globalThis.fetch(callbackUrl)
    assert.equal(callbackResponse.status, 200, '回调必须返回成功页')

    // 轮询登录状态直到落定（与前端 login.poll 的调用形态一致）
    let poll
    for (let index = 0; index < 200; index += 1) {
      poll = await call('login.poll', { accountId: loginStarted.accountId, provider })
      if (poll.value?.done === true) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(poll.value?.done, true, `登录必须落定：${JSON.stringify(poll)}`)
    assert.equal(poll.value?.success, true, `登录必须成功：${JSON.stringify(poll)}`)
    assert.equal(poll.value?.loginError, undefined, '成功路径不得带 loginError')

    // 凭据必须落盘且字段正确
    const loginAccount = ctx.accountPool.listAccountsByProvider(provider)
      .find((row) => row.id === loginStarted.accountId)
    assert.ok(loginAccount, '登录后账号条目必须存在（占位条目已回填）')
    const savedCredential = JSON.parse(creds.get(loginAccount.credentialRef).value)
    // ⚠️ **登录落盘时必须已换成 device_token**（真实缺陷，2026-10-15 现场）：
    // OAuth 兑换的 access_token 只在 COSY 域有效，网页域（余额）恒 401。
    // fixture 的 refresh 端点回的是 `device_token: 'fixture-access-new'`，
    // 故落盘的 access_token 必须是它 —— 若仍是 OAuth 那个，本条即失败。
    assert.equal(savedCredential.access_token, 'fixture-access-new',
      '登录落盘必须已换成 device_token（否则余额查询恒 401 Invalid JWT token）')
    // ⚠️ refresh_token **会轮换**：落盘必须是换出来的新值，否则下次续期用已作废的旧值。
    assert.equal(savedCredential.refresh_token, 'fixture-refresh-new',
      'device_token 换出后 refresh_token 会轮换，必须落盘新值')
    assert.equal(savedCredential.uid, 'u-fixture', '必须从 JWT 解出 uid')
    assert.equal(loginAccount.refreshable, true, '有 refresh_token ⇒ refreshable 必须为 true')
    // ⚠️ 昵称必须从 JWT/`/user/info` 取到，而不是退化成池 id
    assert.notEqual(loginAccount.nickname, loginStarted.accountId, '昵称不得退化成池 id')
    // ⚠️ expires_at 必须按**秒**换算（604800 秒 ≈ 7 天）
    const savedLifetime = savedCredential.expires_at - Date.now()
    assert.ok(savedLifetime > 6.9 * 86400_000, `登录落盘的过期时刻也应按秒换算，实得 ${(savedLifetime / 86400_000).toFixed(2)} 天`)

    // 清理本次登录产生的账号与凭据
    await ctx.accountPool.removeAccount(loginStarted.accountId).catch(() => {})
    creds.delete(loginAccount.credentialRef)

    // ===== 12. 余额 401 自愈（历史账号无需重新登录）=====
    // 现场缺陷（2026-10-15）：先装的账号落盘的是 OAuth access_token，网页域恒 401。
    // 修复后：`credits.balances` 传入 credentialRef ⇒ 401 时自动 refresh 换
    // device_token 并重试一次。这里用「OAuth 形态凭据 + 401 桩」复现该场景。
    {
      const legacyRef = 'QWENWORK_ACCOUNT_LEGACY'
      // OAuth token 在网页域恒 401（fixture 按 token 前缀区分）
      creds.set(legacyRef, { value: JSON.stringify({
        access_token: 'oauth-only-token', refresh_token: 'legacy-refresh',
        expires_at: Date.now() + 3600_000, uid: 'u-legacy', nickname: '',
      }) })
      await ctx.accountPool.addAccount({
        id: 'fixture-qw-legacy', provider, nickname: '历史号',
        credentialRef: legacyRef, enabled: true, refreshable: true, createdAt: 1,
      })
      // 让假上游：带 oauth-only-token 的余额请求回 401；换取后的新 token 回 200
      const previousFetch = globalThis.fetch
      let sawUnauthorized = 0
      globalThis.fetch = async (input, init) => {
        const url = String(input)
        const auth = (() => {
          const h = init?.headers ?? {}
          if (typeof h.get === 'function') return h.get('Authorization') ?? h.get('authorization')
          const k = Object.keys(h).find(x => x.toLowerCase() === 'authorization')
          return k ? h[k] : undefined
        })() ?? ''
        if (url.includes('/user/balance')) {
          if (auth.includes('oauth-only-token')) { sawUnauthorized += 1; return Response.json({ code: 'invalid-credential', msg: 'Invalid JWT token' }, { status: 401 }) }
          return Response.json({ code: 'ok', data: { balance: 777.5, freeze_credit: 0 } })
        }
        if (url.includes('/user/wallets')) return Response.json({ code: 'ok', data: {} })
        return previousFetch(input, init)
      }
      try {
        const healed = await call('credits.balances', { provider })
        const row = healed.value.accounts.find(a => a.accountId === 'fixture-qw-legacy')
        assert.ok(row, '历史账号必须在结果里')
        assert.equal(sawUnauthorized, 1, '网页域必须先真的 401 一次（自愈的触发条件）')
        assert.equal(row.balance?.total, 777,
          `401 后必须换 device_token 并重试成功，实得 ${JSON.stringify(row)}`)
        // 换出的凭据必须落盘（含轮换后的 refresh_token）
        const after = JSON.parse(creds.get(legacyRef).value)
        assert.equal(after.access_token, 'fixture-access-new', '自愈换出的 token 必须落盘')
        assert.equal(after.refresh_token, 'fixture-refresh-new', '轮换后的 refresh_token 必须落盘')
        // ⚠️ **账号池的 expiresAt 也必须随自愈更新**（实测缺陷：凭据已续到 10/22，
        // 池里仍是当天 00:19）。只更新凭据不回写池，面板会一直显示旧的过期时刻。
        const healedEntry = ctx.accountPool.listAccountsByProvider(provider)
          .find(a => a.id === 'fixture-qw-legacy')
        const poolLifetime = healedEntry.expiresAt - Date.now()
        assert.ok(poolLifetime > 6.9 * 86400_000,
          `自愈后必须把新 expiresAt 写回账号池（实得 ${(poolLifetime / 86400_000).toFixed(2)} 天）`)
      } finally {
        globalThis.fetch = previousFetch
        await ctx.accountPool.removeAccount('fixture-qw-legacy').catch(() => {})
        creds.delete(legacyRef)
      }
    }

    // ===== 13. 账号索引恢复表必须覆盖 qwenwork（已复发三次的静默失效坑）=====
    // 背景：`channel-pack-store.ts` 的 `REF_PREFIX_TO_PROVIDER` 用于「state.json 丢失时
    // 从 `.credentials.yaml` 重建账号索引」。**漏加 = 该渠道账号静默消失**
    //（凭据还在，只是索引建不出来，用户只能重新登录）。历史已在 minimax /
    // opencode / gemini 上各漏过一次（源码注释「同款坑第三次」），故这里做
    // **源码级**断言把它锁死 —— 该表是纯声明式常量，静态检查即可覆盖这个陷阱。
    {
      const fsModule = await import('node:fs')
      const pathModule = await import('node:path')
      const urlModule = await import('node:url')
      const sourcePath = fileURLToPath(new URL('../vendor/channel-pack/src/channel-pack-store.ts', import.meta.url))
      const source = fsModule.readFileSync(sourcePath, 'utf8')
      const tableMatch = /const REF_PREFIX_TO_PROVIDER[\s\S]*?\n\]/.exec(source)
      assert.ok(tableMatch, '必须能定位 REF_PREFIX_TO_PROVIDER 恢复表')
      assert.match(tableMatch[0], /\['QWENWORK',\s*'qwenwork'\]/,
        'REF_PREFIX_TO_PROVIDER 必须登记 QWENWORK → qwenwork，否则账号在 state.json 丢失后静默消失')
      // 同名坑的通用防线：每个已注册 provider 都必须在恢复表里有一行
      for (const provider of ['codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn',
        'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'opencode', 'gemini', 'qwenwork']) {
        assert.match(tableMatch[0], new RegExp(`'${provider}'`),
          `恢复表缺 ${provider}（漏加会让该渠道账号在 state.json 丢失后静默消失）`)
      }
      void pathModule
      void urlModule
    }
  } finally {
    globalThis.fetch = originalFetch
    // 清理本用例造的账号与凭据
    await ctx.accountPool.removeAccount('fixture-qwenwork').catch(() => {})
    creds.delete('QWENWORK_ACCOUNT_FIXTURE')
  }
}
