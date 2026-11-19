import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('renderer image URL cache', () => {
  // A fresh module is the same boundary as a new renderer window.
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.unstubAllGlobals())

  async function setup() {
    const cacheChatAvatar = vi.fn(async (url: string): Promise<string | null> => `local:${url}`)
    const cacheChatGif = vi.fn(async (url: string): Promise<string | null> => `gif:${url}`)
    vi.stubGlobal('window', { videorc: { cacheChatAvatar, cacheChatGif } })
    const { resolveAvatar } = await import('./chat-image-cache')
    return { resolveAvatar, cacheChatAvatar, cacheChatGif }
  }

  it('deduplicates resident in-flight requests and separates avatar and GIF keys', async () => {
    const { resolveAvatar, cacheChatAvatar, cacheChatGif } = await setup()
    const first = resolveAvatar('one', 'avatar')
    expect(resolveAvatar('one', 'avatar')).toBe(first)
    expect(await first).toBe('local:one')
    expect(await resolveAvatar('one', 'gif')).toBe('gif:one')
    expect(cacheChatAvatar).toHaveBeenCalledTimes(1)
    expect(cacheChatGif).toHaveBeenCalledTimes(1)
  })

  it('evicts the least recently used key and refreshes hits at the 256-entry bound', async () => {
    const { resolveAvatar, cacheChatAvatar } = await setup()
    for (let i = 0; i < 256; i++) await resolveAvatar(`url-${i}`, 'avatar')
    await resolveAvatar('url-0', 'avatar')
    await resolveAvatar('url-256', 'avatar')
    await resolveAvatar('url-0', 'avatar')
    expect(cacheChatAvatar).toHaveBeenCalledTimes(257)
    await resolveAvatar('url-1', 'avatar')
    expect(cacheChatAvatar).toHaveBeenCalledTimes(258)
  })

  it('bounds unresolved requests and does not reinsert evicted late results', async () => {
    const { resolveAvatar, cacheChatAvatar } = await setup()
    let finish!: (value: string | null) => void
    const firstResult = new Promise<string | null>((resolve) => {
      finish = resolve
    })
    cacheChatAvatar.mockImplementationOnce(() => firstResult)
    const first = resolveAvatar('slow', 'avatar')
    cacheChatAvatar.mockImplementation(() => new Promise(() => {}))
    for (let i = 0; i < 256; i++) void resolveAvatar(`pending-${i}`, 'avatar')
    finish('local:slow')
    expect(await first).toBe('local:slow')
    void resolveAvatar('slow', 'avatar')
    expect(cacheChatAvatar).toHaveBeenCalledTimes(258)
  })

  it('bounds negative results and retries them after eviction', async () => {
    const { resolveAvatar, cacheChatAvatar, cacheChatGif } = await setup()
    cacheChatAvatar.mockRejectedValue(new Error('refused'))
    cacheChatGif.mockResolvedValue(null)
    expect(await resolveAvatar('refused', 'avatar')).toBeNull()
    expect(await resolveAvatar('refused', 'avatar')).toBeNull()
    expect(cacheChatAvatar).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 256; i++) expect(await resolveAvatar(`gif-${i}`, 'gif')).toBeNull()
    expect(await resolveAvatar('refused', 'avatar')).toBeNull()
    expect(cacheChatAvatar).toHaveBeenCalledTimes(2)
  })
})
