// The agent tool catalog (plan 209 S1): the TypeScript twin of
// `crates/videorc-backend/src/agent_tools.rs`, read from the one JSON file
// `protocol-fixtures/agent-tools.json`. The renderer's Studio action executor
// (S5/S6), the Settings → Agents section (S7) and the Buddy planner request
// (S19) read it from here; a test on each side pins both loaders to the file.
//
// Pure: no DOM, no Electron, no backend client.

import catalogJson from '../../../../protocol-fixtures/agent-tools.json'

/** D10: about forty tools, never two hundred eighty. */
export const MAX_AGENT_TOOLS = 45
export const MAX_AGENT_TOOL_NAME_CHARS = 40
export const MIN_AGENT_TOOL_DESCRIPTION_CHARS = 40
export const MAX_AGENT_TOOL_DESCRIPTION_CHARS = 400

export type AgentToolRunsIn = 'backend' | 'studio'
export const AGENT_RATE_FAMILIES = [
  'read',
  'picture',
  'action',
  'stop',
  'chat',
  'removal',
  'session'
] as const
export type AgentRateFamily = (typeof AGENT_RATE_FAMILIES)[number]

/** MCP tool annotations. All hints, honest ones (D2). */
export interface AgentToolAnnotations {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

/** A JSON Schema 2020-12 object in the subset `compileAgentToolSchema` accepts. */
export type AgentToolSchema = Record<string, unknown>

export interface AgentTool {
  name: string
  title: string
  description: string
  inputSchema: AgentToolSchema
  outputSchema: AgentToolSchema
  annotations: AgentToolAnnotations
  runsIn: AgentToolRunsIn
  /** D15: Buddy's planner may return this tool. */
  buddy: boolean
  /** D11: the Studio shows a notice naming the agent when it runs. */
  onAir: boolean
  rateFamily: AgentRateFamily
  /** The notice sentence, with `{agent}` and `{field}` placeholders filled
   * from the call's arguments, then its structured result (`agentToolNotice`). */
  notice: string | null
}

export interface AgentToolCatalog {
  version: number
  /** The server name agent apps show (`mcp__videorc__…`), D21. */
  serverName: string
  serverTitle: string
  /** The `initialize` result's instructions. */
  instructions: string
  tools: AgentTool[]
}

const SCHEMA_KEYWORDS = new Set([
  'type',
  'title',
  'description',
  'default',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'const',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'items',
  'oneOf',
  'anyOf'
])

const SCHEMA_TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array', 'null'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isSnakeCaseAgentToolName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_AGENT_TOOL_NAME_CHARS &&
    /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(name)
  )
}

/**
 * Check that a schema uses only the supported subset, with well-formed
 * values. Throws with a sentence naming the first problem, like the Rust
 * `compile_schema`.
 */
