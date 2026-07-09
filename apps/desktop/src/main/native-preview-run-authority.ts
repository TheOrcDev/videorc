export interface NativePreviewRunDecision {
  accepted: boolean
  changed: boolean
}

const RETIRED_RUN_LIMIT = 32

export class NativePreviewRunAuthority {
  private current: string | undefined
  private readonly retired: string[] = []

  get currentRunId(): string | undefined {
    return this.current
  }

  decision(candidateRunId: string | undefined): NativePreviewRunDecision {
    if (!candidateRunId || !this.current) {
      return { accepted: true, changed: false }
    }
    if (candidateRunId === this.current) {
      return { accepted: true, changed: false }
    }
    if (this.retired.includes(candidateRunId)) {
      return { accepted: false, changed: false }
    }
    return { accepted: true, changed: true }
  }

  commit(candidateRunId: string | undefined): boolean {
    if (!candidateRunId || !this.decision(candidateRunId).accepted) {
      return false
    }
    if (this.current && this.current !== candidateRunId) {
      this.retired.push(this.current)
      if (this.retired.length > RETIRED_RUN_LIMIT) {
        this.retired.splice(0, this.retired.length - RETIRED_RUN_LIMIT)
      }
    }
    this.current = candidateRunId
    return true
  }

  clear(): void {
    this.current = undefined
    this.retired.splice(0)
  }
}
