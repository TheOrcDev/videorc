import { spawn } from 'node:child_process'

// Plan 178 U5. Every shell-out of live:install goes through a runner with this
// shape, so the unit tests can swap in a fake:
//   runner(command, args, { timeoutMs, cwd }) -> Promise<{ code, stdout, stderr }>
// A non-zero exit resolves (callers read `code`); only a spawn failure rejects.
// `cwd` is for the Linux AppImage, which extracts itself into the current
// directory (plan 179).
export function createRunner({ defaultTimeoutMs = 120_000 } = {}) {
  return function run(command, args, { timeoutMs = defaultTimeoutMs, cwd } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      const stdout = []
      const stderr = []
      child.stdout.on('data', (chunk) => stdout.push(chunk))
      child.stderr.on('data', (chunk) => stderr.push(chunk))
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        resolve({
          code: code ?? (signal ? 128 : 1),
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8')
        })
      })
    })
  }
}

// A refusal is an expected outcome with a stable code (tests and the run
// manifest key on it), not a crash.
export class InstallRefusal extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'InstallRefusal'
    this.code = code
  }
}

export function refuse(code, message) {
  throw new InstallRefusal(code, message)
}
