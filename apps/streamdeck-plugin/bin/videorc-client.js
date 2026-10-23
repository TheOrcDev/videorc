// Local connection to the Videorc backend's remote-control surface.
//
// Pairing is same-machine: the app writes a 0600 discovery file next to its
// database when Remote Control is enabled in Settings. This client watches
// that file, connects with the token, keeps a live state snapshot for key
// rendering, and reconnects with backoff when the app restarts, the token
// rotates, or the surface is disabled.
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
/** Longest banner name a key title shows before it ends in "…". */
const BANNER_TITLE_MAX_CHARS = 10;
/**
 * A Banner key's title (plan 186): the banner's name, with ON while it
 * shows. A key whose banner is gone, or not picked yet, says Banner.
 */
export function bannerKeyTitle(describe, bannerId, connected) {
    if (!connected)
        return 'Videorc\noffline';
    const banner = describe?.banners?.find((candidate) => candidate.id === bannerId);
    if (!banner)
        return 'Banner';
    const name = banner.name.length > BANNER_TITLE_MAX_CHARS
        ? `${banner.name.slice(0, BANNER_TITLE_MAX_CHARS - 1).trimEnd()}…`
        : banner.name;
    return banner.shown ? `${name}\nON` : name;
}
/** A Banner key's intent: a toggle by id, or nothing until one is picked. */
export function bannerKeyIntent(bannerId) {
    return bannerId ? { kind: 'bannerToggle', bannerId } : null;
}
/** Longest sound name a key title shows before it ends in "…". */
const SOUND_TITLE_MAX_CHARS = 10;
/**
 * A Play sound key's title (plan 189): the sound's name, with ON while it
 * plays. A key whose sound is gone, or not picked yet, says Sound.
 */
export function soundKeyTitle(describe, soundId, connected) {
    if (!connected)
        return 'Videorc\noffline';
    const sound = describe?.sounds?.find((candidate) => candidate.id === soundId);
    if (!sound)
        return 'Sound';
    const name = sound.name.length > SOUND_TITLE_MAX_CHARS
        ? `${sound.name.slice(0, SOUND_TITLE_MAX_CHARS - 1).trimEnd()}…`
        : sound.name;
    return sound.playing ? `${name}\nON` : name;
}
/**
 * A Play sound key's intent: a press by id, so the sound plays the way its
 * mode says (Play once restarts, Play/stop and Loop stop a playing sound),
 * or nothing until one is picked.
 */
export function soundKeyIntent(soundId) {
    return soundId ? { kind: 'soundPlay', soundId } : null;
}
const RECONNECT_DELAY_MS = 2_000;
/** An intent that neither acked nor failed within this window counts as
 * failed — the deck key must never hang waiting for feedback. */
const INTENT_ACK_TIMEOUT_MS = 5_000;
export function defaultDiscoveryPath() {
    if (process.platform === 'darwin') {
        return join(homedir(), 'Library', 'Application Support', 'Videorc', 'remote-control.json');
    }
    if (process.platform === 'win32') {
        return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Videorc', 'remote-control.json');
    }
    return join(homedir(), '.config', 'Videorc', 'remote-control.json');
}
export function readDiscovery(path) {
    try {
        if (!existsSync(path)) {
            return null;
        }
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (!parsed.port || !parsed.token) {
            return null;
        }
        return {
            host: parsed.host ?? '127.0.0.1',
            port: parsed.port,
            token: parsed.token,
            protocol: parsed.protocol ?? 1
        };
    }
    catch {
        return null;
    }
}
/**
 * Events: `state` (RemoteState), `describe` (RemoteDescribe), `connected`,
 * `disconnected`.
 */
