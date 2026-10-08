// Videorc Remote — the phone page. All protocol work lives in
// remote-client.js; this file is only DOM. Chat text is attacker-controlled
// (anyone can type in a livestream chat): it reaches the page through
// textContent only, never as markup.

import { RemoteClient, deviceFragment, parseFragment } from './remote-client.js'

const STORAGE_KEY = 'videorc.remote.device'
const MAX_ROWS = 300
const STICK_TO_BOTTOM_PX = 96
const HOLD_TO_STOP_MS = 700

const $ = (id) => document.getElementById(id)
const el = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

// --- credentials -------------------------------------------------------

function storedCredentials() {
  try {
    return parseFragment(localStorage.getItem(STORAGE_KEY) ?? '')
  } catch {
    return null
  }
}

function rememberCredentials(credentials) {
  const fragment = deviceFragment(credentials)
  try {
    localStorage.setItem(STORAGE_KEY, fragment)
  } catch {
    // Private mode: the URL below still carries the credential.
  }
  // The origin is an IP address; if it changes, storage is gone. A bookmark
  // or home-screen icon made from THIS url keeps working regardless.
  history.replaceState(null, '', fragment)
}

function forgetCredentials() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing stored.
  }
  history.replaceState(null, '', location.pathname)
}

function deviceName() {
  const agent = navigator.userAgent
  const device = /iPhone/.test(agent)
    ? 'iPhone'
    : /iPad|Macintosh.*Mobile/.test(agent)
      ? 'iPad'
      : /Android/.test(agent)
        ? 'Android'
        : 'Browser'
  const browser = /CriOS|Chrome/.test(agent)
    ? 'Chrome'
    : /FxiOS|Firefox/.test(agent)
      ? 'Firefox'
      : /Safari/.test(agent)
        ? 'Safari'
        : ''
  return browser ? `${device} · ${browser}` : device
}

// --- chrome -------------------------------------------------------------

let snackTimer = null
function snack(message) {
  const node = $('snack')
  node.textContent = message
  node.hidden = false
  clearTimeout(snackTimer)
  snackTimer = setTimeout(() => (node.hidden = true), 3500)
}

function showGate(title, text) {
  cancelHolds()
  $('gate-title').textContent = title
  $('gate-text').textContent = text
  $('view-gate').hidden = false
  $('view-comments').hidden = true
  $('view-deck').hidden = true
  $('tabs').hidden = true
}

let activeView = 'comments'
function showView(view) {
  if (view !== 'deck') cancelHolds()
  activeView = view
  $('view-gate').hidden = true
  $('tabs').hidden = false
  $('view-comments').hidden = view !== 'comments'
  $('view-deck').hidden = view !== 'deck'
  for (const tab of $('tabs').querySelectorAll('button')) {
    tab.setAttribute('aria-pressed', String(tab.dataset.view === view))
  }
  if (view === 'comments') scrollToBottom()
}

const STATUS_TEXT = {
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  connected: 'Connected',
  unpaired: 'Not paired',
  idle: 'Offline'
}

// --- comments -----------------------------------------------------------

const rows = new Map()
let highlight = { phase: 'idle' }
let pendingId = null
let unseen = 0
let highlightTimer = null

const commentsView = $('view-comments')
const commentsList = $('comments')

function nearBottom() {
  return (
    commentsView.scrollHeight - commentsView.scrollTop - commentsView.clientHeight <
    STICK_TO_BOTTOM_PX
  )
}

function scrollToBottom() {
  commentsView.scrollTop = commentsView.scrollHeight
  unseen = 0
  $('jump').hidden = true
}

function messageText(message) {
  if (message.messageText) return message.messageText
  return (message.fragments ?? []).map((fragment) => fragment.text).join('')
}

