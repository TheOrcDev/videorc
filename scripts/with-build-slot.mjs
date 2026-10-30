import { spawn } from 'node:child_process'
import { withBuildSlot } from './lib/host-lock.mjs'

const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error('Usage: node scripts/with-build-slot.mjs <command> [args...]')
  process.exitCode = 1
} else {
  try {
    const result = await withBuildSlot(
      () =>
        new Promise((resolve, reject) => {
          const child = spawn(command, args, { stdio: 'inherit', env: process.env })
          const forward = (signal) => child.kill(signal)
          const interrupt = () => forward('SIGINT')
          const terminate = () => forward('SIGTERM')
          process.on('SIGINT', interrupt)
          process.on('SIGTERM', terminate)
          const cleanup = () => {
            process.off('SIGINT', interrupt)
            process.off('SIGTERM', terminate)
          }
          child.once('error', (error) => {
            cleanup()
            reject(error)
          })
          child.once('exit', (code, signal) => {
            cleanup()
            resolve({ code, signal })
          })
        })
    )
    if (result.signal) process.kill(process.pid, result.signal)
    else process.exitCode = result.code ?? 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
