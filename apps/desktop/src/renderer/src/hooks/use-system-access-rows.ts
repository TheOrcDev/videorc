import { useStudioAudio, useStudioCore } from '@/hooks/use-studio'
import { systemAccessRows, type SystemAccessRow } from '@/lib/system-access'

/** Shared live permission context for lazy Settings, Sources and first-run setup. */
export function useSystemAccessRows(): SystemAccessRow[] {
  const { deviceList, runtimeInfo, mediaAccess, systemAccessContext } = useStudioCore()
  const { audioMeter } = useStudioAudio()
  return systemAccessRows({
    ...systemAccessContext,
    deviceList,
    audioMeter,
    platform: runtimeInfo?.platform,
    osRelease: runtimeInfo?.osRelease,
    permissionTargetName: runtimeInfo?.permissionTargetName,
    mediaAccess
  })
}
