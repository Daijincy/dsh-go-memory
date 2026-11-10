/**
 * 一轮对话 → 一条第一人称记忆 + 好感度变化。
 *
 * 全部本地计算、纯函数，不额外调模型：这样每轮都稳、离线可用、不花额度，
 * 也能保证同样的输入永远得到同样的记忆（落盘可复核）。需要更强提炼时，
 * 上层可以把「关键段落」换成模型结论再喂给这里。
 *
 * @module dsh-go-memory/src/memory/extract
 */

const WARM_WORDS = ['谢谢', '感谢', '辛苦', '喜欢你', '喜欢', '好棒', '厉害', '可爱', '拜托', '麻烦你', '真好', '爱你', '么么', '抱抱']
const COLD_WORDS = ['滚', '闭嘴', '讨厌你', '讨厌', '垃圾', '废物', '烦死', '没用', '傻', '蠢', '别废话']
const TASK_WORDS = ['做', '改', '修', '写', '加', '删', '实现', '适配', '测试', '打包', '部署', '编译', '跑通', '排查', '定位', '优化']

const WORK_WORDS = ['代码', '插件', '端口', '部署', '编译', '打包', '仓库', '报错', '日志', '接口', '配置',
  '安装', '命令', '脚本', '版本', '构建', '测试', '运行', '进程', '服务', '文件', '目录', '函数',
  '组件', '协议', '清单', '校验', '注入', '上下文', '模型', '面板', '视图', '数据结构', '数据库',
  '终端', '服务器', '权限', '密钥', '环境变量', '异常', '崩溃', '方案', '架构', '思路',
  'npm', 'git', 'json', 'api', 'bug', 'dsh', 'dsh-go', 'cordis', 'node', 'python', 'kotlin',
  'flutter', 'docker', 'nginx', 'sql', 'http', 'android', 'ios']

const DAY_MS = 24 * 60 * 60 * 1000

export const LEVELS = [
  { min: 0, name: '陌生' },
  { min: 20, name: '客气' },
  { min: 40, name: '熟悉' },
  { min: 60, name: '亲近' },
  { min: 75, name: '信赖' },
  { min: 90, name: '心有灵犀' },
]

export function levelOf(score) {
  let level = LEVELS[0]
  for (const candidate of LEVELS) {
    if (score >= candidate.min) level = candidate
  }
  return level.name
}

/** 去掉换行、多余空白与首尾引号，超长截断时保留句尾省略号。 */
export function clean(text, max = 180) {
  const value = String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^["'「『]|["'」』]$/g, '')
    .trim()
  if (value.length <= max) return value
  return `${value.slice(0, max)}…`
}

function clockOf(date) {
  const d = new Date(date)
  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 一段话在讲工作技术，还是在讲别的。 */
export function bucketOf(text, assistantText = '') {
  const joined = `${text ?? ''} ${assistantText ?? ''}`
  if (joined.trim() === '') return 'chat'
  const lower = joined.toLowerCase()
  let hits = 0
  for (const word of WORK_WORDS) {
    if (lower.includes(word.toLowerCase())) hits += 1
  }
  // 带代码痕迹的：反引号、源码文件名、绝对路径、--flag，命中即算技术。
  const codeSign = /`|\b[\w-]+\.(js|ts|json|yml|yaml|mjs|py|kt|md)\b|\/(home|usr|tmp|var)\/|--[a-z]/.test(joined)
  if (codeSign) hits += 2
  return hits >= 2 ? 'work' : 'chat'
}

/** 从一段话里挑出更像「话题」的短句：去掉寒暄与标点，取最长的两段。 */
export function topicsOf(text, limit = 3) {
  const raw = String(text ?? '')
  const parts = raw
    .split(/[。！？；\n,，:：]/)
    .map(part => part.trim())
    .filter(part => part.length >= 4 && part.length <= 40)
  const seen = new Set()
  const picked = []
  for (const part of parts) {
    const key = part.slice(0, 12)
    if (seen.has(key)) continue
    seen.add(key)
    picked.push(part)
    if (picked.length >= limit) break
  }
  return picked
}

/**
 * 计算这一轮对好感度的影响。
 *
 * 规则尽量「可解释」：基础 +2（愿意继续聊），字数多 +1（投入），
 * 暖词每命中一个 +1（上限 +3），冷词每命中一个 -3（下限 -9），
 * 同一天累计上涨最多 +8，下降不设日限。
 */
export function affectionDelta(userText) {
  const text = String(userText ?? '')
  const hitsWarm = WARM_WORDS.filter(word => text.includes(word)).length
  const hitsCold = COLD_WORDS.filter(word => text.includes(word)).length
  let delta = 2
  if (text.length >= 80) delta += 1
  if (text.length >= 300) delta += 1
  delta += Math.min(3, hitsWarm)
  delta -= Math.min(9, hitsCold * 3)
  return { delta, warm: hitsWarm, cold: hitsCold }
}

/** 好感度按自然日封顶，并把分数夹在 0..100。 */
export function applyDelta(affection, delta, now = Date.now()) {
  const score = Number(affection?.score ?? 50)
  const sameDay = Number(affection?.updatedAt ?? 0) > 0
    && new Date(affection.updatedAt).toDateString() === new Date(now).toDateString()
  const gainedToday = sameDay ? Number(affection?.gainedToday ?? 0) : 0
  let gain = delta > 0 ? Math.max(0, Math.min(delta, 8 - gainedToday)) : delta
  const next = Math.max(0, Math.min(100, score + gain))
  return {
    score: next,
    updatedAt: now,
    gainedToday: delta > 0 ? gainedToday + Math.max(0, next - score) : gainedToday,
    level: levelOf(next),
  }
}

/**
 * 把一轮对话压成一条第一人称记忆。
 *
 * @returns `{ text, topics, affection }`，text 里带时间戳与「主人/我」的说话人视角。
 */
export function turnToMemory({ userText, assistantText, now = Date.now(), maxChars = 180 }) {
  const user = clean(userText, Math.round(maxChars * 0.6))
  const assistant = clean(assistantText, Math.round(maxChars * 0.6))
  const topics = topicsOf(user !== '' ? user : assistant)
  const pieces = []
  if (user !== '') pieces.push(`主人跟我说：「${user}」`)
  if (assistant !== '') pieces.push(`我回了他：${assistant}`)
  const text = pieces.join('；')
  const { delta, warm, cold } = affectionDelta(userText)
  return {
    text,
    at: now,
    kind: 'turn',
    bucket: bucketOf(userText, assistantText),
    topics,
    user,
    assistant,
    sentiment: { warm, cold },
    affectionDelta: delta,
  }
}

/** 若干轮之后的一条「进程」记忆：这段时间在忙什么。 */
export function progressMemory({ topics, turns, from, to, now = Date.now() }) {
  const list = (topics ?? []).filter(topic => String(topic).trim() !== '').slice(0, 4)
  const span = from > 0 ? `${clockOf(from)} → ${clockOf(to ?? now)}` : clockOf(now)
  const body = list.length > 0 ? `我们在忙这些：${list.join(' / ')}` : '我们聊了一阵子，没什么明确的任务'
  return {
    text: `${body}（共 ${turns} 轮，${span}）`,
    at: now,
    kind: 'progress',
    bucket: 'work',
    topics: list,
    turns,
  }
}

export function isSameDay(a, b) {
  return Math.abs(Number(a) - Number(b)) < DAY_MS
}
