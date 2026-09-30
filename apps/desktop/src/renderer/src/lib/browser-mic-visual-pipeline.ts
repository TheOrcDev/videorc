import {
  createMicVisualPipeline,
  type MicVisualAnalyserLike,
  type MicVisualPipeline
} from './mic-visual-pipeline'

/** Browser adapter for the shared visual-only microphone analyser. */
export function createBrowserMicVisualPipeline(): MicVisualPipeline {
  // The pipeline talks to analyser wrappers; Web Audio's connect() accepts
  // only a real AudioNode. Passing the wrapper threw a TypeError on every
  // open (#153 to plan 080 S3), so the idle mic visuals never started.
  const analyserNodes = new WeakMap<MicVisualAnalyserLike, AnalyserNode>()
  return createMicVisualPipeline<MediaStream>({
    mediaDevices:
      typeof navigator === 'undefined' ? undefined : (navigator.mediaDevices ?? undefined),
    createAudioContext: () => {
      const context = new AudioContext()
      return {
        sampleRate: context.sampleRate,
        createAnalyser: () => {
          const analyser = context.createAnalyser()
          const wrapper: MicVisualAnalyserLike = {
            get fftSize() {
              return analyser.fftSize
            },
            set fftSize(value: number) {
              analyser.fftSize = value
            },
            get frequencyBinCount() {
              return analyser.frequencyBinCount
            },
            get smoothingTimeConstant() {
              return analyser.smoothingTimeConstant
            },
            set smoothingTimeConstant(value: number) {
              analyser.smoothingTimeConstant = value
            },
            getFloatFrequencyData: (samples) =>
              analyser.getFloatFrequencyData(samples as Float32Array<ArrayBuffer>),
            getFloatTimeDomainData: (samples) =>
              analyser.getFloatTimeDomainData(samples as Float32Array<ArrayBuffer>)
          }
          analyserNodes.set(wrapper, analyser)
          return wrapper
        },
        createMediaStreamSource: (stream) => {
          const source = context.createMediaStreamSource(stream)
          return {
            connect: (analyser) => {
              const node = analyserNodes.get(analyser)
              if (!node) throw new Error('visual microphone analyser is not a Web Audio node')
              source.connect(node)
            },
            disconnect: () => source.disconnect()
          }
        },
        close: () => context.close()
      }
    },
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (id) => window.cancelAnimationFrame(id),
    queueMicrotask: (callback) => globalThis.queueMicrotask(callback),
    subscribeDeviceChange: (listener) => {
      const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
      if (!media?.addEventListener) return () => undefined
      media.addEventListener('devicechange', listener)
      return () => media.removeEventListener('devicechange', listener)
    },
    setTimer: (callback, ms) => window.setTimeout(callback, ms),
    clearTimer: (handle) => window.clearTimeout(handle as number)
  })
}
