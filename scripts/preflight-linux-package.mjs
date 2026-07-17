import { runLinuxPackagePreflight } from './lib/linux-package-preflight.mjs'

const code = runLinuxPackagePreflight(process.argv)
if (code !== 0) {
  process.exit(code)
}
