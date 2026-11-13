/**
 * The guest page the fake cloud web serves at `/guest/<slug>` (plan 224
 * S-G1): a headless-Chrome stand-in for `videorc-web`'s
 * `app/guest/[slug]/page.tsx`, following the same wire (`docs/cloud.md`
 * "Talk shows", `lib/cloud/guest-wire.ts`):
 *
 * - `GET /api/guest/:slug` for the show's state, `POST .../join` to ask,
 *   `GET .../join/:requestId` until the host answers;
 * - `let-in` carries a LiveKit token; the page connects with
 *   `autoSubscribe: false`, publishes its camera (VP8, simulcast) and mic,
 *   and subscribes only to the host and the people the host's stage topic
 *   names (D11); it never asks for the runner's return, unless the smoke
 *   says `tryReturn=1`, which proves the runner's permissions refuse it;
 * - `window.__guest` is what the smoke reads: the phase, the identities it
 *   subscribed to, the runner's publications it saw, every refusal, the
 *   stage it was told, and how it was disconnected (a removed guest reads
 *   `removed`).
 *
 * `livekit-client` comes from `/guest-assets/livekit-client.esm.mjs`, the
 * desktop's own copy. Nothing here is a secret: the token lives in the page
 * for the connect and is never written anywhere.
 */
export function guestPageHtml({ slug, title = 'Videorc guest' }) {
  const safeSlug = JSON.stringify(String(slug))
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 16px; background: #111; color: #eee; }
  video { width: 240px; height: 135px; background: #000; margin: 4px; }
  #status { white-space: pre-wrap; }
</style>
</head>
<body>
<h1 id="title">${escapeHtml(title)}</h1>
<p id="status">loading</p>
<div id="videos"></div>
<script type="module">
import {
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  DisconnectReason,
  createLocalTracks
} from '/guest-assets/livekit-client.esm.mjs'

const slug = ${safeSlug}
const params = new URLSearchParams(location.search)
const name = params.get('name') || 'Guest'
const tryReturn = params.get('tryReturn') === '1'
const RUNNER_PREFIX = 'runner:'
const STAGE_TOPIC = 'videorc.stage'

const state = {
  phase: 'loading',
  show: null,
  requestId: null,
  guestId: null,
  identity: null,
  hostIdentity: null,
  connected: false,
  published: { camera: false, microphone: false },
  onStage: [],
  stageMessages: 0,
  participants: [],
  subscribed: [],
  subscribeAsked: [],
  runnerPublications: [],
  runnerSubscribeAttempts: 0,
  runnerTracksReceived: 0,
  permissionChanges: [],
  subscriptionFailures: [],
  disconnected: null,
  removed: false,
  errors: [],
  events: []
}
window.__guest = state
const statusElement = document.getElementById('status')
function note(line) {
  state.events.push({ at: Date.now(), line })
  statusElement.textContent = state.phase + '\\n' + line
}
function fail(error) {
  state.errors.push(String((error && error.message) || error))
  note('error: ' + String((error && error.message) || error))
}

function isRunner(identity) {
  return typeof identity === 'string' && identity.startsWith(RUNNER_PREFIX)
}
function subscribesTo(identity) {
  if (isRunner(identity)) return false
  if (state.hostIdentity && identity === state.hostIdentity) return true
  return state.onStage.includes(identity)
}

let room = null
function applySubscriptions() {
  if (!room) return
  for (const participant of room.remoteParticipants.values()) {
    const runner = isRunner(participant.identity)
    const wanted = runner ? tryReturn : subscribesTo(participant.identity)
    for (const publication of participant.trackPublications.values()) {
      if (runner) {
        const key = participant.identity + ':' + publication.source
        if (!state.runnerPublications.includes(key)) state.runnerPublications.push(key)
      }
      if (wanted && !publication.isSubscribed) {
        const key = participant.identity + ':' + publication.source
        if (!state.subscribeAsked.includes(key)) state.subscribeAsked.push(key)
        if (runner) state.runnerSubscribeAttempts += 1
        publication.setSubscribed(true)
      }
    }
  }
  state.participants = [...room.remoteParticipants.values()].map((participant) => participant.identity)
}

async function connect(url, token) {
  state.phase = 'connecting'
  note('connecting')
  room = new Room({
    adaptiveStream: false,
    dynacast: false,
    publishDefaults: {
      videoCodec: 'vp8',
      simulcast: true,
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360]
    }
  })
  room
    .on(RoomEvent.ParticipantConnected, () => applySubscriptions())
    .on(RoomEvent.ParticipantDisconnected, () => applySubscriptions())
    .on(RoomEvent.TrackPublished, () => applySubscriptions())
    .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      const key = participant.identity + ':' + track.kind
      state.subscribed.push(key)
      if (isRunner(participant.identity)) state.runnerTracksReceived += 1
      if (track.kind === Track.Kind.Video) {
        const element = track.attach()
        element.setAttribute('data-identity', participant.identity)
        document.getElementById('videos').appendChild(element)
      }
      note('subscribed ' + key)
    })
    .on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      const key = participant.identity + ':' + track.kind
      state.subscribed = state.subscribed.filter((entry) => entry !== key)
      for (const element of track.detach()) element.remove()
    })
    .on(RoomEvent.TrackSubscriptionPermissionChanged, (participant, status) => {
      state.permissionChanges.push({ identity: participant.identity, status: String(status) })
      note('permission ' + participant.identity + ' ' + String(status))
    })
    .on(RoomEvent.TrackSubscriptionFailed, (sid, participant, reason) => {
      state.subscriptionFailures.push({ identity: participant.identity, reason: String(reason) })
    })
    .on(RoomEvent.DataReceived, (payload, participant, kind, topic) => {
      if (topic !== STAGE_TOPIC) return
      if (!participant || !state.hostIdentity || participant.identity !== state.hostIdentity) return
      try {
        const message = JSON.parse(new TextDecoder().decode(payload))
        if (message && message.v === 1 && Array.isArray(message.onStage)) {
          state.onStage = message.onStage.filter((entry) => typeof entry === 'string' && !isRunner(entry))
          state.stageMessages += 1
          applySubscriptions()
        }
      } catch (error) {
        fail(error)
      }
    })
    .on(RoomEvent.Disconnected, (reason) => {
      state.connected = false
      state.disconnected = { code: reason ?? null, name: DisconnectReason[reason] ?? null }
      if (reason === DisconnectReason.PARTICIPANT_REMOVED) {
        state.removed = true
        state.phase = 'removed'
      } else if (reason === DisconnectReason.ROOM_DELETED) {
        state.phase = 'ended'
      } else {
        state.phase = 'disconnected'
      }
      note('disconnected ' + String(state.disconnected.name ?? reason))
    })
  await room.connect(url, token, { autoSubscribe: false })
  state.connected = true
  state.identity = room.localParticipant.identity
  state.phase = 'connected'
  note('connected as ' + state.identity)
  applySubscriptions()
  const tracks = await createLocalTracks({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    video: { resolution: VideoPresets.h360.resolution }
  })
  for (const track of tracks) {
    if (track.kind === Track.Kind.Video) {
      await room.localParticipant.publishTrack(track, {
        source: Track.Source.Camera,
        videoCodec: 'vp8',
        simulcast: true,
        videoEncoding: VideoPresets.h360.encoding
      })
      state.published.camera = true
    } else {
      await room.localParticipant.publishTrack(track, { source: Track.Source.Microphone })
      state.published.microphone = true
    }
  }
  state.phase = 'published'
  note('published camera and microphone')
}

