/**
 * 记忆引擎：单一记忆池 + 全局好感度，读走内存、写只追加一行。
 *
 * 事件来源（都在 dsh 0.2.1-rc.4 上验证过存在）：
 * - `session/event`，`event.type === 'user/message'` → 记下用户这一句；
 * - `agent/assistant-stream` 的 `text-delta` / `end` → 拼出我这一轮的回复；
 * - `end` 帧到达即视为一轮结束 → 写一条记忆、结算好感度；
 * - `agent/pre-step` 的 `step === 1` → 给出要注入的文本。
 *
 * 铁律（写死，无开关）：
 * 1. **每次对话开始先读记忆**：任何会话的第一步都注入；读的是内存里的池子，毫秒级。
 * 2. **每次对话结束必写记忆**：一条记忆 = 追加一行 jsonl（几百字节），不重写整份文件。
 * 这两件事同时以**工具**（`memory_read` / `memory_write`）暴露给模型，模型可以主动调。
 *
 * **不按会话分片**：所有对话共用一池记忆与一个好感度，就是大杂烩。
 *
 * @module dsh-go-memory/src/memory/engine
 */

import { levelOf, progressMemory, turnToMemory, applyDelta } from './extract.js'
import { buildMemoryPrompt, summarizeTopics } from './prompt.js'

const MAX_MEMORIES = 500
const PROGRESS_EVERY = 5
const DEFAULT_LIMIT = 8

/** 从宿主 message 里取出可读文本，兼容 string / blocks / 嵌套 content。 */
export function textOfMessage(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === 'string') return block
        if (block !== null && typeof block === 'object') {
          if (typeof block.text === 'string') return block.text
          if (typeof block.content === 'string') return block.content
        }
        return ''
      })
      .filter(part => part !== '')
      .join('\n')
  }
  if (typeof message?.text === 'string') return message.text
  return ''
}

