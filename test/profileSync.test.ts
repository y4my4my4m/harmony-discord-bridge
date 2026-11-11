import { describe, expect, it } from 'vitest'
import { planProfileSync, profilePlanLines, profileSkipLines, type DiscordProfile, type HarmonyProfileState, type ProfileField } from '../src/runtime/profileSync.js'

const all: Record<ProfileField, boolean> = { name: true, icon: true, banner: true, description: true }
const only = (f: ProfileField): Record<ProfileField, boolean> => ({ name: false, icon: false, banner: false, description: false, [f]: true })

const disc = (o: Partial<DiscordProfile> = {}): DiscordProfile => ({ name: 'Srv', description: null, icon: null, banner: null, features: [], ...o })
const harm = (o: Partial<HarmonyProfileState> = {}): HarmonyProfileState => ({
  name: 'Srv', description: null, icon: null, banner: null,
  icon_discord_hash: null, icon_path: null, banner_discord_hash: null, banner_path: null, ...o,
})
const act = (d: DiscordProfile, h: HarmonyProfileState, f: ProfileField) => planProfileSync(d, h, only(f)).fields[0]!.action

describe('planProfileSync', () => {
  it('name differing only by surrounding whitespace is same', () => {
    expect(act(disc({ name: ' Srv ' }), harm({ name: 'Srv' }), 'name')).toBe('same')
  })

  it('hash match with null icon_path is replace', () => {
    const p = planProfileSync(
      disc({ icon: 'abc' }),
      harm({ icon: 'https://h/i.png', icon_discord_hash: 'abc', icon_path: null }),
      only('icon'),
    )
    expect(p.fields[0]!.action).toBe('replace')
    expect(p.body).toEqual({ icon_hash: 'abc' })
  })

  it('renamed server is replace with body.name', () => {
    const p = planProfileSync(disc({ name: 'New' }), harm({ name: 'Old' }), only('name'))
    expect(p.fields).toEqual([{ field: 'name', action: 'replace', from: 'Old', to: 'New' }])
    expect(p.body).toEqual({ name: 'New' })
  })

  it('non-community description is unavailable and not in body', () => {
    const p = planProfileSync(disc({ description: 'x' }), harm(), only('description'))
    expect(p.fields[0]!.action).toBe('unavailable')
    expect(p.body).toBeNull()
  })

  it('community server with no description clears a Harmony description', () => {
    const p = planProfileSync(disc({ features: ['COMMUNITY'] }), harm({ description: 'old' }), only('description'))
    expect(p.fields[0]!.action).toBe('clear')
    expect(p.body).toEqual({ description: null })
  })

  it('description set when Harmony has none', () => {
    const p = planProfileSync(disc({ features: ['COMMUNITY'], description: ' hi ' }), harm(), only('description'))
    expect(p.fields[0]!.action).toBe('set')
    expect(p.body).toEqual({ description: 'hi' })
  })

  it('icon same when hash and path match', () => {
    expect(act(disc({ icon: 'abc' }), harm({ icon: 'p/a.png', icon_path: 'p/a.png', icon_discord_hash: 'abc' }), 'icon')).toBe('same')
  })

  it('hand-changed Harmony icon is replace', () => {
    expect(act(disc({ icon: 'abc' }), harm({ icon: 'p/other.png', icon_path: 'p/a.png', icon_discord_hash: 'abc' }), 'icon')).toBe('replace')
  })

  it('new Discord icon hash is replace', () => {
    const p = planProfileSync(disc({ icon: 'new' }), harm({ icon: 'p/a.png', icon_path: 'p/a.png', icon_discord_hash: 'abc' }), only('icon'))
    expect(p.fields[0]!.action).toBe('replace')
    expect(p.body).toEqual({ icon_hash: 'new' })
  })

  it('icon set when Harmony has none', () => {
    expect(act(disc({ icon: 'abc' }), harm(), 'icon')).toBe('set')
  })

  it("Discord without icon clears Harmony's", () => {
    const p = planProfileSync(disc(), harm({ icon: 'p/a.png' }), only('icon'))
    expect(p.fields[0]!.action).toBe('clear')
    expect(p.body).toEqual({ icon_hash: null })
    expect(act(disc(), harm(), 'icon')).toBe('same')
  })

  it('banner unavailable without BANNER feature', () => {
    const p = planProfileSync(disc({ banner: 'b' }), harm(), only('banner'))
    expect(p.fields[0]!.action).toBe('unavailable')
    expect(p.body).toBeNull()
  })

  it('banner with BANNER feature and null hash clears', () => {
    const p = planProfileSync(disc({ features: ['BANNER'] }), harm({ banner: 'p/b.png' }), only('banner'))
    expect(p.fields[0]!.action).toBe('clear')
    expect(p.body).toEqual({ banner_hash: null })
  })

  it('deselected field is absent from fields and body', () => {
    const p = planProfileSync(disc({ name: 'New' }), harm({ name: 'Old' }), only('icon'))
    expect(p.fields.map(f => f.field)).toEqual(['icon'])
    expect(p.body).toBeNull()
  })

  it('all same gives null body', () => {
    const p = planProfileSync(disc(), harm(), all)
    expect(p.fields.map(f => f.field)).toEqual(['name', 'icon', 'banner', 'description'])
    expect(p.body).toBeNull()
  })
})

describe('profile lines', () => {
  it('lines truncate a long description to 80 chars with …', () => {
    const long = 'x'.repeat(200)
    const p = planProfileSync(disc({ features: ['COMMUNITY'], description: long }), harm({ description: 'short' }), only('description'))
    expect(profilePlanLines(p)[0]).toBe(`• Description: "short" → "${'x'.repeat(79)}…"`)
    expect(profilePlanLines(planProfileSync(disc({ features: ['COMMUNITY'], description: 'd' }), harm(), only('description')))[0]).toBe('• Description: "(none)" → "d"')
  })

  it('clear lines carry the warning', () => {
    const p = planProfileSync(disc({ features: ['COMMUNITY'] }), harm({ icon: 'i', icon_path: 'i', description: 'd' }), all)
    expect(profilePlanLines(p)).toEqual([
      "⚠️ Harmony's icon will be removed (Discord has none)",
      "⚠️ Harmony's description will be removed (Discord has none)",
    ])
  })

  it('formats name, set and replace lines', () => {
    const p = planProfileSync(disc({ name: 'New', icon: 'a', features: ['BANNER'], banner: 'b' }), harm({ name: 'Old', banner: 'x' }), all)
    expect(profilePlanLines(p)).toEqual([
      '• Name: "Old" → "New"',
      '• Icon: set from Discord',
      "• Banner: Harmony's will be replaced with Discord's",
    ])
  })

  it('skip lines explain unavailable fields', () => {
    const p = planProfileSync(disc(), harm(), all)
    expect(profileSkipLines(p)).toEqual([
      "Banner skipped: this Discord server can't have a banner (boost level 2)",
      'Description skipped: only Community servers have one on Discord',
    ])
  })
})
