import {
  Client,
  ChannelType,
  OverwriteType,
  type DMChannel,
  type Guild,
  type Role,
  type NonThreadGuildBasedChannel,
} from 'discord.js'
import { HarmonyClient } from './HarmonyClient.js'
import { ChannelMapper } from './ChannelMapper.js'
import { PermissionSyncStore } from './PermissionSyncStore.js'
import {
  discordRoleToHarmonyPermissions,
  discordColorToHex,
  discordOverwriteToHarmonyMasks,
} from './utils/discordPermissions.js'

/**
 * Live Discord → Harmony permission sync: server roles + channel overrides.
 * Does NOT assign members to roles (no Discord↔Harmony account link).
 */
export class PermissionSync {
  private attached = false

  constructor(
    private harmony: HarmonyClient,
    private discord: Client,
    private mapper: ChannelMapper,
    private store: PermissionSyncStore,
  ) {}

  private harmonyServerIdForGuild(guildId: string): string | null {
    return this.mapper.getBridgeForDiscordGuild(guildId)?.harmonyServerId ?? null
  }

  private requireServerId(guildId: string): string {
    const serverId = this.harmonyServerIdForGuild(guildId)
    if (!serverId) {
      throw new Error(`Discord guild ${guildId} is not configured in bridge-config.yml`)
    }
    return serverId
  }

  private isTrackedGuild(guildId: string): boolean {
    return this.mapper.isConfiguredDiscordGuild(guildId)
  }

  isEnabled(): boolean {
    return this.mapper.getConfig().settings.syncPermissions === true
  }

  attach() {
    if (this.attached || !this.isEnabled()) return
    this.discord.on('roleCreate', this.onRoleCreate)
    this.discord.on('roleUpdate', this.onRoleUpdate)
    this.discord.on('roleDelete', this.onRoleDelete)
    this.discord.on('channelUpdate', this.onChannelUpdate)
    this.attached = true
    console.log('🔐 Permission sync: listening for Discord role/channel changes')
  }

  detach() {
    if (!this.attached) return
    this.discord.off('roleCreate', this.onRoleCreate)
    this.discord.off('roleUpdate', this.onRoleUpdate)
    this.discord.off('roleDelete', this.onRoleDelete)
    this.discord.off('channelUpdate', this.onChannelUpdate)
    this.attached = false
  }

  private isProtectedHarmonyRole(role: { is_default?: boolean; is_admin?: boolean }): boolean {
    return !!(role.is_default || role.is_admin)
  }

  /** Full reconcile on startup (roles by name + all mapped channel overwrites). */
  async initialSync(guild: Guild) {
    if (!this.isEnabled()) return
    console.log('🔐 Permission sync: initial reconcile...')
    await guild.roles.fetch()
    await this.ensureDefaultRoleMapped(guild)
    await this.reconcileRoles(guild)
    await this.syncAllMappedChannelOverwrites(guild)
    console.log('🔐 Permission sync: initial reconcile complete')
  }

  /** After clone-server creates roles, record mappings and sync channel overwrites. */
  async afterClone(guild: Guild, createdRoles: Array<{ discordRole: Role; harmonyRoleId: string }>) {
    for (const { discordRole, harmonyRoleId } of createdRoles) {
      this.store.setMapping(discordRole.id, harmonyRoleId, discordRole.name)
    }
    if (this.isEnabled()) {
      await this.syncAllMappedChannelOverwrites(guild)
    }
  }

  private onRoleCreate = async (role: Role) => {
    if (!this.isEnabled() || !this.isTrackedGuild(role.guild.id)) return
    if (role.managed || role.name === '@everyone') return
    try {
      await this.upsertHarmonyRole(role)
      console.log(`🔐 Synced new Discord role "${role.name}" → Harmony`)
    } catch (err) {
      console.error(`🔐 Failed to sync new role "${role.name}":`, err)
    }
  }

  private onRoleUpdate = async (_oldRole: Role, newRole: Role) => {
    if (!this.isEnabled() || !this.isTrackedGuild(newRole.guild.id)) return
    if (newRole.managed) return
    if (newRole.id === newRole.guild.id) {
      // @everyone base permissions cannot be changed via bot API (default role).
      // Per-channel @everyone overrides are still synced in syncChannelOverwrites.
      return
    }
    try {
      await this.upsertHarmonyRole(newRole)
      console.log(`🔐 Synced role update "${newRole.name}" → Harmony`)
    } catch (err) {
      console.error(`🔐 Failed to sync role update "${newRole.name}":`, err)
    }
  }

