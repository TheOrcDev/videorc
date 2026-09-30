// Electron main for the Linux screen-record smokes: one window that repaints
// every animation frame, so a captured monitor always has motion. A static
// desktop makes exact frame repeats the expected output and the analyzer's
// freeze/repeat gates meaningless (ogre, 2026-09-30).
//
// Prints `motion-window-ready` once the first frame is painted.
// Launched by scripts/lib/linux-motion-window.mjs; never part of the app.

const { app, BrowserWindow } = require('electron')

const page = `<!doctype html><html><body style="margin:0;overflow:hidden;background:#000">
<canvas id="c"></canvas>
<script>
const canvas = document.getElementById('c')
const context = canvas.getContext('2d')
let frame = 0
function paint() {
  canvas.width = innerWidth
  canvas.height = innerHeight
  frame += 1
  context.fillStyle = 'hsl(' + ((frame * 7) % 360) + ' 70% 40%)'
  context.fillRect(0, 0, canvas.width, canvas.height)
  const size = Math.max(40, Math.min(canvas.width, canvas.height) / 4)
  const x = (frame * 11) % Math.max(1, canvas.width - size)
  const y = (frame * 5) % Math.max(1, canvas.height - size)
  context.fillStyle = '#fff'
  context.fillRect(x, y, size, size)
  context.font = '48px monospace'
  context.fillText(String(frame), 24, 64)
  if (frame === 2) document.title = 'motion-ready'
  requestAnimationFrame(paint)
}
requestAnimationFrame(paint)
</script></body></html>`

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 960,
    height: 720,
    title: 'Videorc motion probe',
    backgroundColor: '#000000',
    webPreferences: { sandbox: true, backgroundThrottling: false }
  })
  window.webContents.on('page-title-updated', (_event, title) => {
    if (title === 'motion-ready') console.log('motion-window-ready')
  })
  window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`)
})

app.on('window-all-closed', () => app.quit())
