import { execFile } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export function hasTerminal() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

export function requireTerminal(what) {
  if (!hasTerminal()) {
    throw new Error(
      `${what} needs a terminal for hidden input. Run it in Terminal.app, or use --from-clipboard / --client-json (they work from Claude Code's ! prompt).`
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

export async function readClipboard() {
  const { stdout } = await execFileAsync('pbpaste', [], { maxBuffer: 64 * 1024 })
  return stdout.trim()
}

// Called after a key is stored, so it does not linger on the clipboard.
export function clearClipboard() {
  return new Promise((resolve, reject) => {
    const child = execFile('pbcopy', [], (error) => (error ? reject(error) : resolve()))
    child.stdin.end('')
  })
}
