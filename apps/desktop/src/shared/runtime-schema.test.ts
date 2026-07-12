import { describe, expect, it } from 'vitest'

import {
  RuntimeSchemaError,
  boundedJsonValueSchema,
  numberSchema,
  objectSchema,
  optionalSchema,
  stringSchema
} from './runtime-schema'

describe('runtime schemas', () => {
  it('reports the contract path without echoing rejected secrets', () => {
    const schema = objectSchema(
      {
        token: stringSchema({ minLength: 16 }),
        port: numberSchema({ integer: true, min: 1, max: 65_535 }),
        label: optionalSchema(stringSchema({ maxLength: 20 }))
      },
      { allowUnknown: false }
    )
    const secret = 'do-not-print-this-secret'

    let error: unknown
    try {
      schema.parse({ token: secret, port: Number.NaN })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(RuntimeSchemaError)
    expect(String(error)).toContain('value.port')
    expect(String(error)).not.toContain(secret)
  })

  it('rejects unknown fields at strict trust boundaries', () => {
    const schema = objectSchema({ enabled: optionalSchema(stringSchema()) })
    expect(() => schema.parse({ enabled: 'yes', executable: true })).toThrow(
      'value.executable must be a known field'
    )
  })

  it('accepts bounded JSON and rejects cycles, accessors, sparse arrays, and excess depth', () => {
    const schema = boundedJsonValueSchema({ maxDepth: 2, maxNodes: 10 })
    expect(schema.parse({ nested: [true, null, 1, 'ok'] })).toEqual({
      nested: [true, null, 1, 'ok']
    })

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => schema.parse(cyclic)).toThrow('acyclic JSON value')

    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => 'must-not-run'
    })
    expect(() => schema.parse(accessor)).toThrow('enumerable data field')

    const sparse = Array(1)
    expect(() => schema.parse(sparse)).toThrow('defined JSON value')
    expect(() => schema.parse({ a: { b: { c: true } } })).toThrow('nested at most 2 levels')
  })

  it('can accept JSON-omitted undefined object fields only for request boundaries', () => {
    const strict = boundedJsonValueSchema()
    const request = boundedJsonValueSchema({ allowUndefinedObjectProperties: true })
    const value = { optional: undefined, nested: { optional: undefined } }

    expect(() => strict.parse(value)).toThrow('JSON-compatible value')
    expect(request.parse(value)).toBe(value)
    expect(() => request.parse([undefined])).toThrow('JSON-compatible value')
  })
})
