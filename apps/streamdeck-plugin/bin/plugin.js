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
import streamDeck, { action, SingletonAction } from '@elgato/streamdeck';
import { VideorcClient } from './videorc-client.js';
const client = new VideorcClient();
class VideorcAction extends SingletonAction {
    constructor() {
        super();
        // Shared-client subscriptions live here, once per action CLASS —
        // onWillAppear fires on every visibility change and would stack
        // duplicate listeners (each refresh() would then run N times).
        client.on('state', this.refresh);
        client.on('connected', this.refresh);
        client.on('describe', this.pushInspectorOptions);
        client.on('disconnected', this.refresh);
    }
    refresh = () => {
        for (const visible of this.actions) {
            void visible.setTitle(this.renderTitle(client.state, client.connected));
        }
    };
    pushInspectorOptions = () => {
        void streamDeck.ui.current?.sendToPropertyInspector({
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
        void ev.action.setTitle(this.renderTitle(client.state, client.connected));
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
streamDeck.actions.registerAction(new SceneApply());
streamDeck.actions.registerAction(new TakeoverToggle());
streamDeck.actions.registerAction(new WindowFront());
client.start();
void streamDeck.connect();
