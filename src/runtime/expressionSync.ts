export type SyncMode = 'mirror' | 'merge' | 'add'

export const SYNC_MODE_CHOICES: Array<{ name: string; value: SyncMode }> = [
  { name: 'Mirror: match Discord exactly (deletes extras)', value: 'mirror' },
  { name: 'Merge: add and update, keep Harmony extras', value: 'merge' },
  { name: 'Add: only add new ones', value: 'add' },
]

export interface SyncDiscordItem { id: string; name: string }
export interface SyncHarmonyItem { id: string; name: string; discordId: string | null; removed?: boolean }

export interface SyncPlan<D, H> {
  add: D[]
  update: Array<{ discord: D; harmony: H }>
  replace: Array<{ discord: D; harmony: H[] }>
  /**
   * Merge and add only: Harmony items that share a Discord item's name without being linked to it
   * (never linked, or linked to a Discord item that is gone). Left as they are and reported; only
   * mirror replaces them.
   */
  conflict: Array<{ discord: D; harmony: H[] }>
  delete: H[]
  /** Mirror and merge: soft-removed Harmony items whose Discord item still exists; they come back. */
  restore: Array<{ discord: D; harmony: H }>
  /** Creates and restores that do not fit under the per-server limit. */
  overLimit: D[]
  /** The per-server limit the plan was made under (0 = none). */
  limit: number
  unchanged: number
  /** Add mode only: linked items that changed on Discord but are left as they are. */
  outdated: number
}

const key = (name: string): string => name.toLowerCase()

export function planSync<D extends SyncDiscordItem, H extends SyncHarmonyItem>(input: {
  mode: SyncMode
  discord: D[]
  presentIds?: string[]
  harmony: H[]
  differs: (d: D, h: H) => boolean
  limit?: number
}): SyncPlan<D, H> {
  const { mode, discord, harmony, differs } = input
  const plan: SyncPlan<D, H> = { add: [], update: [], replace: [], conflict: [], delete: [], restore: [], overLimit: [], limit: Math.max(input.limit ?? 0, 0), unchanged: 0, outdated: 0 }
  const consumed = new Set<string>()

  const present = new Set<string>([...discord.map(x => x.id), ...(input.presentIds ?? [])])
  const linkedByDiscord = new Map<string, H>()
  for (const hi of harmony) {
    if (!hi.discordId) continue
    const prev = linkedByDiscord.get(hi.discordId)
    // An active row wins over a removed one linked to the same Discord item.
    if (!prev || (prev.removed && !hi.removed)) linkedByDiscord.set(hi.discordId, hi)
  }
  // Name matching sees items without a live link: never linked, or linked to a Discord item that is gone.
  const unlinkedByName = new Map<string, H[]>()
  for (const hi of harmony) {
    if (hi.removed) continue
    if (hi.discordId && present.has(hi.discordId)) continue
    const k = key(hi.name)
    const list = unlinkedByName.get(k)
    if (list) list.push(hi)
    else unlinkedByName.set(k, [hi])
  }

  // Linked items first, so they always win over name matching.
  const unlinkedDiscord: D[] = []
  for (const di of discord) {
    const linked = linkedByDiscord.get(di.id)
    if (!linked) { unlinkedDiscord.push(di); continue }
    consumed.add(linked.id)
    if (linked.removed) {
      if (mode === 'add') plan.outdated++
      else plan.restore.push({ discord: di, harmony: linked })
    }
    else if (!differs(di, linked)) plan.unchanged++
    else if (mode === 'add') plan.outdated++
    else plan.update.push({ discord: di, harmony: linked })
  }

  for (const di of unlinkedDiscord) {
    const candidates = (unlinkedByName.get(key(di.name)) ?? []).filter(x => !consumed.has(x.id))
    if (candidates.length === 0) { plan.add.push(di); continue }
    for (const c of candidates) consumed.add(c.id)
    if (mode === 'mirror') plan.replace.push({ discord: di, harmony: candidates })
    else plan.conflict.push({ discord: di, harmony: candidates })
  }

  if (mode !== 'mirror') {
    // A linked item renamed on Discord to a name an unlinked Harmony item holds: the update still
    // runs where it can, and the holder is reported. Mirror deletes such holders instead.
    const clashingRestores = new Set<string>()
    const isRestore = new Set(plan.restore.map(r => r.discord.id))
    for (const { discord: di } of [...plan.update, ...plan.restore]) {
      const holders = (unlinkedByName.get(key(di.name)) ?? []).filter(x => !consumed.has(x.id))
      if (holders.length === 0) continue
      for (const h of holders) consumed.add(h.id)
      plan.conflict.push({ discord: di, harmony: holders })
      if (isRestore.has(di.id)) clashingRestores.add(di.id)
    }
    // A restore that would take a clashing name cannot run; drop it before the limit counts it.
    if (clashingRestores.size > 0) plan.restore = plan.restore.filter(r => !clashingRestores.has(r.discord.id))
  }

  if (mode === 'mirror') {
    for (const hi of harmony) {
      if (consumed.has(hi.id) || hi.removed) continue
      if (hi.discordId && present.has(hi.discordId)) continue
      plan.delete.push(hi)
    }
  }

  if (plan.limit > 0) {
    const active = harmony.filter(x => !x.removed).length
    const replaced = plan.replace.reduce((n, r) => n + r.harmony.length, 0)
    const free = Math.max(plan.limit - (active - plan.delete.length - replaced) - plan.replace.length, 0)
    const order = new Map(discord.map((x, i) => [x.id, i]))
    const at = (x: D): number => order.get(x.id) ?? 0
    const needing: Array<{ d: D; restore: boolean }> = [
      ...plan.add.map(x => ({ d: x, restore: false })),
      ...plan.restore.map(x => ({ d: x.discord, restore: true })),
    ].sort((a, b) => at(a.d) - at(b.d))
    const over = new Set(needing.slice(free).map(x => x.d.id))
    if (over.size > 0) {
      const dropped = needing.slice(free)
      plan.add = plan.add.filter(x => !over.has(x.id))
      plan.restore = plan.restore.filter(x => !over.has(x.discord.id))
      plan.overLimit = dropped.map(x => x.d)
    }
  }
  return plan
}

