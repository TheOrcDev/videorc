import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { overlayEditsBlockedReason } from '@/components/scene/overlay-stage'
import type { OverlayItem } from '@/lib/backend'
import {
  LIVE_PLACEMENT_HINT,
  OVERLAY_ITEM_OFF_LINES,
  OverlayItemInspector,
  OverlayItemSection,
  SCENE_POSITION_LOCK_REASON,
  SCENE_POSITION_UNAVAILABLE_REASON,
  placementControls,
  scenePositionLockReason
} from './layout-tab'

// Plan 174, C-6: overlay changes never fail silently. Without the backend the
// controls are off, with one reason above them.

function render(blockedReason: string | null): string {
  return renderToStaticMarkup(
    createElement(OverlayItemInspector, {
      blockedReason,
      item: 'buddy',
      layout: { showOnStream: true, showInRecording: false },
      orientation: 'horizontal',
      onPatch: () => {},
      onSnap: () => {}
    })
  )
}

const switches = (markup: string): string[] => markup.match(/<span[^>]*role="switch"[^>]*>/g) ?? []
// The snaps are one-shot Buttons inside the "Snap overlay" group (plan 174 S1.7, C-37).
const snaps = (markup: string): string[] =>
  markup
    .split('aria-label="Snap overlay"')[1]
    ?.match(/<button[^>]*>/g)
    ?.filter((button) => !button.includes('role=')) ?? []

describe('the overlay inspector (plan 174, C-6)', () => {
  it('turns every control off with one reason while the backend is away', () => {
    const reason = overlayEditsBlockedReason('closed')!
    const markup = render(reason)
    // Once, and only once: the app's one offline wording, as a polite lock
    // line (plan 174 S1.5), not an assertive alert.
    expect(markup.split('These controls come back in a moment.')).toHaveLength(2)
    expect(markup).toContain('data-variant="locked"')
    expect(markup).toContain('role="status"')
    expect(switches(markup)).toHaveLength(2)
    for (const control of switches(markup)) expect(control).toContain('aria-disabled="true"')
    for (const control of snaps(markup)) expect(control).toContain('disabled=""')
    expect(snaps(markup).length).toBeGreaterThan(0)
  })

  it('keeps the controls on, with no notice, while connected', () => {
    const markup = render(overlayEditsBlockedReason('connected'))
    expect(markup).not.toContain('data-slot="alert"')
    for (const control of switches(markup)) expect(control).not.toContain('aria-disabled')
    for (const control of snaps(markup)) expect(control).not.toContain('disabled=""')
  })
})

// Plan 205 S3 (D4): Buddy with both switches off is never drawn, even while
// selected, so its section says so above the two switches.
function renderSection(
  item: OverlayItem,
  layout: { showOnStream: boolean; showInRecording: boolean }
): string {
  return renderToStaticMarkup(
    createElement(OverlayItemSection, {
      blockedReason: null,
      item,
      layout,
      orientation: 'horizontal',
      onPatch: () => {},
      onSnap: () => {}
    })
  )
}

const OFF_LINE = "Off. Viewers don't see Buddy."

