// @vitest-environment happy-dom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThumbnailField } from './thumbnail-field'

// QA F20: after a preview error, choosing the same image again imports fine,
// but the content id (SHA-256 of the bytes) is unchanged, so the field kept
// saying the file is missing and never tried the preview again.

const OLD_ID = 'a'.repeat(64)

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function mountBroken(importedId: string): Promise<void> {
  Object.assign(window, {
    videorc: {
      importScheduledThumbnail: vi.fn(async () => ({ id: importedId, width: 1280, height: 720 }))
    }
  })
  function Fixture() {
    const [id, setId] = useState<string | null>(OLD_ID)
    return createElement(ThumbnailField, {
      assetId: id,
      alt: 'Thumbnail',
      hint: '',
      onChange: setId
    })
  }
  await act(async () => root.render(createElement(Fixture)))
  await act(async () => container.querySelector('img')!.dispatchEvent(new Event('error')))
  expect(container.textContent).toContain('The thumbnail file is missing. Choose it again.')
  expect(container.querySelector('img')).toBeNull()
}

async function replace(): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((entry) =>
    entry.textContent?.includes('Replace thumbnail')
  )!
  await act(async () => button.click())
}

describe('ThumbnailField after a missing preview', () => {
  for (const [label, importedId] of [
    ['the same image', OLD_ID],
    ['a different image', 'b'.repeat(64)]
  ] as const) {
    it(`shows the preview again when ${label} is chosen`, async () => {
      await mountBroken(importedId)
      await replace()
      expect(container.textContent).not.toContain('The thumbnail file is missing')
      expect(container.querySelector('img')).not.toBeNull()
    })
  }
})
