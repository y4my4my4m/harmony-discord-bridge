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
import { CONFLICT_HINT, DEFAULT_SYNC_MODE, planSync, syncConfirmLines, syncReportLines, SYNC_MODE_CHOICES, type SyncMode } from './expressionSync.js'
import { byDiscordId, desiredEmoji, emojiDiffers, harmonyEmojiSyncItem, type DesiredEmoji } from './emojiSync.js'
import { desiredSticker, harmonyStickerSyncItem, isStickerSkip, stickerDiffers, type DesiredSticker, type StickerSkip } from './stickerSync.js'
import { desiredSound, harmonySyncItem, soundDiffers, soundUpdate, type DesiredSound } from './soundSync.js'
import { BridgeApiError, type ImportJob } from '../v2/BridgeApi.js'
import { importPercent } from './importProgress.js'

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

/** Commands that exist only where the gateway lists the capability (Harmony 1.9.7). */
export interface CommandFeatures {
  soundSync: boolean
  emojiSync: boolean
  stickerSync: boolean
  /** The capability, a bridge that may import, and the instance setting on. */
  historyImport: boolean
  privacy: boolean
}

export const NO_FEATURES: CommandFeatures = { soundSync: false, emojiSync: false, stickerSync: false, historyImport: false, privacy: false }

/**
 * `/mention`, `/m`, `/bridge`. `/bridge` is visible to Administrators only
 * and the handler checks the permission again. v1 keeps its original
 * `link` options; v2 links by Harmony channel autocomplete and direction.
 * A subcommand of a gateway feature is offered only with that feature.
 */
export function buildCommands(mode: 'v1' | 'v2', features: CommandFeatures = NO_FEATURES) {
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
    if (features.emojiSync) bridgeCommand.addSubcommand(sub =>
      sub
        .setName('sync-emojis')
        .setDescription('Copy this server\'s emoji to Harmony and keep them up to date')
        .addStringOption(opt =>
          opt.setName('mode')
            .setDescription('How to reconcile (default: merge)')
            .setRequired(false)
            .addChoices(...SYNC_MODE_CHOICES))
        .addBooleanOption(opt =>
          opt.setName('dry_run').setDescription('Show what would change without making changes').setRequired(false)))
    if (features.stickerSync) bridgeCommand.addSubcommand(sub =>
      sub
        .setName('sync-stickers')
        .setDescription('Copy this server\'s stickers to Harmony and keep them up to date')
        .addStringOption(opt =>
          opt.setName('mode')
            .setDescription('How to reconcile (default: merge)')
            .setRequired(false)
            .addChoices(...SYNC_MODE_CHOICES))
        .addBooleanOption(opt =>
          opt.setName('dry_run').setDescription('Show what would change without making changes').setRequired(false)))
    if (features.soundSync) bridgeCommand.addSubcommand(sub =>
      sub
        .setName('sync-sounds')
        .setDescription('Copy this server\'s soundboard to Harmony and keep it up to date')
        .addStringOption(opt =>
          opt.setName('mode')
            .setDescription('How to reconcile (default: merge)')
            .setRequired(false)
            .addChoices(...SYNC_MODE_CHOICES))
        .addBooleanOption(opt =>
          opt.setName('dry_run').setDescription('Show what would change without making changes').setRequired(false)))
    if (features.historyImport) bridgeCommand.addSubcommand(sub =>
      sub
        .setName('import-history')
        .setDescription('Import old Discord messages into Harmony (start, check or cancel)')
        .addStringOption(opt =>
          opt.setName('action')
            .setDescription('What to do (default: start, which asks before it begins)')
            .setRequired(false)
            .addChoices(
              { name: 'Start', value: 'start' },
              { name: 'Status', value: 'status' },
              { name: 'Cancel', value: 'cancel' },
            ))
        .addStringOption(opt =>
          opt.setName('scope')
            .setDescription('This channel or every bridged channel (default: this channel)')
            .setRequired(false)
            .addChoices(
              { name: 'This channel', value: 'channel' },
              { name: 'All bridged channels', value: 'all' },
            )))
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

export async function registerSlashCommands(rt: BridgeRuntime, client: DiscordClient, guildId: string, features: CommandFeatures = NO_FEATURES) {
  const applicationId = client.application?.id ?? client.user?.id
  if (!applicationId) throw new Error('Discord client has no application id yet')
  const commands = buildCommands(rt.mode, features)
  await client.rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: commands })
  rt.log.info(`Slash commands registered in guild ${guildId}: ${commands.map(c => `/${c.name}`).join(', ')}`)
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
      case 'sync-stickers':
        await runBridgeSyncStickers(rt, command)
        break
      case 'import-history':
        await runBridgeImportHistory(rt, command)
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

const ACTIVE_IMPORT_STATES = new Set(['queued', 'running', 'paused'])

/** Short sentences for the error codes an import job can carry. */
function importErrorText(code: string): string {
  switch (code) {
    case 'pair_removed': return 'pair removed'
    case 'pair_not_importable': return "the pair no longer brings Discord messages to Harmony"
    case 'channel_encrypted': return 'channel is now encrypted'
    case 'import_disabled': return 'history import was turned off'
    case 'discord_approval_required': return 'the Discord channel is hidden from @everyone: run `/bridge import-history` in it on Discord'
    case 'discord_channel_unsupported': return 'this kind of Discord channel cannot be imported'
    case 'discord_access_lost': return 'the bot lost access to the Discord channel'
    case 'bridge_stalled': return 'the import stopped making progress'
  }
  const refused = /^harmony_(\d+)$/.exec(code)
  return refused ? `Harmony refused the import (${refused[1]})` : code
}

/** Why the import routes refuse this bridge, for the person who ran the command. */
function importDisabledText(err: BridgeApiError): string {
  return err.details.reason === 'bridge_mode'
    ? '❌ Only a bridge you run yourself can import history; a hosted bridge and the instance bot cannot.'
    : '❌ History import is turned off on this Harmony instance. An instance admin can turn it on.'
}

function memberCanView(channel: unknown, member: unknown): boolean {
  const permissions = (channel as { permissionsFor?: (m: unknown) => { has(flag: bigint): boolean } | null } | null)?.permissionsFor?.(member)
  return permissions?.has(PermissionFlagsBits.ViewChannel) === true
}

