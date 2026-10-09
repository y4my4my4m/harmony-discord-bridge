import {
  Client as DiscordClient,
  SlashCommandBuilder,
  Routes,
  MessageFlags,
  PermissionFlagsBits,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Interaction,
  type Role as DiscordRole,
} from 'discord.js'
import type { BridgeRuntime, CachedHarmonyUser } from './BridgeRuntime.js'
import { directionLabel, type NewPair, type PairDirection } from './PairDirectory.js'
import { joinLinesWithinDiscordLimit } from '../utils/discordMessage.js'
import {
  discordRoleToHarmonyPermissions,
  discordColorToHex,
} from '../utils/discordPermissions.js'
import { buildDiscordStructurePlan, syncDiscordStructureOrderToHarmony } from '../discordChannelOrder.js'
import {
  formatHarmonyUserAutocompleteLabel,
  formatHarmonyUserHandle,
} from '../utils/discordDisplayName.js'
import { describeProblem } from '../problems.js'
import { DiscordAuthorLimiter } from './antiSpam.js'
import { memberJoinedAt } from '../utils/discordUserMetadata.js'
import { isAutomodBlocked } from '../HarmonyClient.js'
import { errorText } from '../log.js'

// =============================================================================
// Command definitions
// =============================================================================

function addUserOptions(builder: SlashCommandBuilder) {
  builder.addStringOption(option =>
    option.setName('user').setDescription('Harmony user to mention').setRequired(true).setAutocomplete(true))
  builder.addStringOption(option =>
    option.setName('message').setDescription('Your message').setRequired(false))
  for (const name of ['user2', 'user3', 'user4', 'user5']) {
    builder.addStringOption(option =>
      option.setName(name).setDescription('Additional user to mention').setRequired(false).setAutocomplete(true))
  }
  return builder
}

/**
 * `/mention`, `/m`, `/bridge`. `/bridge` is visible to Administrators only
 * and the handler checks the permission again. v1 keeps its original
 * `link` options; v2 links by Harmony channel autocomplete and direction.
 */
