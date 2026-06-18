import {
  createContext,
  useContext,
  useEffect,
  useState,
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type SetStateAction
} from 'react'

import {
  applyBundledBackgroundAssets,
  reconcileRegistry,
  type BackgroundAssetRegistry
} from '@/lib/background-assets'
import { STORAGE_KEYS, loadJson } from '@/lib/capture'

type BackgroundAssetsValue = {
  registry: BackgroundAssetRegistry
  setRegistry: Dispatch<SetStateAction<BackgroundAssetRegistry>>
}

const BackgroundAssetsContext = createContext<BackgroundAssetsValue | null>(null)

// One shared background-asset registry (Assets Tab plan, slice A5): Assets edits
// it, Scene reads/edits per-scene overrides, and useStudio reads it to resolve
// Scene.background for session/preview params. A single localStorage-backed
// source of truth keeps all three reactive and in sync, so an "Apply" on Assets
// is visible to Studio without a reload.
export function BackgroundAssetsProvider({ children }: { children: ReactNode }): ReactElement {
  const [registry, setRegistry] = useState<BackgroundAssetRegistry>(() =>
    reconcileRegistry(loadJson(STORAGE_KEYS.backgroundAssets, null))
  )

  useEffect(() => {
    let cancelled = false
    void window.videorc
      ?.getBundledBackgroundAssets?.()
      .then((bundledAssets) => {
        if (cancelled) {
          return
        }
        setRegistry((current) => applyBundledBackgroundAssets(current, bundledAssets))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.backgroundAssets, JSON.stringify(registry))
  }, [registry])

  return (
    <BackgroundAssetsContext.Provider value={{ registry, setRegistry }}>
      {children}
    </BackgroundAssetsContext.Provider>
  )
}

export function useBackgroundAssets(): BackgroundAssetsValue {
  const value = useContext(BackgroundAssetsContext)
  if (!value) {
    throw new Error('useBackgroundAssets must be used within a BackgroundAssetsProvider')
  }
  return value
}
