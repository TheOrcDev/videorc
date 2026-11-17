import { RoomSystemAudioBuffer } from './room-system-audio-buffer'
declare const sampleRate: number
declare const currentFrame: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void
class SystemAudioProcessor extends AudioWorkletProcessor {
  #buffer: RoomSystemAudioBuffer
  #pending = false
  #closed = false
  constructor(options: { processorOptions: { generation: number } }) {
    super()
    if (sampleRate !== 48000) throw new Error('System worklet requires 48 kHz.')
    this.#buffer = new RoomSystemAudioBuffer(options.processorOptions.generation)
    this.port.onmessage = ({ data }) => {
      if (data?.close) {
        this.#closed = true
        this.#buffer.close()
        this.port.close()
        return
      }
      if (!this.#pending || data?.generation !== this.#buffer.generation) return
      if (data.frame !== null) this.#buffer.push(data.frame)
      this.#pending = false
    }
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    this.#buffer.render(outputs[0] ?? [])
    if (this.#closed) return false
    if (!this.#pending && this.#buffer.queuedFrames <= 960) {
      this.#pending = true
      this.port.postMessage(
        {
          pull: true,
          generation: this.#buffer.generation,
          workletFrame: currentFrame,
          queuedFrames: this.#buffer.queuedFrames,
          counters: { ...this.#buffer.counters }
        },
        []
      )
    }
    return true
  }
}
registerProcessor('videorc-room-system-audio', SystemAudioProcessor)
