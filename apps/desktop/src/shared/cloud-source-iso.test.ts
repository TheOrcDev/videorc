import fixture from '../../../../protocol-fixtures/cloud-source-iso.json'
import { describe, expect, it } from 'vitest'
import { parseIsoManifest, planIsoImport } from './cloud-source-iso'

function patched(pointer: string, value: unknown): unknown {
  const doc = structuredClone(fixture.valid) as Record<string, unknown>
  const parts = pointer.slice(1).split('/')
  let at = doc
  for (const part of parts.slice(0, -1)) at = at[part] as Record<string, unknown>
  at[parts.at(-1) as string] = value
  return doc
}

describe('cloud ISO manifest mirror (Plan 249 S22)', () => {
  it('accepts the shared valid manifest and refuses every shared invalid case', () => {
    expect(parseIsoManifest(fixture.valid)).toEqual(fixture.valid)
    expect(fixture.invalid.length).toBeGreaterThanOrEqual(15)
    for (const c of fixture.invalid) {
      expect(() => parseIsoManifest(patched(c.pointer, c.value)), c.case).toThrow()
    }
  })

  it('plans the same imports as the backend: roles separate, partial labelled', () => {
    const manifest = parseIsoManifest(fixture.valid)
    const plan = planIsoImport(manifest, manifest.createdAtMs + 1)
    expect(plan.map((item) => item.entryId)).toEqual([
      'host/host-camera/g1',
      'host/host-microphone/g1',
      'host/host-microphone/g2',
      'host/host-aux/g1',
      'g_ann/guest-camera/g1'
    ])
    expect(plan.find((item) => item.role === 'host-aux')?.fileName).toBe(
      'tk_AbCdEf123456-iso-host-aux-host-g1.ogg'
    )
    expect(plan[2]?.title).toBe('Host microphone (part 2)')
    // A host camera layout is never trusted in v1, even when its name declares opaque.
    expect(plan[0]?.frameLayout).toBe('unknown')
    expect(plan[0]?.title).toBe('Host camera (layout unknown)')
    expect(plan[4]?.frameLayout).toBe('opaque')
    expect(plan[1]?.frameLayout).toBeNull()
    expect(plan[4]?.title).toBe('Guest camera (partial)')
    expect(plan.map((item) => item.offsetMs)).toEqual([400, 350, 20900, 500, 700])
    expect(planIsoImport(manifest, manifest.expiresAtMs)).toEqual([])
    expect(planIsoImport({ ...manifest, entries: [] }, manifest.createdAtMs + 1)).toEqual([])
  })
})
