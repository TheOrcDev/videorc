import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
const source = readFileSync(
  new URL('../../crates/videorc-backend/src/cloud_clips.rs', import.meta.url),
  'utf8'
)
// Windows only runs a file with no extension by adding .com/.exe, so a bare
// `helper` is ENOENT there (rustc writes exactly the -o name).
const executable = (name) => (process.platform === 'win32' ? `${name}.exe` : name)

// rustc's FIRST run on a cold machine costs far more than compiling the helper.
// On the Windows runner (toolchain already installed, nothing downloads) it
// goes through the rustup proxy, which resolves rust-toolchain.toml, loads the
// ~100 MB rustc_driver DLL for the first time (Defender scans it), asks the
// Visual Studio installer where the MSVC linker is, and runs link.exe cold,
// while the other test files use every core. PR #1621's Windows JS gates spent
// 17.2 s on it and PR #1608's passed the old shared 30 s budget (ETIMEDOUT).
// So the toolchain warms up once, here, with its own budget and message; the
// helper then compiles with the real rustc (not the proxy) under 30 s.
const WARM_UP_BUDGET_MS = 120_000
const COMPILE_BUDGET_MS = 30_000
const RUN_BUDGET_MS = 5_000
let rustc = 'rustc'
let warmUp = ''

function run(file, args, budget, what) {
  const started = performance.now()
  try {
    return execFileSync(file, args, { timeout: budget, encoding: 'utf8' })
  } catch (error) {
    if (error.code === 'ETIMEDOUT') {
      throw new Error(`${what} took longer than ${budget / 1000} s (${file})`, { cause: error })
    }
    throw error
  } finally {
    warmUp += ` ${what}: ${Math.round(performance.now() - started)} ms;`
  }
}

before(() => {
  const sysroot = run(
    'rustc',
    ['--print', 'sysroot'],
    WARM_UP_BUDGET_MS,
    'locating rustc through rustup (cold toolchain warm-up)'
  ).trim()
  rustc = join(sysroot, 'bin', executable('rustc'))
  const folder = mkdtempSync(join(tmpdir(), 'videorc-rustc-warm-up-'))
  try {
    const path = join(folder, 'empty.rs')
    writeFileSync(path, 'fn main() {}\n')
    run(
      rustc,
      ['--edition', '2024', path, '-o', join(folder, executable('empty'))],
      WARM_UP_BUDGET_MS,
      'compiling and linking an empty program (cold rustc and linker warm-up)'
    )
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test('actual trim argument helper compiles independently and decodes both lanes without seeking a keyframe', (t) => {
  const start = source.indexOf('pub fn trim_args('),
    end = source.indexOf('\nasync fn ffmpeg_job', start)
  assert.ok(start >= 0 && end > start)
  const folder = mkdtempSync(join(tmpdir(), 'videorc-clip-helper-'))
  try {
    const path = join(folder, 'helper.rs'),
      binary = join(folder, executable('helper'))
    writeFileSync(
      path,
      `use std::{path::Path,ffi::OsString};\n${source.slice(start, end)}\nfn main(){let a=trim_args(Path::new("index.m3u8"),Path::new("clip.part"),1250.0,30000.0);let a:Vec<_>=a.iter().map(|s|s.to_str().unwrap()).collect();assert!(!a.contains(&"copy"));assert!(!a.contains(&"-ss"));assert!(a.contains(&"[0:v:0]trim=start=1.250000:duration=30.000000,setpts=PTS-STARTPTS[v];[0:a:0]atrim=start=1.250000:duration=30.000000,asetpts=PTS-STARTPTS[a]"));assert!(a.windows(2).any(|w|w==["-protocol_whitelist","file"]));assert!(a.windows(2).any(|w|w==["-fs","134217728"]));}`
    )
    run(rustc, ['--edition', '2024', path, '-o', binary], COMPILE_BUDGET_MS, 'compiling the helper')
    run(binary, [], RUN_BUDGET_MS, 'running the helper')
  } finally {
    t.diagnostic(`rustc timings:${warmUp}`)
    rmSync(folder, { recursive: true, force: true })
  }
})
test('additive local journal schema preserves historical session starts and is idempotent', () => {
  const sql = readFileSync(
    new URL('../../crates/videorc-backend/src/storage/cloud_clips.sql', import.meta.url),
    'utf8'
  )
  const output = execFileSync(
    'python3',
    [
      '-c',
      `import sqlite3,sys\nc=sqlite3.connect(':memory:')\nc.execute('CREATE TABLE sessions(id TEXT PRIMARY KEY, started_at TEXT)')\nc.execute("INSERT INTO sessions VALUES ('old','2020-01-01')")\ns=sys.stdin.read()\nc.executescript(s)\nc.executescript(s)\nassert c.execute('SELECT started_at FROM sessions').fetchone()[0]=='2020-01-01'\nc.execute("INSERT INTO cloud_program_clips VALUES ('clip_one','{}')")\nassert c.execute('SELECT count(*) FROM cloud_program_clips').fetchone()[0]==1\nprint('ok')`
    ],
    { input: sql, encoding: 'utf8' }
  )
  assert.equal(output.trim(), 'ok')
})
