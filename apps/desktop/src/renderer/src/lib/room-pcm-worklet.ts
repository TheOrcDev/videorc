import { RoomPcmBuffer } from './room-pcm-buffer'
declare const sampleRate: number
declare const currentFrame: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void

class RoomPcmProcessor extends AudioWorkletProcessor {
  #buffer: RoomPcmBuffer
  #pending = false
  #closed = false
  #clock: { requestedAtMs: number; frame: number } | null = null
  #marker: { second: number; captureSample: number; workletFrame: number } | null = null
  #lostMarkers = 0
  constructor(options: { processorOptions: { generation: number } }) {
    super()
    if (sampleRate !== 48000) throw new Error('PCM worklet requires 48 kHz.')
    this.#buffer = new RoomPcmBuffer(options.processorOptions.generation)
    this.port.onmessage = ({ data }) => {
      if (data?.close) {
        this.#closed = true
        this.#buffer.close()
        this.port.close()
        return
      }
      if (data?.generation !== this.#buffer.generation || !this.#pending) return
      if (typeof data.clockRequestedAtMs === 'number')
        this.#clock = { requestedAtMs: data.clockRequestedAtMs, frame: currentFrame }
      if (data.frame !== null) this.#buffer.push(data.frame)
      this.#pending = false
    }
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]?.[0]
    const cursor = this.#buffer.captureCursor
    if (output) {
      this.#buffer.render(output)
      if (cursor !== null) {
        const at = Math.ceil(cursor / 48000) * 48000
        const offset = at - cursor
        if (offset < output.length && output[offset] > 0.25) {
          if (this.#marker) this.#lostMarkers++
          this.#marker = {
            second: at / 48000,
            captureSample: at,
            workletFrame: currentFrame + offset
          }
        }
      }
    }
    if (this.#closed) return false
    if (!this.#pending && this.#buffer.queuedFrames <= 960) {
      this.#pending = true
      // One credit remains outstanding until renderer returns. A stalled renderer
      // cannot accumulate MessagePort messages, even while audio keeps rendering.
      // MessagePort transfer list is empty: these diagnostics contain no buffers.
      this.port.postMessage(
        {
          pull: true,
          generation: this.#buffer.generation,
          workletFrame: currentFrame + (output?.length ?? 0),
          captureCursor: this.#buffer.captureCursor,
          queuedFrames: this.#buffer.queuedFrames,
          counters: { ...this.#buffer.counters },
          clock: this.#clock,
          marker: this.#marker,
          lostMarkers: this.#lostMarkers
        },
        []
      )
      this.#clock = null
      this.#marker = null
    }
    return true
  }
}
registerProcessor('videorc-room-pcm-test', RoomPcmProcessor)