export function compileAgentToolSchema(
  schema: unknown,
  path = '#'
): asserts schema is AgentToolSchema {
  if (!isRecord(schema)) throw new Error(`${path} must be a schema object.`)
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYWORDS.has(key))
      throw new Error(`${path} uses the unsupported keyword \`${key}\`.`)
  }
  if (
    !('type' in schema) &&
    !('oneOf' in schema) &&
    !('anyOf' in schema) &&
    !('enum' in schema) &&
    !('const' in schema)
  ) {
    throw new Error(
      `${path} needs a \`type\`, an \`enum\`, a \`const\`, a \`oneOf\` or an \`anyOf\`.`
    )
  }
  if ('type' in schema) {
    const names = typeof schema.type === 'string' ? [schema.type] : schema.type
    if (!Array.isArray(names))
      throw new Error(`${path}.type must be a type name or a list of them.`)
    for (const name of names) {
      if (typeof name !== 'string' || !SCHEMA_TYPES.has(name)) {
        throw new Error(`${path}.type \`${String(name)}\` is not a JSON Schema type.`)
      }
    }
  }
  for (const key of ['title', 'description'] as const) {
    if (key in schema && typeof schema[key] !== 'string')
      throw new Error(`${path}.${key} must be text.`)
  }
  const properties = schema.properties
  if (properties !== undefined) {
    if (!isRecord(properties)) throw new Error(`${path}.properties must be an object.`)
    for (const [name, child] of Object.entries(properties)) {
      compileAgentToolSchema(child, `${path}.properties.${name}`)
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required))
      throw new Error(`${path}.required must be a list of field names.`)
    for (const name of schema.required) {
      if (typeof name !== 'string') throw new Error(`${path}.required must hold field names.`)
      if (!isRecord(properties) || !(name in properties)) {
        throw new Error(`${path}.required names \`${name}\`, which is not in properties.`)
      }
    }
  }
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== 'boolean'
  ) {
    throw new Error(`${path}.additionalProperties must be true or false.`)
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum)) throw new Error(`${path}.enum must be a list.`)
    if (schema.enum.length === 0) throw new Error(`${path}.enum must list at least one value.`)
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    const value = schema[key]
    if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0)) {
      throw new Error(`${path}.${key} must be a whole number.`)
    }
  }
  for (const key of ['minimum', 'maximum'] as const) {
    if (schema[key] !== undefined && typeof schema[key] !== 'number')
      throw new Error(`${path}.${key} must be a number.`)
  }
  if (schema.items !== undefined) compileAgentToolSchema(schema.items, `${path}.items`)
  for (const key of ['oneOf', 'anyOf'] as const) {
    const alternatives = schema[key]
    if (alternatives === undefined) continue
    if (!Array.isArray(alternatives)) throw new Error(`${path}.${key} must be a list of schemas.`)
    if (alternatives.length === 0) throw new Error(`${path}.${key} must list at least one schema.`)
    alternatives.forEach((alternative, index) =>
      compileAgentToolSchema(alternative, `${path}.${key}[${index}]`)
    )
  }
}

function typeMatches(name: string, value: unknown): boolean {
  switch (name) {
    case 'object':
      return isRecord(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'null':
      return value === null
    default:
      return false
  }
}

const TYPE_SENTENCES: Record<string, string> = {
  object: 'an object',
  string: 'text',
  number: 'a number',
  integer: 'a whole number',
  boolean: 'true or false',
  array: 'a list',
  null: 'null'
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Validate a value against a compiled schema. Returns the first problem as a
 * sentence naming the value (`arguments.title must be text.`), or null.
 */
export function validateAgentToolValue(
  schema: AgentToolSchema,
  value: unknown,
  path: string
): string | null {
  if ('const' in schema && !sameJson(value, schema.const))
    return `${path} must be ${JSON.stringify(schema.const)}.`
  if (Array.isArray(schema.enum) && !schema.enum.some((choice) => sameJson(choice, value))) {
    return `${path} must be one of ${schema.enum.map((choice) => JSON.stringify(choice)).join(', ')}.`
  }
  if ('type' in schema) {
    const names =
      (typeof schema.type === 'string' ? [schema.type] : (schema.type as string[])) ?? []
    if (!names.some((name) => typeMatches(name, value))) {
      return `${path} must be ${names.map((name) => TYPE_SENTENCES[name] ?? 'another type').join(' or ')}.`
    }
  }
  if (typeof value === 'string') {
    const chars = [...value].length
    const min = schema.minLength
    const max = schema.maxLength
    if (typeof min === 'number' && chars < min) {
      return min === 1
        ? `${path} must not be empty.`
        : `${path} must be at least ${min} characters.`
    }
    if (typeof max === 'number' && chars > max) return `${path} must be at most ${max} characters.`
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum)
      return `${path} must be at least ${schema.minimum}.`
    if (typeof schema.maximum === 'number' && value > schema.maximum)
      return `${path} must be at most ${schema.maximum}.`
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      return `${path} must list at least ${schema.minItems} items.`
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      return `${path} must list at most ${schema.maxItems} items.`
    }
    if (isRecord(schema.items)) {
      for (const [index, item] of value.entries()) {
        const problem = validateAgentToolValue(schema.items, item, `${path}[${index}]`)
        if (problem) return problem
      }
    }
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : undefined
    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (typeof name === 'string' && !(name in value)) return `${path}.${name} is required.`
      }
    }
    const additionalAllowed = schema.additionalProperties !== false
    for (const [name, field] of Object.entries(value)) {
      const child = properties?.[name]
      if (isRecord(child)) {
        const problem = validateAgentToolValue(child, field, `${path}.${name}`)
        if (problem) return problem
      } else if (!additionalAllowed) {
        return `${path} has no field \`${name}\`.`
      }
    }
  }
  for (const key of ['oneOf', 'anyOf'] as const) {
    const alternatives = schema[key]
    if (!Array.isArray(alternatives)) continue
    const matches = alternatives.filter(
      (alternative) =>
        isRecord(alternative) && validateAgentToolValue(alternative, value, path) === null
    ).length
    const wanted = key === 'oneOf' ? matches === 1 : matches >= 1
    if (!wanted) return `${path} does not match any of its allowed shapes.`
  }
  return null
}

