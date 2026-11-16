import { describe, expect, it } from 'vitest'

import type { CloudOnAir, CloudStatus } from './backend'
import { cloudResumeNotice } from './cloud-show-view'

// Plan 184 C5 and plan 243 C5: the Studio's cloud notice for each state of a
// show this computer is not feeding.

const held: CloudStatus = {
  phase: 'hold',
  entitled: true,
  settings: { enabled: true, holdMaxSeconds: 1800, holdMaxChoices: [1800] },
  show: { id: 'sh_1', nodeId: 'livekit', resumable: true, kind: 'solo' },
  connected: true,
  hold: { active: true, reason: 'feed-lost', remainingSeconds: 1500 },
  directFallbackAvailable: false
}
const since = '2026-11-16T20:01:02.000Z'
const phone: CloudOnAir = {
  name: 'iPhone',
  kind: 'phone',
  source: 'camera',
  waiting: false,
  thisDevice: false,
  since
}
const talk = (status: CloudStatus): CloudStatus => ({
  ...status,
  show: { ...status.show!, kind: 'talk' }
})

describe('cloudResumeNotice (plan 184 C5)', () => {
  it('stays away while a session runs, without a resumable show, or once it ends', () => {
    expect(cloudResumeNotice(null, false)).toBeNull()
    expect(cloudResumeNotice(held, true)).toBeNull()
    expect(cloudResumeNotice({ ...held, show: { ...held.show!, resumable: false } }, false)).toBe(
      null
    )
    for (const phase of ['off', 'ending', 'failed'] as const) {
      expect(cloudResumeNotice({ ...held, phase }, false)).toBeNull()
    }
  })

  it('says Resume for a show this computer stopped feeding', () => {
    expect(cloudResumeNotice(held, false)).toEqual({
      title: "You're still live through Videorc Cloud.",
      detail: 'Viewers see Be right back. The stream ends in 25 min unless you resume.',
      action: 'resume',
      tone: 'warning',
      pointer: null
    })
    expect(cloudResumeNotice({ ...held, hold: undefined }, false)?.detail).toBe(
      'Your stream is still on air.'
    )
    expect(cloudResumeNotice(talk(held), false)?.detail).toBe(
      'Your guests are still on. Viewers see Be right back until you resume.'
    )
    expect(cloudResumeNotice(talk({ ...held, hold: undefined }), false)?.detail).toBe(
      'Your guests are still on.'
    )
    // This computer still on air for the web (a crash): Resume, not Continue here.
    expect(
      cloudResumeNotice({ ...held, onAir: { ...phone, thisDevice: true } }, false)?.action
    ).toBe('resume')
  })
})

describe('cloudResumeNotice after a hand-off (plan 243 C5)', () => {
  const waiting: CloudStatus = {
    ...held,
    onAir: { kind: 'computer', source: 'feed', waiting: true, thisDevice: true, since }
  }

  it('says the show waits, how long, and where a phone continues', () => {
    expect(cloudResumeNotice(waiting, false)).toEqual({
      title: 'Your show is waiting for another device.',
      detail: 'Viewers see Be right back. The stream ends in 25 min unless you continue.',
      action: 'continue',
      tone: 'warning',
      pointer: 'On your phone, open videorc.com/live/continue.'
    })
    expect(cloudResumeNotice({ ...waiting, hold: undefined }, false)?.detail).toBeNull()
    expect(cloudResumeNotice(talk(waiting), false)?.detail).toBe(
      'Your guests are still on. Viewers see Be right back until you continue.'
    )
  })

  it('names the device on air elsewhere and offers Continue here', () => {
    expect(cloudResumeNotice({ ...held, phase: 'live', onAir: phone }, false)).toEqual({
      title: 'Your show is live from iPhone.',
      detail: null,
      action: 'continue',
      tone: 'default',
      pointer: null
    })
    // A computer's feed: continuing here breaks before it makes (D2).
    expect(
      cloudResumeNotice(
        {
          ...held,
          onAir: { ...phone, name: 'MacBook Pro', kind: 'computer', source: 'feed' }
        },
        false
      )
    ).toMatchObject({
      title: 'Your show is live from MacBook Pro.',
      detail: 'Viewers see Be right back for a few seconds when you continue here.'
    })
    expect(cloudResumeNotice({ ...held, onAir: { ...phone, name: undefined } }, false)?.title).toBe(
      'Your show is live from a phone.'
    )
    expect(
      cloudResumeNotice(talk({ ...held, onAir: { ...phone, source: 'host' } }), false)
    ).toMatchObject({
      title: 'Your show is live from iPhone.',
      detail: 'Your guests are still on.',
      action: 'continue'
    })
  })
})
