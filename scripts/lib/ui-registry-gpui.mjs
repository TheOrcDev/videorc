// The GPUI flavour of the @videorc registry (plan 260 S2.2b): Videorc's
// design system on GPUI, served at ui.videorc.com/r/gpui/<item>.json from
// videorc-ui's registry-gpui.json and synced into crates/videorc-kit. As
// with the React flavour, a synced file is edited in videorc-ui and never
// here. These are the pure parts; scripts/sync-ui.mjs does the I/O.

import { isItemName, isSafeRelativePath, validateRegistryTemplate } from './ui-registry.mjs'

export const GPUI_NAMESPACE = '@videorc-gpui'
/** The crate the GPUI items sync into, relative to the repo root. */
export const GPUI_CRATE_DIR = 'crates/videorc-kit'
/** Relative to the repo root. Its paths (`keepLocal`) are relative to the crate. */
export const GPUI_MANIFEST_PATH = `${GPUI_CRATE_DIR}/ui-registry.json`
/** `--local` with no template: videorc-ui's `pnpm dev`. */
export const GPUI_LOCAL_TEMPLATE = 'http://localhost:3000/r/gpui/{name}.json'
export const FLAVOURS = Object.freeze(['react', 'gpui'])

// Where an item's files may land in the crate: its modules and its icons.
const CRATE_FILE = /^(?:src\/[a-z0-9_]+\.rs|icons\/[a-z0-9-]+\.svg)$/
const SECTION = /^\s*\[([^\]]+)\]\s*$/
const DEPENDENCY_LINE = /^([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/
const INLINE_PAIR = /([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|true|false)/g
const MOD_DECLARATION = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([a-z_][a-z0-9_]*)\s*;/gm

/**
 * `--flavour react|gpui` (or `--flavour=gpui`) out of the arguments. `null`
 * when none is given: ui:sync then syncs React and ui:check checks both.
 */
export function parseFlavourArgs(argv) {
  const rest = []
  let flavour = null
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    let value
    if (arg === '--flavour') {
      value = argv[index + 1]
      index += 1
    } else if (arg.startsWith('--flavour=')) {
      value = arg.slice('--flavour='.length)
    } else {
      rest.push(arg)
      continue
    }
    if (!FLAVOURS.includes(value)) {
      throw new Error(`--flavour takes ${FLAVOURS.join(' or ')}, got ${JSON.stringify(value)}.`)
    }
    if (flavour !== null && flavour !== value) {
      throw new Error('--flavour is given twice with different values.')
    }
    flavour = value
  }
  return { flavour, rest }
}

/**
 * The GPUI manifest: `registry`, the URL template of the GPUI items;
 * `items`, the items Videorc syncs; `keepLocal`, crate-relative files the
 * sync never changes.
 */
export function parseGpuiManifest(text, source = GPUI_MANIFEST_PATH) {
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error.message}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source} must be a JSON object with "registry", "items" and "keepLocal".`)
  }
  const list = (field) => {
    const entries = value[field] ?? []
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string')) {
      throw new Error(`${source}: "${field}" must be a list of strings.`)
    }
    if (new Set(entries).size !== entries.length) {
      throw new Error(`${source}: "${field}" lists an entry twice.`)
    }
    return [...entries]
  }
  const items = list('items')
  const keepLocal = list('keepLocal')
  for (const name of items) {
    if (!isItemName(name)) {
      throw new Error(`${source}: "${name}" is not a registry item name (kebab-case).`)
    }
  }
  for (const path of keepLocal) {
    if (!isSafeRelativePath(path)) {
      throw new Error(`${source}: keepLocal "${path}" must be a plain path relative to the crate.`)
    }
  }
  const registry = validateRegistryTemplate(value.registry, `${source}'s "registry"`)
  return { ...value, registry, items, keepLocal }
}

/** An item's files, keyed by their crate-relative path (`target`). */
export function gpuiItemFiles(item) {
  return (item.files ?? []).map((file) => {
    if (typeof file.content !== 'string') {
      throw new Error(`${item.name}: ${file.path} has no content in the registry JSON.`)
    }
    if (!CRATE_FILE.test(file.target ?? '')) {
      throw new Error(
        `${item.name}: ${file.path} targets ${JSON.stringify(file.target)}, not src/<module>.rs or icons/<name>.svg.`
      )
    }
    return { path: file.target, content: file.content, item: item.name }
  })
}

const unquote = (value) => (value.startsWith('"') ? JSON.parse(value) : value === 'true')

/**
 * The one-line entries of a Cargo.toml table, such as `workspace.dependencies`:
 * `{ gpui: { package: 'gpui-pre', version: '=0.3.14' } }`. A multi-line
 * entry is skipped.
 */