/** Check a call's arguments against the tool's input schema. */
export function validateAgentToolArguments(tool: AgentTool, args: unknown): string | null {
  return validateAgentToolValue(tool.inputSchema, args, 'arguments')
}

/**
 * D11: the notice sentence with the agent's name filled in, then every
 * `{field}` from the call's arguments and, after them, its structured result
 * (`stop` names what it stopped). The Rust twin is `AgentTool::fill_notice`;
 * the backend fills the same sentence onto the `agents.activity` event as
 * `notice`.
 */
export function agentToolNotice(
  tool: AgentTool,
  agentName: string,
  args: unknown,
  result?: unknown
): string | null {
  if (tool.notice === null) return null
  let text = tool.notice.replaceAll('{agent}', agentName)
  for (const fields of [args, result]) {
    if (!isRecord(fields)) continue
    for (const [key, value] of Object.entries(fields)) {
      const placeholder = `{${key}}`
      if (!text.includes(placeholder)) continue
      const shown = typeof value === 'string' ? value : value === null ? '' : JSON.stringify(value)
      text = text.replaceAll(placeholder, shown)
    }
  }
  return text
}

function expectString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw new Error(`${where}.${key} must be text.`)
  return value
}

function expectBoolean(record: Record<string, unknown>, key: string, where: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') throw new Error(`${where}.${key} must be true or false.`)
  return value
}

const TOOL_KEYS = [
  'name',
  'title',
  'description',
  'inputSchema',
  'outputSchema',
  'annotations',
  'runsIn',
  'buddy',
  'onAir',
  'rateFamily',
  'notice'
] as const

const ANNOTATION_KEYS = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint'
] as const

/**
 * Parse and check a catalog: unique snake_case names, at most
 * `MAX_AGENT_TOOLS`, every schema compiles, the exact field set per tool.
 * Throws with the first problem, like the Rust `parse_catalog`.
 */
