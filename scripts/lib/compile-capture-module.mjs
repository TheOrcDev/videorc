import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const ts = require('../../apps/desktop/node_modules/typescript')

const compilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  esModuleInterop: true
}

/**
 * Compile capture.ts and its runtime shared contract into a disposable tree.
 * The preserved source layout matters: capture.ts intentionally imports the
 * canonical layout-preset arrays from shared/backend at runtime.
 */
export async function compileCaptureModule(tempDir) {
  const modules = [
    {
      source: join(process.cwd(), 'apps/desktop/src/renderer/src/lib/capture.ts'),
      output: join(tempDir, 'apps/desktop/src/renderer/src/lib/capture.cjs')
    },
    {
      source: join(process.cwd(), 'apps/desktop/src/shared/backend.ts'),
      output: join(tempDir, 'apps/desktop/src/shared/backend.js')
    }
  ]

  await Promise.all(
    modules.map(async ({ source, output }) => {
      const transpiled = ts.transpileModule(await readFile(source, 'utf8'), {
        compilerOptions,
        fileName: source
      })
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, transpiled.outputText)
    })
  )

  return modules[0].output
}
