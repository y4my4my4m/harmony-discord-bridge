import { describe, expect, it, vi } from 'vitest'
import { confirmAction } from '../src/runtime/confirmPrompt.js'

function setup(opts: { await?: () => Promise<unknown> }) {
  const message = { awaitMessageComponent: vi.fn(opts.await ?? (async () => { throw new Error('time') })) }
  const command: any = { id: 'i1', user: { id: 'u1' }, editReply: vi.fn(async () => message) }
  return { command, message }
}

describe('confirmAction', () => {
  it('cancels silently when the wait times out', async () => {
    const { command } = setup({})
    const log = { warn: vi.fn() }
    expect(await confirmAction(command, 'sure?', 10, log)).toBe(false)
    expect(log.warn).not.toHaveBeenCalled()
    expect(command.editReply).toHaveBeenLastCalledWith({ content: 'Cancelled, nothing changed.', components: [] })
  })

  it('logs and cancels when updating the press fails', async () => {
    const update = vi.fn(async () => { throw new Error('interaction expired') })
    const { command } = setup({ await: async () => ({ customId: 'confirm:i1', user: { id: 'u1' }, update }) })
    const log = { warn: vi.fn() }
    expect(await confirmAction(command, 'sure?', 10, log)).toBe(false)
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn.mock.calls[0][0]).toContain('interaction expired')
  })

  it('returns true on Confirm', async () => {
    const update = vi.fn(async () => {})
    const { command } = setup({ await: async () => ({ customId: 'confirm:i1', user: { id: 'u1' }, update }) })
    expect(await confirmAction(command, 'sure?', 10)).toBe(true)
  })
})
