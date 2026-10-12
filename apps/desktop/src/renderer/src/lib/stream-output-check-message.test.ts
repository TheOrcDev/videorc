import { describe, expect, it, vi } from 'vitest'

import { RuntimeSchemaError } from '../../../shared/runtime-schema'
import { streamOutputCheckFailureMessage } from './stream-output-check-message'

describe('streamOutputCheckFailureMessage (plan 0015)', () => {
  it('keeps a raw contract path out of user copy and logs it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const message = streamOutputCheckFailureMessage(
      new RuntimeSchemaError('backend.result.fallbackReason', 'absent for a passed topology')
    )
    expect(message).not.toContain('fallbackReason')
    expect(message).toContain('Restart Videorc')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fallbackReason'))
    warn.mockRestore()
  })

  it('passes engine errors through and covers non-errors', () => {
    expect(streamOutputCheckFailureMessage(new Error('FFmpeg is missing.'))).toBe(
      'FFmpeg is missing.'
    )
    expect(streamOutputCheckFailureMessage('nope')).toBe(
      "The livestream output path couldn't be verified."
    )
  })
})
