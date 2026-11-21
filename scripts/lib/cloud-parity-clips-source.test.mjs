import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
const source = readFileSync(
  new URL('../../crates/videorc-backend/src/cloud_clips.rs', import.meta.url),
  'utf8'
)
// A cold `rustc` + link on a shared CI runner is slow, not a sign of a broken
// helper: GitHub's Windows runner took 15–27 s on green runs (and over 30 s on
// red ones) for what takes 0.3 s warm on a laptop, while `node --test` runs the
// other files alongside. The deadline only catches a hung compiler.
const RUSTC_DEADLINE_MS = 180_000,
  HELPER_DEADLINE_MS = 30_000
function runWithDeadline(file, args, timeout, what) {
  try {
    execFileSync(file, args, { timeout })
  } catch (error) {
    if (error.code === 'ETIMEDOUT')
      throw new Error(
        `${what} did not finish within ${timeout / 1000} s. This is the machine's cold toolchain or a hung process, not an assertion about trim_args.`,
        { cause: error }
      )
    throw error
  }
}
test('actual trim argument helper compiles independently and decodes both lanes without seeking a keyframe', (t) => {
  const start = source.indexOf('pub fn trim_args('),
    end = source.indexOf('\nasync fn ffmpeg_job', start)
  assert.ok(start >= 0 && end > start)
  const folder = mkdtempSync(join(tmpdir(), 'videorc-clip-helper-'))
  try {
    const path = join(folder, 'helper.rs'),
      // Windows only runs a file with no extension by adding .com/.exe, so a
      // bare `helper` is ENOENT there (rustc writes exactly the -o name).
      binary = join(folder, process.platform === 'win32' ? 'helper.exe' : 'helper')
    writeFileSync(
      path,
      `use std::{path::Path,ffi::OsString};\n${source.slice(start, end)}\nfn main(){let a=trim_args(Path::new("index.m3u8"),Path::new("clip.part"),1250.0,30000.0);let a:Vec<_>=a.iter().map(|s|s.to_str().unwrap()).collect();assert!(!a.contains(&"copy"));assert!(!a.contains(&"-ss"));assert!(a.contains(&"[0:v:0]trim=start=1.250000:duration=30.000000,setpts=PTS-STARTPTS[v];[0:a:0]atrim=start=1.250000:duration=30.000000,asetpts=PTS-STARTPTS[a]"));assert!(a.windows(2).any(|w|w==["-protocol_whitelist","file"]));assert!(a.windows(2).any(|w|w==["-fs","134217728"]));}`
    )
    const compileStart = performance.now()
    runWithDeadline(
      'rustc',
      ['--edition', '2024', path, '-o', binary],
      RUSTC_DEADLINE_MS,
      'rustc compiling the trim_args helper'
    )
    t.diagnostic(`rustc compiled the helper in ${Math.round(performance.now() - compileStart)} ms`)
    runWithDeadline(binary, [], HELPER_DEADLINE_MS, 'the compiled trim_args helper')
  } finally {
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
