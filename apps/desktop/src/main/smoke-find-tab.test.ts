import { describe, expect, it } from 'vitest'

import { SMOKE_FIND_TAB_SOURCE, SMOKE_FIND_TAB_TIMEOUT_MS } from './smoke-find-tab'

type FakeElement = { getAttribute: (name: string) => string | null; id: string }

type FindTab = (
  doc: unknown,
  tabId: string,
  sleep: (ms: number) => Promise<void>,
  timeoutMs?: number,
  now?: () => number
) => Promise<FakeElement>

const findTab = new Function(`return (${SMOKE_FIND_TAB_SOURCE})`)() as FindTab

function trigger(id: string): FakeElement {
  return { id, getAttribute: (name) => (name === 'data-videorc-tab-trigger' ? id : null) }
}

/** A document whose sidebar mounts after `mountAfterMs` of (fake) time. */
function fakeDocument(clock: { ms: number }, mountAfterMs: number, ids: string[]) {
  return {
    querySelectorAll: () => (clock.ms >= mountAfterMs ? ids.map(trigger) : []),
    querySelector: () => null
  }
}

function fakeTime() {
  const clock = { ms: 0 }
  const sleep = async (ms: number): Promise<void> => {
    clock.ms += ms
  }
  return { clock, sleep, now: () => clock.ms }
}

describe('SMOKE_FIND_TAB_SOURCE', () => {
  it('waits for a sidebar that mounts after a reload', async () => {
    const { clock, sleep, now } = fakeTime()
    const doc = fakeDocument(clock, 1_700, ['studio', 'sources'])
    const tab = await findTab(doc, 'sources', sleep, undefined, now)
    expect(tab.id).toBe('sources')
    expect(clock.ms).toBeGreaterThanOrEqual(1_700)
    expect(clock.ms).toBeLessThan(1_800)
  })

  it('finds a mounted tab without waiting', async () => {
    const { clock, sleep, now } = fakeTime()
    const tab = await findTab(fakeDocument(clock, 0, ['sources']), 'sources', sleep, undefined, now)
    expect(tab.id).toBe('sources')
    expect(clock.ms).toBe(0)
  })

  it('falls back to a data-videorc-open-tab button', async () => {
    const { sleep, now } = fakeTime()
    const button = trigger('captions-door')
    const doc = {
      querySelectorAll: () => [],
      querySelector: (selector: string) =>
        selector === '[data-videorc-open-tab="captions"]' ? button : null
    }
    expect(await findTab(doc, 'captions', sleep, undefined, now)).toBe(button)
  })

  it('still fails with the old message once the deadline passes', async () => {
    const { clock, sleep, now } = fakeTime()
    const doc = fakeDocument(clock, Number.POSITIVE_INFINITY, [])
    await expect(findTab(doc, 'sources', sleep, undefined, now)).rejects.toThrow(
      'Could not find tab sources'
    )
    expect(clock.ms).toBeGreaterThanOrEqual(SMOKE_FIND_TAB_TIMEOUT_MS)
  })
})
