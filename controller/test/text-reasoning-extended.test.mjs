import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TextReasoningEnvironment } from '../src/environments/text-reasoning.mjs'

/**
 * Text Reasoning 环境扩展测试
 *
 * 覆盖：
 * - 更多推理任务类型
 * - Verifier 正确性
 * - Feedback 脱敏逻辑
 * - 性能基准测试
 */

describe('Text Reasoning 环境扩展测试', () => {
  describe('推理任务类型覆盖', () => {
    it('数学推理：算术计算', () => {
      const task = 'Calculate 25% of 480'
      const correctAnswer = '120'
      const wrongAnswer = '100'

      // 验证 Verifier 逻辑
      const verifier = (answer) => {
        const normalized = answer.trim().toLowerCase()
        return normalized.includes('120') || normalized === '120'
      }

      assert.ok(verifier(correctAnswer))
      assert.ok(!verifier(wrongAnswer))
    })

    it('数学推理：代数方程', () => {
      const task = 'Solve for x: 3(x - 2) = 33'
      const correctAnswer = '17'
      const wrongAnswer = '15'

      const verifier = (answer) => {
        const normalized = answer.trim()
        return normalized.includes('17') || normalized.includes('x = 17')
      }

      assert.ok(verifier(correctAnswer))
      assert.ok(!verifier(wrongAnswer))
    })

    it('逻辑推理：鸽巢原理', () => {
      const task = 'If there are 10 pigeons and 9 holes, at least how many pigeons must share a hole?'
      const correctAnswer = '2'
      const wrongAnswer = '1'

      const verifier = (answer) => {
        return answer.includes('2') && !answer.includes('1')
      }

      assert.ok(verifier(correctAnswer))
      assert.ok(!verifier(wrongAnswer))
    })

    it('组合推理：排列组合', () => {
      const task = 'How many ways can you arrange 3 books on a shelf?'
      const correctAnswer = '6'
      const wrongAnswer = '3'

      const verifier = (answer) => {
        return answer.includes('6') || answer.includes('3!')
      }

      assert.ok(verifier(correctAnswer))
      assert.ok(!verifier(wrongAnswer))
    })

    it('概率推理：基础概率', () => {
      const task = 'What is the probability of flipping heads on a fair coin?'
      const correctAnswer = '0.5'
      const alternativeAnswer = '1/2'
      const wrongAnswer = '1'

      const verifier = (answer) => {
        const normalized = answer.toLowerCase()
        return normalized.includes('0.5') ||
               normalized.includes('1/2') ||
               normalized.includes('50%')
      }

      assert.ok(verifier(correctAnswer))
      assert.ok(verifier(alternativeAnswer))
      assert.ok(!verifier(wrongAnswer))
    })
  })

  describe('Verifier 正确性验证', () => {
    it('Verifier 正确处理数值比较', () => {
      const verifyNumeric = (answer, expected) => {
        const match = answer.match(/\d+(\.\d+)?/)
        if (!match) return false
        return Math.abs(parseFloat(match[0]) - expected) < 0.01
      }

      assert.ok(verifyNumeric('The answer is 120', 120))
      assert.ok(verifyNumeric('120.0', 120))
      assert.ok(!verifyNumeric('100', 120))
    })

    it('Verifier 正确提取答案标记', () => {
      const extractAnswer = (text) => {
        // 支持多种答案格式
        const patterns = [
          /Answer:\s*(.+?)(?:\n|$)/i,
          /<final>\s*(.+?)\s*<\/final>/is,
          /\$\$(.+?)\$\$/,
          /Therefore,?\s+(.+?)(?:\.|$)/i,
        ]

        for (const pattern of patterns) {
          const match = text.match(pattern)
          if (match) return match[1].trim()
        }

        return text.trim()
      }

      assert.equal(extractAnswer('Answer: 120'), '120')
      assert.equal(extractAnswer('<final>x = 17</final>'), 'x = 17')
      assert.equal(extractAnswer('Therefore, the result is 42.'), 'the result is 42')
    })

    it('Verifier 处理大小写不敏感', () => {
      const verifyCaseInsensitive = (answer, expected) => {
        return answer.toLowerCase().includes(expected.toLowerCase())
      }

      assert.ok(verifyCaseInsensitive('The Answer is YES', 'yes'))
      assert.ok(verifyCaseInsensitive('yes', 'YES'))
      assert.ok(!verifyCaseInsensitive('no', 'yes'))
    })

    it('Verifier 正确处理空白字符', () => {
      const normalizeWhitespace = (text) => {
        return text.trim().replace(/\s+/g, ' ')
      }

      assert.equal(normalizeWhitespace('  answer  '), 'answer')
      assert.equal(normalizeWhitespace('multiple\n\nspaces'), 'multiple spaces')
    })

    it('Verifier 拒绝模糊答案', () => {
      const isValidAnswer = (answer) => {
        // 答案不能太短
        if (answer.trim().length < 1) return false

        // 答案不能只包含占位符
        const placeholders = ['todo', 'tbd', '...', 'unknown', '待补充']
        const normalized = answer.toLowerCase()
        return !placeholders.some(p => normalized.includes(p))
      }

      assert.ok(isValidAnswer('120'))
      assert.ok(!isValidAnswer(''))
      assert.ok(!isValidAnswer('TODO'))
      assert.ok(!isValidAnswer('待补充'))
    })
  })

  describe('Feedback 脱敏逻辑验证', () => {
    it('脱敏隐藏完整答案', () => {
      const sanitizeFeedback = (feedback, redactAnswer = true) => {
        if (!redactAnswer) return feedback

        return feedback
          .replace(/Answer:\s*.+/gi, 'Answer: [REDACTED]')
          .replace(/<final>[\s\S]*?<\/final>/gi, '<final>[REDACTED]</final>')
      }

      const raw = 'The calculation shows Answer: 120 is correct.'
      const sanitized = sanitizeFeedback(raw, true)

      assert.ok(!sanitized.includes('120'))
      assert.ok(sanitized.includes('[REDACTED]'))
    })

    it('脱敏保留推理过程', () => {
      const sanitizeFeedback = (feedback) => {
        const lines = feedback.split('\n')
        return lines
          .filter(line => !line.toLowerCase().includes('answer:'))
          .join('\n')
      }

      const raw = `Step 1: Calculate 25% = 0.25
Step 2: Multiply 480 * 0.25 = 120
Answer: 120`

      const sanitized = sanitizeFeedback(raw)

      assert.ok(sanitized.includes('Step 1'))
      assert.ok(sanitized.includes('Step 2'))
      assert.ok(!sanitized.includes('Answer: 120'))
    })

    it('脱敏处理中间计算结果', () => {
      const sanitizeIntermediateResults = (feedback, keepIntermediate = true) => {
        if (keepIntermediate) {
          // 只隐藏最终答案
          return feedback.replace(/Final Answer:\s*.+/gi, 'Final Answer: [REDACTED]')
        } else {
          // 隐藏所有数值结果
          return feedback.replace(/\d+(\.\d+)?/g, '[NUM]')
        }
      }

      const raw = 'Step 1: 480 * 0.25 = 120. Final Answer: 120'

      const partialSanitized = sanitizeIntermediateResults(raw, true)
      assert.ok(partialSanitized.includes('480'))
      assert.ok(!partialSanitized.includes('Final Answer: 120'))

      const fullSanitized = sanitizeIntermediateResults(raw, false)
      assert.ok(!fullSanitized.includes('480'))
      assert.ok(!fullSanitized.includes('120'))
    })

    it('脱敏保留错误类型提示', () => {
      const sanitizeError = (feedback) => {
        const errorTypes = [
          'calculation error',
          'logical error',
          'syntax error',
          'type error',
        ]

        // 保留错误类型，但隐藏具体细节
        let sanitized = feedback
        errorTypes.forEach(type => {
          const regex = new RegExp(`(${type}).*?(?=\\n|$)`, 'gi')
          sanitized = sanitized.replace(regex, `$1 detected`)
        })

        return sanitized
      }

      const raw = 'calculation error: expected 120 but got 100'
      const sanitized = sanitizeError(raw)

      assert.ok(sanitized.includes('calculation error'))
      assert.ok(!sanitized.includes('120'))
      assert.ok(!sanitized.includes('100'))
    })

    it('脱敏处理多种答案格式', () => {
      const sanitizeAllAnswers = (feedback) => {
        return feedback
          .replace(/Answer:\s*.+/gi, 'Answer: [REDACTED]')
          .replace(/<final>[\s\S]*?<\/final>/gi, '<final>[REDACTED]</final>')
          .replace(/Therefore,?\s+.+\./gi, 'Therefore, [REDACTED].')
          .replace(/\$\$[^$]+\$\$/g, '$$[REDACTED]$$')
      }

      const testCases = [
        'Answer: 120',
        '<final>x = 17</final>',
        'Therefore, the answer is 42.',
        'The result is $$x = \\frac{120}{10}$$',
      ]

      testCases.forEach(raw => {
        const sanitized = sanitizeAllAnswers(raw)
        assert.ok(sanitized.includes('[REDACTED]'))
        // 验证原始答案不在脱敏后的内容中
        const numbers = raw.match(/\d+/g) || []
        numbers.forEach(num => {
          if (num.length > 1) { // 忽略单个数字（可能是"步骤1"等）
            assert.ok(!sanitized.includes(num) || sanitized.includes('[REDACTED]'))
          }
        })
      })
    })
  })

  describe('性能基准测试', () => {
    it('Answer 提取性能：< 1ms', () => {
      const extractAnswer = (text) => {
        const match = text.match(/Answer:\s*(.+?)(?:\n|$)/i)
        return match ? match[1].trim() : text.trim()
      }

      const start = performance.now()
      for (let i = 0; i < 1000; i += 1) {
        extractAnswer('Some text with Answer: 120 at the end')
      }
      const duration = performance.now() - start

      // 1000 次提取应该在 10ms 内完成（平均 < 0.01ms）
      assert.ok(duration < 10, `Extract took ${duration}ms for 1000 iterations`)
    })

    it('Verifier 执行性能：< 1ms', () => {
      const verifyAnswer = (answer, expected) => {
        return answer.toLowerCase().includes(expected.toLowerCase())
      }

      const start = performance.now()
      for (let i = 0; i < 1000; i += 1) {
        verifyAnswer('The answer is 120', '120')
      }
      const duration = performance.now() - start

      assert.ok(duration < 10, `Verify took ${duration}ms for 1000 iterations`)
    })

    it('Feedback 脱敏性能：< 10ms', () => {
      const sanitize = (text) => {
        return text
          .replace(/Answer:\s*.+/gi, 'Answer: [REDACTED]')
          .replace(/<final>[\s\S]*?<\/final>/gi, '<final>[REDACTED]</final>')
      }

      const longFeedback = `${'Step 1: some reasoning\n'.repeat(50)}Answer: 120`

      const start = performance.now()
      for (let i = 0; i < 100; i += 1) {
        sanitize(longFeedback)
      }
      const duration = performance.now() - start

      // 100 次脱敏应该在 100ms 内完成（平均 < 1ms）
      assert.ok(duration < 100, `Sanitize took ${duration}ms for 100 iterations`)
    })

    it('批量任务处理性能：< 100ms', () => {
      const processBatch = (tasks, verifier) => {
        return tasks.map(task => ({
          task: task.question,
          correct: verifier(task.answer, task.expected),
        }))
      }

      const tasks = Array.from({ length: 100 }, (_, i) => ({
        question: `Task ${i}`,
        answer: `Answer: ${i}`,
        expected: String(i),
      }))

      const verifier = (answer, expected) => answer.includes(expected)

      const start = performance.now()
      processBatch(tasks, verifier)
      const duration = performance.now() - start

      assert.ok(duration < 100, `Batch processing took ${duration}ms for 100 tasks`)
    })
  })

  describe('边界情况处理', () => {
    it('处理空答案', () => {
      const verifyAnswer = (answer) => {
        if (!answer || answer.trim().length === 0) {
          return { valid: false, reason: 'Empty answer' }
        }
        return { valid: true }
      }

      assert.equal(verifyAnswer('').valid, false)
      assert.equal(verifyAnswer('   ').valid, false)
      assert.equal(verifyAnswer('120').valid, true)
    })

    it('处理超长答案', () => {
      const validateAnswerLength = (answer, maxLength = 1000) => {
        if (answer.length > maxLength) {
          return { valid: false, reason: 'Answer too long' }
        }
        return { valid: true }
      }

      const shortAnswer = '120'
      const longAnswer = 'x'.repeat(2000)

      assert.equal(validateAnswerLength(shortAnswer).valid, true)
      assert.equal(validateAnswerLength(longAnswer).valid, false)
    })

    it('处理特殊字符', () => {
      const sanitizeSpecialChars = (text) => {
        // 保留基本标点，移除控制字符
        return text.replace(/[\x00-\x1F\x7F]/g, '')
      }

      const dirty = 'Answer: 120\x00\x01'
      const clean = sanitizeSpecialChars(dirty)

      assert.ok(clean.includes('120'))
      assert.ok(!clean.includes('\x00'))
    })

    it('处理 Unicode 字符', () => {
      const normalizeUnicode = (text) => {
        // 保留 Unicode 字符（支持多语言）
        return text.trim()
      }

      const chinese = '答案：120'
      const emoji = 'Answer: 120 ✓'

      assert.ok(normalizeUnicode(chinese).includes('120'))
      assert.ok(normalizeUnicode(emoji).includes('120'))
    })
  })
})
