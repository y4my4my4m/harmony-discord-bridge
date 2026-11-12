import { describe, expect, it } from 'vitest'
import { errorText } from '../src/log.js'
import { HarmonyHttpError } from '../src/HarmonyClient.js'

describe('errorText', () => {
  it('appends a code the message does not already carry', () => {
    expect(errorText(new HarmonyHttpError('full', 409, 'SOUND_LIMIT'))).toBe('full (SOUND_LIMIT)')
    expect(errorText(new HarmonyHttpError('SOUND_LIMIT: full', 409, 'SOUND_LIMIT'))).toBe('SOUND_LIMIT: full')
  })

  it('appends nothing for an error whose code is null', () => {
    expect(errorText(new HarmonyHttpError('Failed to delete sound (500)', 500))).toBe('Failed to delete sound (500)')
  })
})
