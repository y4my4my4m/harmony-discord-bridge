import { PermissionFlagsBits, type Role as DiscordRole } from 'discord.js'

// Discord permission flag -> Harmony permission name. Bit positions are resolved by name
// from the Harmony instance's /config `permission_bits` (index = bit position).
// ADMINISTRATOR is omitted: the gateway strips it on write.
export const DISCORD_TO_HARMONY_PERMISSION: [bigint, string][] = [
  [PermissionFlagsBits.ViewChannel, 'VIEW_CHANNEL'],
  [PermissionFlagsBits.ManageChannels, 'MANAGE_CHANNELS'],
  [PermissionFlagsBits.ManageRoles, 'MANAGE_ROLES'],
  [PermissionFlagsBits.ManageGuildExpressions, 'MANAGE_EMOJIS'],
  [PermissionFlagsBits.ViewAuditLog, 'VIEW_AUDIT_LOG'],
  [PermissionFlagsBits.ManageWebhooks, 'MANAGE_WEBHOOKS'],
  [PermissionFlagsBits.ManageGuild, 'MANAGE_SERVER'],
  [PermissionFlagsBits.CreateInstantInvite, 'CREATE_INVITE'],
  [PermissionFlagsBits.KickMembers, 'KICK_MEMBERS'],
  [PermissionFlagsBits.BanMembers, 'BAN_MEMBERS'],
  [PermissionFlagsBits.ModerateMembers, 'TIMEOUT_MEMBERS'],
  [PermissionFlagsBits.SendMessages, 'SEND_MESSAGES'],
  [PermissionFlagsBits.SendMessagesInThreads, 'SEND_MESSAGES_IN_THREADS'],
  [PermissionFlagsBits.CreatePublicThreads, 'CREATE_PUBLIC_THREADS'],
  [PermissionFlagsBits.CreatePrivateThreads, 'CREATE_PRIVATE_THREADS'],
  [PermissionFlagsBits.EmbedLinks, 'EMBED_LINKS'],
  [PermissionFlagsBits.AttachFiles, 'ATTACH_FILES'],
  [PermissionFlagsBits.AddReactions, 'ADD_REACTIONS'],
  [PermissionFlagsBits.UseExternalEmojis, 'USE_EXTERNAL_EMOJIS'],
  [PermissionFlagsBits.MentionEveryone, 'MENTION_EVERYONE'],
  [PermissionFlagsBits.ManageMessages, 'MANAGE_MESSAGES'],
  [PermissionFlagsBits.ReadMessageHistory, 'READ_MESSAGE_HISTORY'],
  [PermissionFlagsBits.PinMessages, 'PIN_MESSAGES'],
  [PermissionFlagsBits.Connect, 'CONNECT'],
  [PermissionFlagsBits.Speak, 'SPEAK'],
  [PermissionFlagsBits.Stream, 'STREAM'],
  [PermissionFlagsBits.MuteMembers, 'MUTE_MEMBERS'],
  [PermissionFlagsBits.DeafenMembers, 'DEAFEN_MEMBERS'],
  [PermissionFlagsBits.MoveMembers, 'MOVE_MEMBERS'],
  [PermissionFlagsBits.UseSoundboard, 'USE_SOUNDBOARD'],
  [PermissionFlagsBits.UseExternalSounds, 'USE_EXTERNAL_SOUNDS'],
  [PermissionFlagsBits.ChangeNickname, 'CHANGE_NICKNAME'],
  [PermissionFlagsBits.ManageNicknames, 'MANAGE_NICKNAMES'],
]

/** Harmony bit order (positions 0-31) used when /config has no `permission_bits`. */
const LEGACY_HARMONY_PERMISSION_BITS: string[] = [
  'ADMINISTRATOR',
  'VIEW_CHANNEL',
  'MANAGE_CHANNELS',
  'MANAGE_ROLES',
  'MANAGE_EMOJIS',
  'VIEW_AUDIT_LOG',
  'MANAGE_WEBHOOKS',
  'MANAGE_SERVER',
  'CREATE_INVITE',
  'KICK_MEMBERS',
  'BAN_MEMBERS',
  'TIMEOUT_MEMBERS',
  'SEND_MESSAGES',
  'SEND_MESSAGES_IN_THREADS',
  'CREATE_PUBLIC_THREADS',
  'CREATE_PRIVATE_THREADS',
  'EMBED_LINKS',
  'ATTACH_FILES',
  'ADD_REACTIONS',
  'USE_EXTERNAL_EMOJIS',
  'MENTION_EVERYONE',
  'MANAGE_MESSAGES',
  'READ_MESSAGE_HISTORY',
  'PIN_MESSAGES',
  'CONNECT',
  'SPEAK',
  'STREAM',
  'MUTE_MEMBERS',
  'DEAFEN_MEMBERS',
  'MOVE_MEMBERS',
  'USE_SOUNDBOARD',
  'USE_EXTERNAL_SOUNDS',
]

function buildPositions(names: string[]): Map<string, number> {
  const map = new Map<string, number>()
  names.forEach((name, i) => { if (!map.has(name)) map.set(name, i) })
  return map
}

let positionByName = buildPositions(LEGACY_HARMONY_PERMISSION_BITS)

/** Set the Harmony permission names (index = bit position); null restores the legacy list. */
export function setHarmonyPermissionBits(names: string[] | null): void {
  positionByName = buildPositions(names ?? LEGACY_HARMONY_PERMISSION_BITS)
}

/** Map a Discord permission bitfield to a Harmony bigint bitmask string. */
export function discordBitfieldToHarmonyMask(discordBits: bigint): string {
  let mask = 0n
  for (const [discordFlag, name] of DISCORD_TO_HARMONY_PERMISSION) {
    if ((discordBits & discordFlag) !== discordFlag) continue
    const bit = positionByName.get(name)
    if (bit !== undefined) mask |= 1n << BigInt(bit)
  }
  return mask.toString()
}

export function discordRoleToHarmonyPermissions(role: DiscordRole): string {
  return discordBitfieldToHarmonyMask(role.permissions.bitfield)
}

export function discordOverwriteToHarmonyMasks(allow: bigint, deny: bigint): {
  allow: string
  deny: string
} {
  return {
    allow: discordBitfieldToHarmonyMask(allow),
    deny: discordBitfieldToHarmonyMask(deny),
  }
}

export function discordColorToHex(color: number): string | null {
  if (!color) return null
  return `#${color.toString(16).padStart(6, '0')}`
}
