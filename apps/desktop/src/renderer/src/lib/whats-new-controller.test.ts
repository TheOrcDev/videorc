import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkWhatsNew, showLatestWhatsNew } from './whats-new-controller'
import { fetchChangelogEntries } from './whats-new-fetch'
import { WHATS_NEW_STORAGE_KEY } from './whats-new-storage'
import { toast } from 'sonner'

vi.mock('./whats-new-fetch', () => ({ fetchChangelogEntries: vi.fn() }))
vi.mock('sonner', () => ({ toast: { info: vi.fn() } }))

const getItem = vi.fn()
const setItem = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('localStorage', { getItem, setItem })
})
afterEach(() => vi.unstubAllGlobals())

describe('deferred release notes', () => {
  it('initializes a first launch without fetching', async () => {
    getItem.mockReturnValue(null)
    await checkWhatsNew('0.9.122', 'darwin', () => false, vi.fn())
    expect(setItem).toHaveBeenCalledWith(WHATS_NEW_STORAGE_KEY, '0.9.122')
    expect(fetchChangelogEntries).not.toHaveBeenCalled()
  })

  it('leaves the last-seen version unchanged when the fetch fails', async () => {
    getItem.mockReturnValue('0.9.121')
    vi.mocked(fetchChangelogEntries).mockResolvedValue(null)
    await checkWhatsNew('0.9.122', 'darwin', () => false, vi.fn())
    expect(setItem).not.toHaveBeenCalled()
  })

  it('ignores a fetch result after the effect was cancelled', async () => {
    getItem.mockReturnValue('0.9.121')
    let cancelled = false
    vi.mocked(fetchChangelogEntries).mockImplementation(async () => {
      cancelled = true
      return []
    })
    const show = vi.fn()
    await checkWhatsNew('0.9.122', 'darwin', () => cancelled, show)
    expect(setItem).not.toHaveBeenCalled()
    expect(show).not.toHaveBeenCalled()
  })

  it('reports an unavailable manual request without opening an empty dialog', async () => {
    vi.mocked(fetchChangelogEntries).mockResolvedValue([])
    const show = vi.fn()
    await showLatestWhatsNew('darwin', show)
    expect(toast.info).toHaveBeenCalledWith('Release notes are not available right now.')
    expect(show).not.toHaveBeenCalled()
  })
})
