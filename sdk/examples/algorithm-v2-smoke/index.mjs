export default function createAlgorithm({ store, algorithm }) {
  const limit = Number.isSafeInteger(algorithm?.configuration?.limit)
    ? Math.max(1, algorithm.configuration.limit)
    : 2
  return {
    store,
    checkpointCodec: {
      version: 'v1',
      encode(value) { return value },
      decode(value) { return value },
    },
    async initialize({ state }) {
      return { ...state, status: 'active', step: state.step ?? 0, limit }
    },
    async resume({ state, checkpoint }) {
      const step = checkpoint?.step ?? state.step
      return { ...state, step, status: step >= state.limit ? 'completed' : 'active' }
    },
    async step({ state }) {
      const step = (state.step ?? 0) + 1
      return {
        state: { ...state, step, status: step >= state.limit ? 'completed' : 'active' },
        checkpoint: { step },
        event: { type: 'algorithm.step', step },
      }
    },
    async freezeBaseline({ state }) { return { ...state, baseline: true, status: 'completed' } },
    async report({ state }) { return { step: state.step ?? 0, baseline: state.baseline === true } },
  }
}
