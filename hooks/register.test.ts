import { expect, test } from 'claude-code/testing'

import { describe, nextAt, parseDuration, parseLegArgs, parseTarget, planLegs, promptLine } from './register'

const MIN = 60_000
const mins = (legs: ReturnType<typeof planLegs>) => legs.map(l => `${l.kind}:${(l.endMs - l.startMs) / MIN}`)

test('45 min is 25 focus, 5 break, 15 focus', () => {
  expect(mins(planLegs(0, 45 * MIN))).toEqual(['focus:25', 'break:5', 'focus:15'])
})

test('20 min is a single focus leg with no break', () => {
  expect(mins(planLegs(0, 20 * MIN))).toEqual(['focus:20'])
})

test('a break that would end the session is folded into the focus leg', () => {
  expect(mins(planLegs(0, 30 * MIN))).toEqual(['focus:30'])
})

test('legs tile the session exactly', () => {
  const legs = planLegs(1000, 1000 + 95 * MIN)
  expect(legs[0].startMs).toBe(1000)
  expect(legs[legs.length - 1].endMs).toBe(1000 + 95 * MIN)
  legs.slice(1).forEach((l, i) => expect(l.startMs).toBe(legs[i].endMs))
})

test('describe is undefined once the session is over', () => {
  const s = { startMs: 0, endMs: 10 * MIN, legs: planLegs(0, 10 * MIN), announced: 0 }
  expect(describe(s, 10 * MIN)).toBeUndefined()
  expect(promptLine(s, 11 * MIN)).toBeUndefined()
})

test('prompt line carries minutes left and leg position', () => {
  const s = { startMs: 0, endMs: 45 * MIN, legs: planLegs(0, 45 * MIN), announced: 0 }
  expect(promptLine(s, 14 * MIN)).toContain('31 min left')
  expect(promptLine(s, 14 * MIN)).toContain('focus leg 1/3, 11 min left')
})

test('parseTarget reads 24h and 12h times, with or without until', () => {
  expect(parseTarget('22:00')).toEqual({ hh: 22, mm: 0, isTomorrow: false })
  expect(parseTarget('until 21:40')).toEqual({ hh: 21, mm: 40, isTomorrow: false })
  expect(parseTarget('10pm')).toEqual({ hh: 22, mm: 0, isTomorrow: false })
  expect(parseTarget('9:40 PM')).toEqual({ hh: 21, mm: 40, isTomorrow: false })
  expect(parseTarget('9.40pm')).toEqual({ hh: 21, mm: 40, isTomorrow: false })
  expect(parseTarget('12am')).toEqual({ hh: 0, mm: 0, isTomorrow: false })
  expect(parseTarget('12pm')).toEqual({ hh: 12, mm: 0, isTomorrow: false })
  expect(parseTarget('tomorrow 9:00')).toEqual({ hh: 9, mm: 0, isTomorrow: true })
})

test('parseTarget leaves bare numbers (minutes) and nonsense alone', () => {
  expect(parseTarget('45')).toBeUndefined()
  expect(parseTarget('25:00')).toBeUndefined()
  expect(parseTarget('13pm')).toBeUndefined()
  expect(parseTarget('10:75')).toBeUndefined()
  expect(parseTarget('soon')).toBeUndefined()
})

test('nextAt rolls to tomorrow only when the time has passed, or when asked', () => {
  const noon = new Date(2026, 9, 7, 12, 0, 0).getTime()
  const at = (ms: number) => new Date(ms).getHours() * 60 + new Date(ms).getMinutes()
  expect(nextAt(noon, 13, 0) - noon).toBe(60 * MIN)
  expect(nextAt(noon, 11, 0) - noon).toBe(23 * 60 * MIN)
  expect(at(nextAt(noon, 9, 0, true))).toBe(9 * 60)
  expect(nextAt(noon, 9, 0, true)).toBeGreaterThan(noon)
})

test('parseLegArgs accepts long and short names in any position', () => {
  expect(parseLegArgs('3 focus=1 break=1')).toEqual({ focus: 1, rest: 1, spec: '3' })
  expect(parseLegArgs('3 f=2 b=1')).toEqual({ focus: 2, rest: 1, spec: '3' })
  expect(parseLegArgs('f=10 22:00 breaks=3')).toEqual({ focus: 10, rest: 3, spec: '22:00' })
  expect(parseLegArgs('45')).toEqual({ focus: 25, rest: 5, spec: '45' })
  expect(parseLegArgs('3 f=2').rest).toBe(5)
})

test('parseDuration reads units and defaults to minutes', () => {
  expect(parseDuration('45')).toBe(45)
  expect(parseDuration('45m')).toBe(45)
  expect(parseDuration('30s')).toBe(0.5)
  expect(parseDuration('90 seconds')).toBe(1.5)
  expect(parseDuration('1.5h')).toBe(90)
  expect(parseDuration('0.5')).toBe(0.5)
  expect(parseDuration('soon')).toBeUndefined()
  expect(parseDuration('10pm')).toBeUndefined()
})

test('leg args take units too', () => {
  expect(parseLegArgs('1m f=20s b=10s')).toEqual({ focus: 1 / 3, rest: 1 / 6, spec: '1m' })
})
