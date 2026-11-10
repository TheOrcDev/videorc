import { launchDevApp } from './lib/app-launcher.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

// Plan 226: chat commands end to end over the real websocket protocol, with
// the fake chat connectors and no platform account. An isolated dev app (the
// launcher gives it its own profile) saves commands over RPC, viewers type
// `!go` and `!commands` in fake Twitch, YouTube and Kick chats, and the smoke
// reads Videorc's replies back from the fakes' echo rows. It holds:
//
// - a viewer's `!go` is answered once, in the chat they asked in only, as
//   `@name <reply>` (a YouTube `@handle` is not doubled);
// - `!GO now` inside the cooldown, `hello`, `!nope` and `why !go` get nothing;
// - `!commands` lists the enabled commands A–Z;
// - a refused send raises exactly one `chatCommands.replyFailed`;
// - the streamer's own `chatCommands.post` reaches every chat that takes
//   posts, and its echo (a line that starts with `!faq`) is never answered;
// - the editor's refusals use the shared words.
//
// It never goes live and never reaches a real platform.

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90000)
// How long the smoke waits for a reply that must NOT come.
const QUIET_MS = 3000

const GO_REPLY = 'Go compiles fast, ships one binary, and makes concurrency simple.'
const FAQ_REPLY = 'Read the pinned message first, then ask away.'
const LINKS_REPLY = '!faq has more answers, and the links are in the description.'

const TWITCH = 'chat-commands-twitch'
const YOUTUBE = 'chat-commands-youtube'
const KICK = 'chat-commands-kick'

let launched

