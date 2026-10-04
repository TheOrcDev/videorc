import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CameraIcon, StudioIcon, BrainIcon, KickIcon, OrcleIcon, type AppIconProps } from './icons'

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

  // Plan 119: Orcle's hand-drawn mark follows its Phosphor neighbours' weights,
  // so the sidebar's regular-to-fill swap still reads.
  it('draws Orcle as an outline, a duotone or a solid head in currentColor', () => {
    const markup = (weight?: AppIconProps['weight']): string =>
      renderToStaticMarkup(createElement(OrcleIcon, { size: 16, weight, className: 'orcle' }))
    const outline = markup()
    expect(outline).toContain('viewBox="0 0 256 256"')
    expect(outline).toContain('width="16"')
    expect(outline).toContain('fill="currentColor"')
    expect(outline).toContain('class="orcle"')
    expect(outline).not.toContain('opacity')
    expect(markup('regular')).toBe(outline)
    expect(markup('light')).toBe(outline)
    expect(markup('thin')).toBe(outline)
    expect(markup('fill')).not.toBe(outline)
    expect(markup('bold')).toBe(markup('fill'))
    expect(markup('duotone')).toContain('opacity="0.2"')
    expect(markup('duotone')).toContain(outline.match(/fill-rule="evenodd" d="[^"]+"/)?.[0])
  })
})
