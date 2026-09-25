import { ProtocolError } from './protocol.mjs'

// 旧插件只声明了 supportsTaskInfrastructureRetries，保留原有语义。
export function environmentCapabilities(driver) {
  if (typeof driver.describeCapabilities !== 'function') {
    const retry = driver.supportsTaskInfrastructureRetries === true
    return Object.freeze({
      supportsTaskRetry: retry,
      supportsCheckpointResume: retry,
      partitions: null,
    })
  }
  const capabilities = driver.describeCapabilities()
  if (!capabilities || capabilities.apiVersion !== 'harness-rsi/v1alpha1'
      || !Array.isArray(capabilities.partitions) || !capabilities.partitions.length
      || capabilities.partitions.some((item) => !['feedback', 'selection', 'final'].includes(item))
      || new Set(capabilities.partitions).size !== capabilities.partitions.length) {
    throw new ProtocolError('Environment capabilities 的版本或 partitions 无效')
  }
  for (const flag of ['supportsFeedback', 'supportsHiddenFinal', 'supportsTaskRetry', 'supportsCheckpointResume']) {
    if (typeof capabilities[flag] !== 'boolean') {
      throw new ProtocolError(`Environment capabilities.${flag} 必须是布尔值`)
    }
  }
  if ((capabilities.supportsFeedback && !capabilities.partitions.includes('feedback'))
      || (capabilities.supportsHiddenFinal && !capabilities.partitions.includes('final'))
      || (capabilities.supportsTaskRetry && !capabilities.supportsCheckpointResume)
      || (driver.supportsTaskInfrastructureRetries !== undefined
        && driver.supportsTaskInfrastructureRetries !== capabilities.supportsTaskRetry)) {
    throw new ProtocolError('Environment capabilities 与分区或旧重试声明不一致')
  }
  return Object.freeze({ ...capabilities, partitions: Object.freeze([...capabilities.partitions]) })
}

export function supportsTaskInfrastructureRetries(driver) {
  const capabilities = environmentCapabilities(driver)
  return capabilities.supportsTaskRetry && capabilities.supportsCheckpointResume
}
