import type { Engine, Register } from 'claude-code'

// session-timer v1: a session with a hard end and Pomodoro-style legs.
// State is absolute timestamps in $.store, so reloads and restarts lose nothing.

type Leg = { kind: 'focus' | 'break'; startMs: number; endMs: number; note?: string }
type Session = { startMs: number; endMs: number; legs: Leg[]; announced: number }

const MIN = 60_000
// The leg log lives in the user's ~/.claude; HOME is read once from the host.
let logPath: string | undefined
const BLINK_MS = 6_000
const SOUND = '/System/Library/Sounds/Glass.aiff'
const USAGE = 'Usage: /session 45 | 22:00 | 10pm | until 22:00 | tomorrow 9:00 | status | stop | note <text> | help'
const HELP = [
  'session-timer commands:',
  '  /session <minutes | time> [focus=N] [break=M]   start (focus default 25, break default 5)',
  '      shorthands: f=N for focus, b=M (or breaks=M) for break',
  '      durations take units: 30s, 90s, 5m, 1.5h (a bare number is minutes)',
  '      examples: /session 45   /session 22:00   /session 10pm   /session 3 f=1 b=1',
  '  /session status | stop | note <text> | help',
  'focus/break values must be written with the name; a bare second number is not read.',
].join('\n')

// Focus/break legs from start to end. A session of one focus length or less is a
// single leg; no trailing break (a break that would end the session is folded into
// the focus leg before it). 45 min -> 25 focus, 5 break, 15 focus.
export function planLegs(startMs: number, endMs: number, focusMin = 25, breakMin = 5): Leg[] {
  const legs: Leg[] = []
  let t = startMs
  while (t < endMs) {
    let focusEnd = Math.min(t + focusMin * MIN, endMs)
    if (endMs - focusEnd <= breakMin * MIN) focusEnd = endMs
    legs.push({ kind: 'focus', startMs: t, endMs: focusEnd })
    t = focusEnd
    if (t >= endMs) break
    legs.push({ kind: 'break', startMs: t, endMs: t + breakMin * MIN })
    t += breakMin * MIN
  }
  return legs
}

// Where `now` stands in the session, or undefined once it is over.
export function describe(s: Session, now: number) {
  if (now >= s.endMs) return undefined
  const index = Math.max(0, s.legs.findIndex(l => now < l.endMs))
  const leg = s.legs[index]
  return {
    leg,
    number: index + 1,
    total: s.legs.length,
    legLeftMs: leg.endMs - now,
    sessionLeftMs: s.endMs - now,
  }
}

