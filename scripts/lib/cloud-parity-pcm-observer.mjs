/* global AudioWorkletProcessor, registerProcessor, currentFrame, sampleRate */
import { PcmMarkerDecoder } from './cloud-parity-pcm-marker.mjs'
/** Served only by the local parity fixture. Observes the real final limiter bus. */
class PcmObserver extends AudioWorkletProcessor {
  constructor() {
    super()
    if (sampleRate !== 48000) throw new Error('Program observer requires 48 kHz')
    this.decoder = new PcmMarkerDecoder()
    this.events = []
    this.dropped = 0
    this.closed = false
    this.port.onmessage = ({ data }) => {
      if (data.close) {
        this.closed = true
        this.port.close()
        return
      }
      if (data.drain && Number.isFinite(data.requestedAtMs)) {
        this.port.postMessage(
          {
            events: this.events.splice(0),
            dropped: this.dropped,
            rejected: this.decoder.rejected,
            clock: { requestedAtMs: data.requestedAtMs, frame: currentFrame }
          },
          []
        )
      }
    }
  }
  process(inputs, outputs) {
    for (const channel of outputs[0] ?? []) channel.fill(0)
    if (this.closed) return false
    if (inputs[0]?.[0])
      this.decoder.push(inputs[0][0], currentFrame, (event) => {
        if (this.events.length >= 64) {
          this.events.shift()
          this.dropped++
        }
        this.events.push(event)
      })
    return true
  }
}
registerProcessor('videorc-parity-pcm-observer', PcmObserver)
