import { accessSync, constants, readdirSync } from 'node:fs'
import { join } from 'node:path'

const releaseDir = process.argv[2] || 'apps/desktop/release'
const required = [
  /^videorc-.*-linux-.*\.deb$/i,
  /linux-build-info\.json$/i,
  /linux-capabilities\.json$/i,
  /THIRD-PARTY-NOTICES\.txt$/i,
  /\.sha256$/i
]

function hasMatch(pattern) {
  if (!readdirSync(releaseDir, { withFileTypes: true }).some((entry) => pattern.test(entry.name))) {
    return false
  }
  return true
}

for (const pattern of required) {
  if (!hasMatch(pattern)) {
    console.error(`missing required artifact matching ${pattern}`)
    process.exit(1)
  }
}

try {
  // Basic proof that these files are readable as a health check.
  for (const dirent of readdirSync(releaseDir, { withFileTypes: true })) {
    accessSync(join(releaseDir, dirent.name), constants.R_OK)
  }
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

console.log(`linux-artifacts: OK in ${releaseDir}`)
