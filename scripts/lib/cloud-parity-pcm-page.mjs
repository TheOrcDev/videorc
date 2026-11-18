/** Browser bodies serialized by the acquisition driver, not imported by product. */
export function installPcmRendererCollector() {
  // Hundreds of diagnostics a second; the drivers drain between steps, but a
  // setup step (a browser context, a program page) can take a minute on a
  // loaded host. Overflow is still a failure; it must not be a load artefact.
  const events = [],
    limit = 32768
  let dropped = 0
  const listener = ({ detail }) => {
    if (events.length >= limit) {
      events.shift()
      dropped++
    }
    events.push(detail)
  }
  window.addEventListener('videorc:pcm-test-diagnostic', listener)
  window.__parityPcmRenderer = {
    drain: () => ({ events: events.splice(0), dropped, performanceMs: performance.now() }),
    close: () => window.removeEventListener('videorc:pcm-test-diagnostic', listener)
  }
}

export async function startPcmProgramRecorder() {
  const taps = window.__parityProgramTaps ?? []
  if (taps.length !== 1) throw new Error('One final program bus is required')
  const { node, tap } = taps[0],
    context = node.context
  if (context.sampleRate !== 48000)
    throw new Error('Program bus sample rate unavailable or not 48 kHz')
  await context.audioWorklet.addModule('/__parity/cloud-parity-pcm-observer.mjs')
  const observer = new AudioWorkletNode(context, 'videorc-parity-pcm-observer', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1]
  })
  const muted = context.createGain()
  muted.gain.value = 0
  // The output is zero and disconnected on close; it cannot recapture speakers.
  node.connect(observer).connect(muted).connect(tap)
  const chunks = [],
    events = []
  let bufferedBytes = 0,
    dropped = 0,
    failed = null,
    pending = Promise.resolve(),
    clockPending = false,
    closed = false
  const recorder = new MediaRecorder(tap.stream, {
    mimeType: 'audio/webm;codecs=opus',
    audioBitsPerSecond: 128000
  })
  observer.port.onmessage = ({ data }) => {
    clockPending = false
    if (events.length >= 128) {
      events.shift()
      dropped++
    }
    events.push({ ...data, receivedAtMs: performance.now() })
  }
  const fail = (reason) => {
    failed = reason
    if (recorder.state !== 'inactive') recorder.stop()
  }
  observer.onprocessorerror = () => fail('Program worklet observation failed')
  recorder.ondataavailable = (event) => {
    if (!event.data.size) return
    if (event.data.size > 2 * 1024 * 1024 || bufferedBytes + event.data.size > 8 * 1024 * 1024) {
      fail('Program artifact queue overflow')
      return
    }
    const emittedAtMs = performance.now(),
      timecodeMs = event.timecode
    bufferedBytes += event.data.size
    pending = pending
      .then(async () => {
        const bytes = new Uint8Array(await event.data.arrayBuffer())
        let binary = ''
        for (const byte of bytes) binary += String.fromCharCode(byte)
        chunks.push({ base64: btoa(binary), bytes: bytes.length, emittedAtMs, timecodeMs })
      })
      .catch(() => {
        failed = 'Program artifact chunk conversion failed'
      })
  }
  recorder.onerror = () => fail('Program MediaRecorder failed')
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve
  })
  const drain = async () => {
    await pending
    if (!closed && !clockPending) {
      clockPending = true
      observer.port.postMessage({ drain: true, requestedAtMs: performance.now() }, [])
    }
    const data = chunks.splice(0)
    for (const chunk of data) bufferedBytes -= chunk.bytes
    return {
      chunks: data,
      events: events.splice(0),
      dropped,
      failed,
      performanceMs: performance.now(),
      recorderState: recorder.state
    }
  }
  recorder.start(250)
  window.__parityPcmProgram = {
    drain,
    async close() {
      if (!closed) {
        closed = true
        if (recorder.state !== 'inactive') recorder.stop()
        let timer
        try {
          await Promise.race([
            stopped,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('Program recorder close timeout')), 5000)
            })
          ])
        } finally {
          clearTimeout(timer)
          observer.port.postMessage({ close: true }, [])
          observer.port.close()
          node.disconnect(observer)
          observer.disconnect()
          muted.disconnect()
        }
      }
      return drain()
    }
  }
  return { state: recorder.state, performanceMs: performance.now(), sampleRate: context.sampleRate }
}
