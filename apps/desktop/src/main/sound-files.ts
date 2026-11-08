// Plan 189: the files main hands the soundboard. Assets → Sounds → Import
// sounds… picks audio files, and the main window seeds the starter sounds
// from the bundled manifest. Either way the renderer gets single-use
// `input-file` capabilities (index.ts), never a path. Pure: no fs or
// electron, so the rules are verified in node.

import { basename, join, resolve } from 'node:path'

import { SOUND_HOTKEYS, SOUND_MAX_COUNT, SOUND_NAME_MAX_CHARS } from '../shared/backend'
import type { ResourceSelection, SoundHotkey } from '../shared/backend'
import { isSoundStarterSlug } from '../shared/sound-assets'
import type { SoundPickResult, StarterSound } from '../shared/sound-commands'

/** What Import sounds… offers: everything the bundled FFmpeg decodes that people have. */
export const SOUND_IMPORT_EXTENSIONS = [
  'wav',
  'mp3',
  'm4a',
  'aac',
  'ogg',
  'oga',
  'opus',
  'flac',
  'webm'
] as const

/** One pick imports at most a full board; the backend refuses past its own limits. */
export const SOUND_PICK_MAX_FILES = SOUND_MAX_COUNT

/**
 * What a picked file that main couldn't hand over says (release test 147,
 * plan 0006). The backend's own reason stays in the log: it can name a path.
 */
export const SOUND_PICK_LEFT_OUT_REASON =
  "Videorc couldn't open this file. It may have been moved or deleted."

/**
 * Each picked path as a single-use capability, at most a full board, and the
 * ones whose capability couldn't be issued, by file name. Pure apart from the
 * injected issuer, so the rule is verified in node.
 */
export async function soundPickResult(
  paths: readonly string[],
  issue: (path: string) => Promise<ResourceSelection>,
  onLeftOut: (path: string, error: unknown) => void = () => undefined
): Promise<SoundPickResult> {
  const result: SoundPickResult = { selections: [], leftOut: [] }
  for (const path of paths.slice(0, SOUND_PICK_MAX_FILES)) {
    try {
      result.selections.push(await issue(path))
    } catch (error) {
      onLeftOut(path, error)
      result.leftOut.push({ displayName: basename(path), reason: SOUND_PICK_LEFT_OUT_REASON })
    }
  }
  return result
}

/** The manifest beside the starter files (plan 189 S1). */
export const STARTER_SOUNDS_MANIFEST = 'manifest.json'

/**
 * The starter folder: the packaged app's `sounds/starter` resource
 * (electron-builder `extraResources`), or the source tree in development.
 */
export function starterSoundsDirectory(options: {
  packaged: boolean
  resourcesPath: string
  workspaceRoot: string
}): string {
  return options.packaged
    ? join(options.resourcesPath, 'sounds', 'starter')
    : resolve(options.workspaceRoot, 'apps/desktop/resources/sounds/starter')
}

/** A bare `.ogg` basename beside the manifest: no separators, no hops, no hidden file. */
export function isStarterSoundFileName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 4 &&
    value.length <= 255 &&
    value.endsWith('.ogg') &&
    !value.startsWith('.') &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('..') &&
    !value.includes('\0')
  )
}

/** A manifest row main will offer, with the file it names. */
export interface StarterSoundRow extends StarterSound {
  file: string
}

const isHotkey = (value: unknown): value is SoundHotkey =>
  typeof value === 'string' && (SOUND_HOTKEYS as readonly string[]).includes(value)

/**
 * The manifest's rows main will offer, in manifest order, and why it refused
 * the rest (for the log). A row needs a starter slug, a name and a bare
 * `.ogg` file beside the manifest; a key, when it has one, is 1 to 9. A slug
 * or a key seen before is refused, so the board never gets two of either.
 */
export function starterSoundRows(manifest: unknown): {
  rows: StarterSoundRow[]
  refused: string[]
} {
  const list =
    typeof manifest === 'object' && manifest !== null
      ? (manifest as { sounds?: unknown }).sounds
      : undefined
  if (!Array.isArray(list)) return { rows: [], refused: ['The manifest has no sounds list.'] }
  const rows: StarterSoundRow[] = []
  const refused: string[] = []
  const slugs = new Set<string>()
  const hotkeys = new Set<string>()
  list.forEach((entry, index) => {
    const row = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >
    const { slug, name, hotkey, file } = row
    const at = `Row ${index + 1}`
    if (!isSoundStarterSlug(slug)) return void refused.push(`${at}: not a starter slug.`)
    if (slugs.has(slug)) return void refused.push(`${at}: ${slug} is listed twice.`)
    if (typeof name !== 'string' || !name.trim() || name.length > SOUND_NAME_MAX_CHARS) {
      return void refused.push(`${at}: ${slug} has no usable name.`)
    }
    if (hotkey !== undefined && !isHotkey(hotkey)) {
      return void refused.push(`${at}: ${slug} has a key other than 1 to 9.`)
    }
    if (!isStarterSoundFileName(file)) {
      return void refused.push(`${at}: ${slug} names a file that isn't an .ogg beside it.`)
    }
    slugs.add(slug)
    const key = hotkey !== undefined && !hotkeys.has(hotkey) ? hotkey : undefined
    if (key) hotkeys.add(key)
    rows.push({ slug, name: name.trim(), ...(key ? { hotkey: key } : {}), file })
  })
  return { rows, refused }
}

/** The rows `slugs` asks for, in manifest order; every row without a filter. */
export function starterSoundRowsFor(
  rows: readonly StarterSoundRow[],
  slugs: readonly string[] | undefined
): StarterSoundRow[] {
  if (!slugs) return [...rows]
  const wanted = new Set(slugs)
  return rows.filter((row) => wanted.has(row.slug))
}
