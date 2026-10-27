import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

import { MicrophoneGainFader } from '@/components/audio/gain-faders'
import { DevicePicker } from '@/components/device-picker'
import {
  FirstRunNextButton,
  FirstRunStepLayout,
  useFirstRunStepFrame
} from '@/components/first-run/setup-step-frame'
import { DesktopIcon, MicrophoneIcon } from '@/components/icons'
import { GroupedList } from '@/components/list-row'
import { MicLevelMeter } from '@/components/studio/mic-level-meter'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { Switch } from '@/components/ui/switch'
import { useStudioCore } from '@/hooks/use-studio'
import { useMicrophoneMeter } from '@/hooks/use-studio-mic-sources'
import type { AudioSettings } from '@/lib/backend'
import { buildMicrophoneSources, microphonePickerDevices } from '@/lib/capture'
import {
  SOUND_CHECK_COPY,
  addSoundCheckSample,
  framePeakDb,
  soundCheckGainDb,
  soundCheckReading,
  type SoundCheckReading,
  type SoundCheckSample
} from '@/lib/first-run-sound'
import type { MeterInput } from '@/lib/mic-meter-input'
import { platformCopy } from '@/lib/platform-copy'
import { systemAudioRowDevice, systemAudioSwitchView } from '@/lib/system-audio'

/** How often the verdict line reads the window: often enough to feel live, never per frame. */
const VERDICT_TICK_MS = 250
const NO_READING: SoundCheckReading = { verdict: 'none', speechPeakDb: null }

/**
 * The last 8 s of the meter, read into a verdict (plan 207 D9). It listens to
 * the same source the bar draws, so the verdict is about the level the
 * recording gets. A Gain change shifts what was heard by the same amount, so
 * the verdict follows the fader at once; a new microphone starts over.
 */
function useSoundCheck(
  meter: MeterInput,
  gainDb: number,
  microphoneId: string | undefined
): { reading: SoundCheckReading; restart: () => void } {
  const samples = useRef<SoundCheckSample[]>([])
  const heardAtGain = useRef(gainDb)
  const [reading, setReading] = useState<SoundCheckReading>(NO_READING)
  const source = meter.kind === 'source' ? meter.source : null

  const restart = useCallback(() => {
    samples.current = []
    setReading(NO_READING)
  }, [])

  useEffect(() => {
    if (!source) return
    return source.subscribe((frame) => {
      samples.current = addSoundCheckSample(samples.current, {
        at: performance.now(),
        peakDb: framePeakDb(frame)
      })
    })
  }, [source])

  useEffect(() => {
    const shift = gainDb - heardAtGain.current
    heardAtGain.current = gainDb
    if (shift === 0) return
    samples.current = samples.current.map((sample) => ({
      ...sample,
      peakDb: sample.peakDb + shift
    }))
  }, [gainDb])

  useEffect(() => restart(), [microphoneId, restart])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = soundCheckReading(samples.current, performance.now())
      setReading((current) =>
        current.verdict === next.verdict && current.speechPeakDb === next.speechPeakDb
          ? current
          : next
      )
    }, VERDICT_TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

  return { reading, restart }
}

/**
 * Step 4, "Sound check" (plan 207 S6, D9): the microphone, its level and Gain
 * with a verdict in words and "Set level for me", then the System audio
 * switch. Every control writes the same captureConfig the Studio's Audio
 * section writes, so the Studio opens with exactly this. No monitor and no
 * test recording: there is nothing behind them (design rule).
 */
