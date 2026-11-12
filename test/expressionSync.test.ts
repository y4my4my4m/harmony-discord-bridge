import { describe, expect, it } from 'vitest'
import { CONFLICT_HINT, planSync, syncReportLines, SYNC_MODE_CHOICES, type SyncDiscordItem, type SyncHarmonyItem } from '../src/runtime/expressionSync.js'

const d = (id: string, name: string, v = 1) => ({ id, name, v })
const h = (id: string, name: string, discordId: string | null = null, v = 1) => ({ id, name, discordId, v })
const differs = (a: { v: number }, b: { v: number }) => a.v !== b.v
const run = (mode: 'mirror' | 'merge' | 'add', discord: Array<SyncDiscordItem & { v: number }>, harmony: Array<SyncHarmonyItem & { v: number }>, presentIds?: string[]) =>
  planSync({ mode, discord, harmony, presentIds, differs })

describe('SYNC_MODE_CHOICES', () => {
  it('lists mirror first with short names', () => {
    expect(SYNC_MODE_CHOICES.map(c => c.value)).toEqual(['mirror', 'merge', 'add'])
    for (const c of SYNC_MODE_CHOICES) expect(c.name.length).toBeLessThanOrEqual(100)
  })
})

describe('planSync', () => {
  it('adds new items in every mode', () => {
    for (const mode of ['mirror', 'merge', 'add'] as const) {
      const p = run(mode, [d('1', 'a')], [])
      expect(p.add.map(x => x.id)).toEqual(['1'])
    }
  })

  it('updates differing linked items in mirror and merge but not add', () => {
    const harmony = [h('H1', 'a', '1', 2)]
    for (const mode of ['mirror', 'merge'] as const) {
      const p = run(mode, [d('1', 'a')], harmony)
      expect(p.update).toHaveLength(1)
      expect(p.unchanged).toBe(0)
    }
    const p = run('add', [d('1', 'a')], harmony)
    expect(p.update).toHaveLength(0)
    expect(p.unchanged).toBe(0)
    expect(p.outdated).toBe(1)
  })

  it('counts identical linked items as unchanged', () => {
    const p = run('mirror', [d('1', 'a')], [h('H1', 'a', '1')])
    expect(p.unchanged).toBe(1)
    expect(p.update).toHaveLength(0)
  })

  it('mirror replaces a case-insensitive name match; merge and add report it as a clash', () => {
    const p = run('mirror', [d('1', 'airhorn')], [h('H1', 'AirHorn')])
    expect(p.replace).toHaveLength(1)
    expect(p.replace[0].harmony.map(x => x.id)).toEqual(['H1'])
    expect(p.conflict).toHaveLength(0)
    expect(p.add).toHaveLength(0)
    expect(p.delete).toHaveLength(0)
    for (const mode of ['merge', 'add'] as const) {
      const q = run(mode, [d('1', 'airhorn')], [h('H1', 'AirHorn')])
      expect(q.conflict.map(c => [c.discord.id, c.harmony.map(x => x.id)])).toEqual([['1', ['H1']]])
      expect(q.replace).toHaveLength(0)
      expect(q.add).toHaveLength(0)
      expect(q.delete).toHaveLength(0)
    }
  })

  it('name-matches Harmony items linked to a Discord item that is gone', () => {
    // H1 was imported from Discord item 9, deleted on Discord; a new Discord item reuses its name.
    const harmony = [h('H1', 'horn', '9')]
    const m = run('mirror', [d('2', 'horn')], harmony)
    expect(m.replace.map(r => r.harmony.map(x => x.id))).toEqual([['H1']])
    expect(m.delete).toHaveLength(0)
    for (const mode of ['merge', 'add'] as const) {
      const q = run(mode, [d('2', 'horn')], harmony)
      expect(q.conflict.map(c => c.harmony.map(x => x.id))).toEqual([['H1']])
      expect(q.add).toHaveLength(0)
    }
  })

  it('merge reports an unlinked Harmony item holding the name a linked item is renamed to', () => {
    const harmony = [h('H1', 'old', '1'), h('H2', 'new')]
    const p = run('merge', [d('1', 'new', 2)], harmony)
    expect(p.update.map(u => u.harmony.id)).toEqual(['H1'])
    expect(p.conflict.map(c => [c.discord.id, c.harmony.map(x => x.id)])).toEqual([['1', ['H2']]])
    const m = run('mirror', [d('1', 'new', 2)], harmony)
    expect(m.conflict).toHaveLength(0)
    expect(m.delete.map(x => x.id)).toEqual(['H2'])
  })

  it('mirror deletes Harmony-only and stale-linked items; merge and add delete nothing', () => {
    const harmony = [h('H1', 'only'), h('H2', 'stale', '999'), h('H3', 'kept', '1')]
    const p = run('mirror', [d('1', 'kept')], harmony)
    expect(p.delete.map(x => x.id).sort()).toEqual(['H1', 'H2'])
    expect(run('merge', [d('1', 'kept')], harmony).delete).toHaveLength(0)
    expect(run('add', [d('1', 'kept')], harmony).delete).toHaveLength(0)
  })

  it('leaves items linked to presentIds neither deleted nor updated', () => {
    const p = run('mirror', [], [h('H1', 'x', '5', 2)], ['5'])
    expect(p.delete).toHaveLength(0)
    expect(p.update).toHaveLength(0)
    expect(p.add).toHaveLength(0)
  })

  it('does not treat a same-name unlinked Discord item as colliding with a presentIds-linked Harmony item', () => {
    const p = run('mirror', [d('1', 'x')], [h('H1', 'x', '5', 2)], ['5'])
    expect(p.add.map(x => x.id)).toEqual(['1'])
    expect(p.replace).toHaveLength(0)
    expect(p.update).toHaveLength(0)
    expect(p.delete).toHaveLength(0)
  })

  it('never schedules one Harmony sound for two actions', () => {
    const p = run('mirror', [d('1', 'a'), d('2', 'a')], [h('H1', 'A')])
    expect(p.replace).toHaveLength(1)
    expect(p.replace[0].discord.id).toBe('1')
    expect(p.add.map(x => x.id)).toEqual(['2'])
    expect(p.delete).toHaveLength(0)

    const q = run('mirror', [d('1', 'a')], [h('H1', 'a'), h('H2', 'a')])
    expect(q.replace).toHaveLength(1)
    expect(q.replace[0].harmony.map(x => x.id)).toEqual(['H1', 'H2'])
    expect(q.delete).toHaveLength(0)

    const s = run('add', [d('1', 'a'), d('2', 'a')], [h('H1', 'a')])
    expect(s.conflict.map(x => x.discord.id)).toEqual(['1'])
    expect(s.add.map(x => x.id)).toEqual(['2'])
  })

  it('reports every same-name Harmony item of a clash', () => {
    const p = run('add', [d('1', 'a')], [h('H1', 'a'), h('H2', 'a')])
    expect(p.conflict.map(x => x.harmony.map(y => y.id))).toEqual([['H1', 'H2']])
  })
})

