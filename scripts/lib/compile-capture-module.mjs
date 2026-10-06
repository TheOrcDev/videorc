import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { transformSync } from 'esbuild'

/**
 * Compile capture.ts and its runtime dependencies into a disposable tree.
 * The preserved source layout matters: capture.ts intentionally imports the
 * canonical layout-preset arrays from shared/backend at runtime.
 * TypeScript 7 ships tsc without the JavaScript compiler API, so this uses
 * esbuild's type-stripping transform and keeps the same CommonJS layout.
 */
export async function compileCaptureModule(tempDir) {
  const modules = [
    {
      source: join(process.cwd(), 'apps/desktop/src/renderer/src/lib/capture.ts'),
      output: join(tempDir, 'apps/desktop/src/renderer/src/lib/capture.cjs')
    },
    ...['layout-framing-memory', 'backend'].map((name) => ({
      source: join(process.cwd(), `apps/desktop/src/renderer/src/lib/${name}.ts`),
      output: join(tempDir, `apps/desktop/src/renderer/src/lib/${name}.js`)
    })),
    {
      source: join(process.cwd(), 'apps/desktop/src/shared/backend.ts'),
      output: join(tempDir, 'apps/desktop/src/shared/backend.js')
    },
    {
      source: join(process.cwd(), 'apps/desktop/src/renderer/src/lib/layout-framing-memory.ts'),
      output: join(tempDir, 'apps/desktop/src/renderer/src/lib/layout-framing-memory.js')
    },
    {
      source: join(process.cwd(), 'apps/desktop/src/renderer/src/lib/backend.ts'),
      output: join(tempDir, 'apps/desktop/src/renderer/src/lib/backend.js')
    }
  ]

  await Promise.all(
    modules.map(async ({ source, output }) => {
      const transpiled = transformSync(await readFile(source, 'utf8'), {
        loader: 'ts',
        format: 'cjs',
        target: 'es2022',
        sourcefile: source
      })
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, transpiled.code)
    })
  )

  return modules[0].output
}
