/**
 * Controller 中两层重试预算的唯一来源。
 *
 * infrastructureRetries 是整题/Trial 级恢复预算；
 * maximumUpstreamRetries 是 Model Gateway 对同一次模型请求的网络重试预算。
 * 两者必须保持不同，避免把请求级重试误当成整题级重试。
 */
export const MAXIMUM_INFRASTRUCTURE_RETRIES = 10
export const MAXIMUM_UPSTREAM_RETRIES = 5

