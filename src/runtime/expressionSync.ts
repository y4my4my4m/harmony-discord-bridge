export type SyncMode = 'mirror' | 'merge' | 'add'

/** Merge removes nothing, so it is the mode a run gets without one. */
export const DEFAULT_SYNC_MODE: SyncMode = 'merge'

export const SYNC_MODE_CHOICES: Array<{ name: string; value: SyncMode }> = [
  { name: 'Merge: add and update, remove nothing', value: 'merge' },
  { name: 'Mirror: merge, and remove the ones deleted on Discord', value: 'mirror' },
  { name: 'Add: only add new ones', value: 'add' },
]

export interface SyncDiscordItem { id: string; name: string }
export interface SyncHarmonyItem {
  id: string
  name: string
  discordId: string | null
  removed?: boolean
  /** Whether the bridge may remove the item. Default: it carries a Discord link. A member's upload is never removable. */
  removable?: boolean
  /** Whether the bridge may restore the removed item. Default true; false once a person removed it. */
  restorable?: boolean
}

export interface SyncPlan<D, H> {
  add: D[]
  update: Array<{ discord: D; harmony: H }>
  /** Mirror only: a Discord item takes the name of removable Harmony items whose Discord item is gone. */
  replace: Array<{ discord: D; harmony: H[] }>
  /**
   * Harmony items that share a Discord item's name without being linked to it. Left as they are
   * and reported. Mirror lists only the ones it may not remove; merge and add list all.
   */
  conflict: Array<{ discord: D; harmony: H[] }>
  /** Mirror only: removable Harmony items whose Discord item is gone. */
  delete: H[]
  /** Mirror only: Harmony items that are not on Discord and not the bridge's to remove. */
  kept: H[]
  /** Mirror and merge: removed Harmony items the bridge may restore, whose Discord item still exists. */
  restore: Array<{ discord: D; harmony: H }>
  /** Removed Harmony items a person removed; they stay removed in every mode. */
  keptRemoved: Array<{ discord: D; harmony: H }>
  /** Unique names only: Discord items whose name an earlier Discord item already has. */
  duplicate: D[]
  /** Creates and restores that do not fit under the per-server limit. */
  overLimit: D[]
  /** The per-server limit the plan was made under (0 = none). */
  limit: number
  unchanged: number
  /** Add mode only: linked items that changed on Discord but are left as they are. */
  outdated: number
}

const key = (name: string): string => name.toLowerCase()

const removable = (h: SyncHarmonyItem): boolean => h.removable ?? h.discordId !== null
const restorable = (h: SyncHarmonyItem): boolean => h.restorable ?? true

export function emptyPlan<D, H>(limit = 0): SyncPlan<D, H> {
  return {
    add: [], update: [], replace: [], conflict: [], delete: [], kept: [], restore: [], keptRemoved: [],
    duplicate: [], overLimit: [], limit: Math.max(limit, 0), unchanged: 0, outdated: 0,
  }
}

