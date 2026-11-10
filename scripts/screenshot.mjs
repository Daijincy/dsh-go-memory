/**
 * 生成 README 用的管理页截图：起一个假宿主跑插件，用 headless chromium 拍页面。
 *
 * 运行：node scripts/screenshot.mjs [输出目录]
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const outDir = process.argv[2] ?? 'docs'
const home = mkdtempSync(join(tmpdir(), 'dgm-shot-'))
process.env.DSH_HOME = home
process.env.DGM_MOBILE_PORT = '18923'

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

async function openSession(id) {
  const decision = { kind: 'act', messages: [] }
  return handlers.get('agent/pre-step')[0](
    { agent: { session: { id } }, messages: [], step: 1, signal: { throwIfAborted() {} } },
    async () => decision,
  )
}

await openSession('demo')

const lines = [
  ['主人说他明天要考物理，我提醒他带电学笔记。', '高一下午的物理，笔记比刷题有用。'],
  ['主人让我把 dsh-go-memory 的读写成到 1 秒以内，我改成了追加写。', '已经压到 0.04 ms，池子再大也不回退了。'],
  ['主人吐槽三个插件的状态条打架，我们把它们并成了一条。', 'composer.strip 只容得下一个，并进去更省地方。'],
  ['主人说想做微信公众号桥接，还要求能扫码登录。', '原生面板画不了二维码，只能挂本机管理页。'],
]

for (const [user, reply] of lines) {
  const sess = { id: 'demo' }
  for (const fn of handlers.get('session/event') ?? []) {
    fn(sess, { type: 'user/message', data: { role: 'user', content: user, source: { kind: 'user' } } })
  }
  for (const fn of handlers.get('agent/assistant-stream') ?? []) {
    fn({ agent: { session: sess }, frame: { chunk: { type: 'text-delta', text: reply } } })
  }
  for (const fn of handlers.get('agent/assistant-stream') ?? []) {
    fn({ agent: { session: sess }, frame: { type: 'end' } })
  }
}

await openSession('demo-new-conversation')
await new Promise(resolve => setTimeout(resolve, 600))
mkdirSync(outDir, { recursive: true })

const shots = [
  { path: 'preview-memory.png', width: 480, height: 1280, scroll: 0 },
  { path: 'preview-full.png', width: 1000, height: 900, scroll: 0 },
]

for (const shot of shots) {
  await run('chromium', [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    `--window-size=${shot.width},${shot.height}`,
    `--screenshot=${join(outDir, shot.path)}`,
    'http://127.0.0.1:18923/',
  ], { timeout: 30_000 })
  console.log('✓', join(outDir, shot.path))
}

rmSync(home, { recursive: true, force: true })
process.exit(0)
