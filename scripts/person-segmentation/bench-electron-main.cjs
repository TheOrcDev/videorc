// Electron main for bench-run.mjs: one window loading BENCH_URL with an isolated profile.
const { app, BrowserWindow } = require('electron')

app.setPath('userData', process.env.BENCH_PROFILE)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1650,
    height: 962,
    show: process.env.BENCH_SHOW === '1',
    paintWhenInitiallyHidden: true,
    webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true }
  })
  win.loadURL(process.env.BENCH_URL)
})
app.on('window-all-closed', () => app.quit())
