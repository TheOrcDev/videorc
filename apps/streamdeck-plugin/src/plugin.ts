// Videorc Stream Deck plugin (remote-control plan RC4, issue #143).
//
// Keys render backend-CONFIRMED state from the remote projection — never the
// optimistic intent. When Videorc is closed or Remote Control is disabled in
// Settings, every key shows an alert glyph on press and the title says so.

import { privacyKeyTitle, privacyKeyIntent } from './privacy-key.js'
import {
  bannerKeyLit,
  buddyKeyIntent,
  buddyKeyLit,
  layoutKeyLit,
  micKeyLit,
  recordKeyIntent,
  recordKeyLit,
  soundKeyLit,
  streamKeyIntent,
  streamKeyLit,
  streamManagerFrontOrCloseIntent,
  streamManagerScreenKeyAllows,
  streamManagerScreenKeyBlock,
  streamManagerScreenKeyIntent,
  streamManagerScreenKeyNotice,
  streamManagerScreenKeyLit,
  streamManagerScreenKeyTitle,
  systemAudioKeyLit,
  takeoverKeyIntent,
  takeoverKeyLit,
  type StreamManagerScreenKeySettings
} from './key-states.js'
import streamDeck, { action, SingletonAction } from '@elgato/streamdeck'
import type {
  DidReceiveSettingsEvent,
  JsonObject,
  KeyDownEvent,
  KeyUpEvent,
  WillAppearEvent,
  KeyAction,
  WillDisappearEvent
} from '@elgato/streamdeck'

import { createHoldGesture } from './hold-gesture.js'
import {
  VideorcClient,
  sceneKeyIntent,
  sceneKeyTitle,
  bannerKeyIntent,
  bannerKeyTitle,
  soundKeyIntent,
  soundKeyTitle,
  type RemoteState
} from './videorc-client.js'

const client = new VideorcClient()

/** A key's title from the confirmed state; a key that names one thing (a
 * banner) reads its own settings too. */
type TitleRenderer<TSettings extends JsonObject = JsonObject> = (
  state: RemoteState | null,
  connected: boolean,
  settings: TSettings
) => string

type InspectorOption = {
  value: string
  label: string
}

abstract class VideorcAction<TSettings extends JsonObject> extends SingletonAction<TSettings> {
  protected abstract renderTitle: TitleRenderer<TSettings>
  protected renderPressed(_state: RemoteState | null, _settings: TSettings): boolean | null {
    return null
  }
  private updatePressed(key: KeyAction<TSettings>, settings: TSettings): void {
    const pressed = this.renderPressed(client.state, settings)
    if (pressed !== null) void key.setState(client.connected && pressed ? 1 : 0)
  }
  /** Each visible key's settings, so a refresh can title every key on its own. */
  private readonly settingsById = new Map<string, TSettings>()
  protected abstract intentFor(
    settings: TSettings,
    state: RemoteState | null
  ): Record<string, unknown> | null

  constructor() {
    super()
    // Shared-client subscriptions live here, once per action CLASS —
    // onWillAppear fires on every visibility change and would stack
    // duplicate listeners (each refresh() would then run N times).
    client.on('state', this.refresh)
    client.on('state', this.pushInspectorOptions)
    client.on('connected', this.refresh)
    client.on('describe', this.pushInspectorOptions)
    // Banner and sound keys render `shown` and `playing` from describe
    // (plans 186, 189).
    client.on('describe', this.refresh)
    client.on('disconnected', this.refresh)
  }

  private refresh = (): void => {
    for (const visible of this.actions) {
      const settings = this.settingsById.get(visible.id) ?? ({} as TSettings)
      if (visible.isKey()) this.updatePressed(visible, settings)
      void visible.setTitle(this.renderTitle(client.state, client.connected, settings))
    }
  }

