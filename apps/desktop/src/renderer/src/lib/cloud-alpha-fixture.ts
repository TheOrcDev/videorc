/** Browser acquisition entry, bundled only by the explicitly invoked S10 harness. */
import { Room, Track, PublishTrackError } from 'livekit-client'
import { ALPHA_EXPERIMENT } from '../../../shared/cloud-alpha'
import { publishAlphaExperiment } from './room-alpha-experiment'

const room = new Room({ adaptiveStream: false, dynacast: false })
const timers: ReturnType<typeof setInterval>[] = [],
  tracks: MediaStreamTrack[] = []
const alphas: Awaited<ReturnType<typeof publishAlphaExperiment>>[] = []
let audio: AudioContext | null = null
async function publishVideo(name: string, screen: boolean, index: number) {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 360
  const context = canvas.getContext('2d')!
  let frame = 0
  const draw = () => {
    context.fillStyle = screen ? '#204060' : `hsl(${index * 57} 75% 40%)`
    context.fillRect(0, 0, 640, 360)
    context.fillStyle = 'white'
    context.fillRect((frame++ * 7) % 600, 300, 40, 40)
  }
  draw()
  timers.push(setInterval(draw, 1000 / 30))
  const track = canvas.captureStream(30).getVideoTracks()[0]!
  tracks.push(track)
  return room.localParticipant.publishTrack(track, {
    name,
    source: screen ? Track.Source.ScreenShare : Track.Source.Camera,
    simulcast: false,
    videoCodec: 'vp8',
    videoEncoding: { maxBitrate: 1_500_000, maxFramerate: 30 }
  })
}
Object.assign(window, {
  alphaPublisher: {
    async start(input: {
      url: string
      token: string
      host: boolean
      show: string
      index: number
      layer: boolean
    }) {
      await room.connect(input.url, input.token, { autoSubscribe: false })
      // Deny every subscriber before any experimental publication can exist.
      room.localParticipant.setTrackSubscriptionPermissions(false, [])
      await publishVideo('camera', false, input.index)
      audio = new AudioContext({ sampleRate: 48000 })
      const oscillator = audio.createOscillator(),
        gain = audio.createGain(),
        sink = audio.createMediaStreamDestination()
      oscillator.frequency.value = 220 + input.index * 110
      gain.gain.value = 0.02
      oscillator.connect(gain).connect(sink)
      oscillator.start()
      await audio.resume()
      const track = sink.stream.getAudioTracks()[0]!
      tracks.push(track)
      await room.localParticipant.publishTrack(track, {
        name: 'speech-fixture',
        source: Track.Source.Microphone
      })
      if (input.host) {
        await publishVideo('screen', true, input.index)
        if (input.layer)
          for (const orientation of ['h', 'v'] as const)
            alphas.push(
              await publishAlphaExperiment(room, {
                experiment: ALPHA_EXPERIMENT,
                show: input.show,
                orientation,
                generation: 1
              })
            )
      }
      return {
        sid: room.localParticipant.sid,
        publications: [...room.localParticipant.trackPublications.values()].map((p) => ({
          sid: p.trackSid,
          name: p.trackName,
          source: p.source
        }))
      }
    },
    async probeForbiddenSource() {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 2
      const track = canvas.captureStream(0).getVideoTracks()[0]!
      try {
        const p = await room.localParticipant.publishTrack(track, {
          source: Track.Source.Unknown,
          name: 'forbidden-alpha-probe'
        })
        if (p.track) await room.localParticipant.unpublishTrack(p.track)
        return false
      } catch (error) {
        return (
          error instanceof PublishTrackError && error.status === 403 && room.state === 'connected'
        )
      } finally {
        track.stop()
        canvas.width = canvas.height = 1
      }
    },
    permit(permissions: { participantSid: string; trackSids: string[] }[]) {
      room.localParticipant.setTrackSubscriptionPermissions(false, permissions)
    },
    sample: () => alphas.map((a) => ({ ...a.stats })),
    async close() {
      timers.forEach(clearInterval)
      await Promise.all(alphas.map((a) => a.close()))
      tracks.forEach((t) => t.stop())
      await audio?.close()
      await room.disconnect()
    }
  }
})