const MAX_LISTED = 20

/** How to resolve name clashes; merge and add never delete. */
export const CONFLICT_HINT = "  To fix: delete or rename the Harmony one, leave it, or run `mode:mirror` to replace it with Discord's."

export function syncReportLines<D extends { name: string }, H extends { name: string }>(plan: Omit<SyncPlan<D, H>, 'restore' | 'overLimit' | 'limit'> & Partial<Pick<SyncPlan<D, H>, 'restore' | 'overLimit' | 'limit'>>, opts: {
  dryRun: boolean; label: (name: string) => string; noun: string; nounPlural?: string; limitHint?: string; removeVerb?: { dry: string; real: string }
}): string[] {
  const lines: string[] = []
  const section = (verb: string, tail: string, names: string[]): void => {
    if (names.length === 0) return
    const noun = names.length === 1 ? opts.noun : (opts.nounPlural ?? `${opts.noun}s`)
    lines.push(`${verb} ${names.length} ${noun}${tail}`)
    for (const n of names.slice(0, MAX_LISTED)) lines.push(`  • ${opts.label(n)}`)
    if (names.length > MAX_LISTED) lines.push(`  • …and ${names.length - MAX_LISTED} more`)
  }
  const v = (dry: string, real: string): string => (opts.dryRun ? dry : real)
  section(v('Would add', 'Add'), '', plan.add.map(x => x.name))
  section(v('Would update', 'Update'), '', plan.update.map(x => x.discord.name))
  section(v('Would replace', 'Replace'), ' (same name on Harmony)', plan.replace.map(x => x.discord.name))
  const rv = opts.removeVerb ?? { dry: 'Would delete', real: 'Delete' }
  section(v(rv.dry, rv.real), '', plan.delete.map(x => x.name))
  section(v('Would restore', 'Restore'), '', (plan.restore ?? []).map(x => x.discord.name))
  const overLimit = plan.overLimit ?? []
  section('Skipped', `: limit reached (${plan.limit ?? 0} per server)`, overLimit.map(x => x.name))
  if (overLimit.length > 0 && opts.limitHint) lines.push(opts.limitHint)
  section('Name clash:', ' (a Harmony one with the same name is not linked to it; left as is)', plan.conflict.map(x => x.discord.name))
  if (plan.conflict.length > 0) lines.push(CONFLICT_HINT)
  if (plan.outdated > 0) lines.push(`Not updated (add mode): ${plan.outdated}; use merge or mirror to update`)
  if (plan.unchanged > 0) lines.push(`Unchanged: ${plan.unchanged}`)
  const nothingToDo = plan.add.length + plan.update.length + plan.replace.length + plan.delete.length + plan.conflict.length + (plan.restore ?? []).length + overLimit.length + plan.outdated === 0
  if (opts.dryRun && nothingToDo) lines.push('Already matches: nothing to change')
  return lines
}
