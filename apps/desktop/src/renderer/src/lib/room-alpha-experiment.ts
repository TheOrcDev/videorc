/** S10 fixture-only publisher. Nothing in the application imports or enables this. */
import { Room, Track, type LocalTrackPublication } from 'livekit-client'
import { ALPHA_EXPERIMENT, ALPHA_LIMITS, ALPHA_ROLE, stampBits } from '../../../shared/cloud-alpha'
import { createAlphaGpu } from '../../../shared/cloud-alpha-gpu'

/** Fixed solid/half/transparent patches plus high-frequency motion and a checked clock strip. */
export function paintAlphaFixture(context: CanvasRenderingContext2D, frame: number, now: number) {
  const { width: w, height: h } = context.canvas
  context.clearRect(0, 0, w, h)
  for (let y = Math.floor(h / 4); y < h - 12; y += 8)
    for (let x = 0; x < w; x += 8) {
      const n = Math.imul((x + 1) * (y + 3), frame + 1) >>> 0
      context.fillStyle = `rgba(${n & 255},${(n >>> 8) & 255},${(n >>> 16) & 255},${(n % 255) / 255})`
      context.fillRect(x, y, 8, 8)
    }
  context.fillStyle = '#ff00ff'
  context.fillRect(0, 0, w / 4, h / 4)
  context.fillStyle = 'rgba(0,255,0,0.5019607843)'
  context.fillRect(w / 4, 0, w / 4, h / 4)
  for (const [i, bit] of stampBits(now).entries()) {
    context.fillStyle = bit ? 'white' : 'black'
    context.fillRect((i * w) / 32, h - 12, w / 32 + 1, 12)
  }
}

export async function publishAlphaExperiment(
  room: Room,
  options: {
    experiment: typeof ALPHA_EXPERIMENT
    show: string
    orientation: 'h' | 'v'
    generation: number
  }
) {
  if (
    options.experiment !== ALPHA_EXPERIMENT ||
    room.localParticipant.identity !== `host:${options.show}` ||
    !room.localParticipant.permissions?.canPublish ||
    !Number.isSafeInteger(options.generation) ||
    options.generation < 1
  )
    throw new Error('alpha experimental publisher is not authorized')
  const name = `${ALPHA_ROLE}:${options.orientation}:${options.generation}`
  const alphaTracks = [...room.localParticipant.trackPublications.values()].filter((p) =>
    p.trackName.startsWith(ALPHA_ROLE)
  )
  if (
    alphaTracks.length >= ALPHA_LIMITS.publications ||
    alphaTracks.some((p) => p.trackName === name)
  )
    throw new Error('alpha experimental publication capacity reached')
  const width = options.orientation === 'h' ? 640 : 360,
    height = options.orientation === 'h' ? 360 : 640
  const source = document.createElement('canvas')
  source.width = width
  source.height = height
  const context = source.getContext('2d')
  if (!context) throw new Error('alpha fixture canvas unavailable')
  const packed = document.createElement('canvas'),
    gpu = createAlphaGpu(packed, width, height, 'pack')
  let publication: LocalTrackPublication | undefined,
    timer: ReturnType<typeof setInterval> | undefined
  let closed = false,
    frame = 0
  let stream: MediaStream | undefined
  const close = async () => {
    if (closed) return
    closed = true
    clearInterval(timer)
    if (publication?.track)
      await room.localParticipant.unpublishTrack(publication.track).catch(() => {})
    stream?.getTracks().forEach((t) => t.stop())
    gpu.close()
    source.width = source.height = 1
  }
  try {
    stream = packed.captureStream(0)
    const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined
    if (!track || typeof track.requestFrame !== 'function')
      throw new Error('explicit canvas frame capture unavailable')
    const draw = () => {
      if (closed) return
      paintAlphaFixture(context, frame++, Date.now())
      if (!gpu.draw(source)) {
        void close()
        return
      }
      track.requestFrame()
    }
    draw()
    publication = await room.localParticipant.publishTrack(track, {
      name,
      source: Track.Source.Camera,
      videoCodec: 'vp8',
      simulcast: false,
      videoEncoding: { maxBitrate: 4_000_000, maxFramerate: ALPHA_LIMITS.fps }
    })
    if (closed) {
      if (publication.track) await room.localParticipant.unpublishTrack(publication.track)
      throw new Error('alpha publication cancelled')
    }
    timer = setInterval(draw, 1000 / ALPHA_LIMITS.fps)
    return { publication, width, height, close, stats: gpu.stats }
  } catch (error) {
    await close()
    throw error
  }
}
