import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const advisoryDatabaseUrl = 'https://github.com/RustSec/advisory-db.git'

// Informational "unmaintained" notices only, never a vulnerability. Each entry
// names the dependency that pulls it in, so it can be dropped once that moves.
export const acceptedUnmaintainedAdvisories = [
  // zvariant, zbus_names and zvariant_derive were folded into zbus 6. They reach
  // us only through ashpd 0.13 (Linux screencast portal), which still depends on
  // zbus 5. Remove these once an ashpd release on zbus 6 is adopted.
  { id: 'RUSTSEC-2026-0370', crate: 'zvariant', via: 'ashpd 0.13 -> zbus 5' },
  { id: 'RUSTSEC-2026-0371', crate: 'zbus_names', via: 'ashpd 0.13 -> zbus 5' },
  { id: 'RUSTSEC-2026-0372', crate: 'zvariant_derive', via: 'ashpd 0.13 -> zbus 5' }
]

export function rustAuditCommands({ databasePath, databaseExists }) {
  const refresh = databaseExists
    ? ['git', ['-C', databasePath, 'pull', '--ff-only', '--quiet']]
    : ['git', ['clone', '--quiet', advisoryDatabaseUrl, databasePath]]
  // --no-fetch also prevents cargo-audit from populating the crates.io index.
  // Hydrate every locked target first so fresh CI runners can check yanked crates.
  return [
    refresh,
    ['cargo', ['fetch', '--locked']],
    [
      'cargo',
      [
        'audit',
        '--db',
        databasePath,
        '--no-fetch',
        '--deny',
        'warnings',
        ...acceptedUnmaintainedAdvisories.flatMap(({ id }) => ['--ignore', id])
      ]
    ]
  ]
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
