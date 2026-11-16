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
export function createRoomAuxSink(initial: SoundboardSnapshot) {
  const since = Date.now()
  const context = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' })
  const destination = context.createMediaStreamDestination()
  destination.channelCount = 2
  destination.channelCountMode = 'explicit'
  const skipped = new Set(initial.voices.filter((v) => !v.loop).map((v) => v.voiceId))
  let problem: string | null = null
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
      player.update({ ...snapshot, voices: auxiliaryVoices(snapshot, skipped, since) })
    },
    close() {
      player.dispose()
      destination.stream.getTracks().forEach((track) => track.stop())
      void context.close().catch(() => {})
    }
  }
}
