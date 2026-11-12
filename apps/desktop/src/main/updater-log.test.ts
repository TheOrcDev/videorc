import { describe, expect, it, vi } from 'vitest'

import { createUpdaterLog, UPDATER_LOG_MESSAGE_MAX_CHARS, updaterLogMessage } from './updater-log'

describe('updater log', () => {
  it('keeps the last lines, oldest first, and hands each to the sink', () => {
    const sink = vi.fn()
    let tick = 0
    const log = createUpdaterLog({
      capacity: 2,
      now: () => new Date(Date.UTC(2026, 10, 11, 4, 0, tick++)),
      sink
    })
    log.info('Checking for update')
    log.warn('background download failed: boom')
    log.error(new Error('Command failed'))

    expect(log.snapshot()).toEqual([
      {
        at: '2026-11-11T04:00:01.000Z',
        level: 'warn',
        message: 'background download failed: boom'
      },
      { at: '2026-11-11T04:00:02.000Z', level: 'error', message: 'Command failed' }
    ])
    expect(sink).toHaveBeenCalledTimes(3)
    expect(sink).toHaveBeenLastCalledWith('error', 'Command failed')
  })

  it('drops debug and empty lines', () => {
    const sink = vi.fn()
    const log = createUpdaterLog({ sink })
    log.debug('noise')
    log.info('')
    log.info()
    expect(log.snapshot()).toEqual([])
    expect(sink).not.toHaveBeenCalled()
  })

  it('switches sinks and survives a sink that throws', () => {
    const log = createUpdaterLog()
    log.setSink(() => {
      throw new Error('disk full')
    })
    expect(() => log.warn('still kept')).not.toThrow()
    expect(log.snapshot().map((entry) => entry.message)).toEqual(['still kept'])
  })

  it('flattens multi-line messages and caps their length', () => {
    expect(updaterLogMessage('a\n  b\r\nc')).toBe('a b c')
    expect(updaterLogMessage({ kind: 0 })).toBe('{"kind":0}')
    const long = updaterLogMessage('x'.repeat(5000))
    expect(long).toHaveLength(UPDATER_LOG_MESSAGE_MAX_CHARS)
    expect(long.endsWith('…')).toBe(true)
  })

  it('returns copies from snapshot', () => {
    const log = createUpdaterLog()
    log.info('one')
    const first = log.snapshot()
    first[0]!.message = 'changed'
    expect(log.snapshot()[0]!.message).toBe('one')
  })
})
