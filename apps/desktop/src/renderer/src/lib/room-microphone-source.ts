import { roomPcmTestResources } from './room-pcm-test-state'
import { createLocalAudioTrack, type LocalAudioTrack } from 'livekit-client'
import { createRoomPcmTestSource, type RoomPcmSource } from './room-pcm-source'
import {
  parseRoomMicrophoneSettings,
  type RoomMicrophoneSettings,
  type RoomMicrophoneCommand
} from '../../../shared/room-microphone'
import {
  roomMicrophoneState,
  registerRoomMicrophoneResources,
  type RoomMicrophoneMode
} from './room-microphone-state'
import { closeVisualMicrophoneStreams } from './mic-visual-ownership'
export type RoomMicrophoneChoice = {
  mode: RoomMicrophoneMode
  deviceId: string | null
  name: string | null
  gainDb: number
  muted: boolean
  noise: 'off' | 'rnnoise'
  offsetMs: number
}
export type RoomMicrophoneSource = {
  track: MediaStreamTrack
  update: (choice: RoomMicrophoneChoice) => void
  disconnectFixture: (mode?: 'disconnect' | 'starve' | 'resume') => Promise<void>
  published: () => void
  close: () => Promise<void>
}
export function microphoneRequiresReplacement(
  a: RoomMicrophoneChoice,
  b: RoomMicrophoneChoice
): boolean {
  return (
    a.mode !== b.mode || a.deviceId !== b.deviceId || a.name !== b.name || a.offsetMs !== b.offsetMs
  )
}
export function microphoneProcessingDetail(choice: RoomMicrophoneChoice): string {
  if (choice.mode === 'native-headphones')
    return `Native headphones test mode. ${choice.offsetMs} ms intentional delay (0–1000 ms supported). Speaker AEC and clock sync are unqualified.`
  return choice.noise === 'rnnoise'
    ? 'Browser echo cancellation. Native RNNoise and sync offset are unavailable in this mode; RNNoise is not replaced by browser noise suppression.'
    : 'Browser echo cancellation. Native noise reduction and sync offset are unavailable in this mode.'
}

// getUserMedia cannot be cancelled while its permission/open request is pending.
// Teardown stops acquired tracks immediately; a replacement, including a new
// room client for the same show, waits until the late acquisition disposes its
// own result. Never let two browser/native opens race across client instances.
let pendingAcquisition: Promise<void> = Promise.resolve()
export function createRoomMicrophoneSource(
  ...args: Parameters<typeof openRoomMicrophoneSource>
): Promise<RoomMicrophoneSource> {
  const opening = pendingAcquisition.then(() => openRoomMicrophoneSource(...args))
  pendingAcquisition = opening.then(
    () => {},
    () => {}
  )
  return opening
}

