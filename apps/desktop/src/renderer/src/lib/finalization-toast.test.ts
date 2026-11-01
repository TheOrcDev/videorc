import { toast as sonner } from 'sonner'
import { describe, expect, it } from 'vitest'

import {
  finalizationToastId,
  showMp4ExportFailed,
  showMp4Finalizing,
  showMp4Ready
} from './finalization-toast'

// One toast per recording, updated in place by id. Sonner merges an update
// into the toast it replaces, so a field the new state does not set survives
// from the old one (E2E 2026-11-01: "MP4 ready" still said "Long recordings
// can take several minutes to save as MP4").
function current(sessionId: string) {
  return sonner.getHistory().find((entry) => entry.id === finalizationToastId(sessionId))
}

describe('finalization toasts', () => {
  it('MP4 ready drops the saving description it replaces', () => {
    showMp4Finalizing('take-1', 'Saving MP4 · 98%')
    showMp4Ready('take-1')

    const ready = current('take-1')
    expect(ready).toMatchObject({ type: 'success', title: 'MP4 ready' })
    expect(ready && 'description' in ready ? ready.description : undefined).toBeUndefined()
    expect(ready && 'action' in ready ? ready.action : undefined).toMatchObject({
      label: expect.any(String)
    })
  })

  it('a retried export drops the failed toast Retry action while it saves', () => {
    showMp4ExportFailed('take-2', () => undefined, undefined)
    showMp4Finalizing('take-2', 'Saving MP4…')

    const saving = current('take-2')
    expect(saving).toMatchObject({ type: 'loading', title: 'Saving MP4…' })
    expect(saving && 'action' in saving ? saving.action : undefined).toBeUndefined()
  })

  // E2E 2026-11-01 (Linux, low disk): the export after Stop was refused for
  // want of space, and the toast only said the recording was safe, so Retry
  // was the one step offered and it could not work until space was freed.
  it('a failed export for want of disk space says how much and what to do', () => {
    const refusal =
      'Not enough disk space to finish the MP4 (needs 541 MB, 148 MB free). Your recording is safe as MKV; free some space and use Export MP4.'
    showMp4ExportFailed('take-3', () => undefined, refusal)

    expect(current('take-3')).toMatchObject({
      type: 'error',
      title: 'MP4 export failed',
      description: refusal
    })
  })

  it('any other export failure keeps its reason out of the toast', () => {
    showMp4ExportFailed('take-4', () => undefined, 'ffmpeg exited with status 1')

    expect(current('take-4')).toMatchObject({ description: 'Your original recording is safe.' })
  })
})