  private onRoleDelete = async (role: Role) => {
    if (!this.isEnabled() || !this.isTrackedGuild(role.guild.id)) return
    const harmonyRoleId = this.store.getHarmonyRoleId(role.id)
    if (!harmonyRoleId) return
    try {
      await this.harmony.deleteRole(this.requireServerId(role.guild.id), harmonyRoleId)
      this.store.removeMapping(role.id)
      console.log(`🔐 Deleted Harmony role for removed Discord role "${role.name}"`)
    } catch (err) {
      console.error(`🔐 Failed to delete Harmony role for "${role.name}":`, err)
    }
  }

  private onChannelUpdate = async (
    oldChannel: DMChannel | NonThreadGuildBasedChannel,
    newChannel: DMChannel | NonThreadGuildBasedChannel,
  ) => {
    if (!this.isEnabled()) return
    if (!('guildId' in newChannel) || !newChannel.guildId || !this.isTrackedGuild(newChannel.guildId)) return
    if (
      newChannel.type !== ChannelType.GuildText &&
      newChannel.type !== ChannelType.GuildVoice
    ) {
      return
    }

    const harmonyChannelId = this.mapper.getHarmonyChannel(newChannel.id)
    if (!harmonyChannelId) return

    const oldOw =
      'permissionOverwrites' in oldChannel ? oldChannel.permissionOverwrites?.cache : undefined
    const newOw =
      'permissionOverwrites' in newChannel ? newChannel.permissionOverwrites?.cache : undefined
    if (oldOw && newOw && oldOw.equals(newOw)) return

    try {
      await this.syncChannelOverwrites(newChannel as NonThreadGuildBasedChannel, harmonyChannelId)
      console.log(`🔐 Synced channel overrides for #${newChannel.name}`)
    } catch (err) {
      console.error(`🔐 Failed to sync overrides for #${newChannel.name}:`, err)
    }
  }

  private async ensureDefaultRoleMapped(guild: Guild) {
    if (this.store.getDefaultHarmonyRoleId()) return

    const harmonyRoles = await this.harmony.getServerRoles(this.requireServerId(guild.id))
    const defaultRole = harmonyRoles.find((r: any) => r.is_default)
    if (defaultRole) {
      this.store.setDefaultHarmonyRoleId(defaultRole.id)
    }
  }

  /** Match Discord roles to Harmony roles by stored mapping or by name. */
  async reconcileRoles(guild: Guild): Promise<void> {
    const serverId = this.requireServerId(guild.id)
    const harmonyRoles = await this.harmony.getServerRoles(serverId)
    const harmonyById = new Map(harmonyRoles.map((r: any) => [r.id, r]))
    const harmonyByName = new Map(
      harmonyRoles
        .filter((r: any) => !this.isProtectedHarmonyRole(r))
        .map((r: any) => [r.name, r]),
    )

    for (const role of guild.roles.cache.values()) {
      if (role.managed) continue
      if (role.id === guild.id) continue // @everyone — channel overrides only

      try {
        const existingId = this.store.getHarmonyRoleId(role.id)
        if (existingId) {
          const existing = harmonyById.get(existingId)
          if (existing && this.isProtectedHarmonyRole(existing)) continue

          await this.harmony.updateRole(serverId, existingId, {
            name: role.name,
            color: discordColorToHex(role.color),
            position: role.position,
            permissions: discordRoleToHarmonyPermissions(role),
            mentionable: role.mentionable,
            hoist: role.hoist,
          })
          continue
        }

        const byName = harmonyByName.get(role.name)
        if (byName) {
          this.store.setMapping(role.id, byName.id, role.name)
          await this.harmony.updateRole(serverId, byName.id, {
            color: discordColorToHex(role.color),
            position: role.position,
            permissions: discordRoleToHarmonyPermissions(role),
            mentionable: role.mentionable,
            hoist: role.hoist,
          })
          continue
        }

        const created = await this.harmony.createRole(serverId, {
          name: role.name,
          color: discordColorToHex(role.color),
          position: role.position,
          permissions: discordRoleToHarmonyPermissions(role),
          mentionable: role.mentionable,
          hoist: role.hoist,
        })
        this.store.setMapping(role.id, created.id, role.name)
      } catch (err) {
        console.error(`🔐 Failed to sync role "${role.name}":`, err)
      }
    }
  }

