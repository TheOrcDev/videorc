import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  AGENT_TOOL_CATALOG,
  MAX_AGENT_TOOLS,
  MAX_AGENT_TOOL_DESCRIPTION_CHARS,
  MIN_AGENT_TOOL_DESCRIPTION_CHARS,
  agentTool,
  agentToolNotice,
  buddyAgentTools,
  compileAgentToolSchema,
  isSnakeCaseAgentToolName,
  parseAgentToolCatalog,
  studioAgentTools,
  validateAgentToolArguments,
  validateAgentToolValue
} from './agent-tools'

const fixtureText = readFileSync(
  new URL('../../../../protocol-fixtures/agent-tools.json', import.meta.url),
  'utf8'
)
const fixture = JSON.parse(fixtureText) as unknown

/** RPC method namespaces that must never appear in agent-facing text (D10). */
const METHOD_NAMESPACES = [
  'session.',
  'sessions.',
  'banners.',
  'remote.',
  'cohost.',
  'liveChat.',
  'scene.',
  'sounds.',
  'screens.',
  'captions.',
  'streamTargets.',
  'overlays.',
  'comments.',
  'clip.',
  'replay.',
  'agents.',
  'agent.',
  'preview.',
  'account.',
  'platformAccounts.'
]

/** `namespace.identifier`, not the word "banners" ending a sentence. */
function mentionsMethod(text: string, namespace: string): boolean {
  let from = 0
  for (;;) {
    const at = text.indexOf(namespace, from)
    if (at < 0) return false
    const next = text[at + namespace.length]
    if (next !== undefined && /[A-Za-z_]/.test(next)) return true
    from = at + namespace.length
  }
}

function everyString(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) value.forEach((item) => everyString(item, out))
  else if (value && typeof value === 'object')
    Object.values(value).forEach((item) => everyString(item, out))
}

