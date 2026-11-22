#!/usr/bin/env node
// Plan 258 S0: by-eye edge sheets. For chosen frames, composite each engine's
// matte as the product would (strong blur behind the person) and crop the hair
// and hand regions side by side.
//
//   node edge-sheet.mjs --clip clip.mp4 --out-dir DIR --frames 120,900 \
//     --crops "hair=640,0,640,360;hands=300,300,640,540" name=path.gray:WxH [...]
// Tiles run left to right, top to bottom: the source crop, then each run in
// argument order (this ffmpeg build has no drawtext, so tiles carry no labels).

import { execFileSync } from 'node:child_process'
import { mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const opts = {},
  runs = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) opts[argv[i].slice(2)] = argv[++i]
  else {
    const [name, rest] = argv[i].split('=')
    const [path, size] = rest.split(':')
    runs.push({ name, path, size })
  }
}
mkdirSync(opts['out-dir'], { recursive: true })
const ff = (a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...a, '-y'])
const crops = opts.crops.split(';').map((c) => {
  const [k, v] = c.split('=')
  const [x, y, w, h] = v.split(',').map(Number)
  return { k, x, y, w, h }
})

for (const frame of opts.frames.split(',').map(Number)) {
  const dir = join(opts['out-dir'], `f${frame}`)
  mkdirSync(dir, { recursive: true })
  const src = join(dir, 'frame.png')
  ff(['-i', opts.clip, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', src])
  const tiles = {}
  for (const c of crops) tiles[c.k] = [join(dir, `src-${c.k}.png`)]
  for (const c of crops) ff(['-i', src, '-vf', `crop=${c.w}:${c.h}:${c.x}:${c.y}`, tiles[c.k][0]])
  for (const run0 of runs) {
    // A path with {f} is one file per frame (full-size keep-frames); otherwise a sequence.
    const run = { ...run0, path: run0.path.replaceAll('{f}', String(frame)) }
    const [w, h] = run.size.split('x').map(Number)
    const buf = Buffer.alloc(w * h)
    readSync(
      openSync(run.path, 'r'),
      buf,
      0,
      w * h,
      statSync(run.path).size === w * h ? 0 : frame * w * h
    )
    const raw = join(dir, `${run.name}.raw`)
    writeFileSync(raw, buf)
    const comp = join(dir, `${run.name}.png`)
    // person * m + blurred * (1 - m); matte scaled to the frame with bilinear.
    ff([
      '-i',
      src,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      '-s',
      run.size,
      '-i',
      raw,
      '-filter_complex',
      `[1]scale=1920:1080:flags=bilinear,format=gray[m];[0]split[a][b];[b]boxblur=40:2[bg];[a][m]alphamerge[fg];[bg][fg]overlay=format=auto`,
      comp
    ])
    for (const c of crops) {
      const t = join(dir, `${run.name}-${c.k}.png`)
      ff(['-i', comp, '-vf', `crop=${c.w}:${c.h}:${c.x}:${c.y}`, t])
      tiles[c.k].push(t)
    }
  }
  for (const c of crops) {
    const ins = tiles[c.k].flatMap((t) => ['-i', t])
    const cols = Math.min(3, tiles[c.k].length)
    const rows = Math.ceil(tiles[c.k].length / cols)
    const layout = tiles[c.k]
      .map((_, i) => `${(i % cols) * c.w}_${Math.floor(i / cols) * c.h}`)
      .join('|')
    ff([
      ...ins,
      '-filter_complex',
      `${tiles[c.k].map((_, i) => `[${i}]`).join('')}xstack=inputs=${tiles[c.k].length}:layout=${layout}:fill=black`,
      join(opts['out-dir'], `edge-f${frame}-${c.k}.png`)
    ])
    console.log(join(opts['out-dir'], `edge-f${frame}-${c.k}.png`), `${cols * c.w}x${rows * c.h}`)
  }
}
