import { describe, expect, it } from 'vitest'
import { CONFLICT_HINT, DEFAULT_SYNC_MODE, emptyPlan, planSync, syncConfirmLines, syncReportLines, SYNC_MODE_CHOICES, type SyncDiscordItem, type SyncHarmonyItem } from '../src/runtime/expressionSync.js'
import { joinLinesWithinDiscordLimit } from '../src/utils/discordMessage.js'

const d = (id: string, name: string, v = 1) => ({ id, name, v })
const h = (id: string, name: string, discordId: string | null = null, v = 1) => ({ id, name, discordId, v })
const differs = (a: { v: number }, b: { v: number }) => a.v !== b.v
const run = (mode: 'mirror' | 'merge' | 'add', discord: Array<SyncDiscordItem & { v: number }>, harmony: Array<SyncHarmonyItem & { v: number }>, presentIds?: string[], limit?: number, uniqueNames?: boolean) =>
  planSync({ mode, discord, harmony, presentIds, differs, limit, uniqueNames })
const rm = (id: string, name: string, discordId: string | null = null, v = 1) => ({ ...h(id, name, discordId, v), removed: true })

describe('SYNC_MODE_CHOICES', () => {
  it('lists the default first, with short names', () => {
    expect(SYNC_MODE_CHOICES.map(c => c.value)).toEqual(['merge', 'mirror', 'add'])
    for (const c of SYNC_MODE_CHOICES) expect(c.name.length).toBeLessThanOrEqual(100)
  })

  it('defaults to the mode that removes nothing', () => {
    expect(DEFAULT_SYNC_MODE).toBe('merge')
    expect(run(DEFAULT_SYNC_MODE, [], [h('H1', 'stale', '9'), h('H2', 'mine')]).delete).toEqual([])
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

  it('reports a never-linked item with the same name (ignoring case) as a clash in every mode', () => {
    for (const mode of ['mirror', 'merge', 'add'] as const) {
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

  it('reports a never-linked Harmony item holding the name a linked item is renamed to, in every mode', () => {
    const harmony = [h('H1', 'old', '1'), h('H2', 'new')]
    for (const mode of ['merge', 'mirror'] as const) {
      const p = run(mode, [d('1', 'new', 2)], harmony)
      expect(p.update.map(u => u.harmony.id)).toEqual(['H1'])
      expect(p.conflict.map(c => [c.discord.id, c.harmony.map(x => x.id)])).toEqual([['1', ['H2']]])
      expect(p.delete).toEqual([])
    }
  })

  it('mirror removes a stale-linked holder of the name a linked item is renamed to', () => {
    const m = run('mirror', [d('1', 'new', 2)], [h('H1', 'old', '1'), h('H2', 'new', '9')])
    expect(m.conflict).toHaveLength(0)
    expect(m.delete.map(x => x.id)).toEqual(['H2'])
    expect(m.update.map(u => u.harmony.id)).toEqual(['H1'])
  })

  it('merge drops a clashing restore before the limit, so it cannot push a real add over', () => {
    const harmony = [h('A', 'other', '9'), rm('R', 'old', '1'), h('U', 'back')]
    const p = run('merge', [d('9', 'other'), d('1', 'back'), d('2', 'fresh')], harmony, undefined, 3)
    expect(p.restore).toEqual([])
    expect(p.conflict.map(c => [c.discord.id, c.harmony.map(x => x.id)])).toEqual([['1', ['U']]])
    expect(p.add.map(x => x.id)).toEqual(['2'])
    expect(p.overLimit).toEqual([])
  })

  it('mirror deletes stale-linked items and keeps Harmony-only ones; merge and add delete nothing', () => {
    const harmony = [h('H1', 'only'), h('H2', 'stale', '999'), h('H3', 'kept', '1')]
    const p = run('mirror', [d('1', 'kept')], harmony)
    expect(p.delete.map(x => x.id)).toEqual(['H2'])
    expect(p.kept.map(x => x.id)).toEqual(['H1'])
    expect(run('merge', [d('1', 'kept')], harmony).delete).toHaveLength(0)
    expect(run('add', [d('1', 'kept')], harmony).delete).toHaveLength(0)
  })

  it('mirror with nothing on Discord deletes only what was copied from Discord', () => {
    const p = run('mirror', [], [h('H1', 'mine'), h('H2', 'copied', '5'), h('H3', 'also mine')])
    expect(p.delete.map(x => x.id)).toEqual(['H2'])
    expect(p.kept.map(x => x.id)).toEqual(['H1', 'H3'])
  })

  it('never deletes or replaces an item marked not removable, linked or not', () => {
    const adopted = { ...h('H1', 'horn', '9'), removable: false }
    const p = run('mirror', [d('1', 'horn')], [adopted])
    expect(p.replace).toEqual([])
    expect(p.delete).toEqual([])
    expect(p.conflict.map(c => c.harmony.map(x => x.id))).toEqual([['H1']])
    const q = run('mirror', [], [adopted])
    expect(q.delete).toEqual([])
    expect(q.kept.map(x => x.id)).toEqual(['H1'])
  })

  it('mirror replaces only when every holder of the name is removable', () => {
    const p = run('mirror', [d('1', 'horn')], [h('H1', 'horn', '9'), h('H2', 'Horn')])
    expect(p.replace).toEqual([])
    expect(p.conflict.map(c => c.harmony.map(x => x.id))).toEqual([['H2']])
    expect(p.delete.map(x => x.id)).toEqual(['H1'])
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
    const p = run('mirror', [d('1', 'a'), d('2', 'a')], [h('H1', 'A', '9')])
    expect(p.replace).toHaveLength(1)
    expect(p.replace[0].discord.id).toBe('1')
    expect(p.add.map(x => x.id)).toEqual(['2'])
    expect(p.delete).toHaveLength(0)

    const q = run('mirror', [d('1', 'a')], [h('H1', 'a', '8'), h('H2', 'a', '9')])
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
    const plan = { ...emptyPlan<{ name: string }, { name: string }>(), unchanged: 1, outdated: 2 }
    const dry = syncReportLines(plan, { dryRun: true, label: (n: string) => n, noun: 'sound' })
    expect(dry).toContain('Not updated (add mode): 2; use merge or mirror to update')
    expect(dry.join(' ')).not.toContain('Already matches')
  })

  it('lists clashes with the fix in dry and real runs, and does not call that a match', () => {
    const plan = { ...emptyPlan<{ name: string }, { name: string }>(), conflict: [{ discord: { name: 'horn' }, harmony: [{ name: 'Horn' }] }] }
    for (const dryRun of [true, false]) {
      const lines = syncReportLines(plan, { dryRun, label: (n: string) => n, noun: 'sound' })
      expect(lines[0]).toBe('Name clash: 1 sound (a Harmony one with the same name is not linked to it; left as is)')
      expect(lines).toContain('  • horn')
      expect(lines).toContain(CONFLICT_HINT)
      expect(lines.join(' ')).not.toContain('Already matches')
    }
  })

  it('says the Harmony side already matches on an empty dry run only', () => {
    const empty = { ...emptyPlan<{ name: string }, { name: string }>(), unchanged: 3 }
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
    const plan = run('mirror', [d('1', 'a')], [h('H0', 'gone', '9'), h('H1', 'a', '1'), h('H2', 'mine')])
    const lines = syncReportLines(plan, { dryRun: false, label, noun: 'sound' })
    expect(lines).toEqual(['Delete 1 sound', '  • gone', 'Kept: 1 sound not copied from Discord', 'Unchanged: 1'])
  })

  it('truncates at 20 entries', () => {
    const items = Array.from({ length: 25 }, (_, i) => d(String(i), `n${i}`))
    const lines = syncReportLines(run('add', items, []), { dryRun: true, label, noun: 'sound' })
    expect(lines).toHaveLength(1 + 20 + 1)
    expect(lines[lines.length - 1]).toBe('  • …and 5 more')
  })
})

describe('planSync restore and limit', () => {
  it('restores a removed linked item in mirror and merge, counts it outdated in add', () => {
    const harmony = [rm('H1', 'a', '1')]
    for (const mode of ['mirror', 'merge'] as const) {
      const p = run(mode, [d('1', 'a')], harmony)
      expect(p.restore.map(r => [r.discord.id, r.harmony.id])).toEqual([['1', 'H1']])
      expect(p.unchanged).toBe(0)
      expect(p.update).toHaveLength(0)
      expect(p.delete).toHaveLength(0)
    }
    const renamed = run('merge', [d('1', 'b', 2)], harmony)
    expect(renamed.restore).toHaveLength(1)
    expect(renamed.update).toHaveLength(0)
    const p = run('add', [d('1', 'a')], harmony)
    expect(p.restore).toHaveLength(0)
    expect(p.outdated).toBe(1)
    expect(p.add).toHaveLength(0)
  })

  it('ignores removed unlinked items: no name clash, no delete', () => {
    const harmony = [rm('H1', 'a')]
    for (const mode of ['mirror', 'merge', 'add'] as const) {
      const p = run(mode, [d('1', 'a')], harmony)
      expect(p.add.map(x => x.id)).toEqual(['1'])
      expect(p.conflict).toHaveLength(0)
      expect(p.replace).toHaveLength(0)
      expect(p.delete).toHaveLength(0)
    }
  })

  it('mirror does not delete removed items', () => {
    const p = run('mirror', [], [rm('H1', 'a', '9'), rm('H2', 'b')])
    expect(p.delete).toHaveLength(0)
  })

  it('merge reports an unlinked holder of a restored item name', () => {
    const harmony = [rm('H1', 'old', '1'), h('H2', 'new')]
    const p = run('merge', [d('1', 'new')], harmony)
    expect(p.restore).toEqual([])
    expect(p.conflict.map(c => [c.discord.id, c.harmony.map(x => x.id)])).toEqual([['1', ['H2']]])
  })

  it('limit moves the newest creates and restores to overLimit in Discord order', () => {
    const harmony = [h('H0', 'x', '0'), rm('H3', 'c', '3')]
    const p = run('merge', [d('0', 'x'), d('1', 'a'), d('2', 'b'), d('3', 'c')], harmony, undefined, 3)
    expect(p.limit).toBe(3)
    expect(p.unchanged).toBe(1)
    expect(p.add.map(x => x.id)).toEqual(['1', '2'])
    expect(p.restore).toHaveLength(0)
    expect(p.overLimit.map(x => x.id)).toEqual(['3'])
  })

  it('mirror deletes free slots before the limit applies', () => {
    const harmony = [h('H0', 'gone0', '90'), h('H1', 'gone1', '91'), h('H2', 'x', '2')]
    const p = run('mirror', [d('2', 'x'), d('3', 'a'), d('4', 'b')], harmony, undefined, 3)
    expect(p.delete).toHaveLength(2)
    expect(p.add.map(x => x.id)).toEqual(['3', '4'])
    expect(p.overLimit).toHaveLength(0)
    const q = run('mirror', [d('1', 'a')], [h('H1', 'a', '8'), h('H2', 'a', '9')], undefined, 2)
    expect(q.replace).toHaveLength(1)
    expect(q.overLimit).toHaveLength(0)
  })

  it('items the bridge keeps hold their slots: a member upload is not counted as freed', () => {
    const p = run('mirror', [d('1', 'a'), d('2', 'b')], [h('H0', 'mine'), h('H1', 'stale', '9')], undefined, 2)
    expect(p.delete.map(x => x.id)).toEqual(['H1'])
    expect(p.add.map(x => x.id)).toEqual(['1'])
    expect(p.overLimit.map(x => x.id)).toEqual(['2'])
  })

  it('a replace with no slot for its copy removes the stale holder and reports the copy over the limit', () => {
    // The limit was lowered to 1 with two active items; the linked one stays, the stale one goes.
    const p = run('mirror', [d('1', 'x'), d('2', 'horn')], [h('H1', 'x', '1'), h('H2', 'horn', '9')], undefined, 1)
    expect(p.replace).toEqual([])
    expect(p.delete.map(x => x.id)).toEqual(['H2'])
    expect(p.overLimit.map(x => x.id)).toEqual(['2'])
  })

  it('limit 0 or absent means no limit', () => {
    const items = [d('1', 'a'), d('2', 'b'), d('3', 'c')]
    for (const limit of [undefined, 0]) {
      const p = run('merge', items, [], undefined, limit)
      expect(p.add).toHaveLength(3)
      expect(p.overLimit).toHaveLength(0)
      expect(p.limit).toBe(0)
    }
  })
})

describe('planSync restorable and duplicate names', () => {
  it('leaves a removed item alone when it is not restorable, in every mode, and gives it no slot', () => {
    const harmony = [{ ...rm('H1', 'a', '1'), restorable: false }]
    for (const mode of ['mirror', 'merge', 'add'] as const) {
      const p = run(mode, [d('1', 'a'), d('2', 'b')], harmony, undefined, 1)
      expect(p.restore).toEqual([])
      expect(p.outdated).toBe(0)
      expect(p.keptRemoved.map(k => k.harmony.id)).toEqual(['H1'])
      expect(p.add.map(x => x.id)).toEqual(['2'])
      expect(p.overLimit).toEqual([])
    }
  })

  it('with unique names plans the earliest Discord item of a name and reports the others', () => {
    const p = run('merge', [d('1', 'dup'), d('2', 'DUP'), d('3', 'solo')], [], undefined, 2, true)
    expect(p.add.map(x => x.id)).toEqual(['1', '3'])
    expect(p.duplicate.map(x => x.id)).toEqual(['2'])
    expect(p.overLimit).toEqual([])
  })

  it('with unique names the item whose Harmony row already has the name keeps it', () => {
    const p = run('mirror', [d('1', 'dup'), d('2', 'dup')], [h('H2', 'dup', '2')], undefined, 0, true)
    expect(p.unchanged).toBe(1)
    expect(p.duplicate.map(x => x.id)).toEqual(['1'])
    expect(p.add).toEqual([])
    // The duplicate is still on Discord: mirror does not remove its row.
    const q = run('mirror', [d('1', 'dup'), d('2', 'dup')], [h('H1', 'old', '1'), h('H2', 'dup', '2')], undefined, 0, true)
    expect(q.delete).toEqual([])
  })

  it('without unique names two Discord items of a name are both planned', () => {
    const p = run('merge', [d('1', 'dup'), d('2', 'dup')], [])
    expect(p.add.map(x => x.id)).toEqual(['1', '2'])
    expect(p.duplicate).toEqual([])
  })
})

describe('syncConfirmLines', () => {
  const opts = { label: (n: string) => n, noun: 'sound', warning: '⚠️ This deletes sounds. Confirm?' }

  it('starts with the warning and lists every removal, past the 20 a report section shows', () => {
    const stale = Array.from({ length: 48 }, (_, i) => h(`H${i}`, `stale${i}`, `9${i}`))
    const lines = syncConfirmLines(run('mirror', [], stale), opts)
    expect(lines[0]).toBe(opts.warning)
    expect(lines[1]).toBe('Delete 48 sounds')
    expect(lines.slice(2, 50)).toEqual(stale.map(x => `  • ${x.name}`))
    expect(lines.join('\n')).not.toContain('more')
  })

  it('keeps the warning and the removals when Discord cuts the message', () => {
    const stale = Array.from({ length: 20 }, (_, i) => h(`H${i}`, `stale-with-a-long-name-${i}`, `9${i}`))
    const fresh = Array.from({ length: 22 }, (_, i) => d(`1${i}`, `new-sound-with-quite-a-long-name-${i}`))
    const renamed = Array.from({ length: 22 }, (_, i) => h(`R${i}`, `renamed-sound-quite-a-long-name-${i}`, `2${i}`, 2))
    const updates = renamed.map(r => d(r.discordId!, r.name))
    const plan = run('mirror', [...fresh, ...updates], [...stale, ...renamed])
    const text = joinLinesWithinDiscordLimit(syncConfirmLines(plan, opts))
    expect(text.length).toBeLessThanOrEqual(2000)
    expect(text).toContain('more_')
    expect(text.startsWith(opts.warning)).toBe(true)
    for (const x of stale) expect(text).toContain(`  • ${x.name}\n`)
  })
})

describe('CONFLICT_HINT', () => {
  it('points at no mode: none replaces a Harmony item the bridge did not copy', () => {
    expect(CONFLICT_HINT).not.toMatch(/mirror|merge|mode/)
  })
})

describe('syncReportLines kept, left removed and duplicates', () => {
  const label = (n: string) => n
  it('reports them and does not call that a match', () => {
    const plan = run('mirror', [d('1', 'a'), d('2', 'A'), d('3', 'gone')], [h('H0', 'mine'), { ...rm('H3', 'gone', '3'), restorable: false }], undefined, 0, true)
    const lines = syncReportLines(plan, { dryRun: true, label, noun: 'emoji', nounPlural: 'emoji' })
    expect(lines).toContain('Skipped 1 emoji: another one on Discord has the same name')
    expect(lines).toContain('Left removed: 1 emoji (a person removed it on Harmony)')
    expect(lines).toContain('Kept: 1 emoji not copied from Discord')
    expect(lines.join(' ')).not.toContain('Already matches')
  })
})

describe('syncReportLines removeVerb', () => {
  it('uses the given verbs for the delete section', () => {
    const plan = run('mirror', [], [h('H1', 'x', '9')])
    const base = { label: (n: string) => n, noun: 'emoji' }
    expect(syncReportLines(plan, { ...base, dryRun: true, removeVerb: { dry: 'Would remove', real: 'Remove' } })[0]).toBe('Would remove 1 emoji')
    expect(syncReportLines(plan, { ...base, dryRun: false, removeVerb: { dry: 'Would remove', real: 'Remove' } })[0]).toBe('Remove 1 emoji')
    expect(syncReportLines(plan, { ...base, dryRun: true })[0]).toBe('Would delete 1 emoji')
  })
})

describe('syncReportLines restore and limit', () => {
  const label = (n: string) => n
  it('lists restores and over-limit items with the hint, and never says Already matches with overLimit', () => {
    const harmony = [rm('H1', 'b', '2')]
    const plan2 = run('merge', [d('2', 'b'), d('3', 'c')], harmony, undefined, 3)
    const opts = { dryRun: true, label, noun: 'emoji', nounPlural: 'emoji', limitHint: 'Delete some, then re-run.' }
    expect(syncReportLines(plan2, opts)).toEqual(['Would add 1 emoji', '  • c', 'Would restore 1 emoji', '  • b'])
    const over = run('merge', [d('1', 'a'), d('2', 'b')], [h('H0', 'x', '0')], undefined, 1)
    const lines = syncReportLines(over, { ...opts })
    expect(lines).toContain('Skipped 2 emoji: limit reached (1 per server)')
    const one = run('merge', [d('1', 'a'), d('2', 'b')], [h('H0', 'x', '0')], undefined, 2)
    const l1 = syncReportLines(one, opts)
    expect(l1.slice(0, 3)).toEqual(['Would add 1 emoji', '  • a', 'Skipped 1 emoji: limit reached (2 per server)'])
    expect(l1).toContain('  • b')
    expect(l1[l1.length - 1]).toBe('Delete some, then re-run.')
    const onlyOver = run('merge', [d('1', 'a')], [h('H0', 'x', '0')], undefined, 1)
    expect(syncReportLines(onlyOver, opts).join(' ')).not.toContain('Already matches')
    expect(syncReportLines(plan2, { ...opts, dryRun: false })[2]).toBe('Restore 1 emoji')
  })

  it('uses nounPlural when given, and noun + s otherwise', () => {
    const two = run('mirror', [d('1', 'a'), d('2', 'b')], [])
    expect(syncReportLines(two, { dryRun: true, label, noun: 'emoji', nounPlural: 'emoji' })[0]).toBe('Would add 2 emoji')
    expect(syncReportLines(two, { dryRun: true, label, noun: 'sound' })[0]).toBe('Would add 2 sounds')
  })
})
