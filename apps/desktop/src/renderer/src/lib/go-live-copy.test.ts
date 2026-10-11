import { describe, expect, it } from 'vitest'

import {
  GO_LIVE_CHECKING_LABEL,
  GO_LIVE_COMMAND,
  GO_LIVE_DIALOG_TITLE,
  GO_LIVE_LABEL,
  GO_LIVE_NO_DESTINATION_TITLE,
  GO_LIVE_SHORTCUT_LABEL,
  OPEN_LIVESTREAM_LABEL,
  RECORD_LABEL,
  RECORD_SHORTCUT_LABEL,
  START_RECORDING_COMMAND,
  USE_FOR_GO_LIVE_LABEL,
  goLiveConfirmLabel,
  goLiveOnReadyLabel
} from './go-live-copy'

// Plan 174 S2.2 (D3): one verb pair on every surface, as docs/ui-copy.md
// tables it. smoke:start-labels pins the same words from outside the app.
describe('the going-live vocabulary (plan 174 D3)', () => {
  it('names the transport, ⌘K, the shortcuts and Upcoming the D3 way', () => {
    expect([RECORD_LABEL, GO_LIVE_LABEL]).toEqual(['Record', 'Go Live…'])
    expect([START_RECORDING_COMMAND, GO_LIVE_COMMAND]).toEqual(['Start recording', 'Go live…'])
    expect([RECORD_SHORTCUT_LABEL, GO_LIVE_SHORTCUT_LABEL]).toEqual([
      'Record / stop recording',
      'Go Live / end livestream'
    ])
    expect(USE_FOR_GO_LIVE_LABEL).toBe('Use for Go Live…')
    expect(GO_LIVE_DIALOG_TITLE).toBe('Go live')
  })

  it('refuses a Go Live with no destination with one fix, and checks from the first click (S3.1)', () => {
    expect(GO_LIVE_NO_DESTINATION_TITLE).toBe('Set up a destination to go live')
    expect(OPEN_LIVESTREAM_LABEL).toBe('Open Livestream')
    expect(GO_LIVE_CHECKING_LABEL).toBe('Checking…')
  })

  it('says how many destinations the Go Live dialog starts, past one', () => {
    expect(goLiveConfirmLabel(0)).toBe('Go live')
    expect(goLiveConfirmLabel(1)).toBe('Go live')
    expect(goLiveConfirmLabel(2)).toBe('Go live on 2 destinations')
    expect(goLiveConfirmLabel(3)).toBe('Go live on 3 destinations')
  })

  it('names the one ready destination after a partial setup, else counts them', () => {
    expect(goLiveOnReadyLabel(['Twitch'])).toBe('Go live on Twitch')
    expect(goLiveOnReadyLabel(['Twitch', 'Kick'])).toBe('Go live on 2 destinations')
  })

  it('keeps the action name capitalized and every other word in sentence case', () => {
    for (const label of [
      RECORD_LABEL,
      GO_LIVE_LABEL,
      START_RECORDING_COMMAND,
      GO_LIVE_COMMAND,
      RECORD_SHORTCUT_LABEL,
      GO_LIVE_SHORTCUT_LABEL,
      USE_FOR_GO_LIVE_LABEL,
      GO_LIVE_DIALOG_TITLE,
      goLiveConfirmLabel(3)
    ]) {
      const words = label
        .replace('Go Live', '')
        .split(/[\s/…]+/)
        .filter(Boolean)
        .slice(1)
      expect(
        words.every((word) => word === word.toLowerCase()),
        label
      ).toBe(true)
      expect(label).not.toMatch(/\.\.\.|session|Stream\b/)
    }
  })
})
