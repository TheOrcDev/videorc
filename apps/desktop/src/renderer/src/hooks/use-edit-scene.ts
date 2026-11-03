import { useCallback } from 'react'

import { useWorkspaceNav } from '@/components/workspace-nav'
import { useStudioBanners, useStudioCore } from '@/hooks/use-studio'
import { editScene } from '@/lib/edit-scene'

/** Plan 215 D4: the one Edit scene action, for every door that offers it. */
export function useEditScene(): () => void {
  const { openStudioPanel } = useWorkspaceNav()
  const { scene, setSceneEditMode, setSelectedSceneSourceId } = useStudioCore()
  const { selectBanner } = useStudioBanners()
  return useCallback(
    () =>
      editScene({
        scene,
        openScenePage: () => openStudioPanel('layouts'),
        selectBanner,
        selectSource: setSelectedSceneSourceId,
        setEditMode: setSceneEditMode
      }),
    [openStudioPanel, scene, selectBanner, setSceneEditMode, setSelectedSceneSourceId]
  )
}