export function SoundStep(): ReactElement {
  const {
    captureConfig,
    setCaptureConfig,
    deviceList,
    selectedMicrophone,
    switchSourceDeviceLive,
    sourceSwitchReason,
    runtimeInfo,
    wsStatus,
    mediaAccess,
    isSessionActive,
    audioBusActive,
    systemAudioConfirmed,
    systemAudioJoining,
    systemAudioIssue
  } = useStudioCore()
  const frame = useFirstRunStepFrame()
  const { meter } = useMicrophoneMeter()
  const platform = runtimeInfo?.platform
  const { deviceNoun } = platformCopy(platform)
  const audio = captureConfig.audio
  const microphones = microphonePickerDevices(deviceList.devices)
  const microphoneId = captureConfig.sources.microphoneId
  const { reading, restart } = useSoundCheck(meter, audio.microphoneGainDb, microphoneId)
  const setAudio = (update: (current: AudioSettings) => AudioSettings): void =>
    setCaptureConfig((current) => ({ ...current, audio: update(current.audio) }))
  const setGain = (microphoneGainDb: number): void =>
    setAudio((current) => ({ ...current, microphoneGainDb }))
  // Only a refusal or a never-asked grant blocks the level; an unknown
  // snapshot (Videorc still asking the OS) keeps the meter.
  const microphoneBlocked = ['denied', 'restricted', 'not-determined'].includes(
    mediaAccess?.microphone ?? 'unknown'
  )
  const systemAudio = systemAudioSwitchView({
    device: systemAudioRowDevice(deviceList, platform),
    requested: audio.systemAudioEnabled,
    sessionActive: isSessionActive,
    audioBusActive,
    confirmed: systemAudioConfirmed,
    joining: systemAudioJoining,
    issue: systemAudioIssue
  })
  const systemAudioReason = systemAudio.permissionRequired
    ? 'Comes with Screen Recording. Go back to permissions to allow it.'
    : undefined
  const systemAudioSwitch = (
    <Switch
      aria-label="System audio"
      checked={systemAudio.checked}
      disabled={systemAudio.disabled || frame.leaving}
      onCheckedChange={(systemAudioEnabled) =>
        setAudio((current) => ({ ...current, systemAudioEnabled }))
      }
    />
  )
  const levelReady = reading.speechPeakDb !== null

  return (
    <FirstRunStepLayout
      description="Pick your microphone and talk the way you will when you record."
      primary={<FirstRunNextButton />}
    >
      <GroupedList aria-label="Sound check">
        <div className="flex flex-col gap-2.5 px-3 py-2.5" data-first-run-sound-row="microphone">
          <div className="flex items-center gap-3">
            <MicrophoneIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">Microphone</span>
          </div>
          <DevicePicker
            devices={microphones}
            disabled={Boolean(sourceSwitchReason('microphone')) || frame.leaving}
            discoveryPending={wsStatus !== 'connected'}
            kind="microphone"
            label="Microphone"
            labelHidden
            noneLabel="Off"
            selectedDevice={selectedMicrophone}
            selectedName={captureConfig.sources.microphoneName}
            value={microphoneId}
            onChange={(id) =>
              void switchSourceDeviceLive(
                'microphone',
                buildMicrophoneSources(captureConfig.sources, microphones, id)
              )
            }
          />
          {microphoneBlocked ? (
            <Alert data-first-run-sound-blocked="" variant="warning">
              <AlertTitle>Videorc can't hear your microphone yet.</AlertTitle>
              <AlertDescription className="pt-1">
                <Button
                  className="-ml-2"
                  size="xs"
                  variant="ghost"
                  onClick={() => frame.goTo('permissions')}
                >
                  Back to permissions
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <MicLevelMeter aria-label="Microphone level" className="min-w-0" meter={meter} />
              <MicrophoneGainFader gainDb={audio.microphoneGainDb} onGainChange={setGain} />
              <div className="flex items-center gap-3">
                <p
                  aria-live="polite"
                  className="min-w-0 flex-1 text-meta text-muted-foreground"
                  data-first-run-sound-gain={audio.microphoneGainDb}
                  data-first-run-sound-verdict={reading.verdict}
                >
                  {SOUND_CHECK_COPY[reading.verdict]}
                </p>
                <DisabledReason reason={levelReady ? undefined : 'Talk for a few seconds first.'}>
                  <Button
                    data-first-run-sound-level=""
                    disabled={!levelReady || frame.leaving}
                    variant="outline"
                    onClick={() => {
                      if (reading.speechPeakDb === null) return
                      setGain(soundCheckGainDb(audio.microphoneGainDb, reading.speechPeakDb))
                      restart()
                    }}
                  >
                    Set level for me
                  </Button>
                </DisabledReason>
              </div>
            </>
          )}
        </div>

        {systemAudio.visible ? (
          <div
            className="flex items-start gap-3 px-3 py-2.5"
            data-first-run-sound-row="system-audio"
          >
            <DesktopIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">System audio</span>
              <p className="text-meta text-muted-foreground">
                {`The sound your ${deviceNoun} plays: games, music and calls. Its level shows once you record or go live.`}
              </p>
            </div>
            {systemAudioReason ? (
              <DisabledReason reason={systemAudioReason}>{systemAudioSwitch}</DisabledReason>
            ) : (
              systemAudioSwitch
            )}
          </div>
        ) : null}
      </GroupedList>
    </FirstRunStepLayout>
  )
}
