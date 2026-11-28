/**
 * The cloud-parity cases' seams into the app, one helper per seam, for both
 * apps (plan 260 parity foundation F4).
 *
 * Electron's cases reach the Studio and its renderer room through `h.eval`
 * (`eval-js` in the renderer): `window.__videorcSmokeScenePresets.*`. The GPUI
 * app has no renderer: its Studio answers smoke commands, and its room lives
 * in the backend (`room_host`), which publishes `cloud.room.presentation` and
 * answers `cloud.room.presentation.get` with the latest of every part. The
 * Electron branch here is exactly the `h.eval` source the cases sent before,
 * so an Electron run is unchanged; the GPUI branch says by name what it can't
 * do yet instead of passing.
 *
 * Shapes: the room helpers answer what Electron's `roomControls.snapshot`
 * part answered on Electron, and the backend's `cloud.room.presentation` part
 * on GPUI (the same fields where the backend took the renderer's over: see
 * `RoomPresentationStatus`, `RoomAuxStatus`, `RoomScreenStatus` in
 * `crates/videorc-backend/src/cloud_talk.rs`). A case that reads a field only
 * one of them has says so where it reads it.
 */
import { roomFixtureDevicesSource } from './room-fixture-devices.mjs'

/** Not available on the GPUI app yet: thrown, never a pass. */
export class SeamNotOnGpui extends Error {
  constructor(seam, why) {
    super(`${seam} has no GPUI seam yet: ${why}`)
    this.name = 'SeamNotOnGpui'
  }
}

const presets = (call) => `return await window.__videorcSmokeScenePresets.${call}`

/** `room-switch-set`'s switch for each room helper (GPUI). */
const ROOM_SWITCH = {
  sounds: 'sounds',
  scenes: 'scenes',
  graphics: 'graphics',
  avatar: 'avatar',
  avatarGuests: 'avatarGuests'
}

/** Electron's renderer room seam for each room helper. */
const ELECTRON_ROOM = {
  sounds: 'roomSounds',
  scenes: 'roomScenes',
  graphics: 'roomGraphics',
  avatar: 'roomAvatar',
  avatarGuests: 'roomAvatarGuests'
}

/** The GPUI answer for a room helper: the part of the backend's presentation. Pure. */
export function presentationPart(presentation, part) {
  switch (part) {
    case 'sounds':
      return presentation?.media?.aux ?? null
    case 'scenes':
      return presentation?.scene ?? null
    case 'graphics':
      return presentation?.graphics ?? null
    case 'avatar':
      return presentation?.avatar ?? null
    case 'avatarGuests':
      return presentation?.avatar?.guests ?? null
    case 'privacy':
      return presentation?.media?.screen ?? null
    default:
      throw new Error(`No presentation part is called ${part}`)
  }
}

/** The fixture devices' camera and microphone ids from `studio-room-fixture-devices`. Pure. */
export function fixtureIds(seeded) {
  const ids = seeded?.seeded ?? []
  const camera = ids.find((id) => id.includes('camera'))
  const microphone = ids.find((id) => id.includes('microphone'))
  if (!camera || !microphone)
    throw new Error(`No fixture camera and microphone: ${JSON.stringify(seeded)}`)
  return { camera, microphone }
}

