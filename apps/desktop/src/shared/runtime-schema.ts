/**
 * Tiny dependency-free runtime schemas for trust boundaries.
 *
 * TypeScript types disappear at runtime. Electron IPC and the backend websocket
 * both receive untrusted JSON, so their public contracts need a parser as well
 * as a compile-time type. These helpers deliberately report only the failing
 * path, never the rejected value (which may contain tokens or local paths).
 */
export class RuntimeSchemaError extends Error {
  constructor(
    readonly path: string,
    readonly expected: string
  ) {
    super(`${path} must be ${expected}.`)
    this.name = 'RuntimeSchemaError'
  }
}

export interface RuntimeSchema<T> {
  readonly description: string
  parse(value: unknown, path?: string): T
}

export type InferRuntimeSchema<TSchema extends RuntimeSchema<unknown>> =
  TSchema extends RuntimeSchema<infer TValue> ? TValue : never

export function runtimeSchema<T>(
  description: string,
  parser: (value: unknown, path: string) => T
): RuntimeSchema<T> {
  return {
    description,
    parse: (value, path = 'value') => parser(value, path)
  }
}

export const unknownValueSchema = runtimeSchema<unknown>('any value', (value) => value)

type BoundedJsonOptions = {
  maxDepth?: number
  maxNodes?: number
  maxArrayLength?: number
  maxObjectKeys?: number
  maxStringLength?: number
  maxTotalStringLength?: number
  allowUndefinedObjectProperties?: boolean
}

/**
 * Validate a JSON-compatible value without invoking accessors or accepting
 * class instances. This is the compatibility boundary for protocol members
 * that have not yet received a field-by-field schema: they remain bounded and
 * serialization-safe instead of passing arbitrary renderer/backend objects.
 */
export function boundedJsonValueSchema(options: BoundedJsonOptions = {}) {
  const maxDepth = options.maxDepth ?? 64
  const maxNodes = options.maxNodes ?? 100_000
  const maxArrayLength = options.maxArrayLength ?? 50_000
  const maxObjectKeys = options.maxObjectKeys ?? 10_000
  const maxStringLength = options.maxStringLength ?? 1_000_000
  const maxTotalStringLength = options.maxTotalStringLength ?? 16_000_000
  const allowUndefinedObjectProperties = options.allowUndefinedObjectProperties ?? false

  return runtimeSchema<unknown>('a bounded JSON value', (value, path) => {
    const seen = new WeakSet<object>()
    let nodes = 0
    let totalStringLength = 0

    const consumeString = (text: string, valuePath: string): void => {
      if (text.length > maxStringLength) {
        throw new RuntimeSchemaError(valuePath, `a string of at most ${maxStringLength} characters`)
      }
      totalStringLength += text.length
      if (totalStringLength > maxTotalStringLength) {
        throw new RuntimeSchemaError(
          path,
          `JSON containing at most ${maxTotalStringLength} string characters`
        )
      }
    }

    const visit = (entry: unknown, entryPath: string, depth: number): void => {
      nodes += 1
      if (nodes > maxNodes) {
        throw new RuntimeSchemaError(path, `JSON containing at most ${maxNodes} values`)
      }
      if (depth > maxDepth) {
        throw new RuntimeSchemaError(entryPath, `JSON nested at most ${maxDepth} levels`)
      }

      if (entry === null || typeof entry === 'boolean') return
      if (typeof entry === 'string') {
        consumeString(entry, entryPath)
        return
      }
      if (typeof entry === 'number') {
        if (!Number.isFinite(entry)) {
          throw new RuntimeSchemaError(entryPath, 'a finite JSON number')
        }
        return
      }
      if (typeof entry !== 'object') {
        throw new RuntimeSchemaError(entryPath, 'a JSON-compatible value')
      }
      if (seen.has(entry)) {
        throw new RuntimeSchemaError(entryPath, 'an acyclic JSON value')
      }
      seen.add(entry)

      if (Array.isArray(entry)) {
        if (entry.length > maxArrayLength) {
          throw new RuntimeSchemaError(entryPath, `an array with at most ${maxArrayLength} items`)
        }
        for (let index = 0; index < entry.length; index += 1) {
          if (!Object.hasOwn(entry, index)) {
            throw new RuntimeSchemaError(`${entryPath}[${index}]`, 'a defined JSON value')
          }
          visit(entry[index], `${entryPath}[${index}]`, depth + 1)
        }
        seen.delete(entry)
        return
      }

      const prototype = Object.getPrototypeOf(entry)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new RuntimeSchemaError(entryPath, 'a plain JSON object')
      }
      const keys = Reflect.ownKeys(entry)
      if (keys.length > maxObjectKeys) {
        throw new RuntimeSchemaError(entryPath, `an object with at most ${maxObjectKeys} fields`)
      }
      for (const key of keys) {
        if (typeof key !== 'string') {
          throw new RuntimeSchemaError(entryPath, 'an object with string keys')
        }
        consumeString(key, `${entryPath}.${key}`)
        const descriptor = Object.getOwnPropertyDescriptor(entry, key)
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new RuntimeSchemaError(`${entryPath}.${key}`, 'an enumerable data field')
        }
        // JSON.stringify omits undefined object fields. Renderer request
        // objects commonly materialize optional fields this way, so the
        // request-boundary variant may accept them without permitting
        // undefined backend results/events or undefined array elements.
        if (descriptor.value === undefined && allowUndefinedObjectProperties) {
          continue
        }
        visit(descriptor.value, `${entryPath}.${key}`, depth + 1)
      }
      seen.delete(entry)
    }

    visit(value, path, 0)
    return value
  })
}

