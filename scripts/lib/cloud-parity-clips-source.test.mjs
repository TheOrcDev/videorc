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
test('actual trim argument helper compiles independently and decodes both lanes without seeking a keyframe', () => {
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
      `use std::{path::Path,ffi::OsString};\n${source.slice(start, end)}\nfn main(){let v=["-c:v","libopenh264","-pix_fmt","yuv420p"].map(String::from);let a=trim_args(Path::new("index.m3u8"),Path::new("clip.part"),1250.0,30000.0,&v);let a:Vec<_>=a.iter().map(|s|s.to_str().unwrap()).collect();assert!(!a.contains(&"copy"));assert!(!a.contains(&"libx264"));assert!(a.windows(2).any(|w|w==["-c:v","libopenh264"]));assert!(a.windows(2).any(|w|w==["-map","[a]"]));assert!(!a.contains(&"-ss"));assert!(a.contains(&"[0:v:0]trim=start=1.250000:duration=30.000000,setpts=PTS-STARTPTS[v];[0:a:0]atrim=start=1.250000:duration=30.000000,asetpts=PTS-STARTPTS[a]"));assert!(a.windows(2).any(|w|w==["-protocol_whitelist","file"]));assert!(a.windows(2).any(|w|w==["-fs","134217728"]));}`
    )
    execFileSync('rustc', ['--edition', '2024', path, '-o', binary], { timeout: 30000 })
    execFileSync(binary, [], { timeout: 5000 })
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