// YouTube rows carry YouTube's official icon file, unmodified and 20 px tall
// (plan 165, Google's ToS report III.F.2a). Other platforms keep a letter tile.
function platformGlyph(platform) {
  if (platform === 'youtube') {
    const glyph = el('span', 'glyph')
    glyph.dataset.platform = 'youtube'
    // The viewBox crops the file to the mark's own bounds, so the 20 px box
    // is the visible icon (the same framing as the desktop's YoutubeIcon).
    const svg = 'http://www.w3.org/2000/svg'
    const icon = document.createElementNS(svg, 'svg')
    icon.setAttribute('viewBox', '102.6875 119.167969 396 277.402343')
    icon.setAttribute('class', 'youtube-icon')
    icon.setAttribute('role', 'img')
    icon.setAttribute('aria-label', 'YouTube')
    const image = document.createElementNS(svg, 'image')
    image.setAttribute('href', '/youtube-icon.svg')
    image.setAttribute('width', '602.187')
    image.setAttribute('height', '515.868')
    icon.append(image)
    glyph.append(icon)
    return glyph
  }
  const glyph = el('span', 'glyph', (platform ?? '?').slice(0, 1).toUpperCase())
  glyph.dataset.platform = platform ?? ''
  return glyph
}

function buildRow(message) {
  const row = el('button', 'comment')
  row.type = 'button'
  row.setAttribute('role', 'listitem')
  row.dataset.id = message.id
  row.dataset.kind = message.eventType ?? 'message'
  const glyph = platformGlyph(message.platform)
  const meta = el('span', 'meta')
  meta.append(el('span', 'author', message.authorName ?? ''))
  const role = (message.authorRoles ?? []).find((value) =>
    ['owner', 'broadcaster', 'moderator'].includes(value)
  )
  if (role) meta.append(el('span', 'role', role === 'moderator' ? 'mod' : 'host'))
  if (message.amountText) meta.append(el('span', 'amount', message.amountText))
  row.append(glyph, meta, el('span', 'text', messageText(message)))
  if (message.isDeleted) row.dataset.deleted = 'true'
  return row
}

function upsertMessage(message, { scroll = true } = {}) {
  const stick = nearBottom()
  const existing = rows.get(message.id)
  const row = buildRow(message)
  if (existing) existing.replaceWith(row)
  else commentsList.append(row)
  rows.set(message.id, row)
  while (rows.size > MAX_ROWS) {
    const [oldestId, oldest] = rows.entries().next().value
    oldest.remove()
    rows.delete(oldestId)
  }
  $('comments-empty').hidden = true
  paintHighlight()
  if (!scroll || existing) return
  if (stick || activeView !== 'comments') scrollToBottom()
  else {
    unseen += 1
    $('jump').textContent = `↓ ${unseen} new`
    $('jump').hidden = false
  }
}

function resetMessages(messages) {
  rows.clear()
  commentsList.replaceChildren()
  $('comments-empty').hidden = messages.length > 0
  for (const message of messages) upsertMessage(message, { scroll: false })
  scrollToBottom()
}

/** "On stream" is only ever painted from the backend-confirmed highlight. */
function paintHighlight() {
  const msLeft = highlight.expiresAt ? Date.parse(highlight.expiresAt) - Date.now() : null
  // The backend's clear event is authoritative. If it was missed (a network
  // blip at the wrong moment) the card is gone from the stream anyway — never
  // leave a stale "ON STREAM" badge behind.
  if (highlight.phase === 'live' && msLeft !== null && msLeft < -1500) {
    highlight = { phase: 'idle' }
    renderDeck()
  }
  const liveId = highlight.phase === 'live' ? highlight.messageId : null
  const secondsLeft = msLeft === null ? null : Math.max(0, Math.ceil(msLeft / 1000))
  for (const [id, row] of rows) {
    const isLive = id === liveId
    row.dataset.live = String(isLive)
    row.dataset.pending = String(id === pendingId && !isLive)
    const meta = row.querySelector('.meta')
    let badge = meta.querySelector('.onstream')
    if (isLive) {
      if (!badge) meta.append((badge = el('span', 'onstream')))
      badge.textContent = secondsLeft === null ? 'ON STREAM' : `ON STREAM ${secondsLeft}s`
    } else badge?.remove()
  }
  clearInterval(highlightTimer)
  highlightTimer = liveId ? setInterval(paintHighlight, 500) : null
}

// --- deck ---------------------------------------------------------------

let describe = null
let state = null
let sessionControl = null
const holdOwners = new Map()

function cancelHolds() {
  for (const owner of holdOwners.values()) owner.cancel()
}

function retireKey(node) {
  holdOwners.get(node)?.dispose()
  holdOwners.delete(node)
}

function retireSessionControl() {
  if (sessionControl) retireKey(sessionControl.node)
  sessionControl = null
}

