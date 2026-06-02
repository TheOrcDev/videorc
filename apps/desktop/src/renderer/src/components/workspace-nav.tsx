import {
  Broadcast,
  FileVideo,
  FilmReel,
  Gauge,
  GearSix,
  ImageSquare,
  Layout,
  Monitor,
  Sparkle,
  VideoCamera,
  type Icon
} from '@phosphor-icons/react'
import { createContext, useContext } from 'react'

export type WorkspaceTab =
  | 'studio'
  | 'sources'
  | 'layout'
  | 'screens'
  | 'recording'
  | 'streaming'
  | 'library'
  | 'ai'
  | 'diagnostics'
  | 'settings'

export type WorkspaceTabMeta = {
  id: WorkspaceTab
  label: string
  icon: Icon
}

export const WORKSPACE_TABS: WorkspaceTabMeta[] = [
  { id: 'studio', label: 'Studio', icon: VideoCamera },
  { id: 'sources', label: 'Sources', icon: Monitor },
  { id: 'layout', label: 'Layout', icon: Layout },
  { id: 'screens', label: 'Screens', icon: ImageSquare },
  { id: 'recording', label: 'Recording', icon: FileVideo },
  { id: 'streaming', label: 'Streaming', icon: Broadcast },
  { id: 'library', label: 'Library', icon: FilmReel },
  { id: 'ai', label: 'AI', icon: Sparkle },
  { id: 'diagnostics', label: 'Diagnostics', icon: Gauge },
  { id: 'settings', label: 'Settings', icon: GearSix }
]

type WorkspaceNavValue = {
  active: WorkspaceTab
  setActive: (tab: WorkspaceTab) => void
}

export const WorkspaceNavContext = createContext<WorkspaceNavValue | null>(null)

export function useWorkspaceNav(): WorkspaceNavValue {
  const value = useContext(WorkspaceNavContext)
  if (!value) {
    throw new Error('useWorkspaceNav must be used within a WorkspaceNavContext provider')
  }
  return value
}
