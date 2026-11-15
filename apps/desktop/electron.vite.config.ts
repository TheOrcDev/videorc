import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { build as viteBuild } from 'vite'

import {
  BUILD_FLAGS_FILE_NAME,
  packagedTestHooksBuildEnabled
} from './src/main/packaged-test-hooks'
import {
  RENDERER_DOCUMENT_CSP,
  rendererDocumentCspWithScriptHash
} from './src/shared/renderer-security-policy'

const reactRefreshPreamble = react.preambleCode.replace('__BASE__', '/')
const reactRefreshPreambleHash = createHash('sha256').update(reactRefreshPreamble).digest('base64')
const smokeRendererEvaluationAllowed =
  process.env.VIDEORC_SMOKE_COMMAND_SERVER === '1' ||
  process.env.VIDEORC_SMOKE_PREVIEW_MOTION === '1'
const rendererDevelopmentCsp = rendererDocumentCspWithScriptHash(
  reactRefreshPreambleHash,
  smokeRendererEvaluationAllowed
)
const developmentRendererCspPlugin = {
  name: 'videorc-development-renderer-csp',
  apply: 'serve' as const,
  transformIndexHtml(html: string): string {
    // A response CSP cannot relax the production meta policy because browsers
    // enforce both. Keep the dev meta and response header identical; production
    // builds retain the checked-in strict policy without the smoke exception.
    return html.replace(RENDERER_DOCUMENT_CSP, rendererDevelopmentCsp)
  }
}

// A packaged test build (VIDEORC_PACKAGED_TEST_HOOKS=1) keeps the CDP port and
// native module overrides; release builds refuse them (packaged-test-hooks.ts).
// The flags file lets `pnpm check:packaged-app` prove which one an artifact is.
const packagedTestHooks = packagedTestHooksBuildEnabled(process.env)
const buildFlagsPlugin = {
  name: 'videorc-build-flags',
  generateBundle(this: {
    emitFile(file: { type: 'asset'; fileName: string; source: string }): string
  }): void {
    this.emitFile({
      type: 'asset',
      fileName: BUILD_FLAGS_FILE_NAME,
      source: `${JSON.stringify({ packagedTestHooks })}\n`
    })
  }
}

// The key HUD's window (plan 231 D20) is its own small build, after the
// Studio's. As a fifth input it would share React components with the Studio,
// and Rollup would cut the Studio's eager chunks again (about 2.9 KB more
// gzip in the eager budget). The dev server serves its page as it is.
const sceneHudBuildPlugin = {
  name: 'videorc-scene-hud-build',
  apply: 'build' as const,
  async closeBundle(): Promise<void> {
    await viteBuild({
      configFile: false,
      root: resolve('src/renderer'),
      base: './',
      logLevel: 'warn',
      resolve: { alias: { '@': resolve('src/renderer/src') } },
      plugins: [react(), tailwindcss()],
      // The Studio's minify settings (below): names kept, linked maps without sources.
      esbuild: { keepNames: true },
      build: {
        outDir: resolve('out/renderer'),
        emptyOutDir: false,
        minify: 'esbuild',
        sourcemap: true,
        rollupOptions: {
          output: { sourcemapExcludeSources: true },
          input: { 'scene-hud': resolve('src/renderer/scene-hud.html') }
        }
      }
    })
  }
}

export default defineConfig({
  main: {
    define: {
      __VIDEORC_PACKAGED_TEST_HOOKS__: JSON.stringify(packagedTestHooks)
    },
    plugins: [externalizeDepsPlugin(), buildFlagsPlugin]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: resolve('src/renderer'),
    server: {
      // Vite injects React Refresh before the document's CSP meta tag. A
      // response header enforces the policy from byte zero; only that exact
      // static preamble receives a hash exception in development.
      headers: {
        'Content-Security-Policy': rendererDevelopmentCsp
      }
    },
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [developmentRendererCspPlugin, react(), tailwindcss(), sceneHudBuildPlugin],
    // Only the production minify pass reads this: Vite turns keepNames off in
    // its TS transform, so dev is unchanged. Mangled functions keep their
    // `.name`, which V8 uses for stack frames, so `error.stack`, React's
    // component stack ("Copy details") and render-crash logs keep real names.
    esbuild: {
      keepNames: true
    },
    build: {
      // electron-vite defaults the renderer to `minify: false`. Main and
      // preload stay unminified (their own defaults).
      minify: 'esbuild',
      // A `.js.map` beside each chunk for DevTools and for resolving a pasted
      // stack: mappings and names only. The source is the release tag.
      sourcemap: true,
      rollupOptions: {
        output: {
          sourcemapExcludeSources: true
        },
        input: {
          index: resolve('src/renderer/index.html'),
          comments: resolve('src/renderer/comments.html'),
          captions: resolve('src/renderer/captions.html'),
          notes: resolve('src/renderer/notes.html')
        }
      }
    }
  }
})
