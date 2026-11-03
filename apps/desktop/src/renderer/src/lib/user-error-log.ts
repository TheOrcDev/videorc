import type { RendererUserErrorRecord } from '@/lib/backend'
import type { UserError, UserErrorContext } from '@/lib/user-error'

// Plan 216 A5: the support bundle explains the last toast. Every user-facing
// error (a toast, an inline line, a backend error) leaves one record here,
// raw text included. The export ships the newest ones as
// rendererDiagnostics.recentUserErrors; the backend redacts them with the
// rest of the bundle (paths, URLs, secrets), so nothing is redacted here.

/** How many errors the ring keeps: enough for a session's worth of toasts. */
export const USER_ERROR_LOG_LIMIT = 50

const records: RendererUserErrorRecord[] = []

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** Keeps one record of a shown error; the oldest goes when the ring is full. */
export function recordUserError(
  copy: Pick<UserError, 'kind' | 'title' | 'raw'>,
  error: unknown,
  context?: UserErrorContext,
  now: Date = new Date()
): RendererUserErrorRecord {
  const code = errorCode(error)
  const record: RendererUserErrorRecord = {
    at: now.toISOString(),
    ...(context ? { action: context.action } : {}),
    ...(context?.object ? { object: context.object } : {}),
    ...(code ? { code } : {}),
    kind: copy.kind,
    title: copy.title,
    raw: copy.raw
  }
  records.push(record)
  if (records.length > USER_ERROR_LOG_LIMIT)
    records.splice(0, records.length - USER_ERROR_LOG_LIMIT)
  return record
}

/** The ring's records, oldest first, as a copy the caller may ship. */
export function recentUserErrors(): RendererUserErrorRecord[] {
  return records.map((record) => ({ ...record }))
}

/** Tests share the module; each starts from an empty ring. */
export function resetUserErrorLogForTests(): void {
  records.length = 0
}
