import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const inputs = Object.freeze({ feedback: [0, 2, 4], selection: [1, 3, 5], final: [-7, 9] })

/** 可复制到独立仓库的受信任务示例；只接受明确的仿射表达式，不执行任意 JS。 */
export default function createEnvironment({ runRoot }) {
  return {
    async preflight() {},
    describeCapabilities() {
      return { apiVersion: 'harness-rsi/v1alpha1', environment: 'affine-tasks',
        partitions: ['feedback', 'selection', 'final'], supportsFeedback: true,
        supportsHiddenFinal: true, supportsTaskRetry: true, supportsCheckpointResume: true,
        scoreType: 'inverse-error', artifactType: 'javascript-expression' }
    },
    async runCandidatePartition({ candidateWorkspace, partition }) {
      if (!Object.hasOwn(inputs, partition)) throw new Error('未知任务分区')
      const source = await readFile(join(candidateWorkspace, 'solve.mjs'), 'utf8')
      const match = /^export default x => x \* (-?\d+) \+ (-?\d+);\n$/u.exec(source)
      if (!match || match.slice(1).some((v) => Math.abs(Number(v)) > 100)) {
        throw new Error('示例 Candidate 只允许 x * 整数 + 整数')
      }
      const identity = createHash('sha256').update(JSON.stringify({ source, partition, inputs, target: [3, 1] })).digest('hex')
      const cache = join(runRoot, 'trials', `${identity}.json`)
      try {
        const saved = JSON.parse(await readFile(cache, 'utf8'))
        if (saved.identity !== identity || !Array.isArray(saved.records)) throw new Error('任务检查点损坏')
        return new Map(saved.records.map((record) => [record.instance_id, record]))
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      const records = inputs[partition].map((x, i) => {
        const actual = x * Number(match[1]) + Number(match[2])
        const expected = x * 3 + 1
        return { instance_id: `${partition}-${i}`, status: actual === expected ? 'resolved' : 'unresolved',
          reward: 1 / (1 + Math.abs(actual - expected)),
          ...(partition === 'feedback' ? { feedback: { x, expected, actual } } : {}) }
      })
      await mkdir(join(runRoot, 'trials'), { recursive: true })
      await writeFile(cache, JSON.stringify({ identity, records }), { flag: 'wx', mode: 0o600 })
      return new Map(records.map((record) => [record.instance_id, record]))
    },
  }
}