/** One real capture, processed destination and published meter; no speaker tap. */
async function openRoomMicrophoneSource(
  initial: RoomMicrophoneChoice,
  showId: string,
  signal: AbortSignal,
  resolveBrowserDevice: (name: string) => Promise<string | undefined>,
  onFailure: (reason: string) => void,
  observe?: (value: unknown) => void
): Promise<RoomMicrophoneSource> {
  if (!initial.deviceId || !initial.name || signal.aborted)
    throw new Error('Select an available microphone.')
  if (roomPcmTestResources().owners.length > 0)
    throw new Error('Previous PCM owner cleanup is unconfirmed. No second capture was opened.')
  let choice = initial,
    closed = false,
    published = false,
    closing: Promise<void> | null = null
  let raw: LocalAudioTrack | null = null,
    native: RoomPcmSource | null = null
  let context: AudioContext | null = null,
    input: MediaStreamAudioSourceNode | null = null
  let gain: GainNode | null = null,
    limiter: DynamicsCompressorNode | null = null
  let analyser: AnalyserNode | null = null,
    output: MediaStreamAudioDestinationNode | null = null
  let timer: ReturnType<typeof setInterval> | undefined
  let opening = true,
    closeSettled = false,
    closeError: string | null = null
  let disconnectFixture = async (_mode?: 'disconnect' | 'starve' | 'resume'): Promise<void> => {
    throw new Error('No native fixture is active.')
  }
  const readResources = (): Record<string, unknown> => ({
    contexts: context && context.state !== 'closed' ? 1 : 0,
    tracks:
      (raw?.mediaStreamTrack.readyState === 'live' ? 1 : 0) +
      (output?.stream.getTracks().filter((t) => t.readyState !== 'ended').length ?? 0),
    timers: timer === undefined ? 0 : 1,
    ipcRequests: opening ? 1 : 0,
    worklets: 0,
    closeError
  })
  const unregister = registerRoomMicrophoneResources(readResources)
  const release = (): void => {
    if (
      closed &&
      closeSettled &&
      !closeError &&
      Object.entries(readResources()).every(([key, value]) => key === 'closeError' || value === 0)
    )
      unregister()
  }
  const state = roomMicrophoneState.acquire(choice.mode)
  const close = (): Promise<void> => {
    if (closing) return closing
    closed = true
    published = false
    clearInterval(timer)
    timer = undefined
    signal.removeEventListener('abort', abort)
    raw?.stop()
    output?.stream.getTracks().forEach((t) => t.stop())
    input?.disconnect()
    gain?.disconnect()
    limiter?.disconnect()
    analyser?.disconnect()
    output?.disconnect()
    state.close()
    closing = Promise.all([native?.close(), context?.close()])
      .then(async () => {
        if (native) {
          const resources = await window.videorc.getRoomNativeMicrophoneResources()
          if (
            resources.nativeSources !== 0 ||
            resources.sockets !== 0 ||
            resources.ipcRequests !== 0
          )
            throw new Error('Native microphone cleanup has not completed.')
        }
        closeSettled = true
        release()
      })
      .catch((error) => {
        closeError = 'Microphone cleanup acknowledgement unavailable.'
        throw error
      })
    return closing
  }
  const abort = (): void => {
    void close().catch(() => {})
  }
  const current = (): void => {
    if (closed || signal.aborted) throw new Error('Microphone acquisition cancelled.')
  }
  const fail = (reason: string): void => {
    if (closed) return
    void close().catch(() => {})
    state.update({ state: 'lost', reason })
    onFailure(reason)
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    closeVisualMicrophoneStreams()
    let track: MediaStreamTrack
    if (choice.mode === 'native-headphones') {
      if (!import.meta.env.DEV)
        throw new Error('Native microphone is disabled pending qualification.')
      const settings = (): RoomMicrophoneSettings =>
        parseRoomMicrophoneSettings({
          deviceId: choice.deviceId,
          gainDb: choice.gainDb,
          muted: choice.muted,
          noise: choice.noise,
          offsetMs: choice.offsetMs
        })
      let sent = '',
        serial: Promise<unknown> = Promise.resolve(),
        nativeGeneration = 0
      disconnectFixture = async (mode = 'disconnect') => {
        const call = serial
          .catch(() => {})
          .then(() =>
            window.videorc.roomMicrophonePcm({
              action:
                mode === 'starve'
                  ? 'starve-test'
                  : mode === 'resume'
                    ? 'resume-test'
                    : 'disconnect-test',
              generation: nativeGeneration,
              role: 'host-microphone',
              showId,
              sampleRate: 48000,
              channels: 1,
              frames: 480
            })
          )
        serial = call
        await call
      }
      native = await createRoomPcmTestSource(
        (command) => {
          const call = serial
            .catch(() => {})
            .then(async () => {
              nativeGeneration = command.generation
              const base: RoomMicrophoneCommand = { ...command, role: 'host-microphone', showId }
              const next = JSON.stringify(settings())
              if (command.action === 'pull' && sent !== next) {
                await window.videorc.roomMicrophonePcm({
                  ...base,
                  action: 'update',
                  settings: settings()
                })
                sent = next
              }
              if (command.action === 'open') {
                base.settings = settings()
                sent = next
              }
              return window.videorc.roomMicrophonePcm(base)
            })
          serial = call
          return call
        },
        signal,
        observe,
        fail
      )
      if (closed || signal.aborted) await native.close()
      current()
      track = native.track
    } else {
      const deviceId = await resolveBrowserDevice(choice.name!)
      current()
      if (!deviceId)
        throw new Error('The selected microphone is unavailable. No default device was opened.')
      raw = await createLocalAudioTrack({
        deviceId: { exact: deviceId },
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false
      })
      if (closed || signal.aborted) raw.stop()
      current()
      track = raw.mediaStreamTrack
    }
    track.addEventListener(
      'ended',
      () => fail('The selected microphone was lost. Re-select it to recover.'),
      { once: true }
    )
    context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
    input = context.createMediaStreamSource(new MediaStream([track]))
    gain = context.createGain()
    gain.gain.value = choice.muted
      ? 0
      : choice.mode === 'browser-aec'
        ? 10 ** (choice.gainDb / 20)
        : 1
    analyser = context.createAnalyser()
    analyser.fftSize = 2048
    output = context.createMediaStreamDestination()
    input.connect(gain)
    if (choice.mode === 'browser-aec') {
      limiter = context.createDynamicsCompressor()
      limiter.threshold.value = -1
      limiter.knee.value = 0
      limiter.ratio.value = 20
      limiter.attack.value = 0.001
      limiter.release.value = 0.05
      gain.connect(limiter).connect(analyser)
    } else gain.connect(analyser)
    analyser.connect(output)
    await context.resume()
    current()
    const samples = new Float32Array(analyser.fftSize)
    timer = setInterval(() => {
      if (!published || closed || context?.state !== 'running') {
        state.update({ peakDb: null, rmsDb: null, observedAt: null })
        return
      }
      analyser!.getFloatTimeDomainData(samples)
      let peak = 0,
        energy = 0
      for (const sample of samples) {
        peak = Math.max(peak, Math.abs(sample))
        energy += sample * sample
      }
      state.update({
        peakDb: 20 * Math.log10(peak),
        rmsDb: 10 * Math.log10(energy / samples.length),
        observedAt: performance.now()
      })
    }, 50)
    return {
      track: output.stream.getAudioTracks()[0],
      close,
      disconnectFixture,
      update(next) {
        if (microphoneRequiresReplacement(choice, next))
          throw new Error('Microphone replacement requires a new owner.')
        choice = next
        if (gain)
          gain.gain.value = choice.muted
            ? 0
            : choice.mode === 'browser-aec'
              ? 10 ** (choice.gainDb / 20)
              : 1
        state.update({
          reason: microphoneProcessingDetail(choice),
          peakDb: null,
          rmsDb: null,
          observedAt: null
        })
      },
      published() {
        published = true
        state.update({ state: 'published', reason: microphoneProcessingDetail(choice) })
      }
    }
  } catch (error) {
    await close()
    throw error
  } finally {
    opening = false
    release()
  }
}