// Keep retained controls attached: removing and re-inserting a held button can
// lose its release route in the browser. Every removed hold owner is disposed.
function updateKeys(container, nodes) {
  for (const node of [...container.children]) {
    if (!nodes.includes(node)) {
      retireKey(node)
      node.remove()
    }
  }
  nodes.forEach((node, index) => {
    const current = container.children[index]
    if (current !== node) container.insertBefore(node, current ?? null)
  })
}

function prettyPreset(id) {
  return id.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function key({ name, hint, on = false, accent, disabled = false, onTap, onHold }) {
  const node = el('button', 'key')
  node.type = 'button'
  node.disabled = disabled
  node.dataset.on = String(on)
  if (accent) node.dataset.accent = accent
  node.append(el('span', 'name', name))
  if (hint) node.append(el('span', 'hint', hint))
  if (!onHold) {
    node.addEventListener('click', onTap)
    return node
  }
  node.append(el('span', 'hold'))
  let timer = null
  let pointerId = null
  let retired = false
  const available = () =>
    !retired &&
    node.isConnected &&
    !node.disabled &&
    client?.status === 'connected' &&
    activeView === 'deck' &&
    document.visibilityState === 'visible'
  const cancel = () => {
    clearTimeout(timer)
    timer = null
    pointerId = null
    node.dataset.holding = 'false'
  }
  holdOwners.set(node, {
    cancel,
    dispose: () => {
      retired = true
      cancel()
    }
  })
  node.addEventListener('pointerdown', (event) => {
    if (pointerId !== null || !available()) return
    pointerId = event.pointerId
    node.dataset.holding = 'true'
    timer = setTimeout(() => {
      timer = null
      node.dataset.holding = 'false'
      // Keep the pointer owned until release: repeated down events must not
      // re-arm the same gesture after it has already sent its single intent.
      if (available()) onHold()
    }, HOLD_TO_STOP_MS)
  })
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
    node.addEventListener(type, (event) => {
      if (event.pointerId !== pointerId) return
      if (timer !== null && type === 'pointerup') snack('Hold to stop.')
      cancel()
    })
  }
  node.addEventListener('contextmenu', (event) => event.preventDefault())
  return node
}

async function send(intent) {
  const result = await client.intent(intent)
  if (!result.ok) snack(result.message ?? 'Videorc refused that.')
}

function renderDeck() {
  if (!describe || !state) return
  const streaming = state.streamEnabled
  $('live').hidden = !(state.sessionActive && streaming)

  const action = streaming
    ? state.sessionActive
      ? 'streamStop'
      : 'streamStart'
    : state.sessionActive
      ? 'recordStop'
      : 'recordStart'
  if (sessionControl?.action !== action || sessionControl?.sessionState !== state.sessionState) {
    retireSessionControl()
  }
  const session = state.sessionActive
    ? (sessionControl?.node ??
      key({
        name: streaming ? 'End stream' : 'Stop recording',
        hint: 'Hold to stop',
        on: true,
        accent: 'red',
        onHold: () => send({ kind: action })
      }))
    : key({
        name: streaming ? 'Go live' : 'Record',
        hint: streaming && state.recordEnabled ? 'Stream + record' : 'Tap to start',
        accent: 'red',
        onTap: () => send({ kind: action })
      })
  sessionControl = { action, sessionState: state.sessionState, node: session }
  const mic = key({
    name: 'Microphone',
    hint: state.micMuted ? 'Muted' : 'On',
    on: state.micMuted,
    accent: 'red',
    onTap: () => send({ kind: 'micToggle' })
  })
  // Plan 069: only while the desktop can capture it, like the Studio row. The
  // phone sees an on/off boolean and nothing else about system audio.
  const systemAudio = state.systemAudioAvailable
    ? key({
        name: 'System audio',
        hint: state.systemAudioOn ? 'On' : 'Off',
        on: state.systemAudioOn,
        onTap: () => send({ kind: 'systemAudioToggle' })
      })
    : null
  const comments = key({
    name: 'Clear comment',
    hint: highlight.phase === 'live' ? 'On stream now' : 'Nothing on stream',
    disabled: highlight.phase !== 'live',
    onTap: () => send({ kind: 'commentHighlightClear' })
  })
  updateKeys(
    $('deck-main'),
    [session, mic, systemAudio, comments].filter((node) => node !== null)
  )

  const presets = describe.layoutPresets ?? []
  $('scenes-label').hidden = presets.length === 0
  $('deck-scenes').replaceChildren(
    ...presets.map((layoutPreset) =>
      key({
        name: prettyPreset(layoutPreset),
        on: state.layoutPreset === layoutPreset,
        onTap: () => send({ kind: 'sceneApply', layoutPreset })
      })
    )
  )

  const takeovers = describe.takeovers ?? []
  $('takeovers-label').hidden = takeovers.length === 0
  $('deck-takeovers').replaceChildren(
    ...takeovers.map((takeover) => {
      const on = state.activeTakeoverId === takeover.id
      return key({
        name: takeover.name,
        hint: on ? 'Showing. Tap to hide' : undefined,
        on,
        onTap: () =>
          send(on ? { kind: 'takeoverHide' } : { kind: 'takeoverShow', assetId: takeover.id })
      })
    })
  )
}

