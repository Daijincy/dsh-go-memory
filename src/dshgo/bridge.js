/**
 * dsh-go 适配入口：面板 + 状态条 + 本机管理页。
 *
 * 没有 dsh-go 桥接的宿主（桌面 dsh / TUI）不会进 `ctx.inject(['dshGo'])` 回调，
 * 但管理页仍然会起 —— 那里能看记忆、能导出、能清空。
 *
 * @module dsh-go-memory/src/dshgo/bridge
 */

import { createMemoryState } from './state.js'
import { registerPanels } from './panels.js'
import { mountMobile } from './mobile.js'

export function mountDshGo(ctx, { engine, store, version, dataDir }) {
  const state = createMemoryState({ engine })
  state.version = version
  state.dataDir = dataDir
  state.refresh()

  let stopPanels = () => {}
  try {
    registerPanels(ctx, { state })
    stopPanels = () => {}
  } catch (error) {
    console.warn(`[记忆] 面板注册失败：${error?.message ?? error}`)
  }

  let stopMobile = () => {}
  try {
    stopMobile = mountMobile(ctx, { state, version, dataDir, enginePerf: () => engine.perf?.() })
  } catch (error) {
    console.warn(`[记忆] 管理页启动失败：${error?.message ?? error}`)
  }

  return () => {
    try {
      stopPanels()
    } catch { /* ignore */ }
    try {
      stopMobile()
    } catch { /* ignore */ }
    try {
      store.flush()
    } catch { /* ignore */ }
  }
}
