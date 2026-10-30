#!/usr/bin/env node

// `pnpm ui:sync [item…] [--local [url-template]]` installs @videorc items with
// the shadcn CLI (every manifest item when none are named), puts back the
// files Videorc keeps (the manifest's keepLocal), formats what the CLI wrote
// with the repo's Prettier and prints what changed, package.json and the
// lockfile included.
//
// `pnpm ui:check [item…] [--local [url-template]]` (this script with --check)
// formats each manifest item's registry files the same way and fails when a
// local copy differs: synced files are edited in videorc-ui, never here.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

import * as prettier from 'prettier'

import {
  UI_APP_DIR,
  UI_MANIFEST_PATH,
  UI_NAMESPACE,
  changedPaths,
  componentsJsonWithTemplate,
  dependencyChanges,
  describeDependencyChange,
  findDrift,
  formattablePaths,
  itemsWithSyncedFiles,
  manifestWithItems,
  mergeItemFiles,
  parseUiArgs,
  parseUiManifest,
  registryItemFiles,
  registryItemUrl,
  registryLayout,
  registryTemplateFrom,
  resolveItemClosure,
  serializeUiManifest,
  shadcnAddArgs
} from './lib/ui-registry.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const APP = join(ROOT, UI_APP_DIR)
const COMPONENTS_JSON = 'components.json'
const FETCH_TIMEOUT_MS = 15_000
// What the CLI may write: the alias folders, the CSS, components.json, and
// package.json with the workspace lockfile through `pnpm add`.
const SNAPSHOT_DIRS = ['src']
const SNAPSHOT_FILES = [
  `${UI_APP_DIR}/package.json`,
  `${UI_APP_DIR}/components.json`,
  `${UI_APP_DIR}/tsconfig.json`,
  `${UI_APP_DIR}/tsconfig.web.json`,
  'package.json',
  'pnpm-lock.yaml'
]

const appPath = (path) => join(APP, ...path.split('/'))
const repoRelative = (path) => relative(ROOT, path).split(sep).join('/')

function readText(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function loadContext() {
  const manifestText = readText(join(ROOT, UI_MANIFEST_PATH))
  if (manifestText === null) throw new Error(`${UI_MANIFEST_PATH} is missing.`)
  const manifest = parseUiManifest(manifestText)
  const componentsJson = readJson(appPath(COMPONENTS_JSON))
  const tsconfig = readJson(appPath('tsconfig.json'))
  const layout = registryLayout(componentsJson, tsconfig.compilerOptions?.paths)
  return { manifest, componentsJson, layout }
}

function itemLoader(template) {
  const cache = new Map()
  return (name) => {
    if (!cache.has(name)) cache.set(name, fetchItem(registryItemUrl(template, name), name))
    return cache.get(name)
  }
}

async function fetchItem(url, name) {
  let response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (error) {
    const reason = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error)
    throw new RegistryUnreachable(
      `Could not reach the ${UI_NAMESPACE} registry at ${url} (${reason}). The check and the sync need it: retry online, or use --local [url-template] with a local videorc-ui build.`
    )
  }
  if (response.status === 404) {
    throw new Error(`${UI_NAMESPACE}/${name} is not in the registry (${url} answered 404).`)
  }
  if (!response.ok) {
    throw new RegistryUnreachable(`The registry answered ${response.status} for ${url}.`)
  }
  try {
    return await response.json()
  } catch (error) {
    throw new Error(`${url} did not answer with registry JSON: ${error.message}`)
  }
}

class RegistryUnreachable extends Error {}

async function formatLikeRepo(text, appRelativePath) {
  const filepath = appPath(appRelativePath)
  const options = (await prettier.resolveConfig(filepath, { editorconfig: true })) ?? {}
  return prettier.format(text, { ...options, filepath })
}

function hashFile(path) {
  return createHash('sha1').update(readFileSync(path)).digest('hex')
}

/** Repo-relative path → content hash, over everything the CLI may write. */
function snapshot() {
  const hashes = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) hashes.set(repoRelative(path), hashFile(path))
    }
  }
  for (const dir of SNAPSHOT_DIRS) walk(appPath(dir))
  for (const file of SNAPSHOT_FILES) {
    const path = join(ROOT, file)
    if (existsSync(path)) hashes.set(file, hashFile(path))
  }
  return hashes
}

