import { describe, expect, it } from 'vitest'

/**
 * The main window disables Electron's `backgroundThrottling`, which also
 * freezes the Page Visibility API: `document.visibilityState` stays 'visible'
 * while the window is minimised or hidden and no `visibilitychange` fires.
 * Anything that releases hardware when the window goes away therefore CANNOT
 * be driven by the DOM alone — it needs main's `window:visible`.
 *
 * These pin the wiring that makes that true, because the failure mode is
 * silent: the hook keeps returning `true` forever and the microphone simply
 * never closes.
 */
describe('window visibility wiring', () => {
  it('reads main’s window:visible signal, not just the DOM', async () => {
    const source = await import('node:fs').then(({ readFileSync }) =>
      readFileSync(new URL('./use-document-visible.ts', import.meta.url), 'utf8')
    )
    expect(source).toContain('onWindowVisible')
    // Either source reporting hidden must hide: main knows about minimise,
    // the DOM knows about aux windows and tests.
    expect(source).toMatch(/documentVisible && windowVisible/)
  })

  it('has a main-process publisher for every way the window leaves the screen', async () => {
    const main = await import('node:fs').then(({ readFileSync }) =>
      readFileSync(new URL('../../../main/index.ts', import.meta.url), 'utf8')
    )
    for (const event of ['hide', 'minimize']) {
      expect(main).toContain(`mainWindow.on('${event}', () => publishWindowVisible(false))`)
    }
    for (const event of ['show', 'restore']) {
      expect(main).toContain(`mainWindow.on('${event}', () => publishWindowVisible(true))`)
    }
  })
})