try {
  const connection = await launchAndReadConnection()
  const ws = await connectBackend(connection, timeoutMs)
  const observed = collectEvents(ws)
  try {
    step('the editor refuses what the shared rules refuse')
    await expectRefusal(
      ws,
      { name: 'commands', description: 'built in', reply: 'no', enabled: true },
      '!commands is built in.'
    )
    await expectRefusal(
      ws,
      { name: 'go now', description: 'spaces', reply: 'no', enabled: true },
      'Use letters, numbers, _ and - only.'
    )

    step('save !go, !faq and !links; the list comes back A–Z')
    const saved = await saveCommands(ws, [
      { name: '!Go', description: "why I'm learning Go", reply: GO_REPLY, enabled: true },
      { name: 'faq', description: 'most asked question', reply: FAQ_REPLY, enabled: true },
      { name: 'links', description: 'where the links are', reply: LINKS_REPLY, enabled: true }
    ])
    const names = saved.commands.map((command) => command.name)
    if (JSON.stringify(names) !== JSON.stringify(['faq', 'go', 'links']) || !saved.listEnabled) {
      fail(`chatCommands.list is not the three commands A–Z: ${JSON.stringify(saved)}`)
    }
    await expectRefusal(
      ws,
      { name: 'GO', description: 'again', reply: 'again', enabled: true },
      '!go already exists.'
    )
    const changed = observed.changed.at(-1)
    if (!changed || JSON.stringify(changed) !== JSON.stringify(saved)) {
      fail('chatCommands.changed did not carry the saved state.')
    }

    step('viewers type commands in three fake chats')
    const sessionId = `smoke-chat-commands-${Date.now()}`
    await request(ws, timeoutMs, 'liveChat.start', {
      sessionId,
      destinations: [TWITCH, YOUTUBE, KICK].map((targetId) => ({
        platform: platformOf(targetId),
        targetId,
        read: 'ready',
        write: 'ready'
      })),
      fakes: [
        {
          platform: 'twitch',
          targetId: TWITCH,
          count: 6,
          intervalMs: 300,
          send: 'sent',
          echoSends: true,
          authors: ['coder_x', 'ada', 'bob', 'dee', 'eve', 'fin'],
          texts: ['!go', 'hello', '!GO now', '!commands', '!nope', 'why !go']
        },
        {
          platform: 'youtube',
          targetId: YOUTUBE,
          count: 1,
          intervalMs: 300,
          send: 'sent',
          echoSends: true,
          authors: ['@YouTubeViewer'],
          texts: ['!go']
        },
        {
          platform: 'kick',
          targetId: KICK,
          count: 1,
          intervalMs: 300,
          send: 'failed',
          authors: ['kicker'],
          texts: ['!faq']
        }
      ]
    })

    const commandsText =
      "@dee Commands: !faq (most asked question), !go (why I'm learning Go), " +
      '!links (where the links are)'
    await waitFor(
      () =>
        hasEcho(observed, TWITCH, `@coder_x ${GO_REPLY}`) &&
        hasEcho(observed, TWITCH, commandsText) &&
        hasEcho(observed, YOUTUBE, `@YouTubeViewer ${GO_REPLY}`) &&
        observed.failed.length >= 1,
      timeoutMs,
      'the !go and !commands replies and the Kick refusal'
    )
    await sleep(QUIET_MS)

    step('each reply went once, only to the chat that asked')
    expectEchoes(observed, TWITCH, [`@coder_x ${GO_REPLY}`, commandsText])
    expectEchoes(observed, YOUTUBE, [`@YouTubeViewer ${GO_REPLY}`])
    expectEchoes(observed, KICK, [])
    if (observed.failed.length !== 1) {
      fail(`Expected one chatCommands.replyFailed, got ${JSON.stringify(observed.failed)}`)
    }
    const [failure] = observed.failed
    if (
      failure.sessionId !== sessionId ||
      failure.destinationId !== KICK ||
      failure.platform !== 'kick' ||
      failure.command !== 'faq' ||
      !failure.reason
    ) {
      fail(`The Kick refusal is not the !faq reply on Kick: ${JSON.stringify(failure)}`)
    }

    step("the streamer's !links reaches every chat, and its echo is not answered")
    const posted = await request(ws, timeoutMs, 'chatCommands.post', { sessionId, name: 'LINKS' })
    if (posted.sent !== 2 || posted.failed !== 1) {
      fail(
        `chatCommands.post should send to Twitch and YouTube and fail on Kick: ${JSON.stringify(posted)}`
      )
    }
    await waitFor(
      () => hasEcho(observed, TWITCH, LINKS_REPLY) && hasEcho(observed, YOUTUBE, LINKS_REPLY),
      timeoutMs,
      'the posted !links reply on Twitch and YouTube'
    )
    await sleep(QUIET_MS)
    expectEchoes(observed, TWITCH, [`@coder_x ${GO_REPLY}`, commandsText, LINKS_REPLY])
    expectEchoes(observed, YOUTUBE, [`@YouTubeViewer ${GO_REPLY}`, LINKS_REPLY])
    if (observed.failed.length !== 1) {
      fail(`The same Kick refusal was reported twice: ${JSON.stringify(observed.failed)}`)
    }
    await expectPostRefusal(ws, { sessionId, name: 'nope' }, 'No command called !nope.')
    await expectPostRefusal(
      ws,
      { sessionId: 'smoke-chat-commands-ended', name: 'go' },
      'This chat session ended.'
    )

    await request(ws, timeoutMs, 'liveChat.stop', {})

    step('switch !commands off, then delete a command')
    const listOff = await request(ws, timeoutMs, 'chatCommands.setListEnabled', { enabled: false })
    if (listOff.listEnabled !== false) fail('chatCommands.setListEnabled did not switch it off.')
    const links = listOff.commands.find((command) => command.name === 'links')
    const afterDelete = await request(ws, timeoutMs, 'chatCommands.delete', { id: links.id })
    if (afterDelete.commands.some((command) => command.name === 'links')) {
      fail('chatCommands.delete left !links in the list.')
    }
    const reread = await request(ws, timeoutMs, 'chatCommands.list')
    if (JSON.stringify(reread) !== JSON.stringify(afterDelete)) {
      fail('chatCommands.list disagrees with the last mutation.')
    }

    console.log(
      'Chat commands smoke OK - !go answered once per asking chat with the mention, ' +
        'cooldown, unknown and mid-text commands ignored, !commands listed A–Z, one Kick ' +
        'refusal reported once, the streamer post reached every chat and its echo stayed ' +
        'unanswered, editor refusals in the shared words.'
    )
  } finally {
    ws.close()
  }
} finally {
  if (launched) await launched.stop()
}

