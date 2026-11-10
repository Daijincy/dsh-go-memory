/**
 * 本机管理页：面板只能画文字，导出/批量清理/换注入频率这些更适合在浏览器里做。
 *
 * 绑定 127.0.0.1，不对外网开放；端口被占用时自动换随机端口并在日志里写明。
 *
 * @module dsh-go-memory/src/dshgo/mobile
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const DEFAULT_PORT = 18920
const PAGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'mobile', 'index.html')

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
  })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

function readBody(req) {
  return new Promise(resolve => {
    let raw = ''
    req.on('data', chunk => {
      raw += chunk
      if (raw.length > 1_000_000) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(raw === '' ? {} : JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
  })
}

export function mountMobile(ctx, { state, version, dataDir, port, enginePerf }) {
  const wanted = Number(port ?? process.env.DGM_MOBILE_PORT ?? DEFAULT_PORT)
  if (wanted === 0) return () => {}

  const readPerf = () => (typeof enginePerf === 'function' ? enginePerf() : {})

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/' || url.pathname === '/index.html') {
        let html = '<h1>dsh-go-memory</h1><p>页面文件缺失，改用 /api/memory 读数据。</p>'
        try {
          html = readFileSync(PAGE, 'utf8')
        } catch { /* 页面缺失不致命 */ }
        send(res, 200, html, 'text/html; charset=utf-8')
        return
      }
      if (url.pathname === '/health') {
        send(res, 200, { ok: true, version })
        return
      }
      if (url.pathname === '/api/status') {
        state.refresh()
        const snap = state.snapshot()
        send(res, 200, {
          version,
          dataDir,
          memories: snap.counts.total,
          work: snap.counts.work,
          score: snap.affection.score,
          level: snap.affection.level,
          turns: snap.counts.turns,
          writes: snap.counts.writes,
          injected: snap.counts.injected,
          settings: snap.settings ?? {},
          at: Date.now(),
        })
        return
      }
      if (url.pathname === '/api/perf') {
        send(res, 200, readPerf())
        return
      }
      if (url.pathname === '/api/memory') {
        state.refresh()
        send(res, 200, { ...state.snapshot(), text: state.exportText() })
        return
      }
      if (url.pathname === '/api/export') {
        state.refresh()
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'attachment; filename="dsh-go-memory.md"',
        })
        res.end(state.exportText())
        return
      }
      if (url.pathname === '/api/config' && req.method === 'POST') {
        const body = await readBody(req)
        state.setInjectEvery(Number(body.injectEvery ?? 1))
        send(res, 200, { ok: true, settings: state.snapshot().settings ?? {} })
        return
      }
      if (url.pathname === '/api/reset' && req.method === 'POST') {
        state.reset()
        send(res, 200, { ok: true, memories: state.snapshot().counts.total })
        return
      }
      send(res, 404, { error: 'not found' })
    } catch (error) {
      send(res, 500, { error: String(error?.message ?? error) })
    }
  })

  const announce = actual => {
    console.log(`[记忆] 管理页 http://127.0.0.1:${actual}  （导出/清理/改注入频率）`)
  }

  const listen = (candidate, fallback) => {
    server.once('error', error => {
      if (error?.code === 'EADDRINUSE' && fallback) {
        console.warn(`[记忆] 端口 ${candidate} 被占用，改用随机端口`)
        server.listen(0, '127.0.0.1')
        return
      }
      console.warn(`[记忆] 管理页启动失败：${error?.message ?? error}`)
    })
    server.listen(candidate, '127.0.0.1', () => announce(server.address().port))
  }

  listen(wanted, true)

  return () => {
    try {
      server.close()
    } catch { /* ignore */ }
  }
}
