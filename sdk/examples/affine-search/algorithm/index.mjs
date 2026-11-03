import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const mean = (records) => [...records.values()].reduce((sum, record) => sum + record.reward, 0) / records.size

/** 独立 Beam 状态，不使用 PopulationStore；变异器是明确的离线枚举示例。 */
export default function createAlgorithm({ store, algorithm, createPluginDriver }) {
  const width = algorithm.configuration?.width ?? 2
  const limit = algorithm.configuration?.limit ?? 6
  if (!Number.isInteger(width) || width < 1 || width > 16
      || !Number.isInteger(limit) || limit < 1 || limit > 32) throw new Error('非法 beam width 或 limit')
  const environment = createPluginDriver('environment', 'affine-tasks-v1', { runRoot: store.root })

  async function candidate(factor, bias) {
    const id = `factor-${factor}-bias-${bias}`
    const workspace = join(store.root, 'candidates', id)
    const source = `export default x => x * ${factor} + ${bias};\n`
    await mkdir(workspace, { recursive: true })
    try { await writeFile(join(workspace, 'solve.mjs'), source, { flag: 'wx', mode: 0o400 }) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (await readFile(join(workspace, 'solve.mjs'), 'utf8') !== source) throw new Error('候选源码已被修改')
    }
    const feedback = await environment.runCandidatePartition({ candidateWorkspace: workspace, partition: 'feedback' })
    const selection = await environment.runCandidatePartition({ candidateWorkspace: workspace, partition: 'selection' })
    return { id, factor, bias, feedback: mean(feedback), score: mean(selection) }
  }

  return {
    store,
    checkpointCodec: { version: 'v1', encode: (value) => value, decode: (value) => value },
    async initialize({ state }) {
      await environment.preflight()
      const baseline = await candidate(1, 0)
      return { ...state, status: 'active', step: 0, beam: [baseline], baseline, width, limit }
    },
    async resume({ state, checkpoint }) {
      const recovered = checkpoint ?? state
      if (!Array.isArray(recovered.beam) || !recovered.beam.length) throw new Error('Beam 检查点损坏')
      return recovered
    },
    async step({ state }) {
      const proposals = new Map(state.beam.map((item) => [item.id, item]))
      for (const parent of state.beam) {
        for (const [df, db] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const next = await candidate(parent.factor + df, parent.bias + db)
          proposals.set(next.id, next)
        }
      }
      const beam = [...proposals.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, width)
      const step = state.step + 1
      const next = { ...state, step, beam, status: beam[0].score === 1 || step >= limit ? 'completed' : 'active' }
      return { state: next, checkpoint: next, event: { type: 'beam.step', step, best: beam[0].score } }
    },
    async freezeBaseline({ state }) { return { ...state, status: 'completed', beam: [state.baseline] } },
    async report({ state }) {
      const champion = state.beam[0]
      const final = state.status === 'completed'
        ? await environment.runCandidatePartition({ candidateWorkspace: join(store.root, 'candidates', champion.id), partition: 'final' })
        : null
      return { baselineScore: state.baseline.score, champion, finalScore: final ? mean(final) : null,
        candidatePath: `candidates/${champion.id}/solve.mjs`, evidence: 'offline-enumeration-example' }
    },
  }
}
