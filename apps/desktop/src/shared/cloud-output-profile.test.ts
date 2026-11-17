import { describe, expect, it } from 'vitest'
import {
  MANAGED_HIGHER_PROFILES,
  managedDestinationProblem,
  managedOutputProblem,
  managedOutputProfile,
  managedProfileDescription,
  parseManagedOutputProfile,
  type ManagedOutput
} from './cloud-output-profile'
import fixture from '../../../../protocol-fixtures/cloud-parity-outputs.json'

describe('S17 managed output vectors (mirrored in the web and the fake web)', () => {
  it.each(fixture.admission)('admits or refuses: $name', (one) => {
    const outputs = one.outputs as ManagedOutput[]
    expect(managedOutputProblem(outputs)).toBe(one.problem)
    if (!one.problem) expect(managedOutputProfile(outputs)).toEqual(one.profile)
  })
  it.each(fixture.destinations)('destination: $name', (one) => {
    expect(
      managedDestinationProblem(
        one.destination as Parameters<typeof managedDestinationProblem>[0],
        one.orientations.map((orientation) => ({
          orientation: orientation as ManagedOutput['orientation']
        }))
      )
    ).toBe(one.problem)
  })
})

describe('S17 truthful profile', () => {
  it('never qualifies a higher profile or states a price', () => {
    expect(MANAGED_HIGHER_PROFILES.every((p) => p.qualification === 'not-run')).toBe(true)
    const profile = managedOutputProfile([
      { orientation: 'horizontal', width: 1920, height: 1080, fps: 60, videoKbps: 8000 }
    ])
    expect(profile.pricePerHour).toBeNull()
    expect(profile.higherProfilesQualified).toBe(false)
    const words = managedProfileDescription(profile)
    expect(words).toContain('30 fps picture in a 60 fps stream')
    expect(words).toContain('differs from your settings')
    expect(words).toContain("1440p and 4K aren't available yet")
    expect(words).not.toMatch(/\$|price|per hour/i)
  })
  it('parses the status field strictly and passes it through whole', () => {
    const profile = managedOutputProfile([
      { orientation: 'horizontal', width: 1920, height: 1080, fps: 30, videoKbps: 6000 },
      { orientation: 'vertical', width: 1080, height: 1920, fps: 30, videoKbps: 6000 }
    ])
    expect(parseManagedOutputProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile)
    for (const broken of [
      { ...profile, pricePerHour: 12 },
      { ...profile, higherProfilesQualified: true },
      { ...profile, qualification: '4k-qualified' },
      { ...profile, effective: [] },
      { ...profile, effective: profile.effective.map((e) => ({ ...e, differences: ['magic'] })) },
      { ...profile, effective: profile.effective.map((e) => ({ ...e, pictureFps: 0 })) }
    ])
      expect(parseManagedOutputProfile(broken)).toBeNull()
  })
  it('a room that reports no profile says so, without guessing one', () => {
    expect(managedProfileDescription(undefined)).toMatch(/didn't report its output profile/)
  })
})