/** Exact bytes of each file (null when absent), to put back after the CLI. */
function holdFiles(paths) {
  return new Map(paths.map((path) => [path, existsSync(path) ? readFileSync(path) : null]))
}

function putBack(held) {
  for (const [path, bytes] of held) {
    if (bytes === null) rmSync(path, { force: true })
    else writeFileSync(path, bytes)
  }
}

function git(args, options = {}) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...options })
  return result.stdout ?? ''
}

async function sync(names, template) {
  const { manifest, layout } = loadContext()
  const requested = names.length > 0 ? names : manifest.items
  if (requested.length === 0) throw new Error(`${UI_MANIFEST_PATH} lists no items to sync.`)

  // Load what will be installed first: an unknown name or an unreachable
  // registry stops here, before the CLI touches a file.
  const source = template ?? registryTemplateFrom(readJson(appPath(COMPONENTS_JSON)))
  const { items, external } = await resolveItemClosure(requested, itemLoader(source))
  const keepLocal = manifest.keepLocal
  const expectedPaths = new Set(
    [...items.values()].flatMap((item) => registryItemFiles(item, layout).map((file) => file.path))
  )

  const componentsPath = appPath(COMPONENTS_JSON)
  const held = holdFiles([componentsPath, ...keepLocal.map(appPath)])
  const packageBefore = readJson(appPath('package.json'))
  const before = snapshot()

  console.log(`ui:sync: ${requested.map((name) => `${UI_NAMESPACE}/${name}`).join(' ')}`)
  console.log(`  from ${source}`)
  if (template) {
    writeFileSync(
      componentsPath,
      componentsJsonWithTemplate(readFileSync(componentsPath, 'utf8'), template)
    )
  }

  // Ctrl-C reaches the CLI too; this process waits for it and still puts the
  // kept files back.
  const ignoreInterrupt = () => {}
  process.on('SIGINT', ignoreInterrupt)
  let cli
  try {
    cli = spawnSync('pnpm', shadcnAddArgs(requested), { cwd: APP, stdio: 'inherit' })
  } finally {
    process.off('SIGINT', ignoreInterrupt)
    putBack(held)
  }

  const touched = changedPaths(before, snapshot())
  const appPrefix = `${UI_APP_DIR}/`
  const appTouched = touched
    .filter((path) => path.startsWith(appPrefix))
    .map((path) => path.slice(appPrefix.length))
  for (const path of formattablePaths(appTouched, keepLocal)) {
    const file = appPath(path)
    if (!existsSync(file)) continue
    writeFileSync(file, await formatLikeRepo(readFileSync(file, 'utf8'), path))
  }

  if (cli.error || cli.status !== 0) {
    throw new Error(
      `The shadcn CLI failed (${cli.error?.message ?? `exit ${cli.status}`}). Kept files are restored; review the rest with git status.`
    )
  }

  const synced = itemsWithSyncedFiles(items, layout, keepLocal)
  const nextManifest = manifestWithItems(manifest, [
    ...requested.filter((name) => synced.includes(name)),
    ...synced
  ])
  if (nextManifest.items.length !== manifest.items.length) {
    const manifestFile = join(ROOT, UI_MANIFEST_PATH)
    writeFileSync(
      manifestFile,
      await formatLikeRepo(serializeUiManifest(nextManifest), 'ui-registry.json')
    )
    console.log(
      `\nAdded to ${UI_MANIFEST_PATH}: ${nextManifest.items.filter((name) => !manifest.items.includes(name)).join(', ')}`
    )
  }

  report({ touched, expectedPaths, keepLocal, external, packageBefore, items })
}

