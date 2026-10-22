import { describe, expect, it } from 'vitest'

import {
  FOCUS_PROVIDER_REFRESH_MS,
  focusRefreshesProviders,
  lastCheckedLabel
} from './use-scheduled-streams'

// Plan 174 S3.5b (D-34): a window focus asks the platforms again at most every
// five minutes (each ask re-reads every saved event and spends YouTube quota),
// and Refresh says when it last checked.

describe('Upcoming refresh', () => {
  it('asks the platforms on focus only five minutes after the last ask', () => {
    const last = 1_000_000
    expect(FOCUS_PROVIDER_REFRESH_MS).toBe(300_000)
    expect(focusRefreshesProviders(last, last + 60_000)).toBe(false)
    expect(focusRefreshesProviders(last, last + 299_999)).toBe(false)
    expect(focusRefreshesProviders(last, last + 300_000)).toBe(true)
    expect(focusRefreshesProviders(0, Date.now())).toBe(true)
  })

  it('says when it last checked, in words', () => {
    const now = Date.parse('2026-10-11T12:00:00Z')
    expect(lastCheckedLabel(null, now)).toBeNull()
    expect(lastCheckedLabel('2026-10-11T11:59:50Z', now)).toBe('Last checked just now')
    expect(lastCheckedLabel('2026-10-11T11:55:00Z', now)).toBe('Last checked 5m ago')
    expect(lastCheckedLabel('2026-10-11T09:00:00Z', now)).toBe('Last checked 3h ago')
  })
})
