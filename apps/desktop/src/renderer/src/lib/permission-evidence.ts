import type { BackendClient } from '@/backendClient'
import type { MicrophonePermissionProof } from '@/lib/system-permission-orchestration'

/** Both client identity and main's retired process boundary must change. */
export function isReplacementPermissionClient(
  client: BackendClient | null,
  proof: MicrophonePermissionProof
): client is BackendClient {
  if (!client || client === proof.previousClient) return false
  const boundary = proof.staleBackend
  return (
    !boundary ||
    client.connection.port !== boundary.port ||
    (boundary.pid !== undefined && client.connection.pid !== boundary.pid)
  )
}