export const undefinedSchema = runtimeSchema<undefined>('undefined', (value, path) => {
  if (value !== undefined) throw new RuntimeSchemaError(path, 'undefined')
  return undefined
})

export const booleanSchema = runtimeSchema<boolean>('a boolean', (value, path) => {
  if (typeof value !== 'boolean') throw new RuntimeSchemaError(path, 'a boolean')
  return value
})

export function stringSchema(options: { minLength?: number; maxLength?: number } = {}) {
  return runtimeSchema<string>('a string', (value, path) => {
    if (typeof value !== 'string') throw new RuntimeSchemaError(path, 'a string')
    if (options.minLength !== undefined && value.length < options.minLength) {
      throw new RuntimeSchemaError(path, `a string of at least ${options.minLength} characters`)
    }
    if (options.maxLength !== undefined && value.length > options.maxLength) {
      throw new RuntimeSchemaError(path, `a string of at most ${options.maxLength} characters`)
    }
    return value
  })
}

export function numberSchema(options: { integer?: boolean; min?: number; max?: number } = {}) {
  return runtimeSchema<number>('a finite number', (value, path) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RuntimeSchemaError(path, 'a finite number')
    }
    if (options.integer && !Number.isInteger(value)) {
      throw new RuntimeSchemaError(path, 'an integer')
    }
    if (options.min !== undefined && value < options.min) {
      throw new RuntimeSchemaError(path, `a number greater than or equal to ${options.min}`)
    }
    if (options.max !== undefined && value > options.max) {
      throw new RuntimeSchemaError(path, `a number less than or equal to ${options.max}`)
    }
    return value
  })
}

export function literalSchema<const TValue extends string | number | boolean | null>(
  literal: TValue
) {
  return runtimeSchema<TValue>(JSON.stringify(literal), (value, path) => {
    if (value !== literal) throw new RuntimeSchemaError(path, JSON.stringify(literal))
    return literal
  })
}

export function enumSchema<const TValues extends readonly [string, ...string[]]>(values: TValues) {
  const allowed = new Set<string>(values)
  return runtimeSchema<TValues[number]>(`one of ${values.join(', ')}`, (value, path) => {
    if (typeof value !== 'string' || !allowed.has(value)) {
      throw new RuntimeSchemaError(path, `one of ${values.join(', ')}`)
    }
    return value as TValues[number]
  })
}

