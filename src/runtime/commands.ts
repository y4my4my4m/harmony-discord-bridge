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
  type NonThreadGuildBasedChannel,
  type Role as DiscordRole,
} from 'discord.js'
import type { BridgeRuntime, CachedHarmonyUser } from './BridgeRuntime.js'
import { directionLabel, type NewPair, type PairDirection } from './PairDirectory.js'
import { joinLinesWithinDiscordLimit } from '../utils/discordMessage.js'
import { hiddenFromEveryone, type RoleSyncReport } from '../PermissionSync.js'
import { buildDiscordStructurePlan, syncDiscordStructureOrderToHarmony } from '../discordChannelOrder.js'
import {
  formatHarmonyUserAutocompleteLabel,
  formatHarmonyUserHandle,
} from '../utils/discordDisplayName.js'
import { describeProblem } from '../problems.js'
import { DiscordAuthorLimiter } from './antiSpam.js'
import { memberJoinedAt } from '../utils/discordUserMetadata.js'
import { isAutomodBlocked, HarmonyHttpError } from '../HarmonyClient.js'
import { errorText } from '../log.js'
import { confirmAction } from './confirmPrompt.js'
import { CONFLICT_HINT, planSync, syncReportLines, SYNC_MODE_CHOICES, type SyncMode } from './expressionSync.js'
import { byDiscordId, desiredEmoji, emojiDiffers, harmonyEmojiSyncItem, type DesiredEmoji } from './emojiSync.js'
import { desiredSound, harmonySyncItem, soundDiffers, type DesiredSound } from './soundSync.js'

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
    bridgeCommand.addSubcommand(sub =>
      sub
        .setName('sync-emojis')
        .setDescription('Make Harmony\'s emoji match this Discord server')
        .addStringOption(opt =>
          opt.setName('mode')
            .setDescription('How to reconcile (default: mirror)')
            .setRequired(false)
            .addChoices(...SYNC_MODE_CHOICES))
        .addBooleanOption(opt =>
          opt.setName('dry_run').setDescription('Show what would change without making changes').setRequired(false)))
    bridgeCommand.addSubcommand(sub =>
      sub
        .setName('sync-sounds')
        .setDescription('Make the Harmony soundboard match this server\'s (rerun applies changes)')
        .addStringOption(opt =>
          opt.setName('mode')
            .setDescription('How to reconcile (default: mirror)')
            .setRequired(false)
            .addChoices(...SYNC_MODE_CHOICES))
        .addBooleanOption(opt =>
          opt.setName('dry_run').setDescription('Show what would change without making changes').setRequired(false)))
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
        await runBridgeSyncEmojis(rt, command, { mode: 'add' })
        break
      case 'sync-emojis':
        await runBridgeSyncEmojis(rt, command)
        break
      case 'sync-sounds':
        await runBridgeSyncSounds(rt, command)
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
 *
 * A channel hidden from @everyone on Discord is hidden from @everyone on
 * Harmony before it is paired; when that write fails, it stays unpaired.
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
  const discordChannel = (id: string) => guild.channels.cache.get(id) as NonThreadGuildBasedChannel | undefined
  // A channel absent from the cache counts as hidden.
  const isPrivate = (id: string) => {
    const channel = discordChannel(id)
    return !channel || hiddenFromEveryone(channel)
  }

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
      const hidden = isPrivate(p.discordId) ? ', hidden from @everyone' : ''
      lines.push(`• \`#${p.name}\` (order ${p.position}) → ${action} ${cat}`.trimEnd() + hidden)
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

  // Roles precede channels: a channel's overrides are written before it is paired.
  let rolesCreated = 0
  const rolesAdjusted: string[] = []
  if (cloneRoles) {
    for (const role of rolesToClone) {
      try {
        const notes: string[] = []
        await rt.permissionSync.upsertHarmonyRole(role, notes)
        rolesCreated++
        if (notes.length) rolesAdjusted.push(`\`${role.name}\`: ${notes.join('; ')}`)
      } catch (err) {
        failures.push(`role \`${role.name}\`: ${errorText(err)}`)
      }
    }
    try {
      await rt.permissionSync.reconcileRoles(guild)
    } catch (err) {
      failures.push(`permission sync: ${errorText(err)}`)
    }
  }

  let defaultRoleId: string | null = null
  let defaultRoleError = ''
  if (cloneRoles || toCreate.some(p => isPrivate(p.discordId))) {
    try {
      defaultRoleId = await rt.permissionSync.loadDefaultRole(guild.id)
    } catch (err) {
      defaultRoleError = errorText(err)
    }
  }

  let hidden = 0
  for (const p of toCreate) {
    let harmonyChannelId: string
    try {
      const harmonyCategoryId = p.discordCategoryName ? categoryIdByName.get(p.discordCategoryName) ?? null : null
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
    } catch (err) {
      failures.push(`\`#${p.name}\`: ${errorText(err)}`)
      continue
    }

    const channel = discordChannel(p.discordId)
    if (cloneRoles && channel) {
      try {
        await rt.permissionSync.syncChannelOverwrites(channel, harmonyChannelId)
      } catch (err) {
        failures.push(`permissions \`#${p.name}\`: ${errorText(err)}`)
      }
    }
    if (isPrivate(p.discordId)) {
      try {
        if (!defaultRoleId) throw new Error(defaultRoleError || 'Harmony default role unknown')
        await rt.permissionSync.hideFromEveryone(harmonyChannelId, defaultRoleId)
        hidden++
      } catch (err) {
        rt.log.error(`clone-server: #${p.name} is hidden from @everyone on Discord; hiding Harmony channel ${harmonyChannelId} failed, left unbridged: ${errorText(err)}`)
        failures.push(`\`#${p.name}\`: left unbridged; it is private on Discord and hiding it from @everyone on Harmony failed: ${errorText(err)}`)
        continue
      }
    }
    newPairs.push({ discord: p.discordId, discordName: p.name, harmony: harmonyChannelId, direction: 'both', name: p.name })
  }

  let added: NewPair[] = []
  try {
    added = await rt.writer.linkMany(guild.id, newPairs)
    await rt.hooks.afterPairsWritten?.()
  } catch (err) {
    failures.push(`pairing: ${errorText(err)}`)
  }

  if (cloneRoles) {
    try {
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
    `• Private channels hidden from @everyone: ${hidden}`,
    `• Categories created: ${categoriesCreated}`,
    `• Category orders updated: ${categoriesOrderUpdated}`,
    `• Mappings written: ${added.length}`,
    `• Order synced: ${orderSync.categoriesUpdated} categor${orderSync.categoriesUpdated === 1 ? 'y' : 'ies'}, ${orderSync.channelsUpdated} channel(s)`,
  ]
  if (cloneRoles) summary.push(`• Roles created: ${rolesCreated}`, ...rolesAdjusted.map(a => `  • ${a}`))
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
    const report = await rt.permissionSync.reconcileRoles(guild)
    await rt.permissionSync.loadDefaultRole(guild.id)
    await rt.permissionSync.syncAllMappedChannelOverwrites(guild)
    await command.editReply({ content: joinLinesWithinDiscordLimit(roleSyncSummary(guild.name, report, linked)) })
  } catch (err) {
    await command.editReply({ content: `❌ Permission sync failed: ${errorText(err)}` })
  }
}

