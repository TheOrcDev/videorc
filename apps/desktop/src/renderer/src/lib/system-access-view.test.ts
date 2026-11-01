import { describe, expect, it } from 'vitest'

import type { SystemAccessRow, SystemAccessState } from './system-access'
import {
  FIRST_RUN_ROWS_FALLBACK_MS,
  firstRunPrimary,
  firstRunSetupDescription,
  systemAccessRowsReady,
  systemAccessTag,
  systemAccessActionLabel,
  systemAccessStatus,
  systemAccessVisibleDetail
} from './system-access-view'

const row = (state: SystemAccessState, id: SystemAccessRow['id'] = 'camera'): SystemAccessRow => ({
  id,
  label: 'Camera',
  purpose: 'Camera overlay in your scenes.',
  state,
  detail: `Detail for ${state}.`,
  required: id === 'screen-recording' || id === 'microphone'
})

describe('systemAccessStatus (plan 174 I-10, A-16)', () => {
  it('gives each state one word and one tone, in both homes', () => {
    expect(systemAccessStatus('granted')).toEqual({ label: 'Granted', tone: 'good' })
    expect(systemAccessStatus('not-granted')).toEqual({ label: 'Not granted', tone: 'warn' })
    expect(systemAccessStatus('device-issue')).toEqual({ label: 'Device issue', tone: 'warn' })
    expect(systemAccessStatus('first-use')).toEqual({
      label: 'Not asked yet',
      tone: 'neutral'
    })
  })
})

describe('systemAccessActionLabel', () => {
  it('names the OS prompt and the settings app it opens', () => {
    expect(systemAccessActionLabel('request-media-access', 'darwin')).toBe('Allow…')
    expect(systemAccessActionLabel('open-settings', 'darwin')).toBe('Open System Settings…')
    expect(systemAccessActionLabel('open-settings', 'win32')).toBe('Open Windows Settings…')
    expect(systemAccessActionLabel(null, 'darwin')).toBeNull()
  })
})

describe('systemAccessVisibleDetail', () => {
  it('shows the detail in full while something is left to do, and none once granted', () => {
    expect(systemAccessVisibleDetail(row('granted', 'microphone'))).toBeNull()
    expect(systemAccessVisibleDetail(row('granted'))).toBe('Detail for granted.')
    expect(systemAccessVisibleDetail(row('not-granted'))).toBe('Detail for not-granted.')
    expect(systemAccessVisibleDetail(row('first-use'))).toBe('Detail for first-use.')
    expect(systemAccessVisibleDetail(row('device-issue'))).toBe('Detail for device-issue.')
  })
})

describe('firstRunPrimary and row tags', () => {
  it('requires only recording grants and returns one completion action', () => {
    expect(
      firstRunPrimary([
        row('granted', 'screen-recording'),
        row('granted', 'microphone'),
        row('first-use')
      ])
    ).toEqual({ label: 'Continue', completion: 'done' })
    expect(firstRunPrimary([])).toEqual({ label: 'Continue', completion: 'done' })
    for (const state of [
      'first-use',
      'not-granted',
      'waiting',
      'needs-relaunch',
      'device-issue'
    ] as const) {
      expect(firstRunPrimary([row(state, 'microphone')])).toEqual({
        label: 'Skip for now',
        completion: 'skipped'
      })
    }
    expect(firstRunPrimary([row('not-required', 'screen-recording')]).completion).toBe('done')
    expect(firstRunPrimary([{ ...row('granted', 'microphone'), checking: true }]).completion).toBe(
      'done'
    )
  })

  it('tags required rows, the optional camera, and leaves system audio untagged', () => {
    expect(systemAccessTag(row('granted', 'microphone'))).toBe('Needed to record')
    expect(systemAccessTag(row('granted', 'screen-recording'))).toBe('Needed to record')
    expect(systemAccessTag(row('granted'))).toBe('Optional')
    expect(systemAccessTag(row('granted', 'system-audio'))).toBeNull()
  })

  it.each([
    ['waiting', 'Waiting', 'neutral'],
    ['needs-relaunch', 'Reopen needed', 'warn'],
    ['not-required', 'Ready', 'good'],
    ['unavailable', 'Not available', 'neutral']
  ] as const)('maps %s to its chip', (state, label, tone) => {
    expect(systemAccessStatus(state)).toEqual({ label, tone })
  })

  it('labels the direct relaunch without an ellipsis and hides details while checking', () => {
    expect(systemAccessActionLabel('relaunch', 'darwin')).toBe('Reopen Videorc')
    expect(systemAccessVisibleDetail({ ...row('waiting'), checking: true })).toBeNull()
  })
})

describe('first-run setup (plan 203 S5)', () => {
  it("describes the step in the OS's words", () => {
    expect(firstRunSetupDescription('darwin')).toBe(
      'First, let Videorc record your Mac. macOS asks once for each, and you can change them later in Settings → Permissions.'
    )
    expect(firstRunSetupDescription('win32')).toBe(
      'First, check that Windows lets Videorc use your camera and microphone. You can change this later in Settings → Permissions.'
    )
    expect(firstRunSetupDescription('linux')).toContain('nothing to grant here')
  })

  it('trusts the rows once the OS has answered and the devices are listed, or after the wait', () => {
    expect(
      systemAccessRowsReady({ mediaAccessReady: false, devicesListed: true, waitedLong: true })
    ).toBe(false)
    expect(
      systemAccessRowsReady({ mediaAccessReady: true, devicesListed: false, waitedLong: false })
    ).toBe(false)
    expect(
      systemAccessRowsReady({ mediaAccessReady: true, devicesListed: true, waitedLong: false })
    ).toBe(true)
    // A broken backend never blocks setup.
    expect(
      systemAccessRowsReady({ mediaAccessReady: true, devicesListed: false, waitedLong: true })
    ).toBe(true)
    expect(FIRST_RUN_ROWS_FALLBACK_MS).toBe(5000)
  })
})