function step(label) {
  console.log(`[smoke:chat-commands] ${label}`)
}

function fail(message) {
  throw new Error(message)
}

function platformOf(targetId) {
  if (targetId === TWITCH) return 'twitch'
  if (targetId === YOUTUBE) return 'youtube'
  return 'kick'
}

async function saveCommands(ws, commands) {
  let state
  for (const command of commands) {
    state = await request(ws, timeoutMs, 'chatCommands.save', command)
  }
  return state
}

async function expectRefusal(ws, params, words) {
  try {
    await request(ws, timeoutMs, 'chatCommands.save', params)
  } catch (error) {
    if (String(error.message).includes(words)) return
    fail(
      `chatCommands.save refused ${JSON.stringify(params)} with "${error.message}", not "${words}"`
    )
  }
  fail(`chatCommands.save accepted ${JSON.stringify(params)}`)
}

async function expectPostRefusal(ws, params, words) {
  try {
    await request(ws, timeoutMs, 'chatCommands.post', params)
  } catch (error) {
    if (String(error.message).includes(words)) return
    fail(
      `chatCommands.post refused ${JSON.stringify(params)} with "${error.message}", not "${words}"`
    )
  }
  fail(`chatCommands.post accepted ${JSON.stringify(params)}`)
}

/** The fakes echo every accepted post as the streamer's own row (role broadcaster). */
function echoes(observed, targetId) {
  return observed.messages
    .filter(
      (message) =>
        message.targetId === targetId &&
        (message.authorRoles ?? []).some((role) => role === 'broadcaster' || role === 'owner')
    )
    .map((message) => message.messageText)
}

function hasEcho(observed, targetId, text) {
  return echoes(observed, targetId).includes(text)
}

function expectEchoes(observed, targetId, expected) {
  const actual = echoes(observed, targetId)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      `Replies on ${targetId} should be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    )
  }
}

function collectEvents(ws) {
  const collection = { messages: [], failed: [], changed: [] }
  const seen = new Set()
  ws.addEventListener('message', (event) => {
    let parsed
    try {
      parsed = JSON.parse(event.data)
    } catch {
      return
    }
    if (parsed.event === 'liveChat.message') {
      // A row can arrive again as an update; keep each id once.
      if (seen.has(parsed.payload.id)) return
      seen.add(parsed.payload.id)
      collection.messages.push(parsed.payload)
    } else if (parsed.event === 'chatCommands.replyFailed') {
      collection.failed.push(parsed.payload)
    } else if (parsed.event === 'chatCommands.changed') {
      collection.changed.push(parsed.payload)
    }
  })
  return collection
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function waitFor(predicate, deadlineMs, label) {
  return new Promise((resolveWait, rejectWait) => {
    const startedAt = Date.now()
    const tick = () => {
      if (predicate()) {
        resolveWait()
        return
      }
      if (Date.now() - startedAt > deadlineMs) {
        rejectWait(new Error(`Timed out waiting for ${label}.`))
        return
      }
      setTimeout(tick, 50)
    }
    tick()
  })
}

async function launchAndReadConnection() {
  // The shared launcher gives the app its own temporary profile, holds the
  // host lock and the memory gate.
  launched = await launchDevApp({
    env: { VIDEORC_SMOKE_PRINT_BACKEND_READY: '1' },
    timeoutMs,
    requiredMarkers: ['backend-ready'],
    onLine: printAppLine
  })
  return launched.connections['backend-ready']
}

function printAppLine(line) {
  const marker = '[smoke] backend-ready '
  const index = line.indexOf(marker)
  console.log(
    index === -1 ? line : `${line.slice(0, index)}${marker}[ephemeral connection redacted]`
  )
}