  private pushInspectorOptions = (): void => {
    const inspector = streamDeck.ui.current
    if (!inspector || inspector.action.manifestId !== this.manifestId) return
    void inspector.sendToPropertyInspector({
      event: 'videorc-options',
      connected: client.connected,
      options: this.inspectorOptions(),
      notice: this.inspectorNotice()
    })
  }

  /** Options the property inspector offers for this action's setting. */
  protected inspectorOptions(): InspectorOption[] {
    return []
  }

  /** A note the property inspector shows in place of its hint, if any. */
  protected inspectorNotice(): string | null {
    return null
  }

  override onWillAppear(ev: WillAppearEvent<TSettings>): void {
    this.settingsById.set(ev.action.id, ev.payload.settings)
    if (ev.action.isKey()) this.updatePressed(ev.action, ev.payload.settings)
    void ev.action.setTitle(this.renderTitle(client.state, client.connected, ev.payload.settings))
  }

  override onWillDisappear(ev: WillDisappearEvent<TSettings>): void {
    this.settingsById.delete(ev.action.id)
  }

  /** The property inspector picked something: the title follows at once. */
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<TSettings>): void {
    this.settingsById.set(ev.action.id, ev.payload.settings)
    if (ev.action.isKey()) this.updatePressed(ev.action, ev.payload.settings)
    void ev.action.setTitle(this.renderTitle(client.state, client.connected, ev.payload.settings))
  }

  /** The property inspector asks for options when it opens. */
  override onSendToPlugin(): void {
    this.pushInspectorOptions()
  }

  override async onKeyDown(ev: KeyDownEvent<TSettings>): Promise<void> {
    if (!client.connected) {
      await ev.action.showAlert()
      return
    }
    await this.send(ev.action, this.intentFor(ev.payload.settings, client.state))
  }

  /** End-to-end truth: an alert covers backend rejection (debounce, invalid),
   * renderer refusal ("Enable streaming first"), disconnects, and timeouts. */
  protected async send(
    key: { showAlert(): Promise<void>; showOk(): Promise<void> },
    intent: Record<string, unknown> | null,
    { confirm = false } = {}
  ): Promise<void> {
    if (!intent || !(await client.sendIntent(intent))) {
      await key.showAlert()
    } else if (confirm) {
      await key.showOk()
    }
  }
}

@action({ UUID: 'com.videorc.streamdeck.record-toggle' })
class RecordToggle extends VideorcAction<JsonObject> {
  protected renderTitle: TitleRenderer = (state, connected) =>
    !connected ? 'Videorc\noffline' : recordKeyLit(state) ? '● REC' : 'Record'
  protected override renderPressed(state: RemoteState | null): boolean {
    return recordKeyLit(state)
  }
  protected intentFor(_settings: JsonObject, state: RemoteState | null): Record<string, unknown> {
    return recordKeyIntent(state)
  }
}

@action({ UUID: 'com.videorc.streamdeck.stream-toggle' })
class StreamToggle extends VideorcAction<JsonObject> {
  protected renderTitle: TitleRenderer = (state, connected) =>
    !connected ? 'Videorc\noffline' : streamKeyLit(state) ? 'LIVE' : 'Go Live'
  protected override renderPressed(state: RemoteState | null): boolean {
    return streamKeyLit(state)
  }
  protected intentFor(_settings: JsonObject, state: RemoteState | null): Record<string, unknown> {
    return streamKeyIntent(state)
  }
}

@action({ UUID: 'com.videorc.streamdeck.mic-toggle' })
class MicToggle extends VideorcAction<JsonObject> {
  protected renderTitle: TitleRenderer = (state, connected) =>
    !connected ? 'Videorc\noffline' : state?.micMuted ? 'Mic\nMUTED' : 'Mic\nlive'
  protected override renderPressed(state: RemoteState | null): boolean {
    return micKeyLit(state)
  }
  protected intentFor(): Record<string, unknown> {
    return { kind: 'micToggle' }
  }
}

