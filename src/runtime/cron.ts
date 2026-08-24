type CronFieldName = 'minute' | 'hour' | 'day-of-month' | 'month' | 'day-of-week'

const FIELD_RANGES: Record<CronFieldName, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  'day-of-month': [1, 31],
  month: [1, 12],
  'day-of-week': [0, 7],
}

export interface CronExpression {
  expression: string
  matches(date: Date): boolean
  nextAfter(date: Date): Date
}

export function parseCronExpression(expression: string): CronExpression {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('cron expression must contain five fields')
  const names: CronFieldName[] = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week']
  const values = fields.map((field, index) => parseField(field, names[index]!))
  const domWildcard = fields[2] === '*'
  const dowWildcard = fields[4] === '*'

  const matches = (date: Date): boolean => {
    const minute = date.getUTCMinutes()
    const hour = date.getUTCHours()
    const dayOfMonth = date.getUTCDate()
    const month = date.getUTCMonth() + 1
    const dayOfWeek = date.getUTCDay()
    const dayMatches = domWildcard || dowWildcard
      ? values[2]!.has(dayOfMonth) && values[4]!.has(dayOfWeek)
      : values[2]!.has(dayOfMonth) || values[4]!.has(dayOfWeek)
    return values[0]!.has(minute) && values[1]!.has(hour) && values[3]!.has(month) && dayMatches
  }

  return {
    expression: expression.trim(),
    matches,
    nextAfter(date: Date): Date {
      const candidate = new Date(date)
      candidate.setUTCSeconds(0, 0)
      candidate.setUTCMinutes(candidate.getUTCMinutes() + 1)
      for (let index = 0; index < 5 * 366 * 24 * 60; index += 1) {
        if (matches(candidate)) return candidate
        candidate.setUTCMinutes(candidate.getUTCMinutes() + 1)
      }
      throw new Error(`cron expression has no match within five years: ${expression}`)
    },
  }
}

function parseField(value: string, name: CronFieldName): Set<number> {
  const [minimum, maximum] = FIELD_RANGES[name]
  const result = new Set<number>()
  for (const part of value.split(',')) {
    const [rangePart, stepPart] = part.split('/')
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step <= 0) throw new Error(`invalid ${name} step`)
    const [start, end] = parseRange(rangePart!, minimum, maximum, name)
    for (let current = start; current <= end; current += step) result.add(current)
  }
  return result
}

function parseRange(value: string, minimum: number, maximum: number, name: CronFieldName): [number, number] {
  if (value === '*') return [minimum, maximum]
  const parts = value.split('-')
  if (parts.length > 2) throw new Error(`invalid ${name} range`)
  const start = parseNumber(parts[0]!, minimum, maximum, name)
  const end = parts[1] === undefined ? start : parseNumber(parts[1], minimum, maximum, name)
  if (end < start) throw new Error(`invalid ${name} range`)
  return [start, end]
}

function parseNumber(value: string, minimum: number, maximum: number, name: CronFieldName): number {
  const number = Number(value)
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`invalid ${name} value: ${value}`)
  }
  return number
}
