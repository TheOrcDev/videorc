import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// Plan 050 (D5, D6, S20): the renderer stays on real glass and native feel.
// - No CSS backdrop blur anywhere: it wedged the compositor in June, and the
//   OS draws the glass now.
// - No cursor-pointer: desktop controls use the arrow.
// - No colour literals in chrome: colour comes from the tokens in styles.css.
//   The allowlist names the files whose literals are CONTENT (what ends up in
//   the video or a scanner), never chrome.

const RENDERER_ROOT = join(__dirname, '..')

const COLOUR_LITERAL_ALLOWLIST = new Set([
  // Caption rendering burned into the video, and its previews.
  'src/lib/caption-overlay.ts',
  'src/components/captions/caption-preview.tsx',
  'src/components/captions/captions-controls.tsx',
  'src/components/captions-reader.tsx',
  // The comment highlight overlay drawn onto the stream.
  'src/lib/comment-highlight.ts',
  // Chroma-key colours are the key itself.
  'src/lib/capture.ts',
  'src/components/tabs/layout-tab.tsx',
  // A QR code must stay black on white for scanners.
  'src/components/phone-remote-section.tsx',
  // The recording-invisibility smoke marker is loud red on purpose.
  'src/components/notes-window.tsx',
  // Canvas drawing: a fallback stroke and a transparency mask, not colours.
  'src/components/ui/live-waveform.tsx',
  // shadcn chart: selectors that MATCH Recharts' own default strokes
  // ([stroke='#ccc']) to restyle them with tokens; it paints no literal.
  'src/components/ui/chart.tsx'
])

function rendererFiles(): string[] {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) {
        if (entry !== 'node_modules') walk(path)
      } else if (/\.(tsx|ts|css|html)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        files.push(path)
      }
    }
  }
  walk(RENDERER_ROOT)
  return files
}

/** Comments may name the banned things to explain why; only code counts. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

// Forward slashes on every platform, so the allowlist matches on Windows too.
const files = rendererFiles().map((path) => ({
  path: relative(RENDERER_ROOT, path).split(sep).join('/'),
  code: withoutComments(readFileSync(path, 'utf8'))
}))

function offenders(pattern: RegExp, filter: (path: string) => boolean = () => true): string[] {
  const found: string[] = []
  for (const { path, code } of files) {
    if (!filter(path)) continue
    code.split('\n').forEach((line, index) => {
      if (pattern.test(line)) found.push(`${path}:${index + 1}: ${line.trim().slice(0, 120)}`)
    })
  }
  return found
}

describe('renderer style guards (plan 050)', () => {
  it('scans the renderer sources', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files.some(({ path }) => path === 'src/styles.css')).toBe(true)
  })

  it('never uses CSS backdrop blur or filters', () => {
    expect(
      offenders(
        /\bbackdrop-(?:blur|brightness|contrast|grayscale|hue-rotate|invert|opacity|saturate|sepia)\b|backdrop-filter\s*:/
      )
    ).toEqual([])
  })

  it('never uses cursor-pointer: desktop controls use the arrow', () => {
    expect(offenders(/\bcursor-pointer\b|cursor:\s*pointer/)).toEqual([])
  })

  it('keeps colour literals out of the chrome', () => {
    expect(
      offenders(
        /#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])|\brgba?\(|\boklch\(|\bhsla?\(/,
        (path) => /\.(tsx|ts)$/.test(path) && !COLOUR_LITERAL_ALLOWLIST.has(path)
      )
    ).toEqual([])
  })

  it('keeps every allowlisted file real, so the list cannot rot', () => {
    for (const path of COLOUR_LITERAL_ALLOWLIST) {
      expect(files.some((file) => file.path === path)).toBe(true)
    }
  })
})
