import { describe, expect, it } from 'vitest'
import { remoteFrameUrl } from './room-remote-feed'

describe('plan 260 S1.8d room remote feed', () => {
  const connection = { host: '127.0.0.1', port: 4100, token: 't0k' }

  it('asks the backend for one person and source', () => {
    const url = new URL(remoteFrameUrl(connection, 'g_ada', 'camera', null))
    expect(url.pathname).toBe('/room/remote/latest.bmp')
    expect(url.searchParams.get('token')).toBe('t0k')
    expect(url.searchParams.get('identity')).toBe('g_ada')
    expect(url.searchParams.get('source')).toBe('camera')
    expect(url.searchParams.has('afterGeneration')).toBe(false)
  })

  it('names the frame it already has', () => {
    const url = new URL(
      remoteFrameUrl(connection, 'monitor', 'monitor', { generation: 'TR_x', sequence: 7 })
    )
    expect(url.searchParams.get('afterGeneration')).toBe('TR_x')
    expect(url.searchParams.get('afterSequence')).toBe('7')
  })
})
