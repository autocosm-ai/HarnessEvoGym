/**
 * Evolution Algorithm SDK v2。
 *
 * v1 的 Population Driver 仍然可用，但它要求 PopulationStore 和固定状态形状。
 * v2 只规定生命周期、RunStore 和 CheckpointCodec，算法可以自行决定状态结构，
 * 因此遗传算法、Beam Search、MCTS 不需要修改 Controller 核心。
 */

/**
 * @typedef {Object} AlgorithmRunStore
 * @property {function(Object): Promise<void>} initialize 创建一次新的 Run
 * @property {function(): Promise<Object>} readState 读取算法私有状态
 * @property {function(Object): Promise<void>} writeState 原子保存算法私有状态
 * @property {function(Object): Promise<Object>} appendEvent 追加公开事件
 * @property {function(string,Object): Promise<Object>} writeCheckpoint 写入不可变 Checkpoint
 * @property {function(string): Promise<Object|null>} readCheckpoint 读取 Checkpoint
 */

/**
 * @typedef {Object} CheckpointCodec
 * @property {string} version 不可变的 Codec 版本
 * @property {function(Object): Object} encode 把算法状态编码成 JSON-safe 结构
 * @property {function(Object): Object} decode 从 JSON-safe 结构恢复算法状态
 */

/** v2 Driver 的最小生命周期：initialize -> step* -> report；暂停后 resume -> step*。 */
export class EvolutionAlgorithmDriverV2 {
  get apiVersion() { return 'harness-rsi/algorithm-driver-v2' }

  get store() { throw new Error('store 必须由算法实现提供') }

  get checkpointCodec() { throw new Error('checkpointCodec 必须由算法实现提供') }

  async initialize() { throw new Error('initialize() 必须由算法实现') }

  async step() { throw new Error('step() 必须由算法实现') }

  async resume() { throw new Error('resume() 必须由算法实现') }

  async report() { throw new Error('report() 必须由算法实现') }

  async freezeBaseline() { throw new Error('freezeBaseline() 必须由算法实现') }
}
