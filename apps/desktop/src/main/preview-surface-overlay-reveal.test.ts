// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

import { PREVIEW_SURFACE_BUDDY_LAYER_KIND } from './preview-surface-buddy'

// The proof surface (Windows idle, Linux) hides every layer image until it is
// revealed: a source by `data-live`, an overlay by `data-loaded`. These run
// the page's own stylesheet from main/index.ts against the attributes its
// script sets, so an overlay kind the stylesheet forgets stays invisible here.
const here = dirname(fileURLToPath(import.meta.url))

function proofSurfaceStylesheet(): string {
  const source = readFileSync(join(here, 'index.ts'), 'utf8')
  const page = source.slice(source.indexOf('function nativePreviewSurfaceHtml('))
  const start = page.indexOf('<style>') + '<style>'.length
  return page.slice(start, page.indexOf('</style>', start))
}

function layerImage(kind: string, attributes: Record<string, string>): HTMLImageElement {
  const element = document.createElement('div')
  element.className = 'scene-layer'
  element.dataset.kind = kind
  const image = document.createElement('img')
  for (const [name, value] of Object.entries(attributes)) image.setAttribute(name, value)
  element.append(image)
  document.body.append(element)
  return image
}

function opacity(image: HTMLImageElement): string {
  return window.getComputedStyle(image).opacity
}

describe('proof surface stylesheet reveals', () => {
  beforeAll(() => {
    const style = document.createElement('style')
    style.textContent = proofSurfaceStylesheet()
    document.head.append(style)
  })

  it('shows a source once it is live and hides it before', () => {
    expect(opacity(layerImage('camera', {}))).toBe('0')
    expect(opacity(layerImage('camera', { 'data-live': '1' }))).toBe('1')
  })

  it('shows a banner once it has decoded', () => {
    expect(opacity(layerImage('banner', { 'data-loaded': '0' }))).toBe('0')
    expect(opacity(layerImage('banner', { 'data-loaded': '1' }))).toBe('1')
  })

  it("shows the Buddy's layer once a frame has decoded", () => {
    expect(opacity(layerImage(PREVIEW_SURFACE_BUDDY_LAYER_KIND, { 'data-loaded': '0' }))).toBe('0')
    expect(opacity(layerImage(PREVIEW_SURFACE_BUDDY_LAYER_KIND, { 'data-loaded': '1' }))).toBe('1')
  })

  it('never reveals a source on decode alone', () => {
    expect(opacity(layerImage('camera', { 'data-loaded': '1' }))).toBe('0')
  })
})
