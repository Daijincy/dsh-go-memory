/**
 * 记忆落盘 —— 单一记忆池，**追加写 + 内存快照**。
 *
 * 为什么不再整份 JSON 重写：每次读写都把几百条记忆序列化 + 同步落盘，池子越大越慢，
 * 一次写就可能卡几百毫秒。现在拆成两件小事：
 *
 * - `memories.jsonl`：一条记忆一行，写入 = `appendFileSync` 追加一行（几百字节，微秒级）；
 * - `meta.json`：只装好感度 / 计数（几百字节），合并写（默认 400 ms），同步写也很便宜。
 *
 * 读一律走内存里的池子，不再碰磁盘。池子超过上限时做一次压缩（异步重写 jsonl），
 * 不在写路径上同步做大文件操作。
 *
 * 旧文件 `memories.json`（v1 会话分片 / v2 单文件整池）在加载时自动导入 jsonl，
 * 原名改成 `.bak`，历史不丢。
 *
 * @module dsh-go-memory/src/memory/store
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

const VERSION = 3
const META_DELAY = 400

function emptyState() {
  return {
    version: VERSION,
    memories: [],
    affection: { score: 50, updatedAt: 0, gainedToday: 0, history: [] },
    counts: { turns: 0, writes: 0, injected: 0 },
    updatedAt: 0,
  }
}

/** 把旧结构摊平成数组：去重、按时间排序。 */
function flattenLegacy(parsed) {
  const rows = []
  const seen = new Set()
  const push = row => {
    if (row === null || typeof row !== 'object') return
    const key = `${row.at}|${row.text}`
    if (seen.has(key)) return
    seen.add(key)
    rows.push({
      at: Number(row.at ?? Date.now()),
      text: String(row.text ?? ''),
      kind: String(row.kind ?? 'turn'),
      bucket: String(row.bucket ?? 'chat'),
      topics: Array.isArray(row.topics) ? row.topics : [],
    })
  }
  for (const row of parsed.global?.memories ?? []) push(row)
  for (const row of parsed.memories ?? []) push(row)
  for (const sess of Object.values(parsed.sessions ?? {})) {
    for (const row of sess?.memories ?? []) push(row)
  }
  rows.sort((a, b) => a.at - b.at)
  const affection = { ...emptyState().affection }
  let turns = 0
  for (const sess of Object.values(parsed.sessions ?? {})) {
    turns += Number(sess?.counts?.turns ?? 0)
    const score = Number(sess?.affection?.score ?? NaN)
    const at = Number(sess?.affection?.updatedAt ?? sess?.progress?.lastAt ?? 0)
    if (Number.isFinite(score) && at >= Number(affection.updatedAt)) {
      affection.score = score
      affection.updatedAt = at
    }
  }
  if (Number(parsed.affection?.score ?? NaN) >= 0) Object.assign(affection, parsed.affection)
  return {
    memories: rows,
    affection,
    counts: {
      turns: turns || Number(parsed.counts?.turns ?? 0),
      writes: rows.length,
      injected: Number(parsed.counts?.injected ?? parsed.global?.counts?.writes ?? 0),
    },
  }
}

export function resolveDataDir(home) {
  return join(home, 'dsh-go-memory')
}

export function createStore(dataDir) {
  const logFile = join(dataDir, 'memories.jsonl')
  const metaFile = join(dataDir, 'meta.json')
  const legacyFile = join(dataDir, 'memories.json')

  let data = emptyState()
  let loaded = false
  let metaDirty = false
  let metaTimer = 0
  let compacting = false
  const timings = { loadMs: 0, appendMs: 0, metaMs: 0 }

  function load() {
    if (loaded) return data
    loaded = true
    const started = Date.now()
    try {
      if (existsSync(metaFile)) {
        const meta = JSON.parse(readFileSync(metaFile, 'utf8'))
        data.affection = { ...emptyState().affection, ...(meta.affection ?? {}) }
        data.counts = { ...emptyState().counts, ...(meta.counts ?? {}) }
        data.updatedAt = Number(meta.updatedAt ?? 0)
      }
      if (existsSync(logFile)) {
        const raw = readFileSync(logFile, 'utf8')
        for (const line of raw.split('\n')) {
          if (line.trim() === '') continue
          try {
            data.memories.push(JSON.parse(line))
          } catch { /* 坏行跳过 */ }
        }
      } else if (existsSync(legacyFile)) {
        // 一次性迁移：导入 → 写 jsonl → 原件改名 .bak。
        const parsed = JSON.parse(readFileSync(legacyFile, 'utf8'))
        const flat = flattenLegacy(parsed)
        data.memories = flat.memories
        data.affection = flat.affection
        data.counts = flat.counts
        mkdirSync(dataDir, { recursive: true })
        writeFileSync(logFile, flat.memories.map(row => JSON.stringify(row)).join('\n') + (flat.memories.length ? '\n' : ''), 'utf8')
        writeMetaSync()
        renameSync(legacyFile, `${legacyFile}.bak`)
      }
    } catch {
      // 读坏了就当空池：宁可丢历史，也不能让插件起不来。
      data = emptyState()
    }
    timings.loadMs = Date.now() - started
    return data
  }

  function writeMetaSync() {
    try {
      mkdirSync(dataDir, { recursive: true })
      data.updatedAt = Date.now()
      writeFileSync(metaFile, JSON.stringify({
        version: VERSION,
        affection: data.affection,
        counts: data.counts,
        updatedAt: data.updatedAt,
      }), 'utf8')
    } catch { /* 落盘失败不影响本轮回复 */ }
  }

  /** 元信息合并写：默认 400 ms，避免每次写都摸磁盘。 */
  function touch() {
    metaDirty = true
    if (metaTimer !== 0) return
    metaTimer = setTimeout(() => {
      metaTimer = 0
      flush()
    }, META_DELAY)
    metaTimer.unref?.()
  }

  function flush() {
    if (metaTimer !== 0) {
      clearTimeout(metaTimer)
      metaTimer = 0
    }
    if (!metaDirty) return
    metaDirty = false
    const started = Date.now()
    writeMetaSync()
    timings.metaMs = Date.now() - started
  }

  /** 追加一条记忆：只写一行，不重写整个文件。 */
  function append(row) {
    load()
    data.memories.push(row)
    const started = Date.now()
    try {
      mkdirSync(dataDir, { recursive: true })
      appendFileSync(logFile, `${JSON.stringify(row)}\n`, 'utf8')
    } catch { /* 内存里已经有了，下一次压缩会补上 */ }
    timings.appendMs = Date.now() - started
  }

  /** 池子超上限：异步压缩，不阻塞调用方。 */
  function compact(max) {
    load()
    if (compacting || data.memories.length <= max) return
    compacting = true
    const keep = data.memories.slice(-max)
    data.memories = keep
    const body = keep.map(row => `${JSON.stringify(row)}\n`).join('')
    const tmp = `${logFile}.tmp`
    writeFile(tmp, body, 'utf8')
      .then(() => rename(tmp, logFile))
      .catch(() => { /* 下次再试 */ })
      .finally(() => {
        compacting = false
      })
  }

  function state() {
    load()
    return data
  }

  function reset() {
    data = emptyState()
    metaDirty = true
    try {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(logFile, '', 'utf8')
    } catch { /* ignore */ }
    writeMetaSync()
    metaDirty = false
  }

  return { logFile, metaFile, state, append, compact, reset, touch, flush, load, timings }
}
