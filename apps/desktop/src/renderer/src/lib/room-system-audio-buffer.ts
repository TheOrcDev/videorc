import {
  ROOM_SYSTEM_AUDIO as ROOM_PCM,
  parseRoomSystemAudioFrame,
  type RoomSystemAudioFrame
} from '../../../shared/room-system-audio'

/** Fixed 40 ms ring, absolute capture-sample indices. No repeated old samples. */
export class RoomSystemAudioBuffer {
  readonly samples = new Float32Array(ROOM_PCM.queueFrames * 2)
  readonly counters = {
    underrunFrames: 0,
    overrunFrames: 0,
    gapFrames: 0,
    staleFrames: 0,
    discontinuities: 0,
    nativeDroppedFrames: 0
  }
  #read: number | null = null
  #end = 0
  #sequence = -1
  #closed = false
  constructor(readonly generation: number) {}
  get queuedFrames(): number {
    return this.#read === null ? 0 : this.#end - this.#read
  }
  get captureCursor(): number | null {
    return this.#read
  }
  push(value: unknown): boolean {
    if (this.#closed) return false
    let frame: RoomSystemAudioFrame
    try {
      frame = parseRoomSystemAudioFrame(value, this.generation)
    } catch {
      this.counters.staleFrames++
      return false
    }
    if (frame.sequence <= this.#sequence) {
      this.counters.staleFrames++
      return false
    }
    this.#sequence = frame.sequence
    this.counters.nativeDroppedFrames = frame.droppedFrames
    const start = frame.firstSample
    const end = start + frame.frames
    if (this.#read === null) {
      this.#read = start
      this.#end = start
    }
    if (end <= this.#read) {
      this.counters.staleFrames++
      return false
    }
    if (start > this.#end) {
      this.counters.gapFrames += start - this.#end
      this.counters.discontinuities++
    }
    const floor = Math.max(this.#read, end - ROOM_PCM.queueFrames)
    if (floor > this.#read) {
      this.counters.overrunFrames += floor - this.#read
      this.counters.discontinuities++
      this.#read = floor
    }
    // A huge timestamp jump still writes at most the fixed ring's capacity.
    for (let sample = Math.max(this.#end, floor); sample < end; sample++)
      for (let channel = 0; channel < 2; channel++)
        this.samples[(sample % ROOM_PCM.queueFrames) * 2 + channel] =
          sample < start ? 0 : frame.samples[(sample - start) * 2 + channel]
    this.#end = Math.max(this.#end, end)
    return true
  }
  render(outputs: Float32Array[]): void {
    for (const output of outputs) output.fill(0)
    const length = outputs[0]?.length ?? 0
    if (this.#closed) return
    for (let i = 0; i < length; i++) {
      if (this.#read !== null && this.#read < this.#end) {
        for (let channel = 0; channel < outputs.length; channel++)
          outputs[channel][i] = this.samples[(this.#read % ROOM_PCM.queueFrames) * 2 + channel] ?? 0
      } else this.counters.underrunFrames++
      if (this.#read !== null) this.#read++
    }
    if (this.#read !== null) this.#end = Math.max(this.#end, this.#read)
  }
  close(): void {
    this.#closed = true
    this.samples.fill(0)
    this.#read = null
    this.#end = 0
  }
}
