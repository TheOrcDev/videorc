#!/usr/bin/env node
// Plan 260 S5.1c: builds the GPUI app's Linux package, UNSIGNED, for local
// runs. No signing, AppImage runtime pick, uploading or release workflow:
// those are the owner's / L5 on ogre. This script only builds the runnable
// directory (AppDir-shaped) that mirrors S5.1a's unsigned .app.
//
//   pnpm package:gpui:linux [-- --binaries DIR] [--out DIR] [--version X.Y.Z]
//                              [--bridge FILE] [--ffmpeg DIR]
//
// --binaries  the folder with Linux ELF `Videorc` and `videorc-backend`
//             (default target/release; a CI `gpui-linux-x64` extract works)
// --out       where `Videorc/` goes (default target/gpui-package/linux)
// --version   the package's version (default apps/desktop/package.json's)
// --bridge    Connect an agent's `videorc-mcp` (default: beside the
//             binaries, else target/release); left out with a warning when
//             missing
// --ffmpeg    the bundled FFmpeg folder (default vendor/ffmpeg/linux-x64);
//             left out with a warning when missing (the backend then uses
//             the ffmpeg on PATH)
//
// Assembling works on any host that can copy files. The binaries must be
// Linux ELF (refuses Mach-O / PE). Launch proof needs Linux:
//   <out>/Videorc/Videorc --profile <dir>
// or, once wrapped on ogre: appimagetool <out>/Videorc

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  APP_NAME,
  APP_RUN,
  BACKEND,
  BRIDGE,
  DESKTOP_FILE,
  EXECUTABLE,
  PACKAGE_DIR,
  appRunScript,
  desktopEntryText,
  isElf,
  isPackageVersion,
  matchesFilter,
  packageCopies
} from './lib/gpui-linux-package.mjs'

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
      'pnpm package:gpui:linux [-- --binaries DIR] [--out DIR] [--version X.Y.Z] [--bridge FILE] [--ffmpeg DIR]'
    )
    return
  }

  const binaries = path.resolve(expandHome(options.binaries ?? path.join(root, 'target/release')))
  const out = path.resolve(expandHome(options.out ?? path.join(root, 'target/gpui-package/linux')))
  const version =
    options.version ??
    JSON.parse(fs.readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8')).version
  if (!isPackageVersion(version)) {
    throw new Error(`not a release version: ${JSON.stringify(version)}`)
  }
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
    expandHome(options.ffmpeg ?? path.join(root, 'vendor/ffmpeg/linux-x64'))
  )

  const packageRoot = path.join(out, PACKAGE_DIR)
  const partial = path.join(out, `${PACKAGE_DIR}.partial`)
  fs.rmSync(partial, { recursive: true, force: true })
  fs.mkdirSync(partial, { recursive: true })

  const warnings = []
  for (const copy of packageCopies({ root, binaries, bridge, ffmpeg })) {
    if (!fs.existsSync(copy.from)) {
      if (copy.required) {
        throw new Error(`missing ${copy.from} (for ${copy.to})`)
      }
      warnings.push(`left out ${copy.to}: ${copy.from} is missing`)
      continue
    }
    const target = path.join(partial, copy.to)
    if (!copy.files) {
      copyFile(copy.from, target)
      continue
    }
    const taken = walk(copy.from).filter((relative) =>
      matchesFilter(relative, copy.files, copy.exclude)
    )
    if (taken.length === 0 && copy.required) {
      throw new Error(`nothing to copy from ${copy.from} (for ${copy.to})`)
    }
    for (const relative of taken) {
      copyFile(
        path.join(copy.from, ...relative.split('/')),
        path.join(target, ...relative.split('/'))
      )
    }
  }

  for (const name of [EXECUTABLE, BACKEND, BRIDGE]) {
    const file = path.join(partial, name)
    if (fs.existsSync(file) && !isElf(file)) {
      throw new Error(`${name} is not a Linux ELF executable (need Linux binaries)`)
    }
  }

  fs.writeFileSync(path.join(partial, DESKTOP_FILE), desktopEntryText({ version }))
  const appRun = path.join(partial, APP_RUN)
  fs.writeFileSync(appRun, appRunScript())
  fs.chmodSync(appRun, 0o755)

  fs.rmSync(packageRoot, { recursive: true, force: true })
  fs.renameSync(partial, packageRoot)

  for (const warning of warnings) console.warn(`[package-gpui-linux] ${warning}`)
  console.log(`[package-gpui-linux] ${packageRoot} (${version}, unsigned)`)
  console.log(`[package-gpui-linux] binaries from ${binaries}`)
  console.log(
    `[package-gpui-linux] run on Linux: "${path.join(packageRoot, EXECUTABLE)}" --profile <dir>`
  )
  console.log(
    `[package-gpui-linux] AppImage wrap (ogre): appimagetool "${packageRoot}" "${path.join(out, `${APP_NAME}-${version}-linux-x64.AppImage`)}"`
  )
}

try {
  main()
} catch (error) {
  console.error(`[package-gpui-linux] ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
}