export function cargoTable(text, table) {
  const entries = {}
  let section = ''
  for (const line of text.split('\n')) {
    const heading = SECTION.exec(line)
    if (heading) {
      section = heading[1].trim()
      continue
    }
    if (section !== table || line.trimStart().startsWith('#')) continue
    const entry = DEPENDENCY_LINE.exec(line)
    if (!entry) continue
    const [, name, value] = entry
    if (value.startsWith('"')) {
      entries[name] = { version: JSON.parse(value) }
    } else if (value.startsWith('{') && value.endsWith('}')) {
      const spec = {}
      for (const pair of value.matchAll(INLINE_PAIR)) spec[pair[1]] = unquote(pair[2])
      entries[name] = spec
    }
  }
  return entries
}

/**
 * The crates the items use against the app's `[workspace.dependencies]`:
 * `mismatched`, a crate the app pins to another package or version (GPUI
 * itself among them: one pin for the kit and the app, plan 260 D1), and
 * `missing`, a crate the app does not declare yet.
 */
export function pinDifferences(items, workspaceDependencies) {
  const wanted = new Map()
  for (const item of items) {
    for (const [name, spec] of Object.entries(item.meta?.crates ?? {})) {
      if (!wanted.has(name)) wanted.set(name, { spec, items: [] })
      wanted.get(name).items.push(item.name)
    }
  }
  const mismatched = []
  const missing = []
  for (const [name, { spec, items: users }] of [...wanted].sort(([a], [b]) => a.localeCompare(b))) {
    const ours = workspaceDependencies[name]
    if (!ours) {
      missing.push({ name, spec, items: users })
      continue
    }
    const theirsPackage = spec.package ?? name
    const oursPackage = ours.package ?? name
    if (theirsPackage !== oursPackage || spec.version !== ours.version) {
      mismatched.push({ name, spec, ours, items: users })
    }
  }
  return { mismatched, missing }
}

const tomlValue = (value) => (typeof value === 'string' ? JSON.stringify(value) : String(value))

/** A `[workspace.dependencies]` line for a crate the registry pins. */
export function cargoLine(name, spec) {
  const pairs = Object.entries(spec).map(([key, value]) => `${key} = ${tomlValue(value)}`)
  return Object.keys(spec).length === 1 && spec.version
    ? `${name} = ${tomlValue(spec.version)}`
    : `${name} = { ${pairs.join(', ')} }`
}

export function describePin({ name, spec, ours }) {
  const theirs = `${spec.package ?? name} ${spec.version}`
  return ours
    ? `${name}: the app pins ${ours.package ?? name} ${ours.version}, the registry ${theirs}`
    : `${name}: the registry pins ${theirs}`
}

/** The modules a crate's lib.rs declares. */
export function declaredModules(libSource) {
  return new Set([...libSource.matchAll(MOD_DECLARATION)].map((match) => match[1]))
}

/** The synced modules lib.rs does not declare yet, in order. */
export function undeclaredModules(files, libSource) {
  const declared = declaredModules(libSource ?? '')
  return [
    ...new Set(
      files
        .map((file) => /^src\/([a-z0-9_]+)\.rs$/.exec(file.path)?.[1])
        .filter((module) => module && module !== 'lib' && !declared.has(module))
    )
  ].sort()
}

/** The patched crates the registry's kit builds with, from the items' meta. */
export function registryPatches(items) {
  return [...new Set(items.flatMap((item) => item.meta?.patches ?? []))].sort()
}

/**
 * Why each patch matters, for the failure. gpui-pre-apple carries the SF
 * Medium fix (plan 260 S0.4) until zed-industries/zed#67416 ships in a
 * gpui-pre release; then videorc-ui drops the patch and no item lists it.
 */
const PATCH_REASONS = Object.freeze({
  'gpui-pre-apple':
    'without it, weight 500 draws SF Regular instead of SF Medium on macOS. It goes away when zed-industries/zed#67416 ships in a gpui-pre release'
})

/**
 * The patches the items' kit builds with that the root Cargo.toml's
 * `[patch.crates-io]` lacks. ui:check fails on each, so a synced kit never
 * builds silently without one.
 */
export function missingPatches(items, rootToml) {
  const patched = cargoTable(rootToml, 'patch.crates-io')
  return registryPatches(items)
    .filter((name) => !patched[name])
    .map((name) => ({
      name,
      reason: PATCH_REASONS[name] ?? "the registry's kit builds with it"
    }))
}

export function describePatch({ name, reason }) {
  return `Cargo.toml has no [patch.crates-io] ${name}; copy it from videorc-ui's gpui/patches/ (${name}.patch says what changed): ${reason}.`
}
