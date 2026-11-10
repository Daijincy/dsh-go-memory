/**
 * 跨对话「想起来」验证：A 会话说一句 → 新开 B 会话，第一步注入能不能带出那句话。
 *
 * 运行：node test/recall.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const home = mkdtempSync(join(tmpdir(), 'dgm-recall-'))
process.env.DSH_HOME = home
process.env.DGM_MOBILE_PORT = '18922'

const handlers = new Map()
const ctx = {
  on(event, fn) {
    const list = handlers.get(event) ?? []
    list.push(fn)
    handlers.set(event, list)
  },
  get: () => undefined,
  effect(fn) { fn() },
  inject(deps, callback) {
    callback({ dshGo: { panel() {}, strip() {}, refresh() {} }, effect() {} })
  },
}

const { apply } = await import('../index.js')
apply(ctx, { injectEvery: 1, memoriesPerPrompt: 6 })

const secret = '我叫小陈，明天上午考物理，记得提醒我带电学笔记'

async function say(sessionId, userText, replyText) {
  const sess = { id: sessionId }
  for (const fn of handlers.get('session/event') ?? []) {
    fn(sess, { type: 'user/message', data: { role: 'user', content: userText, source: { kind: 'user' } } })
  }
  for (const fn of handlers.get('agent/assistant-stream') ?? []) {
    fn({ agent: { session: sess }, frame: { chunk: { type: 'text-delta', text: replyText } } })
  }
  for (const fn of handlers.get('agent/assistant-stream') ?? []) {
    fn({ agent: { session: sess }, frame: { type: 'end' } })
  }
}

async function openSession(sessionId) {
  const started = performance.now()
  const decision = { kind: 'act', messages: [] }
  const result = await handlers.get('agent/pre-step')[0](
    { agent: { session: { id: sessionId } }, messages: [], step: 1, signal: { throwIfAborted() {} } },
    async () => decision,
  )
  const elapsed = performance.now() - started
  return { text: result.messages[0]?.content?.[0]?.text ?? '', elapsed }
}

// ① 第一个对话里说这句
await say('conv-A', secret, '记住了，明天物理带电学笔记。')
console.log('① A 对话说：', secret)

// ② 立刻新开一个对话（会话 ID 完全不同）
const fresh = await openSession('conv-B-全新的对话')
console.log(`② 新对话第一步注入 ${fresh.text.length} 字符，耗时 ${fresh.elapsed.toFixed(2)} ms`)
console.log('---- 注入原文 ----')
console.log(fresh.text)
console.log('------------------')

assert.ok(fresh.text.includes('小陈'), '新对话开局必须带出名字')
assert.ok(fresh.text.includes('物理'), '新对话开局必须带出物理这件事')
assert.ok(fresh.text.includes('电学'), '细节也得带上')
assert.ok(fresh.elapsed < 1000, `注入耗时 ${fresh.elapsed.toFixed(1)} ms，超过 1 秒`)

// ③ 新对话继续聊，验证写入不串、且能续上一条新的
await say('conv-B-全新的对话', '那我该带啥？', '带笔记和尺子就行。')
const third = await openSession('conv-C-第三个对话')
const fourth = await openSession('conv-C-第三个对话')
console.log(`③ 第三个对话首次注入 ${third.text.length} 字符（${third.elapsed.toFixed(2)} ms）；同会话第二步注入 ${fourth.text.length} 字符`)
assert.ok(third.text.length > 0, '新会话要注入')
assert.equal(fourth.text.length, 0, '同一会话已经注入过，第二步不重复塞')

console.log('\n跨对话记住并想起来：通过')
rmSync(home, { recursive: true, force: true })
process.exit(0)
