import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const advisoryDatabaseUrl = 'https://github.com/RustSec/advisory-db.git'

export function rustAuditCommands({ databasePath, databaseExists }) {
  const refresh = databaseExists
    ? ['git', ['-C', databasePath, 'pull', '--ff-only', '--quiet']]
    : ['git', ['clone', '--quiet', advisoryDatabaseUrl, databasePath]]
  return [refresh, ['cargo', ['audit', '--db', databasePath, '--no-fetch', '--deny', 'warnings']]]
}

export function auditRustDependencies({
  databasePath = resolve(
    process.env.VIDEORC_RUSTSEC_ADVISORY_DB ??
      join(homedir(), '.cache', 'videorc', 'rustsec-advisory-db')
  ),
  run = execFileSync
} = {}) {
  const databaseExists = existsSync(join(databasePath, '.git'))
  if (!databaseExists && existsSync(databasePath)) {
    throw new Error(`RustSec advisory database path is not a Git repository: ${databasePath}`)
  }

  mkdirSync(dirname(databasePath), { recursive: true })
  for (const [command, args] of rustAuditCommands({ databasePath, databaseExists })) {
    run(command, args, { stdio: 'inherit' })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  auditRustDependencies()
}
