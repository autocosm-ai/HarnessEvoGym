/**
 * Fake Candidate - 用于测试 Fake Environment
 *
 * 实现 solve() 接口，响应简单数学题任务
 */

export async function solve({ a, b, operation }) {
  if (operation === 'add') {
    return a + b
  }

  if (operation === 'multiply') {
    return a * b
  }

  if (operation === 'square-sum') {
    return a * a + b * b
  }

  throw new Error(`Unknown operation: ${operation}`)
}
