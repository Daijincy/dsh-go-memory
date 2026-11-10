/**
 * 注册 4 个 dsh-go 原生面板 + 1 条状态条。
 *
 * 只走 `ctx.dshGo` 的公开接口；桌面 dsh / TUI 上不会进这个回调，其余逻辑照常跑。
 * 数据面是单一记忆池，没有「当前会话」。
 *
 * @module dsh-go-memory/src/dshgo/panels
 */

import { memoryView, workView, affectionView, progressView, stripLabel } from './views.js'

const POLL_MS = 3000

export function registerPanels(ctx, { state }) {
  ctx.inject(['dshGo'], scoped => {
    const kit = scoped.dshGo
    const ids = ['memory', 'work', 'affection', 'progress']
    let timer = 0
    let last = ''

    const snapshot = () => state.snapshot()

    function fingerprint() {
      const snap = snapshot()
      return JSON.stringify([
        snap.counts.total,
        snap.counts.work,
        snap.counts.writes,
        snap.counts.injected,
        snap.affection.score,
        snap.memories[snap.memories.length - 1]?.at ?? 0,
        snap.settings?.injectEvery,
      ])
    }

    function broadcast() {
      const next = fingerprint()
      if (next === last) return
      last = next
      for (const id of ids) {
        try {
          kit.refresh?.(id)
        } catch {
          // 面板没打开时桥接自己忽略
        }
      }
    }

    timer = setInterval(broadcast, POLL_MS)
    timer.unref?.()
    scoped.effect(() => () => clearInterval(timer), 'dsh-go-memory: refresh loop')

    const panelData = (scope, emit) => {
      const refresh = () => {
        state.refresh()
        const snap = state.snapshot()
        emit({
          at: snap.at,
          memories: snap.counts.total,
          work: snap.counts.work,
          score: snap.affection.score,
          level: snap.affection.level,
          writes: snap.counts.writes,
          turns: snap.counts.turns,
        })
      }
      refresh()
      const handle = setInterval(refresh, POLL_MS)
      handle.unref?.()
      return () => clearInterval(handle)
    }

    const doRefresh = () => ({
      pending: { label: '正在读取记忆', timeoutMs: 8_000 },
      result: async () => {
        state.refresh()
        return { refresh: true, toast: `记忆 ${state.snapshot().counts.total} 条` }
      },
    })

    kit.panel('memory', {
      view: () => memoryView(snapshot()),
      data: panelData,
      actions: {
        refresh: doRefresh,
        copyAll: () => ({ result: () => ({ toast: state.exportText().slice(0, 600) }) }),
      },
    })

    kit.panel('work', {
      view: () => workView(snapshot()),
      data: panelData,
      actions: {
        refresh: doRefresh,
        copyWork: () => ({
          result: () => {
            const rows = (state.snapshot().memories ?? []).filter(item => item.bucket === 'work')
            const body = rows.map(item => `- ${new Date(item.at).toISOString()} ${item.text}`).join('\n')
            return { toast: body === '' ? '工作分区还没有记忆' : body.slice(0, 600) }
          },
        }),
      },
    })

    kit.panel('affection', {
      view: () => affectionView(snapshot()),
      data: panelData,
      actions: {
        refresh: doRefresh,
        copyAll: () => ({ result: () => ({ toast: state.exportText().slice(0, 400) }) }),
      },
    })

    kit.panel('progress', {
      view: () => progressView(snapshot()),
      data: panelData,
      actions: {
        injectAlways: () => ({
          pending: { label: '设置注入频率', timeoutMs: 6_000 },
          result: () => {
            state.setInjectEvery(1)
            return { refresh: true, toast: '以后每轮回复都读记忆' }
          },
        }),
        injectEvery3: () => ({
          pending: { label: '设置注入频率', timeoutMs: 6_000 },
          result: () => {
            state.setInjectEvery(3)
            return { refresh: true, toast: '以后每 3 轮读一次记忆' }
          },
        }),
      },
    })

    // 微信桥若在场，把在线账号数并进同一行，避免两条状态条抢插槽。
    const wechatHint = () => {
      try {
        const channel = ctx.get('wechatChannel')
        const status = channel?.status?.()
        const accounts = Array.isArray(status?.accounts) ? status.accounts : []
        if (accounts.length === 0) return ''
        const online = accounts.filter(account => account.polling).length
        return `微信${online > 0 ? `·${online}在线` : ''}`
      } catch {
        return ''
      }
    }

    try {
      kit.strip('mem', () => stripLabel(state.snapshot(), wechatHint()))
    } catch {
      // 老版本桥接没有 strip，忽略。
    }
  })
}