// Plan 069: System audio On/Off. The key shows what the session mixes; an
// app that cannot capture it (no grant, unsupported, or too old to say)
// shows N/A and the key alerts instead of sending.
@action({ UUID: 'com.videorc.streamdeck.system-audio-toggle' })
class SystemAudioToggle extends VideorcAction<JsonObject> {
  protected renderTitle: TitleRenderer = (state, connected) =>
    !connected
      ? 'Videorc\noffline'
      : !state?.systemAudioAvailable
        ? 'System\naudio N/A'
        : state.systemAudioOn
          ? 'System\naudio ON'
          : 'System\naudio off'
  protected override renderPressed(state: RemoteState | null): boolean {
    return systemAudioKeyLit(state)
  }
  protected intentFor(
    _settings: JsonObject,
    state: RemoteState | null
  ): Record<string, unknown> | null {
    return state?.systemAudioAvailable ? { kind: 'systemAudioToggle' } : null
  }
}

@action({ UUID: 'com.videorc.streamdeck.buddy-live-toggle' })
class BuddyLiveToggle extends VideorcAction<JsonObject> {
  protected renderTitle: TitleRenderer = (state, connected) =>
    !connected ? 'Videorc\noffline' : buddyKeyLit(state) ? 'Buddy\nON' : 'Buddy'
  protected override renderPressed(state: RemoteState | null): boolean {
    return buddyKeyLit(state)
  }
  protected intentFor(): Record<string, unknown> {
    return buddyKeyIntent()
  }
}

type SavedSceneSettings = { sceneId?: string }

@action({ UUID: 'com.videorc.streamdeck.saved-scene' })
class SavedSceneApply extends VideorcAction<SavedSceneSettings> {
  protected override renderPressed(
    state: RemoteState | null,
    settings: SavedSceneSettings
  ): boolean {
    return Boolean(settings.sceneId && state?.activeSavedSceneId === settings.sceneId)
  }
  protected renderTitle: TitleRenderer<SavedSceneSettings> = (state, connected, settings) =>
    sceneKeyTitle(state, settings.sceneId, connected)
  protected intentFor(settings: SavedSceneSettings): Record<string, unknown> | null {
    return sceneKeyIntent(settings.sceneId)
  }
  protected override inspectorOptions(): InspectorOption[] {
    return (client.state?.savedScenes ?? []).map(({ id, name }) => ({ value: id, label: name }))
  }
}

type SceneSettings = { layoutPreset?: string }

@action({ UUID: 'com.videorc.streamdeck.scene-apply' })
class SceneApply extends VideorcAction<SceneSettings> {
  protected renderTitle: TitleRenderer = (state, connected) =>
    !connected ? 'Videorc\noffline' : `Scene\n${state?.layoutPreset ?? ''}`
  protected override renderPressed(state: RemoteState | null, settings: SceneSettings): boolean {
    return layoutKeyLit(state, settings.layoutPreset)
  }
  protected intentFor(settings: SceneSettings): Record<string, unknown> | null {
    if (!settings.layoutPreset) {
      return null
    }
    return { kind: 'sceneApply', layoutPreset: settings.layoutPreset }
  }
  protected override inspectorOptions(): InspectorOption[] {
    return (client.describe?.layoutPresets ?? []).map((preset) => ({
      value: preset,
      label: preset
    }))
  }
}

@action({ UUID: 'com.videorc.streamdeck.screen-hide-toggle' })
class ScreenHideToggle extends VideorcAction<JsonObject> {
  protected renderTitle: TitleRenderer = (state) => privacyKeyTitle(Boolean(state?.screenHidden))
  protected override renderPressed(state: RemoteState | null): boolean {
    return Boolean(state?.screenHidden)
  }
  protected intentFor(): Record<string, unknown> {
    return privacyKeyIntent()
  }
}

type TakeoverSettings = { assetId?: string }

