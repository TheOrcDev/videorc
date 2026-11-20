/** Renderer-only host PCM contract. Never a guest or remote-control command. */
export type CloudSpeechSync = {
  showId: string
  sourceId: string
  generation: number
  published: boolean
  muted: boolean
}
export type CloudSpeechPcm = {
  sourceId: string
  sequence: number
  sampleRate: number
  samples: number[]
}
export type CloudSpeechStatus = {
  uploadAllowed: boolean
  sourceId: string | null
  reason: string
  productionQualified: false
}

/**
 * Guest captions: the room renderer's mix of the guests on stage. A
 * captions-only stream, never a host, Sidekick or remote-control input.
 */
export type CloudSpeechGuestSync = {
  showId: string
  sourceId: string
  generation: number
  /** Guests on stage whose microphone audio is in the mix right now. */
  guests: number
}
export type CloudSpeechGuestPcm = CloudSpeechPcm
export type CloudSpeechGuestStatus = {
  uploadAllowed: boolean
  /** The guests' caption stream is up: what they say is captioned. */
  captioning: boolean
  reason: string
}

export type HostTranscriptCue = {
  sourceId: string
  speechSessionId: string
  seq: number
  offsetSeconds: number
  durationSeconds: number
  text: string
  clockBasis: 'processed-host-source'
  clock: {
    basis: 'show-created-at-wall-estimate'
    showCreatedAt: string | null
    sourceObservedAt: string
    showOffsetSeconds: number | null
    uncertaintyMs: null
  }
}

export type CloudSpeechOverlay = {
  sessionClientId: string
  expiresAt: number
  stream: boolean
  recording: boolean
  frame: {
    pngBase64: string
    position: 'top' | 'bottom'
    rect?: import('./backend').OverlayRect
    target: 'primary' | 'auxiliary'
    styleRevision: number
  }
}
export type CloudSpeechOverlayResult = {
  active: boolean
  primary: {
    active: boolean
    width: number
    height: number
    revision: number
    styleRevision: number
  }
  auxiliary: {
    active: boolean
    width: number
    height: number
    revision: number
    styleRevision: number
  }
}
