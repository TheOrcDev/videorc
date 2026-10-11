import { describe, expect, it } from 'vitest'

import type { SystemAccessRow, SystemAccessState } from './system-access'
import {
  permissionsOnboardingContinueLabel,
  systemAccessActionLabel,
  systemAccessStatus,
  systemAccessVisibleDetail
} from './system-access-view'

const row = (state: SystemAccessState, id: SystemAccessRow['id'] = 'camera'): SystemAccessRow => ({
  id,
  label: 'Camera',
  purpose: 'Camera overlay in your scenes.',
  state,
  detail: `Detail for ${state}.`
})

describe('systemAccessStatus (plan 174 I-10, A-16)', () => {
  it('gives each state one word and one tone, in both homes', () => {
    expect(systemAccessStatus('granted')).toEqual({ label: 'Granted', tone: 'good' })
    expect(systemAccessStatus('not-granted')).toEqual({ label: 'Not granted', tone: 'warn' })
    expect(systemAccessStatus('device-issue')).toEqual({ label: 'Device issue', tone: 'warn' })
    expect(systemAccessStatus('first-use')).toEqual({
      label: 'Checked on first use',
      tone: 'neutral'
    })
  })
})

describe('systemAccessActionLabel', () => {
  it('names the OS prompt and the settings app it opens', () => {
    expect(systemAccessActionLabel('request-media-access', 'darwin')).toBe('Allow access…')
    expect(systemAccessActionLabel('open-settings', 'darwin')).toBe('Open System Settings…')
    expect(systemAccessActionLabel('open-settings', 'win32')).toBe('Open Windows Settings…')
    expect(systemAccessActionLabel(null, 'darwin')).toBeNull()
  })
})

describe('systemAccessVisibleDetail', () => {
  it('shows the detail in full while something is left to do, and none once granted', () => {
    expect(systemAccessVisibleDetail(row('granted'))).toBeNull()
    expect(systemAccessVisibleDetail(row('not-granted'))).toBe('Detail for not-granted.')
    expect(systemAccessVisibleDetail(row('first-use'))).toBe('Detail for first-use.')
    expect(systemAccessVisibleDetail(row('device-issue'))).toBe('Detail for device-issue.')
  })
})

describe('permissionsOnboardingContinueLabel (V-11)', () => {
  it('reads Continue when nothing required is missing, first-use rows included', () => {
    expect(
      permissionsOnboardingContinueLabel([
        row('granted', 'screen-recording'),
        row('first-use', 'camera'),
        row('granted', 'microphone')
      ])
    ).toBe('Continue')
    expect(permissionsOnboardingContinueLabel([row('device-issue')])).toBe('Continue')
  })

  it('offers to skip only while the OS refuses a grant', () => {
    expect(
      permissionsOnboardingContinueLabel([
        row('granted', 'camera'),
        row('not-granted', 'microphone')
      ])
    ).toBe('Skip for now')
  })
})
