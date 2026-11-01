import { execFile } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { promisify } from 'node:util'

import { labSessionEnv } from './linux-desktop.mjs'
import { isLinux } from './platform.mjs'

const execFileAsync = promisify(execFile)

export function hasTerminal() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

export function requireTerminal(what) {
  if (!hasTerminal()) {
    throw new Error(
      `${what} needs a terminal for hidden input. Run it in a real terminal (Terminal.app on macOS), or use --from-clipboard / --client-json (they work from Claude Code's ! prompt).`
    )
  }
}

export async function promptVisible(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

// Raw-mode read: nothing typed or pasted is echoed. Enter ends, Backspace
// deletes, Ctrl-C aborts.
export function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin
    process.stdout.write(question)
    let value = ''
    const finish = (error) => {
      input.setRawMode(false)
      input.pause()
      input.removeListener('data', onData)
      process.stdout.write('\n')
      if (error) reject(error)
      else resolve(value.trim())
    }
    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          finish()
          return
        }
        if (char === '\u0003') {
          finish(new Error('Cancelled.'))
          return
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1)
          continue
        }
        if (char >= ' ') value += char
      }
    }
    input.setRawMode(true)
    input.resume()
    input.on('data', onData)
  })
}

// Plan 179: on Linux the clipboard is Wayland's (wl-clipboard), else X11's
// (xclip). Over SSH the session's variables come from labSessionEnv().
export function clipboardCommands(platform = process.platform, sessionEnv = {}) {
  if (!isLinux(platform)) {
    return { read: ['pbpaste', []], clear: ['pbcopy', []] }
  }
  return sessionEnv.WAYLAND_DISPLAY
    ? { read: ['wl-paste', ['--no-newline']], clear: ['wl-copy', ['--clear']] }
    : {
        read: ['xclip', ['-selection', 'clipboard', '-o']],
        clear: ['xclip', ['-selection', 'clipboard', '-i']]
      }
}

async function clipboardEnv(platform) {
  if (!isLinux(platform)) return { commands: clipboardCommands(platform), env: process.env }
  const sessionEnv = await labSessionEnv()
  return {
    commands: clipboardCommands(platform, sessionEnv),
    env: { ...process.env, ...sessionEnv }
  }
}

export async function readClipboard({ platform = process.platform } = {}) {
  const { commands, env } = await clipboardEnv(platform)
  const [command, args] = commands.read
  const { stdout } = await execFileAsync(command, args, { maxBuffer: 64 * 1024, env })
  return stdout.trim()
}

// Called after a key is stored, so it does not linger on the clipboard.
export async function clearClipboard({ platform = process.platform } = {}) {
  const { commands, env } = await clipboardEnv(platform)
  const [command, args] = commands.clear
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { env }, (error) => (error ? reject(error) : resolve()))
    child.stdin.end('')
  })
}
