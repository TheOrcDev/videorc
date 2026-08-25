import { describe, expect, it } from 'vitest'

import { AccountSnapshotCommitCoordinator } from './account-snapshot-policy'

describe('AccountSnapshotCommitCoordinator', () => {
  it('rejects an older refresh after a newer refresh begins', () => {
    const coordinator = new AccountSnapshotCommitCoordinator()
    const early = coordinator.beginRefresh()
    const latest = coordinator.beginRefresh()

    expect(early).not.toBeNull()
    expect(latest).not.toBeNull()
    expect(coordinator.canCommit(early!)).toBe(false)
    expect(coordinator.canCommit(latest!)).toBe(true)
  })

  it('invalidates refreshes and blocks new ones while sign-in/out is pending', () => {
    const coordinator = new AccountSnapshotCommitCoordinator()
    const staleRefresh = coordinator.beginRefresh()
    const mutation = coordinator.beginMutation()

    expect(coordinator.canCommit(staleRefresh!)).toBe(false)
    expect(coordinator.beginRefresh()).toBeNull()
    expect(coordinator.canCommit(mutation)).toBe(true)

    coordinator.finishMutation(mutation)
    expect(coordinator.beginRefresh()).not.toBeNull()
  })

  it('prevents an older sign-in from overwriting a later sign-out', () => {
    const coordinator = new AccountSnapshotCommitCoordinator()
    const signIn = coordinator.beginMutation()
    const signOut = coordinator.beginMutation()

    expect(coordinator.canCommit(signIn)).toBe(false)
    expect(coordinator.canCommit(signOut)).toBe(true)
    coordinator.finishMutation(signOut)
    expect(coordinator.isCurrent(signOut)).toBe(true)
  })

  it('invalidates all pending work when the backend connection changes', () => {
    const coordinator = new AccountSnapshotCommitCoordinator()
    const refresh = coordinator.beginRefresh()
    coordinator.invalidate()
    expect(coordinator.canCommit(refresh!)).toBe(false)
  })
})