/**
 * `/bridge import-history`: start, check or cancel the import of old Discord messages into
 * Harmony. The work runs in the import scheduler; this only talks to the import routes.
 * A thread counts as its parent channel. Starting asks Confirm first, covers only channels the
 * invoker can view, and names the invoker to Harmony.
 */
async function runBridgeImportHistory(rt: BridgeRuntime, command: ChatInputCommandInteraction) {
  const api = rt.hooks.importApi
  if (!api || rt.hooks.importEnabled?.() !== true) {
    await command.reply({ content: '❌ History import is not available for this bridge. It needs a bridge you run yourself, Harmony 1.9.7 or later, and the instance setting turned on.', flags: MessageFlags.Ephemeral })
    return
  }
  const action = command.options.getString('action', false) ?? 'start'
  const all = (command.options.getString('scope', false) ?? 'channel') === 'all'

  const channel = command.channel
  const pairId = channel?.isThread() && channel.parentId ? channel.parentId : command.channelId
  if (!all && !rt.dir.getHarmonyChannel(pairId)) {
    await command.reply({ content: "❌ This channel isn't bridged.", flags: MessageFlags.Ephemeral })
    return
  }

  // The import routes can take longer than Discord's 3 s to answer.
  await command.deferReply({ flags: MessageFlags.Ephemeral })
  const say = (content: string) => command.editReply({ content, components: [] })

  try {
    if (action === 'start') await startImportHistory(rt, command, api, all, pairId, say)
    else await showOrCancelImports(rt, command, api, action, all, pairId, say)
  } catch (err) {
    if (err instanceof BridgeApiError && err.code === 'import_disabled') {
      await say(importDisabledText(err))
      return
    }
    throw err
  }
}

