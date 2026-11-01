import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, posix } from 'node:path'

const require = createRequire(import.meta.url)
const ts = require('../../apps/desktop/node_modules/typescript')

const compilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  esModuleInterop: true
}

/** Vite's build-time env, as a production build sees it. */
const PRODUCTION_IMPORT_META_ENV = '({ MODE: "production", DEV: false, PROD: true })'

/** The renderer's `@/` alias (electron.vite.config.ts, tsconfig.web.json). */
const RENDERER_ALIAS_ROOT = 'apps/desktop/src/renderer/src'
const ALIAS_SPECIFIER = /(\b(?:require|from|import)\s*\(?\s*)(['"])@\/([^'"]+)\2/g

/**
 * Rewrites `@/…` specifiers to relative ones from `source` (a repository-root
 * path), so Node resolves them in the compiled tree: registry files such as
 * lib/platform import through the alias.
 */
export function withRelativeAliases(code, source) {
  return code.replace(ALIAS_SPECIFIER, (_match, prefix, quote, path) => {
    const target = posix.relative(posix.dirname(source), `${RENDERER_ALIAS_ROOT}/${path}`)
    return `${prefix}${quote}${target.startsWith('.') ? target : `./${target}`}${quote}`
  })
}

/**
 * capture.ts's runtime imports and theirs, from the repository root. Plan 174
 * S1.4 gave capture.ts the formatters and the platform words, and
 * layout-framing-memory the layout labels; a module missing here fails every
 * smoke that compiles capture.ts with "Cannot find module".
 */
const CAPTURE_RUNTIME_DEPENDENCIES = [
  'apps/desktop/src/renderer/src/lib/accelerator.ts',
  'apps/desktop/src/renderer/src/lib/backend.ts',
  'apps/desktop/src/renderer/src/lib/format-video.ts',
  'apps/desktop/src/renderer/src/lib/layout-framing-memory.ts',
  'apps/desktop/src/renderer/src/lib/layout-labels.ts',
  'apps/desktop/src/renderer/src/lib/platform-copy.ts',
  'apps/desktop/src/renderer/src/lib/platform.ts',
  'apps/desktop/src/shared/backend.ts',
  'apps/desktop/src/shared/stream-platforms.ts'
]

async function compileTo(source, output) {
  const transpiled = ts.transpileModule(await readFile(join(process.cwd(), source), 'utf8'), {
    compilerOptions,
    fileName: source
  })
  await mkdir(dirname(output), { recursive: true })
  await writeFile(
    output,
    withRelativeAliases(transpiled.outputText, source).replace(
      /\bimport\.meta\.env\b/g,
      PRODUCTION_IMPORT_META_ENV
    )
  )
}

/**
 * Compile capture.ts and its runtime dependencies into a disposable tree.
 * The preserved source layout matters: capture.ts intentionally imports the
 * canonical layout-preset arrays from shared/backend at runtime.
 */
export async function compileCaptureModule(tempDir) {
  const output = join(tempDir, 'apps/desktop/src/renderer/src/lib/capture.cjs')
  await Promise.all([
    compileTo('apps/desktop/src/renderer/src/lib/capture.ts', output),
    compileRendererModules(tempDir, CAPTURE_RUNTIME_DEPENDENCIES)
  ])
  return output
}

/**
 * Compile renderer modules whose runtime imports are relative or through the
 * `@/` alias (type imports are erased) into a disposable tree, keeping the
 * source layout so those imports resolve. `sources` are paths from the
 * repository root; the result maps each one to its compiled CommonJS file.
 * Vite's `import.meta.env` does not exist outside the bundle (and would make
 * Node load the file as an ES module), so it reads as a production build's.
 */
export async function compileRendererModules(tempDir, sources) {
  const compiled = await Promise.all(
    sources.map(async (source) => {
      const output = join(tempDir, source.replace(/\.tsx?$/, '.js'))
      await compileTo(source, output)
      return [source, output]
    })
  )
  return Object.fromEntries(compiled)
}
