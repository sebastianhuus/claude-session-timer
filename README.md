# session-timer

A [Claude Code mod](https://claude.com/resources/articles/claude-code-mods) for timed work
sessions: a session countdown with Pomodoro-style focus/break legs, a status line, a hidden
time line Claude reads with each prompt (so it can pace its answers), a sound and toast at
leg boundaries, and a per-leg log.

## Install

In a terminal Claude Code session:

```
/plugin install session-timer --marketplace sebastianhuus/claude-session-timer
```

Mods are not sandboxed. Read `hooks/register.ts` (one file) before installing.

## Use

```
/session 45                 start a 45-minute session
/session 22:00              end at 22:00 (also 10pm, 9:40pm, until 22:00, tomorrow 9:00)
/session 3 f=1 b=1          legs: focus f= and break b= (default 25 / 5); units: 30s, 5m, 1.5h
/session status | stop (or end, quit) | note <text> | help
```

A session of 25 minutes or less is a single focus leg. Otherwise focus and break legs
alternate, the last one truncated; a break that would end the session is folded into the
focus leg before it (45 min = 25 focus, 5 break, 15 focus).

## What it does

- **Status line** under the prompt: `focus 14:20 · session 52:10`.
- **Hidden prompt line:** while a session is active each prompt carries
  `[session-timer: 21:17 · session ends 22:00, 43 min left · focus leg 1/3, 8 min left]`
  as context for the model. Your typed text is not changed.
- **Leg boundaries:** a sound (macOS `afplay`, plays the system Glass sound in place; nothing bundled), a toast, and a 6 s flash in the status line.
- **Log:** one JSON line per leg in `~/.claude/session-log.jsonl`
  (`at`, `kind`, `plannedMin`, `actualMin`, optional `note` from `/session note`).

State is stored as absolute timestamps in the host's store, so reloads and restarts keep the
session. The sound is macOS only (`afplay`). On Linux and Windows the mod still works and the toast and
flash still show, but there is no sound, and on Windows the leg log is probably skipped too
(untested; failures are ignored, never fatal).

## Develop

```
claude plugin validate .
claude plugin test .
```

## Ideas not built

A colored band above the prompt, a desktop notification, a model-callable tool, pausing during
breaks, and calibrating realistic work per duration from the log.
