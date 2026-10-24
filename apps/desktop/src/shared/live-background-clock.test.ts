import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// The clock is a plain script the preview surface inlines; evaluate it the
// same way, against a stand-in global.
type Spec = {
  id: string
  look: string
  motion: 'calm' | 'normal'
  rate: number
  posterPhase: number
}
type Clock = {
  id: string
  look: string
  rate: number
  anchor: number
  anchorPhase: number
  heldPhase: number | null
}
type ClockModule = {
  start: (spec: Spec, now: number) => Clock
  phaseAt: (clock: Clock, at: number) => number
  update: (clock: Clock, spec: Spec, now: number) => boolean
  hold: (clock: Clock, now: number) => void
  release: (clock: Clock, now: number) => void
}

const source = readFileSync(new URL('./live-background-clock.js', import.meta.url), 'utf8')
const sandbox: { VideorcLiveBackgroundClock?: ClockModule } = {}
new Function('globalThis', source)(sandbox)
const clock = sandbox.VideorcLiveBackgroundClock!

// The looks' numbers come from the backend's export, so the test pins the
// same constants clock.rs's tests use.
const render = JSON.parse(
  readFileSync(new URL('./live-backgrounds.render.generated.json', import.meta.url), 'utf8')
) as { backgrounds: { id: string; looks: { id: string; rate: number; posterPhase: number }[] }[] }

function spec(id: string, look: string, motion: 'calm' | 'normal'): Spec {
  const background = render.backgrounds.find((candidate) => candidate.id === id)!
  const entry = background.looks.find((candidate) => candidate.id === look)!
  return { id, look, motion, rate: entry.rate, posterPhase: entry.posterPhase }
}

describe('live background clock (plan 190, mirrors clock.rs)', () => {
  it('starts at the poster phase, and Calm is half speed', () => {
    const now = 1000
    const calm = clock.start(spec('silk', 'satin', 'calm'), now)
    expect(clock.phaseAt(calm, now)).toBe(3)
    expect(clock.phaseAt(calm, now + 10)).toBeCloseTo(5.5, 9)
    const normal = clock.start(spec('silk', 'satin', 'normal'), now)
    expect(clock.phaseAt(normal, now + 10)).toBeCloseTo(8, 9)
  })

  it('changes look or motion without a jump', () => {
    const now = 1000
    const running = clock.start(spec('silk', 'satin', 'calm'), now)
    const at = now + 7
    const before = clock.phaseAt(running, at)
    expect(clock.update(running, spec('silk', 'midnight', 'normal'), at)).toBe(true)
    expect(clock.phaseAt(running, at)).toBeCloseTo(before, 9)
    // Midnight's speed 3.5 is 0.35 per second at Normal.
    expect(clock.phaseAt(running, at + 1) - before).toBeCloseTo(0.35, 9)
    expect(clock.update(running, spec('silk', 'midnight', 'normal'), at)).toBe(false)
  })

  it('starts another background again at its poster', () => {
    const now = 1000
    const running = clock.start(spec('silk', 'satin', 'calm'), now)
    const later = now + 30
    expect(clock.update(running, spec('plasma-wave', 'ember', 'calm'), later)).toBe(true)
    expect(clock.phaseAt(running, later)).toBe(6)
    expect(running.id).toBe('plasma-wave')
  })

  it('never runs backwards before its anchor', () => {
    const running = clock.start(spec('side-rays', 'sunbeam', 'normal'), 50)
    expect(clock.phaseAt(running, 40)).toBe(15)
  })

  it('holds its phase while hidden and resumes from it without a jump', () => {
    const running = clock.start(spec('side-rays', 'sunbeam', 'normal'), 0)
    clock.hold(running, 4)
    const held = clock.phaseAt(running, 4)
    expect(held).toBeCloseTo(15 + 2.5 * 4, 9)
    expect(clock.phaseAt(running, 60)).toBe(held)
    clock.hold(running, 70)
    expect(clock.phaseAt(running, 70)).toBe(held)
    clock.release(running, 100)
    expect(clock.phaseAt(running, 100)).toBe(held)
    expect(clock.phaseAt(running, 101) - held).toBeCloseTo(2.5, 9)
    // A second release is a no-op.
    clock.release(running, 200)
    expect(clock.phaseAt(running, 200) - held).toBeCloseTo(2.5 * 100, 9)
  })

  it('stays held through a look change and a background change', () => {
    const running = clock.start(spec('silk', 'satin', 'calm'), 0)
    clock.hold(running, 10)
    const held = clock.phaseAt(running, 10)
    clock.update(running, spec('silk', 'midnight', 'calm'), 20)
    expect(clock.phaseAt(running, 30)).toBe(held)
    clock.update(running, spec('line-waves', 'gold', 'calm'), 40)
    expect(clock.phaseAt(running, 50)).toBe(4.5)
    clock.release(running, 60)
    expect(clock.phaseAt(running, 60)).toBe(4.5)
    expect(clock.phaseAt(running, 62) - 4.5).toBeCloseTo(0.75, 9)
  })
})
