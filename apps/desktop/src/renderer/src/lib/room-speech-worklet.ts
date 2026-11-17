// A read-only branch of the already processed host microphone. No output audio.
declare const sampleRate: number
declare class AudioWorkletProcessor {
  port: MessagePort
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void
class RoomSpeechProcessor extends AudioWorkletProcessor {
  private enabled = false
  private pending: number[] = []
  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<{ enabled: boolean }>) => {
      this.enabled = event.data.enabled === true
      this.pending = []
    }
  }
  process(inputs: Float32Array[][]): boolean {
    if (!this.enabled) return true
    const channels = inputs[0]
    if (!channels?.length) return true
    for (let i = 0; i < channels[0].length; i++) {
      let sum = 0
      for (const channel of channels) sum += channel[i] ?? 0
      this.pending.push(Math.max(-1, Math.min(1, sum / channels.length)))
      if (this.pending.length >= Math.floor(sampleRate / 10)) {
        this.port.postMessage({ sampleRate, samples: this.pending }, [])
        // One frame in flight; the consumer must acknowledge before another.
        this.pending = []
        this.enabled = false
        return true
      }
    }
    return true
  }
}
registerProcessor('videorc-host-speech', RoomSpeechProcessor)
export {}
