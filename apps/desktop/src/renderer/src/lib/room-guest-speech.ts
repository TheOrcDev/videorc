import type { BackendClient } from '@/backendClient'
import type { CloudSpeechGuestSync } from '../../../shared/cloud-speech'
// oxlint-disable-next-line import/default -- Vite compiles the worklet module URL.
import workletUrl from './room-speech-worklet?worker&url'

/**
 * Guest captions: one mono mix of the guests on stage, sent to the backend's
 * captions-only guest stream (`cloud.speech.guests.*`). It never uses the
 * host's speech RPCs, so guest audio never reaches Sidekick's listening,
 * voice commands or voice markers. Nothing plays: the mix only feeds the
 * worklet, while each guest keeps playing through its own audio element.
 */
export type GuestSpeechTap = {
  /** The on-stage guests' subscribed, unmuted microphone tracks. */
  setSources(tracks: readonly MediaStreamTrack[]): void
  close(): Promise<void>
}

let generation = 0

export function attachGuestSpeech(
  client: BackendClient,
  showId: string,
  current: () => boolean,
  onCaptioning: (captioning: boolean) => void
): GuestSpeechTap {
  const sourceId = `guests-${crypto.randomUUID()}`
  generation = Math.max(generation + 1, Date.now() * 1000)
  const ownerGeneration = generation
  let closed = false,
    allowed = false,
    sending = false,
    captioning = false,
    sequence = 0
  let tracks: MediaStreamTrack[] = []
  let context: AudioContext | null = null
  let bus: GainNode | null = null
  let node: AudioWorkletNode | null = null
  const inputs = new Map<string, MediaStreamAudioSourceNode>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let opening: Promise<void> | null = null
  let serial: Promise<unknown> = Promise.resolve()
  const live = (): boolean => !closed && current()
  const liveTracks = (): MediaStreamTrack[] =>
    live() ? tracks.filter((track) => track.readyState === 'live') : []
  const enable = (value: boolean): void => {
    allowed = value && liveTracks().length > 0
    node?.port.postMessage({ enabled: allowed }, [])
  }
  const report = (value: boolean): void => {
    if (value === captioning) return
    captioning = value
    onCaptioning(value)
  }
  /** One source node per guest track, all summed on one bus. */
  const connectInputs = (): void => {
    if (!context || !bus) return
    const wanted = new Map(liveTracks().map((track) => [track.id, track]))
    for (const [id, input] of inputs) {
      if (wanted.has(id)) continue
      input.disconnect()
      inputs.delete(id)
    }
    for (const [id, track] of wanted) {
      if (inputs.has(id)) continue
      const input = context.createMediaStreamSource(new MediaStream([track]))
      input.connect(bus)
      inputs.set(id, input)
    }
  }
  const open = async (): Promise<void> => {
    if (context || !live()) return
    context = new AudioContext({ sampleRate: 48000 })
    await context.audioWorklet.addModule(workletUrl)
    if (!live()) return
    bus = context.createGain()
    // The worklet is a read-only mono downmix shared with the host tap.
    node = new AudioWorkletNode(context, 'videorc-host-speech', { numberOfOutputs: 0 })
    bus.connect(node)
    node.port.onmessage = async (
      event: MessageEvent<{ sampleRate: number; samples: number[] }>
    ) => {
      if (!allowed || !live() || sending) return
      sending = true
      try {
        const result = await client.requestTyped('cloud.speech.guests.audio', {
          sourceId,
          sequence: ++sequence,
          ...event.data
        })
        report(result.captioning)
        enable(result.uploadAllowed)
      } catch {
        enable(false)
      } finally {
        sending = false
      }
    }
    node.onprocessorerror = () => enable(false)
    connectInputs()
    await context.resume()
  }
  const sync = (): Promise<void> => {
    const params: CloudSpeechGuestSync = {
      showId,
      sourceId,
      generation: ownerGeneration,
      guests: Math.min(liveTracks().length, 16)
    }
    const next = serial
      .then(async () => {
        const result = await client.requestTyped('cloud.speech.guests.sync', params)
        report(result.captioning)
        // No guest audio: no audio graph, no stream, nothing to pay for.
        if (result.uploadAllowed && params.guests > 0 && live()) {
          opening ??= open()
          await opening
          connectInputs()
        }
        enable(result.uploadAllowed)
      })
      .catch(() => {
        report(false)
        enable(false)
      })
    serial = next
    return next
  }
  const poll = async (): Promise<void> => {
    await sync()
    if (!closed)
      timer = setTimeout(() => {
        void poll()
      }, 250)
  }
  void poll()
  return {
    setSources(next) {
      tracks = [...next]
      connectInputs()
      if (!liveTracks().length) enable(false)
    },
    async close() {
      if (closed) return
      closed = true
      enable(false)
      clearTimeout(timer)
      // Zero guests stops the backend stream at once.
      await sync()
      report(false)
      await opening?.catch(() => {})
      for (const input of inputs.values()) input.disconnect()
      inputs.clear()
      node?.port.close()
      node?.disconnect()
      bus?.disconnect()
      await context?.close()
    }
  }
}
