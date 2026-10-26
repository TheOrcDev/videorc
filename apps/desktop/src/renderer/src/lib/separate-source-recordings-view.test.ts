import { describe, expect, it } from 'vitest'

import {
  separateFileFailedToast,
  separateFileRoleFromMessage,
  separateFileStopped
} from './separate-source-recordings-view'

// The role-failure reasons `source_iso.rs` writes (the role supervisor and the
// commit). Each must read as a plain sentence, never as the raw text.
const BACKEND_REASONS = [
  'Screen capture failed after source recovery',
  'Camera encoder failed: VideoToolbox session invalidated',
  'Screen audio failed: tap closed',
  'Screen muxer exited before Stop (exit status: 0)',
  'Camera muxer failed: No such process',
  'Screen muxer exited with exit status: 1',
  'Could not reap Camera muxer: interrupted',
  'Screen muxer exceeded its stop deadline',
  "Audio bus ended before the role's required stop samples arrived",
  'Encoder writer could not be reaped',
  'Encoder teardown failed: task panicked',
  'Audio teardown failed: task panicked',
  'Camera artifact ended at 1200ms, before its expected 4000ms boundary',
  'Screen artifact duration could not be verified',
  'Could not bind Screen recovery media: database is locked',
  'Could not publish Camera without replacing another file: exists',
  'Could not persist published Screen path: database is locked',
  'Screen recording supervisor failed: task panicked',
  'Screen file was missing after Stop.',
  'Interrupted separate recording ownership could not be verified; the current file was not adopted.',
  'Recording was interrupted; partial media is available for recovery.'
]

function row(
  overrides: Partial<Parameters<typeof separateFileStopped>[0]>
): Parameters<typeof separateFileStopped>[0] {
  return {
    recordingRole: 'screen',
    finalizationState: 'failed',
    finalizationError: 'Screen capture failed after source recovery',
    durationMs: 34,
    ...overrides
  }
}

describe('separateFileStopped', () => {
  it('reads every backend reason as one plain sentence', () => {
    for (const reason of BACKEND_REASONS) {
      const stopped = separateFileStopped(row({ finalizationError: reason, durationMs: 5000 }))
      expect(stopped, reason).not.toBeNull()
      expect(stopped!.detail).not.toContain(reason)
      expect(stopped!.detail).not.toMatch(/muxer|encoder writer|artifact|supervisor|backend/i)
    }
  })

  it("says the owner's 34 ms stub stopped early and has nothing to export", () => {
    expect(separateFileStopped(row({}))).toEqual({
      label: 'Stopped early',
      detail:
        "The screen stopped sending video and couldn't be restarted. Nothing usable was recorded before it stopped.",
      exportable: false
    })
  })

  it('keeps a long partial exportable and says how much it kept', () => {
    const stopped = separateFileStopped(
      row({
        recordingRole: 'camera',
        finalizationError: 'Camera capture failed after source recovery',
        durationMs: 252_000
      })
    )
    expect(stopped).toEqual({
      label: 'Stopped early',
      detail: "The camera stopped sending video and couldn't be restarted. The first 4:12 is kept.",
      exportable: true
    })
  })

  it('says an interrupted file stopped early and offers its export', () => {
    const reason = 'Recording was interrupted; partial media is available for recovery.'
    expect(separateFileStopped(row({ finalizationError: reason, durationMs: undefined }))).toEqual({
      label: 'Stopped early',
      detail: 'Videorc closed before this file finished. What it recorded before then is kept.',
      exportable: true
    })
    expect(
      separateFileStopped(
        row({ recordingRole: 'camera', finalizationError: reason, durationMs: 61_000 })
      )
    ).toEqual({
      label: 'Stopped early',
      detail: 'Videorc closed before this file finished. The first 1:01 is kept.',
      exportable: true
    })
  })

  it('says "Not saved" when no file is left', () => {
    expect(
      separateFileStopped(row({ finalizationError: 'Screen file was missing after Stop.' }))
    ).toMatchObject({ label: 'Not saved', exportable: false })
  })

  it('leaves an MP4 export failure, a Combined row and a finished row alone', () => {
    expect(
      separateFileStopped(row({ finalizationError: 'Invalid data found when processing input' }))
    ).toBeNull()
    expect(separateFileStopped(row({ recordingRole: 'combined' }))).toBeNull()
    expect(separateFileStopped(row({ recordingRole: undefined }))).toBeNull()
    expect(separateFileStopped(row({ finalizationState: 'finalized' }))).toBeNull()
    expect(separateFileStopped(row({ mp4Path: '/tmp/take-screen.mp4' }))).toBeNull()
  })
})

describe('separateFileFailedToast', () => {
  it('names the file and says the Combined recording keeps going during the take', () => {
    expect(separateFileFailedToast('Screen capture failed after source recovery', true)).toEqual({
      title: 'Screen file stopped',
      description:
        "The screen stopped sending video and couldn't be restarted. Your Combined recording keeps going."
    })
  })

  it('reads a commit-time failure after the take', () => {
    expect(
      separateFileFailedToast('Camera file: Encoder writer could not be reaped', false)
    ).toEqual({
      title: 'Camera file stopped early',
      description: "Videorc couldn't keep encoding this file."
    })
    expect(separateFileFailedToast('Screen file was missing after Stop.', false)).toEqual({
      title: "Screen file wasn't saved",
      description: "This file wasn't there when you stopped recording."
    })
  })

  it('never shows raw text for a reason it does not know', () => {
    const copy = separateFileFailedToast('Screen file: something new happened', true)
    expect(copy.title).toBe('Screen file stopped')
    expect(copy.description).not.toContain('something new')
  })
})

describe('separateFileRoleFromMessage', () => {
  it('reads the role the message names first', () => {
    expect(separateFileRoleFromMessage('Screen muxer exited before Stop (exit status: 0)')).toBe(
      'screen'
    )
    expect(separateFileRoleFromMessage('Camera file: Audio teardown failed: x')).toBe('camera')
    expect(separateFileRoleFromMessage('Encoder writer could not be reaped')).toBeNull()
  })
})
