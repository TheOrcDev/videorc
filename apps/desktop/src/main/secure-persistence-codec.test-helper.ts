import { createCipheriv, createDecipheriv, createHash } from 'node:crypto'

import type { SecurePersistenceCodec } from './secure-persistence-codec'

const KEY = createHash('sha256').update('videorc-secure-persistence-test-key').digest()
const IV = createHash('sha256')
  .update('videorc-secure-persistence-test-iv')
  .digest()
  .subarray(0, 12)

export const testSecurePersistenceCodec: SecurePersistenceCodec = {
  seal(plaintext) {
    const cipher = createCipheriv('aes-256-gcm', KEY, IV)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return Buffer.concat([cipher.getAuthTag(), ciphertext]).toString('base64')
  },
  unseal(sealed) {
    const payload = Buffer.from(sealed, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', KEY, IV)
    decipher.setAuthTag(payload.subarray(0, 16))
    return Buffer.concat([decipher.update(payload.subarray(16)), decipher.final()]).toString('utf8')
  }
}
