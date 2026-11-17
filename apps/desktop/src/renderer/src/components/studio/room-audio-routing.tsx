import { useSyncExternalStore, type ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Slider } from '@/components/ui/slider'
import { roomAudioRouting } from '@/lib/room-audio-routing'

export function RoomAudioRoutingControls(): ReactElement {
  const value = useSyncExternalStore(roomAudioRouting.subscribe, roomAudioRouting.getSnapshot)
  return (
    <FieldGroup>
      <Field>
        <FieldLabel>System audio</FieldLabel>
        <FieldDescription role="status">
          {value.reason ?? 'Off. Audio from other apps can be shared with the room when enabled.'}{' '}
          Native system audio is an unqualified development preview.
        </FieldDescription>
        <Button
          variant="outline"
          size="xs"
          disabled={!import.meta.env.DEV}
          onClick={() => roomAudioRouting.system({ enabled: !value.system.enabled })}
        >
          {value.system.enabled ? 'Stop sharing system audio' : 'Share system audio for this room'}
        </Button>
        <FieldLabel htmlFor="room-system-gain">System gain · {value.system.gainDb} dB</FieldLabel>
        <Slider
          id="room-system-gain"
          aria-label="System gain"
          min={-24}
          max={12}
          step={1}
          value={[value.system.gainDb]}
          onValueChange={([gainDb]) => roomAudioRouting.system({ gainDb })}
        />
        <Button
          variant="outline"
          size="xs"
          aria-pressed={value.system.muted}
          onClick={() => roomAudioRouting.system({ muted: !value.system.muted })}
        >
          {value.system.muted ? 'Unmute system audio' : 'Mute system audio'}
        </Button>
      </Field>
      <Field>
        <FieldLabel htmlFor="program-speech-gain">
          Program speech · {Math.round(value.program.speechGain * 100)}%
        </FieldLabel>
        <Slider
          id="program-speech-gain"
          aria-label="Program speech gain"
          min={0}
          max={1}
          step={0.01}
          value={[value.program.speechGain]}
          onValueChange={([speechGain]) => roomAudioRouting.program({ speechGain })}
        />
        <Button
          variant="outline"
          size="xs"
          aria-pressed={value.program.speechMuted}
          onClick={() => roomAudioRouting.program({ speechMuted: !value.program.speechMuted })}
        >
          {value.program.speechMuted ? 'Unmute program speech' : 'Mute program speech'}
        </Button>
      </Field>
      <Field>
        <FieldLabel htmlFor="program-aux-gain">
          Program music and sounds · {Math.round(value.program.auxiliaryGain * 100)}%
        </FieldLabel>
        <Slider
          id="program-aux-gain"
          aria-label="Program auxiliary gain"
          min={0}
          max={1}
          step={0.01}
          value={[value.program.auxiliaryGain]}
          onValueChange={([auxiliaryGain]) => roomAudioRouting.program({ auxiliaryGain })}
        />
        <Button
          variant="outline"
          size="xs"
          aria-pressed={value.program.auxiliaryMuted}
          onClick={() =>
            roomAudioRouting.program({ auxiliaryMuted: !value.program.auxiliaryMuted })
          }
        >
          {value.program.auxiliaryMuted
            ? 'Unmute program auxiliary audio'
            : 'Mute program auxiliary audio'}
        </Button>
        <FieldDescription>
          {value.takeover
            ? 'Takeover silences program speech; deliberately enabled music and sounds continue. '
            : ''}
          Conversation audio is independent. Older program pages use all-program takeover silence.
          Program gain changes require a current routing-capable page.
        </FieldDescription>
      </Field>
    </FieldGroup>
  )
}
