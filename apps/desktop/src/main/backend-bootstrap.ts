import type { BackendConnection } from '../shared/backend'

type BackendBootstrap = BackendConnection & { adminToken: string }

export type ParsedBackendBootstrap = {
  renderer: BackendConnection
  admin: BackendConnection
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

function validSecret(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)
}
