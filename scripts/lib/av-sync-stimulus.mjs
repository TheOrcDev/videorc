import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  resolveScreenMotionStimulusBrowser,
  resolveWindowsStimulusBrowser,
  stopStimulusBrowserTree,
  stimulusWindowOptionsForSource
} from './screen-motion-stimulus.mjs'

const DEFAULT_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export function resolveAvSyncStimulusBrowser({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  requestedPath
} = {}) {
  if (platform === 'win32') {
    return resolveWindowsStimulusBrowser({
      env,
      exists,
      requestedPath,
      legacyEnvironmentVariable: 'VIDEORC_AV_SYNC_BROWSER_PATH'
    })
  }
  return resolveScreenMotionStimulusBrowser({
    platform,
    env: {
      ...env,
      VIDEORC_SCREEN_MOTION_BROWSER_PATH: env.VIDEORC_AV_SYNC_BROWSER_PATH ?? DEFAULT_CHROME_PATH
    },
    exists,
    requestedPath
  })
}

export async function launchAvSyncStimulus(options = {}) {
  const displayOptions = stimulusWindowOptionsForSource(options.screenSource) ?? {}
  const browserResolution = resolveAvSyncStimulusBrowser({
    requestedPath: options.browserPath
  })
  const browserPath = browserResolution.executablePath
  const x = Number(options.x ?? process.env.VIDEORC_AV_SYNC_X ?? displayOptions.x ?? 16)
  const y = Number(options.y ?? process.env.VIDEORC_AV_SYNC_Y ?? displayOptions.y ?? 16)
  const width = Number(
    options.width ?? process.env.VIDEORC_AV_SYNC_WIDTH ?? displayOptions.width ?? 1800
  )
  const height = Number(
    options.height ?? process.env.VIDEORC_AV_SYNC_HEIGHT ?? displayOptions.height ?? 980
  )
  const settleMs = Number(options.settleMs ?? process.env.VIDEORC_AV_SYNC_SETTLE_MS ?? 1800)

  if (!browserPath) {
    throw new Error(
      `A/V sync stimulus requires a Chromium-compatible browser. ` +
        `Set VIDEORC_STIMULUS_BROWSER, or install Edge/Chrome. ` +
        `Checked: ${browserResolution.searchedPaths.join(', ') || 'no Windows browser roots were available'}.`
    )
  }

  const dir = mkdtempSync(join(tmpdir(), 'videorc-av-sync-'))
  const htmlPath = join(dir, 'stimulus.html')
  const profileDir = join(dir, 'profile')
  writeFileSync(htmlPath, stimulusHtml(), 'utf8')

  const child = spawn(
    browserPath,
    [
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-extensions',
      '--autoplay-policy=no-user-gesture-required',
      '--force-device-scale-factor=1',
      `--window-position=${x},${y}`,
      `--window-size=${width},${height}`,
      `--app=${pathToFileURL(htmlPath).href}`
    ],
    {
      detached: true,
      stdio: 'ignore'
    }
  )
  child.unref()
  const stimulus = {
    child,
    dir,
    htmlPath,
    browserPath,
    browserSource: browserResolution.source,
    x,
    y,
    width,
    height
  }
  try {
    await sleep(settleMs)
    if (child.exitCode !== null) {
      throw new Error(`A/V sync stimulus browser exited early with code ${child.exitCode}.`)
    }
    return stimulus
  } catch (error) {
    await stopAvSyncStimulus(stimulus, options.teardownOptions)
    throw error
  }
}

export async function stopAvSyncStimulus(stimulus, options = {}) {
  return await stopStimulusBrowserTree(stimulus, options)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stimulusHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Videorc A/V Sync Stimulus</title>
  <style>
    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #000;
      color: #fff;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    #stage {
      position: fixed;
      inset: 0;
      background: #000;
    }
    #stage.flash {
      background: #fff;
    }
    #counter {
      position: fixed;
      left: 3vw;
      bottom: 3vh;
      padding: 0.2em 0.35em;
      background: rgba(0, 0, 0, 0.78);
      color: #fff;
      font-size: 6vh;
      font-weight: 800;
    }
    #sweep {
      position: fixed;
      top: 0;
      bottom: 0;
      width: 18vw;
      background: linear-gradient(90deg, transparent, #115566, #221144, transparent);
      opacity: 0.74;
      will-change: transform;
    }
    #ticker {
      position: fixed;
      left: 0;
      right: 0;
      top: 5vh;
      padding: 0.25em 0;
      background: #151515;
      color: #7de7ff;
      font-size: 4vh;
      white-space: nowrap;
      will-change: transform;
    }
    .dot {
      position: fixed;
      width: 7vh;
      height: 7vh;
      border: 1vh solid #6cff8d;
      border-radius: 999px;
      box-shadow: 0 0 0 0.6vh #111;
      will-change: transform;
    }
  </style>
</head>
<body>
  <div id="stage"></div>
  <div id="sweep"></div>
  <div id="ticker">VIDEORC A/V SYNC STIMULUS - continuous low-luma motion plus one full-frame flash/click each second - </div>
  <div id="dot" class="dot"></div>
  <div id="counter">sync 0000</div>
  <script>
    const stage = document.getElementById('stage');
    const sweep = document.getElementById('sweep');
    const ticker = document.getElementById('ticker');
    const dot = document.getElementById('dot');
    const counter = document.getElementById('counter');
    const audio = new AudioContext();
    let count = 0;
    let frame = 0;

    function click() {
      const now = audio.currentTime;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = 1000;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.8, now + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
      osc.connect(gain);
      gain.connect(audio.destination);
      osc.start(now);
      osc.stop(now + 0.07);
    }

    function pulse() {
      audio.resume();
      count += 1;
      counter.textContent = 'sync ' + String(count).padStart(4, '0');
      stage.classList.add('flash');
      click();
      setTimeout(() => stage.classList.remove('flash'), 50);
    }

    setTimeout(() => {
      pulse();
      setInterval(pulse, 1000);
    }, 500);

    function animate(now) {
      frame += 1;
      const w = window.innerWidth;
      const h = window.innerHeight;
      sweep.style.transform = 'translateX(' + (((now / 6) % (w + 300)) - 220) + 'px)';
      ticker.style.transform = 'translateX(' + (-((now / 10) % Math.max(1, w))) + 'px)';
      dot.style.transform =
        'translate(' +
        ((Math.sin(now / 620) * 0.42 + 0.5) * (w - 140)) +
        'px,' +
        ((Math.cos(now / 780) * 0.36 + 0.5) * (h - 140)) +
        'px)';
      counter.textContent = 'sync ' + String(count).padStart(4, '0') + ' frame ' + String(frame).padStart(6, '0');
      requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
  </script>
</body>
</html>`
}
