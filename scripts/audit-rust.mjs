import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const advisoryDatabaseUrl = 'https://github.com/RustSec/advisory-db.git'

// Informational "unmaintained" notices only, never a vulnerability. Each entry
// names the dependency that pulls it in and the day it was reviewed, so it can
// be dropped once that moves.
export const acceptedUnmaintainedAdvisories = [
  // zvariant, zbus_names and zvariant_derive were folded into zbus 6. They reach
  // us only through ashpd 0.13 (Linux screencast portal), which still depends on
  // zbus 5. Remove these once an ashpd release on zbus 6 is adopted.
  {
    id: 'RUSTSEC-2026-0370',
    crate: 'zvariant',
    via: 'ashpd 0.13 -> zbus 5',
    reviewed: '2026-10-21'
  },
  {
    id: 'RUSTSEC-2026-0371',
    crate: 'zbus_names',
    via: 'ashpd 0.13 -> zbus 5',
    reviewed: '2026-10-21'
  },
  {
    id: 'RUSTSEC-2026-0372',
    crate: 'zvariant_derive',
    via: 'ashpd 0.13 -> zbus 5',
    reviewed: '2026-10-21'
  },
  // chrono is marked unmaintained for every version, with no patched release
  // (chronotope/chrono#1768); the advisory suggests jiff or time. Zone rules
  // already use jiff. chrono is the backend's time type (100+ files) and also
  // comes in through rmcp and schemars, so moving off it is its own migration,
  // not an audit fix. Remove this once the backend (and rmcp, schemars) leave
  // chrono.
  {
    id: 'RUSTSEC-2026-0543',
    crate: 'chrono',
    via: 'videorc-backend, rmcp 3, schemars 1',
    reviewed: '2026-11-18'
  },
  // The GPUI app's (plan 260) UI stack pulls these in; none has a maintained
  // release to move to and gpui-pre 0.3.14 / gpui-base 0.11.0 pin them. Revisit
  // each on the next gpui-pre or gpui-base bump and drop the ones it no longer
  // brings.
  {
    id: 'RUSTSEC-2024-0384',
    crate: 'instant',
    via: 'gpui-base 0.11.0',
    reviewed: '2026-11-25'
  },
  {
    id: 'RUSTSEC-2024-0436',
    crate: 'paste',
    via: 'gpui-pre 0.3.14 -> image -> ravif -> rav1e',
    reviewed: '2026-11-25'
  },
  {
    id: 'RUSTSEC-2026-0206',
    crate: 'rustybuzz',
    via: 'gpui-pre 0.3.14 -> usvg',
    reviewed: '2026-11-25'
  },
  {
    id: 'RUSTSEC-2026-0192',
    crate: 'ttf-parser',
    via: 'gpui-pre 0.3.14 (direct, and through usvg, fontdb and rustybuzz)',
    reviewed: '2026-11-25'
  }
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
