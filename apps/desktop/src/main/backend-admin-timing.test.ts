import { describe, expect, it } from 'vitest'

import {
  BACKEND_ADMIN_RESPONSE_SLACK_MS,
  BACKEND_FILE_MUTATION_MAX_EXECUTION_MS,
  BACKEND_FILE_MUTATION_REQUEST_TIMEOUT_MS
} from './backend-admin-timing'

describe('backend admin timing', () => {
  it('keeps deletion completion above the backend file-mutation deadline', () => {
    expect(BACKEND_FILE_MUTATION_MAX_EXECUTION_MS).toBe(30_000)
    expect(BACKEND_ADMIN_RESPONSE_SLACK_MS).toBe(15_000)
    expect(BACKEND_FILE_MUTATION_REQUEST_TIMEOUT_MS).toBe(45_000)
  })
})
