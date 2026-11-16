import { afterEach, expect, it, vi } from 'vitest'
afterEach(() => vi.unstubAllGlobals())
it('uses one MessagePort credit during renderer stalls and terminates on close', async () => {
  const posted: unknown[] = []
  const port = {
    onmessage: null as null | ((event: { data: unknown }) => void),
    postMessage: (value: unknown) => posted.push(value),
    close: vi.fn()
  }
  let Processor!: new (options: unknown) => {
    process(inputs: unknown[], outputs: Float32Array[][]): boolean
  }
  vi.stubGlobal(
    'AudioWorkletProcessor',
    class {
      port = port
    }
  )
  vi.stubGlobal('sampleRate', 48000)
  vi.stubGlobal('currentFrame', 0)
  vi.stubGlobal('registerProcessor', (_name: string, ctor: typeof Processor) => {
    Processor = ctor
  })
  await import('./room-pcm-worklet')
  const processor = new Processor({ processorOptions: { generation: 1 } })
  const output = new Float32Array(128).fill(1)
  for (let i = 0; i < 2000; i++) expect(processor.process([], [[output]])).toBe(true)
  expect(posted).toHaveLength(1)
  expect([...output]).toEqual(Array(128).fill(0))
  port.onmessage?.({ data: { generation: 2, frame: null } })
  processor.process([], [[output]])
  expect(posted).toHaveLength(1)
  port.onmessage?.({ data: { generation: 1, frame: null } })
  processor.process([], [[output]])
  expect(posted).toHaveLength(2)
  port.onmessage?.({ data: { close: true } })
  expect(processor.process([], [[output]])).toBe(false)
  expect(port.close).toHaveBeenCalledOnce()
})
