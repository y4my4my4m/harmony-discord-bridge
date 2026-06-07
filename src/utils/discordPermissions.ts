import { PermissionFlagsBits, type Role as DiscordRole } from 'discord.js'

// Discord permission flag -> Harmony permission bit position (RoleService PERMISSION_BITS).
// ADMINISTRATOR (bit 0) is omitted — gateway strips it on write.
export const DISCORD_TO_HARMONY_PERMISSION_BITS: [bigint, number][] = [
  [PermissionFlagsBits.ViewChannel, 1],
  [PermissionFlagsBits.ManageChannels, 2],
  [PermissionFlagsBits.ManageRoles, 3],
  [PermissionFlagsBits.ManageGuildExpressions, 4],
  [PermissionFlagsBits.ViewAuditLog, 5],
  [PermissionFlagsBits.ManageWebhooks, 6],
  [PermissionFlagsBits.ManageGuild, 7],
  [PermissionFlagsBits.CreateInstantInvite, 8],
  [PermissionFlagsBits.KickMembers, 9],
  [PermissionFlagsBits.BanMembers, 10],
  [PermissionFlagsBits.ModerateMembers, 11],
  [PermissionFlagsBits.SendMessages, 12],
  [PermissionFlagsBits.SendMessagesInThreads, 13],
  [PermissionFlagsBits.CreatePublicThreads, 14],
  [PermissionFlagsBits.CreatePrivateThreads, 15],
  [PermissionFlagsBits.EmbedLinks, 16],
  [PermissionFlagsBits.AttachFiles, 17],
  [PermissionFlagsBits.AddReactions, 18],
  [PermissionFlagsBits.UseExternalEmojis, 19],
  [PermissionFlagsBits.MentionEveryone, 20],
  [PermissionFlagsBits.ManageMessages, 21],
  [PermissionFlagsBits.ReadMessageHistory, 22],
  [PermissionFlagsBits.Connect, 24],
  [PermissionFlagsBits.Speak, 25],
  [PermissionFlagsBits.Stream, 26],
  [PermissionFlagsBits.MuteMembers, 27],
  [PermissionFlagsBits.DeafenMembers, 28],
  [PermissionFlagsBits.MoveMembers, 29],
]

/** Map a Discord permission bitfield to a Harmony bigint bitmask string. */
export function discordBitfieldToHarmonyMask(discordBits: bigint): string {
  let mask = 0n
  for (const [discordFlag, harmonyBit] of DISCORD_TO_HARMONY_PERMISSION_BITS) {
    if ((discordBits & discordFlag) === discordFlag) {
      mask |= 1n << BigInt(harmonyBit)
    }
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
