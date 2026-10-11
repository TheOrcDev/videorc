// Plan 178 U6. Test doubles shared by the harness unit tests: a fake clock
// whose timers fire only when the test advances time. Not used at runtime.

export function createFakeClock(start = Date.parse('2026-10-12T06:00:00.000Z')) {
  let at = start
  let nextId = 1
  const timers = new Map()

  const flush = async () => {
    for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve))
  }

  const clock = {
    now: () => at,
    setTimeout(fn, ms) {
      const id = nextId++
      timers.set(id, { at: at + Math.max(0, ms), fn, every: null })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    setInterval(fn, ms) {
      const id = nextId++
      timers.set(id, { at: at + Math.max(1, ms), fn, every: Math.max(1, ms) })
      return id
    },
    clearInterval(id) {
      timers.delete(id)
    },
    pending: () => timers.size,
    flush,
    /** Moves time forward, firing due timers in order and letting promises settle. */
    async advance(ms) {
      const target = at + ms
      await flush()
      for (;;) {
        let dueId = null
        let due = null
        for (const [id, timer] of timers) {
          if (timer.at <= target && (due === null || timer.at < due.at)) {
            dueId = id
            due = timer
          }
        }
        if (!due) break
        at = due.at
        if (due.every) due.at += due.every
        else timers.delete(dueId)
        due.fn()
        await flush()
      }
      at = target
      await flush()
    }
  }
  return clock
}
