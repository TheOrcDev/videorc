import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import {
  PROOF_SURFACE_CONTENT_LIVE_LINE,
  PROOF_SURFACE_CONTENT_NONE_LINE,
  PROOF_SURFACE_CONTENT_RUNTIME_SCRIPT,
  PROOF_SURFACE_VIEW_BASE,
  PROOF_SURFACE_VIEW_CLEAR,
  proofSurfaceContentFromConsoleLine,
  proofSurfaceViewBackground
} from './proof-surface-content'
import { PREVIEW_SURFACE_LIVE_BACKGROUND_CONSOLE_PREFIX } from './preview-surface-live-background'

describe('proofSurfaceContentFromConsoleLine', () => {
  it('reads the two content lines', () => {
    expect(proofSurfaceContentFromConsoleLine('[proof-preview] content live')).toBe(true)
    expect(proofSurfaceContentFromConsoleLine('[proof-preview] content none')).toBe(false)
    expect(proofSurfaceContentFromConsoleLine(PROOF_SURFACE_CONTENT_LIVE_LINE)).toBe(true)
    expect(proofSurfaceContentFromConsoleLine(PROOF_SURFACE_CONTENT_NONE_LINE)).toBe(false)
  })

  it('ignores every other line the surface or the log may print', () => {
    for (const line of [
      '',
      'content live',
      '[proof-preview] content',
      '[proof-preview] content ',
      '[proof-preview] content live ',
      ' [proof-preview] content live',
      '[proof-preview] content LIVE',
      '[proof-preview] content live now',
      '[proof-preview] content unknown',
      '[proof-preview] source frame delivery is live',
      '[proof-preview] presentation watchdog is live',
      '[proof-preview] live background silk (satin) is moving',
      '[proof-preview] live background silk (satin) shows its poster, reason no-gpu',
      `${PREVIEW_SURFACE_LIVE_BACKGROUND_CONSOLE_PREFIX}null`,
      `${PREVIEW_SURFACE_LIVE_BACKGROUND_CONSOLE_PREFIX}{"id":"silk","look":"satin","rendering":"shader"}`,
      'Uncaught TypeError: content live'
    ]) {
      expect(proofSurfaceContentFromConsoleLine(line), line).toBeNull()
    }
  })
})

describe('proofSurfaceViewBackground', () => {
  it('is clear until the page has content, then the opaque base', () => {
    expect(proofSurfaceViewBackground(false)).toBe('#00000000')
    expect(proofSurfaceViewBackground(true)).toBe('#101014')
    expect(PROOF_SURFACE_VIEW_CLEAR).toBe('#00000000')
    expect(PROOF_SURFACE_VIEW_BASE).toBe('#101014')
  })
})

type FakeLayer = { image?: { dataset: { live?: string; loaded?: string } }; kind?: string }
type FakeLiveBackground = { canvas: { dataset: { drawn?: string } } | null }

// The same code the proof document inlines, over the two maps it reads.
function runtime() {
  const layers = new Map<string, FakeLayer>()
  const liveBackgrounds = new Map<string, FakeLiveBackground>()
  const body = { dataset: {} as Record<string, string> }
  const info = vi.fn()
  const glue = new Function(
    'layers',
    'liveBackgrounds',
    'document',
    'console',
    `${PROOF_SURFACE_CONTENT_RUNTIME_SCRIPT}\nreturn { proofSurfaceHasContent, publishProofSurfaceContent };`
  )(layers, liveBackgrounds, { body }, { info }) as {
    proofSurfaceHasContent: () => boolean
    publishProofSurfaceContent: () => void
  }
  return {
    ...glue,
    layers,
    liveBackgrounds,
    body,
    lines: () => info.mock.calls.map(([line]) => String(line))
  }
}

