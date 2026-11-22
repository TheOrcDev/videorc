#!/usr/bin/env node
// Plan 258 S0: score person mattes against a ground-truth matte (from a green
// screen key) at a common 480x270 grid.
//
//   node analyze-mattes.mjs --gt gt-480.gray --out scores.json \
//     [--ignore "x0,y0,x1,y1;..."]   (fractions of the frame; e.g. the mic arm)
//     run-name=path.gray:WxH [...]
//
// Metrics per run (over non-ignored pixels):
//   iou        IoU of matte>=0.5 vs gt>=0.5
//   mae        mean |matte-gt| (0..1)
//   edgeMae    mean |matte-gt| inside a ±4 px (±16 px at 1080p) band around the gt edge
//   softPct    share of band pixels where 0.1 < matte < 0.9 (how soft the edge is)
//   excessDelta  mean |(m_t - m_t-1) - (g_t - g_t-1)| in the band: change the real
//                motion does not explain (temporal instability), 0..1
//   leakPct    background leak: share of gt-background pixels outside the band that
//              the matte keeps as person (>=0.5), i.e. room shown unblurred; plus the
//              p99 per-frame value (a bad frame matters more than the average)
//   lossPct    share of gt-person pixels outside the band the matte drops (<0.5)
//   --ema A    smooth each run in time first (m = A*m + (1-A)*previous), as S3 plans
//   flicker    pixels per frame per 1000 person pixels whose binarised matte flips
//              and flips back on the next frame (A-B-A) while the gt does not

import { execFileSync } from 'node:child_process'
import { existsSync, openSync, readSync, statSync, writeFileSync, closeSync } from 'node:fs'

const W = 480,
  H = 270,
  N = W * H
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

const valid = new Uint8Array(N).fill(1)
for (const rect of (opts.ignore ?? '').split(';').filter(Boolean)) {
  const [x0, y0, x1, y1] = rect.split(',').map(Number)
  for (let y = Math.floor(y0 * H); y < Math.ceil(y1 * H); y++)
    for (let x = Math.floor(x0 * W); x < Math.ceil(x1 * W); x++) valid[y * W + x] = 0
}

function resized(run) {
  const out = run.path.replace(/\.gray$/, '') + '.480.gray'
  if (!existsSync(out) || statSync(out).mtimeMs < statSync(run.path).mtimeMs) {
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      '-s',
      run.size,
      '-i',
      run.path,
      '-vf',
      `scale=${W}:${H}:flags=bilinear`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      '-y',
      out
    ])
  }
  return out
}

function band(g) {
  // Binary gt, then a 9x9 window (separable) that holds both classes.
  const b = new Uint8Array(N)
  for (let i = 0; i < N; i++) b[i] = g[i] >= 128 ? 1 : 0
  const r = 4
  const mx = new Uint8Array(N),
    mn = new Uint8Array(N)
  const tmx = new Uint8Array(N),
    tmn = new Uint8Array(N)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let a = 0,
        c = 1
      for (let k = -r; k <= r; k++) {
        const xx = Math.min(W - 1, Math.max(0, x + k))
        const v = b[y * W + xx]
        a |= v
        c &= v
      }
      tmx[y * W + x] = a
      tmn[y * W + x] = c
    }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let a = 0,
        c = 1
      for (let k = -r; k <= r; k++) {
        const yy = Math.min(H - 1, Math.max(0, y + k))
        a |= tmx[yy * W + x]
        c &= tmn[yy * W + x]
      }
      mx[y * W + x] = a
      mn[y * W + x] = c
    }
  const out = new Uint8Array(N)
  for (let i = 0; i < N; i++) out[i] = mx[i] !== mn[i] && valid[i] ? 1 : 0
  return out
}