  async upsertHarmonyRole(role: Role): Promise<string> {
    const serverId = this.requireServerId(role.guild.id)
    let harmonyRoleId = this.store.getHarmonyRoleId(role.id)

    if (!harmonyRoleId) {
      const harmonyRoles = await this.harmony.getServerRoles(serverId)
      const byName = harmonyRoles.find(
        (r: any) => r.name === role.name && !this.isProtectedHarmonyRole(r),
      )
      if (byName?.id) {
        harmonyRoleId = byName.id as string
        this.store.setMapping(role.id, harmonyRoleId, role.name)
      }
    }

    const payload = {
      name: role.name,
      color: discordColorToHex(role.color),
      position: role.position,
      permissions: discordRoleToHarmonyPermissions(role),
      mentionable: role.mentionable,
      hoist: role.hoist,
    }

    if (harmonyRoleId) {
      const harmonyRoles = await this.harmony.getServerRoles(serverId)
      const existing = harmonyRoles.find((r: any) => r.id === harmonyRoleId)
      if (existing && this.isProtectedHarmonyRole(existing)) {
        return harmonyRoleId
      }

      await this.harmony.updateRole(serverId, harmonyRoleId, payload)
      return harmonyRoleId
    }

    const created = await this.harmony.createRole(serverId, payload)
    this.store.setMapping(role.id, created.id, role.name)
    return created.id
  }

  async syncAllMappedChannelOverwrites(guild: Guild) {
    for (const mapping of this.mapper.getAllMappings(guild.id)) {
      try {
        const channel = await guild.channels.fetch(mapping.discord)
        if (
          !channel ||
          (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildVoice)
        ) {
          continue
        }
        await this.syncChannelOverwrites(
          channel as NonThreadGuildBasedChannel,
          mapping.harmony,
        )
      } catch (err) {
        console.error(`🔐 Failed overrides for mapping ${mapping.name || mapping.discord}:`, err)
      }
    }
  }

  async syncChannelOverwrites(
    discordChannel: NonThreadGuildBasedChannel,
    harmonyChannelId: string,
  ) {
    const guild = discordChannel.guild
    const refreshed = await guild.channels.fetch(discordChannel.id, { force: true })
    if (
      !refreshed ||
      (refreshed.type !== ChannelType.GuildText && refreshed.type !== ChannelType.GuildVoice)
    ) {
      return
    }
    const channel = refreshed as NonThreadGuildBasedChannel

    const discordRoleIds = new Set<string>()
    for (const overwrite of channel.permissionOverwrites.cache.values()) {
      if (overwrite.type !== OverwriteType.Role) continue // skip member-specific overwrites

      const harmonyRoleId = await this.resolveHarmonyRoleId(guild, overwrite.id)
      if (!harmonyRoleId) continue

      discordRoleIds.add(overwrite.id)
      const { allow, deny } = discordOverwriteToHarmonyMasks(
        overwrite.allow.bitfield,
        overwrite.deny.bitfield,
      )

      if (allow === '0' && deny === '0') {
        await this.harmony.deleteChannelPermissionOverrideForRole(harmonyChannelId, harmonyRoleId)
      } else {
        await this.harmony.upsertChannelPermissionOverride(harmonyChannelId, {
          target_type: 'role',
          role_id: harmonyRoleId,
          allow_permissions: allow,
          deny_permissions: deny,
        })
      }
    }

    // Remove Harmony overrides for roles no longer present on the Discord channel.
    const existing = await this.harmony.getChannelPermissionOverrides(harmonyChannelId)
    for (const row of existing) {
      if (row.target_type !== 'role' || !row.role_id) continue
      const discordRoleId = this.store.getDiscordRoleId(row.role_id)
      if (discordRoleId && !discordRoleIds.has(discordRoleId)) {
        await this.harmony.deleteChannelPermissionOverrideForRole(harmonyChannelId, row.role_id)
      }
    }
  }

  private async resolveHarmonyRoleId(guild: Guild, discordRoleId: string): Promise<string | null> {
    // @everyone uses the guild id as the role snowflake on Discord.
    if (discordRoleId === guild.id) {
      return this.store.getDefaultHarmonyRoleId() ?? null
    }

    let harmonyRoleId = this.store.getHarmonyRoleId(discordRoleId)
    if (harmonyRoleId) return harmonyRoleId

    const discordRole = guild.roles.cache.get(discordRoleId)
    if (!discordRole || discordRole.managed) return null

    harmonyRoleId = await this.upsertHarmonyRole(discordRole)
    return harmonyRoleId
  }
}