async function startImportHistory(
  rt: BridgeRuntime,
  command: ChatInputCommandInteraction,
  api: NonNullable<BridgeRuntime['hooks']['importApi']>,
  all: boolean,
  pairId: string,
  say: (content: string) => Promise<unknown>,
) {
  const guild = command.guild!
  // Pairs that bring Discord messages to Harmony, in this command's scope.
  const candidates = (all ? rt.dir.getAllMappings(guild.id).map(m => m.discord) : [pairId])
    .filter(id => rt.dir.shouldBridgeFromDiscord(id))
  if (candidates.length === 0) {
    await say(all
      ? 'Nothing to import: no channel here brings Discord messages to Harmony.'
      : "❌ This channel's pair doesn't bring Discord messages to Harmony.")
    return
  }

  // Only channels the invoker can view: starting an import is their approval to copy the channel.
  const viewable: string[] = []
  const hidden: string[] = []
  for (const id of candidates) {
    const channel = guild.channels.cache.get(id) ?? await guild.channels.fetch(id).catch(() => null)
    if (memberCanView(channel, command.member)) viewable.push(id)
    else hidden.push(id)
  }
  const hiddenLine = hidden.length > 0
    ? `Left out, you cannot view ${hidden.length === 1 ? 'it' : 'them'}: ${hidden.map(id => `<#${id}>`).join(', ')}`
    : null
  if (viewable.length === 0) {
    await say(`❌ Nothing to import: you cannot view ${all ? 'any bridged channel' : 'this channel'}.${hiddenLine ? `\n${hiddenLine}` : ''}`)
    return
  }

  const n = viewable.length
  const prompt = joinLinesWithinDiscordLimit([
    `⚠️ Import the history of ${n} channel${n === 1 ? '' : 's'} into Harmony? ${viewable.slice(0, 20).map(id => `<#${id}>`).join(', ')}${n > 20 ? `, and ${n - 20} more` : ''}`,
    '• Every message and file in them is copied to Harmony, with its author and date.',
    '• Messages of people who left this server, of bots, and of members who opted out with `/bridge-privacy` are skipped.',
    '• There is no undo button: what is imported stays on Harmony until it is removed there.',
    '• A pinned notice in each channel tells its members.',
    ...(hiddenLine ? [hiddenLine] : []),
  ])
  if (!(await confirmAction(command, prompt, undefined, rt.log))) return

  const requestedBy = { id: command.user.id, username: command.user.username }
  let ids = viewable
  const notImportable: string[] = []
  let jobs: ImportJob[] = []
  while (ids.length > 0) {
    try {
      jobs = await api.startImports(ids, requestedBy)
      break
    } catch (err) {
      // Harmony names one pair it will not import (encrypted, or changed since): the rest still start.
      const bad = err instanceof BridgeApiError && err.code === 'pair_not_importable' ? err.details.discord_channel_id : null
      if (typeof bad !== 'string' || !ids.includes(bad)) throw err
      notImportable.push(bad)
      ids = ids.filter(id => id !== bad)
    }
  }
  rt.log.info(`/bridge import-history start by ${command.user.id} in guild ${guild.id}: ${jobs.length} job(s) for ${ids.length} channel(s)${hidden.length > 0 ? `, ${hidden.length} hidden from the invoker` : ''}`)
  rt.hooks.kickImports?.()

  const lines = [jobs.length === 0
    ? 'Nothing to import: Harmony queued no channel.'
    : `✅ Importing history for ${jobs.length} channel(s). Progress shows in Harmony under Server settings → Discord Bridge, or run \`/bridge import-history action:status\`.`]
  if (notImportable.length > 0) lines.push(`Not importable (encrypted on Harmony, or no longer paired this way): ${notImportable.map(id => `<#${id}>`).join(', ')}`)
  if (hiddenLine) lines.push(hiddenLine)
  await say(joinLinesWithinDiscordLimit(lines))
}

async function showOrCancelImports(
  rt: BridgeRuntime,
  command: ChatInputCommandInteraction,
  api: NonNullable<BridgeRuntime['hooks']['importApi']>,
  action: string,
  all: boolean,
  pairId: string,
  say: (content: string) => Promise<unknown>,
) {
  const inScope = (await api.listImports()).filter(j => all || j.discord_channel_id === pairId)
  if (action === 'cancel') {
    const active = inScope.filter(j => ACTIVE_IMPORT_STATES.has(j.state))
    for (const j of active) await api.cancelImport(j.id)
    if (active.length > 0) rt.log.info(`/bridge import-history cancel by ${command.user.id} in guild ${command.guildId}: ${active.length} job(s)`)
    await say(active.length > 0 ? 'Cancelling…' : 'No import is running or queued here.')
    return
  }

  // status: the newest job of each channel.
  const latest = new Map<string, ImportJob>()
  for (const j of inScope) {
    const seen = latest.get(j.discord_channel_id)
    if (!seen || j.created_at > seen.created_at) latest.set(j.discord_channel_id, j)
  }
  if (latest.size === 0) {
    await say('No imports yet. Run `/bridge import-history` to start one.')
    return
  }
  const lines = ['**History imports**']
  for (const j of latest.values()) {
    const pct = importPercent(j)
    const cancelling = j.cancel_requested && ACTIVE_IMPORT_STATES.has(j.state)
    // A finished run counts what that run added: a re-run over an imported channel adds nothing.
    const count = j.state !== 'done' ? `${j.imported_count} messages`
      : j.imported_count > 0 ? `${j.imported_count} new messages` : 'up to date'
    const parts = [cancelling ? 'cancelling' : j.state, pct === null ? '-' : `${pct}%`, count]
    if (j.authors_skipped) parts.push(`${j.authors_skipped} skipped (author left or opted out)`)
    lines.push(`• ${harmonyChannelName(rt, j.harmony_channel_id)}: ${parts.join(', ')}${j.error ? ` (${importErrorText(j.error)})` : ''}`)
  }
  await say(joinLinesWithinDiscordLimit(lines))
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

/** Harmony's cap on sounds per server (SOUND_LIMIT). */
const HARMONY_SOUND_LIMIT = 48

/** Harmony servers with a sync of one kind in flight. A second run would plan against state the first is changing. */
const syncsInFlight = new Set<string>()

async function withSyncLock(command: ChatInputCommandInteraction, key: string, run: () => Promise<void>): Promise<void> {
  if (syncsInFlight.has(key)) {
    await command.editReply({ content: '⏳ This sync is already running for this server. Wait for it to finish, then run it again.' })
    return
  }
  syncsInFlight.add(key)
  try {
    await run()
  } finally {
    syncsInFlight.delete(key)
  }
}

/** A 403 with `code`: the gateway keeps the item (a member's upload, or an emoji a person removed). Final. */
function isRefusal(err: unknown, code: string): boolean {
  return err instanceof HarmonyHttpError && err.status === 403 && err.code === code
}

/** Text for a list the gateway could not answer whole, or null for any other error. */
function listErrorText(err: unknown, what: string): string | null {
  if (!(err instanceof HarmonyHttpError)) return null
  if (err.code === 'LIST_TOO_LARGE') return `❌ Harmony holds too many ${what} rows to list. Nothing changed.`
  if (err.code === 'LIST_MALFORMED') return `❌ Harmony answered a ${what} list this bridge version cannot read. Nothing changed.`
  return null
}

type Removal = 'gone' | 'kept' | { error: unknown }

/** One removal. A 404 is an item that is already gone; `keptCode` is the gateway keeping a member's upload. */
async function tryRemoval(remove: () => Promise<void>, keptCode: string): Promise<Removal> {
  try {
    await remove()
    return 'gone'
  } catch (err) {
    if (err instanceof HarmonyHttpError && err.status === 404) return 'gone'
    if (isRefusal(err, keptCode)) return 'kept'
    return { error: err }
  }
}

function namedList(header: string, names: string[], label: (n: string) => string, max = 20): string[] {
  if (names.length === 0) return []
  const lines = ['', header, ...names.slice(0, max).map(n => `  • ${label(n)}`)]
  if (names.length > max) lines.push(`  • …and ${names.length - max} more`)
  return lines
}

/**
 * `/bridge sync-sounds`: copies the guild's soundboard to Harmony. Merge (default) adds and
 * updates. Mirror also deletes the sounds copied from a Discord sound that is gone, after
 * Confirm/Cancel. A sound a member uploaded on Harmony is never deleted or replaced.
 * Order: deletes, replacements, creates, updates; a rerun finishes whatever failed.
 */
export async function runBridgeSyncSounds(rt: BridgeRuntime, command: ChatInputCommandInteraction) {
  const mode = (command.options.getString('mode', false) ?? DEFAULT_SYNC_MODE) as SyncMode
  const dryRun = command.options.getBoolean('dry_run', false) ?? false
  await command.deferReply({ flags: MessageFlags.Ephemeral })

  const guild = command.guild!
  const bridge = rt.dir.getBridgeForDiscordGuild(guild.id)
  if (!bridge) {
    await command.editReply({ content: notBridgedText(rt) })
    return
  }
  const serverId = bridge.harmonyServerId
  await withSyncLock(command, `sounds:${serverId}`, () => syncSounds(rt, command, serverId, mode, dryRun))
}

async function syncSounds(rt: BridgeRuntime, command: ChatInputCommandInteraction, serverId: string, mode: SyncMode, dryRun: boolean) {
  const guild = command.guild!
  const say = (content: string) => command.editReply({ content, components: [] })

  /** Reads both sides and plans. Null after replying, when a side cannot be read. */
  const prepare = async () => {
    let harmonyRows
    try {
      harmonyRows = await rt.harmony.getServerSounds(serverId)
    } catch (err) {
      if (err instanceof HarmonyHttpError && err.status === 404) {
        await say('❌ Soundboard sync needs Harmony 1.9.7 or later.')
        return null
      }
      const text = listErrorText(err, 'sound')
      if (!text) throw err
      await say(text)
      return null
    }

    let discordSounds
    try {
      discordSounds = [...(await guild.soundboardSounds.fetch()).values()]
    } catch (err) {
      await say(`❌ Could not read the Discord soundboard: ${errorText(err)}`)
      return null
    }

    // Read now, not from the cache: links that failed to load map every custom emoji to none.
    try {
      rt.emojiLinks.replace(serverId, await rt.harmony.getServerEmojis(serverId))
    } catch (err) {
      await say(`❌ Could not read Harmony's emoji, which sound emoji are matched against: ${errorText(err)}. Nothing changed.`)
      return null
    }
    const harmonyEmojiFor = (id: string) => rt.emojiLinks.harmonyFor(serverId, id)?.id ?? null
    const inputs = discordSounds.map(s => ({
      soundId: s.soundId,
      name: s.name,
      volume: s.volume ?? 1,
      emojiId: s.emoji?.id ?? null,
      emojiName: s.emoji?.name ?? null,
      available: s.available !== false,
    }))
    const plan = planSync({
      mode,
      discord: inputs.filter(s => s.available).map(s => desiredSound(s, harmonyEmojiFor)),
      presentIds: inputs.filter(s => !s.available).map(s => s.soundId),
      harmony: harmonyRows.map(harmonySyncItem),
      differs: soundDiffers,
    })
    return { plan, discordEmpty: inputs.length === 0, active: harmonyRows.length }
  }

  const first = await prepare()
  if (!first) return
  let { plan, active } = first
  type Plan = typeof plan
  const reportOpts = { label: (n: string) => n, noun: 'sound' }

  if (dryRun) {
    await say(joinLinesWithinDiscordLimit([
      `🧪 **Dry run** (${mode}) for **${guild.name}**`,
      ...syncReportLines(plan, { ...reportOpts, dryRun: true }),
    ]))
    return
  }

  const removalsOf = (p: Plan) => [...p.delete, ...p.replace.flatMap(r => r.harmony)]
  if (removalsOf(plan).length + plan.add.length + plan.update.length === 0) {
    // Clashing, outdated or kept sounds can remain; say so instead of "matches".
    const left = plan.conflict.length + plan.outdated + plan.kept.length > 0
    await say(left
      ? joinLinesWithinDiscordLimit([
        `${plan.conflict.length > 0 ? '⚠️' : '✅'} Nothing to apply (${mode}) for **${guild.name}**`,
        ...syncReportLines(plan, { ...reportOpts, dryRun: false }),
      ])
      : '✅ Soundboard already matches.')
    return
  }

  const removals = removalsOf(plan)
  if (removals.length > 0) {
    const n = removals.length
    const warning = first.discordEmpty
      ? `⚠️ The Discord soundboard is empty. This deletes all ${n} Harmony sound(s) copied from Discord. Confirm?`
      : `⚠️ This deletes ${n} Harmony sound(s) copied from Discord. Confirm?`
    const prompt = joinLinesWithinDiscordLimit(syncConfirmLines(plan, { ...reportOpts, warning }))
    if (!(await confirmAction(command, prompt, undefined, rt.log))) return
    // Both sides can change during the wait. The fresh plan may delete only what was confirmed.
    const fresh = await prepare()
    if (!fresh) return
    const confirmed = new Set(removals.map(r => r.id))
    if (removalsOf(fresh.plan).some(r => !confirmed.has(r.id))) {
      await say('❌ The sounds changed while this waited for an answer. Nothing changed; run it again.')
      return
    }
    plan = fresh.plan
    active = fresh.active
  }

  const failures: string[] = []
  const keptByHarmony: string[] = []
  const skippedFull: string[] = []
  const counts = { deleted: 0, created: 0, updated: 0, replaced: 0, existing: 0 }
  const applied: DesiredSound[] = []
  let full = false

  const remove = (h: { id: string }) => tryRemoval(() => rt.harmony.deleteServerSound(serverId, h.id), 'SOUND_NOT_LINKED')
  /** True when the Discord sound is on Harmony afterwards. After the first SOUND_LIMIT nothing more is sent. */
  const create = async (d: DesiredSound, replacing: boolean, oldDeleted = false): Promise<boolean> => {
    if (full) {
      skippedFull.push(d.name)
      return false
    }
    try {
      const row = await rt.harmony.importDiscordSound(serverId, d, false)
      if (row?.status === 'existing') counts.existing++
      else if (replacing) counts.replaced++
      else counts.created++
      applied.push(d)
      return true
    } catch (err) {
      if (err instanceof HarmonyHttpError && err.code === 'SOUND_LIMIT') {
        full = true
        skippedFull.push(d.name)
      } else {
        failures.push(oldDeleted
          ? `${d.name}: the old Harmony sound was deleted but the Discord one could not be copied (${errorText(err)})`
          : `${d.name}: ${errorText(err)}`)
      }
      return false
    }
  }

  for (const h of plan.delete) {
    const result = await remove(h)
    if (result === 'gone') {
      counts.deleted++
      active--
    } else if (result === 'kept') {
      keptByHarmony.push(h.name)
    } else {
      failures.push(`${h.name}: ${errorText(result.error)}`)
    }
  }
  // With a free slot the copy is made first, so a failed copy leaves the old sound in place.
  // At the cap the old sound goes first.
  for (const r of plan.replace) {
    const removeOld = async (): Promise<boolean> => {
      let gone = true
      for (const h of r.harmony) {
        const result = await remove(h)
        if (result === 'gone') {
          active--
          continue
        }
        gone = false
        if (result === 'kept') keptByHarmony.push(h.name)
        else failures.push(`${r.discord.name}: deleting the old Harmony sound failed: ${errorText(result.error)}`)
      }
      return gone
    }
    if (active < HARMONY_SOUND_LIMIT) {
      if (await create(r.discord, true)) {
        active++
        await removeOld()
      }
    } else if (await removeOld()) {
      if (await create(r.discord, true, true)) active++
    }
  }
  for (const d of plan.add) {
    if (await create(d, false)) active++
  }
  for (const { discord: d, harmony: h } of plan.update) {
    try {
      const row = await rt.harmony.importDiscordSound(serverId, soundUpdate(d, h.row), true)
      if (row?.status === 'existing') counts.existing++
      else counts.updated++
      applied.push(d)
    } catch (err) {
      failures.push(`${d.name}: ${errorText(err)}`)
    }
  }

  const kept = plan.kept.length + keptByHarmony.length
  rt.log.info(`/bridge sync-sounds (${mode}) by ${command.user.id} in guild ${guild.id}: added ${counts.created}, updated ${counts.updated}, replaced ${counts.replaced}, deleted ${counts.deleted}, kept ${kept}, skipped ${skippedFull.length}, failed ${failures.length}`)

  const lines = [
    failures.length > 0
      ? `⚠️ Soundboard sync finished with ${failures.length} failure(s) (${mode}) for **${guild.name}**`
      : `✅ Soundboard sync (${mode}) for **${guild.name}**`,
    `• Added: ${counts.created}`,
    `• Updated: ${counts.updated}`,
    ...(plan.replace.length > 0 ? [`• Replaced (same name, copied from a deleted Discord one): ${counts.replaced}`] : []),
    `• Deleted: ${counts.deleted}`,
    ...(counts.existing > 0 ? [`• Already there: ${counts.existing}`] : []),
    ...(kept > 0 ? [`• Kept (not copied from Discord): ${kept}`] : []),
    ...(plan.outdated > 0 ? [`• Not updated (add mode): ${plan.outdated}; use merge or mirror to update`] : []),
  ]
  lines.push(...namedList(`⚠️ ${skippedFull.length} skipped: the Harmony soundboard is full (${HARMONY_SOUND_LIMIT} sounds per server)`, skippedFull, n => n))
  if (plan.conflict.length > 0) {
    lines.push(...namedList(`⚠️ ${plan.conflict.length} name clash(es), left as they are:`, plan.conflict.map(c => c.discord.name), n => n), CONFLICT_HINT)
  }
  const noEmoji = applied.filter(d => d.hadUnimportedEmoji).length
  if (noEmoji > 0) {
    lines.push('', `Run \`/bridge import-emojis\` first to carry the custom emoji of ${noEmoji} sound(s).`)
  }
  lines.push(...namedList(`⚠️ ${failures.length} failure(s):`, failures, n => n, 15))
  await say(joinLinesWithinDiscordLimit(lines))
}

/**
 * `/bridge sync-emojis`: copies the guild's emoji to Harmony. Merge (default) adds, renames and
 * restores what the bridge removed. Mirror also removes the emoji the bridge imported from a
 * Discord emoji that is gone, after Confirm/Cancel. An emoji a member uploaded is never removed
 * or replaced, and one a person removed is never restored. `/bridge import-emojis` is this in add
 * mode, falling back to the old import on a Harmony without the sync endpoints.
 * Order: removals, replacements, creates, then renames and restores.
 */
export async function runBridgeSyncEmojis(
  rt: BridgeRuntime,
  command: ChatInputCommandInteraction,
  opts: { mode?: SyncMode } = {},
) {
  const mode = (opts.mode ?? command.options.getString('mode', false) ?? DEFAULT_SYNC_MODE) as SyncMode
  const dryRun = command.options.getBoolean('dry_run', false) ?? false
  await command.deferReply({ flags: MessageFlags.Ephemeral })

  const guild = command.guild!
  const bridge = rt.dir.getBridgeForDiscordGuild(guild.id)
  if (!bridge) {
    await command.editReply({ content: notBridgedText(rt) })
    return
  }
  const serverId = bridge.harmonyServerId
  // One lock for sync-emojis and import-emojis: both write the same rows.
  await withSyncLock(command, `emojis:${serverId}`, () => syncEmojis(rt, command, serverId, mode, dryRun, opts.mode !== undefined))
}

async function syncEmojis(rt: BridgeRuntime, command: ChatInputCommandInteraction, serverId: string, mode: SyncMode, dryRun: boolean, shortcut: boolean) {
  const guild = command.guild!
  const say = (content: string) => command.editReply({ content, components: [] })

  /** Reads both sides and plans. Null after replying, when a side cannot be read. */
  const prepare = async () => {
    let state
    try {
      state = await rt.harmony.getEmojiSyncState(serverId)
    } catch (err) {
      if (err instanceof HarmonyHttpError && err.status === 404) {
        if (shortcut) await runBridgeImportEmojisLegacy(rt, command, true)
        else await say('❌ Emoji sync needs Harmony 1.9.7 or later.')
        return null
      }
      const text = listErrorText(err, 'emoji')
      if (!text) throw err
      await say(text)
      return null
    }

    let fetched
    try {
      fetched = [...(await guild.emojis.fetch()).values()]
    } catch (err) {
      await say(`❌ Could not read the Discord emoji: ${errorText(err)}`)
      return null
    }
    // Present on Discord without being synced: unavailable, or no usable name.
    const presentIds: string[] = []
    const discord: DesiredEmoji[] = []
    for (const e of fetched) {
      const d = e.available === false ? null : desiredEmoji({ id: e.id, name: e.name, animated: e.animated === true, available: true })
      if (d) discord.push(d)
      else presentIds.push(e.id)
    }
    discord.sort(byDiscordId)

    const rawPlan = planSync({
      mode,
      discord,
      presentIds,
      harmony: state.emojis.map(harmonyEmojiSyncItem),
      differs: emojiDiffers,
      limit: state.limit,
      uniqueNames: true,
    })
    // A clash report already covers an emoji the planner also wanted to rename.
    const clashing = new Set(rawPlan.conflict.map(c => c.discord.id))
    const plan = { ...rawPlan, update: rawPlan.update.filter(u => !clashing.has(u.discord.id)) }
    return { plan, limit: state.limit, discordEmpty: fetched.length === 0 }
  }

  const first = await prepare()
  if (!first) return
  let { plan, limit } = first
  type Plan = typeof plan
  const limitHint = '  An instance admin can raise "max custom emojis per server", then run this again.'
  const reportOpts = { label: (n: string) => `:${n}:`, noun: 'emoji', nounPlural: 'emoji', limitHint, removeVerb: { dry: 'Would remove', real: 'Remove' } }

  if (dryRun) {
    await say(joinLinesWithinDiscordLimit([
      `🧪 **Dry run** (${mode}) for **${guild.name}**`,
      ...syncReportLines(plan, { ...reportOpts, dryRun: true }),
    ]))
    return
  }

  const removalsOf = (p: Plan) => [...p.delete, ...p.replace.flatMap(r => r.harmony)]
  if (removalsOf(plan).length + plan.add.length + plan.update.length + plan.restore.length === 0) {
    const left = plan.conflict.length + plan.outdated + plan.overLimit.length + plan.duplicate.length + plan.keptRemoved.length + plan.kept.length > 0
    await say(left
      ? joinLinesWithinDiscordLimit([
        `${plan.conflict.length > 0 ? '⚠️' : '✅'} Nothing to apply (${mode}) for **${guild.name}**`,
        ...syncReportLines(plan, { ...reportOpts, dryRun: false }),
      ])
      : '✅ Emoji already match.')
    return
  }

  const removals = removalsOf(plan)
  if (removals.length > 0) {
    const n = removals.length
    const tail = 'Removed emoji stay in old messages; an instance administrator can restore them. Confirm?'
    const warning = first.discordEmpty
      ? `⚠️ This Discord server has no emoji. This removes all ${n} Harmony emoji the bridge imported. ${tail}`
      : `⚠️ This removes ${n} Harmony emoji the bridge imported. ${tail}`
    const prompt = joinLinesWithinDiscordLimit(syncConfirmLines(plan, { ...reportOpts, warning }))
    if (!(await confirmAction(command, prompt, undefined, rt.log))) return
    // Both sides can change during the wait. The fresh plan may remove only what was confirmed.
    const fresh = await prepare()
    if (!fresh) return
    const confirmed = new Set(removals.map(r => r.id))
    if (removalsOf(fresh.plan).some(r => !confirmed.has(r.id))) {
      await say('❌ The emoji changed while this waited for an answer. Nothing changed; run it again.')
      return
    }
    plan = fresh.plan
    limit = fresh.limit
  }

  const failures: string[] = []
  const keptByHarmony: string[] = []
  const leftRemoved: string[] = plan.keptRemoved.map(k => k.discord.name)
  const errorLine = (err: unknown): string => {
    if (err instanceof HarmonyHttpError && err.code === 'EMOJI_LIMIT') return `the Harmony emoji list is full (${limit} per server)`
    if (err instanceof HarmonyHttpError && err.code === 'EMOJI_NAME_TAKEN') return 'name already used by another Harmony emoji'
    return errorText(err)
  }
  const counts = { removed: 0, created: 0, linked: 0, existing: 0, renamed: 0, restored: 0, replaced: 0 }

  const remove = (h: { id: string }) => tryRemoval(() => rt.harmony.removeServerEmoji(serverId, h.id), 'EMOJI_NOT_LINKED')
  for (const h of plan.delete) {
    const result = await remove(h)
    if (result === 'gone') counts.removed++
    else if (result === 'kept') keptByHarmony.push(h.name)
    else failures.push(`:${h.name}: ${errorLine(result.error)}`)
  }
  // Names are unique on Harmony, so the old emoji goes before its replacement is created.
  const blocked = new Set<string>()
  for (const r of plan.replace) {
    for (const h of r.harmony) {
      const result = await remove(h)
      if (result === 'gone') continue
      blocked.add(r.discord.id)
      if (result === 'kept') keptByHarmony.push(h.name)
      else failures.push(`:${r.discord.name}: not replaced, removing the old Harmony emoji failed: ${errorLine(result.error)}`)
    }
  }
  const send = (d: DesiredEmoji, update: boolean) =>
    rt.harmony.importDiscordEmoji(serverId, { discordEmojiId: d.id, name: d.name, animated: d.animated }, update)
  const create = async (d: DesiredEmoji, replacing: boolean) => {
    try {
      const row = await send(d, false)
      if (row?.status === 'existing') counts.existing++
      else if (row?.status === 'linked') counts.linked++
      else if (replacing) counts.replaced++
      else counts.created++
    } catch (err) {
      failures.push(replacing
        ? `:${d.name}: the old Harmony emoji was removed but the Discord one could not be copied (${errorLine(err)}); an instance administrator can restore the old one`
        : `:${d.name}: ${errorLine(err)}`)
    }
  }
  for (const r of plan.replace) {
    if (!blocked.has(r.discord.id)) await create(r.discord, true)
  }
  for (const d of plan.add) await create(d, false)
  /** Rename or restore. EMOJI_REMOVED: a person removed the emoji, and it stays removed. */
  const update = async (d: DesiredEmoji, count: 'renamed' | 'restored') => {
    try {
      const row = await send(d, true)
      if (row?.status === 'existing') counts.existing++
      else counts[count]++
    } catch (err) {
      if (isRefusal(err, 'EMOJI_REMOVED')) leftRemoved.push(d.name)
      else failures.push(`:${d.name}: ${errorLine(err)}`)
    }
  }
  for (const { discord: d } of plan.update) await update(d, 'renamed')
  for (const { discord: d } of plan.restore) await update(d, 'restored')

  try {
    rt.emojiLinks.replace(serverId, await rt.harmony.getServerEmojis(serverId))
  } catch (err) {
    rt.log.warn(`Could not refresh emoji links after sync: ${errorText(err)}`)
  }

  const kept = plan.kept.length + keptByHarmony.length
  rt.log.info(`/bridge ${shortcut ? 'import-emojis' : 'sync-emojis'} (${mode}) by ${command.user.id} in guild ${guild.id}: added ${counts.created}, linked ${counts.linked}, renamed ${counts.renamed}, restored ${counts.restored}, replaced ${counts.replaced}, removed ${counts.removed}, kept ${kept}, failed ${failures.length}`)

  const label = (n: string) => `:${n}:`
  const lines = [
    failures.length > 0
      ? `⚠️ Emoji sync finished with ${failures.length} failure(s) (${mode}) for **${guild.name}**`
      : `✅ Emoji sync (${mode}) for **${guild.name}**`,
    `• Added: ${counts.created}`,
    `• Renamed: ${counts.renamed}`,
    `• Restored: ${counts.restored}`,
    ...(plan.replace.length > 0 ? [`• Replaced (same name, copied from a deleted Discord one): ${counts.replaced}`] : []),
    `• Removed: ${counts.removed}`,
    ...(counts.linked > 0 ? [`• Linked to a Harmony emoji with the same name: ${counts.linked}`] : []),
    ...(counts.existing > 0 ? [`• Already there: ${counts.existing}`] : []),
    ...(kept > 0 ? [`• Kept (not imported by the bridge): ${kept}`] : []),
    ...(leftRemoved.length > 0 ? [`• Left removed (a person removed them on Harmony): ${leftRemoved.length}`] : []),
    ...(plan.outdated > 0 ? [`• Not updated (add mode): ${plan.outdated}; use merge or mirror to update`] : []),
  ]
  if (plan.overLimit.length > 0) {
    lines.push(...namedList(`⚠️ ${plan.overLimit.length} skipped: limit reached (${plan.limit} per server)`, plan.overLimit.map(d => d.name), label), limitHint)
  }
  lines.push(...namedList(`⚠️ ${plan.duplicate.length} skipped: another emoji on Discord has the same name`, plan.duplicate.map(d => d.name), label))
  if (plan.conflict.length > 0) {
    lines.push(...namedList(`⚠️ ${plan.conflict.length} name clash(es), left as they are:`, plan.conflict.map(c => c.discord.name), label), CONFLICT_HINT)
  }
  lines.push(...namedList(`⚠️ ${failures.length} failure(s):`, failures, n => n, 15))
  await say(joinLinesWithinDiscordLimit(lines))
}

const STICKER_FILE_REASONS: Record<string, string> = {
  lottie: 'Lottie sticker',
  type: 'unsupported image',
  size: 'over 512 KB',
  dimensions: 'over 320 × 320',
  duration: 'animation over 5 s',
}

/**
 * `/bridge sync-stickers`: copies the guild's stickers to Harmony, like `sync-emojis`. Mirror
 * also retires the stickers copied from a Discord sticker that is gone (asks Confirm first); a
 * sticker a member uploaded is never retired or replaced.
 * Lottie stickers, too-short names and files Harmony refuses are reported as skipped, not failed.
 */
export async function runBridgeSyncStickers(rt: BridgeRuntime, command: ChatInputCommandInteraction) {
  const mode = (command.options.getString('mode', false) ?? DEFAULT_SYNC_MODE) as SyncMode
  const dryRun = command.options.getBoolean('dry_run', false) ?? false
  await command.deferReply({ flags: MessageFlags.Ephemeral })

  const guild = command.guild!
  const bridge = rt.dir.getBridgeForDiscordGuild(guild.id)
  if (!bridge) {
    await command.editReply({ content: notBridgedText(rt) })
    return
  }
  const serverId = bridge.harmonyServerId
  await withSyncLock(command, `stickers:${serverId}`, () => syncStickers(rt, command, serverId, mode, dryRun))
}

async function syncStickers(rt: BridgeRuntime, command: ChatInputCommandInteraction, serverId: string, mode: SyncMode, dryRun: boolean) {
  const guild = command.guild!
  const say = (content: string) => command.editReply({ content, components: [] })

  /** Reads both sides and plans. Null after replying, when a side cannot be read. */
  const prepare = async () => {
    let state
    try {
      state = await rt.harmony.getStickerSyncState(serverId)
    } catch (err) {
      if (err instanceof HarmonyHttpError && err.status === 404) {
        await say('❌ Sticker sync needs Harmony 1.9.7 or later.')
        return null
      }
      const text = listErrorText(err, 'sticker')
      if (!text) throw err
      await say(text)
      return null
    }
    if (state.limit === 0) {
      await say('❌ Server stickers are turned off on this Harmony instance (max stickers per server is 0).')
      return null
    }

    let fetched
    try {
      fetched = [...(await guild.stickers.fetch()).values()]
    } catch (err) {
      await say(`❌ Could not read the Discord stickers: ${errorText(err)}`)
      return null
    }
    const presentIds = fetched.filter(s => s.available === false).map(s => s.id)
    const discord: DesiredSticker[] = []
    const skips: StickerSkip[] = []
    for (const s of fetched) {
      if (s.available === false) continue
      const d = desiredSticker({ id: s.id, name: s.name, description: s.description, formatType: Number(s.format), available: true })
      if (isStickerSkip(d)) {
        skips.push(d)
        presentIds.push(d.id)
      } else {
        discord.push(d)
      }
    }
    discord.sort(byDiscordId)

    const rawPlan = planSync({
      mode,
      discord,
      presentIds,
      harmony: state.stickers.map(harmonyStickerSyncItem),
      differs: stickerDiffers,
      limit: state.limit,
      uniqueNames: true,
    })
    const clashing = new Set(rawPlan.conflict.map(c => c.discord.id))
    const plan = { ...rawPlan, update: rawPlan.update.filter(u => !clashing.has(u.discord.id)) }
    return { plan, skips, limit: state.limit, discordEmpty: fetched.length === 0 }
  }

  const first = await prepare()
  if (!first) return
  let { plan, skips, limit } = first
  type Plan = typeof plan
  const limitHint = '  An instance admin can raise "max stickers per server", then run this again.'
  const label = (n: string) => `"${n}"`
  const reportOpts = { label, noun: 'sticker', nounPlural: 'stickers', limitHint, removeVerb: { dry: 'Would remove', real: 'Remove' } }

  const fileSkips: Array<{ name: string; reason: string }> = []
  const skipLines = (): string[] => {
    const q = (x: { id: string; name: string }) => `"${x.name || x.id}"`
    const out: string[] = []
    const lottie = skips.filter(x => x.reason === 'lottie')
    const short = skips.filter(x => x.reason === 'name')
    if (lottie.length > 0) out.push(`• Skipped ${lottie.length}: Lottie stickers can't be copied (${lottie.map(q).join(', ')})`)
    if (short.length > 0) out.push(`• Skipped ${short.length}: name too short (${short.map(q).join(', ')})`)
    if (fileSkips.length > 0) out.push(`• Skipped ${fileSkips.length}: can't be copied (${fileSkips.map(x => `"${x.name}": ${x.reason}`).join(', ')})`)
    return out
  }

  if (dryRun) {
    await say(joinLinesWithinDiscordLimit([
      `🧪 **Dry run** (${mode}) for **${guild.name}**`,
      ...syncReportLines(plan, { ...reportOpts, dryRun: true }),
      ...skipLines(),
    ]))
    return
  }

  const removalsOf = (p: Plan) => [...p.delete, ...p.replace.flatMap(r => r.harmony)]
  if (removalsOf(plan).length + plan.add.length + plan.update.length + plan.restore.length === 0) {
    const left = plan.conflict.length + plan.outdated + plan.overLimit.length + plan.duplicate.length + plan.keptRemoved.length + plan.kept.length + skips.length > 0
    await say(left
      ? joinLinesWithinDiscordLimit([
        `${plan.conflict.length > 0 ? '⚠️' : '✅'} Nothing to apply (${mode}) for **${guild.name}**`,
        ...syncReportLines(plan, { ...reportOpts, dryRun: false }),
        ...skipLines(),
      ])
      : '✅ Stickers already match.')
    return
  }

  const removals = removalsOf(plan)
  if (removals.length > 0) {
    const n = removals.length
    const tail = 'Removed stickers leave the sticker list. Old messages keep showing them. Confirm?'
    const warning = first.discordEmpty
      ? `⚠️ This Discord server has no stickers. This removes all ${n} Harmony sticker${n === 1 ? '' : 's'} copied from Discord. ${tail}`
      : `⚠️ This removes ${n} Harmony sticker${n === 1 ? '' : 's'} copied from Discord. ${tail}`
    const prompt = joinLinesWithinDiscordLimit(syncConfirmLines(plan, { ...reportOpts, warning }))
    if (!(await confirmAction(command, prompt, undefined, rt.log))) return
    // Both sides can change during the wait. The fresh plan may remove only what was confirmed.
    const fresh = await prepare()
    if (!fresh) return
    const confirmed = new Set(removals.map(r => r.id))
    if (removalsOf(fresh.plan).some(r => !confirmed.has(r.id))) {
      await say('❌ The stickers changed while this waited for an answer. Nothing changed; run it again.')
      return
    }
    plan = fresh.plan
    skips = fresh.skips
    limit = fresh.limit
  }

  const failures: string[] = []
  const keptByHarmony: string[] = []
  const fail = (d: { name: string }, err: unknown, afterRemoval = false) => {
    let fileReason: string | null = null
    if (err instanceof HarmonyHttpError && err.status === 422 && err.code === 'STICKER_FILE') {
      const reason = String(err.details.reason ?? '')
      fileReason = STICKER_FILE_REASONS[reason] ?? (reason || errorText(err))
      if (!afterRemoval) {
        fileSkips.push({ name: d.name, reason: fileReason })
        return
      }
    }
    let text: string
    if (fileReason !== null) {
      text = fileReason
    } else if (err instanceof HarmonyHttpError && err.code === 'STICKER_LIMIT') {
      text = `the Harmony sticker list is full (${limit} per server)`
    } else if (err instanceof HarmonyHttpError && err.code === 'STICKER_NAME_TAKEN') {
      text = 'name already used by another Harmony sticker'
    } else {
      text = errorText(err)
    }
    failures.push(afterRemoval
      ? `"${d.name}": the old Harmony sticker was removed but the Discord one could not be copied (${text})`
      : `"${d.name}": ${text}`)
  }
  const counts = { removed: 0, created: 0, existing: 0, updated: 0, restored: 0, replaced: 0 }

  const remove = (h: { id: string }) => tryRemoval(() => rt.harmony.removeServerSticker(serverId, h.id), 'STICKER_NOT_LINKED')
  for (const h of plan.delete) {
    const result = await remove(h)
    if (result === 'gone') counts.removed++
    else if (result === 'kept') keptByHarmony.push(h.name)
    else fail(h, result.error)
  }
  // Names are unique on Harmony, so the old sticker goes before its replacement is created.
  const blocked = new Set<string>()
  for (const r of plan.replace) {
    for (const h of r.harmony) {
      const result = await remove(h)
      if (result === 'gone') continue
      blocked.add(r.discord.id)
      if (result === 'kept') keptByHarmony.push(h.name)
      else failures.push(`"${r.discord.name}": not replaced, removing the old Harmony sticker failed: ${errorText(result.error)}`)
    }
  }
  const create = async (d: DesiredSticker, replacing: boolean) => {
    try {
      const row = await rt.harmony.importDiscordSticker(serverId, d, false)
      if (row?.status === 'existing') counts.existing++
      else if (replacing) counts.replaced++
      else counts.created++
    } catch (err) {
      fail(d, err, replacing)
    }
  }
  for (const r of plan.replace) {
    if (!blocked.has(r.discord.id)) await create(r.discord, true)
  }
  for (const d of plan.add) await create(d, false)
  const update = async (d: DesiredSticker, count: 'updated' | 'restored') => {
    try {
      const row = await rt.harmony.importDiscordSticker(serverId, d, true)
      if (row?.status === 'existing') counts.existing++
      else counts[count]++
    } catch (err) {
      fail(d, err)
    }
  }
  for (const { discord: d } of plan.update) await update(d, 'updated')
  for (const { discord: d } of plan.restore) await update(d, 'restored')

  try {
    rt.stickerLinks.replace(serverId, (await rt.harmony.getStickerSyncState(serverId)).stickers)
  } catch (err) {
    rt.log.warn(`Could not refresh sticker links after sync: ${errorText(err)}`)
  }

  const kept = plan.kept.length + keptByHarmony.length
  rt.log.info(`/bridge sync-stickers (${mode}) by ${command.user.id} in guild ${guild.id}: added ${counts.created}, updated ${counts.updated}, restored ${counts.restored}, replaced ${counts.replaced}, removed ${counts.removed}, kept ${kept}, failed ${failures.length}`)

  const lines = [
    failures.length > 0
      ? `⚠️ Sticker sync finished with ${failures.length} failure(s) (${mode}) for **${guild.name}**`
      : `✅ Sticker sync (${mode}) for **${guild.name}**`,
    `• Added: ${counts.created}`,
    `• Updated: ${counts.updated}`,
    `• Restored: ${counts.restored}`,
    ...(plan.replace.length > 0 ? [`• Replaced (same name, copied from a deleted Discord one): ${counts.replaced}`] : []),
    `• Removed: ${counts.removed}`,
    ...(counts.existing > 0 ? [`• Already there: ${counts.existing}`] : []),
    ...(kept > 0 ? [`• Kept (not copied from Discord): ${kept}`] : []),
    ...(plan.outdated > 0 ? [`• Not updated (add mode): ${plan.outdated}; use merge or mirror to update`] : []),
    ...skipLines(),
  ]
  if (plan.overLimit.length > 0) {
    lines.push(...namedList(`⚠️ ${plan.overLimit.length} skipped: limit reached (${plan.limit} per server)`, plan.overLimit.map(d => d.name), label), limitHint)
  }
  lines.push(...namedList(`⚠️ ${plan.duplicate.length} skipped: another sticker on Discord has the same name`, plan.duplicate.map(d => d.name), label))
  if (plan.conflict.length > 0) {
    lines.push(...namedList(`⚠️ ${plan.conflict.length} name clash(es), left as they are:`, plan.conflict.map(c => c.discord.name), label), CONFLICT_HINT)
  }
  lines.push(...namedList(`⚠️ ${failures.length} failure(s):`, failures, n => n, 15))
  await say(joinLinesWithinDiscordLimit(lines))
}