window.__guestLeave = async () => {
  try {
    await fetch('/api/guest/' + encodeURIComponent(slug) + '/leave', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ guestId: state.guestId })
    })
  } catch (error) {
    fail(error)
  }
  if (room) await room.disconnect()
  state.phase = 'left'
}

async function main() {
  const show = await (await fetch('/api/guest/' + encodeURIComponent(slug))).json()
  state.show = show
  if (show.state !== 'open' && show.state !== 'waiting-for-host') {
    state.phase = 'refused:' + show.state
    note('the link is ' + show.state)
    return
  }
  const joined = await fetch('/api/guest/' + encodeURIComponent(slug) + '/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, device: 'computer' })
  })
  if (!joined.ok) {
    state.phase = 'refused:join-' + joined.status
    note('join refused ' + joined.status)
    return
  }
  state.requestId = (await joined.json()).requestId
  state.phase = 'waiting'
  note('asked to join as ' + name)
  for (;;) {
    const answer = await (
      await fetch('/api/guest/' + encodeURIComponent(slug) + '/join/' + encodeURIComponent(state.requestId))
    ).json()
    if (answer.state === 'let-in') {
      state.guestId = answer.guestId
      state.hostIdentity = answer.hostIdentity ?? null
      await connect(answer.room.url, answer.room.token)
      return
    }
    if (answer.state !== 'waiting') {
      state.phase = answer.state
      note('the host said ' + answer.state)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}
main().catch(fail)
</script>
</body>
</html>
`
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