/** Lines of the /bridge sync-perms reply: what Harmony accepted, adjusted and refused. */
export function roleSyncSummary(guildName: string, report: RoleSyncReport, linkedChannels: number): string[] {
  const refused = report.failed.length
  const lines = [
    `${refused ? '⚠️' : '✅'} Permissions synced for **${guildName}**`,
    `• Roles: ${report.created} created, ${report.updated} updated${refused ? `, ${refused} refused` : ''}`,
    `• Channels: overwrites applied to ${linkedChannels} linked channel(s)`,
  ]
  if (report.adjusted.length) {
    lines.push('', 'Adjusted:', ...report.adjusted.map(a => `  • \`${a.name}\`: ${a.notes.join('; ')}`))
  }
  if (refused) {
    lines.push('', 'Refused by Harmony:', ...report.failed.slice(0, 15).map(f => `  • \`${f.name}\`: ${f.error}`))
    if (report.failed.some(f => /manage_roles/.test(f.error))) {
      lines.push('', 'The bridge bot lacks manage_roles on Harmony; Harmony 1.6.27 grants it to bridge bots.')
    }
    if (report.failed.some(f => /position/.test(f.error))) {
      lines.push('', 'A role cannot sit at or above an Administrator role: move the Admin role up in Harmony\'s Server Settings → Roles, then run this again.')
    }
  }
  return lines
}

