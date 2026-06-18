// Pure helpers for importing background images into managed app-support storage
// (Assets Tab plan, slice A4). Shared by the Electron main process (which does
// the actual copy) and unit tests — no fs/electron here, just path + extension
// logic so the rules are verified in node.

export const SUPPORTED_BACKGROUND_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const

export type SupportedBackgroundExtension = (typeof SUPPORTED_BACKGROUND_EXTENSIONS)[number]

// What the main process returns to the renderer after copying an imported image
// into app-support storage. The renderer turns this into a BackgroundAsset.
export type BackgroundImportResult = {
  id: string
  name: string
  assetPath: string
  thumbnailPath: string
  fileName: string
}

export const BUNDLED_BACKGROUND_MANIFEST = [
  { id: 'builtin-bg-01', name: 'Code Demo', fileName: 'code-demo.webp' },
  { id: 'builtin-bg-02', name: 'Product Launch', fileName: 'product-launch.webp' },
  { id: 'builtin-bg-03', name: 'Tutorial', fileName: 'tutorial.webp' },
  { id: 'builtin-bg-04', name: 'Livestream', fileName: 'livestream.webp' },
  { id: 'builtin-bg-05', name: 'Minimal Desk', fileName: 'minimal-desk.webp' },
  { id: 'builtin-bg-06', name: 'Podcast', fileName: 'podcast.webp' },
  { id: 'builtin-bg-07', name: 'Webinar', fileName: 'webinar.webp' },
  { id: 'builtin-bg-08', name: 'Dark Mode', fileName: 'dark-mode.webp' },
  { id: 'builtin-bg-09', name: 'Light Mode', fileName: 'light-mode.webp' },
  { id: 'builtin-bg-10', name: 'Focus', fileName: 'focus.webp' }
] as const

function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  // dot <= 0 covers "no extension" and dotfiles like ".gitignore".
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

export function isSupportedBackgroundFile(path: string): boolean {
  return (SUPPORTED_BACKGROUND_EXTENSIONS as readonly string[]).includes(extensionOf(path))
}

// The default asset name: the source file's name without directory or extension.
export function backgroundAssetNameFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  const name = dot <= 0 ? base : base.slice(0, dot)
  return name.trim() || 'Background'
}

// Managed copy file name: <id><normalized-ext>. Falls back to .png when the
// source extension is unsupported — callers should validate first with
// isSupportedBackgroundFile.
export function managedBackgroundFileName(id: string, sourcePath: string): string {
  const ext = extensionOf(sourcePath)
  const safeExt = (SUPPORTED_BACKGROUND_EXTENSIONS as readonly string[]).includes(ext)
    ? ext
    : '.png'
  return `${id}${safeExt}`
}
