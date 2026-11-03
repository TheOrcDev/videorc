import { useCallback } from 'react'

import { useStudioBanners, useStudioCore } from '@/hooks/use-studio'
import { editScene } from '@/lib/edit-scene'
import { openWorkspaceTab } from '@/lib/workspace-navigation'

/** Plan 215 D4: the one Edit scene action, for every door that offers it. It
 *  opens the page through `openWorkspaceTab`, so the Scene page itself needs
 *  no workspace context. */
export function useEditScene(): () => void {
  const { scene, setSceneEditMode, setSelectedSceneSourceId } = useStudioCore()
  const { selectBanner } = useStudioBanners()
  return useCallback(
    () =>
      editScene({
        scene,
        openScenePage: () => openWorkspaceTab('layouts'),
        selectBanner,
        selectSource: setSelectedSceneSourceId,
        setEditMode: setSceneEditMode
      }),
    [scene, selectBanner, setSceneEditMode, setSelectedSceneSourceId]
  )
}
