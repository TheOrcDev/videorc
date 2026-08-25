export type AccountSnapshotCommitToken = Readonly<{
  generation: number
  kind: 'refresh' | 'mutation'
}>

/**
 * Orders account snapshots across renderer WebSocket reads and Electron Main
 * refresh/sign-in/sign-out work. Mutations invalidate refreshes and temporarily
 * block new refreshes so stale identity can never overwrite an auth decision.
 */
export class AccountSnapshotCommitCoordinator {
  private generation = 0
  private mutationGeneration: number | null = null

  beginRefresh(): AccountSnapshotCommitToken | null {
    if (this.mutationGeneration !== null) return null
    return { generation: ++this.generation, kind: 'refresh' }
  }

  beginMutation(): AccountSnapshotCommitToken {
    const token = { generation: ++this.generation, kind: 'mutation' } as const
    this.mutationGeneration = token.generation
    return token
  }

  canCommit(token: AccountSnapshotCommitToken): boolean {
    return (
      this.isCurrent(token) &&
      (token.kind === 'mutation'
        ? this.mutationGeneration === token.generation
        : this.mutationGeneration === null)
    )
  }

  isCurrent(token: AccountSnapshotCommitToken): boolean {
    return token.generation === this.generation
  }

  finishMutation(token: AccountSnapshotCommitToken): void {
    if (token.kind === 'mutation' && this.mutationGeneration === token.generation) {
      this.mutationGeneration = null
    }
  }

  invalidate(): void {
    this.generation += 1
    this.mutationGeneration = null
  }
}
