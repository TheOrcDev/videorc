import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import {
  LINUX_HELPER_WATCH_INTERVAL_MS,
  LINUX_HELPER_WATCH_WINDOW_MS,
  LINUX_TERMINATION_SIGNALS,
  exitedChromiumHelper,
  installLinuxTerminationSignalTakeover,
  procStatState,
  type ChromiumHelperProcess,
  type LinuxTerminationSignal
} from './linux-termination-signals'

const BROWSER_PID = 100
const helpers: ChromiumHelperProcess[] = [
  { pid: BROWSER_PID, type: 'Browser' },
  { pid: 101, type: 'GPU' },
  { pid: 102, type: 'Utility' },
  { pid: 103, type: 'Tab' }
]

function stat(pid: number, state: string, comm = 'videorc'): string {
  return `${pid} (${comm}) ${state} ${BROWSER_PID} ${pid} ${pid} 0 -1 4194560`
}

function harness(listHelpers: () => ChromiumHelperProcess[] = () => helpers) {
  const source = new EventEmitter()
  const states = new Map<number, string | null>(helpers.map((h) => [h.pid, 'S']))
  const order: string[] = []
  let tick: (() => void) | null = null
  const clock = { now: 1_000 }
  const options = {
    source,
    browserPid: BROWSER_PID,
    listHelpers,
    readProcStat: (pid: number) => {
      const state = states.get(pid)
      return state ? stat(pid, state) : null
    },
    requestQuit: vi.fn((signal: LinuxTerminationSignal) => order.push(`quit ${signal}`)),
    beforeEnd: vi.fn((signal: LinuxTerminationSignal, reason: string) =>
      order.push(`beforeEnd ${signal} ${reason}`)
    ),
    raise: vi.fn((signal: LinuxTerminationSignal) => {
      const listening = LINUX_TERMINATION_SIGNALS.map((s) => source.listenerCount(s))
      order.push(`raise ${signal} listeners ${listening.join(',')}`)
    }),
    setInterval: vi.fn((callback: () => void, ms: number) => {
      expect(ms).toBe(LINUX_HELPER_WATCH_INTERVAL_MS)
      tick = callback
      return 'watch'
    }),
    clearInterval: vi.fn(() => {
      tick = null
    }),
    now: () => clock.now
  }
  const takeover = installLinuxTerminationSignalTakeover(options)
  return { source, states, order, options, takeover, clock, tick: () => tick?.() }
}

describe('procStatState', () => {
  it('reads the state after the last parenthesis of the command name', () => {
    expect(procStatState(stat(7, 'S'))).toBe('S')
    expect(procStatState(stat(7, 'Z', 'odd) name'))).toBe('Z')
    expect(procStatState('garbage')).toBeNull()
    expect(procStatState('7 (videorc)')).toBeNull()
  })
})

describe('exitedChromiumHelper', () => {
  it('skips the browser and renderers and names a gone or zombie helper', () => {
    const states = new Map<number, string | null>([
      [101, 'S'],
      [102, 'R'],
      [103, 'S']
    ])
    const read = (pid: number) => (states.get(pid) ? stat(pid, states.get(pid)!) : null)
    expect(exitedChromiumHelper(helpers, BROWSER_PID, read)).toBeNull()

    states.set(101, 'Z')
    expect(exitedChromiumHelper(helpers, BROWSER_PID, read)).toBe('GPU process 101 exited')

    states.set(101, 'S')
    states.set(103, null)
    expect(exitedChromiumHelper(helpers, BROWSER_PID, read)).toBeNull()

    states.set(102, null)
    expect(exitedChromiumHelper(helpers, BROWSER_PID, read)).toBe('Utility process 102 is gone')
  })
})

describe('installLinuxTerminationSignalTakeover', () => {
  it('quits gracefully on every signal sent to the browser alone', () => {
    const h = harness()
    h.source.emit('SIGTERM')
    h.source.emit('SIGTERM')
    h.source.emit('SIGINT')
    h.source.emit('SIGHUP')
    h.tick()

    expect(h.order).toEqual(['quit SIGTERM', 'quit SIGTERM', 'quit SIGINT', 'quit SIGHUP'])
    expect(h.options.setInterval).toHaveBeenCalledOnce()
    expect(h.options.raise).not.toHaveBeenCalled()
  })

  it('ends by the same signal at once when the helpers were signalled too', () => {
    const h = harness()
    h.states.set(101, 'Z')
    h.source.emit('SIGHUP')

    expect(h.order).toEqual([
      'beforeEnd SIGHUP GPU process 101 exited',
      'raise SIGHUP listeners 0,0,0'
    ])
    expect(h.options.requestQuit).not.toHaveBeenCalled()

    h.source.emit('SIGTERM')
    h.takeover.childProcessGone({ type: 'Utility', reason: 'killed' })
    expect(h.options.raise).toHaveBeenCalledOnce()
  })

  it('ends a graceful quit once a helper dies under it', () => {
    const h = harness()
    h.source.emit('SIGTERM')
    h.tick()
    h.states.set(102, null)
    h.tick()

    expect(h.order).toEqual([
      'quit SIGTERM',
      'beforeEnd SIGTERM Utility process 102 is gone',
      'raise SIGTERM listeners 0,0,0'
    ])
    expect(h.options.clearInterval).toHaveBeenCalledWith('watch')
  })

  it('keeps the graceful quit while its windows close', () => {
    const h = harness()
    h.source.emit('SIGTERM')
    h.states.set(103, 'Z')
    h.tick()
    h.takeover.childProcessGone({ type: 'Tab', reason: 'killed' })

    expect(h.order).toEqual(['quit SIGTERM'])
    expect(h.options.raise).not.toHaveBeenCalled()
  })

  it('stops watching once the window after the first signal has passed', () => {
    const h = harness()
    h.source.emit('SIGTERM')
    h.clock.now += LINUX_HELPER_WATCH_WINDOW_MS + 1
    h.tick()
    expect(h.options.clearInterval).toHaveBeenCalledWith('watch')

    h.states.set(102, 'Z')
    h.tick()
    h.takeover.childProcessGone({ type: 'GPU', reason: 'crashed' })
    expect(h.options.raise).not.toHaveBeenCalled()

    // A later signal that reached the helpers too still ends at once.
    h.source.emit('SIGINT')
    expect(h.order).toEqual([
      'quit SIGTERM',
      'beforeEnd SIGINT Utility process 102 exited',
      'raise SIGINT listeners 0,0,0'
    ])
  })

  it('ends a graceful quit when Chromium reports a helper gone', () => {
    const h = harness()
    h.takeover.childProcessGone({ type: 'Utility', reason: 'killed' })
    expect(h.options.raise).not.toHaveBeenCalled()

    h.source.emit('SIGINT')
    h.takeover.childProcessGone({ type: 'Utility', reason: 'clean-exit' })
    expect(h.options.raise).not.toHaveBeenCalled()

    h.takeover.childProcessGone({ type: 'Utility', reason: 'killed' })
    expect(h.order).toEqual([
      'quit SIGINT',
      'beforeEnd SIGINT Chromium Utility process killed',
      'raise SIGINT listeners 0,0,0'
    ])
  })

  it('keeps the graceful quit when the helpers cannot be listed', () => {
    const h = harness(() => {
      throw new Error('app metrics unavailable')
    })
    h.source.emit('SIGTERM')
    h.tick()

    expect(h.order).toEqual(['quit SIGTERM'])
    expect(h.options.raise).not.toHaveBeenCalled()
  })
})
