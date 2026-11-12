// Plays the system-audio smokes' stimulus WAVs through the default output
// (issue #1088): `afplay` on macOS, a PowerShell `Media.SoundPlayer` on
// Windows. The owner's volume, mute and output device are never touched.
//
// On Windows a cold `powershell.exe` takes 0.3 to 1 s to start, which would
// eat most of the gates' late allowance, so every player is armed ahead: it
// loads its WAV, prints `ready`, and plays the moment it reads a line on
// stdin (the explicit trigger the backend's live capture tests use). `play`
// hands out an armed player and arms the next one for that WAV.
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { createInterface } from 'node:readline'

/** PowerShell single-quoted string literal. */
export function powershellQuote(text) {
  return `'${String(text).replaceAll("'", "''")}'`
}

/**
 * The PowerShell script for one Windows player. `loop` plays the WAV over and
 * over until stdin closes (the keep-alive); otherwise it plays it once after
 * the trigger line.
 */
export function windowsPlayerScript(wavPath, { loop = false } = {}) {
  const load = `$p = New-Object Media.SoundPlayer ${powershellQuote(wavPath)}; $p.Load(); [Console]::Out.WriteLine('ready'); [Console]::Out.Flush()`
  return loop
    ? `${load}; $p.PlayLooping(); $null = [Console]::In.ReadToEnd(); $p.Stop()`
    : `${load}; $null = [Console]::In.ReadLine(); $p.PlaySync()`
}

export function windowsPlayerCommand(wavPath, options) {
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', windowsPlayerScript(wavPath, options)]
  }
}

/**
 * @param {{ platform?: NodeJS.Platform, log?: (message: string) => void, readyTimeoutMs?: number }} [options]
 */
export function createTonePlayer({
  platform = process.platform,
  log = () => {},
  readyTimeoutMs = 20000
} = {}) {
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new Error(`no tone player for ${platform}`)
  }
  const children = new Set()
  const playing = new Set()
  const armed = new Map()
  let keepAlive = null
  let closed = false

  function track(child, label) {
    children.add(child)
    child.on('exit', () => children.delete(child))
    child.on('error', (error) => log(`${label} failed: ${error.message}`))
    return child
  }

  function spawnWindowsPlayer(wavPath, options) {
    const { command, args } = windowsPlayerCommand(wavPath, options)
    const child = track(
      spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }),
      'tone player'
    )
    const ready = new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(
        () =>
          rejectReady(new Error(`tone player for ${wavPath} not ready in ${readyTimeoutMs} ms`)),
        readyTimeoutMs
      )
      const lines = createInterface({ input: child.stdout })
      lines.on('line', (line) => {
        if (line.trim() !== 'ready') return
        clearTimeout(timer)
        resolveReady()
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        rejectReady(new Error(`tone player for ${wavPath} exited (${code}) before it was ready`))
      })
    })
    // An unready player that is killed later must not raise an unhandled rejection.
    ready.catch(() => {})
    return { child, ready }
  }

  async function arm(wavPath) {
    if (platform !== 'win32' || armed.has(wavPath)) return
    const player = spawnWindowsPlayer(wavPath)
    armed.set(wavPath, player)
    await player.ready
  }

  return {
    /** Arms one player per WAV (Windows); resolves once each is loaded. */
    async prepare(wavPaths) {
      await Promise.all(wavPaths.map((wavPath) => arm(wavPath)))
    },

    /** Starts the WAV now; returns the wall time of the start request. */
    play(wavPath) {
      if (platform === 'darwin') {
        const at = performance.now()
        const child = track(spawn('afplay', [wavPath], { stdio: 'ignore' }), 'afplay')
        playing.add(child)
        child.on('exit', () => playing.delete(child))
        return at
      }
      const player = armed.get(wavPath)
      if (!player) throw new Error(`no armed tone player for ${wavPath}; call prepare first`)
      armed.delete(wavPath)
      playing.add(player.child)
      player.child.on('exit', () => playing.delete(player.child))
      const at = performance.now()
      player.child.stdin.end('\n')
      // The next play of this WAV gets a fresh, already-loaded player.
      void arm(wavPath).catch((error) => {
        if (!closed) log(error.message)
      })
      return at
    },

    /**
     * Plays digital silence for the whole run so the output device stays
     * awake: a cold device delayed a sound's start by up to ~1.9 s.
     */
    async startKeepAlive(wavPath) {
      if (platform === 'darwin') {
        const loop = () => {
          if (keepAlive?.stopped) return
          const child = track(spawn('afplay', [wavPath], { stdio: 'ignore' }), 'keep-alive afplay')
          keepAlive = { child, stopped: false }
          child.on('exit', () => {
            if (keepAlive && !keepAlive.stopped && keepAlive.child === child) loop()
          })
        }
        loop()
        return
      }
      const player = spawnWindowsPlayer(wavPath, { loop: true })
      keepAlive = { child: player.child, stopped: false }
      await player.ready
    },

    /** Stops the tones still playing; armed players stay armed. */
    stopPlayers() {
      for (const child of playing) child.kill()
      playing.clear()
    },

    /** Stops every child this player spawned, the keep-alive included. */
    stopAll() {
      closed = true
      if (keepAlive) {
        keepAlive.stopped = true
        keepAlive.child.stdin?.end()
      }
      for (const child of children) child.kill()
      children.clear()
      playing.clear()
      armed.clear()
    }
  }
}
