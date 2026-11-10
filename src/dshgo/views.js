/**
 * dsh-go 原生视图（协议 v1，纯函数）。
 *
 * 四个面板：记忆 / 工作记忆 / 好感度 / 聊天进程。全部读单一池快照，不读文件、不分会话。
 * 约束：视图 ≤ 32 KiB、≤ 120 节点、≤ 8 层、列表 ≤ 50 行。
 *
 * @module dsh-go-memory/src/dshgo/views
 */

const MAX_LIST = 50

function text(value, tone) {
  const node = { type: 'text', text: String(value) }
  if (tone !== undefined) node.tone = tone
  return node
}

function callout(value, tone) {
  const node = { type: 'callout', text: String(value) }
  if (tone !== undefined) node.tone = tone
  return node
}

function keyValue(items) {
  return { type: 'keyValue', items }
}

function actions(items) {
  return { type: 'actions', items }
}

function clockOf(at) {
  const value = Number(at)
  if (!Number.isFinite(value) || value <= 0) return '—'
  const d = new Date(value)
  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function rowsOf(state) {
  return Array.isArray(state?.memories) ? state.memories : []
}

/** 面板一：记忆（全部，第一人称 + 时间戳，新的在上）。 */
export function memoryView(state) {
  const memories = rowsOf(state)
  if (memories.length === 0) {
    return {
      type: 'stack',
      children: [
        callout('记忆池还是空的。这轮结束就会写第一条（也会走 memory_write 工具）。', 'info'),
        text('全部对话共用这一池，不按会话分开；每条都带时间戳，用第一人称写。', 'muted'),
        actions([{ label: '刷新', action: 'refresh', icon: 'refresh', style: 'primary' }]),
      ],
    }
  }
  const ordered = [...memories].reverse()
  return {
    type: 'stack',
    children: [
      callout(`记忆 ${state.counts.total} 条 · 工作技术 ${state.counts.work} 条 · 好感度 ${state.affection.score}/100（${state.affection.level}）`, 'good'),
      {
        type: 'list',
        items: ordered.slice(0, MAX_LIST).map(item => ({
          title: item.text,
          subtitle: item.kind === 'progress'
            ? '进程'
            : (item.kind === 'note' ? '手写' : (item.bucket === 'work' ? '技术' : '对话')),
          trailing: clockOf(item.at),
        })),
      },
      actions([
        { label: '刷新', action: 'refresh', icon: 'refresh', style: 'primary' },
        { label: '复制全部', action: 'copyAll', icon: 'copy' },
      ]),
      text(`写入 ${state.counts.writes} 次 · 轮次 ${state.counts.turns} · 注入 ${state.counts.injected} 次`, 'muted'),
    ],
  }
}

/** 面板二：工作记忆（只放技术类）。 */
export function workView(state) {
  const work = rowsOf(state).filter(item => item.bucket === 'work')
  if (work.length === 0) {
    return {
      type: 'stack',
      children: [
        callout('工作分区还空着。', 'info'),
        text('一轮里出现代码、端口、部署、报错、接口这类内容，或者模型调 memory_write 时标了 work，就会归到这里。', 'muted'),
        actions([{ label: '刷新', action: 'refresh', icon: 'refresh', style: 'primary' }]),
      ],
    }
  }
  return {
    type: 'stack',
    children: [
      callout(`工作技术类 ${work.length} 条 / 全部 ${rowsOf(state).length} 条`, 'good'),
      {
        type: 'list',
        items: [...work].reverse().slice(0, MAX_LIST).map(item => ({
          title: item.text,
          subtitle: item.kind === 'progress' ? '进程' : (item.kind === 'note' ? '手写' : '技术'),
          trailing: clockOf(item.at),
        })),
      },
      actions([
        { label: '刷新', action: 'refresh', icon: 'refresh', style: 'primary' },
        { label: '复制工作记忆', action: 'copyWork', icon: 'copy' },
      ]),
    ],
  }
}

/** 面板三：好感度（全局一个分数）。 */
export function affectionView(state) {
  const score = Number(state?.affection?.score ?? 0)
  const level = String(state?.affection?.level ?? '陌生')
  return {
    type: 'stack',
    children: [
      callout(`现在对主人的好感度：${score}/100 · ${level}`, score >= 60 ? 'good' : (score >= 20 ? 'info' : 'warn')),
      { type: 'progress', value: score, max: 100 },
      keyValue([
        ['分数', `${score}/100`],
        ['等级', level],
        ['轮次', `${state.counts.turns}`],
        ['已注入', `${state.counts.injected} 次`],
        ['写入', `${state.counts.writes} 次`],
        ['全局记忆', `${state.counts.total} 条（工作 ${state.counts.work}）`],
        ['最近互动', clockOf(state.affection.updatedAt)],
      ]),
      text('每聊一轮 +2 起；暖话加成，冷话扣分；单日最多涨 8，扣分不封顶。分数全局一个，只在本机。', 'muted'),
      actions([
        { label: '刷新', action: 'refresh', icon: 'refresh', style: 'primary' },
        { label: '复制记忆', action: 'copyAll', icon: 'copy' },
      ]),
    ],
  }
}

/** 面板四：聊天进程（轮次、话题、注入频率、工具契约）。 */
export function progressView(state) {
  const topics = (state?.topics ?? []).slice(0, 6)
  return {
    type: 'stack',
    children: [
      keyValue([
        ['记忆条数', `${state.counts.total}（工作 ${state.counts.work}）`],
        ['轮次', `${state.counts.turns}`],
        ['写入', `${state.counts.writes} 次`],
        ['注入', `${state.counts.injected} 次`],
        ['最近一条', clockOf(state.memories[state.memories.length - 1]?.at)],
        ['注入频率', state.settings?.injectEvery === 1 ? '每轮都读' : `每 ${state.settings?.injectEvery} 轮`],
      ]),
      callout(topics.length > 0 ? `最近在忙：${topics.join(' / ')}` : '还没有形成明确的话题', topics.length > 0 ? 'good' : 'info'),
      text('铁律：每次对话开始先读记忆（memory_read），每次对话结束必写记忆（memory_write）；插件自己也兜底，模型不调也不会漏。', 'muted'),
      actions([
        { label: '每次都读记忆', action: 'injectAlways', icon: 'refresh', style: 'primary' },
        { label: '每 3 轮读一次', action: 'injectEvery3', icon: 'refresh' },
      ]),
    ],
  }
}

/** 输入框上方状态条。 */
export function stripLabel(state, extra) {
  const tail = String(extra ?? '') === '' ? '' : ` · ${extra}`
  if ((state?.memories ?? []).length === 0) return `记忆 · 空${tail}`.slice(0, 24)
  return `记忆 ${state.counts.total} · ♥${state.affection.score}${tail}`.slice(0, 24)
}
