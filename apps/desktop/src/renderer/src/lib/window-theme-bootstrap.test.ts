import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const RENDERER_DIR = join(__dirname, '../..')

/**
 * Runs window-theme-bootstrap.js against a fake document whose
 * prefers-color-scheme main drives through nativeTheme.themeSource.
 */
function bootstrap(initiallyDark: boolean): {
  classes: Set<string>
  dataset: Record<string, string>
  setAppTheme: (dark: boolean) => void
} {
  const classes = new Set<string>()
  const dataset: Record<string, string> = {}
  const listeners: Array<() => void> = []
  const query = {
    matches: initiallyDark,
    addEventListener: (_type: string, listener: () => void) => listeners.push(listener)
  }
  runInNewContext(readFileSync(join(RENDERER_DIR, 'window-theme-bootstrap.js'), 'utf8'), {
    window: { matchMedia: () => query },
    document: {
      documentElement: {
        classList: {
          toggle: (name: string, force: boolean) =>
            force ? classes.add(name) : classes.delete(name)
        },
        dataset
      }
    },
    navigator: { platform: 'MacIntel' }
  })
  return {
    classes,
    dataset,
    setAppTheme: (dark) => {
      query.matches = dark
      for (const listener of listeners) listener()
    }
  }
}

describe('window-theme-bootstrap (Stream Manager, Notes, Captions)', () => {
  it('paints the app theme on the first frame', () => {
    expect([...bootstrap(true).classes]).toEqual(['dark'])
    expect([...bootstrap(false).classes]).toEqual(['light'])
  })

  it('follows a theme toggle in the main window live', () => {
    const page = bootstrap(true)
    page.setAppTheme(false)
    expect([...page.classes]).toEqual(['light'])
    page.setAppTheme(true)
    expect([...page.classes]).toEqual(['dark'])
  })

  it('stamps the platform for the Mica coats', () => {
    expect(bootstrap(true).dataset.platform).toBe('darwin')
  })

  it('is loaded by every secondary window, and none hard-codes a theme', () => {
    for (const page of ['comments.html', 'notes.html', 'captions.html']) {
      const html = readFileSync(join(RENDERER_DIR, page), 'utf8')
      expect(html).toContain('<script type="module" src="/window-theme-bootstrap.js"></script>')
      expect(html).toContain('<html lang="en">')
    }
  })
})
