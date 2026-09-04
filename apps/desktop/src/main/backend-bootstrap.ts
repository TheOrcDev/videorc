import type { BackendConnection } from '../shared/backend'

type BackendBootstrap = BackendConnection & { adminToken: string }

export type ParsedBackendBootstrap = {
  renderer: BackendConnection
  admin: BackendConnection
}

export type BackendProcessOwnership = {
  pid: number
  parentPid?: number
}

export const BACKEND_PROCESS_OWNERSHIP_PREFIX = 'OWNERSHIP '

export type BackendOwnershipMarkerDecision = {
  markerPid: number
  conflict: boolean
}

export function parseBackendBootstrap(value: unknown): ParsedBackendBootstrap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Backend bootstrap must be an object.')
  }
  const bootstrap = value as Partial<BackendBootstrap>
  if (
    bootstrap.host !== '127.0.0.1' ||
    !Number.isInteger(bootstrap.port) ||
    Number(bootstrap.port) < 1 ||
    Number(bootstrap.port) > 65_535 ||
    !validSecret(bootstrap.token) ||
    !validSecret(bootstrap.adminToken) ||
    bootstrap.token === bootstrap.adminToken
  ) {
    throw new Error('Backend bootstrap credentials or loopback address are invalid.')
  }
  const common = {
    host: bootstrap.host,
    port: Number(bootstrap.port),
    ...(typeof bootstrap.pid === 'number' ? { pid: bootstrap.pid } : {}),
    ...(typeof bootstrap.parentPid === 'number' ? { parentPid: bootstrap.parentPid } : {})
  }
  return {
    renderer: { ...common, token: bootstrap.token },
    admin: { ...common, token: bootstrap.adminToken }
  }
}

/** The only backend bootstrap shape allowed in logs/smoke markers/preload. */
export function publicBackendConnectionJson(connection: BackendConnection): string {
  return JSON.stringify({
    host: connection.host,
    port: connection.port,
    token: connection.token,
    ...(typeof connection.pid === 'number' ? { pid: connection.pid } : {}),
    ...(typeof connection.parentPid === 'number' ? { parentPid: connection.parentPid } : {})
  })
}

/**
 * Authenticate the process identity marker emitted before the backend begins
 * any fallible initialization. In development the spawned process is a Cargo
 * wrapper, so READY is too late to establish ownership of the real backend.
 */
export function parseBackendProcessOwnership(
  value: unknown,
  expectedToken: string
): BackendProcessOwnership {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Backend process ownership must be an object.')
  }
  const ownership = value as { token?: unknown; pid?: unknown; parentPid?: unknown }
  const parentPid = ownership.parentPid
  if (
    !validSecret(expectedToken) ||
    ownership.token !== expectedToken ||
    !Number.isSafeInteger(ownership.pid) ||
    Number(ownership.pid) <= 1 ||
    (parentPid !== undefined &&
      parentPid !== null &&
      (!Number.isSafeInteger(parentPid) || Number(parentPid) < 1))
  ) {
    throw new Error('Backend process ownership token or process identity is invalid.')
  }
  return {
    pid: Number(ownership.pid),
    ...(parentPid === undefined || parentPid === null ? {} : { parentPid: Number(parentPid) })
  }
}

export function observeBackendOwnershipMarker(
  existingMarkerPid: number | undefined,
  incomingPid: number
): BackendOwnershipMarkerDecision {
  return {
    markerPid: existingMarkerPid ?? incomingPid,
    conflict: existingMarkerPid !== undefined && existingMarkerPid !== incomingPid
  }
}

export function backendReadyMatchesOwnershipMarker(
  markerPid: number | undefined,
  readyPid: number | undefined
): boolean {
  return markerPid !== undefined && readyPid === markerPid
}

export function backendOwnershipLineageMatches(options: {
  packaged: boolean
  platform: NodeJS.Platform
  wrapperPid: number | undefined
  backendPid: number
  parentPid?: number
}): boolean {
  const { packaged, platform, wrapperPid, backendPid, parentPid } = options
  if (!Number.isSafeInteger(wrapperPid) || Number(wrapperPid) <= 1) {
    return true
  }
  if (packaged) {
    return backendPid === wrapperPid
  }
  if (platform === 'win32') {
    // The Rust Windows bootstrap cannot currently expose a parent PID. The
    // generation token and exact READY PID binding remain mandatory.
    return true
  }
  return backendPid === wrapperPid || parentPid === wrapperPid
}

function validSecret(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)
}