describe('the agent tool catalog (plan 209 S1)', () => {
  it('equals protocol-fixtures/agent-tools.json, field for field', () => {
    expect(AGENT_TOOL_CATALOG).toStrictEqual(parseAgentToolCatalog(fixture))
    expect(AGENT_TOOL_CATALOG.version).toBe(1)
    expect(AGENT_TOOL_CATALOG.serverName).toBe('videorc')
  })

  it('keeps unique snake_case names, at most 45, with 40 to 400 character descriptions', () => {
    const names = AGENT_TOOL_CATALOG.tools.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names.length).toBeGreaterThan(0)
    expect(names.length).toBeLessThanOrEqual(MAX_AGENT_TOOLS)
    for (const tool of AGENT_TOOL_CATALOG.tools) {
      expect(isSnakeCaseAgentToolName(tool.name)).toBe(true)
      const length = [...tool.description].length
      expect(length).toBeGreaterThanOrEqual(MIN_AGENT_TOOL_DESCRIPTION_CHARS)
      expect(length).toBeLessThanOrEqual(MAX_AGENT_TOOL_DESCRIPTION_CHARS)
      expect(() => compileAgentToolSchema(tool.inputSchema)).not.toThrow()
      expect(() => compileAgentToolSchema(tool.outputSchema)).not.toThrow()
    }
    for (const needle of ['get_status', 'viewers', 'public', 'Trash']) {
      expect(AGENT_TOOL_CATALOG.instructions).toContain(needle)
    }
  })

  it('mentions no method name anywhere in its text', () => {
    expect(mentionsMethod('the banners. Chat', 'banners.')).toBe(false)
    expect(mentionsMethod('call banners.show now', 'banners.')).toBe(true)
    const strings: string[] = []
    everyString(fixture, strings)
    for (const text of strings) {
      for (const namespace of METHOD_NAMESPACES) {
        expect(mentionsMethod(text, namespace), `mentions ${namespace}: ${text}`).toBe(false)
      }
    }
  })

  it('fails on a schema typo, a duplicate, a camelCase name or an unknown field', () => {
    expect(() =>
      parseAgentToolCatalog(JSON.parse(fixtureText.replace('"type": "string"', '"type": "strnig"')))
    ).toThrow(/strnig/)
    expect(() =>
      parseAgentToolCatalog(JSON.parse(fixtureText.replace('"required"', '"require"')))
    ).toThrow(/require/)
    expect(() =>
      parseAgentToolCatalog(
        JSON.parse(fixtureText.replace('"name": "notify"', '"name": "add_marker"'))
      )
    ).toThrow(/twice/)
    expect(() =>
      parseAgentToolCatalog(
        JSON.parse(fixtureText.replace('"name": "notify"', '"name": "notifyMe"'))
      )
    ).toThrow(/snake_case/)
    expect(() =>
      parseAgentToolCatalog(
        JSON.parse(fixtureText.replace('"buddy": false', '"buddy": false, "x": 1'))
      )
    ).toThrow(/unknown field/)
    expect(() =>
      parseAgentToolCatalog(JSON.parse(fixtureText.replace('"onAir": true', '"onAir": false')))
    ).toThrow(/onAir/)
  })

  it('checks arguments against the input schema with the same sentences as Rust', () => {
    const notify = agentTool('notify')!
    expect(validateAgentToolArguments(notify, { message: 'hi' })).toBeNull()
    expect(validateAgentToolArguments(notify, {})).toBe('arguments.message is required.')
    expect(validateAgentToolArguments(notify, { message: '' })).toBe(
      'arguments.message must not be empty.'
    )
    expect(validateAgentToolArguments(notify, { message: 4 })).toBe(
      'arguments.message must be text.'
    )
    expect(validateAgentToolArguments(notify, { message: 'hi', loud: true })).toBe(
      'arguments has no field `loud`.'
    )
    expect(validateAgentToolArguments(notify, { message: 'x'.repeat(201) })).toBe(
      'arguments.message must be at most 200 characters.'
    )
    expect(validateAgentToolArguments(notify, [])).toBe('arguments must be an object.')
    const setBanner = agentTool('set_banner')!
    expect(validateAgentToolArguments(setBanner, { shown: false })).toBeNull()
    expect(validateAgentToolArguments(setBanner, { shown: 'yes' })).toBe(
      'arguments.shown must be true or false.'
    )
  })

  it('validates the rest of the schema subset', () => {
    const schema = {
      type: 'object',
      properties: {
        seconds: { type: 'integer', enum: [30, 60] },
        gain: { type: 'number', minimum: -30, maximum: 10 },
        ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 },
        place: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        mode: { const: 'fast' }
      },
      required: ['seconds']
    }
    compileAgentToolSchema(schema)
    expect(
      validateAgentToolValue(
        schema,
        { seconds: 30, gain: 0, ids: ['a'], place: null, mode: 'fast', extra: 1 },
        'arguments'
      )
    ).toBeNull()
    expect(validateAgentToolValue(schema, { seconds: 45 }, 'arguments')).toBe(
      'arguments.seconds must be one of 30, 60.'
    )
    expect(validateAgentToolValue(schema, { seconds: 30, gain: 11 }, 'arguments')).toBe(
      'arguments.gain must be at most 10.'
    )
    expect(validateAgentToolValue(schema, { seconds: 30, ids: [] }, 'arguments')).toBe(
      'arguments.ids must list at least 1 items.'
    )
    expect(validateAgentToolValue(schema, { seconds: 30, ids: [1] }, 'arguments')).toBe(
      'arguments.ids[0] must be text.'
    )
    expect(validateAgentToolValue(schema, { seconds: 30, place: 2 }, 'arguments')).toBe(
      'arguments.place does not match any of its allowed shapes.'
    )
    expect(validateAgentToolValue(schema, { seconds: 30, mode: 'slow' }, 'arguments')).toBe(
      'arguments.mode must be "fast".'
    )
    expect(() => compileAgentToolSchema({ type: 'object', required: ['x'] })).toThrow(/required/)
    expect(() => compileAgentToolSchema({ description: 'no type' })).toThrow(/needs a/)
    expect(() => compileAgentToolSchema({ type: 'string', pattern: 'x' })).toThrow(/pattern/)
  })

  it('splits studio and backend tools and fills notice sentences', () => {
    expect(studioAgentTools().map((tool) => tool.name)).toContain('notify')
    expect(studioAgentTools().every((tool) => tool.runsIn === 'studio')).toBe(true)
    expect(buddyAgentTools().map((tool) => tool.name)).toContain('add_marker')
    expect(buddyAgentTools().map((tool) => tool.name)).not.toContain('notify')
    expect(
      agentToolNotice(agentTool('notify')!, 'Claude Desktop', {
        message: 'the sponsor banner is up'
      })
    ).toBe('Claude Desktop: the sponsor banner is up')
    expect(agentToolNotice(agentTool('add_marker')!, 'Claude', {})).toBeNull()
  })
})