export function paritySeams(h) {
  const gpui = Boolean(h.isGpui)
  const presentation = async () =>
    (await h.rpc('cloud.room.presentation.get'))?.presentation ?? null

  const studio = {
    /** The room's fixture camera and microphone (`roomFixtureDevicesSource`);
     * `controls`: no camera, camera off, the microphone muted. The camera's id. */
    async fixtureDevices(controls = false) {
      if (!gpui) return h.eval(roomFixtureDevicesSource(controls))
      const { camera, microphone } = fixtureIds(await h.command('studio-room-fixture-devices', {}))
      await h.command('studio-capture-configure', {
        config: {
          sources: {
            cameraId: controls ? null : camera,
            cameraOff: controls,
            microphoneId: microphone,
            microphoneName: 'Parity microphone'
          },
          audio: { microphoneMuted: controls }
        }
      })
      return camera
    },
    /** The camera picked live (`camera(id)`; null turns it off). True. */
    async camera(cameraId) {
      if (!gpui) return h.eval(presets(`camera(${JSON.stringify(cameraId)})`))
      await h.command('select-camera-device', cameraId ? { cameraId } : { off: true })
      return true
    },
    /** The microphone row's mute (`microphone('mute' | 'unmute')`). True when it landed. */
    async microphone(mode) {
      if (!gpui) return h.eval(presets(`microphone('${mode}')`))
      await h.command('studio-microphone-mute', { muted: mode === 'mute' })
      return true
    },
    /** The microphone picked live (`roomMicrophoneSelect`). */
    async microphoneSelect(id, name) {
      if (!gpui)
        return h.eval(
          presets(`roomMicrophoneSelect(${JSON.stringify(id)}, ${JSON.stringify(name)})`)
        )
      return h.command('select-microphone-device', id ? { microphoneId: id } : { off: true })
    },
    /** A global shortcut's action (`shortcut('mic-toggle')`, a scene key). */
    async shortcut(action) {
      if (!gpui) {
        await h.eval(
          `window.__videorcSmokeScenePresets.shortcut(${JSON.stringify(action)}); return true`
        )
        return true
      }
      await h.command('studio-shortcut', { action })
      return true
    },
    /** The session's output facts (`outputFacts()`). On GPUI only
     * `microphoneMuted` so far (`studio-state`); a case that reads more must
     * add it to `studio-state` first. */
    async outputFacts() {
      if (!gpui) return h.eval(presets('outputFacts()'))
      const state = await h.command('studio-state')
      return { microphoneMuted: state.microphoneMuted }
    },
    /** Hide screen on or off (`screenPrivacyCommand('hide' | 'show')`). */
    async screenPrivacy(action) {
      if (!gpui) return h.eval(presets(`screenPrivacyCommand('${action}')`))
      return h.command('studio-screen-privacy', { hidden: action === 'hide' })
    },
    /** A control clicked: Electron's DOM selector, or the GPUI ui-driver's
     * selector (`{id}`, `{label}`, `{role, label}`). True when it was there and enabled. */
    async click({ electron, gpui: selector }) {
      if (!gpui) {
        return h.eval(
          `const button = document.querySelector(${JSON.stringify(electron)}); if (!button || button.disabled) return false; button.click(); return true`
        )
      }
      if (!selector) throw new SeamNotOnGpui(`click ${electron}`, 'no GPUI control named for it')
      await h.command('ui-click', selector)
      return true
    }
  }

  // The room's scenes opt-in as this run last set it: the room host has no
  // read of it, and every show starts with scenes off.
  let scenesOptIn = false

  /** A room switch and its state: `enabled` given switches it first. */
  const roomSwitch = (part) => async (enabled) => {
    if (!gpui) {
      return h.eval(
        presets(`${ELECTRON_ROOM[part]}(${enabled === undefined ? '' : JSON.stringify(enabled)})`)
      )
    }
    if (enabled !== undefined) {
      const state = await h.command('room-switch-set', { switch: ROOM_SWITCH[part], enabled })
      if (part === 'scenes') scenesOptIn = Boolean(state?.enabled)
    }
    const current = presentationPart(await presentation(), part)
    // Electron's `roomScenes` answers the opt-in and the status together.
    return part === 'scenes' ? { enabled: scenesOptIn, status: current } : current
  }

  const room = {
    sounds: roomSwitch('sounds'),
    scenes: roomSwitch('scenes'),
    graphics: roomSwitch('graphics'),
    avatar: roomSwitch('avatar'),
    avatarGuests: roomSwitch('avatarGuests'),
    /** The room's screen privacy (`roomPrivacy()`): on GPUI the backend's
     * `RoomScreenStatus` (`status`, `epoch`, `published`, `hidden`). */
    async privacy() {
      if (!gpui) return h.eval(presets('roomPrivacy()'))
      return presentationPart(await presentation(), 'privacy')
    },
    /** The avatar's motion probe (`roomAvatarMotion()`). */
    async avatarMotion() {
      if (!gpui) return h.eval(presets('roomAvatarMotion()'))
      throw new SeamNotOnGpui('roomAvatarMotion', 'the backend avatar has no motion probe read yet')
    },
    /** The whole presentation the backend last published (GPUI), or null. */
    presentation
  }

  return { gpui, studio, room }
}
