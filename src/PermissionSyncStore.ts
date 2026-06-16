import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { parse, stringify } from 'yaml'

export interface RoleMapping {
  discordRoleId: string
  harmonyRoleId: string
  name: string
}

interface StoreData {
  defaultHarmonyRoleId?: string
  roles: RoleMapping[]
}

/** Persists Discord role ID ↔ Harmony role ID mappings for permission sync. */
export class PermissionSyncStore {
  private path: string
  private data: StoreData

  constructor(path: string = './data/permission-sync.yml') {
    this.path = path
    this.data = this.load()
  }

  private load(): StoreData {
    if (!existsSync(this.path)) {
      return { roles: [] }
    }
    const parsed = parse(readFileSync(this.path, 'utf8')) as StoreData
    return { roles: parsed?.roles ?? [], defaultHarmonyRoleId: parsed?.defaultHarmonyRoleId }
  }

  private save() {
    const dir = dirname(this.path)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(this.path, stringify(this.data), 'utf8')
  }

  getHarmonyRoleId(discordRoleId: string): string | undefined {
    return this.data.roles.find(r => r.discordRoleId === discordRoleId)?.harmonyRoleId
  }

  getDiscordRoleId(harmonyRoleId: string): string | undefined {
    return this.data.roles.find(r => r.harmonyRoleId === harmonyRoleId)?.discordRoleId
  }

  getAll(): RoleMapping[] {
    return [...this.data.roles]
  }

  setMapping(discordRoleId: string, harmonyRoleId: string, name: string) {
    const idx = this.data.roles.findIndex(r => r.discordRoleId === discordRoleId)
    const entry = { discordRoleId, harmonyRoleId, name }
    if (idx >= 0) {
      this.data.roles[idx] = entry
    } else {
      this.data.roles.push(entry)
    }
    this.save()
  }

  removeMapping(discordRoleId: string) {
    this.data.roles = this.data.roles.filter(r => r.discordRoleId !== discordRoleId)
    this.save()
  }

  setDefaultHarmonyRoleId(roleId: string) {
    this.data.defaultHarmonyRoleId = roleId
    this.save()
  }

  getDefaultHarmonyRoleId(): string | undefined {
    return this.data.defaultHarmonyRoleId
  }
}
