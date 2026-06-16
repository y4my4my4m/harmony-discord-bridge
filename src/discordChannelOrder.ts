import { ChannelType, type Guild } from 'discord.js'
import type { HarmonyClient } from './HarmonyClient.js'

export interface DiscordCategoryPlan {
  discordId: string
  name: string
  position: number
}

export interface DiscordChannelPlan {
  discordId: string
  name: string
  harmonyType: 0 | 1
  discordCategoryId: string | null
  discordCategoryName: string | null
  position: number
}

export function buildDiscordStructurePlan(
  guild: Guild,
  includeVoice: boolean,
): { categories: DiscordCategoryPlan[]; channels: DiscordChannelPlan[] } {
  const categories: DiscordCategoryPlan[] = []
  const channels: DiscordChannelPlan[] = []

  for (const ch of guild.channels.cache.values()) {
    if (ch.type === ChannelType.GuildCategory) {
      categories.push({
        discordId: ch.id,
        name: ch.name,
        position: ch.position,
      })
      continue
    }
    if (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildVoice) continue
    if (ch.type === ChannelType.GuildVoice && !includeVoice) continue

    const parent = ch.parentId ? guild.channels.cache.get(ch.parentId) : null
    channels.push({
      discordId: ch.id,
      name: ch.name,
      harmonyType: ch.type === ChannelType.GuildVoice ? 1 : 0,
      discordCategoryId: ch.parentId ?? null,
      discordCategoryName:
        parent && parent.type === ChannelType.GuildCategory ? parent.name : null,
      position: ch.position,
    })
  }

  categories.sort((a, b) => a.position - b.position)
  channels.sort((a, b) => {
    const parentA = a.discordCategoryId ?? ''
    const parentB = b.discordCategoryId ?? ''
    if (parentA !== parentB) return parentA.localeCompare(parentB)
    return a.position - b.position
  })

  return { categories, channels }
}

/**
 * Push Discord category/channel positions (and channel parent categories) to
 * Harmony for all mapped channels. Categories are matched by name.
 */
export async function syncDiscordStructureOrderToHarmony(opts: {
  guild: Guild
  serverId: string
  harmonyClient: HarmonyClient
  getHarmonyChannelId: (discordChannelId: string) => string | null
  includeVoice?: boolean
}): Promise<{ categoriesUpdated: number; channelsUpdated: number; failures: string[] }> {
  const { guild, serverId, harmonyClient, getHarmonyChannelId } = opts
  const includeVoice = opts.includeVoice ?? true
  const failures: string[] = []
  let categoriesUpdated = 0
  let channelsUpdated = 0

  const { categories: discordCategories, channels: discordChannels } = buildDiscordStructurePlan(
    guild,
    includeVoice,
  )

  const harmonyCategories = await harmonyClient.getServerCategories(serverId).catch(() => [])
  const harmonyCategoryIdByName = new Map<string, string>(
    harmonyCategories.map((c: { id: string; name: string }) => [c.name, c.id]),
  )

  for (const cat of discordCategories) {
    const harmonyCategoryId = harmonyCategoryIdByName.get(cat.name)
    if (!harmonyCategoryId) continue
    try {
      await harmonyClient.updateCategory(serverId, harmonyCategoryId, { order: cat.position })
      categoriesUpdated++
    } catch (err: any) {
      failures.push(`category **${cat.name}**: ${err.message}`)
    }
  }

  for (const ch of discordChannels) {
    const harmonyChannelId = getHarmonyChannelId(ch.discordId)
    if (!harmonyChannelId) continue

    let harmonyCategoryId: string | null = null
    if (ch.discordCategoryName) {
      harmonyCategoryId = harmonyCategoryIdByName.get(ch.discordCategoryName) ?? null
    }

    try {
      await harmonyClient.updateChannel(harmonyChannelId, {
        order: ch.position,
        categoryId: harmonyCategoryId,
      })
      channelsUpdated++
    } catch (err: any) {
      failures.push(`#${ch.name}: ${err.message}`)
    }
  }

  return { categoriesUpdated, channelsUpdated, failures }
}