describe('proof surface content runtime', () => {
  it('starts with none and prints nothing until a layer is live', () => {
    const page = runtime()
    page.publishProofSurfaceContent()
    page.layers.set('camera', { image: { dataset: { live: '0' } } })
    page.publishProofSurfaceContent()

    expect(page.proofSurfaceHasContent()).toBe(false)
    expect(page.lines()).toEqual([])
    expect(page.body.dataset.proofContent).toBeUndefined()
  })

  it('prints one line per change, in the words main reads', () => {
    const page = runtime()
    const camera = { image: { dataset: { live: '0' } } }
    page.layers.set('camera', camera)

    camera.image.dataset.live = '1'
    page.publishProofSurfaceContent()
    page.publishProofSurfaceContent()
    expect(page.lines()).toEqual(['[proof-preview] content live'])
    expect(page.body.dataset.proofContent).toBe('live')

    // A second live layer changes nothing; losing one of two neither.
    page.layers.set('screen', { image: { dataset: { live: '1' } } })
    page.publishProofSurfaceContent()
    camera.image.dataset.live = '0'
    page.publishProofSurfaceContent()
    expect(page.lines()).toEqual(['[proof-preview] content live'])

    page.layers.delete('screen')
    page.publishProofSurfaceContent()
    page.publishProofSurfaceContent()
    expect(page.lines()).toEqual(['[proof-preview] content live', '[proof-preview] content none'])
    expect(page.body.dataset.proofContent).toBe('none')

    expect(page.lines().map(proofSurfaceContentFromConsoleLine)).toEqual([true, false])
  })

  it('never counts a banner or the Buddy: decoded overlays are not content', () => {
    const page = runtime()
    page.layers.set('banner:1', { kind: 'banner', image: { dataset: { loaded: '1' } } })
    page.layers.set('buddy', { kind: 'buddy', image: { dataset: { loaded: '1', live: '0' } } })
    page.publishProofSurfaceContent()

    expect(page.proofSurfaceHasContent()).toBe(false)
    expect(page.lines()).toEqual([])
  })

  it('counts a live background whose canvas drew before its poster decoded', () => {
    const page = runtime()
    const canvas = { dataset: { drawn: '0' } }
    page.layers.set('background:live-silk', { image: { dataset: { live: '0' } } })
    page.liveBackgrounds.set('background:live-silk', { canvas })
    page.publishProofSurfaceContent()
    expect(page.lines()).toEqual([])

    canvas.dataset.drawn = '1'
    page.publishProofSurfaceContent()
    expect(page.lines()).toEqual(['[proof-preview] content live'])

    // A lost context drops the canvas; with no poster there is nothing left.
    page.liveBackgrounds.set('background:live-silk', { canvas: null })
    page.publishProofSurfaceContent()
    expect(page.lines()).toEqual(['[proof-preview] content live', '[proof-preview] content none'])
  })

  it('tolerates a layer entry with no image', () => {
    const page = runtime()
    page.layers.set('odd', {})
    expect(page.proofSurfaceHasContent()).toBe(false)
  })
})

// The document in main/index.ts, without starting Electron: its stylesheet is
// read the way preview-surface-overlay-reveal.test.ts reads it.
const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const documentSource = indexSource.slice(
  indexSource.indexOf('function nativePreviewSurfaceHtml('),
  indexSource.indexOf('function surfaceWindowPlacement(')
)

function proofSurfaceStylesheet(): string {
  const start = documentSource.indexOf('<style>') + '<style>'.length
  return documentSource.slice(start, documentSource.indexOf('</style>', start))
}

type Rule = { selectors: string[]; declarations: string }

function rulesOf(css: string): Rule[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1].split(',').map((selector) => selector.trim()),
    declarations: match[2]
  }))
}

// `html`, `body` and `body.some-state`: the page itself, never a descendant.
const PAGE_SELECTOR = /^(html|body)(\.[\w-]+)*$/

function pageRules(css: string): Rule[] {
  return rulesOf(css).filter((rule) => rule.selectors.some((s) => PAGE_SELECTOR.test(s)))
}

function backgroundDeclarations(rule: Rule): string[] {
  return rule.declarations
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => /^background(-[\w-]+)?\s*:/.test(declaration))
}

const BACKDROP_VARIABLES = ['--dot-x', '--offset', '--stripe-offset', '--stripe-size']

// Before its first frame the proof surface showed a moving blue and green
// gradient with white stripes and a dot. The page paints nothing of its own.
describe('proof surface document backdrop (main/index.ts)', () => {
  it('finds the document and its one stylesheet', () => {
    expect(documentSource).toContain('<div id="scene-root"></div>')
    expect(documentSource.match(/<style\b/g)).toHaveLength(1)
    expect(proofSurfaceStylesheet()).toContain('#scene-root {')
  })

  it('gives the page a transparent background and nothing else, in every state', () => {
    const rules = pageRules(proofSurfaceStylesheet())
    expect(rules.map((rule) => rule.selectors.join(', '))).toEqual(['html, body', 'body'])
    for (const rule of rules) {
      expect(backgroundDeclarations(rule)).toEqual(['background: transparent'])
      expect(rule.declarations).not.toContain('radial-gradient(')
      expect(rule.declarations).not.toContain('repeating-linear-gradient(')
      expect(rule.declarations).not.toMatch(/gradient\(/)
    }
  })

  it('would catch the old backdrop', () => {
    const old = `body { background: radial-gradient(circle at var(--dot-x, 10%) 50%, #fff, transparent 20%); }
      body.surface-live { background: transparent; }`
    const [body, live] = pageRules(old)
    expect(body.declarations).toMatch(/gradient\(/)
    expect(backgroundDeclarations(live)).toEqual(['background: transparent'])
  })

  it('keeps none of the backdrop variables, in the stylesheet or the script', () => {
    for (const variable of BACKDROP_VARIABLES) {
      expect(documentSource, variable).not.toContain(variable)
    }
    expect(documentSource).not.toContain('radial-gradient(')
    expect(documentSource).not.toContain('body.style.setProperty(')
  })

  it('inlines the content glue and reports from every path that changes what is drawn', () => {
    expect(documentSource).toContain('${PROOF_SURFACE_CONTENT_RUNTIME_SCRIPT}')
    expect(documentSource.match(/publishProofSurfaceContent\(\);/g)).toHaveLength(5)
  })
})
