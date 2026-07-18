import { describe, expect, it, vi } from 'vitest'

import {
  createMicStreamController,
  microphoneStreamAcquisitionEnabled,
  type MicStreamConstraints
} from './mic-stream'

function fakeStream(): { stopped: number[]; stream: { getTracks: () => { stop: () => void }[] } } {
  const stopped: number[] = []
  const tracks = [0, 1].map((index) => ({ stop: (): void => void stopped.push(index) }))
  return { stopped, stream: { getTracks: () => tracks } }
}

describe('microphoneStreamAcquisitionEnabled', () => {
  it('allows acquisition only when requested and OS microphone access is exactly granted', () => {
    expect(microphoneStreamAcquisitionEnabled(true, 'granted')).toBe(true)
    expect(microphoneStreamAcquisitionEnabled(false, 'granted')).toBe(false)

    for (const status of [
      'not-determined',
      'denied',
      'restricted',
      'unknown',
      undefined
    ] as const) {
      expect(microphoneStreamAcquisitionEnabled(true, status)).toBe(false)
    }
  })
})

describe('createMicStreamController', () => {
  it('matches the backend device name and requests that exact deviceId', async () => {
    const { stream } = fakeStream()
    const requested: MicStreamConstraints[] = []
    const controller = createMicStreamController({
      enumerateDevices: async () => [
        { kind: 'videoinput', deviceId: 'cam-1', label: 'FaceTime HD Camera' },
        { kind: 'audioinput', deviceId: 'mic-1', label: 'MacBook Pro Microphone' },
        { kind: 'audioinput', deviceId: 'mic-2', label: 'USB Interface' }
      ],
      getUserMedia: async (constraints) => {
        requested.push(constraints)
        return stream
      }
    })

    await expect(controller.open('MacBook Pro Microphone')).resolves.toBe(stream)
    expect(requested).toEqual([{ audio: { deviceId: { exact: 'mic-1' } }, video: false }])
  })

  it('falls back to the default input when the name cannot be matched', async () => {
    const { stream } = fakeStream()
    const requested: MicStreamConstraints[] = []
    const controller = createMicStreamController({
      enumerateDevices: async () => [],
      getUserMedia: async (constraints) => {
        requested.push(constraints)
        return stream
      }
    })

    await expect(controller.open('Ghost Device')).resolves.toBe(stream)
    expect(requested).toEqual([{ audio: true, video: false }])
  })

  it('resolves null without throwing when acquisition fails or media is missing', async () => {
    const denied = createMicStreamController({
      enumerateDevices: async () => [],
      getUserMedia: async () => {
        throw new Error('Permission denied')
      }
    })
    await expect(denied.open(undefined)).resolves.toBeNull()
    await expect(createMicStreamController(undefined).open('Any')).resolves.toBeNull()
    // enumerateDevices failures fall back to the default input, not an error.
    const { stream } = fakeStream()
    const flakyEnumerate = createMicStreamController({
      enumerateDevices: async () => {
        throw new Error('enumerate failed')
      },
      getUserMedia: async () => stream
    })
    await expect(flakyEnumerate.open('Any')).resolves.toBe(stream)
  })

  it('stops tracks on close, including a stream that resolves after close', async () => {
    const first = fakeStream()
    let resolveSecond: ((stream: (typeof first)['stream']) => void) | undefined
    const controller = createMicStreamController({
      getUserMedia: async () => first.stream
    })
    await controller.open(undefined)
    controller.close()
    expect(first.stopped).toEqual([0, 1])

    // A close() racing an in-flight open(): the late stream must be stopped
    // and never handed out.
    const second = fakeStream()
    const racing = createMicStreamController({
      getUserMedia: () =>
        new Promise<(typeof second)['stream']>((resolve) => {
          resolveSecond = resolve
        })
    })
    const pending = racing.open(undefined)
    // Let open() progress past device enumeration to the getUserMedia call.
    await Promise.resolve()
    racing.close()
    resolveSecond?.(second.stream)
    await expect(pending).resolves.toBeNull()
    expect(second.stopped).toEqual([0, 1])

    // A closed controller refuses further opens.
    await expect(racing.open(undefined)).resolves.toBeNull()
  })

  it('does not request a stream after close wins a deferred device enumeration', async () => {
    let resolveDevices:
      | ((devices: Array<{ kind: string; deviceId: string; label: string }>) => void)
      | undefined
    const getUserMedia = vi.fn(async () => fakeStream().stream)
    const controller = createMicStreamController({
      enumerateDevices: () =>
        new Promise((resolve) => {
          resolveDevices = resolve
        }),
      getUserMedia
    })

    const pending = controller.open('Studio microphone')
    controller.close()
    resolveDevices?.([{ kind: 'audioinput', deviceId: 'mic-1', label: 'Studio microphone' }])

    await expect(pending).resolves.toBeNull()
    expect(getUserMedia).not.toHaveBeenCalled()
  })
})
