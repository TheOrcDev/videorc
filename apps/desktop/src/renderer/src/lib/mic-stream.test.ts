import { describe, expect, it, vi } from 'vitest'

import {
  createMicStreamController,
  closeVisualMicrophoneStreams,
  micStreamFailureFromError,
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
    expect(requested).toEqual([
      {
        audio: {
          deviceId: { exact: 'mic-1' },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        },
        video: false
      }
    ])
  })

  it('never opens an unrelated default or ambiguous device in strict live mode', async () => {
    for (const labels of [[], ['Other'], ['Studio', 'Studio'], [''], ['Studio Plus']]) {
      const getUserMedia = vi.fn(async () => fakeStream().stream)
      const controller = createMicStreamController({
        enumerateDevices: async () =>
          labels.map((label, index) => ({ kind: 'audioinput', deviceId: `mic-${index}`, label })),
        getUserMedia
      })
      expect(await controller.open('Studio', true)).toBeNull()
      expect(getUserMedia).not.toHaveBeenCalled()
      controller.close()
    }
  })

  // Plan 080 S3: strict mode compared raw labels, and Chromium decorates every
  // macOS label, so the preview never opened a real Mac mic after 0.9.101.
  it('opens the selected Mac mic in strict mode behind Chromium label decorations', async () => {
    const labels = [
      {
        kind: 'audioinput',
        deviceId: 'default',
        label: 'Default - MacBook Pro Microphone (Built-in)'
      },
      { kind: 'audioinput', deviceId: 'built-in', label: 'MacBook Pro Microphone (Built-in)' },
      { kind: 'audioinput', deviceId: 'airpods', label: 'AirPods Pro (Bluetooth)' },
      { kind: 'audioinput', deviceId: 'mv7', label: 'Shure MV7 (14ed:1012)' }
    ]
    for (const [name, deviceId] of [
      ['AirPods Pro', 'airpods'],
      ['MacBook Pro Microphone', 'built-in'],
      ['Shure MV7', 'mv7']
    ] as const) {
      const { stream } = fakeStream()
      const requested: MicStreamConstraints[] = []
      const controller = createMicStreamController({
        enumerateDevices: async () => labels,
        getUserMedia: async (constraints) => {
          requested.push(constraints)
          return stream
        }
      })
      await expect(controller.open(name, true)).resolves.toBe(stream)
      expect(requested[0]?.audio.deviceId).toEqual({ exact: deviceId })
      expect(controller.lastFailure()).toBeNull()
      controller.close()
    }
  })

  it('says why a strict open failed instead of a bare null', async () => {
    for (const [labels, reason] of [
      [[], 'device-missing'],
      [['Other (Built-in)'], 'no-label-match'],
      [['Studio Plus (USB)'], 'no-label-match'],
      [['USB Mic (Virtual)', 'USB Mic (Virtual)'], 'ambiguous-label'],
      [['', ''], 'labels-hidden']
    ] as const) {
      const controller = createMicStreamController({
        enumerateDevices: async () =>
          labels.map((label, index) => ({ kind: 'audioinput', deviceId: `mic-${index}`, label })),
        getUserMedia: vi.fn(async () => fakeStream().stream)
      })
      const name = reason === 'ambiguous-label' ? 'USB Mic' : 'Studio'
      await expect(controller.open(name, true)).resolves.toBeNull()
      expect(controller.lastFailure()).toEqual({ reason })
      controller.close()
    }
    const noMedia = createMicStreamController(undefined)
    await expect(noMedia.open('Studio', true)).resolves.toBeNull()
    expect(noMedia.lastFailure()).toEqual({ reason: 'no-media' })
  })

  it('maps getUserMedia errors onto a reason the UI can explain', async () => {
    const error = (name: string): Error => Object.assign(new Error(`${name} message`), { name })
    for (const [name, reason] of [
      ['NotAllowedError', 'permission-denied'],
      ['NotReadableError', 'device-busy'],
      ['AbortError', 'device-busy'],
      ['NotFoundError', 'device-missing'],
      ['OverconstrainedError', 'overconstrained'],
      ['TypeError', 'unknown']
    ] as const) {
      const controller = createMicStreamController({
        enumerateDevices: async () => [
          { kind: 'audioinput', deviceId: 'mic-1', label: 'AirPods Pro (Bluetooth)' }
        ],
        getUserMedia: async () => {
          throw error(name)
        }
      })
      await expect(controller.open('AirPods Pro', true)).resolves.toBeNull()
      expect(controller.lastFailure()).toEqual({ reason, detail: `${name} message` })
    }
    expect(micStreamFailureFromError('boom')).toEqual({ reason: 'unknown' })
  })

  it('releases active and pending visual acquisitions before a live replacement', async () => {
    const active = fakeStream(),
      late = fakeStream()
    const first = createMicStreamController({ getUserMedia: async () => active.stream })
    await first.open(undefined)
    let resolve!: (stream: typeof late.stream) => void
    const second = createMicStreamController({
      getUserMedia: () =>
        new Promise<typeof late.stream>((yes) => {
          resolve = yes
        })
    })
    const opening = second.open(undefined)
    await Promise.resolve()
    closeVisualMicrophoneStreams()
    expect(active.stopped).toEqual([0, 1])
    resolve(late.stream)
    expect(await opening).toBeNull()
    expect(late.stopped).toEqual([0, 1])
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
    // Processing stays off on the default input too: AGC would pump silence.
    expect(requested).toEqual([
      {
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false
      }
    ])
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
      ((devices: Array<{ kind: string; deviceId: string; label: string }>) => void) | undefined
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
