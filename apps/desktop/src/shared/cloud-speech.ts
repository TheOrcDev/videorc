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
