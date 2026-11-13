import { describe, expect, it, vi } from 'vitest'
import { ImportProblems, IMPORT_NOTICE_TTL_MS } from '../src/v2/importProblems.js'
import type { Problem } from '../src/problems.js'

const notice = (channel: string, count: string): Problem => ({ code: 'private_threads_skipped', params: { discord_channel_id: channel, count } })
const intent: Problem = { code: 'message_content_needed_for_import' }

function setup() {
  let now = 1_000_000
  const onChange = vi.fn()
  const problems = new ImportProblems(onChange, () => now)
  return { problems, onChange, advance: (ms: number) => { now += ms } }
}

describe('ImportProblems', () => {
  it('replaces a notice with a new count instead of keeping the first', () => {
    const { problems, onChange } = setup()
    problems.raise(notice('c1', '2'))
    problems.raise(notice('c1', '5'))
    expect(problems.current()).toEqual([notice('c1', '5')])
    expect(onChange).toHaveBeenCalledTimes(2)
    problems.raise(notice('c1', '5'))
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('keeps a notice after its job ended, for an hour', () => {
    const { problems, advance } = setup()
    problems.raise(notice('c1', '2'))
    problems.raise(intent)
    problems.clear('message_content_needed_for_import')
    expect(problems.current()).toEqual([notice('c1', '2')])
    advance(IMPORT_NOTICE_TTL_MS - 1)
    expect(problems.current()).toEqual([notice('c1', '2')])
    advance(1)
    expect(problems.current()).toEqual([])
  })

  it('drops the notices of a channel when its next import starts, and no other', () => {
    const { problems, onChange } = setup()
    problems.raise(notice('c1', '2'))
    problems.raise(notice('c2', '1'))
    problems.raise(intent)
    onChange.mockClear()
    problems.beginChannel('c1')
    expect(problems.current()).toEqual([notice('c2', '1'), intent])
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('keeps a problem that is not a notice until it is cleared', () => {
    const { problems, advance } = setup()
    problems.raise(intent)
    advance(IMPORT_NOTICE_TTL_MS * 10)
    expect(problems.current()).toEqual([intent])
    problems.clear('message_content_needed_for_import')
    expect(problems.current()).toEqual([])
  })
})
