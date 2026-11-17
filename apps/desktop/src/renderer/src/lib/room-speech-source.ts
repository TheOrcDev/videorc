import type { BackendClient } from '@/backendClient'
import type { CloudSpeechSync } from '../../../shared/cloud-speech'
// oxlint-disable-next-line import/default -- Vite compiles the worklet module URL.
import workletUrl from './room-speech-worklet?worker&url'
export type HostSpeechTap = { setMuted(muted: boolean): Promise<void>; close(): Promise<void> }
let generation = 0
/** Attaches only to the exact local processed publication. Never stops its track. */
export function attachHostSpeech(
  client: BackendClient,
  track: MediaStreamTrack,
  showId: string,
  muted: boolean,
  current: () => boolean
): HostSpeechTap {
  const sourceId = crypto.randomUUID()
  generation = Math.max(generation + 1, Date.now() * 1000)
  const ownerGeneration = generation
  let closed = false,
    allowed = false,
    sequence = 0,
    sending = false
  let context: AudioContext | null = null
  let input: MediaStreamAudioSourceNode | null = null
  let node: AudioWorkletNode | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let opening: Promise<void> | null = null
  let serial: Promise<unknown> = Promise.resolve()
  const live = (): boolean => !closed && !muted && current() && track.readyState === 'live'
  const enable = (value: boolean): void => {
    allowed = value && live()
    node?.port.postMessage({ enabled: allowed }, [])
  }
  const open = async (): Promise<void> => {
    if (context || !live()) return
    context = new AudioContext({ sampleRate: 48000 })
    await context.audioWorklet.addModule(workletUrl)
    if (!live()) return
    input = context.createMediaStreamSource(new MediaStream([track]))
    node = new AudioWorkletNode(context, 'videorc-host-speech', { numberOfOutputs: 0 })
    input.connect(node)
    node.port.onmessage = async (
      event: MessageEvent<{ sampleRate: number; samples: number[] }>
    ) => {
      if (!allowed || !live() || sending) return
      sending = true
      try {
        await client.requestTyped('cloud.speech.audio', {
          sourceId,
          sequence: ++sequence,
          ...event.data
        })
        enable(allowed)
      } catch {
        enable(false)
      } finally {
        sending = false
      }
    }
    node.onprocessorerror = () => enable(false)
    await context.resume()
  }
  const sync = (): Promise<void> => {
    const params: CloudSpeechSync = {
      showId,
      sourceId,
      generation: ownerGeneration,
      published: !closed && current(),
      muted
    }
    const next = serial
      .then(async () => {
        const result = await client.requestTyped('cloud.speech.sync', params)
        if (result.uploadAllowed && live()) {
          opening ??= open()
          await opening
        }
        enable(result.uploadAllowed)
      })
      .catch(() => enable(false))
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
    async setMuted(value) {
      muted = value
      enable(false)
      await sync()
    },
    async close() {
      if (closed) return
      closed = true
      enable(false)
      clearTimeout(timer)
      await sync()
      await opening?.catch(() => {})
      node?.port.close()
      node?.disconnect()
      input?.disconnect()
      await context?.close()
    }
  }
}
