import { observeRoomSystemAudio } from './room-system-audio-state'
import { createRoomSystemAudioSource, type RoomSystemAudioSource } from './room-system-audio-source'
import { roomAudioRouting } from './room-audio-routing'
import { createSoundMonitor, type SoundMonitorDeps } from './sound-monitor'
import type { SoundboardSnapshot } from './soundboard-store'

/** A room epoch starts with no one-shots owed. Loops may join at their current phase. */
export function auxiliaryVoices(
  snapshot: SoundboardSnapshot,
  skipped: ReadonlySet<string>,
  since = -Infinity
) {
  return snapshot.voices.filter(
    (voice) => voice.loop || (!skipped.has(voice.voiceId) && voice.startedAtMs >= since)
  )
}
export function createRoomAuxSink(initial: SoundboardSnapshot, showId: string) {
  const since = Date.now()
  const context = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' })
  const destination = context.createMediaStreamDestination()
  destination.channelCount = 2
  destination.channelCountMode = 'explicit'
  const skipped = new Set(initial.voices.filter((v) => !v.loop).map((v) => v.voiceId))
  let problem: string | null = null
  let closed = false,
    generation = 0
  let source: RoomSystemAudioSource | null = null
  let input: MediaStreamAudioSourceNode | null = null
  const systemGain = context.createGain()
  systemGain.connect(destination)
  let abort: AbortController | null = null
  let opening: Promise<void> | null = null
  let retiring: Promise<void> = Promise.resolve()
  const stopSystem = (): void => {
    ++generation
    abort?.abort()
    abort = null
    input?.disconnect()
    input = null
    const old = source
    source = null
    const pending = opening
    retiring = retiring.then(async () => {
      await pending
      await old?.close()
    })
    void retiring.catch(() => {
      if (!closed)
        roomAudioRouting.status(
          'blocked',
          'System capture cleanup is unconfirmed. Reopen the app before retrying.'
        )
    })
  }
  const syncSystem = (): void => {
    const settings = roomAudioRouting.getSnapshot().system
    systemGain.gain.value = settings.muted ? 0 : 10 ** (settings.gainDb / 20)
    if (!settings.enabled || closed) {
      if (abort || source) stopSystem()
      return
    }
    if (abort || source || opening) return
    const epoch = ++generation
    const owner = new AbortController()
    abort = owner
    roomAudioRouting.status('opening', 'Opening own-app-excluded system audio.')
    const prior = retiring
    opening = (async () => {
      try {
        await prior
        if (closed || epoch !== generation) return
        if (!import.meta.env.DEV)
          throw new Error('Native system audio is disabled pending qualification.')
        const made = await createRoomSystemAudioSource(
          window.videorc.roomSystemAudioPcm,
          showId,
          owner.signal,
          observeRoomSystemAudio,
          (reason) => {
            roomAudioRouting.system({ enabled: false })
            roomAudioRouting.status('blocked', reason)
          }
        )
        if (closed || epoch !== generation) {
          await made.close()
          return
        }
        source = made
        input = context.createMediaStreamSource(new MediaStream([made.track]))
        input.connect(systemGain)
        roomAudioRouting.status(
          'capturing',
          'System source attached. Final audibility and clock sync are unqualified.'
        )
      } catch (error) {
        if (epoch === generation && !closed) {
          abort = null
          roomAudioRouting.system({ enabled: false })
          roomAudioRouting.status(
            'blocked',
            error instanceof Error ? error.message : 'System audio unavailable.'
          )
        }
      }
    })().finally(() => {
      opening = null
      if (!closed) syncSystem()
    })
  }
  const offSystem = roomAudioRouting.subscribe(syncSystem)
  syncSystem()
  const deps: SoundMonitorDeps = {
    createContext: () => context,
    destination: () => destination,
    hears: () => true,
    closeContext: false,
    suspendIdle: false,
    fetchBytes: async (url) => {
      const response = await fetch(url)
      if (!response.ok) throw new Error('Sound asset unavailable')
      return response.arrayBuffer()
    },
    now: Date.now,
    setTimer: (run, delay) => setTimeout(run, delay),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    onUnplayable: (sound) => {
      problem = `Room audio could not decode ${sound.name}. Press again to retry.`
    }
  }
  const player = createSoundMonitor(deps)
  return {
    track: destination.stream.getAudioTracks()[0]!,
    queued: () => player.queued?.() ?? [],
    problem: () =>
      context.state !== 'running' ? 'Room audio is waiting for browser audio playback.' : problem,
    update(snapshot: SoundboardSnapshot) {
      if (!snapshot.roomAux?.enabled)
        for (const voice of snapshot.voices) if (!voice.loop) skipped.add(voice.voiceId)
      player.update({
        ...snapshot,
        voices: snapshot.roomAux?.enabled ? auxiliaryVoices(snapshot, skipped, since) : []
      })
    },
    close() {
      if (closed) return retiring
      closed = true
      offSystem()
      stopSystem()
      systemGain.disconnect()
      player.dispose()
      destination.stream.getTracks().forEach((track) => track.stop())
      return Promise.all([retiring, context.close()]).then(() => {})
    }
  }
}
