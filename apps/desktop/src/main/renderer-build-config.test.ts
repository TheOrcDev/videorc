import type { UserConfig } from 'vite'
import { describe, expect, it } from 'vitest'

import config from '../../electron.vite.config'

// PERF-01: electron-vite defaults the renderer to `minify: false`, and the
// renderer asset budget assumed that for months. These pin the production
// renderer to a minified build that keeps names and source maps, so neither
// a config edit nor a new electron-vite default ships 2.4 MB of eager
// unminified JS again, or ships it without readable stacks.
const resolved = config as {
  main?: UserConfig
  preload?: UserConfig
  renderer?: UserConfig
}

describe('production renderer build config', () => {
  it('minifies the renderer with esbuild', () => {
    expect(resolved.renderer?.build?.minify).toBe('esbuild')
  })

  it('keeps function and component names through the minify pass', () => {
    expect(resolved.renderer?.esbuild).toMatchObject({ keepNames: true })
  })

  it('writes source maps without embedding the source', () => {
    expect(resolved.renderer?.build?.sourcemap).toBe(true)
    const output = resolved.renderer?.build?.rollupOptions?.output
    expect(Array.isArray(output) ? output : [output]).toEqual([
      expect.objectContaining({ sourcemapExcludeSources: true })
    ])
  })

  it('keeps all four renderer windows as build inputs', () => {
    const input = resolved.renderer?.build?.rollupOptions?.input as Record<string, string>
    expect(Object.keys(input).sort()).toEqual(['captions', 'comments', 'index', 'notes'])
  })

  it('leaves main and preload on their own defaults', () => {
    expect(resolved.main?.build?.minify).toBeUndefined()
    expect(resolved.preload?.build?.minify).toBeUndefined()
  })
})
