/**
 * Plan 249 S11: sandboxed HTML banners in the cloud room
 * (docs/cloud/249-s11-contract.md). The locked-down offscreen windows keep
 * rendering the HTML; this publisher reads their latest frames from the
 * backend, draws them into one sheet per orientation and layer set, packs
 * each sheet with S10's GPU helper and publishes it as a CAMERA track named
 * for its role. It sends a manifest to exactly the egress pages whose
 * relayed capability asks for it, which the web only allows for a page token
 * with the default-off claim: in production nothing is ever published.
 */
import {
  ConnectionState,
  RoomEvent,
  Track,
  type LocalTrackPublication,
  type Room
} from 'livekit-client'
import {
  CAPABILITY_RECEIPT_MAX_BYTES,
  CAPABILITY_TOPIC,
  capabilityCurrent,
  parseConsumerCapability,
  type CapabilityReceipt
} from './room-media-v2'
import {
  HTML_LAYER_LIMITS,
  HTML_LAYER_PRODUCTION_QUALIFIED,
  HTML_LAYER_ROLE,
  HTML_LAYER_SHEET,
  HTML_LAYER_TOPIC,
  htmlLayerPixels,
  htmlLayerTrackName,
  type HtmlLayerManifest,
  type HtmlLayerOrientation,
  type HtmlLayerOutput
} from '../../../shared/cloud-html-layer'
import type { HtmlBannerPlacement } from '../../../shared/cloud-graphics'
import { createAlphaGpu } from '../../../shared/cloud-alpha-gpu'

/** Native banner fade: 200 ms ease-out cubic, like S9's static layers. */
const FADE_MS = 200
export function htmlLayerFade(fade: HtmlBannerPlacement['fade'], now: number): number {
  if (!fade) return 1
  const t = Math.max(0, Math.min(1, (now - fade.at) / FADE_MS))
  const eased = 1 - (1 - t) ** 3
  return fade.from + (fade.to - fade.from) * eased
}

export type RoomHtmlLayerStatus = {
  state: 'off' | 'waiting' | 'publishing' | 'failed'
  /** Lanes asking (egress identity, output, orientation). */
  lanes: number
  sheets: number
  /** Lanes refused for the two-publication bound. */
  refused: number
  reason: string | null
  productionQualified: typeof HTML_LAYER_PRODUCTION_QUALIFIED
}

/** One packed sheet: a 2D canvas at logical size, its GPU packer and track. */
export type HtmlLayerSurface = {
  context: CanvasRenderingContext2D
  /** Packs the sheet; false is terminal (lost context, bad size). */
  pack(): boolean
  track: MediaStreamTrack & { requestFrame?: () => void }
  close(): void
}

export type RoomHtmlLayerDeps = {
  /** The backend's latest frame of one HTML banner, renderer token, or null. */
  frameUrl: (
    bannerId: string,
    after: { generation: string; sequence: number } | null
  ) => string | null
  /** `cloud.htmlLayers.want` (the backend's 30 s lease; renewed here). */
  want: (want: boolean) => Promise<void>
  /**
   * Plan 249 S24: the controller epoch this desktop holds for the room (0
   * when the show was never claimed), or null while another device controls
   * it or devices are held: then nothing is published.
   */
  controllerEpoch: () => number | null
  changed: (status: RoomHtmlLayerStatus) => void
  now?: () => number
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  decode?: (blob: Blob) => Promise<ImageBitmap>
  surface?: (orientation: HtmlLayerOrientation) => HtmlLayerSurface
}

type Lane = { identity: string; output: HtmlLayerOutput; orientation: HtmlLayerOrientation }
type Sheet = {
  key: string
  orientation: HtmlLayerOrientation
  layers: HtmlBannerPlacement[]
  generation: number
  revision: number
  surface: HtmlLayerSurface
  publication: LocalTrackPublication | null
  lanes: Lane[]
}
type Frame = {
  bitmap: ImageBitmap | null
  after: { generation: string; sequence: number } | null
  busy: boolean
  readAt: number
}

