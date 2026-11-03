import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { parse } from 'smol-toml'

import { ProtocolError } from './protocol.mjs'

const execute = promisify(execFile)

/** 仅在用户显式创建本地配置后复用 Codex Provider；密钥不落盘。 */
export async function loadLocalProviderEnvironment({
  repositoryRoot,
  environment = process.env,
  includeSecrets = true,
  runCommand = execute,
} = {}) {
  let settings
  try {
    settings = JSON.parse(await readFile(join(repositoryRoot, '.local/provider.json'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw new ProtocolError('无法读取 .local/provider.json')
  }
  if (!settings || Array.isArray(settings) || settings.source !== 'codex' || typeof settings.provider !== 'string'
      || !/^[a-zA-Z0-9_-]+$/u.test(settings.provider)
      || Object.keys(settings).some((key) => !['source', 'provider'].includes(key))) {
    throw new ProtocolError('本地 Provider 配置只接受 source=codex 和 provider 名称')
  }

  // 显式传入的一整对凭据优先；禁止把一个渠道的 Key 与另一个地址拼接。
  const hasUrl = Boolean(environment.RSI_PROVIDER_BASE_URL)
  const hasKey = Boolean(environment.RSI_PROVIDER_API_KEY)
  if (hasUrl && hasKey) return false
  if ((includeSecrets && hasUrl !== hasKey) || (!hasUrl && hasKey)) {
    throw new ProtocolError('请同时设置 RSI_PROVIDER_BASE_URL 和 RSI_PROVIDER_API_KEY，或同时取消以使用本地 Codex Provider')
  }
  if (!includeSecrets && hasUrl) return false

  let provider
  try {
    const configPath = join(environment.CODEX_HOME || join(homedir(), '.codex'), 'config.toml')
    const config = parse(await readFile(configPath, 'utf8'))
    provider = config.model_providers?.[settings.provider]
  } catch {
    throw new ProtocolError('无法读取本机 Codex Provider 配置')
  }
  let baseUrl
  try {
    const url = new URL(provider?.base_url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('invalid endpoint')
    }
    baseUrl = url.href.replace(/\/$/u, '')
  } catch {
    throw new ProtocolError('本机 Codex Provider 缺少有效 base_url')
  }

  let key
  if (includeSecrets) {
    if (provider.env_key) {
      key = environment[provider.env_key]
    } else if (provider.experimental_bearer_token) {
      key = provider.experimental_bearer_token
    } else if (typeof provider.auth?.command === 'string' && provider.auth.command.trim()) {
      try {
        const result = await runCommand('/bin/sh', ['-c', provider.auth.command], {
          cwd: resolve(repositoryRoot),
          env: environment,
          timeout: Math.min(Math.max(Number(provider.auth.timeout_ms) || 5000, 1), 30000),
          maxBuffer: 65536,
          encoding: 'utf8',
        })
        key = result.stdout.trim()
      } catch {
        // 子进程的 stdout/stderr 可能含 Key，不拼接进报错。
        throw new ProtocolError('Codex Provider 凭据命令失败；请检查本机凭据配置')
      }
    }
    if (typeof key !== 'string' || key.trim().length < 8 || /[\r\n]/u.test(key.trim()) || key.length > 65536) {
      throw new ProtocolError('Codex Provider 未提供有效的 API Key')
    }
  }
  environment.RSI_PROVIDER_BASE_URL = baseUrl
  if (includeSecrets) environment.RSI_PROVIDER_API_KEY = key.trim()
  return true
}
