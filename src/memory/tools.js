/**
 * 把读写记忆暴露成**工具**，并强制模型每轮用：
 *
 * - `memory_read`：读最近若干条记忆 + 当前好感度；
 * - `memory_write`：手写一条记忆（走引擎同一条 `appendMemory`）。
 *
 * 「强制」两层：注入文本里点名要求模型调这两个工具；同时插件自己仍在
 * 开局注入、收尾自动写、并立刻落盘 —— 模型没调也不会丢记忆。
 *
 * @module dsh-go-memory/src/memory/tools
 */

const OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    detail: { type: 'string' },
    total: { type: 'number' },
    score: { type: 'number' },
    level: { type: 'string' },
  },
  required: ['detail'],
}

function clockOf(at) {
  const d = new Date(Number(at) || Date.now())
  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 注册两个记忆工具；返回 disposer。没有 tools 服务的宿主上等于空操作。 */
export function registerMemoryTools(ctx, { engine }) {
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  if (tools === undefined || typeof tools.register !== 'function') {
    return () => {}
  }

  const read = tools.register({
    name: 'memory_read',
    description:
      '读取「我的记忆」—— 跨对话共用的那一池，含第一人称记忆条目、时间戳、当前好感度。' +
      '每轮对话开始时先调它一次，把你和主人以前做过的事想起来；回答涉及之前的工作、约定、偏好时也要先调它。',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: '读最近多少条，默认 8，最多 50。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT,
      render: args => [{ type: 'text', text: `memory_read · ${String(args.total ?? '')} 条记忆` }],
    },
    execute: async args => {
      const result = engine.read(Number(args?.limit ?? 8))
      const lines = result.memories.map(row => `- ${clockOf(row.at)} ${row.text}`)
      return {
        detail: [
          `共 ${result.total} 条记忆；好感度 ${result.score}/100（${result.level}）`,
          ...(lines.length > 0 ? lines : ['（这一池还是空的）']),
        ].join('\n'),
        total: result.total,
        score: result.score,
        level: result.level,
      }
    },
  })

  const write = tools.register({
    name: 'memory_write',
    description:
      '往「我的记忆」写一条第一人称记忆。每轮对话结束前必须调一次，写下这一轮的要点' +
      '（主人要了什么、做了什么、结论是什么）。只写值得留到以后的事，一句话即可。',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '第一人称的一句话，例如「主人让我把记忆插件改成全局池，我改完并测通了」。',
        },
        bucket: {
          type: 'string',
          enum: ['work', 'chat'],
          description: 'work = 工作技术类，chat = 其它。不确定就留空，插件会自己判断。',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT,
      render: args => [{ type: 'text', text: `memory_write · ${String(args.detail ?? '')}` }],
    },
    execute: async args => {
      const row = engine.write(String(args?.text ?? ''), { bucket: args?.bucket })
      if (row === undefined) return { detail: '没写：text 为空' }
      return { detail: `已记下：${row.text}` }
    },
  })

  return () => {
    try {
      read()
    } catch { /* ignore */ }
    try {
      write()
    } catch { /* ignore */ }
  }
}
