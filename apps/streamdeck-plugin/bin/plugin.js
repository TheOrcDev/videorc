// Videorc Stream Deck plugin (remote-control plan RC4, issue #143).
//
// Keys render backend-CONFIRMED state from the remote projection — never the
// optimistic intent. When Videorc is closed or Remote Control is disabled in
// Settings, every key shows an alert glyph on press and the title says so.
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
import { privacyKeyTitle, privacyKeyIntent } from './privacy-key.js';
import streamDeck, { action, SingletonAction } from '@elgato/streamdeck';
import { VideorcClient, sceneKeyIntent, sceneKeyTitle, bannerKeyIntent, bannerKeyTitle, soundKeyIntent, soundKeyTitle } from './videorc-client.js';
const client = new VideorcClient();
class VideorcAction extends SingletonAction {
    renderPressed(_state, _settings) {
        return null;
    }
    updatePressed(key, settings) {
        const pressed = this.renderPressed(client.state, settings);
        if (pressed !== null)
            void key.setState(client.connected && pressed ? 1 : 0);
    }
    /** Each visible key's settings, so a refresh can title every key on its own. */
    settingsById = new Map();
    constructor() {
        super();
        // Shared-client subscriptions live here, once per action CLASS —
        // onWillAppear fires on every visibility change and would stack
        // duplicate listeners (each refresh() would then run N times).
        client.on('state', this.refresh);
        client.on('state', this.pushInspectorOptions);
        client.on('connected', this.refresh);
        client.on('describe', this.pushInspectorOptions);
        // Banner and sound keys render `shown` and `playing` from describe
        // (plans 186, 189).
        client.on('describe', this.refresh);
        client.on('disconnected', this.refresh);
    }
    refresh = () => {
        for (const visible of this.actions) {
            const settings = this.settingsById.get(visible.id) ?? {};
            if (visible.isKey())
                this.updatePressed(visible, settings);
            void visible.setTitle(this.renderTitle(client.state, client.connected, settings));
        }
    };
    pushInspectorOptions = () => {
        const inspector = streamDeck.ui.current;
        if (!inspector || inspector.action.manifestId !== this.manifestId)
            return;
        void inspector.sendToPropertyInspector({
            event: 'videorc-options',
            connected: client.connected,
            options: this.inspectorOptions()
        });
    };
    /** Options the property inspector offers for this action's setting. */
    inspectorOptions() {
        return [];
    }
    onWillAppear(ev) {
        this.settingsById.set(ev.action.id, ev.payload.settings);
        if (ev.action.isKey())
            this.updatePressed(ev.action, ev.payload.settings);
        void ev.action.setTitle(this.renderTitle(client.state, client.connected, ev.payload.settings));
    }
    onWillDisappear(ev) {
        this.settingsById.delete(ev.action.id);
    }
    /** The property inspector picked something: the title follows at once. */
    onDidReceiveSettings(ev) {
        this.settingsById.set(ev.action.id, ev.payload.settings);
        if (ev.action.isKey())
            this.updatePressed(ev.action, ev.payload.settings);
        void ev.action.setTitle(this.renderTitle(client.state, client.connected, ev.payload.settings));
    }
    /** The property inspector asks for options when it opens. */
    onSendToPlugin() {
        this.pushInspectorOptions();
    }
    async onKeyDown(ev) {
        if (!client.connected) {
            await ev.action.showAlert();
            return;
        }
        const intent = this.intentFor(ev.payload.settings, client.state);
        if (!intent) {
            await ev.action.showAlert();
            return;
        }
        // End-to-end truth: false covers backend rejection (debounce, invalid),
        // renderer refusal ("Enable streaming first"), disconnects, and timeouts.
        const ok = await client.sendIntent(intent);
        if (!ok) {
            await ev.action.showAlert();
        }
    }
}
let RecordToggle = (() => {
    let _classDecorators = [action({ UUID: 'com.videorc.streamdeck.record-toggle' })];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = VideorcAction;
    var RecordToggle = class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            RecordToggle = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        renderTitle = (state, connected) => !connected ? 'Videorc\noffline' : state?.sessionActive ? '● REC' : 'Record';
        intentFor() {
            return { kind: 'recordToggle' };
        }
    };
    return RecordToggle = _classThis;
})();
let StreamToggle = (() => {
    let _classDecorators = [action({ UUID: 'com.videorc.streamdeck.stream-toggle' })];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = VideorcAction;
    var StreamToggle = class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            StreamToggle = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        renderTitle = (state, connected) => !connected
            ? 'Videorc\noffline'
            : state?.sessionActive && state.streamEnabled
                ? 'LIVE'
                : 'Go Live';
        intentFor(_settings, state) {
            return { kind: state?.sessionActive ? 'streamStop' : 'streamStart' };
        }
    };
    return StreamToggle = _classThis;
})();
let MicToggle = (() => {
    let _classDecorators = [action({ UUID: 'com.videorc.streamdeck.mic-toggle' })];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = VideorcAction;
    var MicToggle = class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            MicToggle = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        renderTitle = (state, connected) => !connected ? 'Videorc\noffline' : state?.micMuted ? 'Mic\nMUTED' : 'Mic\nlive';
        intentFor() {
            return { kind: 'micToggle' };
        }
    };
    return MicToggle = _classThis;
})();
// Plan 069: System audio On/Off. The key shows what the session mixes; an
// app that cannot capture it (no grant, unsupported, or too old to say)
// shows N/A and the key alerts instead of sending.
let SystemAudioToggle = (() => {
    let _classDecorators = [action({ UUID: 'com.videorc.streamdeck.system-audio-toggle' })];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = VideorcAction;
    var SystemAudioToggle = class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            SystemAudioToggle = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        renderTitle = (state, connected) => !connected
            ? 'Videorc\noffline'
            : !state?.systemAudioAvailable
                ? 'System\naudio N/A'
                : state.systemAudioOn
                    ? 'System\naudio ON'
                    : 'System\naudio off';
        intentFor(_settings, state) {
            return state?.systemAudioAvailable ? { kind: 'systemAudioToggle' } : null;
        }
    };
    return SystemAudioToggle = _classThis;
})();
let SavedSceneApply = (() => {
    let _classDecorators = [action({ UUID: 'com.videorc.streamdeck.saved-scene' })];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = VideorcAction;
    var SavedSceneApply = class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            SavedSceneApply = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        renderPressed(state, settings) {
            return Boolean(settings.sceneId && state?.activeSavedSceneId === settings.sceneId);
        }
        renderTitle = (state, connected, settings) => sceneKeyTitle(state, settings.sceneId, connected);
        intentFor(settings) {
            return sceneKeyIntent(settings.sceneId);
        }
        inspectorOptions() {
            return (client.state?.savedScenes ?? []).map(({ id, name }) => ({ value: id, label: name }));
        }
    };
    return SavedSceneApply = _classThis;
})();
let SceneApply = (() => {
    let _classDecorators = [action({ UUID: 'com.videorc.streamdeck.scene-apply' })];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = VideorcAction;
    var SceneApply = class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            SceneApply = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        renderTitle = (state, connected) => !connected ? 'Videorc\noffline' : `Scene\n${state?.layoutPreset ?? ''}`;
        intentFor(settings) {
            if (!settings.layoutPreset) {
                return null;
            }
            return { kind: 'sceneApply', layoutPreset: settings.layoutPreset };
        }
        inspectorOptions() {
            return (client.describe?.layoutPresets ?? []).map((preset) => ({
                value: preset,
                label: preset
            }));
        }
    };
    return SceneApply = _classThis;
})();
let ScreenHideToggle = (() => {
    let _classDecorators = [action({ UUID: 'com.videorc.streamdeck.screen-hide-toggle' })];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = VideorcAction;
    var ScreenHideToggle = class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            ScreenHideToggle = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        renderTitle = (state) => privacyKeyTitle(Boolean(state?.screenHidden));
        renderPressed(state) {
            return Boolean(state?.screenHidden);
        }
        intentFor() {
            return privacyKeyIntent();
        }
    };
    return ScreenHideToggle = _classThis;
})();
let TakeoverToggle = (() => {
    let _classDecorators = [action({ UUID: 'com.videorc.streamdeck.takeover-toggle' })];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = VideorcAction;
    var TakeoverToggle = class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            TakeoverToggle = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        renderTitle = (state, connected) => !connected ? 'Videorc\noffline' : state?.activeTakeoverId ? 'BRB\nON' : 'BRB';
        intentFor(settings, state) {
            if (state?.activeTakeoverId) {
                return { kind: 'takeoverHide' };
            }
            if (!settings.assetId) {
                return null;
            }
            return { kind: 'takeoverShow', assetId: settings.assetId };
        }
        inspectorOptions() {
            return (client.describe?.takeovers ?? []).map((takeover) => ({
                value: takeover.id,
                label: takeover.name
            }));
        }
    };
    return TakeoverToggle = _classThis;
})();
// Plan 186: one of the streamer's banners, picked in the property inspector.
// The key shows its name, with ON while it shows (`shown` from describe),
// and a press toggles it. A banner that is gone says Banner, and a press
// alerts: Videorc refuses it.
let BannerToggle = (() => {
    let _classDecorators = [action({ UUID: 'com.videorc.streamdeck.banner-toggle' })];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = VideorcAction;
    var BannerToggle = class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            BannerToggle = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        renderTitle = (_state, connected, settings) => bannerKeyTitle(client.describe, settings.bannerId, connected);
        intentFor(settings) {
            return bannerKeyIntent(settings.bannerId);
        }
        inspectorOptions() {
            return (client.describe?.banners ?? []).map((banner) => ({
                value: banner.id,
                label: banner.name
            }));
        }
    };
    return BannerToggle = _classThis;
})();
// Plan 189: one of the streamer's sounds, picked in the property inspector.
// The key shows its name, with ON while it plays (`playing` from describe),
// and a press plays it the way its mode says. A sound that is gone says
// Sound, and a press alerts: Videorc refuses it.
let SoundPlay = (() => {
    let _classDecorators = [action({ UUID: 'com.videorc.streamdeck.sound-play' })];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = VideorcAction;
    var SoundPlay = class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            SoundPlay = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        renderTitle = (_state, connected, settings) => soundKeyTitle(client.describe, settings.soundId, connected);
        intentFor(settings) {
            return soundKeyIntent(settings.soundId);
        }
        inspectorOptions() {
            return (client.describe?.sounds ?? []).map((sound) => ({
                value: sound.id,
                label: sound.name
            }));
        }
    };
    return SoundPlay = _classThis;
})();
let WindowFront = (() => {
    let _classDecorators = [action({ UUID: 'com.videorc.streamdeck.window-front' })];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = VideorcAction;
    var WindowFront = class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            WindowFront = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        renderTitle = (_state, connected) => !connected ? 'Videorc\noffline' : 'Window';
        intentFor(settings) {
            if (!settings.window) {
                return null;
            }
            return { kind: 'windowFront', window: settings.window };
        }
        inspectorOptions() {
            return (client.describe?.windows ?? ['notes', 'comments', 'preview']).map((name) => ({
                value: name,
                label: name.charAt(0).toUpperCase() + name.slice(1)
            }));
        }
    };
    return WindowFront = _classThis;
})();
streamDeck.actions.registerAction(new RecordToggle());
streamDeck.actions.registerAction(new StreamToggle());
streamDeck.actions.registerAction(new MicToggle());
streamDeck.actions.registerAction(new SystemAudioToggle());
streamDeck.actions.registerAction(new SceneApply());
streamDeck.actions.registerAction(new SavedSceneApply());
streamDeck.actions.registerAction(new ScreenHideToggle());
streamDeck.actions.registerAction(new TakeoverToggle());
streamDeck.actions.registerAction(new BannerToggle());
streamDeck.actions.registerAction(new SoundPlay());
streamDeck.actions.registerAction(new WindowFront());
client.start();
void streamDeck.connect();
