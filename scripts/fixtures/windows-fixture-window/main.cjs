// The Windows stand-in for scripts/fixtures/fixture-window.swift (plan 210
// S11, issue #1088): one borderless, always-on-top window over a whole
// display, painted like Fixture Alpha (solid red, a darker marker letter, a
// frame counter top-left and a white block sweeping the bottom-left 40% of the
// width), so a display capture of it reads exactly like the macOS window
// capture to the shared gates in scripts/lib/scene-window-switch-frames.mjs
// and scripts/lib/smart-scenes-gate.mjs.
//
// Run with the repository's own Electron binary:
//   electron main.cjs [--display-index N] [--color red|blue]
//
// stdout, one line each:
//   ready pid=<pid> window_number=<HWND> bounds=<x>,<y>,<w>x<h> scale=<f> control_port=<port>
//   flash drawn_at_ms=<epoch ms>      after every `flash` command
// Commands, one per line on a TCP connection to 127.0.0.1:<control_port>:
// `flash [ms]` (white for 200 ms, or ms up to 2000), `stats` (prints
// `stats frames=<n> at_ms=<epoch ms>`) and `quit`. Closing that connection
// quits too.

'use strict'

const { app, BrowserWindow, screen } = require('electron')
const { createServer } = require('node:net')
const { join } = require('node:path')
const { createInterface } = require('node:readline')

const FLASH_MS = 200

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const displayIndex = Number(option('--display-index', '0'))
const color = option('--color', 'red')

// GPU compositing stays on: a software-rendered full-display canvas runs at
// a few frames a second on an integrated GPU, and the flash lands ~170 ms late.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

let window = null

function print(line) {
  process.stdout.write(`${line}\n`)
}

app.whenReady().then(async () => {
  const displays = screen.getAllDisplays()
  const display = displays[displayIndex] ?? screen.getPrimaryDisplay()
  window = new BrowserWindow({
    ...display.bounds,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    backgroundColor: color === 'blue' ? '#1f3fd0' : '#d0201f',
    show: false,
    webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true }
  })
  // Above the taskbar and any app window, so the display shows the fixture alone.
  window.setAlwaysOnTop(true, 'screen-saver')
  window.setBounds(display.bounds)
  await window.loadFile(join(__dirname, 'index.html'), { query: { color } })
  window.showInactive()
  const hwnd = window.getNativeWindowHandle()
  const handle = hwnd.length >= 8 ? hwnd.readBigUInt64LE(0) : BigInt(hwnd.readUInt32LE(0))
  // Electron's main process gets no stdin on Windows, so commands arrive on
  // a loopback socket the ready line names. One client: the smoke.
  const control = createServer((socket) => {
    const lines = createInterface({ input: socket })
    lines.on('line', async (raw) => {
      const [command, argument] = raw.trim().split(/\s+/)
      if (command === 'flash') {
        const requested = Number(argument)
        const durationMs =
          Number.isFinite(requested) && requested > 0 ? Math.min(requested, 2000) : FLASH_MS
        try {
          const drawnAtMs = await window.webContents.executeJavaScript(
            `window.__fixtureFlash(${durationMs})`
          )
          print(`flash drawn_at_ms=${Math.round(drawnAtMs)}`)
        } catch (error) {
          print(`flash error=${JSON.stringify(String(error))}`)
        }
      } else if (command === 'stats') {
        // The fixture's own frame rate, so a slow capture is not mistaken
        // for a slow picture.
        try {
          const frames = await window.webContents.executeJavaScript('window.__fixtureFrames()')
          print(`stats frames=${frames} at_ms=${Date.now()}`)
        } catch (error) {
          print(`stats error=${JSON.stringify(String(error))}`)
        }
      } else if (command === 'quit') {
        app.quit()
      }
    })
    // The smoke going away takes the fixture with it.
    socket.on('close', () => app.quit())
    socket.on('error', () => app.quit())
  })
  await new Promise((resolveListen) => control.listen(0, '127.0.0.1', resolveListen))
  const { x, y, width, height } = display.bounds
  print(
    `ready pid=${process.pid} window_number=${handle} bounds=${x},${y},${width}x${height} scale=${display.scaleFactor} control_port=${control.address().port}`
  )
})

app.on('window-all-closed', () => app.quit())
