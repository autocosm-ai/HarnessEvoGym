import { access, statfs } from 'node:fs/promises'
import { constants } from 'node:fs'
import { loadExperimentBundle } from './adapters.mjs'
import { loadLocalProviderEnvironment } from './local-provider.mjs'
import { DockerClient } from './docker.mjs'
import { createUpdaterDriver } from './factories.mjs'
import { preflightExperiment } from './cowork-orchestrator.mjs'
import { runProcess } from './process.mjs'
import { sanitizeFailureText } from './solver-failure.mjs'

const GiB = 1024 ** 3

async function probeProvider(provider, model, environment, request) {
  const base = new URL(environment[provider.credentials.baseUrlEnvironment])
  const key = environment[provider.credentials.apiKeyEnvironment]
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('invalid endpoint')
  }
  if (!key || /[\r\n]/u.test(key)) throw new Error('missing credential')
  const anthropic = provider.protocol === 'anthropic-messages'
  const responses = provider.protocol === 'openai-responses'
  const root = base.href.replace(/\/$/u, '')
  const url = anthropic ? `${root.replace(/\/v1$/u, '')}/v1/messages`
    : `${root}${root.endsWith('/v1') ? '' : '/v1'}/${responses ? 'responses' : 'chat/completions'}`
  const body = { model: model.model, stream: false,
    ...(responses ? { input: 'Reply OK.', max_output_tokens: 512,
      ...(model.reasoningEffort ? { reasoning: { effort: model.reasoningEffort } } : {}) }
      : { messages: [{ role: 'user', content: 'Reply OK.' }],
        [anthropic ? 'max_tokens' : provider.compatibility.maxTokensField]: 512,
        ...(!anthropic && model.reasoningEffort ? { reasoning_effort: model.reasoningEffort } : {}) }) }
  const response = await request(url, { method: 'POST', signal: AbortSignal.timeout(60_000),
    headers: { 'content-type': 'application/json', ...(anthropic
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${key}` }) },
    body: JSON.stringify(body) })
  // 不回显 Provider 正文；错误响应可能反射密钥或包含服务商内部细节。
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`) }
  const payload = await response.json()
  if (payload?.error || !(responses ? payload?.object === 'response'
    : anthropic ? payload?.type === 'message' : Array.isArray(payload?.choices) && payload.choices.length > 0)) {
    throw new Error('invalid model response')
  }
}

/** 启动检查不创建实验、不构建镜像；只有显式探测模式会读取凭据并产生模型费用。 */
export async function runDoctor({ repositoryRoot, experimentPath, probeModels = false, environment = process.env }, {
  command = runProcess, disk = statfs, request = fetch, preflight = preflightExperiment,
  updaterFactory = createUpdaterDriver, dockerFactory = (config) => new DockerClient(config),
} = {}) {
  const checks = []
  const secrets = Object.entries(environment).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/u.test(key)).map(([, value]) => value)
  const add = (id, status, message, remedy = null) => checks.push({ id, status, message, remedy })
  const check = async (id, message, remedy, operation) => {
    try { await operation(); add(id, 'pass', message) }
    catch (error) {
      add(id, 'fail', message, remedy)
      checks.at(-1).reason = sanitizeFailureText(error.message, secrets, 256)
    }
  }
  add('platform', process.platform === 'linux' && process.getuid?.() !== 0 ? 'pass' : 'fail',
    'Linux 普通用户运行', '使用 Linux 普通用户启动，不使用 sudo 运行 Controller。')
  add('node', Number(process.versions.node.split('.')[0]) >= 20 ? 'pass' : 'fail', 'Node.js >= 20', '安装 Node.js 20 或更新版本。')
  for (const [id, binary, args, remedy] of [
    ['git', 'git', ['--version'], '安装 git。'],
    ['python', 'python3', ['--version'], '激活项目 Python 环境，确保 python3 可用。'],
  ]) await check(id, `${binary} 可执行`, remedy, () => command(binary, args, { timeoutMs: 10_000 }))
  await check('workspace', '工作目录可写', '修复仓库目录的普通用户写权限。', () => access(repositoryRoot, constants.W_OK))
  await check('disk', '工作目录所在磁盘至少有 2 GiB 可用空间', '释放磁盘空间或迁移实验目录到数据盘。', async () => {
    const value = await disk(repositoryRoot)
    if (Number(value.bavail) * Number(value.bsize) < 2 * GiB) throw new Error('low disk')
  })
  let bundle
  try { bundle = await loadExperimentBundle(experimentPath, repositoryRoot); add('config', 'pass', 'Experiment 与 Adapter 配置有效') }
  catch { add('config', 'fail', 'Experiment 配置无效', '运行 experiment validate --config <配置> 查看配置错误。') }
  if (!bundle) return { kind: 'DoctorReport', ready: false, checks, modelProbePerformed: false }

  let docker
  try { docker = dockerFactory(bundle.environment.docker) } catch { /* 统一交由检查项报告。 */ }
  await check('docker', 'Docker 服务可访问', '安装并启动 Docker，授予当前普通用户访问权限。', async () => {
    if (!docker) throw new Error('no docker')
    await docker.info()
    const result = await command(docker.binary ?? 'docker', ['info', '--format', '{{.DockerRootDir}}'], { timeoutMs: 15_000 })
    const value = await disk(result.stdout.trim())
    if (Number(value.bavail) * Number(value.bsize) < 5 * GiB) throw new Error('low docker disk')
  })
  // 既有 preflight 校验固定源码、数据 revision 和每题输入；不启动模型或 Updater。
  await check('data-and-source', '任务数据、固定源码和任务输入可用',
    '按对应环境文档准备数据、子模块和 RSI_* 路径，再运行 experiment preflight --skip-secrets。',
    () => preflight({ repositoryRoot, experimentPath, requireSecrets: false }))
  if (['codex-exec-v1', 'claude-code-exec-v1'].includes(bundle.updater.protocol)) {
    await check('updater-runtime', 'CLI Updater、版本与沙箱工具可用',
      '安装 bubblewrap、util-linux，并按 Updater Adapter 配置固定 CLI distribution 和 RSI_* 环境变量。',
      () => updaterFactory({ updater: bundle.updater, provider: bundle.providers.updater, repositoryRoot }).ensureRuntime())
  }
  for (const [id, image] of [['solver-image', bundle.target.solver.runtime.image],
    ['gateway-image', bundle.environment.modelGateway.image], ['updater-image', bundle.updater.runtime.image]]) {
    if (!image || !docker) continue
    try {
      add(id, await docker.imageExists(image) ? 'pass' : 'warn', `${id}：${image}`,
        '镜像不存在时运行 runtime build，并按环境文档准备 Solver 镜像；doctor 不自动下载或构建。')
    } catch { add(id, 'fail', '无法检查镜像', '先解决 Docker 服务或镜像访问问题。') }
  }
  const providerEnvironment = { ...environment }
  let credentialsReady = true
  try { await loadLocalProviderEnvironment({ repositoryRoot, environment: providerEnvironment, includeSecrets: probeModels }) }
  catch { credentialsReady = false; add('provider-config', 'fail', '本地 Provider 配置不可用', '检查 .local/provider.json 和对应凭据配置；诊断不会输出 Key。') }
  for (const provider of Object.values(bundle.providers)) secrets.push(providerEnvironment[provider.credentials.apiKeyEnvironment])
  for (const [role, provider] of Object.entries(bundle.providers)) {
    const hasUrl = Boolean(providerEnvironment[provider.credentials.baseUrlEnvironment])
    const hasKey = Boolean(providerEnvironment[provider.credentials.apiKeyEnvironment])
    if (hasUrl) await check(`${role}-provider-url`, `${role} Provider 地址格式有效`,
      '使用不含用户名、密码、query 或 fragment 的 HTTP(S) API 地址。', async () => {
        const url = new URL(providerEnvironment[provider.credentials.baseUrlEnvironment])
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
          throw new Error('Provider 地址格式无效')
        }
      })
    add(`${role}-credentials`, hasUrl && hasKey ? 'pass' : hasUrl && !probeModels ? 'warn' : 'fail',
      `${role} Provider ${hasUrl ? '已配置地址' : '缺少地址'}；${hasKey ? '已提供凭据' : '凭据尚未验证'}`,
      '设置对应 Provider 的地址和 Key；使用 --probe-models 验证凭据 helper 和模型调用。')
    if (probeModels && credentialsReady) {
      await check(`${role}-model`, `${role} 模型 ${bundle.experiment.models[role].model} 接口探测`,
        '检查模型名称、Key 权限、渠道协议和网络代理设置；Provider 返回正文不会记录。',
        () => probeProvider(provider, bundle.experiment.models[role], providerEnvironment, request))
    }
  }
  if ((bundle.environment.docker.resources.gpus ?? 0) > 0) {
    await check('gpu', 'NVIDIA 驱动可访问', '安装 NVIDIA 驱动及 NVIDIA Container Toolkit，并按 KernelBench 文档自检 CUDA。',
      () => command('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeoutMs: 10_000 }))
  }
  return { kind: 'DoctorReport', ready: checks.every((item) => item.status !== 'fail'),
    modelProbePerformed: probeModels, checks }
}
