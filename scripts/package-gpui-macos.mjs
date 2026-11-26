#!/usr/bin/env node
// Plan 260 S5.1a: builds the GPUI app's macOS bundle, UNSIGNED, for local
// runs. No signing, notarising, uploading or release workflow: those are the
// owner's.
//
//   pnpm package:gpui:macos [-- --binaries DIR] [--out DIR] [--version X.Y.Z]
//                              [--bridge FILE] [--ffmpeg DIR]
//
// --binaries  the folder with `Videorc` and `videorc-backend` (default
//             target/release; a sentinel build's folder works as is)
// --out       where `Videorc.app` goes (default target/gpui-package/macos)
// --version   the bundle's version (default apps/desktop/package.json's)
// --bridge    Connect an agent's `videorc-mcp` (default: beside the
//             binaries, else target/release); left out with a warning when
//             missing
// --ffmpeg    the bundled FFmpeg folder (default vendor/ffmpeg/current);
//             left out with a warning when missing (the backend then uses
//             the ffmpeg on PATH)
//
// Run it: `<out>/Videorc.app/Contents/MacOS/Videorc --profile <dir>`
// (an isolated profile), or `open <out>/Videorc.app`.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  APP_NAME,
  BACKEND,
  BRIDGE,
  EXECUTABLE,
  bundleCopies,
  infoPlistValues,
  matchesFilter,
  plistXml
} from './lib/gpui-macos-bundle.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    const [flag, inline] = arg.split('=', 2)
    const value = () => {
      if (inline !== undefined) return inline
      index += 1
      if (index >= argv.length) throw new Error(`${flag} needs a value`)
      return argv[index]
    }
    switch (flag) {
      case '--binaries':
      case '--out':
      case '--version':
      case '--bridge':
      case '--ffmpeg':
        options[flag.slice(2)] = value()
        break
      case '-h':
      case '--help':
        options.help = true
        break
      default:
        throw new Error(`unknown argument ${arg}`)
    }
  }
  return options
}

function expandHome(file) {
  return file.startsWith('~/') ? path.join(process.env.HOME ?? '', file.slice(2)) : file
}

/** The first four bytes of a 64-bit Mach-O, either byte order, or a fat binary. */
function isMachO(file) {
  const handle = fs.openSync(file, 'r')
  try {
    const magic = Buffer.alloc(4)
    fs.readSync(handle, magic, 0, 4, 0)
    const word = magic.readUInt32BE(0)
    return [0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(word)
  } finally {
    fs.closeSync(handle)
  }
}

function walk(dir, base = dir) {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walk(full, base))
    } else if (entry.isFile()) {
      files.push(path.relative(base, full).split(path.sep).join('/'))
    }
  }
  return files
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  fs.chmodSync(to, fs.statSync(from).mode & 0o777)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(
      'pnpm package:gpui:macos [-- --binaries DIR] [--out DIR] [--version X.Y.Z] [--bridge FILE] [--ffmpeg DIR]'
    )
    return
  }
  if (process.platform !== 'darwin') {
    throw new Error('the macOS bundle is built on macOS')
  }

  const binaries = path.resolve(expandHome(options.binaries ?? path.join(root, 'target/release')))
  const out = path.resolve(expandHome(options.out ?? path.join(root, 'target/gpui-package/macos')))
  const version =
    options.version ??
    JSON.parse(fs.readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8')).version
  const bridge = path.resolve(
    expandHome(
      options.bridge ??
        [path.join(binaries, BRIDGE), path.join(root, 'target/release', BRIDGE)].find((file) =>
          fs.existsSync(file)
        ) ??
        path.join(binaries, BRIDGE)
    )
  )
  const ffmpeg = path.resolve(
    expandHome(options.ffmpeg ?? path.join(root, 'vendor/ffmpeg/current'))
  )

  const values = infoPlistValues({ version })
  const app = path.join(out, `${APP_NAME}.app`)
  const partial = path.join(out, `${APP_NAME}.app.partial`)
  fs.rmSync(partial, { recursive: true, force: true })
  const contents = path.join(partial, 'Contents')

  const warnings = []
  for (const copy of bundleCopies({ root, binaries, bridge, ffmpeg })) {
    if (!fs.existsSync(copy.from)) {
      if (copy.required) {
        throw new Error(`missing ${copy.from} (for Contents/${copy.to})`)
      }
      warnings.push(`left out Contents/${copy.to}: ${copy.from} is missing`)
      continue
    }
    const target = path.join(contents, copy.to)
    if (!copy.files) {
      copyFile(copy.from, target)
      continue
    }
    const taken = walk(copy.from).filter((relative) =>
      matchesFilter(relative, copy.files, copy.exclude)
    )
    if (taken.length === 0 && copy.required) {
      throw new Error(`nothing to copy from ${copy.from} (for Contents/${copy.to})`)
    }
    for (const relative of taken) {
      copyFile(
        path.join(copy.from, ...relative.split('/')),
        path.join(target, ...relative.split('/'))
      )
    }
  }

  for (const name of [EXECUTABLE, BACKEND, BRIDGE]) {
    const file = path.join(contents, 'MacOS', name)
    if (fs.existsSync(file) && !isMachO(file)) {
      throw new Error(`Contents/MacOS/${name} is not a macOS executable`)
    }
  }

  const plist = path.join(contents, 'Info.plist')
  fs.writeFileSync(plist, plistXml(values))
  fs.writeFileSync(path.join(contents, 'PkgInfo'), 'APPL????')
  execFileSync('/usr/bin/plutil', ['-lint', plist], { stdio: 'pipe' })

  fs.rmSync(app, { recursive: true, force: true })
  fs.renameSync(partial, app)

  for (const warning of warnings) console.warn(`[package-gpui-macos] ${warning}`)
  console.log(`[package-gpui-macos] ${app} (${values.CFBundleShortVersionString}, unsigned)`)
  console.log(`[package-gpui-macos] binaries from ${binaries}`)
  console.log(
    `[package-gpui-macos] run: "${path.join(app, 'Contents/MacOS', EXECUTABLE)}" --profile <dir>`
  )
}

try {
  main()
} catch (error) {
  console.error(`[package-gpui-macos] ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
}