export function parseAgentToolCatalog(raw: unknown): AgentToolCatalog {
  if (!isRecord(raw)) throw new Error('agent-tools.json must be an object.')
  const version = raw.version
  if (typeof version !== 'number') throw new Error('agent-tools.json.version must be a number.')
  const serverName = expectString(raw, 'serverName', 'agent-tools.json')
  const serverTitle = expectString(raw, 'serverTitle', 'agent-tools.json')
  const instructions = expectString(raw, 'instructions', 'agent-tools.json')
  if (!Array.isArray(raw.tools)) throw new Error('agent-tools.json.tools must be a list.')
  if (raw.tools.length > MAX_AGENT_TOOLS) {
    throw new Error(
      `agent-tools.json lists ${raw.tools.length} tools; the catalog holds at most ${MAX_AGENT_TOOLS}.`
    )
  }
  const seen = new Set<string>()
  const tools: AgentTool[] = raw.tools.map((entry, index) => {
    const where = `tools[${index}]`
    if (!isRecord(entry)) throw new Error(`${where} must be an object.`)
    const keys = Object.keys(entry)
    for (const key of keys) {
      if (!(TOOL_KEYS as readonly string[]).includes(key))
        throw new Error(`${where} has the unknown field \`${key}\`.`)
    }
    for (const key of TOOL_KEYS) {
      if (!(key in entry)) throw new Error(`${where} is missing \`${key}\`.`)
    }
    const name = expectString(entry, 'name', where)
    if (!isSnakeCaseAgentToolName(name)) {
      throw new Error(
        `Tool name \`${name}\` must be snake_case (a to z, 0 to 9, underscores), 1 to ${MAX_AGENT_TOOL_NAME_CHARS} characters.`
      )
    }
    if (seen.has(name)) throw new Error(`Tool name \`${name}\` is listed twice.`)
    seen.add(name)
    const title = expectString(entry, 'title', where)
    if (title.trim().length === 0) throw new Error(`Tool \`${name}\` needs a title.`)
    const description = expectString(entry, 'description', where)
    const descriptionChars = [...description].length
    if (
      descriptionChars < MIN_AGENT_TOOL_DESCRIPTION_CHARS ||
      descriptionChars > MAX_AGENT_TOOL_DESCRIPTION_CHARS
    ) {
      throw new Error(
        `Tool \`${name}\` description is ${descriptionChars} characters; it must be ${MIN_AGENT_TOOL_DESCRIPTION_CHARS} to ${MAX_AGENT_TOOL_DESCRIPTION_CHARS}.`
      )
    }
    const inputSchema = entry.inputSchema
    const outputSchema = entry.outputSchema
    try {
      compileAgentToolSchema(inputSchema)
    } catch (error) {
      throw new Error(
        `Tool \`${name}\` inputSchema: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      )
    }
    try {
      compileAgentToolSchema(outputSchema)
    } catch (error) {
      throw new Error(
        `Tool \`${name}\` outputSchema: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      )
    }
    if (inputSchema.type !== 'object')
      throw new Error(`Tool \`${name}\` inputSchema must be an object schema.`)
    const rawAnnotations = entry.annotations
    if (!isRecord(rawAnnotations))
      throw new Error(`Tool \`${name}\` annotations must be an object.`)
    for (const key of Object.keys(rawAnnotations)) {
      if (!(ANNOTATION_KEYS as readonly string[]).includes(key)) {
        throw new Error(`Tool \`${name}\` annotations has the unknown hint \`${key}\`.`)
      }
    }
    const annotations: AgentToolAnnotations = {
      readOnlyHint: expectBoolean(rawAnnotations, 'readOnlyHint', `${where}.annotations`),
      destructiveHint: expectBoolean(rawAnnotations, 'destructiveHint', `${where}.annotations`),
      idempotentHint: expectBoolean(rawAnnotations, 'idempotentHint', `${where}.annotations`),
      openWorldHint: expectBoolean(rawAnnotations, 'openWorldHint', `${where}.annotations`)
    }
    const runsIn = entry.runsIn
    if (runsIn !== 'backend' && runsIn !== 'studio')
      throw new Error(`Tool \`${name}\` runsIn must be backend or studio.`)
    const rateFamily = entry.rateFamily
    if (!(AGENT_RATE_FAMILIES as readonly unknown[]).includes(rateFamily)) {
      throw new Error(
        `Tool \`${name}\` rateFamily must be one of ${AGENT_RATE_FAMILIES.join(', ')}.`
      )
    }
    const notice = entry.notice
    if (notice !== null && typeof notice !== 'string')
      throw new Error(`Tool \`${name}\` notice must be text or null.`)
    const onAir = expectBoolean(entry, 'onAir', where)
    if (onAir !== (notice !== null)) {
      throw new Error(`Tool \`${name}\`: onAir tools carry a notice sentence and only they do.`)
    }
    return {
      name,
      title,
      description,
      inputSchema,
      outputSchema,
      annotations,
      runsIn,
      buddy: expectBoolean(entry, 'buddy', where),
      onAir,
      rateFamily: rateFamily as AgentRateFamily,
      notice
    }
  })
  return { version, serverName, serverTitle, instructions, tools }
}

/** The compiled-in catalog, validated once at load. */
export const AGENT_TOOL_CATALOG: AgentToolCatalog = parseAgentToolCatalog(catalogJson)

export function agentTool(name: string): AgentTool | undefined {
  return AGENT_TOOL_CATALOG.tools.find((tool) => tool.name === name)
}

/** The tools the renderer's Studio action executor must implement (S5/S6). */
export function studioAgentTools(catalog: AgentToolCatalog = AGENT_TOOL_CATALOG): AgentTool[] {
  return catalog.tools.filter((tool) => tool.runsIn === 'studio')
}

/** D15: the tools Buddy's planner may be given. */
export function buddyAgentTools(catalog: AgentToolCatalog = AGENT_TOOL_CATALOG): AgentTool[] {
  return catalog.tools.filter((tool) => tool.buddy)
}
