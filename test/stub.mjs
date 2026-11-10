/**
 * 本地 stub 验证：不装宿主，用假 ctx 走完整链路（单池版）。
 *
 * 覆盖：
 * 1. user/message + assistant-stream → 一条记忆、全局好感度；
 * 2. `agent/pre-step` 第一步注入池子里的记忆（含别的会话写的）；
 * 3. `memory_read` / `memory_write` 两个工具真的注册且能执行；
 * 4. 四个面板视图可序列化、体积在协议内；
 * 5. 管理页 /api/status、/api/memory、清空。
 *
 * 运行：node test/stub.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const home = mkdtempSync(join(tmpdir(), 'dgm-'))
process.env.DSH_HOME = home
const PORT = Number(process.env.DGM_MOBILE_PORT ?? 18921)
process.env.DGM_MOBILE_PORT = String(PORT)

const handlers = new Map()
const panels = []
const tools = []
let stripFn

const ctx = {
  on(event, fn) {
    const list = handlers.get(event) ?? []
    list.push(fn)
    handlers.set(event, list)
  },
  get(name) {
    if (name === 'tools') {
      return { register: definition => { tools.push(definition); return () => {} } }
    }
    return undefined
  },
  effect(fn) { fn() },
  inject(deps, callback) {
    callback({
      dshGo: {
        panel(id, options) { panels.push({ id, options }) },
        strip(id, fn) { stripFn = fn },
        refresh() {},
      },
      effect() {},
    })
  },
}

const { apply } = await import('../index.js')
apply(ctx, { injectEvery: 1, memoriesPerPrompt: 4 })

function turn(sessionId, userText, replyText) {
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

// —— 第 1 轮 ——
turn('sess-1', '帮我把记忆插件改成单一池，端口 18920 那个服务也别动，谢谢！', '好的，我先把存储改成单池。')

const status = await fetch(`http://127.0.0.1:${PORT}/api/status`).then(r => r.json())
assert.equal(status.memories, 1, '一轮之后池子里应当有 1 条')
assert.ok(status.score >= 50, '好感度应当起步在 50 以上')
console.log('✓ 单池写入 + 好感度：', status.memories, '条，分数', status.score)

// —— 工具真的注册了 ——
assert.equal(tools.length, 2, '应当注册 memory_read / memory_write 两个工具')
assert.deepEqual(tools.map(t => t.name).sort(), ['memory_read', 'memory_write'])
const readTool = tools.find(t => t.name === 'memory_read')
const writeTool = tools.find(t => t.name === 'memory_write')

const readResult = await readTool.execute({ limit: 5 })
assert.match(readResult.detail, /共 1 条记忆|共 \d+ 条记忆/)
console.log('✓ memory_read：', readResult.detail.split('\n')[0])

const writeResult = await writeTool.execute({ text: '主人要求记忆不按会话分，我改成单池并测通了。', bucket: 'work' })
assert.match(writeResult.detail, /已记下/)
const afterWrite = await fetch(`http://127.0.0.1:${PORT}/api/status`).then(r => r.json())
assert.equal(afterWrite.memories, 2, 'memory_write 应当多写一条')
console.log('✓ memory_write：', writeResult.detail.slice(0, 40))

// —— 性能：读、写都要远低于 1 秒（这里按毫秒级卡） ——
const n = 200
const writeSamples = []
for (let i = 0; i < n; i++) {
  const started = performance.now()
  await writeTool.execute({ text: `批量写入第 ${i + 1} 条，验证追加写成本。`, bucket: 'work' })
  writeSamples.push(performance.now() - started)
}
const readSamples = []
for (let i = 0; i < n; i++) {
  const started = performance.now()
  await readTool.execute({ limit: 8 })
  readSamples.push(performance.now() - started)
}
const worst = arr => Math.max(...arr)
const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length
assert.ok(worst(writeSamples) < 1000, `单次写入最差 ${worst(writeSamples).toFixed(1)} ms，超过 1 秒`)
assert.ok(worst(readSamples) < 1000, `单次读取最差 ${worst(readSamples).toFixed(1)} ms，超过 1 秒`)
assert.ok(avg(writeSamples) < 20, `写入均值 ${avg(writeSamples).toFixed(1)} ms，偏慢`)
assert.ok(avg(readSamples) < 5, `读取均值 ${avg(readSamples).toFixed(1)} ms，偏慢`)
console.log(`✓ 性能：写 ${n} 次 均值 ${avg(writeSamples).toFixed(2)} ms / 最差 ${worst(writeSamples).toFixed(2)} ms；读 均值 ${avg(readSamples).toFixed(2)} ms / 最差 ${worst(readSamples).toFixed(2)} ms`)

// —— 注入 ——
async function preStep(step, sessionId) {
  const list = handlers.get('agent/pre-step') ?? []
  const decision = { kind: 'act', messages: [] }
  return list[0]({ agent: { session: { id: sessionId } }, messages: [], step, signal: { throwIfAborted() {} } }, async () => decision)
}

const first = await preStep(1, 'sess-1')
assert.equal(first.messages.length, 1, '第一步应当注入一条记忆')
const injectedText = first.messages[0].content[0].text
assert.match(injectedText, /好感度/)
assert.match(injectedText, /memory_read/)
console.log('✓ 注入（铁律 1）：', injectedText.length, '字符，含工具要求')

assert.equal((await preStep(2, 'sess-1')).messages.length, 0, '非首步不注入')

const other = await preStep(1, 'sess-brand-new')
assert.equal(other.messages.length, 1, '任何会话第一步都得注入')
assert.match(other.messages[0].content[0].text, /新对话的开始/)
console.log('✓ 跨对话：新会话开局注入', other.messages[0].content[0].text.length, '字符')

// —— 再聊一轮，分区与计数 ——
turn('sess-1', '继续，辛苦了', '应该的。')
const memory = await fetch(`http://127.0.0.1:${PORT}/api/memory`).then(r => r.json())
assert.ok(memory.counts.total >= 3)
assert.ok(memory.counts.work >= 2, "工作类条目应当 ≥ 2")
console.log('✓ 三轮：总数', memory.counts.total, '工作', memory.counts.work, '分数', memory.affection.score)

// —— 面板 ——
assert.equal(panels.length, 4, '应当注册 4 个面板')
const sizes = {}
for (const panel of panels) {
  const view = panel.options.view()
  const size = JSON.stringify(view).length
  sizes[panel.id] = size
  assert.ok(size < 32 * 1024, `${panel.id} 超过 32 KiB`)
  assert.equal(view.type, 'stack')
}
console.log('✓ 视图体积：', JSON.stringify(sizes))
console.log('✓ 状态条：', stripFn?.())

const page = await fetch(`http://127.0.0.1:${PORT}/`).then(r => r.text())
assert.ok(page.includes('我的记忆'))
console.log('✓ 管理页', page.length, '字节')

await fetch(`http://127.0.0.1:${PORT}/api/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
const cleared = await fetch(`http://127.0.0.1:${PORT}/api/status`).then(r => r.json())
assert.equal(cleared.memories, 0, '清空后池子为空')
console.log('✓ 清空生效')

rmSync(home, { recursive: true, force: true })
console.log('\n全部通过')
process.exit(0)