/** The renderer publishes describe/state shortly AFTER it connects. */
async function loadDescribe(attempt = 0) {
  try {
    const answer = await client.describe()
    if (answer.describe && answer.state) {
      describe = answer.describe
      state = answer.state
      renderDeck()
      return
    }
  } catch {
    // Falls through to the retry.
  }
  if (client.status === 'connected' && attempt < 20) {
    setTimeout(() => loadDescribe(attempt + 1), 1000)
  }
}

// --- wiring -------------------------------------------------------------

let client = null

function start() {
  const credentials = parseFragment(location.hash) ?? storedCredentials()
  if (!credentials) {
    showGate(
      'Pair this phone',
      'In Videorc on your computer, open Settings → Phone remote → Pair a phone, then scan the code with this phone’s camera.'
    )
    $('status').dataset.status = 'unpaired'
    $('status').textContent = STATUS_TEXT.unpaired
    return
  }
  if (credentials.kind === 'pair') {
    // Get the single-use secret out of the address bar and history at once.
    history.replaceState(null, '', location.pathname)
  }

  client = new RemoteClient({
    url: `ws://${location.host}/ws`,
    credentials,
    deviceName: deviceName()
  })
  client.on('paired', rememberCredentials)
  client.on('status', ({ status, detail }) => {
    if (status !== 'connected') retireSessionControl()
    $('status').dataset.status = status
    $('status').textContent = STATUS_TEXT[status] ?? status
    if (status === 'connected') {
      showView(activeView)
      void loadDescribe()
      void client.chatSnapshot().catch(() => {})
    } else if (status === 'unpaired') {
      forgetCredentials()
      showGate('Scan a new code', detail?.message ?? 'This phone is no longer paired.')
    }
  })
  client.on('state', (next) => {
    state = next
    if (!describe) void loadDescribe()
    renderDeck()
  })
  client.on('chat.message', (message) => upsertMessage(message))
  client.on('chat.reset', resetMessages)
  client.on('highlight', (next) => {
    highlight = next ?? { phase: 'idle' }
    if (highlight.phase !== 'idle') pendingId = null
    if (highlight.phase === 'failed' && highlight.reason) snack(highlight.reason)
    paintHighlight()
    renderDeck()
  })
  client.connect().catch(() => {})
}

commentsList.addEventListener('click', async (event) => {
  const row = event.target.closest('.comment')
  if (!row || !client) return
  const id = row.dataset.id
  const isLive = highlight.phase === 'live' && highlight.messageId === id
  pendingId = isLive ? null : id
  paintHighlight()
  const result = await client.intent(
    isLive ? { kind: 'commentHighlightClear' } : { kind: 'commentHighlight', messageId: id }
  )
  if (pendingId === id) pendingId = null
  if (!result.ok) snack(result.message ?? 'Could not show that comment.')
  paintHighlight()
})

commentsView.addEventListener('scroll', () => {
  if (nearBottom()) {
    unseen = 0
    $('jump').hidden = true
  }
})
$('jump').addEventListener('click', scrollToBottom)
$('tabs').addEventListener('click', (event) => {
  const view = event.target.closest('button')?.dataset.view
  if (view) showView(view)
})

// A phone that slept or changed network reconnects the moment it is looked at.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') cancelHolds()
  if (document.visibilityState === 'visible' && client?.status === 'reconnecting') {
    client.reconnectNow()
  }
})
window.addEventListener('pagehide', cancelHolds)

start()
