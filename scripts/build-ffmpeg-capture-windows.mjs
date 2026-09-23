import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32')
  throw new Error('Build the capture worker on Windows with MSYS2 UCRT64.')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const msys = process.env.VIDEORC_MSYS2_ROOT ?? 'C:\\msys64'
const bash = join(msys, 'usr', 'bin', 'bash.exe')
if (!existsSync(bash))
  throw new Error(
    'MSYS2 UCRT64 is required. Set VIDEORC_MSYS2_ROOT to an existing installation; install make, pkgconf, patch, GCC and NASM using the maintained CI recipe.'
  )
const result = spawnSync(
  bash,
  ['--login', '-c', 'exec /usr/bin/bash "$(cygpath -u "$VIDEORC_WORKER_RECIPE")"'],
  {
    cwd: repo,
    stdio: 'inherit',
    env: {
      ...process.env,
      MSYSTEM: 'UCRT64',
      CHERE_INVOKING: '1',
      VIDEORC_NODE_EXECUTABLE: process.execPath,
      VIDEORC_WORKER_RECIPE: join(repo, 'scripts', 'build-ffmpeg-capture-windows.sh')
    }
  }
)
if (result.error) throw result.error
process.exit(result.status ?? 1)
