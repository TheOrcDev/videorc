import { createMicVisualPipeline, type MicVisualPipeline } from './mic-visual-pipeline'

/** Browser adapter for the shared visual-only microphone analyser. */
export function createBrowserMicVisualPipeline(): MicVisualPipeline {
  return createMicVisualPipeline<MediaStream>({
    mediaDevices:
      typeof navigator === 'undefined' ? undefined : (navigator.mediaDevices ?? undefined),
    createAudioContext: () => {
      const context = new AudioContext()
      return {
        sampleRate: context.sampleRate,
        createAnalyser: () => {
          const analyser = context.createAnalyser()
          return {
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
        },
        createMediaStreamSource: (stream) => {
          const source = context.createMediaStreamSource(stream)
          return {
            connect: (analyser) => source.connect(analyser as AnalyserNode),
            disconnect: () => source.disconnect()
          }
        },
        close: () => context.close()
      }
    },
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (id) => window.cancelAnimationFrame(id),
    queueMicrotask: (callback) => globalThis.queueMicrotask(callback)
  })
}