export function buildCommands(mode: 'v1' | 'v2') {
  const bridgeCommand = new SlashCommandBuilder()
    .setName('bridge')
    .setDescription('Manage the Harmony bridge for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub.setName('status').setDescription('Show bridged channels and any problems'))

  if (mode === 'v1') {
    bridgeCommand.addSubcommand(sub =>
      sub
        .setName('link')
        .setDescription('Bridge this Discord channel to a Harmony channel')
        .addStringOption(opt =>
          opt.setName('harmony_channel_id').setDescription('Harmony channel UUID').setRequired(true))
        .addBooleanOption(opt =>
          opt.setName('bidirectional')
            .setDescription('Mirror Harmony messages back to Discord too (default: yes)')
            .setRequired(false)))
  } else {
    bridgeCommand.addSubcommand(sub =>
      sub
        .setName('link')
        .setDescription('Bridge this Discord channel to a Harmony channel')
        .addStringOption(opt =>
          opt.setName('harmony_channel')
            .setDescription('Harmony channel')
            .setRequired(true)
            .setAutocomplete(true))
        .addStringOption(opt =>
          opt.setName('direction')
            .setDescription('Which way messages flow (default: both ways)')
            .setRequired(false)
            .addChoices(
              { name: 'Both ways', value: 'both' },
              { name: 'Discord → Harmony only', value: 'to_harmony' },
              { name: 'Harmony → Discord only', value: 'to_discord' },
            )))
  }

  bridgeCommand
    .addSubcommand(sub => sub.setName('unlink').setDescription('Stop bridging this Discord channel'))
    .addSubcommand(sub =>
      sub
        .setName('clone-server')
        .setDescription('Mirror every Discord channel into Harmony (additive - never overwrites)')
        .addBooleanOption(opt =>
          opt.setName('dry_run').setDescription('Show what would be created without making changes').setRequired(false))
        .addBooleanOption(opt =>
          opt.setName('include_voice').setDescription('Also mirror voice channels (default: yes)').setRequired(false))
        .addBooleanOption(opt =>
          opt.setName('clone_roles').setDescription('Also recreate Discord roles on Harmony (default: bridge setting)').setRequired(false)))
    .addSubcommand(sub =>
      sub
        .setName('sync-order')
        .setDescription('Sync Harmony category/channel order from Discord (mapped channels only)')
        .addBooleanOption(opt =>
          opt.setName('include_voice').setDescription('Include voice channels when syncing order (default: yes)').setRequired(false)))
    .addSubcommand(sub =>
      sub
        .setName('sync-perms')
        .setDescription('Sync Discord roles and channel permissions onto Harmony (linked channels only)'))

  // Harmony accepts emoji imports only from the bot of a server's discord_bridges row, which
  // v1 (YAML-configured) bridges lack.
  if (mode === 'v2') {
    bridgeCommand.addSubcommand(sub =>
      sub
        .setName('import-emojis')
        .setDescription('Copy this server\'s custom emojis into the Harmony server (rerun adds only new ones)')
        .addBooleanOption(opt =>
          opt.setName('dry_run').setDescription('List what would be imported without changes').setRequired(false)))
  }

  return [
    addUserOptions(new SlashCommandBuilder()
      .setName('mention')
      .setDescription('Mention Harmony user(s) with a message (visible in Discord + Harmony)')),
    addUserOptions(new SlashCommandBuilder()
      .setName('m')
      .setDescription('Quick mention a Harmony user with a message')),
    bridgeCommand,
  ].map(cmd => cmd.toJSON())
}

export async function registerSlashCommands(rt: BridgeRuntime, client: DiscordClient, guildId: string) {
  const applicationId = client.application?.id ?? client.user?.id
  if (!applicationId) throw new Error('Discord client has no application id yet')
  await client.rest.put(Routes.applicationGuildCommands(applicationId, guildId), {
    body: buildCommands(rt.mode),
  })
  rt.log.info(`Slash commands registered in guild ${guildId}: /mention, /m, /bridge`)
}

// =============================================================================
// Dispatch
// =============================================================================

export async function handleInteraction(rt: BridgeRuntime, interaction: Interaction) {
  if (interaction.isAutocomplete()) {
    await handleAutocomplete(rt, interaction)
    return
  }
  if (!interaction.isChatInputCommand()) return

  if (interaction.commandName === 'mention' || interaction.commandName === 'm') {
    await handleMention(rt, interaction)
  } else if (interaction.commandName === 'bridge') {
    await handleBridgeCommand(rt, interaction)
  }
}

async function handleAutocomplete(rt: BridgeRuntime, autocomplete: AutocompleteInteraction) {
  const focused = autocomplete.options.getFocused(true)

  if (focused.name.startsWith('user')) {
    const guildId = autocomplete.guildId ?? undefined
    const matches = rt.searchHarmonyUsers(focused.value, guildId)
    await autocomplete.respond(
      matches.map(user => ({
        name: formatHarmonyUserAutocompleteLabel(user.displayName, user.username, user.domain, user.isLocal),
        value: user.id,
      })),
    )
    return
  }

  if (focused.name === 'harmony_channel') {
    const query = focused.value.toLowerCase()
    const paired = new Set(rt.dir.getAllMappings().map(m => m.harmony))
    const options = (rt.hooks.harmonyChannels?.() ?? [])
      .filter(c => c.type === undefined || c.type === 0 || c.type === 'text')
      .filter(c => !paired.has(c.id))
      .filter(c => !query || c.name.toLowerCase().includes(query) || (c.category ?? '').toLowerCase().includes(query))
      .slice(0, 25)
      .map(c => {
        const label = c.category ? `#${c.name} (${c.category})` : `#${c.name}`
        return { name: label.length > 100 ? `${label.slice(0, 97)}...` : label, value: c.id }
      })
    await autocomplete.respond(options)
  }
}

// =============================================================================
// /mention, /m
// =============================================================================

async function handleMention(rt: BridgeRuntime, command: ChatInputCommandInteraction) {
  const userIds = [
    command.options.getString('user', true),
    command.options.getString('user2', false),
    command.options.getString('user3', false),
    command.options.getString('user4', false),
    command.options.getString('user5', false),
  ].filter(Boolean) as string[]

  const message = command.options.getString('message', false) || ''
  rt.log.debug(`/mention: users=${userIds.length}, message="${message}"`)

  const harmonyChannelId = rt.dir.getHarmonyChannel(command.channelId)
  if (!harmonyChannelId || !rt.dir.shouldBridgeFromDiscord(command.channelId)) {
    await command.reply({
      content: '❌ This channel is not bridged to Harmony.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const verdict = rt.antiSpam.check(command.user.id, command.channelId, DiscordAuthorLimiter.contentKey(message, userIds))
  if (verdict !== 'ok') {
    rt.noteSpamDrop(verdict, command.channelId)
    await command.reply({
      content: verdict === 'duplicate' ? '⏳ You just sent that.' : '⏳ Slow down: too many messages to Harmony.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const contentParts: any[] = []
  const mentionedUsers: CachedHarmonyUser[] = []
  const harmonyUsersForGuild = command.guildId
    ? rt.getHarmonyUserCacheForGuild(command.guildId)
    : new Map<string, CachedHarmonyUser>()

  for (const userId of userIds) {
    const harmonyUser = harmonyUsersForGuild.get(userId)
    if (harmonyUser) {
      contentParts.push(rt.harmonyUserToMentionPart(harmonyUser))
      mentionedUsers.push(harmonyUser)
    }
  }

  if (mentionedUsers.length > 0 && message) {
    contentParts.push({ type: 'text', text: ' ' })
  }

  // Discord custom emoji <a?:name:id> become Harmony emoji parts.
  if (message) {
    const emojiRegex = /<(a?):(\w+):(\d+)>/g
    let lastIndex = 0
    let match

    while ((match = emojiRegex.exec(message)) !== null) {
      if (match.index > lastIndex) {
        contentParts.push({ type: 'text', text: message.substring(lastIndex, match.index) })
      }
      const isAnimated = match[1] === 'a'
      contentParts.push({
        type: 'emoji',
        emoji: {
          name: match[2],
          url: `https://cdn.discordapp.com/emojis/${match[3]}.${isAnimated ? 'gif' : 'png'}`,
          id: null,
          domain: 'discord.com',
          display_name: match[2],
        },
      })
      lastIndex = emojiRegex.lastIndex
    }

    if (lastIndex < message.length) {
      contentParts.push({ type: 'text', text: message.substring(lastIndex) })
    } else if (lastIndex === 0) {
      contentParts.push({ type: 'text', text: message })
    }
  }

  const member = command.member as GuildMember
  const discordMetadata = {
    discord_user: {
      id: command.user.id,
      username: command.user.username,
      discriminator: command.user.discriminator,
      display_name: member?.displayName || command.user.username,
      avatar_url: command.user.displayAvatarURL({ size: 256 }),
      ...(memberJoinedAt(command.member) ? { joined_at: memberJoinedAt(command.member) } : {}),
    },
    bridge_source: 'discord',
  }

  await command.deferReply()

  try {
    const result = await rt.harmony.sendMessage(harmonyChannelId, contentParts, discordMetadata)
    const harmonyMessageId = result?.id ?? result?.message?.id

    const mentionDisplay = mentionedUsers
      .map(u => formatHarmonyUserHandle(u.username, u.domain, u.isLocal))
      .join(' ')
    const discordDisplayText = message ? `${mentionDisplay} ${message}`.trim() : mentionDisplay

    const replyMsg = await command.editReply({ content: discordDisplayText || '✅ Sent to Harmony' })
    rt.log.info(`/mention → Harmony ${harmonyMessageId ?? '?'} (channel ${command.channelId})`)

    // Slash reply ↔ Harmony message, for reply threading.
    const discordMessageId = typeof replyMsg === 'object' && replyMsg && 'id' in replyMsg ? replyMsg.id : null
    if (harmonyMessageId && discordMessageId) {
      rt.discordToHarmonyMessages.set(discordMessageId, harmonyMessageId)
      rt.harmonyToDiscordMessages.set(harmonyMessageId, discordMessageId)
    }
  } catch (error) {
    if (isAutomodBlocked(error)) {
      rt.noteAutomodBlock(command.channelId)
      await command.editReply({ content: '❌ Harmony\'s AutoMod blocked this message.' }).catch(() => {})
      return
    }
    rt.log.error(`/mention failed: ${errorText(error)}`)
    await command.editReply({ content: `❌ Failed to send: ${errorText(error)}` }).catch(() => {})
  }
}

// =============================================================================
// /bridge
// =============================================================================
// Gate: Discord Administrator. The Harmony side is enforced by the bridge
// bot's permissions on its server; there is no cross-platform account link.

function notBridgedText(rt: BridgeRuntime): string {
  return rt.mode === 'v1'
    ? '❌ This Discord server is not configured in bridge-config.yml (`bridges[]`).'
    : '❌ This Discord server is not the one chosen for this bridge. Pick it in Harmony → Server Settings → Discord Bridge.'
}

async function handleBridgeCommand(rt: BridgeRuntime, command: ChatInputCommandInteraction) {
  const guild = command.guild
  if (!guild) {
    await command.reply({ content: '❌ This command can only be used in a server.', flags: MessageFlags.Ephemeral })
    return
  }

  const member = command.member
  if (!member) {
    await command.reply({ content: '❌ Could not verify your permissions.', flags: MessageFlags.Ephemeral })
    return
  }
  const perms = member.permissions
  const isAdmin = typeof perms === 'string'
    ? (BigInt(perms) & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator
    : perms.has(PermissionFlagsBits.Administrator)
  if (!isAdmin) {
    await command.reply({
      content: '❌ You need the **Administrator** permission to manage the bridge.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const sub = command.options.getSubcommand(true)

  // v2 status works before a guild is chosen; it explains what is missing.
  const statusWithoutScope = rt.mode === 'v2' && sub === 'status'
  if (!statusWithoutScope && !rt.dir.getBridgeForDiscordGuild(guild.id)) {
    await command.reply({ content: notBridgedText(rt), flags: MessageFlags.Ephemeral })
    return
  }

  try {
    switch (sub) {
      case 'status':
        await runBridgeStatus(rt, command)
        break
      case 'link':
        await runBridgeLink(rt, command)
        break
      case 'unlink':
        await runBridgeUnlink(rt, command)
        break
      case 'clone-server':
        await runBridgeCloneServer(rt, command)
        break
      case 'sync-order':
        await runBridgeSyncOrder(rt, command)
        break
      case 'sync-perms':
        await runBridgeSyncPerms(rt, command)
        break
      case 'import-emojis':
        await runBridgeImportEmojis(rt, command)
        break
      default:
        await command.reply({ content: `❌ Unknown subcommand: ${sub}`, flags: MessageFlags.Ephemeral })
    }
  } catch (err) {
    rt.log.error(`/bridge ${sub} failed: ${errorText(err)}`)
    const msg = `❌ \`/bridge ${sub}\` failed: ${errorText(err) || 'unknown error'}`
    if (command.deferred || command.replied) {
      await command.followUp({ content: msg, flags: MessageFlags.Ephemeral })
    } else {
      await command.reply({ content: msg, flags: MessageFlags.Ephemeral })
    }
  }
}

function harmonyChannelName(rt: BridgeRuntime, harmonyChannelId: string, fallback?: string): string {
  const known = rt.hooks.harmonyChannels?.().find(c => c.id === harmonyChannelId)
  if (known) return `#${known.name}`
  if (fallback) return `#${fallback}`
  return `\`${harmonyChannelId.slice(0, 8)}...\``
}

async function runBridgeStatus(rt: BridgeRuntime, command: ChatInputCommandInteraction) {
  const guildId = command.guildId!
  const bridge = rt.dir.getBridgeForDiscordGuild(guildId)
  const mappings = rt.dir.getAllMappings(guildId)
  const lines: string[] = []

  if (rt.mode === 'v1') {
    lines.push(`**Bridge status** - ${mappings.length} mapping${mappings.length === 1 ? '' : 's'}`)
    lines.push(`Harmony server: \`${bridge?.harmonyServerId || '(not configured)'}\``)
    lines.push('')
    if (mappings.length === 0) {
      lines.push('_No channels are currently bridged. Use_ `/bridge clone-server` _or_ `/bridge link`.')
    } else {
      for (const m of mappings.slice(0, 25)) {
        lines.push(`• <#${m.discord}> ↔ \`${m.harmony.slice(0, 8)}...\` _(${directionLabel(m.direction, m.bidirectional)})_`)
      }
      if (mappings.length > 25) lines.push(`_...and ${mappings.length - 25} more_`)
    }
  } else {
    lines.push('**Bridge status**')
    lines.push(`Discord: ${rt.isDiscordConnected() ? 'connected' : 'not connected'} · Harmony: ${rt.isHarmonyConnected() ? 'connected' : 'not connected'}`)
    if (!bridge) {
      lines.push('_This Discord server is not the one chosen for this bridge in Harmony._')
    }
    lines.push('')
    if (mappings.length === 0) {
      lines.push('_No channels are bridged yet. Use_ `/bridge link` _in a channel, or pair channels in Harmony → Server Settings → Discord Bridge._')
    } else {
      lines.push(`Bridged channels (${mappings.length}):`)
      for (const m of mappings.slice(0, 25)) {
        lines.push(`• <#${m.discord}> ↔ ${harmonyChannelName(rt, m.harmony, m.name)} _(${directionLabel(m.direction, m.bidirectional)})_`)
      }
      if (mappings.length > 25) lines.push(`_...and ${mappings.length - 25} more_`)
    }
    lines.push('')
    const problems = rt.hooks.problems?.() ?? []
    if (problems.length === 0) {
      lines.push('✅ No problems detected.')
    } else {
      lines.push(`⚠️ ${problems.length} problem${problems.length === 1 ? '' : 's'}:`)
      for (const p of problems) {
        const { summary, fix } = describeProblem(p)
        lines.push(`• ${summary} ${fix}`)
      }
    }
  }

  await command.reply({ content: joinLinesWithinDiscordLimit(lines), flags: MessageFlags.Ephemeral })
}

async function runBridgeLink(rt: BridgeRuntime, command: ChatInputCommandInteraction) {
  const guildId = command.guildId!
  const bridge = rt.dir.getBridgeForDiscordGuild(guildId)
  if (!bridge) {
    await command.reply({ content: notBridgedText(rt), flags: MessageFlags.Ephemeral })
    return
  }

  const discordChannelId = command.channelId
  const existingHarmony = rt.dir.getHarmonyChannel(discordChannelId)
  if (existingHarmony) {
    await command.reply({
      content: `❌ This Discord channel is already bridged to ${harmonyChannelName(rt, existingHarmony)}. Run \`/bridge unlink\` first.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  let harmonyChannelId: string
  let direction: PairDirection
  if (rt.mode === 'v1') {
    harmonyChannelId = command.options.getString('harmony_channel_id', true).trim()
    direction = (command.options.getBoolean('bidirectional', false) ?? true) ? 'both' : 'to_harmony'
  } else {
    harmonyChannelId = command.options.getString('harmony_channel', true).trim()
    const raw = command.options.getString('direction', false)
    direction = raw === 'to_harmony' || raw === 'to_discord' ? raw : 'both'
  }

  // The Harmony channel must exist on the bridged server.
  const known = rt.hooks.harmonyChannels?.()
  if (known && known.length > 0) {
    if (!known.some(c => c.id === harmonyChannelId)) {
      await command.reply({
        content: '❌ Pick a Harmony channel from the list (it must belong to the bridged Harmony server).',
        flags: MessageFlags.Ephemeral,
      })
      return
    }
  } else {
    try {
      const channels = await rt.harmony.getServerChannels(bridge.harmonyServerId)
      if (!channels.find((c: any) => c.id === harmonyChannelId)) {
        await command.reply({
          content: `❌ Harmony channel \`${harmonyChannelId}\` not found in the configured server.`,
          flags: MessageFlags.Ephemeral,
        })
        return
      }
    } catch (err) {
      await command.reply({
        content: `❌ Could not verify Harmony channel: ${errorText(err)}`,
        flags: MessageFlags.Ephemeral,
      })
      return
    }
  }

  await command.deferReply({ flags: MessageFlags.Ephemeral })
  const channelName = command.channel && 'name' in command.channel ? command.channel.name ?? undefined : undefined
  try {
    await rt.writer.link(guildId, { discord: discordChannelId, discordName: channelName, harmony: harmonyChannelId, direction })
    await rt.hooks.afterPairsWritten?.()
    await command.editReply({
      content: `✅ Linked <#${discordChannelId}> ↔ ${harmonyChannelName(rt, harmonyChannelId)} (${directionLabel(direction, direction === 'both')}).`,
    })
  } catch (err) {
    await command.editReply({ content: `❌ Failed to link: ${errorText(err)}` })
  }
}

async function runBridgeUnlink(rt: BridgeRuntime, command: ChatInputCommandInteraction) {
  const discordChannelId = command.channelId
  if (!rt.dir.getHarmonyChannel(discordChannelId)) {
    await command.reply({ content: '❌ This Discord channel isn\'t bridged.', flags: MessageFlags.Ephemeral })
    return
  }
  await command.deferReply({ flags: MessageFlags.Ephemeral })
  const removed = await rt.writer.unlink(discordChannelId)
  if (removed) await rt.hooks.afterPairsWritten?.()
  await command.editReply({ content: removed ? `✅ Unlinked <#${discordChannelId}>.` : '❌ Nothing was removed.' })
}

/** Non-@everyone, non-managed Discord roles, highest first. */
function cloneableDiscordRoles(guild: { roles: { cache: Map<string, DiscordRole> } }): DiscordRole[] {
  return Array.from(guild.roles.cache.values())
    .filter(r => r.name !== '@everyone' && !r.managed)
    .sort((a, b) => b.position - a.position)
}

/**
 * `/bridge clone-server`: mirror every text/voice Discord channel (under its
 * category) into Harmony and pair them. Additive: existing pairs stay,
 * Harmony channels with the same name are reused. With clone_roles, Discord
 * roles are recreated (matched by name) with mapped permissions.
 * The Harmony bot needs manage_channels; the gateway enforces it.
 */
async function runBridgeCloneServer(rt: BridgeRuntime, command: ChatInputCommandInteraction) {
  const dryRun = command.options.getBoolean('dry_run', false) ?? false
  const includeVoice = command.options.getBoolean('include_voice', false) ?? true
  const cloneRoles = command.options.getBoolean('clone_roles', false) ?? rt.settings().cloneRoles

  await command.deferReply({ flags: MessageFlags.Ephemeral })

  const guild = command.guild!
  const bridge = rt.dir.getBridgeForDiscordGuild(guild.id)
  if (!bridge) {
    await command.editReply({ content: notBridgedText(rt) })
    return
  }
  const harmonyServerId = bridge.harmonyServerId

  await guild.channels.fetch()

  const { categories: discordCategories, channels: planned } = buildDiscordStructurePlan(guild, includeVoice)

  const alreadyMapped = new Set(rt.dir.getAllMappings(guild.id).map(m => m.discord))
  const toCreate = planned.filter(p => !alreadyMapped.has(p.discordId))

  let rolesToClone: DiscordRole[] = []
  if (cloneRoles) {
    const existingRoles = await rt.harmony.getServerRoles(harmonyServerId).catch(() => [])
    const existingRoleNames = new Set(existingRoles.map((r: any) => r.name))
    rolesToClone = cloneableDiscordRoles(guild).filter(r => !existingRoleNames.has(r.name))
  }

  if (toCreate.length === 0 && rolesToClone.length === 0) {
    await command.editReply({
      content: cloneRoles
        ? '✅ Nothing to do - every Discord channel and role already exists on Harmony. `/bridge sync-perms` re-applies permissions.'
        : '✅ Nothing to do - every Discord channel already has a mapping.',
    })
    return
  }

  const harmonyCategories = await rt.harmony.getServerCategories(harmonyServerId).catch(() => [])
  const categoryIdByName = new Map<string, string>(
    harmonyCategories.map((c: any) => [c.name as string, c.id as string]),
  )
  const harmonyChannels = await rt.harmony.getServerChannels(harmonyServerId).catch(() => [])
  const harmonyChannelByName = new Map<string, any>()
  for (const c of harmonyChannels) harmonyChannelByName.set(c.name, c)

  if (dryRun) {
    const lines: string[] = [`**Dry run** - ${toCreate.length} channel(s) would be processed:`]
    const categoriesNeeded = new Set<string>()
    for (const p of toCreate) {
      const reuse = harmonyChannelByName.get(p.name)
      const action = reuse ? `reuse Harmony \`${reuse.id.slice(0, 8)}...\`` : 'create Harmony channel'
      const cat = p.discordCategoryName ? `under category **${p.discordCategoryName}**` : ''
      if (p.discordCategoryName && !categoryIdByName.has(p.discordCategoryName)) {
        categoriesNeeded.add(p.discordCategoryName)
      }
      lines.push(`• \`#${p.name}\` (order ${p.position}) → ${action} ${cat}`.trimEnd())
    }
    if (categoriesNeeded.size > 0) {
      lines.splice(1, 0,
        `_Would also create ${categoriesNeeded.size} categor${categoriesNeeded.size === 1 ? 'y' : 'ies'}: ${Array.from(categoriesNeeded).map(n => `**${n}**`).join(', ')}_`)
    }
    if (cloneRoles) {
      lines.push(rolesToClone.length > 0
        ? `_Would also create ${rolesToClone.length} role(s): ${rolesToClone.map(r => `**${r.name}**`).join(', ')}_`
        : '_Roles: all Discord roles already exist on Harmony (by name)._')
    }
    await command.editReply({ content: joinLinesWithinDiscordLimit(lines) })
    return
  }

  // Serial: one request at a time against the gateway.
  let created = 0
  let reused = 0
  let categoriesCreated = 0
  let categoriesOrderUpdated = 0
  const failures: string[] = []
  const newPairs: NewPair[] = []

  for (const cat of discordCategories) {
    try {
      const existing = categoryIdByName.get(cat.name)
      if (existing) {
        await rt.harmony.updateCategory(harmonyServerId, existing, { order: cat.position })
        categoriesOrderUpdated++
      } else {
        const newCat = await rt.harmony.createCategory(harmonyServerId, cat.name, cat.position)
        if (newCat.id) categoryIdByName.set(cat.name, newCat.id)
        categoriesCreated++
      }
    } catch (err) {
      failures.push(`category \`${cat.name}\`: ${errorText(err)}`)
    }
  }

  for (const p of toCreate) {
    try {
      const harmonyCategoryId = p.discordCategoryName ? categoryIdByName.get(p.discordCategoryName) ?? null : null
      let harmonyChannelId: string
      const reuse = harmonyChannelByName.get(p.name)
      if (reuse) {
        harmonyChannelId = reuse.id
        reused++
      } else {
        const newCh = await rt.harmony.createChannel(harmonyServerId, {
          name: p.name,
          type: p.harmonyType,
          categoryId: harmonyCategoryId,
          order: p.position,
        })
        harmonyChannelId = newCh.id
        created++
      }
      newPairs.push({ discord: p.discordId, discordName: p.name, harmony: harmonyChannelId, direction: 'both', name: p.name })
    } catch (err) {
      failures.push(`\`#${p.name}\`: ${errorText(err)}`)
    }
  }

  let added: NewPair[] = []
  try {
    added = await rt.writer.linkMany(guild.id, newPairs)
    await rt.hooks.afterPairsWritten?.()
  } catch (err) {
    failures.push(`pairing: ${errorText(err)}`)
  }

  let rolesCreated = 0
  if (cloneRoles) {
    for (const role of rolesToClone) {
      try {
        const createdRole = await rt.harmony.createRole(harmonyServerId, {
          name: role.name,
          color: discordColorToHex(role.color),
          position: role.position,
          permissions: discordRoleToHarmonyPermissions(role),
          mentionable: role.mentionable,
          hoist: role.hoist,
        })
        rt.permissionSyncStore.setMapping(role.id, createdRole.id, role.name)
        rolesCreated++
      } catch (err) {
        failures.push(`role \`${role.name}\`: ${errorText(err)}`)
      }
    }
    try {
      await rt.permissionSync.reconcileRoles(guild)
      await rt.permissionSync.syncAllMappedChannelOverwrites(guild)
    } catch (err) {
      failures.push(`permission sync: ${errorText(err)}`)
    }
  }

  let orderSync = { categoriesUpdated: 0, channelsUpdated: 0, failures: [] as string[] }
  try {
    orderSync = await syncDiscordStructureOrderToHarmony({
      guild,
      serverId: harmonyServerId,
      harmonyClient: rt.harmony,
      getHarmonyChannelId: (discordId) => rt.dir.getHarmonyChannel(discordId),
      includeVoice,
    })
    failures.push(...orderSync.failures)
  } catch (err) {
    failures.push(`order sync: ${errorText(err)}`)
  }

  const summary: string[] = [
    `✅ Clone complete for **${guild.name}**`,
    `• Channels created: ${created}`,
    `• Channels reused (matched by name): ${reused}`,
    `• Categories created: ${categoriesCreated}`,
    `• Category orders updated: ${categoriesOrderUpdated}`,
    `• Mappings written: ${added.length}`,
    `• Order synced: ${orderSync.categoriesUpdated} categor${orderSync.categoriesUpdated === 1 ? 'y' : 'ies'}, ${orderSync.channelsUpdated} channel(s)`,
  ]
  if (cloneRoles) summary.push(`• Roles created: ${rolesCreated}`)
  if (failures.length) {
    summary.push('', `⚠️ ${failures.length} failure(s):`, ...failures.map(f => `  • ${f}`))
  }

  await command.editReply({ content: joinLinesWithinDiscordLimit(summary) })
}

/**
 * `/bridge sync-order`: Harmony category/channel order and parent categories
 * from Discord, for paired channels.
 */
async function runBridgeSyncOrder(rt: BridgeRuntime, command: ChatInputCommandInteraction) {
  const includeVoice = command.options.getBoolean('include_voice', false) ?? true

  await command.deferReply({ flags: MessageFlags.Ephemeral })

  const guild = command.guild!
  const bridge = rt.dir.getBridgeForDiscordGuild(guild.id)
  if (!bridge) {
    await command.editReply({ content: notBridgedText(rt) })
    return
  }

  await guild.channels.fetch()

  if (rt.dir.getAllMappings(guild.id).length === 0) {
    await command.editReply({
      content: '❌ No channel mappings configured. Run `/bridge clone-server` or `/bridge link` first.',
    })
    return
  }

  try {
    const result = await syncDiscordStructureOrderToHarmony({
      guild,
      serverId: bridge.harmonyServerId,
      harmonyClient: rt.harmony,
      getHarmonyChannelId: (discordId) => rt.dir.getHarmonyChannel(discordId),
      includeVoice,
    })

    const lines = [
      `✅ Order sync complete for **${guild.name}**`,
      `• Categories updated: ${result.categoriesUpdated}`,
      `• Mapped channels updated: ${result.channelsUpdated}`,
    ]
    if (result.failures.length > 0) {
      lines.push('', `⚠️ ${result.failures.length} failure(s):`)
      lines.push(...result.failures.slice(0, 15).map(f => `  • ${f}`))
      if (result.failures.length > 15) lines.push(`  • …and ${result.failures.length - 15} more`)
    }
    await command.editReply({ content: joinLinesWithinDiscordLimit(lines) })
  } catch (err) {
    await command.editReply({ content: `❌ Order sync failed: ${errorText(err)}` })
  }
}

/**
 * `/bridge sync-perms`: Discord roles onto Harmony roles (by mapping, then name; missing ones
 * created), then every linked channel's permission overwrites. Channels are not created.
 */
async function runBridgeSyncPerms(rt: BridgeRuntime, command: ChatInputCommandInteraction) {
  await command.deferReply({ flags: MessageFlags.Ephemeral })

  const guild = command.guild!
  const bridge = rt.dir.getBridgeForDiscordGuild(guild.id)
  if (!bridge) {
    await command.editReply({ content: notBridgedText(rt) })
    return
  }
  const linked = rt.dir.getAllMappings(guild.id).length
  if (linked === 0) {
    await command.editReply({
      content: '❌ No channel mappings configured. Run `/bridge clone-server` or `/bridge link` first.',
    })
    return
  }

  try {
    await guild.roles.fetch()
    await rt.permissionSync.reconcileRoles(guild)
    await rt.permissionSync.syncAllMappedChannelOverwrites(guild)
    const roles = cloneableDiscordRoles(guild).length
    await command.editReply({
      content: [
        `✅ Permissions synced for **${guild.name}**`,
        `• Roles: ${roles} Discord role(s) matched or created on Harmony`,
        `• Channels: overwrites applied to ${linked} linked channel(s)`,
        '_Roles Harmony refuses (above the bot, or protected) are skipped; see `/bridge status` and the bridge log._',
      ].join('\n'),
    })
  } catch (err) {
    await command.editReply({ content: `❌ Permission sync failed: ${errorText(err)}` })
  }
}

/** Discord emoji imported per call; Harmony stores each image, so a run is bounded. */
const EMOJI_IMPORT_LIMIT = 250

/**
 * `/bridge import-emojis`: the guild's custom emoji become Harmony server emoji with the same
 * names. Harmony keeps one row per Discord emoji, so a rerun imports only new ones; a server
 * emoji with the same name is linked instead of duplicated. Linked emoji are one emoji on both
 * sides for reactions and messages.
 */
async function runBridgeImportEmojis(rt: BridgeRuntime, command: ChatInputCommandInteraction) {
  const dryRun = command.options.getBoolean('dry_run', false) ?? false
  await command.deferReply({ flags: MessageFlags.Ephemeral })

  const guild = command.guild!
  const bridge = rt.dir.getBridgeForDiscordGuild(guild.id)
  if (!bridge) {
    await command.editReply({ content: notBridgedText(rt) })
    return
  }
  const serverId = bridge.harmonyServerId

  const emojis = [...(await guild.emojis.fetch()).values()]
    .filter(e => !!e.id && !!e.name && e.available !== false)
    .slice(0, EMOJI_IMPORT_LIMIT)
  if (emojis.length === 0) {
    await command.editReply({ content: '✅ This Discord server has no custom emojis.' })
    return
  }

  await rt.emojiLinks.ensure(serverId)
  const fresh = emojis.filter(e => !rt.emojiLinks.harmonyFor(serverId, e.id))
  if (dryRun) {
    await command.editReply({
      content: joinLinesWithinDiscordLimit([
        `🧪 **Dry run** for **${guild.name}**: ${fresh.length} of ${emojis.length} emoji not imported yet`,
        ...fresh.slice(0, 40).map(e => `  • :${e.name}:`),
        ...(fresh.length > 40 ? [`  • …and ${fresh.length - 40} more`] : []),
      ]),
    })
    return
  }

  const counts = { created: 0, linked: 0, existing: emojis.length - fresh.length }
  const failures: string[] = []
  for (const emoji of fresh) {
    try {
      const row = await rt.harmony.importDiscordEmoji(serverId, {
        discordEmojiId: emoji.id,
        name: emoji.name!.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32),
        animated: emoji.animated === true,
      })
      rt.emojiLinks.set(serverId, row)
      counts[row.status]++
    } catch (err) {
      failures.push(`:${emoji.name}: ${errorText(err)}`)
    }
  }

  const lines = [
    `✅ Emoji import for **${guild.name}**`,
    `• Imported: ${counts.created}`,
    `• Linked to a Harmony emoji with the same name: ${counts.linked}`,
    `• Already imported: ${counts.existing}`,
  ]
  if (failures.length > 0) {
    lines.push('', `⚠️ ${failures.length} failure(s):`, ...failures.slice(0, 15).map(f => `  • ${f}`))
    if (failures.length > 15) lines.push(`  • …and ${failures.length - 15} more`)
  }
  await command.editReply({ content: joinLinesWithinDiscordLimit(lines) })
}