/** Discord emoji imported per call; Harmony stores each image, so a run is bounded. */
const EMOJI_IMPORT_LIMIT = 250

/**
 * `/bridge import-emojis`: the guild's custom emoji become Harmony server emoji with the same
 * names. Harmony keeps one row per Discord emoji, so a rerun imports only new ones; a server
 * emoji with the same name is linked instead of duplicated. Linked emoji are one emoji on both
 * sides for reactions and messages.
 */
async function runBridgeImportEmojisLegacy(rt: BridgeRuntime, command: ChatInputCommandInteraction, alreadyDeferred = false) {
  const dryRun = command.options.getBoolean('dry_run', false) ?? false
  if (!alreadyDeferred) await command.deferReply({ flags: MessageFlags.Ephemeral })

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

  const counts = { created: 0, linked: 0, updated: 0, existing: emojis.length - fresh.length }
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

/**
 * `/bridge sync-sounds`: makes the Harmony soundboard match the guild's. Mirror (default) also
 * deletes Harmony sounds that are not on Discord, so a real run with deletes or replacements asks
 * Confirm/Cancel first. Order: deletes, creates, updates; a rerun finishes whatever failed.
 */
export async function runBridgeSyncSounds(rt: BridgeRuntime, command: ChatInputCommandInteraction) {
  const mode = (command.options.getString('mode', false) ?? 'mirror') as SyncMode
  const dryRun = command.options.getBoolean('dry_run', false) ?? false
  await command.deferReply({ flags: MessageFlags.Ephemeral })

  const guild = command.guild!
  const bridge = rt.dir.getBridgeForDiscordGuild(guild.id)
  if (!bridge) {
    await command.editReply({ content: notBridgedText(rt) })
    return
  }
  const serverId = bridge.harmonyServerId

  let harmonyRows
  try {
    harmonyRows = await rt.harmony.getServerSounds(serverId)
  } catch (err) {
    if (err instanceof HarmonyHttpError && err.status === 404) {
      await command.editReply({ content: '❌ Soundboard sync needs a newer Harmony (bridge soundboard endpoints).' })
      return
    }
    throw err
  }

  let discordSounds
  try {
    discordSounds = [...(await guild.soundboardSounds.fetch()).values()]
  } catch (err) {
    await command.editReply({ content: `❌ Could not read the Discord soundboard: ${errorText(err)}` })
    return
  }

  await rt.emojiLinks.ensure(serverId)
  const harmonyEmojiFor = (id: string) => rt.emojiLinks.harmonyFor(serverId, id)?.id ?? null
  const inputs = discordSounds.map(s => ({
    soundId: s.soundId,
    name: s.name,
    volume: s.volume ?? 1,
    emojiId: s.emoji?.id ?? null,
    emojiName: s.emoji?.name ?? null,
    available: s.available !== false,
  }))
  const discord = inputs.filter(s => s.available).map(s => desiredSound(s, harmonyEmojiFor))
  const presentIds = inputs.filter(s => !s.available).map(s => s.soundId)

  const plan = planSync({
    mode,
    discord,
    presentIds,
    harmony: harmonyRows.map(harmonySyncItem),
    differs: soundDiffers,
  })
  const reportOpts = { label: (n: string) => n, noun: 'sound' }

  if (dryRun) {
    await command.editReply({
      content: joinLinesWithinDiscordLimit([
        `🧪 **Dry run** (${mode}) for **${guild.name}**`,
        ...syncReportLines(plan, { ...reportOpts, dryRun: true }),
      ]),
    })
    return
  }

  const deletions = [...plan.delete, ...plan.replace.flatMap(r => r.harmony)]
  const creations = [...plan.add, ...plan.replace.map(r => r.discord)]
  if (deletions.length + creations.length + plan.update.length === 0) {
    // Merge and add can leave clashing or outdated sounds behind; say so instead of "matches".
    const left = plan.conflict.length + plan.outdated > 0
    await command.editReply({
      content: left
        ? joinLinesWithinDiscordLimit([
          `${plan.conflict.length > 0 ? '⚠️' : '✅'} Nothing to apply (${mode}) for **${guild.name}**`,
          ...syncReportLines(plan, { ...reportOpts, dryRun: false }),
        ])
        : '✅ Soundboard already matches.',
    })
    return
  }

  if (deletions.length > 0) {
    const prompt = joinLinesWithinDiscordLimit([
      ...syncReportLines(plan, { ...reportOpts, dryRun: false }),
      `⚠️ This deletes ${deletions.length} Harmony sound(s). Confirm?`,
    ])
    if (!(await confirmAction(command, prompt, undefined, rt.log))) return
  }

  const failures: string[] = []
  const fail = (name: string, err: unknown) => {
    const full = err instanceof HarmonyHttpError && err.code === 'SOUND_LIMIT'
    failures.push(`${name}: ${full ? 'the Harmony soundboard is full (48 sounds per server)' : errorText(err)}`)
  }
  const counts = { deleted: 0, created: 0, updated: 0, replaced: 0 }
  const applied: DesiredSound[] = []

  // Resolves to the error, or null once the sound is gone (404 counts as gone).
  const tryDelete = async (h: { id: string }): Promise<unknown> => {
    try {
      await rt.harmony.deleteServerSound(serverId, h.id)
    } catch (err) {
      if (!(err instanceof HarmonyHttpError && err.status === 404)) return err
    }
    return null
  }
  for (const h of plan.delete) {
    const err = await tryDelete(h)
    if (err) fail(h.name, err)
    else counts.deleted++
  }
  // A replaced sound is only recreated on Discord's name if every old Harmony row is gone.
  const blocked = new Set<string>()
  for (const r of plan.replace) {
    let deleteError: unknown = null
    for (const h of r.harmony) {
      const err = await tryDelete(h)
      if (err && !deleteError) deleteError = err
    }
    if (deleteError) {
      blocked.add(r.discord.id)
      failures.push(`${r.discord.name}: not replaced, deleting the Harmony sound failed: ${errorText(deleteError)}`)
    }
  }
  const replacing = new Set(plan.replace.map(r => r.discord.id))
  for (const d of creations) {
    if (blocked.has(d.id)) continue
    try {
      await rt.harmony.importDiscordSound(serverId, d, false)
      if (replacing.has(d.id)) counts.replaced++
      else counts.created++
      applied.push(d)
    } catch (err) {
      fail(d.name, err)
    }
  }
  for (const { discord: d } of plan.update) {
    try {
      await rt.harmony.importDiscordSound(serverId, d, true)
      counts.updated++
      applied.push(d)
    } catch (err) {
      fail(d.name, err)
    }
  }

  const lines = [
    failures.length > 0
      ? `⚠️ Soundboard sync finished with ${failures.length} failure(s) (${mode}) for **${guild.name}**`
      : `✅ Soundboard sync (${mode}) for **${guild.name}**`,
    `• Added: ${counts.created}`,
    `• Updated: ${counts.updated}`,
    ...(plan.replace.length > 0 ? [`• Replaced (same name on Harmony): ${counts.replaced}`] : []),
    `• Deleted: ${counts.deleted}`,
    ...(plan.outdated > 0 ? [`• Not updated (add mode): ${plan.outdated}; use merge or mirror to update`] : []),
  ]
  if (plan.conflict.length > 0) {
    const names = plan.conflict.map(c => c.discord.name)
    lines.push('', `⚠️ ${names.length} name clash(es), left as they are:`, ...names.slice(0, 20).map(n => `  • ${n}`))
    if (names.length > 20) lines.push(`  • …and ${names.length - 20} more`)
    lines.push(CONFLICT_HINT)
  }
  const noEmoji = applied.filter(d => d.hadUnimportedEmoji).length
  if (noEmoji > 0) {
    lines.push('', `Run \`/bridge import-emojis\` first to keep custom emoji on ${noEmoji} sound(s).`)
  }
  if (failures.length > 0) {
    lines.push('', `⚠️ ${failures.length} failure(s):`, ...failures.slice(0, 15).map(f => `  • ${f}`))
    if (failures.length > 15) lines.push(`  • …and ${failures.length - 15} more`)
  }
  await command.editReply({ content: joinLinesWithinDiscordLimit(lines), components: [] })
}

/**
 * `/bridge sync-emojis`: makes Harmony's emoji match the guild's. Mirror (default) also removes
 * Harmony emoji that are not on Discord, so a real run that removes or replaces anything asks
 * Confirm/Cancel first. `/bridge import-emojis` is this in add mode, falling back to the old
 * import on a Harmony without the sync endpoints.
 * Order: removals, replace holders, creates, then renames and restores.
 */
export async function runBridgeSyncEmojis(
  rt: BridgeRuntime,
  command: ChatInputCommandInteraction,
  opts: { mode?: SyncMode } = {},
) {
  const shortcut = opts.mode !== undefined
  const mode = (opts.mode ?? command.options.getString('mode', false) ?? 'mirror') as SyncMode
  const dryRun = command.options.getBoolean('dry_run', false) ?? false
  await command.deferReply({ flags: MessageFlags.Ephemeral })

  const guild = command.guild!
  const bridge = rt.dir.getBridgeForDiscordGuild(guild.id)
  if (!bridge) {
    await command.editReply({ content: notBridgedText(rt) })
    return
  }
  const serverId = bridge.harmonyServerId

  let state
  try {
    state = await rt.harmony.getEmojiSyncState(serverId)
  } catch (err) {
    if (err instanceof HarmonyHttpError && err.status === 404) {
      if (shortcut) {
        await runBridgeImportEmojisLegacy(rt, command, true)
      } else {
        await command.editReply({ content: '❌ Emoji sync needs a newer Harmony (bridge emoji sync endpoints).' })
      }
      return
    }
    throw err
  }

  let fetched
  try {
    fetched = [...(await guild.emojis.fetch()).values()]
  } catch (err) {
    await command.editReply({ content: `❌ Could not read the Discord emoji: ${errorText(err)}` })
    return
  }
  const presentIds = fetched.filter(e => e.available === false).map(e => e.id)
  const discord = fetched
    .filter(e => e.available !== false)
    .map(e => desiredEmoji({ id: e.id, name: e.name, animated: e.animated === true, available: true }))
    .filter((d): d is DesiredEmoji => d !== null)
    .sort(byDiscordId)

  const rawPlan = planSync({
    mode,
    discord,
    presentIds,
    harmony: state.emojis.map(harmonyEmojiSyncItem),
    differs: emojiDiffers,
    limit: state.limit,
  })
  // A clash report already covers an emoji the planner also wanted to rename or restore.
  const clashing = new Set(rawPlan.conflict.map(c => c.discord.id))
  const plan = {
    ...rawPlan,
    update: rawPlan.update.filter(u => !clashing.has(u.discord.id)),
    restore: rawPlan.restore.filter(u => !clashing.has(u.discord.id)),
  }
  const limitHint = '  An instance admin can raise "max custom emojis per server", then run this again.'
  const reportOpts = { label: (n: string) => `:${n}:`, noun: 'emoji', nounPlural: 'emoji', limitHint, removeVerb: { dry: 'Would remove', real: 'Remove' } }

  if (dryRun) {
    await command.editReply({
      content: joinLinesWithinDiscordLimit([
        `🧪 **Dry run** (${mode}) for **${guild.name}**`,
        ...syncReportLines(plan, { ...reportOpts, dryRun: true }),
      ]),
    })
    return
  }

  const removals = [...plan.delete, ...plan.replace.flatMap(r => r.harmony)]
  const creations = [...plan.add, ...plan.replace.map(r => r.discord)]
  if (removals.length + creations.length + plan.update.length + plan.restore.length === 0) {
    const left = plan.conflict.length + plan.outdated + plan.overLimit.length > 0
    await command.editReply({
      content: left
        ? joinLinesWithinDiscordLimit([
          `${plan.conflict.length > 0 ? '⚠️' : '✅'} Nothing to apply (${mode}) for **${guild.name}**`,
          ...syncReportLines(plan, { ...reportOpts, dryRun: false }),
        ])
        : '✅ Emoji already match.',
    })
    return
  }

  if (removals.length > 0) {
    const prompt = joinLinesWithinDiscordLimit([
      ...syncReportLines(plan, { ...reportOpts, dryRun: false }),
      `⚠️ This removes ${removals.length} Harmony emoji. Removed emoji stay in old messages and can be restored in Harmony. Confirm?`,
    ])
    if (!(await confirmAction(command, prompt, undefined, rt.log))) return
  }

  const failures: string[] = []
  const fail = (name: string, err: unknown) => {
    let text: string
    if (err instanceof HarmonyHttpError && err.code === 'EMOJI_LIMIT') {
      text = `the Harmony emoji list is full (${state.limit} per server)`
    } else if (err instanceof HarmonyHttpError && err.code === 'EMOJI_NAME_TAKEN') {
      text = 'name already used by another Harmony emoji'
    } else {
      text = errorText(err)
    }
    failures.push(`:${name}: ${text}`)
  }
  const counts = { removed: 0, created: 0, renamed: 0, restored: 0, replaced: 0 }

  // Resolves to the error, or null once the emoji is gone (404 counts as gone).
  const tryRemove = async (h: { id: string }): Promise<unknown> => {
    try {
      await rt.harmony.removeServerEmoji(serverId, h.id)
    } catch (err) {
      if (!(err instanceof HarmonyHttpError && err.status === 404)) return err
    }
    return null
  }
  for (const h of plan.delete) {
    const err = await tryRemove(h)
    if (err) fail(h.name, err)
    else counts.removed++
  }
  // A replaced emoji is only recreated on Discord's name if every old Harmony row is gone.
  const blocked = new Set<string>()
  for (const r of plan.replace) {
    let removeError: unknown = null
    for (const h of r.harmony) {
      const err = await tryRemove(h)
      if (err) removeError ??= err
    }
    if (removeError) {
      blocked.add(r.discord.id)
      failures.push(`:${r.discord.name}: not replaced, removing the Harmony emoji failed: ${errorText(removeError)}`)
    }
  }
  const replacing = new Set(plan.replace.map(r => r.discord.id))
  const send = (d: DesiredEmoji, update: boolean) =>
    rt.harmony.importDiscordEmoji(serverId, { discordEmojiId: d.id, name: d.name, animated: d.animated }, update)
  for (const d of creations) {
    if (blocked.has(d.id)) continue
    try {
      await send(d, false)
      if (replacing.has(d.id)) counts.replaced++
      else counts.created++
    } catch (err) {
      fail(d.name, err)
    }
  }
  for (const { discord: d } of plan.update) {
    try {
      await send(d, true)
      counts.renamed++
    } catch (err) {
      fail(d.name, err)
    }
  }
  for (const { discord: d } of plan.restore) {
    try {
      await send(d, true)
      counts.restored++
    } catch (err) {
      fail(d.name, err)
    }
  }

  try {
    rt.emojiLinks.replace(serverId, await rt.harmony.getServerEmojis(serverId))
  } catch (err) {
    rt.log.warn(`Could not refresh emoji links after sync: ${errorText(err)}`)
  }

  const lines = [
    failures.length > 0
      ? `⚠️ Emoji sync finished with ${failures.length} failure(s) (${mode}) for **${guild.name}**`
      : `✅ Emoji sync (${mode}) for **${guild.name}**`,
    `• Added: ${counts.created}`,
    `• Renamed: ${counts.renamed}`,
    `• Restored: ${counts.restored}`,
    ...(plan.replace.length > 0 ? [`• Replaced (same name on Harmony): ${counts.replaced}`] : []),
    `• Removed: ${counts.removed}`,
    ...(plan.outdated > 0 ? [`• Not updated (add mode): ${plan.outdated}; use merge or mirror to update`] : []),
  ]
  if (plan.overLimit.length > 0) {
    const names = plan.overLimit.map(d => d.name)
    lines.push('', `⚠️ ${names.length} skipped: limit reached (${plan.limit} per server)`, ...names.slice(0, 20).map(n => `  • :${n}:`))
    if (names.length > 20) lines.push(`  • …and ${names.length - 20} more`)
    lines.push(limitHint)
  }
  if (plan.conflict.length > 0) {
    const names = plan.conflict.map(c => c.discord.name)
    lines.push('', `⚠️ ${names.length} name clash(es), left as they are:`, ...names.slice(0, 20).map(n => `  • :${n}:`))
    if (names.length > 20) lines.push(`  • …and ${names.length - 20} more`)
    lines.push(CONFLICT_HINT)
  }
  if (failures.length > 0) {
    lines.push('', `⚠️ ${failures.length} failure(s):`, ...failures.slice(0, 15).map(f => `  • ${f}`))
    if (failures.length > 15) lines.push(`  • …and ${failures.length - 15} more`)
  }
  await command.editReply({ content: joinLinesWithinDiscordLimit(lines), components: [] })
}