export function planSync<D extends SyncDiscordItem, H extends SyncHarmonyItem>(input: {
  mode: SyncMode
  /** In creation order when `limit` or `uniqueNames` is set: the earliest wins. */
  discord: D[]
  presentIds?: string[]
  harmony: H[]
  differs: (d: D, h: H) => boolean
  limit?: number
  /** Harmony allows one item per name (ignoring case): a second Discord item of a name is not planned. */
  uniqueNames?: boolean
}): SyncPlan<D, H> {
  const { mode, harmony, differs } = input
  const plan = emptyPlan<D, H>(input.limit)
  const consumed = new Set<string>()

  const present = new Set<string>([...input.discord.map(x => x.id), ...(input.presentIds ?? [])])
  const linkedByDiscord = new Map<string, H>()
  for (const hi of harmony) {
    if (!hi.discordId) continue
    const prev = linkedByDiscord.get(hi.discordId)
    // An active row wins over a removed one linked to the same Discord item.
    if (!prev || (prev.removed && !hi.removed)) linkedByDiscord.set(hi.discordId, hi)
  }

  let discord = input.discord
  if (input.uniqueNames) {
    // The item whose active Harmony row already has the name keeps it; otherwise the earliest.
    const holder = new Map<string, D>()
    const holds = (di: D): boolean => {
      const linked = linkedByDiscord.get(di.id)
      return !!linked && !linked.removed && key(linked.name) === key(di.name)
    }
    for (const di of discord) {
      const k = key(di.name)
      const prev = holder.get(k)
      if (!prev || (!holds(prev) && holds(di))) holder.set(k, di)
    }
    plan.duplicate = discord.filter(di => holder.get(key(di.name)) !== di)
    discord = discord.filter(di => holder.get(key(di.name)) === di)
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
  const holdersOf = (name: string): H[] => (unlinkedByName.get(key(name)) ?? []).filter(x => !consumed.has(x.id))

  // Linked items first, so they always win over name matching.
  const unlinkedDiscord: D[] = []
  for (const di of discord) {
    const linked = linkedByDiscord.get(di.id)
    if (!linked) { unlinkedDiscord.push(di); continue }
    consumed.add(linked.id)
    if (linked.removed) {
      if (!restorable(linked)) plan.keptRemoved.push({ discord: di, harmony: linked })
      else if (mode === 'add') plan.outdated++
      else plan.restore.push({ discord: di, harmony: linked })
    }
    else if (!differs(di, linked)) plan.unchanged++
    else if (mode === 'add') plan.outdated++
    else plan.update.push({ discord: di, harmony: linked })
  }

  for (const di of unlinkedDiscord) {
    const candidates = holdersOf(di.name)
    if (candidates.length === 0) { plan.add.push(di); continue }
    // Mirror replaces holders it may remove. One it may not remove keeps the name: a clash.
    const fixed = mode === 'mirror' ? candidates.filter(c => !removable(c)) : candidates
    if (fixed.length === 0) {
      for (const c of candidates) consumed.add(c.id)
      plan.replace.push({ discord: di, harmony: candidates })
    } else {
      for (const c of fixed) consumed.add(c.id)
      plan.conflict.push({ discord: di, harmony: fixed })
    }
  }

  // A linked item renamed on Discord to a name an unlinked Harmony item holds: the update still
  // runs where it can, and the holder is reported. Mirror removes the holders it may remove.
  const clashingRestores = new Set<string>()
  const isRestore = new Set(plan.restore.map(r => r.discord.id))
  for (const { discord: di } of [...plan.update, ...plan.restore]) {
    const holders = holdersOf(di.name).filter(x => mode !== 'mirror' || !removable(x))
    if (holders.length === 0) continue
    for (const h of holders) consumed.add(h.id)
    plan.conflict.push({ discord: di, harmony: holders })
    if (isRestore.has(di.id)) clashingRestores.add(di.id)
  }
  // A restore that would take a clashing name cannot run; drop it before the limit counts it.
  if (clashingRestores.size > 0) plan.restore = plan.restore.filter(r => !clashingRestores.has(r.discord.id))

  if (mode === 'mirror') {
    for (const hi of harmony) {
      if (consumed.has(hi.id) || hi.removed) continue
      if (hi.discordId && present.has(hi.discordId)) continue
      if (removable(hi)) plan.delete.push(hi)
      else plan.kept.push(hi)
    }
  }

  if (plan.limit > 0) {
    const order = new Map(input.discord.map((x, i) => [x.id, i]))
    const at = (x: D): number => order.get(x.id) ?? 0
    const active = harmony.filter(x => !x.removed).length
    const replaced = plan.replace.reduce((n, r) => n + r.harmony.length, 0)
    const afterRemovals = active - plan.delete.length - replaced
    // A replace with no slot for its copy: the holders go as plain removals, the copy waits.
    const room = Math.max(plan.limit - afterRemovals, 0)
    const unfit = plan.replace.splice(room)
    for (const r of unfit) plan.delete.push(...r.harmony)
    const free = Math.max(plan.limit - afterRemovals - plan.replace.length, 0)
    const needing: Array<{ d: D; restore: boolean }> = [
      ...plan.add.map(x => ({ d: x, restore: false })),
      ...plan.restore.map(x => ({ d: x.discord, restore: true })),
    ].sort((a, b) => at(a.d) - at(b.d))
    const dropped = needing.slice(free)
    const over = new Set(dropped.map(x => x.d.id))
    plan.add = plan.add.filter(x => !over.has(x.id))
    plan.restore = plan.restore.filter(x => !over.has(x.discord.id))
    plan.overLimit = [...unfit.map(r => r.discord), ...dropped.map(x => x.d)].sort((a, b) => at(a) - at(b))
  }
  return plan
}

const MAX_LISTED = 20

/** How to resolve a name clash. No mode removes a Harmony item the bridge did not copy. */
export const CONFLICT_HINT = "  To use Discord's: delete or rename the Harmony one, then run this again."

export interface SyncReportOptions {
  dryRun: boolean
  label: (name: string) => string
  noun: string
  nounPlural?: string
  limitHint?: string
  removeVerb?: { dry: string; real: string }
}

function reportSections<D extends { name: string }, H extends { name: string }>(
  plan: SyncPlan<D, H>,
  opts: SyncReportOptions,
): { changes: string[]; removals: (all: boolean) => string[]; rest: string[] } {
  const nouns = (n: number): string => (n === 1 ? opts.noun : (opts.nounPlural ?? `${opts.noun}s`))
  const section = (verb: string, tail: string, names: string[], all = false): string[] => {
    if (names.length === 0) return []
    const out = [`${verb} ${names.length} ${nouns(names.length)}${tail}`]
    for (const n of all ? names : names.slice(0, MAX_LISTED)) out.push(`  • ${opts.label(n)}`)
    if (!all && names.length > MAX_LISTED) out.push(`  • …and ${names.length - MAX_LISTED} more`)
    return out
  }
  const v = (dry: string, real: string): string => (opts.dryRun ? dry : real)
  const rv = opts.removeVerb ?? { dry: 'Would delete', real: 'Delete' }

  const changes = [
    ...section(v('Would add', 'Add'), '', plan.add.map(x => x.name)),
    ...section(v('Would update', 'Update'), '', plan.update.map(x => x.discord.name)),
    ...section(v('Would replace', 'Replace'), ' (same name, copied from a deleted Discord one)', plan.replace.map(x => x.discord.name)),
  ]
  const removals = (all: boolean): string[] => section(v(rv.dry, rv.real), '', plan.delete.map(x => x.name), all)
  const rest = [
    ...section(v('Would restore', 'Restore'), '', plan.restore.map(x => x.discord.name)),
    ...section('Skipped', `: limit reached (${plan.limit} per server)`, plan.overLimit.map(x => x.name)),
  ]
  if (plan.overLimit.length > 0 && opts.limitHint) rest.push(opts.limitHint)
  rest.push(...section('Skipped', ': another one on Discord has the same name', plan.duplicate.map(x => x.name)))
  rest.push(...section('Name clash:', ' (a Harmony one with the same name is not linked to it; left as is)', plan.conflict.map(x => x.discord.name)))
  if (plan.conflict.length > 0) rest.push(CONFLICT_HINT)
  rest.push(...section('Left removed:', ' (a person removed it on Harmony)', plan.keptRemoved.map(x => x.discord.name)))
  if (plan.kept.length > 0) rest.push(`Kept: ${plan.kept.length} ${nouns(plan.kept.length)} not copied from Discord`)
  if (plan.outdated > 0) rest.push(`Not updated (add mode): ${plan.outdated}; use merge or mirror to update`)
  if (plan.unchanged > 0) rest.push(`Unchanged: ${plan.unchanged}`)
  return { changes, removals, rest }
}

/** Whether applying the plan would change nothing and leave nothing to report. */
function nothingToReport<D, H>(plan: SyncPlan<D, H>): boolean {
  return plan.add.length + plan.update.length + plan.replace.length + plan.delete.length + plan.conflict.length
    + plan.restore.length + plan.overLimit.length + plan.duplicate.length + plan.keptRemoved.length + plan.outdated === 0
}

export function syncReportLines<D extends { name: string }, H extends { name: string }>(
  plan: SyncPlan<D, H>,
  opts: SyncReportOptions,
): string[] {
  const { changes, removals, rest } = reportSections(plan, opts)
  const lines = [...changes, ...removals(false), ...rest]
  if (opts.dryRun && nothingToReport(plan)) lines.push('Already matches: nothing to change')
  return lines
}

/**
 * Lines of a Confirm prompt. The warning and every removal come first: a message over Discord's
 * length limit loses its tail, never the part the buttons are about.
 */
export function syncConfirmLines<D extends { name: string }, H extends { name: string }>(
  plan: SyncPlan<D, H>,
  opts: Omit<SyncReportOptions, 'dryRun'> & { warning: string },
): string[] {
  const { changes, removals, rest } = reportSections(plan, { ...opts, dryRun: false })
  return [opts.warning, ...removals(true), ...changes, ...rest]
}