@action({ UUID: 'com.videorc.streamdeck.takeover-toggle' })
class TakeoverToggle extends VideorcAction<TakeoverSettings> {
  protected renderTitle: TitleRenderer<TakeoverSettings> = (state, connected, settings) =>
    !connected ? 'Videorc\noffline' : takeoverKeyLit(state, settings.assetId) ? 'BRB\nON' : 'BRB'
  protected override renderPressed(state: RemoteState | null, settings: TakeoverSettings): boolean {
    return takeoverKeyLit(state, settings.assetId)
  }
  protected intentFor(
    settings: TakeoverSettings,
    state: RemoteState | null
  ): Record<string, unknown> | null {
    return takeoverKeyIntent(state, settings.assetId)
  }
  protected override inspectorOptions(): InspectorOption[] {
    return (client.describe?.takeovers ?? []).map((takeover) => ({
      value: takeover.id,
      label: takeover.name
    }))
  }
}

type BannerSettings = { bannerId?: string }

// Plan 186: one of the streamer's banners, picked in the property inspector.
// The key shows its name, with ON while it shows (`shown` from describe),
// and a press toggles it. A banner that is gone says Banner, and a press
// alerts: Videorc refuses it.
@action({ UUID: 'com.videorc.streamdeck.banner-toggle' })
class BannerToggle extends VideorcAction<BannerSettings> {
  protected renderTitle: TitleRenderer<BannerSettings> = (_state, connected, settings) =>
    bannerKeyTitle(client.describe, settings.bannerId, connected)
  protected override renderPressed(_state: RemoteState | null, settings: BannerSettings): boolean {
    return bannerKeyLit(client.describe, settings.bannerId)
  }
  protected intentFor(settings: BannerSettings): Record<string, unknown> | null {
    return bannerKeyIntent(settings.bannerId)
  }
  protected override inspectorOptions(): InspectorOption[] {
    return (client.describe?.banners ?? []).map((banner) => ({
      value: banner.id,
      label: banner.name
    }))
  }
}

type SoundSettings = { soundId?: string }

// Plan 189: one of the streamer's sounds, picked in the property inspector.
// The key shows its name, with ON while it plays (`playing` from describe),
// and a press plays it the way its mode says. A sound that is gone says
// Sound, and a press alerts: Videorc refuses it.
@action({ UUID: 'com.videorc.streamdeck.sound-play' })
class SoundPlay extends VideorcAction<SoundSettings> {
  protected renderTitle: TitleRenderer<SoundSettings> = (_state, connected, settings) =>
    soundKeyTitle(client.describe, settings.soundId, connected)
  protected override renderPressed(_state: RemoteState | null, settings: SoundSettings): boolean {
    return soundKeyLit(client.describe, settings.soundId)
  }
  protected intentFor(settings: SoundSettings): Record<string, unknown> | null {
    return soundKeyIntent(settings.soundId)
  }
  protected override inspectorOptions(): InspectorOption[] {
    return (client.describe?.sounds ?? []).map((sound) => ({
      value: sound.id,
      label: sound.name
    }))
  }
}

type WindowSettings = { window?: 'notes' | 'comments' | 'preview' }

@action({ UUID: 'com.videorc.streamdeck.window-front' })
class WindowFront extends VideorcAction<WindowSettings> {
  protected renderTitle: TitleRenderer = (_state, connected) =>
    !connected ? 'Videorc\noffline' : 'Window'
  protected intentFor(settings: WindowSettings): Record<string, unknown> | null {
    if (!settings.window) {
      return null
    }
    return { kind: 'windowFront', window: settings.window }
  }
  protected override inspectorOptions(): InspectorOption[] {
    return (client.describe?.windows ?? ['notes', 'comments', 'preview']).map((name) => ({
      value: name,
      label: name.charAt(0).toUpperCase() + name.slice(1)
    }))
  }
}

type StreamManagerScreenSettings = StreamManagerScreenKeySettings & JsonObject

