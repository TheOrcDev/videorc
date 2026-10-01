// Throwaway repro for plan 082 (Windows main window opens blank). Lives only on
// the repro/windows-blank-main-window branch; never merge it.
//
// Launches an installed Videorc several ways, photographs the real desktop
// (what the user sees) and asks the renderer over CDP what it thinks it drew.
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const exe = process.env.VIDEORC_REPRO_EXE
const outDir = process.env.VIDEORC_REPRO_OUT
if (!exe || !outDir) {
  throw new Error('VIDEORC_REPRO_EXE and VIDEORC_REPRO_OUT are required')
}
mkdirSync(outDir, { recursive: true })

const VARIANTS = [
  { name: 'default', env: {} },
  { name: 'glass-off', env: { VIDEORC_GLASS: '0' } },
  { name: 'gpu-off', env: { VIDEORC_DISABLE_GPU: '1' } },
  { name: 'gpu-off-glass-off', env: { VIDEORC_DISABLE_GPU: '1', VIDEORC_GLASS: '0' } }
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function powershell(script) {
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8'
  })
  return { status: result.status, stdout: result.stdout?.trim(), stderr: result.stderr?.trim() }
}

function screenshot(file) {
  return powershell(`
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
    $bmp.Save('${file.replaceAll("'", "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
    "$($b.Width)x$($b.Height)"
  `)
}

function maximize(pid) {
  return powershell(`
    Add-Type @"
    using System; using System.Runtime.InteropServices;
    public static class W { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
      [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }
"@
    $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowHandle -ne 0) {
      [W]::ShowWindow($p.MainWindowHandle, 3) | Out-Null
      [W]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
      "maximized $($p.MainWindowHandle) title=$($p.MainWindowTitle)"
    } else { "no main window handle" }
  `)
}

async function cdpTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json`)
  return response.json()
}

function cdpSession(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    const pending = new Map()
    let nextId = 1
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message)
        pending.delete(message.id)
      }
    })
    socket.addEventListener('error', () => reject(new Error('CDP socket error')))
    socket.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          const id = nextId++
          socket.send(JSON.stringify({ id, method, params }))
          return new Promise((done, fail) => {
            pending.set(id, done)
            setTimeout(() => fail(new Error(`CDP ${method} timed out`)), 15000)
          })
        },
        close: () => socket.close()
      })
    )
  })
}

async function inspectRenderer(port, variantDir) {
  const report = { targets: null, page: null, gpu: null, error: null }
  try {
    const targets = await cdpTargets(port)
    report.targets = targets.map(({ type, url, title }) => ({ type, url, title }))
    const main = targets.find((t) => t.type === 'page' && /renderer\/index\.html/.test(t.url))
    if (!main) {
      report.error = 'no main renderer target'
      return report
    }
    const session = await cdpSession(main.webSocketDebuggerUrl)
    const evaluated = await session.send('Runtime.evaluate', {
      returnByValue: true,
      awaitPromise: true,
      expression: `(async () => ({
        readyState: document.readyState,
        rootChildren: document.getElementById('root')?.childElementCount ?? null,
        bodyTextLength: document.body?.innerText?.length ?? null,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        htmlClass: document.documentElement.className,
        platformAttr: document.documentElement.dataset.platform ?? null,
        visibility: document.visibilityState,
        inner: [innerWidth, innerHeight],
        runtimeInfo: await window.videorc?.getRuntimeInfo?.().catch((e) => String(e))
      }))()`
    })
    report.page = evaluated.result?.result?.value ?? evaluated
    const shot = await session.send('Page.captureScreenshot', { format: 'png' })
    if (shot.result?.data) {
      writeFileSync(join(variantDir, 'cdp-page.png'), Buffer.from(shot.result.data, 'base64'))
    }
    session.close()
  } catch (error) {
    report.error = String(error?.stack ?? error)
  }
  return report
}

const summary = []
let port = 9333
for (const variant of VARIANTS) {
  const variantDir = join(outDir, variant.name)
  const userData = join(outDir, `${variant.name}-userdata`)
  mkdirSync(variantDir, { recursive: true })
  port += 1
  console.log(`\n=== ${variant.name} ===`)
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      ...variant.env,
      VIDEORC_USER_DATA_DIR: userData,
      VIDEORC_REMOTE_DEBUG_PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  let exited = null
  child.on('exit', (code, signal) => (exited = { code, signal }))

  await sleep(25000)
  const first = screenshot(join(variantDir, 'screen-1-launched.png'))
  const max = maximize(child.pid)
  await sleep(4000)
  const second = screenshot(join(variantDir, 'screen-2-maximized.png'))
  const renderer = await inspectRenderer(port, variantDir)
  await sleep(1000)
  const third = screenshot(join(variantDir, 'screen-3-after-cdp.png'))

  // Only the process tree this script started.
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'])
  await sleep(3000)

  writeFileSync(join(variantDir, 'app-output.log'), output)
  for (const file of ['logs', 'gpu-fallback.json', 'backend-crashes.json']) {
    const source = join(userData, file)
    if (existsSync(source)) {
      try {
        cpSync(source, join(variantDir, file), { recursive: true })
      } catch (error) {
        console.log(`copy ${file} failed: ${error}`)
      }
    }
  }
  const entry = {
    variant: variant.name,
    env: variant.env,
    pid: child.pid,
    exitedBeforeKill: exited,
    screenshots: [first, second, third],
    maximize: max,
    renderer
  }
  writeFileSync(join(variantDir, 'report.json'), JSON.stringify(entry, null, 2))
  console.log(JSON.stringify(entry, null, 2))
  summary.push(entry)
}
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
