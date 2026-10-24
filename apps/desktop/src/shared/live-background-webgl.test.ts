import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// The runner is a plain script the preview surface inlines; evaluate it the
// same way, against a stand-in global.
type Runner = {
  internalSize: (render: unknown, id: string, output: number[], level: string) => number[]
  silkFieldSize: (view: number[]) => number[]
  plasmaSizes: (
    render: unknown,
    view: number[]
  ) => { coarse: number[]; fine: number[]; down: number[][] }
  packUniforms: (
    look: unknown,
    target: number[],
    view: number[],
    phase: number,
    dim: number
  ) => Float32Array
}

const source = readFileSync(new URL('./live-background-webgl.js', import.meta.url), 'utf8')
const sandbox: { VideorcLiveBackground?: Runner } = {}
new Function('globalThis', source)(sandbox)
const runner = sandbox.VideorcLiveBackground!

type Render = {
  backgrounds: { id: string; looks: { id: string; statics: number[][] }[] }[]
  sizeCases: {
    internal: { id: string; output: number[]; level: string; view: number[] }[]
    plasma: { view: number[]; coarse: number[]; fine: number[]; down: number[][] }[]
    silkField: { view: number[]; field: number[] }[]
  }
  uniformCases: {
    id: string
    look: string
    target: number[]
    view: number[]
    phase: number
    dim: number
    packed: number[][]
  }[]
}

const render = JSON.parse(
  readFileSync(new URL('./live-backgrounds.render.generated.json', import.meta.url), 'utf8')
) as Render

describe('live background WebGL runner (plan 190)', () => {
  it('sizes every pass exactly like the backend', () => {
    for (const entry of render.sizeCases.internal) {
      expect(runner.internalSize(render, entry.id, entry.output, entry.level)).toStrictEqual(
        entry.view
      )
    }
    for (const entry of render.sizeCases.plasma) {
      expect(runner.plasmaSizes(render, entry.view)).toStrictEqual({
        coarse: entry.coarse,
        fine: entry.fine,
        down: entry.down
      })
    }
    for (const entry of render.sizeCases.silkField) {
      expect(runner.silkFieldSize(entry.view)).toStrictEqual(entry.field)
    }
  })

  it('packs uniforms exactly like the backend', () => {
    expect(render.uniformCases.length).toBeGreaterThan(0)
    for (const entry of render.uniformCases) {
      const background = render.backgrounds.find((candidate) => candidate.id === entry.id)!
      const look = background.looks.find((candidate) => candidate.id === entry.look)!
      const packed = runner.packUniforms(look, entry.target, entry.view, entry.phase, entry.dim)
      expect(Array.from(packed)).toStrictEqual(Array.from(new Float32Array(entry.packed.flat())))
    }
  })

  it('carries the React Bits credit', () => {
    expect(source).toContain('React Bits by David Haz')
  })
})
