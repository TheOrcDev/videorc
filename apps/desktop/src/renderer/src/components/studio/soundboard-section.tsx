import { useEffect, useEffectEvent, type ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { SoundPadBoard } from '@/components/sound-pad-board'
import { StopAllSoundsButton } from '@/components/stop-all-sounds-button'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyTitle } from '@/components/ui/empty'
import { useWorkspaceNav } from '@/components/workspace-nav'
import { useSoundboard } from '@/hooks/use-soundboard'
import { useStudioRecordingState, useStudioShell } from '@/hooks/use-studio'
import type { Sound } from '@/lib/backend'
import { soundForKey, soundKeyBlocked, soundKeyDigit } from '@/lib/sound-keys'
import { soundboardDescription } from '@/lib/sounds'
import { connectionBlockedReason } from '@/lib/state-labels'
import { sessionOwnsTransport } from '../../../../shared/capture-state'

/**
 * Studio → Soundboard (plan 189 S6): the pads, under Scenes. Studio plays,
 * Assets → Sounds manages and Sources → Sounds holds the level (D1). A pad
 * plays on its own mode; its key, 1 to 9, presses it while Studio is the page
 * in front. Nothing toasts when a sound plays: the pad's ring and progress
 * are the confirmation.
 */
export function SoundboardSection(): ReactElement {
  const { wsStatus } = useStudioShell()
  const { recording } = useStudioRecordingState()
  const { setActive } = useWorkspaceNav()
  const board = useSoundboard()
  const disconnectedReason = connectionBlockedReason(wsStatus)
  // A buffer-only Clips session (plan 181) is not a recording: its ring keeps
  // the sounds for a clip, but only the streamer hears them now.
  const sessionActive = sessionOwnsTransport(recording)
  useSoundKeys(board.sounds, board.press, board.stop, disconnectedReason === null)

  return (
    <PanelSection
      action={
        <StopAllSoundsButton
          disabledReason={disconnectedReason}
          playing={board.voices.length > 0}
          onStopAll={() => void board.stopAll()}
        />
      }
      data-videorc-soundboard=""
      description={soundboardDescription(sessionActive, board.monitor)}
      title="Soundboard"
    >
      {board.sounds.length > 0 ? (
        <>
          <SoundPadBoard
            columns={6}
            disabledReason={disconnectedReason}
            sounds={board.sounds}
            voices={board.voiceBySound}
            onPlay={(id) => void board.play(id)}
            onStop={(id) => void board.stop(id)}
          />
          {disconnectedReason ? (
            <p className="text-xs text-muted-foreground">
              {`${disconnectedReason} Sounds play once Videorc is connected.`}
            </p>
          ) : null}
        </>
      ) : !board.loaded ? (
        // Never "No sounds yet" before the board is known (J2-8).
        <Empty className="py-6" data-videorc-sounds-loading="">
          <EmptyTitle>{disconnectedReason ?? 'Loading sounds…'}</EmptyTitle>
        </Empty>
      ) : (
        <Empty className="py-6" data-videorc-sounds-empty="">
          <EmptyTitle>No sounds yet.</EmptyTitle>
          <EmptyContent>
            <Button variant="outline" onClick={() => setActive('assets')}>
              Add in Assets
            </Button>
          </EmptyContent>
        </Empty>
      )}
    </PanelSection>
  )
}

/**
 * 1 to 9 press the sound with that key while this page is up (plan 189):
 * one listener for the page, so the pad grid's own hotkeys stay off. A While
 * held sound stops when its key comes up, or when the window loses the
 * keys (blur) or the page goes away.
 */
function useSoundKeys(
  sounds: readonly Sound[],
  press: (id: string) => Promise<boolean>,
  stop: (id: string) => Promise<boolean>,
  enabled: boolean
): void {
  const onKeyDown = useEffectEvent((event: KeyboardEvent, held: Map<string, Sound>): void => {
    if (!enabled || soundKeyBlocked(event, document)) return
    const digit = soundKeyDigit(event)
    const sound = digit ? soundForKey(digit, sounds) : undefined
    if (!sound) return
    event.preventDefault()
    held.set(heldKey(event), sound)
    void press(sound.id)
  })
  const release = useEffectEvent((sound: Sound): void => {
    if (sound.mode === 'hold') void stop(sound.id)
  })
  useEffect(() => {
    const held = new Map<string, Sound>()
    const down = (event: KeyboardEvent): void => onKeyDown(event, held)
    const up = (event: KeyboardEvent): void => {
      const sound = held.get(heldKey(event))
      if (!sound) return
      held.delete(heldKey(event))
      release(sound)
    }
    const releaseAll = (): void => {
      for (const sound of held.values()) release(sound)
      held.clear()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', releaseAll)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', releaseAll)
      releaseAll()
    }
  }, [])
}

/** A held key's identity: the physical key, so its release matches on any layout. */
function heldKey(event: KeyboardEvent): string {
  return event.code || event.key
}
