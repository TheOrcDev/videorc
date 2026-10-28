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

  it('fails on a description outside 40 to 400 characters, like Rust', () => {
    const short = JSON.parse(fixtureText) as { tools: { description: string }[] }
    short.tools[0]!.description = 'Too short to say when.'
    expect(() => parseAgentToolCatalog(short)).toThrow(/must be 40 to 400/)
    const long = JSON.parse(fixtureText) as { tools: { description: string }[] }
    long.tools[0]!.description = 'x'.repeat(401)
    expect(() => parseAgentToolCatalog(long)).toThrow(/must be 40 to 400/)
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
    // `stop` names what it stopped from its result, like the Rust filler.
    expect(agentToolNotice(agentTool('stop')!, 'Cursor', {}, { stopped: 'livestream' })).toBe(
      'Cursor ended the livestream.'
    )
  })

  it('runs every PR A tool where the plan says, with D15 and D11 kept', () => {
    const where = Object.fromEntries(
      AGENT_TOOL_CATALOG.tools.map((tool) => [tool.name, tool.runsIn])
    )
    // PR B adds its own tools (plan 209 S10 to S15); these stay where they were.
    const prATools: Record<string, string> = {
      get_status: 'backend',
      get_picture: 'backend',
      list_scenes: 'backend',
      list_sources: 'backend',
      list_assets: 'backend',
      read_chat: 'backend',
      list_destinations: 'backend',
      list_recordings: 'backend',
      get_recording: 'backend',
      start_recording: 'studio',
      stop: 'studio',
      save_clip: 'backend',
      add_marker: 'backend',
      switch_scene: 'studio',
      set_audio: 'studio',
      set_banner: 'backend',
      set_takeover: 'studio',
      play_sound: 'studio',
      stop_sounds: 'studio',
      set_highlight: 'studio',
      open_window: 'studio',
      notify: 'studio'
    }
    expect(where).toMatchObject(prATools)
    expect(buddyAgentTools().map((tool) => tool.name)).not.toContain('get_recording')
    expect(buddyAgentTools().map((tool) => tool.name)).not.toContain('open_window')
    expect(
      AGENT_TOOL_CATALOG.tools
        .filter((tool) => tool.onAir && Object.hasOwn(prATools, tool.name))
        .map((tool) => tool.name)
    ).toEqual(['stop', 'notify'])
    for (const tool of AGENT_TOOL_CATALOG.tools) {
      expect(tool.annotations.readOnlyHint, tool.name).toBe(tool.rateFamily === 'read')
    }
    // D18: chat comes back under viewer-named fields only.
    const chat = agentTool('read_chat')!.outputSchema as {
      properties: { messages: { items: { properties: Record<string, unknown> } } }
    }
    const fields = Object.keys(chat.properties.messages.items.properties)
    expect(fields).toEqual(expect.arrayContaining(['viewerText', 'viewerName']))
    expect(fields).not.toContain('messageText')
    expect(fields).not.toContain('authorName')
  })
  // Plan 209 PR B, Run the show and Arrange the picture (S10, S11, S11b):
  // where each runs, D15 (Buddy may use all of them), D11 (only go_live
  // earns a notice here) and the rate families.
  it('runs the PR B Run the show and Arrange tools where the plan says', () => {
    const expected: Record<string, ['backend' | 'studio', string, boolean]> = {
      go_live: ['studio', 'session', true],
      set_sources: ['studio', 'action', false],
      set_captions: ['studio', 'action', false],
      set_background: ['studio', 'action', false],
      edit_banner: ['backend', 'action', false],
      get_scene_layout: ['studio', 'read', false],
      move_on_scene: ['studio', 'action', false],
      set_scene_item: ['studio', 'action', false]
    }
    for (const [name, [runsIn, rateFamily, onAir]] of Object.entries(expected)) {
      const tool = agentTool(name)
      expect(tool, name).toBeDefined()
      expect(tool!.runsIn, name).toBe(runsIn)
      expect(tool!.rateFamily, name).toBe(rateFamily)
      expect(tool!.onAir, name).toBe(onAir)
      // Review fix 18: Buddy never imports an image from a path.
      expect(tool!.buddy, name).toBe(name !== 'edit_banner')
    }
    expect(agentTool('go_live')!.notice).toBe('{agent} started the livestream.')
    // S11: set_audio's objects take gain and the microphone beside S6's switches.
    const audio = agentTool('set_audio')!.inputSchema as {
      properties: Record<string, { properties: Record<string, unknown> }>
    }
    expect(Object.keys(audio.properties.microphone!.properties)).toEqual([
      'muted',
      'gainDb',
      'deviceId'
    ])
    expect(Object.keys(audio.properties.systemAudio!.properties)).toEqual(['on', 'gainDb'])
  })
})
