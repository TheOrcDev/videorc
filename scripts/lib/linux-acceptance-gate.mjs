import { readFile } from 'node:fs/promises'

const REQUIRED_FIELDS = [
  {
    key: 'gnome-wayland',
    checks: ['ok', 'evidence'],
    message: 'GNOME Wayland evidence'
  },
  {
    key: 'portal',
    checks: ['ok', 'evidence'],
    message: 'portal probe evidence'
  },
  {
    key: 'pipewire',
    checks: ['ok', 'evidence'],
    message: 'PipeWire capture evidence'
  },
  {
    key: 'screen-capture',
    checks: ['ok', 'evidence'],
    message: 'screen capture evidence'
  },
  {
    key: 'preview',
    checks: ['ok', 'evidence'],
    message: 'preview evidence'
  },
  {
    key: 'encoder',
    checks: ['ok', 'evidence'],
    message: 'encoder validation evidence'
  },
  {
    key: 'final-artifact',
    checks: ['ok', 'evidence'],
    message: 'final artifact analysis evidence'
  },
  {
    key: 'av-sync',
    checks: ['ok', 'evidence'],
    message: 'A/V synchronization evidence'
  },
  {
    key: 'process-cleanup',
    checks: ['ok', 'evidence'],
    message: 'process cleanup evidence'
  },
  {
    key: 'redaction',
    checks: ['ok', 'evidence'],
    message: 'redaction evidence'
  }
]

export function validateLinuxAcceptanceManifest(manifest = {}) {
  const failures = []

  for (const field of REQUIRED_FIELDS) {
    const section = manifest[field.key]
    if (!section) {
      failures.push(`required: ${field.key}`)
      continue
    }

    for (const check of field.checks) {
      if (check === 'ok') {
        if (!section[check]) {
          failures.push(`required: ${field.key}.${check}`)
        }
      } else if (check === 'evidence') {
        if (!Array.isArray(section[check]) || section[check].length === 0) {
          failures.push(`required: ${field.key}.${check}`)
        }
      }
    }

    if (section.ok === false) {
      failures.push(`requested: ${field.key}`)
    }
  }

  return failures
}

export async function runAcceptanceGate(argv = process.argv) {
  const manifestPath = argv[2]
  if (!manifestPath) {
    console.error('Usage: node scripts/lib/linux-acceptance-gate.mjs <manifest.json>')
    process.exitCode = 1
    return 1
  }

  let raw
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch (error) {
    console.error(String(error.message || error))
    process.exitCode = 1
    return 1
  }

  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch (error) {
    console.error(`failed to parse manifest JSON: ${error.message}`)
    process.exitCode = 1
    return 1
  }

  const failures = validateLinuxAcceptanceManifest(manifest)
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure)
    }
    process.exitCode = 1
    return 1
  }

  return 0
}
