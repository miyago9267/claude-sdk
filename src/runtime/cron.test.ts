import { describe, expect, test } from 'bun:test'

import { parseCronExpression } from './cron.ts'

describe('cron expression', () => {
  test('matches lists, ranges and steps', () => {
    const expression = parseCronExpression('*/15 9-10 1,15 1-6 1-5')

    expect(expression.matches(new Date('2026-08-24T09:15:00.000Z'))).toBe(false)
    expect(expression.matches(new Date('2026-06-15T09:15:00.000Z'))).toBe(true)
    expect(expression.matches(new Date('2026-06-15T10:45:00.000Z'))).toBe(true)
    expect(expression.matches(new Date('2026-06-15T11:00:00.000Z'))).toBe(false)
  })

  test('uses standard OR semantics when day-of-month and day-of-week are restricted', () => {
    const expression = parseCronExpression('0 9 1 * 1')

    expect(expression.matches(new Date('2026-06-01T09:00:00.000Z'))).toBe(true)
    expect(expression.matches(new Date('2026-06-08T09:00:00.000Z'))).toBe(true)
    expect(expression.matches(new Date('2026-06-02T09:00:00.000Z'))).toBe(false)
  })

  test('finds the next matching UTC minute', () => {
    const expression = parseCronExpression('30 9 * * *')

    expect(expression.nextAfter(new Date('2026-08-24T09:29:00.000Z')).toISOString()).toBe('2026-08-24T09:30:00.000Z')
    expect(expression.nextAfter(new Date('2026-08-24T09:30:00.000Z')).toISOString()).toBe('2026-08-25T09:30:00.000Z')
  })

  test('rejects malformed expressions and out-of-range values', () => {
    expect(() => parseCronExpression('0 9 * *')).toThrow('five fields')
    expect(() => parseCronExpression('61 * * * *')).toThrow('minute')
    expect(() => parseCronExpression('*/0 * * * *')).toThrow('step')
  })
})
