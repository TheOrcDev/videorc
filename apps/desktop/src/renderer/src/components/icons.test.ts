import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  CameraIcon,
  StudioIcon,
  BrainIcon,
  KickIcon,
  GolemIcon,
  YOUTUBE_MARK_ASPECT,
  YOUTUBE_MARK_MIN_PX,
  XPlatformIcon,
  YoutubeIcon,
  type AppIconProps
} from './icons'
import { X_MARK_PATH } from '../lib/x-mark'

describe('semantic icon registry', () => {
  it('keeps optional glyph modules outside the initial chunk through the actual registry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'videorc-icon-chunks-'))
    try {
      const registry = fileURLToPath(new URL('./icons.tsx', import.meta.url))
      await writeFile(
        join(root, 'entry.ts'),
        `import { StudioIcon } from ${JSON.stringify(registry)};
        globalThis.initialIcon = StudioIcon;
        globalThis.openInspector = () => import('./inspector');`
      )
      await writeFile(
        join(root, 'inspector.ts'),
        `export { BrainIcon } from ${JSON.stringify(registry)};`
      )
      const built = await build({
        configFile: false,
        root,
        logLevel: 'silent',
        esbuild: { jsx: 'automatic' },
        build: { write: false, minify: false, rollupOptions: { input: join(root, 'entry.ts') } }
      })
      if (Array.isArray(built) || !('output' in built))
        throw new Error('Expected one Rollup output.')
      const chunks = built.output.filter((item) => item.type === 'chunk')
      const entry = chunks.find((chunk) => chunk.isEntry)
      expect(entry).toBeDefined()
      const eager = new Set<string>()
      const visit = (fileName: string): void => {
        const chunk = chunks.find((candidate) => candidate.fileName === fileName)
        if (!chunk || eager.has(fileName)) return
        eager.add(fileName)
        chunk.imports.forEach(visit)
      }
      visit(entry!.fileName)
      const initialModules = chunks
        .filter((chunk) => eager.has(chunk.fileName))
        .flatMap((chunk) => Object.keys(chunk.modules))
      const deferredModules = chunks
        .filter((chunk) => !eager.has(chunk.fileName))
        .flatMap((chunk) => Object.keys(chunk.modules))
      expect(initialModules.some((id) => id.endsWith('/csr/VideoCamera.es.js'))).toBe(true)
      expect(initialModules.filter((id) => /\/(?:csr|defs)\/Brain\.es\.js$/.test(id))).toEqual([])
      expect(deferredModules.some((id) => id.endsWith('/defs/Brain.es.js'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('preserves semantic aliases, all weights and ordinary SVG props', () => {
    expect(CameraIcon).toBe(StudioIcon)
    const weights: AppIconProps['weight'][] = [
      'thin',
      'light',
      'regular',
      'bold',
      'fill',
      'duotone'
    ]
    const rendered = weights.map((weight) =>
      renderToStaticMarkup(
        createElement(BrainIcon, {
          weight,
          size: 24,
          className: 'semantic-icon',
          'aria-label': 'Brain',
          color: 'currentColor'
        })
      )
    )
    for (const markup of rendered) {
      expect(markup).toContain('width="24"')
      expect(markup).toContain('class="semantic-icon"')
      expect(markup).toContain('aria-label="Brain"')
      expect(markup).toContain('viewBox="0 0 256 256"')
    }
    expect(new Set(rendered).size).toBe(6)
    expect(renderToStaticMarkup(createElement(KickIcon, { size: 32, weight: 'bold' }))).toContain(
      'width="32"'
    )
  })

  // Plan 149: Golem's icon is the real emblem image, kept inside an <svg> so
  // icon slots that size and lay out through `svg` selectors still apply.
  it('draws Golem as the real emblem image inside an svg, whatever the weight', () => {
    const markup = (weight?: AppIconProps['weight']): string =>
      renderToStaticMarkup(createElement(GolemIcon, { size: 16, weight, className: 'golem' }))
    const html = markup()
    expect(html).toMatch(/^<svg /)
    expect(html).toContain('viewBox="0 0 256 256"')
    expect(html).toContain('width="16"')
    expect(html).toContain('class="golem"')
    expect(html).toMatch(/<image href="[^"]*golem-emblem-64[^"]*"/)
    expect(html).toContain('preserveAspectRatio="xMidYMid meet"')
    expect(html).not.toContain('<path')
    for (const weight of ['thin', 'light', 'regular', 'duotone', 'fill', 'bold'] as const) {
      expect(markup(weight)).toBe(html)
    }
    expect(renderToStaticMarkup(createElement(GolemIcon))).toContain('width="1em"')
  })
  // Plan 165 (Google's ToS report, III.F.2a): the YouTube mark is YouTube's
  // own file, unmodified, and never drawn shorter than 20px.
  it('draws YouTube as the official icon file, never smaller than 20px', async () => {
    const markup = (props: AppIconProps = {}): string =>
      renderToStaticMarkup(createElement(YoutubeIcon, props))
    const html = markup({ className: 'size-3.5 text-platform-youtube', weight: 'fill' })
    expect(html).toMatch(/^<svg /)
    // Vite inlines the small file as a data URI; either way it is the official art.
    const href = /<image href="([^"]+)"/.exec(html)?.[1] ?? ''
    const image = decodeURIComponent(href.replaceAll('&#x27;', "'"))
    expect(
      image.includes('youtube-icon-red') ||
        (image.includes("fill='rgb(100%, 0%, 19.999695%)'") &&
          image.includes("fill='rgb(100%, 100%, 100%)'"))
    ).toBe(true)
    expect(html).not.toContain('<path')
    expect(html).not.toContain('currentColor')
    expect(html).toContain('data-slot="platform-mark"')
    // The viewBox is the mark's own bounds, so the box height is the mark height.
    expect(html).toContain('viewBox="102.6875 119.167969 396 277.402343"')
    expect(html).toContain('height:20px')
    expect(html).toContain(`width:${Math.round(20 * YOUTUBE_MARK_ASPECT * 100) / 100}px`)
    // A smaller request clamps up; a larger one is honoured.
    expect(markup({ size: 12 })).toContain(`height="${YOUTUBE_MARK_MIN_PX}"`)
    expect(markup({ size: '14' })).toContain(`height="${YOUTUBE_MARK_MIN_PX}"`)
    expect(markup({ size: 32 })).toContain('height="32"')
    for (const weight of ['thin', 'light', 'regular', 'duotone', 'bold'] as const) {
      expect(markup({ className: 'size-3.5 text-platform-youtube', weight })).toBe(html)
    }
  })

  it('ships the YouTube icon byte-for-byte as recorded in its README', async () => {
    const folder = new URL('../assets/brand/youtube/', import.meta.url)
    const svg = await readFile(new URL('youtube-icon-red.svg', folder))
    const readme = await readFile(new URL('README.md', folder), 'utf8')
    const sha256 = createHash('sha256').update(svg).digest('hex')
    expect(readme).toMatch(new RegExp(`Shipped sha256\\s*\\|\\s*\`${sha256}\``))
    const text = svg.toString('utf8')
    // YouTube Red #FF0033 and a white triangle, nothing else.
    expect(text.match(/<path /g)).toHaveLength(2)
    expect(text).toContain('fill="rgb(100%, 0%, 19.999695%)"')
    expect(text).toContain('fill="rgb(100%, 100%, 100%)"')
  })

  // Plan 167: X's mark is the path from X's partner icon kit, pure black or
  // white by theme, never a tint and never a Phosphor glyph.
  it('draws X with the partner kit path in one solid colour', async () => {
    const markup = (props: AppIconProps = {}): string =>
      renderToStaticMarkup(createElement(XPlatformIcon, props))
    const html = markup({ className: 'size-5 text-foreground', weight: 'fill' })
    const kitFile = await readFile(
      new URL('../assets/brand/x/x-logo-white.svg', import.meta.url),
      'utf8'
    )
    const kitPath = /<path d="([^"]+)"/.exec(kitFile)?.[1]
    expect(kitPath).toBe(X_MARK_PATH)
    expect(html.match(/<path /g)).toHaveLength(1)
    expect(html).toContain(`d="${X_MARK_PATH}"`)
    expect(html).toContain('class="fill-black dark:fill-white"')
    expect(html).toContain('viewBox="0 0 24 24"')
    expect(html).toContain('data-platform="x"')
    expect(html).not.toContain('currentColor')
    for (const weight of ['thin', 'light', 'regular', 'duotone', 'bold'] as const) {
      expect(markup({ className: 'size-5 text-foreground', weight })).toBe(html)
    }
  })

  it('ships the X kit files byte-for-byte as recorded in their README', async () => {
    const folder = new URL('../assets/brand/x/', import.meta.url)
    const readme = await readFile(new URL('README.md', folder), 'utf8')
    const files = [
      'x-logo-white.svg',
      'x-logo-lockup-white-on-black.svg',
      'x-logo-lockup-black-on-white.svg',
      'verified-premium-blue.svg',
      'verified-business-gold.svg',
      'verified-government-gray.svg'
    ]
    for (const file of files) {
      const sha256 = createHash('sha256')
        .update(await readFile(new URL(file, folder)))
        .digest('hex')
      const row = readme.split('\n').find((line) => line.startsWith(`| \`${file}\``))
      expect(row, file).toContain(`\`${sha256}\``)
    }
  })

  it('never re-exports a Phosphor glyph as the X mark', async () => {
    const source = await readFile(new URL('./icons.tsx', import.meta.url), 'utf8')
    expect(source).not.toMatch(/\bXLogo\b/)
  })

  it('never re-exports a Phosphor glyph as the YouTube mark', async () => {
    const source = await readFile(new URL('./icons.tsx', import.meta.url), 'utf8')
    expect(source).not.toMatch(/\bYoutubeLogo\b/)
  })
})
