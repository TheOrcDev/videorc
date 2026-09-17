// Videorc Stream Deck plugin (remote-control plan RC4, issue #143).
//
// Keys render backend-CONFIRMED state from the remote projection — never the
// optimistic intent. When Videorc is closed or Remote Control is disabled in
// Settings, every key shows an alert glyph on press and the title says so.

import streamDeck, { action, SingletonAction } from '@elgato/streamdeck'
import type { JsonObject, KeyDownEvent, WillAppearEvent } from '@elgato/streamdeck'

import { VideorcClient, type RemoteState } from './videorc-client.js'

const client = new VideorcClient()

type TitleRenderer = (state: RemoteState | null, connected: boolean) => string

type InspectorOption = {
  value: string
  label: string
}

abstract class VideorcAction<TSettings extends JsonObject> extends SingletonAction<TSettings> {
  protected abstract renderTitle: TitleRenderer
  protected abstract intentFor(settings: TSettings, state: RemoteState | null): Record<
    string,
    unknown
  > | null

  constructor() {
    super()
    // Shared-client subscriptions live here, once per action CLASS —
    // onWillAppear fires on every visibility change and would stack
    // duplicate listeners (each refresh() would then run N times).
    client.on('state', this.refresh)
    client.on('connected', this.refresh)
    client.on('describe', this.pushInspectorOptions)
    client.on('disconnected', this.refresh)
  }

  private refresh = (): void => {
    for (const visible of this.actions) {
      void visible.setTitle(this.renderTitle(client.state, client.connected))
    }
  }

  private pushInspectorOptions = (): void => {
    void streamDeck.ui.current?.sendToPropertyInspector({
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
    void ev.action.setTitle(this.renderTitle(client.state, client.connected))
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
streamDeck.actions.registerAction(new SceneApply())
streamDeck.actions.registerAction(new TakeoverToggle())
streamDeck.actions.registerAction(new WindowFront())

client.start()
void streamDeck.connect()
