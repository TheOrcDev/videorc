// Videorc's components from the @videorc shadcn registry (ui.videorc.com,
// source TheOrcDev/videorc-ui). A synced file is edited in videorc-ui and
// never here: `pnpm ui:sync` takes the registry's version and `pnpm ui:check`
// fails when a synced file differs from it. These are the pure parts;
// scripts/sync-ui.mjs does the I/O.

import { posix } from 'node:path'

export const UI_NAMESPACE = '@videorc'
/** The app the registry installs into, relative to the repo root. */
export const UI_APP_DIR = 'apps/desktop'
/** Relative to the repo root. Its paths (`keepLocal`) are relative to the app. */
export const UI_MANIFEST_PATH = `${UI_APP_DIR}/ui-registry.json`
/** `--local` with no template: videorc-ui's `pnpm dev`. */
export const UI_LOCAL_TEMPLATE = 'http://localhost:3000/r/{name}.json'
export const SHADCN_CLI = 'shadcn@latest'

const ITEM_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const URL_TEMPLATE = /^https?:\/\/\S+$/
const PRETTIER_FILE = /\.(?:[cm]?[jt]sx?|css|json)$/

// The registry's sources import through shadcn's default aliases, and the CLI
// rewrites them to the app's. Videorc's aliases are the defaults, so a synced
// file is the registry's content after Prettier, byte for byte.
const DEFAULT_ALIASES = Object.freeze({
  components: '@/components',
  ui: '@/components/ui',
  lib: '@/lib',
  utils: '@/lib/utils',
  hooks: '@/hooks'
})

// Where the CLI puts a file with no `target`: the alias of its type, keeping
// the path under that type's folder.
const TYPE_HOMES = Object.freeze({
  'registry:ui': { alias: 'ui', folder: 'components/ui/' },
  'registry:component': { alias: 'components', folder: 'components/' },
  'registry:block': { alias: 'components', folder: 'components/' },
  'registry:lib': { alias: 'lib', folder: 'lib/' },
  'registry:hook': { alias: 'hooks', folder: 'hooks/' }
})

export function isItemName(value) {
  return typeof value === 'string' && ITEM_NAME.test(value)
}

export function isSafeRelativePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')
  )
}

function stringList(value, field, source) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${source}: "${field}" must be a list of strings.`)
  }
  const seen = new Set()
  for (const entry of value) {
    if (seen.has(entry)) throw new Error(`${source}: "${field}" lists "${entry}" twice.`)
    seen.add(entry)
  }
  return [...value]
}

/**
 * The manifest: `items`, the @videorc items Videorc syncs, and `keepLocal`,
 * app-relative files the sync never changes (Videorc's own copies of a file
 * an item would write, such as the theme's stylesheet).
 */
export function parseUiManifest(text, source = UI_MANIFEST_PATH) {
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error.message}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source} must be a JSON object with "items" and "keepLocal".`)
  }
  const items = stringList(value.items, 'items', source)
  const keepLocal = stringList(value.keepLocal, 'keepLocal', source)
  for (const name of items) {
    if (!isItemName(name)) {
      throw new Error(`${source}: "${name}" is not a registry item name (kebab-case).`)
    }
  }
  for (const path of keepLocal) {
    if (!isSafeRelativePath(path)) {
      throw new Error(`${source}: keepLocal "${path}" must be a plain path relative to the app.`)
    }
  }
  return { ...value, items, keepLocal }
}

/** The manifest with `names` appended to its items, in order, once each. */
export function manifestWithItems(manifest, names) {
  const items = [...manifest.items]
  for (const name of names) if (!items.includes(name)) items.push(name)
  return { ...manifest, items }
}

export function serializeUiManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

export function validateRegistryTemplate(template, source = 'The registry URL') {
  if (typeof template !== 'string' || !URL_TEMPLATE.test(template)) {
    throw new Error(`${source} must be an http(s) URL, got ${JSON.stringify(template)}.`)
  }
  if (!template.includes('{name}')) {
    throw new Error(`${source} must contain {name}, got ${template}.`)
  }
  return template
}

export function registryItemUrl(template, name) {
  return validateRegistryTemplate(template).replaceAll('{name}', name)
}

/** The namespace's URL template from components.json `registries`. */
export function registryTemplateFrom(componentsJson, namespace = UI_NAMESPACE) {
  const entry = componentsJson?.registries?.[namespace]
  const template = typeof entry === 'string' ? entry : entry?.url
  if (!template) {
    throw new Error(`components.json has no "${namespace}" registry.`)
  }
  return validateRegistryTemplate(template, `components.json's "${namespace}" registry`)
}

