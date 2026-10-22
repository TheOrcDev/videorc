// Plan 178 U7 test card runtime. Paints the state the harness pushes over
// SSE, runs the clock and motion every frame, fires the flash + click sync
// pulse on each 10 s wall-clock boundary, and draws the marker regions.
//
// Audio: the click plays through the browser's default output. The lab
// captures it as System audio, so the default output must be a real device
// (not BlackHole, which carries the scripted speech as the mic).

import {
  FLASH_MS,
  PULSE_INTERVAL_MS,
  buildCardView,
  formatClock,
  formatUptime,
  msUntilPulse,
  renderCardRegions
} from './card-view.mjs'
import { markerPaintList } from './marker-codec.mjs'

const $ = (id) => document.getElementById(id)
const clock = $('clock')
const uptime = $('uptime')
const runner = $('runner')
const syncArc = $('sync-arc')
const syncIn = $('sync-in')
const flash = $('flash')
const canvas = $('markers')
const session = document.querySelector('.session')
const ARC_LENGTH = 2 * Math.PI * 16

let state = null
let spec = null
let pulses = 0
const audio = new AudioContext({ latencyHint: 'interactive' })

// Same click as scripts/lib/av-sync-stimulus.mjs: a 1 kHz tone burst with a
// 4 ms attack, gone by 60 ms. measure-av-sync finds its onset with
// silencedetect (and a 1 kHz band-pass for system-audio recordings).
function click() {
  const now = audio.currentTime
  const osc = audio.createOscillator()
  const gain = audio.createGain()
  osc.type = 'sine'
  osc.frequency.value = 1000
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(0.8, now + 0.004)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06)
  osc.connect(gain)
  gain.connect(audio.destination)
  osc.start(now)
  osc.stop(now + 0.07)
}

function reportPulse() {
  const body = JSON.stringify({
    count: pulses,
    audioState: audio.state,
    visible: document.visibilityState,
    focused: document.hasFocus(),
    at: Date.now()
  })
  fetch('/pulse', { method: 'POST', body, keepalive: true }).catch(() => {})
}

function pulse() {
  audio.resume()
  pulses += 1
  flash.classList.add('on')
  click()
  setTimeout(() => flash.classList.remove('on'), FLASH_MS)
  reportPulse()
  schedulePulse()
}

function schedulePulse() {
  const delay = msUntilPulse(Date.now()) || PULSE_INTERVAL_MS
  setTimeout(pulse, delay)
}

function drawMarkers() {
  if (!spec) return
  const ratio = window.devicePixelRatio || 1
  const width = Math.round(window.innerWidth * ratio)
  const height = Math.round(window.innerHeight * ratio)
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  const context = canvas.getContext('2d')
  context.clearRect(0, 0, width, height)
  const step = state?.step ?? { index: 0, sceneId: 0 }
  const paint = markerPaintList(
    spec,
    { x: 0, y: 0, width, height },
    { sceneId: step.sceneId, stepIndex: step.index }
  )
  for (const rect of paint) {
    context.fillStyle = rect.color
    context.fillRect(rect.x, rect.y, rect.width, rect.height)
  }
}

function render() {
  if (!state) return
  const regions = renderCardRegions(buildCardView(state, Date.now()))
  for (const [id, html] of Object.entries(regions)) {
    const element = $(id)
    if (element && element.innerHTML !== html) element.innerHTML = html
  }
  session.dataset.state = state.state ?? 'idle'
  drawMarkers()
}

function frame() {
  const now = Date.now()
  clock.textContent = formatClock(now)
  const startedAt = state?.run?.startedAt
  uptime.textContent = formatUptime(startedAt ? now - startedAt : NaN)
  // Back and forth across the track every 4 s, eased, so motion never stops.
  const track = runner.parentElement.clientWidth - runner.clientWidth
  const phase = (now % 4000) / 4000
  const x = ((1 - Math.cos(phase * 2 * Math.PI)) / 2) * track
  runner.style.transform = `translateX(${x.toFixed(1)}px)`
  const remaining = msUntilPulse(now) || PULSE_INTERVAL_MS
  syncArc.style.strokeDashoffset = String(((remaining / PULSE_INTERVAL_MS) * ARC_LENGTH).toFixed(2))
  syncIn.textContent = (remaining / 1000).toFixed(1)
  requestAnimationFrame(frame)
}

function connect() {
  const events = new EventSource('/events')
  events.addEventListener('state', (event) => {
    state = JSON.parse(event.data)
    $('link').hidden = true
    render()
  })
  events.addEventListener('error', () => {
    $('link').hidden = false
  })
}

async function start() {
  spec = await (await fetch('/markers.json')).json()
  drawMarkers()
  window.addEventListener('resize', drawMarkers)
  connect()
  requestAnimationFrame(frame)
  schedulePulse()
}

start()