export function optionalSchema<T>(schema: RuntimeSchema<T>) {
  return runtimeSchema<T | undefined>(`${schema.description} or undefined`, (value, path) =>
    value === undefined ? undefined : schema.parse(value, path)
  )
}

export function nullableSchema<T>(schema: RuntimeSchema<T>) {
  return runtimeSchema<T | null>(`${schema.description} or null`, (value, path) =>
    value === null ? null : schema.parse(value, path)
  )
}

export function arraySchema<T>(item: RuntimeSchema<T>, options: { maxLength?: number } = {}) {
  return runtimeSchema<T[]>('an array', (value, path) => {
    if (!Array.isArray(value)) throw new RuntimeSchemaError(path, 'an array')
    if (options.maxLength !== undefined && value.length > options.maxLength) {
      throw new RuntimeSchemaError(path, `an array with at most ${options.maxLength} items`)
    }
    return value.map((entry, index) => item.parse(entry, `${path}[${index}]`))
  })
}

export function tupleSchema<const TSchemas extends readonly RuntimeSchema<unknown>[]>(
  schemas: TSchemas
) {
  type TupleValue = { -readonly [TIndex in keyof TSchemas]: InferRuntimeSchema<TSchemas[TIndex]> }
  return runtimeSchema<TupleValue>('a fixed-length argument list', (value, path) => {
    if (!Array.isArray(value) || value.length !== schemas.length) {
      throw new RuntimeSchemaError(path, `an argument list of length ${schemas.length}`)
    }
    return schemas.map((schema, index) =>
      schema.parse(value[index], `${path}[${index}]`)
    ) as TupleValue
  })
}

type ObjectShape = Readonly<Record<string, RuntimeSchema<unknown>>>

export function objectSchema<const TShape extends ObjectShape>(
  shape: TShape,
  options: { allowUnknown?: boolean } = {}
) {
  type ObjectValue = { [TKey in keyof TShape]: InferRuntimeSchema<TShape[TKey]> }
  return runtimeSchema<ObjectValue>('an object', (value, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new RuntimeSchemaError(path, 'an object')
    }
    const record = value as Record<string, unknown>
    if (!options.allowUnknown) {
      for (const key of Object.keys(record)) {
        if (!(key in shape)) throw new RuntimeSchemaError(`${path}.${key}`, 'a known field')
      }
    }
    const result: Record<string, unknown> = {}
    for (const [key, schema] of Object.entries(shape)) {
      const parsed = schema.parse(record[key], `${path}.${key}`)
      // Preserve JSON wire shape: optional fields absent from the payload must
      // remain absent rather than being materialized as `key: undefined`.
      if (key in record || parsed !== undefined) {
        result[key] = parsed
      }
    }
    return result as ObjectValue
  })
}

export function unionSchema<const TSchemas extends readonly RuntimeSchema<unknown>[]>(
  schemas: TSchemas
) {
  type UnionValue = InferRuntimeSchema<TSchemas[number]>
  return runtimeSchema<UnionValue>('a supported union member', (value, path) => {
    for (const schema of schemas) {
      try {
        return schema.parse(value, path) as UnionValue
      } catch (error) {
        if (!(error instanceof RuntimeSchemaError)) throw error
      }
    }
    throw new RuntimeSchemaError(path, 'a supported union member')
  })
}

export function recordSchema<T>(valueSchema: RuntimeSchema<T>, options: { maxKeys?: number } = {}) {
  return runtimeSchema<Record<string, T>>('an object record', (value, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new RuntimeSchemaError(path, 'an object record')
    }
    const entries = Object.entries(value)
    if (options.maxKeys !== undefined && entries.length > options.maxKeys) {
      throw new RuntimeSchemaError(path, `an object record with at most ${options.maxKeys} keys`)
    }
    return Object.fromEntries(
      entries.map(([key, entry]) => [key, valueSchema.parse(entry, `${path}.${key}`)])
    )
  })
}