export class VideorcClient extends EventEmitter {
    discoveryPath;
    state = null;
    describe = null;
    connected = false;
    ws = null;
    nextRequestId = 0;
    reconnectTimer = null;
    stopped = false;
    /** Intent sends awaiting their ServerResponse, keyed by request id. */
    pendingRequests = new Map();
    /** Admitted intents awaiting the renderer's remote.ack, keyed by intentId. */
    pendingAcks = new Map();
    /** One describe read at a time; a state that lands meanwhile reads again. */
    describeInFlight = null;
    describeStale = false;
    constructor(discoveryPath = defaultDiscoveryPath()) {
        super();
        this.discoveryPath = discoveryPath;
    }
    start() {
        this.stopped = false;
        this.connect();
    }
    stop() {
        this.stopped = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.ws?.close();
        this.ws = null;
    }
    /**
     * Resolves with the END-TO-END outcome: false when the backend rejects the
     * intent (invalid, debounced, remote control unavailable), when the
     * renderer's ack reports failure, on disconnect, or on timeout. Deck keys
     * render the result — a rejected press must never look like success.
     */
    sendIntent(intent) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return Promise.resolve(false);
        }
        this.nextRequestId += 1;
        const requestId = `sd-${this.nextRequestId}`;
        const result = new Promise((resolve) => {
            const timer = setTimeout(() => settle(false), INTENT_ACK_TIMEOUT_MS);
            const settle = (ok) => {
                clearTimeout(timer);
                this.pendingRequests.delete(requestId);
                resolve(ok);
            };
            this.pendingRequests.set(requestId, settle);
        });
        this.ws.send(JSON.stringify({
            id: requestId,
            method: 'remote.intent',
            params: intent
        }));
        return result;
    }
    settleAllPending(ok) {
        for (const settle of [...this.pendingRequests.values(), ...this.pendingAcks.values()]) {
            settle(ok);
        }
        this.pendingRequests.clear();
        this.pendingAcks.clear();
    }
    connect() {
        const discovery = readDiscovery(this.discoveryPath);
        if (!discovery) {
            this.scheduleReconnect();
            return;
        }
        const url = `ws://${discovery.host}:${discovery.port}/ws?token=${encodeURIComponent(discovery.token)}`;
        const ws = new WebSocket(url);
        this.ws = ws;
        ws.on('open', () => {
            this.connected = true;
            this.emit('connected');
            this.describeInFlight = null;
            this.describeStale = false;
            this.requestDescribe();
        });
        ws.on('message', (raw) => {
            let parsed;
            try {
                parsed = JSON.parse(String(raw));
            }
            catch {
                return;
            }
            // JSON.parse('null') succeeds; anything non-object would throw below
            // and take the plugin process down with it.
            if (typeof parsed !== 'object' || parsed === null) {
                return;
            }
            const message = parsed;
            if (message.event === 'remote.state') {
                this.state = message.payload;
                this.emit('state', this.state);
                // Every publish from the app arrives as remote.state, and a banner
                // shown or hidden changes describe, not state (plan 186): read it again.
                this.requestDescribe();
                return;
            }
            // The renderer executed (or refused) an admitted intent.
            if (message.event === 'remote.ack') {
                const intentId = message.payload?.intentId;
                if (intentId) {
                    this.pendingAcks.get(intentId)?.(message.payload?.ok === true);
                    this.pendingAcks.delete(intentId);
                }
                return;
            }
            // ServerResponse shape: {id, ok, payload}. Settle intent sends: a
            // rejected admission fails now; an accepted one waits for remote.ack.
            if (message.id && this.pendingRequests.has(message.id)) {
                const settle = this.pendingRequests.get(message.id);
                if (message.ok === false || message.payload?.accepted === false || !settle) {
                    settle?.(false);
                }
                else if (message.payload?.intentId) {
                    this.pendingRequests.delete(message.id);
                    this.pendingAcks.set(message.payload.intentId, settle);
                }
                else {
                    settle(true);
                }
                return;
            }
            if (message.id && message.id === this.describeInFlight) {
                this.describeInFlight = null;
                if (this.describeStale) {
                    this.describeStale = false;
                    this.requestDescribe();
                }
            }
            if (message.payload?.describe !== undefined || message.payload?.state !== undefined) {
                if (message.payload.describe) {
                    this.describe = message.payload.describe;
                    this.emit('describe', this.describe);
                }
                if (message.payload.state) {
                    this.state = message.payload.state;
                    this.emit('state', this.state);
                }
            }
        });
        const onGone = () => {
            if (this.ws === ws) {
                this.ws = null;
                this.settleAllPending(false);
                if (this.connected) {
                    this.connected = false;
                    this.emit('disconnected');
                }
                this.scheduleReconnect();
            }
        };
        ws.on('close', onGone);
        ws.on('error', onGone);
    }
    requestDescribe() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
            return;
        if (this.describeInFlight) {
            this.describeStale = true;
            return;
        }
        this.nextRequestId += 1;
        this.describeInFlight = `sd-${this.nextRequestId}`;
        this.ws.send(JSON.stringify({ id: this.describeInFlight, method: 'remote.describe' }));
    }
    scheduleReconnect() {
        if (this.stopped || this.reconnectTimer) {
            return;
        }
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.stopped) {
                this.connect();
            }
        }, RECONNECT_DELAY_MS);
    }
}