/** The backend's latest frame of one HTML banner, with the renderer's token. */
export function htmlLayerFrameUrl(
  connection: { host: string; port: number; token: string },
  bannerId: string,
  after: { generation: string; sequence: number } | null
): string {
  const params = new URLSearchParams({ token: connection.token, id: bannerId })
  if (after) {
    params.set('afterGeneration', after.generation)
    params.set('afterSequence', String(after.sequence))
  }
  return `http://${connection.host}:${connection.port}/preview/html-overlay/latest.bmp?${params}`
}

/** A sheet's identity: its orientation and the exact layers it shows. */
export function htmlSheetKey(
  orientation: HtmlLayerOrientation,
  layers: HtmlBannerPlacement[]
): string {
  return `${orientation}|${layers
    .map((l) => l.id)
    .sort()
    .join(',')}`
}

/** The layers one lane may show: on its output, not faded out. */
export function htmlLaneLayers(
  placements: { h: HtmlBannerPlacement[]; v: HtmlBannerPlacement[] } | null,
  lane: Pick<Lane, 'output' | 'orientation'>,
  now: number
): HtmlBannerPlacement[] {
  return (placements?.[lane.orientation] ?? [])
    .filter((l) => l[lane.output] && htmlLayerFade(l.fade, now) * l.opacity > 0)
    .slice(0, HTML_LAYER_LIMITS.layers)
}

function defaultSurface(orientation: HtmlLayerOrientation): HtmlLayerSurface {
  const { width, height } = HTML_LAYER_SHEET[orientation]
  const source = document.createElement('canvas')
  source.width = width
  source.height = height
  const context = source.getContext('2d')
  if (!context) throw new Error('html layer sheet canvas unavailable')
  const packed = document.createElement('canvas')
  const gpu = createAlphaGpu(packed, width, height, 'pack')
  const stream = packed.captureStream(0)
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined
  if (!track || typeof track.requestFrame !== 'function') {
    gpu.close()
    throw new Error('explicit canvas frame capture unavailable')
  }
  return {
    context,
    pack: () => gpu.draw(source),
    track,
    close() {
      stream.getTracks().forEach((t) => t.stop())
      gpu.close()
      source.width = source.height = 1
    }
  }
}

export class RoomHtmlLayerPublisher {
  #placements: { h: HtmlBannerPlacement[]; v: HtmlBannerPlacement[] } | null = null
  #receipts = new Map<string, CapabilityReceipt>()
  #sheets = new Map<string, Sheet>()
  #frames = new Map<string, Frame>()
  #generation = 0
  #refused = 0
  #wanted = false
  #wantAt = 0
  #closed = false
  #failure: string | null = null
  #tick: ReturnType<typeof setInterval> | undefined
  #renew: ReturnType<typeof setInterval> | undefined
  #lastStatus = ''
  readonly #now: () => number

