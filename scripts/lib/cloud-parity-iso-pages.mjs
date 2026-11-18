/** Plan 249 S22 `iso` browser pieces. Functions here run INSIDE pages
 * (Playwright init scripts / evaluate bodies); importing launches nothing.
 */

/**
 * Guest devices for the real GuestRoom (like cloud-parity-browser's
 * `installGuestFixture`), plus a shared wall-clock marker: the camera turns
 * white and the tone stops for `length` ms at every multiple of `period` ms
 * of `Date.now()`. Same machine clock as the desktop, recorder and program.
 */
export function installIsoGuestFixture({ color, hz, peak, slug, period, length }) {
  sessionStorage.setItem(`vrc-guest-request:${slug}`, 'parity-admitted')
  sessionStorage.setItem('vrc-guest-name', slug)
  const marker = () => Date.now() % period < length
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const tracks = []
    if (constraints.video) {
      const canvas = document.createElement('canvas')
      canvas.width = 320
      canvas.height = 180
      const ctx = canvas.getContext('2d')
      const draw = () => {
        ctx.fillStyle = marker() ? 'rgb(255,255,255)' : `rgb(${color.join(',')})`
        ctx.fillRect(0, 0, 320, 180)
      }
      draw()
      const timer = setInterval(draw, 10)
      const track = canvas.captureStream(30).getVideoTracks()[0]
      const stop = track.stop.bind(track)
      track.stop = () => {
        clearInterval(timer)
        stop()
      }
      tracks.push(track)
    }
    if (constraints.audio) {
      const context = new AudioContext({ sampleRate: 48000 })
      const oscillator = context.createOscillator(),
        gain = context.createGain(),
        destination = context.createMediaStreamDestination()
      oscillator.frequency.value = hz
      gain.gain.value = peak
      oscillator.connect(gain).connect(destination)
      oscillator.start()
      await context.resume()
      const timer = setInterval(
        () => gain.gain.setValueAtTime(marker() ? 0 : peak, context.currentTime),
        5
      )
      const track = destination.stream.getAudioTracks()[0],
        stop = track.stop.bind(track)
      track.stop = () => {
        clearInterval(timer)
        oscillator.stop()
        void context.close()
        stop()
      }
      tracks.push(track)
    }
    return tracks.length ? new MediaStream(tracks) : original(constraints)
  }
}

/**
 * Records the REAL program tab's pixels and its final audio bus (the tap of
 * cloud-parity-browser's `installProgramAudioTap`) in one MediaRecorder, as
 * the replay-ring case does. Chunks go to `window.__isoProgramChunk`.
 * Resolves with the recorder's start, in wall-clock ms.
 */
export async function startProgramCapture({ title }) {
  document.title = title
  const taps = window.__parityProgramTaps ?? []
  if (taps.length !== 1) throw new Error(`Expected one final program mix, saw ${taps.length}`)
  const display = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'browser', frameRate: 30 },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: 'include'
  })
  const video = display.getVideoTracks()[0]
  if (video.getSettings().displaySurface !== 'browser') {
    display.getTracks().forEach((track) => track.stop())
    throw new Error('Tab capture unavailable; no fake screen fallback allowed')
  }
  const audio = taps[0].tap.stream.getAudioTracks()[0]
  if (!audio || audio.readyState !== 'live') throw new Error('No live program mix')
  const recorder = new MediaRecorder(new MediaStream([video, audio]), {
    mimeType: 'video/webm;codecs=vp8,opus',
    videoBitsPerSecond: 2_500_000
  })
  const state = (window.__isoProgram = {
    recorder,
    video,
    pending: Promise.resolve(),
    error: null
  })
  recorder.ondataavailable = (event) => {
    if (!event.data.size) return
    state.pending = state.pending
      .then(async () => {
        const bytes = new Uint8Array(await event.data.arrayBuffer())
        let text = ''
        for (let i = 0; i < bytes.length; i += 0x8000)
          text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        await window.__isoProgramChunk(btoa(text))
      })
      .catch(() => {
        state.error = 'Program chunk delivery failed'
      })
  }
  recorder.onerror = () => {
    state.error = 'Program MediaRecorder failed'
  }
  return new Promise((resolve) => {
    recorder.onstart = () => resolve(Date.now())
    recorder.start(500)
  })
}

/** Stops the program recorder, flushes every chunk, resolves with the stop time. */
export async function stopProgramCapture() {
  const state = window.__isoProgram
  if (!state) return null
  if (state.recorder.state !== 'inactive') {
    const stopped = new Promise((resolve) => {
      state.recorder.onstop = resolve
    })
    state.recorder.stop()
    await stopped
  }
  const endedAt = Date.now()
  await state.pending
  state.video.stop()
  if (state.error) throw new Error(state.error)
  return endedAt
}