describe('syncReportLines', () => {
  it('reports outdated add-mode items and does not call that a match', () => {
    const plan = { add: [], update: [], replace: [], conflict: [], delete: [], unchanged: 1, outdated: 2 }
    const dry = syncReportLines(plan, { dryRun: true, label: (n: string) => n, noun: 'sound' })
    expect(dry).toContain('Not updated (add mode): 2 changed on Discord; use merge or mirror to update')
    expect(dry.join(' ')).not.toContain('Already matches')
  })

  it('lists clashes with the fix in dry and real runs, and does not call that a match', () => {
    const plan = { add: [], update: [], replace: [], conflict: [{ discord: { name: 'horn' }, harmony: [{ name: 'Horn' }] }], delete: [], unchanged: 0, outdated: 0 }
    for (const dryRun of [true, false]) {
      const lines = syncReportLines(plan, { dryRun, label: (n: string) => n, noun: 'sound' })
      expect(lines[0]).toBe('Name clash: 1 sound (a Harmony one with the same name is not linked to it; left as is)')
      expect(lines).toContain('  • horn')
      expect(lines).toContain(CONFLICT_HINT)
      expect(lines.join(' ')).not.toContain('Already matches')
    }
  })

  it('says the Harmony side already matches on an empty dry run only', () => {
    const empty = { add: [], update: [], replace: [], conflict: [], delete: [], unchanged: 3, outdated: 0 }
    const dry = syncReportLines(empty, { dryRun: true, label: (n: string) => n, noun: 'sound' })
    expect(dry).toContain('Already matches: nothing to change')
    const real = syncReportLines(empty, { dryRun: false, label: (n: string) => n, noun: 'sound' })
    expect(real.join(' ')).not.toContain('Already matches')
  })

  const label = (n: string) => n
  it('says Would add in a dry run, with pluralization', () => {
    const plan = run('mirror', [d('1', 'a')], [])
    expect(syncReportLines(plan, { dryRun: true, label, noun: 'sound' })).toEqual(['Would add 1 sound', '  • a'])
    const two = run('mirror', [d('1', 'a'), d('2', 'b')], [])
    expect(syncReportLines(two, { dryRun: true, label, noun: 'sound' })[0]).toBe('Would add 2 sounds')
  })

  it('uses imperative headings for a real run and reports unchanged', () => {
    const plan = run('mirror', [d('1', 'a')], [h('H0', 'gone'), h('H1', 'a', '1')])
    const lines = syncReportLines(plan, { dryRun: false, label, noun: 'sound' })
    expect(lines).toEqual(['Delete 1 sound', '  • gone', 'Unchanged: 1'])
  })

  it('truncates at 20 entries', () => {
    const items = Array.from({ length: 25 }, (_, i) => d(String(i), `n${i}`))
    const lines = syncReportLines(run('add', items, []), { dryRun: true, label, noun: 'sound' })
    expect(lines).toHaveLength(1 + 20 + 1)
    expect(lines[lines.length - 1]).toBe('  • …and 5 more')
  })
})
