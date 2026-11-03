import { StringDecoder } from 'node:string_decoder'

// 只在内存里保留有界文本窗口；对外仅提供计数和故障代码，不保存模型正文。
export class StreamWatch {
  constructor({ now = Date.now } = {}) {
    this.now = now
    this.reset()
  }

  reset() {
    this.streams = new Map()
    this.lastProgressAt = this.now()
    this.receivedBytes = 0
    this.failureCode = null
  }

  start(id) {
    this.lastProgressAt = this.now()
    this.streams.set(id, { decoder: new StringDecoder('utf8'), buffer: '', fields: new Map() })
  }

  text(stream, key, value) {
    if (typeof value !== 'string' || value.length === 0) return
    this.lastProgressAt = this.now()
    if (!stream.fields.has(key) && stream.fields.size >= 32) return
    const previous = stream.fields.get(key) ?? { text: '', inspected: 0 }
    const text = (previous.text + value).slice(-16_384)
    previous.inspected += value.length
    stream.fields.set(key, { text, inspected: previous.inspected })
    if (text.length < 4096 || previous.inspected < 256) return
    stream.fields.get(key).inspected = 0
    // 相同的长片段连续重复，才视为失控；不会因为重复标点或少量代码模板停止。
    const suffix = text.slice(-64)
    let at = text.lastIndexOf(suffix, text.length - 65)
    while (at >= Math.max(0, text.length - 64 - 2048)) {
      const period = text.length - 64 - at
      if (period >= 64) {
        const repeated = Math.max(8, Math.ceil(4096 / period))
        const length = period * repeated
        if (text.length >= length) {
          const segment = text.slice(-period)
          if (text.slice(-length) === segment.repeat(repeated)) {
            this.failureCode = 'updater-repetitive-output'
            return
          }
        }
      }
      if (at === 0) break
      at = text.lastIndexOf(suffix, at - 1)
    }
  }

  event(stream, line) {
    if (!line.startsWith('data:')) return
    const raw = line.slice(5).trim()
    if (raw === '[DONE]') { this.lastProgressAt = this.now(); return }
    let value
    try { value = JSON.parse(raw) } catch { return }
    if (!value || typeof value !== 'object') return
    for (const choice of Array.isArray(value.choices) ? value.choices : []) {
      if (!choice || typeof choice !== 'object') continue
      for (const field of ['content', 'reasoning_content']) this.text(stream, field, choice.delta?.[field])
      for (const tool of Array.isArray(choice.delta?.tool_calls) ? choice.delta.tool_calls : []) {
        this.text(stream, `tool-${tool?.index ?? 0}`, tool?.function?.arguments)
      }
    }
    if (typeof value.delta === 'string') this.text(stream, `${value.type}:${value.item_id ?? value.output_index ?? 0}`, value.delta)
    if (value.delta && typeof value.delta === 'object') {
      for (const field of ['text', 'thinking', 'partial_json']) this.text(stream, `${value.index ?? 0}:${field}`, value.delta[field])
    }
    if (['response.completed', 'message_stop'].includes(value.type)) this.lastProgressAt = this.now()
  }

  chunk(id, chunk) {
    const stream = this.streams.get(id)
    if (!stream) return
    this.receivedBytes += chunk.length
    stream.buffer += stream.decoder.write(chunk)
    let newline = stream.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = stream.buffer.slice(0, newline)
      if (line.length <= 1024 * 1024) this.event(stream, line)
      else this.failureCode = 'updater-stream-event-too-large'
      stream.buffer = stream.buffer.slice(newline + 1)
      newline = stream.buffer.indexOf('\n')
    }
    if (stream.buffer.length > 1024 * 1024) {
      this.failureCode = 'updater-stream-event-too-large'
      stream.buffer = ''
    }
  }

  end(id) {
    const stream = this.streams.get(id)
    if (stream) {
      this.event(stream, stream.buffer + stream.decoder.end())
      this.streams.delete(id)
      this.lastProgressAt = this.now()
    }
  }

  snapshot() {
    return { lastProgressAt: this.lastProgressAt, receivedBytes: this.receivedBytes,
      activeStreams: this.streams.size, failureCode: this.failureCode }
  }
}
