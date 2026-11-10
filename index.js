/**
 * dsh-go-memory —— 每轮自动记第一人称记忆 + 好感度，并把记忆注入后续回复。
 *
 * 宿主接口（都在 dsh 0.2.1-rc.4 上核过）：
 * - `session/event`：`user/message` 拿到主人这一句；
 * - `agent/assistant-stream`：`text-delta` 拼我的回复，`end` 收尾一轮；
 * - `agent/pre-step`：waterfall，`decision.messages` 可插消息 —— 官方
 *   `dsh-agent-instructions` 就是用这条通道往上下文里塞指令的，这里照抄同一形状。
 *
 * 不声明服务依赖：只监听事件，缺什么都没关系，插件不会把宿主拖成 pending。
 *
 * @module dsh-go-memory
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createStore, resolveDataDir } from './src/memory/store.js'
import { createEngine, textOfMessage } from './src/memory/engine.js'
import { registerMemoryTools } from './src/memory/tools.js'
import { mountDshGo } from './src/dshgo/bridge.js'

export const name = 'dsh-go-memory'
export const inject = []

const VERSION = '0.1.0-dshgo.1'

function resolveHome(ctx) {
  try {
    const paths = typeof ctx.get === 'function' ? ctx.get('homePaths') : undefined
    if (paths?.home !== undefined) return String(paths.home)
    if (paths?.dshHome !== undefined) return String(paths.dshHome)
  } catch {
    // 没有 homePaths 就退回环境变量，再退回 ~/.dsh。
  }
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** 宿主消息的权威构造器；拿不到时用等价字面量兜底。 */
let createUserMessage
async function messageFor(text) {
  const source = { kind: name, form: 'instructions', changes: [] }
  try {
    if (createUserMessage === undefined) {
      const mod = await import('@deepseek-ai/dsh-llm')
      createUserMessage = mod.createUserMessage
    }
    if (typeof createUserMessage === 'function') {
      return createUserMessage({ content: [{ type: 'text', text }], source })
    }
  } catch {
    // 宿主没暴露该模块时走下面的兜底形状，字段与官方一致。
  }
  // 与 dsh-llm 的 createUserMessage 等价：role + content + source + id，冻结后交给宿主。
  const message = { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source }
  Object.freeze(message)
  Object.freeze(message.content)
  Object.freeze(message.content[0])
  return message
}

export function apply(ctx, config = {}) {
  const home = resolveHome(ctx)
  const store = createStore(resolveDataDir(home))
  const engine = createEngine({ store, config, logger: console })

  const announced = new Set()

  const sessionIdOf = agent => {
    const raw = agent?.session?.id
    return typeof raw === 'string' ? raw : (typeof agent?.sessionId === 'string' ? agent.sessionId : '')
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'user/message') return
      const sessionId = String(session?.id ?? session?.sessionId ?? '')
      const message = event.data?.message ?? event.data
      // 自己注入的那条不算主人的话，否则会自己喂自己。
      const sourceKind = message?.source?.kind
      if (sourceKind === name) return
      const text = textOfMessage(message)
      if (text === '') return
      engine.onUserMessage(sessionId, text)
    } catch (error) {
      console.warn(`[dsh-go-memory] 记录用户消息失败：${error?.message ?? error}`)
    }
  })

  ctx.on('agent/assistant-stream', payload => {
    try {
      const sessionId = sessionIdOf(payload?.agent)
      if (sessionId === '') return
      const frame = payload?.frame
      if (frame === null || typeof frame !== 'object') return
      if (frame.type === 'end') {
        engine.finishTurn(sessionId)
        return
      }
      const chunk = frame.chunk
      if (chunk !== null && typeof chunk === 'object' && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        engine.onAssistantDelta(sessionId, chunk.text)
      }
    } catch (error) {
      console.warn(`[dsh-go-memory] 处理流帧失败：${error?.message ?? error}`)
    }
  }, { global: true })

  ctx.on('agent/pre-step', async ({ agent, messages, step }, next) => {
    const decision = await next()
    try {
      if (step !== 1) return decision
      if (decision?.kind === 'reject') return decision
      const sessionId = sessionIdOf(agent)
      const block = engine.promptBlockFor(sessionId)
      if (block === '') return decision
      if (!announced.has(sessionId)) {
        announced.add(sessionId)
        console.log(`[记忆] 已注入 ${block.length} 字符（会话 ${String(sessionId).slice(0, 8)}）`)
      }
      const message = await messageFor(block)
      const list = Array.isArray(decision.messages) ? decision.messages : []
      const anchor = list.findLastIndex(item => item?.role === 'user')
      const next = anchor >= 0 ? list.toSpliced(anchor, 0, message) : [...list, message]
      return { ...decision, messages: next }
    } catch (error) {
      console.warn(`[dsh-go-memory] 注入记忆失败：${error?.message ?? error}`)
      return decision
    }
  })

  // 读写记忆以工具形式暴露（memory_read / memory_write）。
  let disposeTools = () => {}
  try {
    disposeTools = registerMemoryTools(ctx, { engine })
  } catch (error) {
    console.warn(`[dsh-go-memory] 注册记忆工具失败：${error?.message ?? error}`)
  }

  let dispose = () => {}
  try {
    dispose = mountDshGo(ctx, { engine, store, version: VERSION, dataDir: resolveDataDir(home) })
  } catch (error) {
    console.warn(`[dsh-go-memory] dsh-go 适配挂载失败：${error?.message ?? error}`)
  }

  ctx.effect(() => () => {
    try {
      store.flush()
    } catch { /* ignore */ }
    try {
      dispose()
    } catch { /* ignore */ }
    try {
      disposeTools()
    } catch { /* ignore */ }
  })
}

export { VERSION as version }