/** components.json text with the namespace pointed at another URL template. */
export function componentsJsonWithTemplate(text, template, namespace = UI_NAMESPACE) {
  const value = JSON.parse(text)
  value.registries = { ...value.registries, [namespace]: validateRegistryTemplate(template) }
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * `ui:sync [names…] [--local [template]]` and `ui:check [names…] [--local [template]]`.
 * `--local` takes the next argument as its template when it is a URL, and
 * videorc-ui's `pnpm dev` otherwise. Names may carry the namespace.
 */
export function parseUiArgs(argv, namespace = UI_NAMESPACE) {
  const names = []
  let template = null
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--local') {
      const next = argv[index + 1]
      if (next !== undefined && /^https?:\/\//.test(next)) {
        template = next
        index += 1
      } else {
        template = UI_LOCAL_TEMPLATE
      }
      continue
    }
    if (arg.startsWith('--local=')) {
      template = arg.slice('--local='.length)
      continue
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option ${arg}. Usage: [item…] [--local [url-template]]`)
    }
    const name = arg.startsWith(`${namespace}/`) ? arg.slice(namespace.length + 1) : arg
    if (!isItemName(name)) throw new Error(`"${arg}" is not a ${namespace} item name.`)
    if (!names.includes(name)) names.push(name)
  }
  if (template !== null) validateRegistryTemplate(template, '--local')
  return { names, template }
}

export function shadcnAddArgs(names, namespace = UI_NAMESPACE) {
  return [
    'dlx',
    SHADCN_CLI,
    'add',
    ...names.map((name) => `${namespace}/${name}`),
    '--overwrite',
    '--yes'
  ]
}

/** A components.json alias through the tsconfig `paths`, as the CLI resolves it. */
export function resolveAliasDir(alias, paths) {
  for (const [pattern, targets] of Object.entries(paths ?? {})) {
    const [target] = targets ?? []
    if (typeof target !== 'string') continue
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1)
      if (alias.startsWith(prefix)) {
        return posix.join(target.replace(/\/\*$/, ''), alias.slice(prefix.length))
      }
    } else if (alias === pattern) {
      return posix.normalize(target)
    }
  }
  throw new Error(`The components.json alias ${alias} matches no tsconfig path.`)
}

/** App-relative folders for each alias, from components.json and the tsconfig `paths`. */
export function registryLayout(componentsJson, paths) {
  const aliases = componentsJson?.aliases ?? {}
  const changed = Object.entries(DEFAULT_ALIASES).filter(([key, value]) => aliases[key] !== value)
  if (changed.length > 0) {
    // The CLI would rewrite the registry's imports to these, and ui:check
    // compares the registry's files as they are.
    throw new Error(
      `components.json aliases differ from shadcn's defaults (${changed.map(([key]) => key).join(', ')}); teach scripts/lib/ui-registry.mjs the CLI's import rewrite first.`
    )
  }
  return Object.fromEntries(
    ['components', 'ui', 'lib', 'hooks'].map((key) => [key, resolveAliasDir(aliases[key], paths)])
  )
}

/** Where the CLI writes a registry file, relative to the app. */
export function localPathForRegistryFile(file, layout) {
  if (file.target) {
    const target = file.target.replace(/^~\//, '')
    if (!isSafeRelativePath(target)) throw new Error(`Unsafe registry target ${file.target}.`)
    return target
  }
  const home = TYPE_HOMES[file.type]
  if (!home) throw new Error(`${file.path}: a ${file.type} file needs a target.`)
  const rest = file.path.startsWith(home.folder)
    ? file.path.slice(home.folder.length)
    : posix.basename(file.path)
  const path = posix.join(layout[home.alias], rest)
  if (!isSafeRelativePath(path)) throw new Error(`Unsafe registry path ${file.path}.`)
  return path
}

/** An item's files, keyed by their app-relative path. */
export function registryItemFiles(item, layout) {
  return (item.files ?? []).map((file) => {
    if (typeof file.content !== 'string') {
      throw new Error(`${item.name}: ${file.path} has no content in the registry JSON.`)
    }
    return { path: localPathForRegistryFile(file, layout), content: file.content, item: item.name }
  })
}

/**
 * One entry per path. Two items that write the same file must agree on it,
 * or the CLI's install order decides what lands.
 */
export function mergeItemFiles(files) {
  const byPath = new Map()
  const conflicts = []
  for (const file of files) {
    const seen = byPath.get(file.path)
    if (!seen) byPath.set(file.path, file)
    else if (seen.content !== file.content) {
      conflicts.push({ path: file.path, items: [seen.item, file.item] })
    }
  }
  return { files: [...byPath.values()], conflicts }
}

/** The item a registry dependency names in the namespace, or null. */
export function namespaceItemName(dependency, namespace = UI_NAMESPACE) {
  return dependency.startsWith(`${namespace}/`) ? dependency.slice(namespace.length + 1) : null
}

/**
 * Every item `names` install: the names and their dependencies in the
 * namespace, loaded a level at a time. Other registries' items and stock
 * shadcn names come back as `external`: the CLI installs them, and the
 * manifest does not hold them.
 */
export async function resolveItemClosure(names, loadItem, namespace = UI_NAMESPACE) {
  const items = new Map()
  const external = new Set()
  let level = [...new Set(names)]
  while (level.length > 0) {
    const loaded = await Promise.all(level.map(async (name) => [name, await loadItem(name)]))
    const next = []
    for (const [name, item] of loaded) {
      if (item?.name !== name) {
        throw new Error(`The registry answered ${namespace}/${name} with "${item?.name}".`)
      }
      items.set(name, item)
      for (const dependency of item.registryDependencies ?? []) {
        const own = namespaceItemName(dependency, namespace)
        if (own === null) external.add(dependency)
        else if (!items.has(own) && !level.includes(own) && !next.includes(own)) next.push(own)
      }
    }
    level = next
  }
  return { items, external: [...external].sort() }
}

/**
 * The items whose files the sync leaves in the app: every item with at least
 * one file outside keepLocal. Those belong in the manifest, so ui:check
 * guards everything the CLI wrote.
 */
export function itemsWithSyncedFiles(items, layout, keepLocal) {
  const kept = new Set(keepLocal)
  return [...items.values()]
    .filter((item) => registryItemFiles(item, layout).some((file) => !kept.has(file.path)))
    .map((item) => item.name)
}

/** Paths whose content hash differs between two snapshots, or that only one has. */
export function changedPaths(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()])
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort()
}

/** The files Prettier should format after the CLI: code it wrote, never a kept file. */
export function formattablePaths(paths, keepLocal = []) {
  const kept = new Set(keepLocal)
  return paths.filter((path) => PRETTIER_FILE.test(path) && !kept.has(path))
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies'
]

/** What changed in package.json's dependency maps: additions, removals and range changes. */
export function dependencyChanges(before, after) {
  const changes = []
  for (const field of DEPENDENCY_FIELDS) {
    const was = before?.[field] ?? {}
    const now = after?.[field] ?? {}
    for (const name of [...new Set([...Object.keys(was), ...Object.keys(now)])].sort()) {
      if (was[name] === now[name]) continue
      changes.push({ field, name, from: was[name] ?? null, to: now[name] ?? null })
    }
  }
  return changes
}

export function describeDependencyChange({ field, name, from, to }) {
  if (from === null) return `+ ${name} ${to} (${field})`
  if (to === null) return `- ${name} ${from} (${field})`
  return `~ ${name} ${from} -> ${to} (${field})`
}

/**
 * Where a local file first parts from the registry's, with a few lines of
 * each side: enough to see the edit without a diff tool.
 */
export function describeDifference(local, registry, maxLines = 3) {
  const ours = local.split('\n')
  const theirs = registry.split('\n')
  let start = 0
  while (start < ours.length && start < theirs.length && ours[start] === theirs[start]) start += 1
  let oursEnd = ours.length
  let theirsEnd = theirs.length
  while (oursEnd > start && theirsEnd > start && ours[oursEnd - 1] === theirs[theirsEnd - 1]) {
    oursEnd -= 1
    theirsEnd -= 1
  }
  const side = (lines, end, mark) => {
    const shown = lines
      .slice(start, Math.min(end, start + maxLines))
      .map((line) => `${mark} ${line}`)
    const more = end - start - shown.length
    return more > 0 ? [...shown, `${mark} … ${more} more`] : shown
  }
  return [
    `first difference at line ${start + 1}:`,
    ...side(ours, oursEnd, '- local   '),
    ...side(theirs, theirsEnd, '+ registry')
  ].join('\n')
}

const LEADING_COMMENTS = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+/

/**
 * A file without the comments before its first statement. The shadcn CLI
 * (4.23) writes files that way: its transforms hand back ts-morph's
 * `getText()`, which skips the file's leading trivia, so a header comment
 * never reaches the app.
 */
export function withoutLeadingComments(text) {
  return text.replace(LEADING_COMMENTS, '')
}

/**
 * The forms a synced file may take, before formatting: what the CLI writes
 * today first, then the registry's text as it is, so a CLI that keeps
 * header comments is not drift either.
 */
export function syncedFileForms(content) {
  const written = withoutLeadingComments(content)
  return written === content ? [content] : [written, content]
}

/**
 * Drift between the registry's files (each with its `forms`, formatted the
 * way the sync formats) and the app's: every file that is missing or matches
 * none of its forms.
 */
export function findDrift(expected, readLocal) {
  const drift = []
  for (const file of expected) {
    const local = readLocal(file.path)
    if (local === null) drift.push({ ...file, kind: 'missing' })
    else if (!file.forms.includes(local)) {
      drift.push({ ...file, kind: 'differs', detail: describeDifference(local, file.forms[0]) })
    }
  }
  return drift
}
