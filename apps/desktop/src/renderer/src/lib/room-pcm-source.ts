import { registerRoomPcmResources } from './room-pcm-test-state'
// oxlint-disable-next-line import/default -- Vite's ?worker&url module exports the compiled worklet URL.
import workletUrl from './room-pcm-worklet?worker&url'
import {
  roomPcmCommand,
  parseRoomPcmFrame,
  pcmNativeCaptureUs,
  type RoomPcmCommand,
  type RoomPcmFrame
} from '../../../shared/room-pcm'

export type RoomPcmApi = (command: RoomPcmCommand) => Promise<RoomPcmFrame | null>
export type RoomPcmSource = { track: MediaStreamTrack; close: () => Promise<void> }
/** What `originUs + firstSampleUs` names: the S7a synthetic fixture timeline, or
 * the S7b PROCESSED microphone timeline (resampled, offset, RNNoise lookahead). */
export type RoomPcmTimeline = 'synthetic' | 'processed'
let lastGeneration = 0
/** Explicit test factory only. Normal joins continue using the browser mic/AEC. */
export async function createRoomPcmTestSource(
  api: RoomPcmApi,
  signal: AbortSignal,
  observe?: (value: unknown) => void,
  onFailure?: (reason: string) => void,
  timeline: RoomPcmTimeline = 'synthetic'
): Promise<RoomPcmSource> {
  if (signal.aborted) throw new Error('PCM source cancelled.')
  const generation = (lastGeneration = Math.max(Date.now(), lastGeneration + 1))
  let inFlight = 0
  let closeError: string | null = null
  let closeSettled = false
  const request: RoomPcmApi = async (command) => {
    inFlight++
    try {
      return await api(command)
    } finally {
      inFlight--
      releaseIfClosed()
    }
  }
  let closed = false
  let closing: Promise<void> | null = null
  let context: AudioContext | null = null
  let node: AudioWorkletNode | null = null
  let destination: MediaStreamAudioDestinationNode | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const readResources = (): Record<string, unknown> => ({
    worklets: node && context?.state !== 'closed' ? 1 : 0,
    contexts: context && context.state !== 'closed' ? 1 : 0,
    tracks:
      destination?.stream.getTracks().filter((track) => track.readyState !== 'ended').length ?? 0,
    timers: timer === undefined ? 0 : 1,
    ipcRequests: inFlight,
    closeError
  })
  const unregister = registerRoomPcmResources(generation, readResources)
  function releaseIfClosed(): void {
    if (!closed || !closeSettled || closeError) return
    const remaining = readResources()
    if (
      ['worklets', 'contexts', 'tracks', 'timers', 'ipcRequests'].every(
        (key) => remaining[key] === 0
      )
    )
      unregister()
  }

  const close = (): Promise<void> => {
    if (closed) return closing ?? Promise.resolve()
    closed = true
    signal.removeEventListener('abort', abort)
    clearTimeout(timer)
    timer = undefined
    destination?.stream.getTracks().forEach((track) => track.stop())
    node?.port.postMessage({ close: true }, [])
    node?.port.close()
    node?.disconnect()
    destination?.disconnect()
    closing = Promise.all([context?.close(), request(roomPcmCommand('close', generation))])
      .then(() => {
        closeSettled = true
        const remaining = readResources()
        observe?.({ phase: 'closed', generation, remaining })
        releaseIfClosed()
      })
      .catch(() => {
        closeError = 'PCM close acknowledgement unavailable.'
      })
    return closing
  }
  const abort = (): void => {
    void close()
  }
  signal.addEventListener('abort', abort, { once: true })
  const current = (): void => {
    if (closed || signal.aborted) throw new Error('PCM source cancelled.')
  }
  try {
    const openRequestedAtMs = performance.now()
    await request(roomPcmCommand('open', generation))
    const openAcknowledgedAtMs = performance.now()
    current()
    context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
    if (context.sampleRate !== 48000) throw new Error('PCM context requires 48 kHz.')
    await context.audioWorklet.addModule(workletUrl)
    current()
    destination = context.createMediaStreamDestination()
    node = new AudioWorkletNode(context, 'videorc-room-pcm-test', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { generation }
    })
    const port = node.port
    let pending = false
    port.onmessage = async ({ data }) => {
      if (closed || pending || !data?.pull || data.generation !== generation) return
      pending = true
      try {
        observe?.({
          ...data,
          phase: 'worklet',
          receivedAtMs: performance.now(),
          openRequestedAtMs,
          openAcknowledgedAtMs,
          productionQualified: false
        })
        const pullRequestedAtMs = performance.now()
        const frame = await request(roomPcmCommand('pull', generation))
        current()
        if (frame) {
          parseRoomPcmFrame(frame, generation)
          observe?.({
            phase: 'native-frame',
            generation,
            sequence: frame.sequence,
            firstSample: frame.firstSample,
            firstSampleUs: frame.firstSampleUs,
            observedAtUs: frame.observedAtUs,
            // Common native clock (S13a): pair with video only for equal incarnations.
            originUs: frame.originUs,
            incarnation: frame.incarnation,
            nativeCaptureUs: pcmNativeCaptureUs(frame),
            timeline,
            droppedFrames: frame.droppedFrames,
            pullRequestedAtMs,
            pullReceivedAtMs: performance.now(),
            productionQualified: false
          })
        }
        const reply = (): void => {
          timer = undefined
          if (closed) return
          port.postMessage({ generation, frame, clockRequestedAtMs: performance.now() })
          pending = false
        }
        if (frame) reply()
        else timer = setTimeout(reply, 5)
      } catch {
        if (!closed) onFailure?.('Native PCM test source stopped; publication is unqualified.')
        void close()
      }
    }
    node.onprocessorerror = () => {
      if (!closed) onFailure?.('PCM worklet failed; publication stopped.')
      void close()
    }
    node.connect(destination)
    await context.resume()
    current()
    const track = destination.stream.getAudioTracks()[0]
    if (!track) throw new Error('PCM destination has no microphone track.')
    return { track, close }
  } catch (error) {
    await close()
    throw error
  }
}
