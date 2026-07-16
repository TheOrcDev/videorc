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
const RECONNECT_DELAY_MS = 2_000;
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
    sendIntent(intent) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }
        this.nextRequestId += 1;
        this.ws.send(JSON.stringify({
            id: `sd-${this.nextRequestId}`,
            method: 'remote.intent',
            params: intent
        }));
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
            this.nextRequestId += 1;
            ws.send(JSON.stringify({ id: `sd-${this.nextRequestId}`, method: 'remote.describe' }));
        });
        ws.on('message', (raw) => {
            let message;
            try {
                message = JSON.parse(String(raw));
            }
            catch {
                return;
            }
            if (message.event === 'remote.state') {
                this.state = message.payload;
                this.emit('state', this.state);
                return;
            }
            // Request responses carry `payload` (ServerResponse shape).
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