function report({ touched, expectedPaths, keepLocal, external, packageBefore, items }) {
  const appPrefix = `${UI_APP_DIR}/`
  const unexpected = touched.filter(
    (path) =>
      !(path.startsWith(appPrefix) && expectedPaths.has(path.slice(appPrefix.length))) &&
      path !== `${UI_APP_DIR}/package.json` &&
      path !== 'pnpm-lock.yaml'
  )
  console.log(`\nInstalled ${items.size} ${UI_NAMESPACE} items (${[...items.keys()].join(', ')}).`)
  console.log(`Kept local: ${keepLocal.join(', ') || 'nothing'}.`)
  if (external.length > 0) {
    console.log(
      `Also installed from other registries (not guarded by ui:check): ${external.join(', ')}.`
    )
  }
  if (unexpected.length > 0) {
    console.log(
      `\nThe CLI also changed files outside these items; review them:\n  ${unexpected.join('\n  ')}`
    )
  }

  const changes = dependencyChanges(packageBefore, readJson(appPath('package.json')))
  if (changes.length > 0) {
    console.log(`\nThe CLI changed ${UI_APP_DIR}/package.json. Keep a change only on purpose:`)
    for (const change of changes) console.log(`  ${describeDependencyChange(change)}`)
    console.log(
      `  (undo: git checkout -- ${UI_APP_DIR}/package.json pnpm-lock.yaml && pnpm install)`
    )
  }
  if (touched.includes('pnpm-lock.yaml')) {
    console.log('\npnpm-lock.yaml changed:')
    process.stdout.write(git(['diff', '--stat', '--', 'pnpm-lock.yaml']))
  }

  console.log('\ngit status:')
  process.stdout.write(
    git(['status', '--short', '--', UI_APP_DIR, 'pnpm-lock.yaml', 'package.json'])
  )
  console.log('\ngit diff --stat:')
  process.stdout.write(git(['diff', '--stat', '--', UI_APP_DIR, 'pnpm-lock.yaml', 'package.json']))
  console.log('\nReview the diff, then run the gates (AGENTS.md). Never edit a synced file here.')
}

async function check(names, template) {
  const started = Date.now()
  const { manifest, componentsJson, layout } = loadContext()
  const unknown = names.filter((name) => !manifest.items.includes(name))
  if (unknown.length > 0) throw new Error(`Not in ${UI_MANIFEST_PATH}: ${unknown.join(', ')}.`)
  const checked = names.length > 0 ? names : manifest.items
  const source = template ?? registryTemplateFrom(componentsJson)
  const { items } = await resolveItemClosure(checked, itemLoader(source))

  const kept = new Set(manifest.keepLocal)
  const failures = []
  const unguarded = itemsWithSyncedFiles(items, layout, manifest.keepLocal).filter(
    (name) => !manifest.items.includes(name)
  )
  for (const name of unguarded) {
    failures.push(
      `${UI_NAMESPACE}/${name} is installed as a dependency but missing from ${UI_MANIFEST_PATH}'s items.`
    )
  }

  const { files, conflicts } = mergeItemFiles(
    checked.flatMap((name) => registryItemFiles(items.get(name), layout))
  )
  for (const conflict of conflicts) {
    failures.push(`${conflict.path} is shipped differently by ${conflict.items.join(' and ')}.`)
  }
  const compared = files.filter((file) => !kept.has(file.path))
  const expected = await Promise.all(
    compared.map(async (file) => ({
      ...file,
      content: await formatLikeRepo(file.content, file.path)
    }))
  )
  for (const drift of findDrift(expected, (path) => readText(appPath(path)))) {
    const where = `${UI_APP_DIR}/${drift.path} (${UI_NAMESPACE}/${drift.item})`
    failures.push(
      drift.kind === 'missing'
        ? `${where} is missing.`
        : `${where} differs from the registry; ${drift.detail}`
    )
  }

  const skipped = files.length - compared.length
  if (failures.length > 0) {
    console.error(`ui:check failed against ${source}:\n`)
    for (const failure of failures) console.error(`${failure}\n`)
    console.error(
      `Synced files are edited in videorc-ui, never here. Move the change upstream, or take the registry's version with pnpm ui:sync <item>.`
    )
    process.exitCode = 1
    return
  }
  console.log(
    `ui:check OK: ${compared.length} files from ${checked.length} ${UI_NAMESPACE} items match ${source}` +
      `${skipped > 0 ? ` (${skipped} kept local)` : ''} in ${Date.now() - started} ms.`
  )
}

const argv = process.argv.slice(2)
const checking = argv.includes('--check')
try {
  const { names, template } = parseUiArgs(argv.filter((arg) => arg !== '--check'))
  if (checking) await check(names, template)
  else await sync(names, template)
} catch (error) {
  console.error(`ui:${checking ? 'check' : 'sync'}: ${error.message}`)
  process.exitCode = error instanceof RegistryUnreachable ? 2 : 1
}
