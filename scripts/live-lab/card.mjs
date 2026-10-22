#!/usr/bin/env node
// Plan 178 U7. Serves the live-lab test card on 127.0.0.1 for a look or a
// local recording. The harness (live:run) uses lib/card-server.mjs directly.
//
//   node scripts/live-lab/card.mjs [--port 4178] [--demo]
//
// --demo pushes made-up metrics every 5 s and walks the steps, so the card
// can be checked by eye or recorded through measure-av-sync without a run.
// Open the printed URL fullscreen in Chrome started with
// --autoplay-policy=no-user-gesture-required (the click needs audio).

import { startCardServer } from './lib/card-server.mjs'

function flag(argv, name) {
  const index = argv.indexOf(name)
  return index !== -1 ? argv[index + 1] : undefined
}

const argv = process.argv.slice(2)
const demo = argv.includes('--demo')
const port = Number(flag(argv, '--port') ?? 0)
const startedAt = Date.now()

const card = await startCardServer({
  port,
  runInfo: {
    runId: demo ? 'demo-local' : 'local',
    scenario: demo ? 'demo' : 'manual',
    appVersion: process.env.npm_package_version ?? '0.0.0',
    startedAt
  },
  onDropped: (fields) => console.warn(`card: dropped ${fields.join(', ')}`)
})
console.log(`Test card: ${card.url}`)

if (demo) {
  const steps = ['Go live', 'Scene applied', 'Comment highlighted', 'Caption check', 'Stop']
  let tick = 0
  const pushDemo = () => {
    const t = tick * 5
    card.push({
      state: 'live',
      memoryMb: {
        backend: 410 + Math.round(t / 30),
        main: 190,
        renderer: 360 + Math.round(10 * Math.sin(t / 40)),
        gpu: 240,
        ffmpeg: 150
      },
      bitrateKbps: 6000 + Math.round(120 * Math.sin(t / 20)),
      droppedFrames: Math.floor(t / 240),
      encoderSpeed: 1 + 0.02 * Math.sin(t / 15),
      openIncidents: 0,
      healthEventCodes: tick % 12 === 6 ? ['stream:bitrate-dip'] : []
    })
    if (tick % 6 === 0) {
      const index = (tick / 6) % steps.length
      card.setStep({ index: index + 1, total: steps.length, name: steps[index], sceneId: index })
    }
    tick += 1
  }
  pushDemo()
  setInterval(pushDemo, 5000)
}

const stop = async () => {
  await card.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