// Plan 230: a tap moves the Stream Manager to the other of the key's two
// screens, the Presenting screen viewers see and the Monitor screen the
// streamer reads. A hold brings it to the front where it is, or closes it
// when it already has the focus. The title says where it is; the key is on
// while viewers see it.
@action({ UUID: 'com.videorc.streamdeck.stream-manager-screen' })
class StreamManagerScreen extends VideorcAction<StreamManagerScreenSettings> {
  protected renderTitle: TitleRenderer<StreamManagerScreenSettings> = (
    state,
    connected,
    settings
  ) => streamManagerScreenKeyTitle(state, connected, settings, client.describe)
  protected override renderPressed(
    state: RemoteState | null,
    settings: StreamManagerScreenSettings
  ): boolean {
    return streamManagerScreenKeyLit(state, settings)
  }
  protected intentFor(settings: StreamManagerScreenSettings): Record<string, unknown> | null {
    return streamManagerScreenKeyIntent(settings)
  }
  private readonly pressed = new Map<string, KeyDownEvent<StreamManagerScreenSettings>>()
  // An older Videorc (no screen list) or a Wayland session (no tap): the
  // title says why, so the press stays quiet instead of alerting each time.
  private allows(gesture: 'tap' | 'hold'): boolean {
    return streamManagerScreenKeyAllows(streamManagerScreenKeyBlock(client.describe), gesture)
  }
  private readonly gesture = createHoldGesture({
    onTap: (id) =>
      this.release(id, async (ev) => {
        if (this.allows('tap')) await this.send(ev.action, this.intentFor(ev.payload.settings))
      }),
    onHold: (id) =>
      this.release(id, async (ev) => {
        if (this.allows('hold')) {
          await this.send(ev.action, streamManagerFrontOrCloseIntent(), { confirm: true })
        }
      })
  })
  private release(
    id: string,
    act: (ev: KeyDownEvent<StreamManagerScreenSettings>) => Promise<void>
  ): void {
    const ev = this.pressed.get(id)
    this.pressed.delete(id)
    if (ev) {
      act(ev).catch((error: unknown) =>
        streamDeck.logger.warn(`Stream Manager Screen key failed: ${String(error)}`)
      )
    }
  }
  override async onKeyDown(ev: KeyDownEvent<StreamManagerScreenSettings>): Promise<void> {
    if (!client.connected) {
      await ev.action.showAlert()
      return
    }
    this.pressed.set(ev.action.id, ev)
    this.gesture.down(ev.action.id)
  }
  override onKeyUp(ev: KeyUpEvent<StreamManagerScreenSettings>): void {
    this.gesture.up(ev.action.id)
  }
  override onWillDisappear(ev: WillDisappearEvent<StreamManagerScreenSettings>): void {
    this.gesture.cancel(ev.action.id)
    this.pressed.delete(ev.action.id)
    super.onWillDisappear(ev)
  }
  protected override inspectorOptions(): InspectorOption[] {
    return (client.describe?.screens ?? []).map((screen) => ({
      value: screen.id,
      label: screen.name
    }))
  }
  protected override inspectorNotice(): string | null {
    return client.connected
      ? streamManagerScreenKeyNotice(streamManagerScreenKeyBlock(client.describe))
      : null
  }
}

streamDeck.actions.registerAction(new RecordToggle())
streamDeck.actions.registerAction(new StreamToggle())
streamDeck.actions.registerAction(new MicToggle())
streamDeck.actions.registerAction(new SystemAudioToggle())
streamDeck.actions.registerAction(new BuddyLiveToggle())
streamDeck.actions.registerAction(new SceneApply())
streamDeck.actions.registerAction(new SavedSceneApply())
streamDeck.actions.registerAction(new ScreenHideToggle())
streamDeck.actions.registerAction(new TakeoverToggle())
streamDeck.actions.registerAction(new BannerToggle())
streamDeck.actions.registerAction(new SoundPlay())
streamDeck.actions.registerAction(new WindowFront())
streamDeck.actions.registerAction(new StreamManagerScreen())

client.start()
void streamDeck.connect()