export function createEngine({ store, config = {}, logger }) {
  const settings = {
    injectEvery: Math.max(1, Number(config.injectEvery ?? 1)),
    memoriesPerPrompt: Math.max(1, Number(config.memoriesPerPrompt ?? 6) || 6),
    maxMemoryChars: Math.max(60, Number(config.maxMemoryChars ?? 180) || 180),
    affectionStart: Math.max(0, Number(config.affectionStart ?? 50) || 50),
  }

  const buffers = new Map()    // sessionId -> { user, assistant }
  const injectedAt = new Map() // sessionId -> 上次注入时的 turns
  const perf = { reads: 0, readMs: 0, writes: 0, writeMs: 0, injected: 0, injectMs: 0 }
  let topicsCache = { dirty: true, list: [] }

  function buffer(sessionId) {
    const key = String(sessionId ?? '')
    if (buffers.has(key)) return buffers.get(key)
    const value = { user: '', assistant: '' }
    buffers.set(key, value)
    return value
  }

  function pool() {
    const data = store.state()
    data.affection ??= { score: settings.affectionStart, updatedAt: 0, gainedToday: 0, history: [] }
    data.counts ??= { turns: 0, writes: 0, injected: 0 }
    data.memories ??= []
    return data
  }

  function topics() {
    if (topicsCache.dirty) {
      topicsCache = { dirty: false, list: summarizeTopics(pool().memories.slice(-20), 6) }
    }
    return topicsCache.list
  }

  function onUserMessage(sessionId, text) {
    if (sessionId === undefined || sessionId === '') return
    const buf = buffer(sessionId)
    buf.user = String(text ?? '').trim()
    buf.assistant = ''
  }

  function onAssistantDelta(sessionId, text) {
    if (sessionId === undefined || sessionId === '') return
    if (typeof text !== 'string' || text === '') return
    buffer(sessionId).assistant += text
  }

  /**
   * 写一条记忆的唯一入口。
   *
   * 成本 = 一次数组 push + 一行 appendFileSync + 一次计数，**不序列化整池**。
   */
  function appendMemory(entry, { now = Date.now() } = {}) {
    const started = Date.now()
    const data = pool()
    const row = {
      at: Number(entry.at ?? now),
      text: String(entry.text ?? ''),
      kind: String(entry.kind ?? 'turn'),
      bucket: String(entry.bucket ?? 'chat'),
      topics: Array.isArray(entry.topics) ? entry.topics : [],
    }
    if (row.text === '') return undefined
    store.append(row)
    data.counts.writes = Number(data.counts.writes ?? 0) + 1
    topicsCache.dirty = true
    store.touch()
    if (data.memories.length > MAX_MEMORIES) store.compact(MAX_MEMORIES)
    perf.writes += 1
    perf.writeMs += Date.now() - started
    return row
  }

  /** 铁律 2：一轮结束 → 写记忆 + 结算好感度。 */
  function finishTurn(sessionId, { now = Date.now() } = {}) {
    if (sessionId === undefined || sessionId === '') return undefined
    const buf = buffer(sessionId)
    if (buf.user === '' && buf.assistant === '') return undefined
    const memory = turnToMemory({
      userText: buf.user,
      assistantText: buf.assistant,
      now,
      maxChars: settings.maxMemoryChars,
    })
    appendMemory(memory, { now })
    const data = pool()
    data.counts.turns = Number(data.counts.turns ?? 0) + 1
    const before = Number(data.affection.score ?? settings.affectionStart)
    const next = applyDelta(data.affection, memory.affectionDelta, now)
    data.affection = {
      ...data.affection,
      ...next,
      history: [...(data.affection?.history ?? []), { at: now, from: before, to: next.score, delta: memory.affectionDelta }].slice(-50),
    }
    if (data.counts.turns % PROGRESS_EVERY === 0) {
      const entry = progressMemory({
        topics: topics().slice(0, 4),
        turns: data.counts.turns,
        from: data.memories.find(row => row.kind === 'turn')?.at ?? now,
        to: now,
        now,
      })
      appendMemory(entry, { now })
    }
    buf.user = ''
    buf.assistant = ''
    // jsonl 每条已落盘；元信息合并写，不阻塞回复。
    store.touch()
    return memory
  }

  /** 铁律 1：该不该注入、注入什么。读的是内存池，无磁盘 IO。 */
  function promptBlockFor(sessionId) {
    if (sessionId === undefined || sessionId === '') return ''
    const started = Date.now()
    const key = String(sessionId)
    const data = pool()
    if (data.memories.length === 0) return ''
    const turns = Number(data.counts.turns ?? 0)
    const last = Number(injectedAt.get(key) ?? -1)
    if (last >= 0 && turns - last < settings.injectEvery) return ''
    const block = buildMemoryPrompt({
      memories: data.memories,
      affection: data.affection,
      perPrompt: settings.memoriesPerPrompt,
      progress: topics().slice(0, 3).join(' / '),
      isSessionStart: last < 0,
    })
    if (block === '') return ''
    injectedAt.set(key, turns)
    data.counts.injected = Number(data.counts.injected ?? 0) + 1
    store.touch()
    perf.injected += 1
    perf.injectMs += Date.now() - started
    return block
  }

  /** 工具 `memory_read` 的数据面：纯内存切片。 */
  function read(limit = DEFAULT_LIMIT) {
    const started = Date.now()
    const data = pool()
    const rows = data.memories.slice(-Math.max(1, Math.min(50, Number(limit) || DEFAULT_LIMIT)))
    const result = {
      total: data.memories.length,
      score: Number(data.affection.score ?? 0),
      level: levelOf(Number(data.affection.score ?? 0)),
      memories: rows.map(row => ({ at: row.at, text: row.text, kind: row.kind, bucket: row.bucket })),
    }
    perf.reads += 1
    perf.readMs += Date.now() - started
    return result
  }

  /** 工具 `memory_write` 的数据面：手写一条记忆。 */
  function write(text, { bucket, at } = {}) {
    const body = String(text ?? '').trim()
    if (body === '') return undefined
    const chosen = bucket === 'work' || bucket === 'chat' ? bucket : undefined
    return appendMemory({
      text: body,
      kind: 'note',
      bucket: chosen ?? 'chat',
      at: at ?? Date.now(),
    }, { now: at ?? Date.now() })
  }

  function snapshot() {
    const data = pool()
    const rows = data.memories
    let work = 0
    for (const row of rows) if (row.bucket === 'work') work += 1
    return {
      memories: rows,
      affection: {
        score: Number(data.affection.score ?? 0),
        level: levelOf(Number(data.affection.score ?? 0)),
        updatedAt: Number(data.affection.updatedAt ?? 0),
      },
      counts: {
        turns: Number(data.counts.turns ?? 0),
        writes: Number(data.counts.writes ?? 0),
        injected: Number(data.counts.injected ?? 0),
        work,
        total: rows.length,
      },
      topics: topics(),
      settings: { ...settings },
      updatedAt: Number(data.updatedAt ?? 0),
    }
  }

  function reset() {
    store.reset()
    buffers.clear()
    injectedAt.clear()
    topicsCache.dirty = true
  }

  function configure(patch) {
    if (patch?.injectEvery !== undefined) settings.injectEvery = Math.max(1, Number(patch.injectEvery) || 1)
    if (patch?.memoriesPerPrompt !== undefined) settings.memoriesPerPrompt = Math.max(1, Number(patch.memoriesPerPrompt ?? 6) || 6)
  }

  return {
    settings: () => ({ ...settings }),
    configure,
    onUserMessage,
    onAssistantDelta,
    finishTurn,
    promptBlockFor,
    appendMemory,
    read,
    write,
    snapshot,
    reset,
    perf: () => {
      const avg = (total, n) => (n === 0 ? 0 : Math.round((total / n) * 10) / 10)
      return {
        reads: perf.reads,
        readAvgMs: avg(perf.readMs, perf.reads),
        writes: perf.writes,
        writeAvgMs: avg(perf.writeMs, perf.writes),
        injected: perf.injected,
        injectAvgMs: avg(perf.injectMs, perf.injected),
        store: store.timings,
      }
    },
    logger,
  }
}