const pad = (n: number) => String(n).padStart(2, '0')
const clock = (ms: number) => `${pad(Math.floor(ms / MIN))}:${pad(Math.floor((ms % MIN) / 1000))}`
const hhmm = (ms: number) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`

export const statusText = (s: Session, now: number) => {
  const d = describe(s, now)
  return d ? `${d.leg.kind} ${clock(d.legLeftMs)} · session ${clock(d.sessionLeftMs)}` : undefined
}

export const promptLine = (s: Session, now: number) => {
  const d = describe(s, now)
  if (!d) return undefined
  const left = (ms: number) => Math.ceil(ms / MIN)
  return (
    `[session-timer: ${hhmm(now)} · session ends ${hhmm(s.endMs)}, ${left(d.sessionLeftMs)} min left · ` +
    `${d.leg.kind} leg ${d.number}/${d.total}, ${left(d.legLeftMs)} min left]`
  )
}

type Dollar = Engine

const load = async ($: Dollar) => (await $.store.get('session')) as Session | undefined

// One JSONL line per leg: planned vs actual minutes, plus the note, if any.
async function logLeg($: Dollar, leg: Leg, endedMs: number) {
  const line = JSON.stringify({
    at: new Date(endedMs).toISOString(),
    kind: leg.kind,
    plannedMin: Math.round((leg.endMs - leg.startMs) / MIN),
    actualMin: Math.round((Math.min(endedMs, leg.endMs) - leg.startMs) / MIN),
    note: leg.note,
  })
  if (!logPath) {
    const { stdout } = await $.process.run(['printenv', 'HOME'])
    logPath = `${stdout.trim()}/.claude/session-log.jsonl`
  }
  const old = await $.fs.read(logPath).catch(() => '')
  await $.fs.write(logPath, `${old}${old && !old.endsWith('\n') ? '\n' : ''}${line}\n`)
}

// A duration in minutes: "45" and "45m" (minutes), "30s", "1.5h"; units s/sec/seconds,
// m/min/minutes, h/hr/hours, no space. A bare number is minutes.
export function parseDuration(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)?$/i.exec(text.trim())
  if (!m) return undefined
  const n = Number(m[1])
  const unit = (m[2] ?? 'm')[0].toLowerCase()
  return unit === 's' ? n / 60 : unit === 'h' ? n * 60 : n
}

// focus=N / f=N and break=M / breaks=M / b=M, in any position; `spec` is what is left
// (the duration or target time). Defaults: focus 25, break 5.
export function parseLegArgs(args: string) {
  const grab = (names: string) => {
    const m = new RegExp(`(?:^|\\s)(?:${names})=(\\S+)(?=\\s|$)`, 'i').exec(args)
    return m ? parseDuration(m[1]) : undefined
  }
  const spec = args
    .replace(/(?:^|\s)(?:focus|f|breaks?|b)=\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { focus: grab('focus|f') ?? 25, rest: grab('breaks?|b') ?? 5, spec }
}

// A target time of day: "22:00", "until 22", "10pm", "9:40 pm", "9.40pm", "tomorrow 21:00".
// A bare number ("45") is minutes, not a time, so it is not parsed here.
export function parseTarget(text: string) {
  const m = /^(until\s+)?(tomorrow\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/i.exec(text.trim())
  if (!m) return undefined
  const [, until, tomorrow, h, min, ampm] = m
  if (!until && !tomorrow && min === undefined && !ampm) return undefined
  let hh = Number(h)
  const mm = Number(min ?? 0)
  if (ampm) {
    if (hh < 1 || hh > 12) return undefined
    hh = (hh % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0)
  }
  if (hh > 23 || mm > 59) return undefined
  return { hh, mm, isTomorrow: Boolean(tomorrow) }
}

// Next occurrence of HH:MM (local time) after `now`; "tomorrow" is today's HH:MM plus a day.
export function nextAt(now: number, hh: number, mm: number, isTomorrow = false) {
  const d = new Date(now)
  d.setHours(hh, mm, 0, 0)
  const today = d.getTime()
  if (isTomorrow) return today + 24 * 60 * MIN
  return today <= now ? today + 24 * 60 * MIN : today
}

const MAX_UNTIL_MS = 6 * 60 * MIN

let blinkUntil = 0

async function tick($: Dollar) {
  const s = await load($)
  if (!s) return $.ui.status(undefined)
  const now = await $.clock.now()

  // Announce every leg whose end has passed since the last tick.
  while (s.announced < s.legs.length && now >= s.legs[s.announced].endMs) {
    const leg = s.legs[s.announced++]
    await logLeg($, leg, leg.endMs)
    const up = s.legs[s.announced]
    void $.process.run(['afplay', SOUND]).catch(() => undefined) // macOS only; nothing bundled
    void $.ui.toast(up ? `${up.kind === 'break' ? 'Break' : 'Focus'}: ${Math.round((up.endMs - up.startMs) / MIN)} min` : 'Session over')
    blinkUntil = now + BLINK_MS
    await $.store.set('session', s)
  }

  if (now >= s.endMs) {
    // Hold a "session over" status for the blink window so the end is visible, then clear.
    if (now < blinkUntil) return $.ui.status(Math.floor(now / 1000) % 2 === 0 ? '🔔 session over' : 'session over')
    await $.store.delete('session')
    return $.ui.status(undefined)
  }

  const text = statusText(s, now)
  const isBlinkOn = now < blinkUntil && Math.floor(now / 1000) % 2 === 0
  $.ui.status(isBlinkOn ? `🔔 ${text}` : text)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'session',
      description: `Timed session: ${USAGE.replace('Usage: /session ', '')}`,
      argumentHint: USAGE.replace('Usage: /session ', ''),
    })
    $.clock.every(1000, () => void tick($))
    return next(e)
  })

  on('command.run', { command: 'session' }, async ($, e) => {
    const args = e.args.trim()
    const s = await load($)
    const now = await $.clock.now()

    if (['help', '?', '-h', '--help'].includes(args.toLowerCase())) return { text: HELP }

    if (args === '' || args === 'status') {
      const line = s && promptLine(s, now)
      return { text: line ?? 'No active session. Try /session 45 or /session 22:00. /session help lists everything.' }
    }

    if (args === 'stop') {
      if (!s) return { text: 'No active session.' }
      const d = describe(s, now)
      if (d) await logLeg($, d.leg, now)
      await $.store.delete('session')
      $.ui.status(undefined)
      return { text: 'Session stopped.' }
    }

    if (args.startsWith('note ')) {
      const d = s && describe(s, now)
      if (!s || !d) return { text: 'No active session to attach a note to.' }
      d.leg.note = args.slice(5).trim()
      await $.store.set('session', s)
      return { text: `Noted on ${d.leg.kind} leg ${d.number}.` }
    }

    // Start: minutes ("45") or a target time ("22:00", "10pm", "until 22:00", "tomorrow 9:00"),
    // optionally with focus=N break=M.
    const { focus, rest, spec } = parseLegArgs(args)
    const target = parseTarget(spec)
    const minutes = target ? undefined : parseDuration(spec)
    const endMs = target
      ? nextAt(now, target.hh, target.mm, target.isTomorrow)
      : minutes !== undefined
        ? now + minutes * MIN
        : undefined
    if (endMs === undefined) return { text: `Could not read "${args}".\n${HELP}` }
    if (target && !target.isTomorrow && endMs - now > MAX_UNTIL_MS) {
      const h = Math.floor((endMs - now) / (60 * MIN))
      const m = Math.round(((endMs - now) % (60 * MIN)) / MIN)
      return { text: `That time is ${h}h ${m}m away (it has passed today). Did you mean "tomorrow ${spec.replace(/^until\s+/i, '')}"?` }
    }

    const session: Session = { startMs: now, endMs, legs: planLegs(now, endMs, focus, rest), announced: 0 }
    await $.store.set('session', session)
    return { text: `Session started. ${promptLine(session, now)}` }
  }).catch(() => ({ text: 'session-timer: that command failed; see the debug log.' }))

  // The model reads the time beside each prompt; the user's typed text is untouched.
  on('prompt.submit', async ($, e, next) => {
    const s = await load($)
    const line = s && promptLine(s, await $.clock.now())
    return line ? next({ ...e, context: [...(e.context ?? []), line] }) : next(e)
  }).catch(($, e, next) => next(e)) // a timer bug must never swallow a prompt
}
