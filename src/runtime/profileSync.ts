export type ProfileField = 'name' | 'icon' | 'banner' | 'description'
export const PROFILE_FIELDS: readonly ProfileField[] = ['name', 'icon', 'banner', 'description']

export interface DiscordProfile {
  name: string
  description: string | null
  icon: string | null
  banner: string | null
  /** Discord guild feature strings, e.g. 'COMMUNITY', 'BANNER'. */
  features: readonly string[]
}

/** What the Harmony gateway's GET /servers/:id/profile/discord returns. */
export interface HarmonyProfileState {
  name: string
  description: string | null
  icon: string | null
  banner: string | null
  icon_discord_hash: string | null
  icon_path: string | null
  banner_discord_hash: string | null
  banner_path: string | null
}

export type ProfileAction = 'same' | 'set' | 'replace' | 'clear' | 'unavailable'

export interface FieldPlan {
  field: ProfileField
  action: ProfileAction
  from: string | null
  to: string | null
}

export interface ProfilePatchBody {
  name?: string
  description?: string | null
  icon_hash?: string | null
  banner_hash?: string | null
}

export interface ProfilePlan {
  /** Selected fields only, in PROFILE_FIELDS order. */
  fields: FieldPlan[]
  /** Null when there is nothing to write. */
  body: ProfilePatchBody | null
}

function imagePlan(
  field: 'icon' | 'banner',
  discordHash: string | null,
  h: { current: string | null; hash: string | null; path: string | null },
): FieldPlan {
  const base = { field, from: h.current, to: discordHash }
  if (discordHash === null) return { ...base, action: h.current === null ? 'same' : 'clear' }
  const same = h.hash === discordHash && h.path !== null && h.current === h.path
  if (same) return { ...base, action: 'same' }
  return { ...base, action: h.current === null ? 'set' : 'replace' }
}

export function planProfileSync(d: DiscordProfile, h: HarmonyProfileState, selected: Record<ProfileField, boolean>): ProfilePlan {
  const fields: FieldPlan[] = []
  const body: ProfilePatchBody = {}
  for (const field of PROFILE_FIELDS) {
    if (!selected[field]) continue
    let plan: FieldPlan
    if (field === 'name') {
      plan = { field, action: d.name.trim() === h.name.trim() ? 'same' : 'replace', from: h.name, to: d.name }
      if (plan.action !== 'same') body.name = d.name
    } else if (field === 'description') {
      const dv = d.description?.trim() || null
      if (!d.features.includes('COMMUNITY')) plan = { field, action: 'unavailable', from: h.description, to: null }
      else {
        const action: ProfileAction = dv === h.description ? 'same' : dv === null ? 'clear' : h.description === null ? 'set' : 'replace'
        plan = { field, action, from: h.description, to: dv }
        if (action !== 'same') body.description = dv
      }
    } else if (field === 'icon') {
      plan = imagePlan('icon', d.icon, { current: h.icon, hash: h.icon_discord_hash, path: h.icon_path })
      if (plan.action !== 'same') body.icon_hash = d.icon
    } else {
      if (!d.features.includes('BANNER')) plan = { field, action: 'unavailable', from: h.banner, to: null }
      else {
        plan = imagePlan('banner', d.banner, { current: h.banner, hash: h.banner_discord_hash, path: h.banner_path })
        if (plan.action !== 'same') body.banner_hash = d.banner
      }
    }
    fields.push(plan)
  }
  return { fields, body: Object.keys(body).length > 0 ? body : null }
}

const cut = (s: string): string => (s.length > 80 ? `${s.slice(0, 79)}…` : s)
const label = (f: ProfileField): string => f[0]!.toUpperCase() + f.slice(1)

export function profilePlanLines(plan: ProfilePlan): string[] {
  const lines: string[] = []
  for (const f of plan.fields) {
    if (f.action === 'same' || f.action === 'unavailable') continue
    if (f.action === 'clear') {
      lines.push(`⚠️ Harmony's ${f.field} will be removed (Discord has none)`)
    } else if (f.field === 'name') {
      lines.push(`• Name: "${f.from ?? ''}" → "${f.to ?? ''}"`)
    } else if (f.field === 'description') {
      lines.push(`• Description: "${f.from === null ? '(none)' : cut(f.from)}" → "${cut(f.to ?? '')}"`)
    } else if (f.action === 'set') {
      lines.push(`• ${label(f.field)}: set from Discord`)
    } else {
      lines.push(`• ${label(f.field)}: Harmony's will be replaced with Discord's`)
    }
  }
  return lines
}

export function profileSkipLines(plan: ProfilePlan): string[] {
  const lines: string[] = []
  for (const f of plan.fields) {
    if (f.action !== 'unavailable') continue
    if (f.field === 'description') lines.push('Description skipped: only Community servers have one on Discord')
    else if (f.field === 'banner') lines.push("Banner skipped: this Discord server can't have a banner (boost level 2)")
  }
  return lines
}