// Plan 215 G (D5): the chat box is an overlay item like Highlight and
// Captions, with the same two switches, off by default.
describe('the Chat item (plan 215 G)', () => {
  it('has Show on stream and Show in recording, and says it carries names', () => {
    const markup = renderSection('chat', { showOnStream: false, showInRecording: false })
    expect(markup).toContain('data-videorc-overlay-inspector="chat"')
    expect(markup).toContain('id="overlay-chat-stream"')
    expect(markup).toContain('id="overlay-chat-recording"')
    expect(markup).toContain('Show on stream')
    expect(markup).toContain('Show in recording')
    expect(markup.replace(/&#x27;/g, "'")).toContain("with each viewer's name")
    expect(switches(markup)).toHaveLength(2)
    for (const control of switches(markup)) expect(control).toContain('aria-checked="false"')
    const line = markup.match(/<span data-videorc-overlay-off-line="chat">([^<]*)<\/span>/)
    expect(line?.[1].replace(/&#x27;/g, "'")).toBe("Off. Viewers don't see chat.")
  })

  it('drops the off line once either switch is on', () => {
    const markup = renderSection('chat', { showOnStream: true, showInRecording: false })
    expect(markup).not.toContain('data-videorc-overlay-off-line')
    expect(switches(markup)[0]).toContain('aria-checked="true"')
  })
})

describe('the overlay section (plan 205 S3, D4)', () => {
  it('says an off Buddy goes nowhere, above its two switches', () => {
    const markup = renderSection('buddy', { showOnStream: false, showInRecording: false })
    expect(OVERLAY_ITEM_OFF_LINES.buddy).toBe(OFF_LINE)
    // React escapes the apostrophe in markup.
    const line = markup.match(/<span data-videorc-overlay-off-line="buddy">([^<]*)<\/span>/)
    expect(line?.[1].replace(/&#x27;/g, "'")).toBe(OFF_LINE)
    expect(markup.indexOf('data-videorc-overlay-off-line')).toBeLessThan(
      markup.indexOf('role="switch"')
    )
    expect(markup).toContain('<h2')
    expect(markup).not.toContain('text-subtle')
    expect(switches(markup)).toHaveLength(2)
    for (const control of switches(markup)) expect(control).toContain('aria-checked="false"')
  })

  it('says nothing while Buddy goes to either output, or for the other items', () => {
    // The owner's Buddy (stream only): drawn, and its chip says "Stream only".
    for (const layout of [
      { showOnStream: true, showInRecording: false },
      { showOnStream: false, showInRecording: true },
      { showOnStream: true, showInRecording: true }
    ]) {
      expect(renderSection('buddy', layout)).not.toContain('data-videorc-overlay-off-line')
    }
    for (const item of ['highlight', 'captions'] as const) {
      const markup = renderSection(item, { showOnStream: false, showInRecording: false })
      expect(markup).not.toContain('data-videorc-overlay-off-line')
      expect(markup).not.toContain('Viewers don&#x27;t see')
    }
  })
})

// Plan 215 D4 (B2): Edit scene turns the editor on, which wakes the arrows.
// While recording or live it still opens the editor, and the line says why
// the arrows stay off.
describe('the Placement section (plan 215 B2)', () => {
  const idle = { isSessionActive: false, acceptsLiveSceneEdits: null, stageDragging: false }

  it('wakes the arrows once the editor is on', () => {
    expect(placementControls({ ...idle, sceneEditMode: false }).nudgeDisabled).toBe(true)
    expect(placementControls({ ...idle, sceneEditMode: true })).toEqual({
      nudgeDisabled: false,
      description:
        'Click the source on the stage to edit it: drag it, or nudge it with the arrows.',
      lockReason: null
    })
    expect(
      placementControls({ ...idle, sceneEditMode: true, stageDragging: true }).nudgeDisabled
    ).toBe(true)
  })

  it('keeps them off while a session has not said it takes a move, and says why', () => {
    expect(
      placementControls({
        sceneEditMode: true,
        isSessionActive: true,
        acceptsLiveSceneEdits: null,
        stageDragging: false
      })
    ).toEqual({
      nudgeDisabled: true,
      description: SCENE_POSITION_LOCK_REASON,
      lockReason: SCENE_POSITION_LOCK_REASON
    })
  })
})

// Plan 215 D1: a source moves while recording or live once the session says
// a commit reaches its picture (`recording.status.acceptsLiveSceneEdits`).
// The outputs move on release, and the line says so; a session on the
// legacy FFmpeg graph keeps the lock and says why.
describe('a live session (plan 215 D1)', () => {
  const live = { isSessionActive: true, stageDragging: false, sceneEditMode: true }

  it('lifts the lock when the session takes a move, and says where a change lands', () => {
    expect(scenePositionLockReason({ isSessionActive: true, acceptsLiveSceneEdits: true })).toBe(
      null
    )
    expect(placementControls({ ...live, acceptsLiveSceneEdits: true })).toEqual({
      nudgeDisabled: false,
      description: LIVE_PLACEMENT_HINT,
      lockReason: null
    })
    expect(LIVE_PLACEMENT_HINT).toBe('Changes apply to your stream when you let go.')
    // A gesture in flight still parks the arrows, as it does idle.
    expect(
      placementControls({ ...live, acceptsLiveSceneEdits: true, stageDragging: true }).nudgeDisabled
    ).toBe(true)
    // The editor still has to be on (plan 215 B2).
    expect(
      placementControls({ ...live, acceptsLiveSceneEdits: true, sceneEditMode: false })
        .nudgeDisabled
    ).toBe(true)
  })

  it("keeps the lock on the legacy FFmpeg graph, with the backend's own reason", () => {
    expect(scenePositionLockReason({ isSessionActive: true, acceptsLiveSceneEdits: false })).toBe(
      SCENE_POSITION_UNAVAILABLE_REASON
    )
    expect(placementControls({ ...live, acceptsLiveSceneEdits: false })).toEqual({
      nudgeDisabled: true,
      description: SCENE_POSITION_UNAVAILABLE_REASON,
      lockReason: SCENE_POSITION_UNAVAILABLE_REASON
    })
    // The same sentence the backend answers `scene-edit-refused` with.
    expect(SCENE_POSITION_UNAVAILABLE_REASON).toBe(
      "Moving and resizing isn't available on this recording. Stop and record again."
    )
  })

  it('keeps the plain lock until the session has said (a start pending, an older backend)', () => {
    expect(scenePositionLockReason({ isSessionActive: true, acceptsLiveSceneEdits: null })).toBe(
      SCENE_POSITION_LOCK_REASON
    )
  })

  it('never locks idle, whatever a stale flag says', () => {
    for (const acceptsLiveSceneEdits of [true, false, null]) {
      expect(scenePositionLockReason({ isSessionActive: false, acceptsLiveSceneEdits })).toBe(null)
    }
  })
})