  constructor(
    private room: Room,
    private deps: RoomHtmlLayerDeps
  ) {
    this.#now = deps.now ?? Date.now
    room.on(RoomEvent.DataReceived, this.#receive)
    room.on(RoomEvent.Reconnecting, this.#lost)
    room.on(RoomEvent.Disconnected, this.#lost)
    room.on(RoomEvent.ParticipantDisconnected, this.#reconcileSoon)
    this.#tick = setInterval(this.#draw, 1000 / HTML_LAYER_LIMITS.fps)
    this.#renew = setInterval(this.#reconcileSoon, HTML_LAYER_LIMITS.renewMs)
  }

  /** The room canvases' HTML banners from `cloud.graphics.snapshot`. */
  setPlacements(placements: { h: HtmlBannerPlacement[]; v: HtmlBannerPlacement[] } | null): void {
    if (this.#closed) return
    this.#placements = placements
    void this.#reconcile()
  }

  get stats() {
    return {
      sheets: this.#sheets.size,
      lanes: [...this.#sheets.values()].reduce((n, s) => n + s.lanes.length, 0),
      frames: this.#frames.size,
      refused: this.#refused
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    clearInterval(this.#tick)
    clearInterval(this.#renew)
    this.room.off(RoomEvent.DataReceived, this.#receive)
    this.room.off(RoomEvent.Reconnecting, this.#lost)
    this.room.off(RoomEvent.Disconnected, this.#lost)
    this.room.off(RoomEvent.ParticipantDisconnected, this.#reconcileSoon)
    this.#receipts.clear()
    await this.#closeSheets()
    this.#dropFrames()
    this.#report()
  }

  #receive = (bytes: Uint8Array, participant?: unknown, _kind?: unknown, topic?: string): void => {
    if (participant || topic !== CAPABILITY_TOPIC || bytes.length > CAPABILITY_RECEIPT_MAX_BYTES)
      return
    try {
      const raw = JSON.parse(new TextDecoder().decode(bytes))
      const parsed = parseConsumerCapability(raw)
      if (
        !parsed?.html ||
        !parsed.identity.startsWith('EG_') ||
        !Number.isSafeInteger(raw.at) ||
        !capabilityCurrent(
          { ...parsed, at: raw.at },
          this.room.remoteParticipants.get(parsed.identity)?.sid ?? '',
          this.#now()
        )
      )
        return
      const old = this.#receipts.get(parsed.identity)
      if (old && old.at >= raw.at) return
      this.#receipts.set(parsed.identity, { ...parsed, at: raw.at })
      void this.#reconcile()
    } catch {
      /* Untrusted input supplies no capability. */
    }
  }

  #lost = (): void => {
    this.#receipts.clear()
    void this.#reconcile()
  }

  #reconcileSoon = (): void => {
    void this.#reconcile()
  }

  /** Current lanes: egress pages with a fresh `html` receipt, still in the room. */
  #lanes(): Lane[] {
    const now = this.#now()
    const lanes: Lane[] = []
    for (const [identity, receipt] of this.#receipts) {
      const sid = this.room.remoteParticipants.get(identity)?.sid ?? ''
      if (!receipt.html || !capabilityCurrent(receipt, sid, now)) {
        this.#receipts.delete(identity)
        continue
      }
      lanes.push({ identity, output: receipt.html.output, orientation: receipt.html.orientation })
    }
    return lanes.sort((a, b) => a.identity.localeCompare(b.identity))
  }

  #reconciling = false
  #again = false
  async #reconcile(): Promise<void> {
    if (this.#reconciling) {
      this.#again = true
      return
    }
    this.#reconciling = true
    try {
      do {
        this.#again = false
        await this.#reconcileOnce()
      } while (this.#again && !this.#closed)
    } finally {
      this.#reconciling = false
      this.#report()
    }
  }

  async #reconcileOnce(): Promise<void> {
    const epoch = this.deps.controllerEpoch()
    const connected = this.room.state === ConnectionState.Connected
    const now = this.#now()
    // Candidate sheets by key; existing sheets keep their slots, new ones
    // take free slots in lane order, and the rest of the lanes are refused.
    const candidates = new Map<
      string,
      { orientation: HtmlLayerOrientation; layers: HtmlBannerPlacement[]; lanes: Lane[] }
    >()
    if (!this.#closed && connected && epoch !== null) {
      for (const lane of this.#lanes()) {
        const layers = htmlLaneLayers(this.#placements, lane, now)
        if (!layers.length) continue
        const key = htmlSheetKey(lane.orientation, layers)
        const entry = candidates.get(key)
        if (entry) entry.lanes.push(lane)
        else candidates.set(key, { orientation: lane.orientation, layers, lanes: [lane] })
      }
    }
    const order = [
      ...[...candidates.keys()].filter((k) => this.#sheets.has(k)),
      ...[...candidates.keys()].filter((k) => !this.#sheets.has(k))
    ]
    const wanted = new Map(
      order.slice(0, HTML_LAYER_LIMITS.publications).map((k) => [k, candidates.get(k)!])
    )
    this.#refused = order
      .slice(HTML_LAYER_LIMITS.publications)
      .reduce((n, k) => n + candidates.get(k)!.lanes.length, 0)
    for (const [key, sheet] of [...this.#sheets]) {
      if (!wanted.has(key)) {
        this.#sheets.delete(key)
        await this.#unpublish(sheet)
      }
    }
    await this.#want(wanted.size > 0)
    for (const [key, next] of wanted) {
      let sheet = this.#sheets.get(key)
      if (!sheet) {
        if (this.#sheets.size >= HTML_LAYER_LIMITS.publications) continue
        sheet = (await this.#publish(key, next.orientation, next.layers)) ?? undefined
        if (!sheet) continue
      }
      const changed =
        sheet.lanes.length !== next.lanes.length ||
        JSON.stringify(sheet.layers) !== JSON.stringify(next.layers)
      sheet.layers = next.layers
      sheet.lanes = next.lanes
      if (changed) sheet.revision++
      await this.#sendManifests(sheet, epoch ?? 0)
    }
    // Frames of banners no sheet shows any more are let go.
    const shown = new Set(
      [...this.#sheets.values()].flatMap((s) => s.layers.map((l) => l.bannerId))
    )
    for (const [id, frame] of this.#frames)
      if (!shown.has(id)) {
        frame.bitmap?.close()
        this.#frames.delete(id)
      }
  }

  async #want(want: boolean): Promise<void> {
    const now = this.#now()
    if (want === this.#wanted && (!want || now - this.#wantAt < HTML_LAYER_LIMITS.renewMs)) return
    this.#wanted = want
    this.#wantAt = now
    try {
      await this.deps.want(want)
    } catch {
      if (want) this.#failure = 'The room HTML banners did not start.'
    }
  }

  async #publish(
    key: string,
    orientation: HtmlLayerOrientation,
    layers: HtmlBannerPlacement[]
  ): Promise<Sheet | null> {
    const generation = ++this.#generation
    let surface: HtmlLayerSurface | null = null
    try {
      surface = (this.deps.surface ?? defaultSurface)(orientation)
      const sheet: Sheet = {
        key,
        orientation,
        layers,
        generation,
        revision: 1,
        surface,
        publication: null,
        lanes: []
      }
      this.#paint(sheet)
      sheet.publication = await this.room.localParticipant.publishTrack(surface.track, {
        name: htmlLayerTrackName(orientation, generation),
        source: Track.Source.Camera,
        videoCodec: 'vp8',
        simulcast: false,
        videoEncoding: {
          maxBitrate: HTML_LAYER_LIMITS.bitrate,
          maxFramerate: HTML_LAYER_LIMITS.fps
        }
      })
      if (this.#closed) {
        await this.#unpublish(sheet)
        return null
      }
      this.#sheets.set(key, sheet)
      this.#failure = null
      return sheet
    } catch (error) {
      surface?.close()
      this.#failure = `The HTML layer sheet was not published (${error instanceof Error ? error.name : 'error'}).`
      return null
    }
  }

  async #unpublish(sheet: Sheet): Promise<void> {
    const track = sheet.publication?.track
    sheet.publication = null
    if (track) await this.room.localParticipant.unpublishTrack(track).catch(() => {})
    sheet.surface.close()
  }

  async #closeSheets(): Promise<void> {
    const sheets = [...this.#sheets.values()]
    this.#sheets.clear()
    for (const sheet of sheets) await this.#unpublish(sheet)
    await this.#want(false)
  }

  #dropFrames(): void {
    for (const frame of this.#frames.values()) frame.bitmap?.close()
    this.#frames.clear()
  }

  async #sendManifests(sheet: Sheet, controllerEpoch: number): Promise<void> {
    const trackSid = sheet.publication?.trackSid
    const publisherSid = this.room.localParticipant.sid
    if (!trackSid || !publisherSid) return
    const { width, height } = HTML_LAYER_SHEET[sheet.orientation]
    for (const lane of sheet.lanes) {
      const manifest: HtmlLayerManifest = {
        version: 1,
        role: HTML_LAYER_ROLE,
        show: this.room.name,
        publisherSid,
        trackSid,
        generation: sheet.generation,
        controllerEpoch,
        revision: sheet.revision,
        output: lane.output,
        orientation: sheet.orientation,
        width,
        height,
        fps: HTML_LAYER_LIMITS.fps,
        packing: 'rgb-left-alpha-right',
        expiresAt: this.#now() + HTML_LAYER_LIMITS.leaseMs - 1000,
        layers: sheet.layers.map((l) => ({ id: l.id, rect: l.rect }))
      }
      const bytes = new TextEncoder().encode(JSON.stringify(manifest))
      if (bytes.length > HTML_LAYER_LIMITS.manifestBytes) continue
      try {
        const writer = await this.room.localParticipant.streamBytes({
          topic: HTML_LAYER_TOPIC,
          mimeType: 'application/json',
          totalSize: bytes.length,
          destinationIdentities: [lane.identity]
        })
        await writer.write(bytes)
        await writer.close()
      } catch {
        /* The next renewal tries again; the page's lease bounds a stale view. */
      }
    }
  }

  /** One frame per sheet at the sheet rate; one request in flight per banner. */
  #draw = (): void => {
    if (this.#closed || !this.#sheets.size) return
    for (const sheet of this.#sheets.values())
      for (const layer of sheet.layers) this.#read(layer.bannerId)
    for (const sheet of [...this.#sheets.values()]) {
      this.#paint(sheet)
      if (!sheet.surface.pack()) {
        this.#failure = 'The HTML layer sheet lost its GPU.'
        this.#sheets.delete(sheet.key)
        void this.#unpublish(sheet).then(() => this.#reconcile())
        continue
      }
      sheet.surface.track.requestFrame?.()
    }
  }

  #paint(sheet: Sheet): void {
    const { width, height } = HTML_LAYER_SHEET[sheet.orientation]
    const context = sheet.surface.context
    const now = this.#now()
    context.clearRect(0, 0, width, height)
    for (const layer of sheet.layers) {
      const bitmap = this.#frames.get(layer.bannerId)?.bitmap
      const alpha = layer.opacity * htmlLayerFade(layer.fade, now)
      if (!bitmap || alpha <= 0) continue
      const px = htmlLayerPixels(layer.rect, { width, height })
      context.globalAlpha = Math.min(1, alpha)
      context.drawImage(bitmap, px.x, px.y, px.w, px.h)
    }
    context.globalAlpha = 1
  }

  #read(bannerId: string): void {
    const frame = this.#frames.get(bannerId) ?? {
      bitmap: null,
      after: null,
      busy: false,
      readAt: 0
    }
    this.#frames.set(bannerId, frame)
    const now = this.#now()
    if (frame.busy || now - frame.readAt < 1000 / HTML_LAYER_LIMITS.fps) return
    const url = this.deps.frameUrl(bannerId, frame.after)
    if (!url) return
    frame.busy = true
    frame.readAt = now
    void (async () => {
      try {
        const response = await (this.deps.fetch ?? fetch)(url, { cache: 'no-store' })
        const generation = response.headers.get('x-videorc-frame-generation')
        const sequence = Number(response.headers.get('x-videorc-frame-sequence'))
        if (response.status === 204) {
          if (response.headers.get('x-videorc-layer-empty')) {
            frame.bitmap?.close()
            frame.bitmap = null
            frame.after = null
          }
          return
        }
        const length = Number(response.headers.get('content-length') ?? '0')
        if (
          !response.ok ||
          length > 1920 * 1080 * 4 + 1024 ||
          !generation ||
          !Number.isSafeInteger(sequence)
        )
          return
        const blob = await response.blob()
        if (blob.size > 1920 * 1080 * 4 + 1024) return
        const bitmap = await (
          this.deps.decode ?? ((b: Blob) => createImageBitmap(b, { premultiplyAlpha: 'none' }))
        )(blob)
        if (this.#closed || this.#frames.get(bannerId) !== frame) {
          bitmap.close()
          return
        }
        frame.bitmap?.close()
        frame.bitmap = bitmap
        frame.after = { generation, sequence }
      } catch {
        /* The next tick asks again. */
      } finally {
        frame.busy = false
      }
    })()
  }

  #report(): void {
    const status: RoomHtmlLayerStatus = {
      state: this.#closed
        ? 'off'
        : this.#failure
          ? 'failed'
          : this.#sheets.size
            ? 'publishing'
            : this.#receipts.size
              ? 'waiting'
              : 'off',
      lanes: [...this.#sheets.values()].reduce((n, s) => n + s.lanes.length, 0),
      sheets: this.#sheets.size,
      refused: this.#refused,
      reason: this.#failure,
      productionQualified: HTML_LAYER_PRODUCTION_QUALIFIED
    }
    const key = JSON.stringify(status)
    if (key === this.#lastStatus) return
    this.#lastStatus = key
    this.deps.changed(status)
  }
}
