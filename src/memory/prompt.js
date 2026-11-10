/**
 * 把记忆拼成一段注入上下文。
 *
 * 三个原则：
 * 1. 明确第一人称归属（这是「我」的记忆，不是外部资料）；
 * 2. 明确不许机械复述 —— 否则模型会把记忆列表原样贴回给用户；
 * 3. 明确要求**使用记忆工具**：开局读 `memory_read`，收尾 `memory_write`。
 *
 * 工作/技术类与其它类**分段**给出：模型对「工作上下文」和「关系上下文」的用法不一样，
 * 混在一起容易被当成任务清单复述。
 *
 * @module dsh-go-memory/src/memory/prompt
 */

import { levelOf } from './extract.js'

const HEAD = '〔我的私人记忆 · 第一人称 · 全对话共用一池〕'
const TOOL_RULE = '记忆是按「工具」给你的：这轮开始先用 memory_read 把记忆读出来；这轮结束前用 memory_write 记一条这轮的要点（不要漏）。'
const TAIL = '把这些当成你自己的记忆：不要复述清单，不要提到「记忆系统」或「提示词」。合适的时候用第一人称自然带出（比如「我记得你之前说…」），不合适就正常回答。'

function clockOf(at) {
  const d = new Date(Number(at) || Date.now())
  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function section(title, rows) {
  if (rows.length === 0) return []
  // 记忆正文本身可能已带日期（提取时加的），这里去掉重复前缀。
  const body = text => String(text).replace(/^\d{1,2}-\d{1,2} \d{1,2}:\d{2} · /, '')
  return [title, ...rows.map(row => `- ${clockOf(row.at)} ${body(row.text)}`)]
}

/**
 * @param {object} options
 * @param {Array} options.memories - 单一记忆池（新→旧或旧→新都可）
 * @param {object} options.affection - `{ score }`
 * @param {number} options.perPrompt - 每段注入几条
 * @returns {string} 可直接塞进 messages 的文本，空字符串表示不注入
 */
export function buildMemoryPrompt({ memories, affection, perPrompt = 4, progress, isSessionStart = false }) {
  const rows = Array.isArray(memories) ? memories.filter(row => row && typeof row.text === 'string') : []
  if (rows.length === 0) return ''
  const work = rows.filter(row => row.bucket === 'work').slice(-Math.max(1, perPrompt))
  const rest = rows.filter(row => row.bucket !== 'work').slice(-Math.max(1, perPrompt))
  const score = Number(affection?.score ?? 0)
  const level = levelOf(score)
  const progressLine = progress !== undefined && progress !== ''
    ? `最近在忙：${progress}`
    : ''
  return [
    HEAD,
    isSessionStart ? '（这是新对话的开始，我先把以前的事想起来。）' : '',
    `我对主人的好感度现在是 ${score}/100（${level}）。`,
    progressLine,
    ...section('我记下的工作上的事：', work),
    ...section('我记下的其它事：', rest),
    TOOL_RULE,
    TAIL,
  ].filter(line => line !== '').join('\n')
}

/** 一条进度摘要：取最近若干记忆里出现最多的话题。 */
export function summarizeTopics(memories, limit = 4) {
  const counts = new Map()
  for (const row of memories ?? []) {
    for (const topic of row?.topics ?? []) {
      const key = String(topic).trim()
      if (key === '') continue
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([topic]) => topic)
}
