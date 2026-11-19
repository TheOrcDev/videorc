import { describe, expect, it } from 'vitest'

import { quietFooterLine, quietWhileLiveOn } from '@/lib/quiet-while-live'

describe('Quiet while recording or live (plan 250, D4)', () => {
  it('is on by default: an absent key is on', () => {
    expect(quietWhileLiveOn({})).toBe(true)
    expect(quietWhileLiveOn({ quietWhileLive: true })).toBe(true)
    expect(quietWhileLiveOn({ quietWhileLive: false })).toBe(false)
  })

  it('the list says what the rule is doing', () => {
    expect(quietFooterLine({})).toBe('Quiet while recording or live.')
    expect(quietFooterLine({ quietWhileLive: false })).toBe('Quiet is off while recording or live.')
  })
})
