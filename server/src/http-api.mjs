import { createServer as createHttpServer } from 'node:http'
import { ProtocolError } from '../../controller/src/protocol.mjs'

const MAX_BODY_BYTES = 1024 * 1024

function jsonResponse(response, status, value) {
  const text = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

function errorResponse(response, error) {
  const status = error instanceof ProtocolError
    ? /不存在|未找到/u.test(error.message) ? 404 : /已存在|只有|不支持/u.test(error.message) ? 409 : 400
    : 500
  jsonResponse(response, status, {
    apiVersion: 'harness-evo-gym/v1',
    kind: 'Error',
    error: error instanceof ProtocolError ? error.message : 'Server API 内部错误',
  })
}

async function body(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new ProtocolError('请求体超过 1 MiB 限制')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  let value
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (error) {
    throw new ProtocolError('请求体必须是合法 JSON', [error.message])
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('请求体必须是 JSON 对象')
  }
  return value
}

function versionPayload(versionInfo = {}) {
  return {
    apiVersion: 'harness-evo-gym/v1',
    kind: 'Version',
    name: 'HarnessEvoGym Server API',
    version: versionInfo.version ?? '0.1.0',
    core: versionInfo.core ?? 'controller',
    protocol: versionInfo.protocol ?? 'harness-rsi/v1alpha1',
  }
}

function route(pathname) {
  const parts = pathname.split('/').filter(Boolean)
  if (parts[0] !== 'v1') return null
  if (parts.length === 2 && parts[1] === 'runs') return { name: 'runs' }
  if (parts.length === 3 && parts[1] === 'runs') return { name: 'run', runId: parts[2] }
  if (parts.length === 4 && parts[1] === 'runs' && parts[3] === 'actions') return { name: 'actions', runId: parts[2] }
  if (parts.length === 4 && parts[1] === 'runs' && parts[3] === 'events') return { name: 'events', runId: parts[2] }
  if (parts.length === 4 && parts[1] === 'runs' && parts[3] === 'versions') return { name: 'versions', runId: parts[2] }
  return null
}

function sendEvents(request, response, events) {
  if (!String(request.headers.accept ?? '').includes('text/event-stream')) {
    return jsonResponse(response, 200, { apiVersion: 'harness-evo-gym/v1', kind: 'RunEvents', events })
  }
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  response.write('retry: 2000\n\n')
  for (const event of events) {
    response.write(`id: ${event.sequence}\nevent: run\ndata: ${JSON.stringify(event)}\n\n`)
  }
  response.end()
}

export function createServer({ engine, versionInfo } = {}) {
  if (!engine) throw new TypeError('createServer 需要 CoreEngine')
  return createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (request.method === 'GET' && url.pathname === '/healthz') {
        return jsonResponse(response, 200, { apiVersion: 'harness-evo-gym/v1', kind: 'Health', ok: true })
      }
      if (request.method === 'GET' && ['/version', '/v1/version'].includes(url.pathname)) {
        return jsonResponse(response, 200, versionPayload(versionInfo))
      }
      const target = route(url.pathname)
      if (!target) return jsonResponse(response, 404, { apiVersion: 'harness-evo-gym/v1', kind: 'Error', error: '路由不存在' })

      if (target.name === 'runs' && request.method === 'GET') {
        return jsonResponse(response, 200, { apiVersion: 'harness-evo-gym/v1', kind: 'RunList', runs: await engine.listRuns() })
      }
      if (target.name === 'runs' && request.method === 'POST') {
        return jsonResponse(response, 202, await engine.createRun(await body(request)))
      }
      if (target.name === 'run' && request.method === 'GET') return jsonResponse(response, 200, await engine.getRun(target.runId))
      if (target.name === 'actions' && request.method === 'POST') {
        const input = await body(request)
        if (typeof input.action !== 'string') throw new ProtocolError('action 必须是字符串')
        return jsonResponse(response, 202, await engine.controlRun(target.runId, input.action))
      }
      if (target.name === 'events' && request.method === 'GET') {
        const after = Number(url.searchParams.get('after') ?? '0')
        if (!Number.isSafeInteger(after) || after < 0) throw new ProtocolError('after 必须是非负整数')
        return sendEvents(request, response, await engine.getEvents(target.runId, after))
      }
      if (target.name === 'versions' && request.method === 'GET') return jsonResponse(response, 200, await engine.getVersions(target.runId))
      return jsonResponse(response, 405, { apiVersion: 'harness-evo-gym/v1', kind: 'Error', error: 'HTTP 方法不支持' })
    } catch (error) {
      errorResponse(response, error)
    }
  })
}
