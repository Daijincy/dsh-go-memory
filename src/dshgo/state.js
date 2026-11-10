/**
 * 面板用的记忆快照 —— 单一池，没有「当前会话」概念。
 *
 * 面板 data 必须同步返回，所以这里只做「读引擎快照」，不碰文件、不等 Promise。
 *
 * @module dsh-go-memory/src/dshgo/state
 */

export function createMemoryState({ engine }) {
  const state = {
    memories: [],
    affection: { score: 0, level: '陌生', updatedAt: 0 },
    counts: { turns: 0, writes: 0, injected: 0, work: 0, total: 0 },
    topics: [],
    settings: {},
    at: 0,
    version: '',
    dataDir: '',
  }

  function refresh() {
    try {
      const snap = engine.snapshot()
      state.memories = snap.memories
      state.affection = snap.affection
      state.counts = snap.counts
      state.topics = snap.topics
      state.settings = snap.settings
      state.at = Date.now()
    } catch (error) {
      console.warn(`[dsh-go-memory] 读取记忆失败：${error?.message ?? error}`)
      state.memories = []
    }
    return state
  }

  function setInjectEvery(value) {
    engine.configure({ injectEvery: Number(value) })
    return engine.settings()
  }

  function reset() {
    engine.reset()
    refresh()
  }

  /** 导出成可读文本。 */
  function exportText() {
    const head = [
      '# 我的记忆（全局一池）',
      `好感度：${state.affection.score}/100（${state.affection.level}）`,
      `记忆 ${state.counts.total} 条，其中工作技术 ${state.counts.work} 条`,
      `写入 ${state.counts.writes} 次，轮次 ${state.counts.turns}，注入 ${state.counts.injected} 次`,
      `话题：${(state.topics ?? []).join(' / ') || '—'}`,
      '',
    ].join('\n')
    const body = state.memories.map(item => `- ${new Date(item.at).toISOString()} ${item.text}`).join('\n')
    return `${head}${body}\n`
  }

  function debug() {
    return {
      version: state.version,
      dataDir: state.dataDir,
      memories: state.counts.total,
      work: state.counts.work,
      score: state.affection.score,
      level: state.affection.level,
      counts: state.counts,
      settings: state.settings,
      perf: engine.perf?.(),
    }
  }

  return { state, refresh, setInjectEvery, reset, exportText, debug, snapshot: () => state }
}
