import { withWorkNotifications } from '@/lib/notify'

// The MP4 export's notices (plan 174 S2.4, J2-13), whether the export ran
// after Stop or from Library's "Export MP4". Since plan 250 they are one
// entry per recording behind the bell (`notifications/sources/work.ts`): a
// spinner while it runs, then "MP4 ready" with its reveal action, or "MP4
// export failed" with Retry. No toast stays up for the length of an export.

export function showMp4Finalizing(sessionId: string, label: string): void {
  withWorkNotifications((work) => work.publishMp4Finalizing(sessionId, label))
}

export function showMp4Ready(sessionId: string): void {
  withWorkNotifications((work) => work.publishMp4Ready(sessionId))
}

export function showMp4ExportFailed(
  sessionId: string,
  retry: () => void,
  reason: string | undefined
): void {
  withWorkNotifications((work) => work.publishMp4ExportFailed(sessionId, retry, reason))
}
