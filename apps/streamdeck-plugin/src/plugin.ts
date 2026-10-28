// Videorc Stream Deck plugin (remote-control plan RC4, issue #143).
//
// Keys render backend-CONFIRMED state from the remote projection — never the
// optimistic intent. When Videorc is closed or Remote Control is disabled in
// Settings, every key shows an alert glyph on press and the title says so.

import streamDeck, { action, SingletonAction } from '@elgato/streamdeck'
import type {
  DidReceiveSettingsEvent,
  JsonObject,
  KeyDownEvent,
  WillAppearEvent,
  KeyAction,
  WillDisappearEvent
} from '@elgato/streamdeck'

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
      options: this.inspectorOptions()
    })
  }

  /** Options the property inspector offers for this action's setting. */
  protected inspectorOptions(): InspectorOption[] {
    return []
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
    const intent = this.intentFor(ev.payload.settings, client.state)
    if (!intent) {
      await ev.action.showAlert()
      return
    }
    // End-to-end truth: false covers backend rejection (debounce, invalid),
    // renderer refusal ("Enable streaming first"), disconnects, and timeouts.
    const ok = await client.sendIntent(intent)
    if (!ok) {
      await ev.action.showAlert()
    }
  }
}

@action({ UUID: 'com.videorc.streamdeck.record-toggle' })
class RecordToggle extends VideorcAction<JsonObject> {
  protected renderTitle: TitleRenderer = (state, connected) =>
    !connected ? 'Videorc\noffline' : state?.sessionActive ? '● REC' : 'Record'
  protected intentFor(): Record<string, unknown> {
    return { kind: 'recordToggle' }
  }
}

@action({ UUID: 'com.videorc.streamdeck.stream-toggle' })
class StreamToggle extends VideorcAction<JsonObject> {
  protected renderTitle: TitleRenderer = (state, connected) =>
    !connected
      ? 'Videorc\noffline'
      : state?.sessionActive && state.streamEnabled
        ? 'LIVE'
        : 'Go Live'
  protected intentFor(_settings: JsonObject, state: RemoteState | null): Record<string, unknown> {
    return { kind: state?.sessionActive ? 'streamStop' : 'streamStart' }
  }
}

@action({ UUID: 'com.videorc.streamdeck.mic-toggle' })
class MicToggle extends VideorcAction<JsonObject> {
  protected renderTitle: TitleRenderer = (state, connected) =>
    !connected ? 'Videorc\noffline' : state?.micMuted ? 'Mic\nMUTED' : 'Mic\nlive'
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
  protected intentFor(
    _settings: JsonObject,
    state: RemoteState | null
  ): Record<string, unknown> | null {
    return state?.systemAudioAvailable ? { kind: 'systemAudioToggle' } : null
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

type TakeoverSettings = { assetId?: string }

@action({ UUID: 'com.videorc.streamdeck.takeover-toggle' })
class TakeoverToggle extends VideorcAction<TakeoverSettings> {
  protected renderTitle: TitleRenderer = (state, connected) =>
    !connected ? 'Videorc\noffline' : state?.activeTakeoverId ? 'BRB\nON' : 'BRB'
  protected intentFor(
    settings: TakeoverSettings,
    state: RemoteState | null
  ): Record<string, unknown> | null {
    if (state?.activeTakeoverId) {
      return { kind: 'takeoverHide' }
    }
    if (!settings.assetId) {
      return null
    }
    return { kind: 'takeoverShow', assetId: settings.assetId }
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

streamDeck.actions.registerAction(new RecordToggle())
streamDeck.actions.registerAction(new StreamToggle())
streamDeck.actions.registerAction(new MicToggle())
streamDeck.actions.registerAction(new SystemAudioToggle())
streamDeck.actions.registerAction(new SceneApply())
streamDeck.actions.registerAction(new SavedSceneApply())
streamDeck.actions.registerAction(new TakeoverToggle())
streamDeck.actions.registerAction(new BannerToggle())
streamDeck.actions.registerAction(new SoundPlay())
streamDeck.actions.registerAction(new WindowFront())

client.start()
void streamDeck.connect()