const ema = Number(opts.ema ?? 0)
const emaBuf = new Float32Array(N)
const gtFd = openSync(opts.gt, 'r')
const frames = Math.floor(statSync(opts.gt).size / N)
const results = {}
for (const run of runs) {
  const path = resized(run)
  const fd = openSync(path, 'r')
  const n = Math.min(frames, Math.floor(statSync(path).size / N))
  const g = new Uint8Array(N),
    m = new Uint8Array(N)
  const pg = new Uint8Array(N),
    pm = new Uint8Array(N)
  const ppm = new Uint8Array(N),
    ppg = new Uint8Array(N)
  let inter = 0,
    uni = 0,
    absSum = 0,
    cnt = 0,
    edgeAbs = 0,
    edgeCnt = 0,
    soft = 0
  let excess = 0,
    excessCnt = 0,
    flick = 0,
    personPx = 0
  let leak = 0,
    bgCore = 0,
    loss = 0,
    fgCore = 0
  const leakPerFrame = []
  for (let f = 0; f < n; f++) {
    readSync(gtFd, g, 0, N, f * N)
    readSync(fd, m, 0, N, f * N)
    if (ema > 0 && f > 0)
      for (let i = 0; i < N; i++) {
        emaBuf[i] = ema * m[i] + (1 - ema) * emaBuf[i]
        m[i] = Math.round(emaBuf[i])
      }
    else if (ema > 0) for (let i = 0; i < N; i++) emaBuf[i] = m[i]
    const bd = band(g)
    let fl = 0,
      fb = 0
    for (let i = 0; i < N; i++) {
      if (!valid[i]) continue
      if (!bd[i]) {
        if (g[i] < 128) {
          fb++
          if (m[i] >= 128) fl++
        } else {
          fgCore++
          if (m[i] < 128) loss++
        }
      }
      const gb = g[i] >= 128,
        mb = m[i] >= 128
      if (gb && mb) inter++
      if (gb || mb) uni++
      if (gb) personPx++
      const d = Math.abs(m[i] - g[i]) / 255
      absSum += d
      cnt++
      if (bd[i]) {
        edgeAbs += d
        edgeCnt++
        if (m[i] > 25 && m[i] < 230) soft++
        if (f > 0) {
          excess += Math.abs(m[i] - pm[i] - (g[i] - pg[i])) / 255
          excessCnt++
        }
      }
      if (f > 1) {
        const a = ppm[i] >= 128,
          b = pm[i] >= 128
        const ga = ppg[i] >= 128,
          gb2 = pg[i] >= 128
        if (a !== b && a === mb && ga === gb2 && gb2 === gb) flick++
      }
    }
    leak += fl
    bgCore += fb
    leakPerFrame.push(fb ? (100 * fl) / fb : 0)
    ppm.set(pm)
    ppg.set(pg)
    pm.set(m)
    pg.set(g)
  }
  closeSync(fd)
  results[run.name] = {
    frames: n,
    iou: inter / uni,
    mae: absSum / cnt,
    edgeMae: edgeAbs / edgeCnt,
    softPct: (100 * soft) / edgeCnt,
    excessDelta: excess / excessCnt,
    leakPct: (100 * leak) / bgCore,
    leakP99Pct: [...leakPerFrame].sort((a, b) => a - b)[
      Math.floor(0.99 * (leakPerFrame.length - 1))
    ],
    leakMaxPct: Math.max(...leakPerFrame),
    lossPct: (100 * loss) / fgCore,
    flicker: ((1000 * flick) / Math.max(1, personPx)) * (n / Math.max(1, n - 2))
  }
  const r = results[run.name]
  console.log(
    `${run.name}: IoU ${r.iou.toFixed(4)} MAE ${r.mae.toFixed(4)} edgeMAE ${r.edgeMae.toFixed(4)} soft ${r.softPct.toFixed(1)}% excessΔ ${r.excessDelta.toFixed(4)} flicker ${r.flicker.toFixed(3)} leak ${r.leakPct.toFixed(3)}% (p99 ${r.leakP99Pct.toFixed(2)}%, max ${r.leakMaxPct.toFixed(2)}%) loss ${r.lossPct.toFixed(3)}%`
  )
}
if (opts.out)
  writeFileSync(
    opts.out,
    JSON.stringify({ grid: `${W}x${H}`, ignore: opts.ignore ?? '', results }, null, 1)
  )
