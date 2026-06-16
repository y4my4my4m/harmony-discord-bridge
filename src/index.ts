import {
  Client as DiscordClient,
  GatewayIntentBits,
  Message as DiscordMessage,
  Webhook,
  TextChannel,
  ChannelType,
  Partials,
  GuildMember,
  SlashCommandBuilder,
  REST,
  Routes,
  Events,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  PermissionFlagsBits,
  MessageFlags,
  type Role as DiscordRole
} from 'discord.js'
import { HarmonyClient } from './HarmonyClient.js'
import { MessageTranslator } from './MessageTranslator.js'
import { ChannelMapper } from './ChannelMapper.js'
import { PermissionSync } from './PermissionSync.js'
import { PermissionSyncStore } from './PermissionSyncStore.js'
import { BoundedMap } from './utils/BoundedMap.js'
import { refreshDiscordAttachmentParts } from './refreshAttachments.js'
import {
  discordRoleToHarmonyPermissions,
  discordColorToHex,
} from './utils/discordPermissions.js'
import { joinLinesWithinDiscordLimit } from './utils/discordMessage.js'
import * as dotenv from 'dotenv'

dotenv.config()

// Initialize components
const mapper = new ChannelMapper('./config/bridge-config.yml')
const config = mapper.getConfig()

// Validate required configuration
if (!config.harmony?.baseUrl) {
  throw new Error('Configuration error: harmony.baseUrl is required in bridge-config.yml')
}

const harmonyBaseUrl = new URL(config.harmony.baseUrl)
if (!harmonyBaseUrl.hostname || harmonyBaseUrl.hostname === 'localhost') {
  console.warn('⚠️  Warning: harmony.baseUrl is set to localhost - federation mentions will use localhost domain')
}

const translator = new MessageTranslator()
translator.setHarmonyDomain(harmonyBaseUrl.hostname)

// Webhook cache for puppeting
const webhookCache = new Map<string, Webhook>()

// Message ID mappings between Discord and Harmony.
//
// Previously these were unbounded Maps that grew for the life of the
// process (one entry per bridged message, forever) - a long-running bridge
// would accumulate hundreds of thousands of entries with no eviction. The
// only operations on these maps are O(1) (set/get/delete/has) so size
// itself wasn't the perf issue; it was RSS / process longevity.
//
// 50_000 entries is enough to cover ~weeks of edit/delete activity for an
// active server. On overflow, the least-recently-used mapping is dropped -
// a dropped mapping means an edit/delete on a very old message won't be
// bridged, which is a strictly better failure mode than OOM.
const MESSAGE_MAPPING_CAP = 50_000
const discordToHarmonyMessages = new BoundedMap<string, string>(MESSAGE_MAPPING_CAP)
const harmonyToDiscordMessages = new BoundedMap<string, string>(MESSAGE_MAPPING_CAP)

// =====================================================
// DISCORD MEMBER CACHE
// =====================================================
// Cache Discord members for mention lookups: lowercase username -> Discord ID
const discordMemberCache = new Map<string, string>()
// Also store full member info for autosuggest API
interface CachedDiscordMember {
  id: string
  username: string
  displayName: string
  avatarUrl: string
}
const discordMemberDetails = new Map<string, CachedDiscordMember>()

/**
 * Get all cached Discord members (for autosuggest API)
 */
export function getDiscordMembers(): CachedDiscordMember[] {
  return Array.from(discordMemberDetails.values())
}

/**
 * Get Discord member cache for username -> ID lookups
 */
export function getDiscordMemberIdCache(): Map<string, string> {
  return discordMemberCache
}

/**
 * Add or update a member in the cache
 */
function cacheMember(member: GuildMember) {
  const username = member.user.username.toLowerCase()
  discordMemberCache.set(username, member.id)
  
  discordMemberDetails.set(member.id, {
    id: member.id,
    username: member.user.username,
    displayName: member.displayName || member.user.username,
    avatarUrl: member.user.displayAvatarURL({ size: 128 })
  })
}

/**
 * Remove a member from the cache by ID
 */
function uncacheMemberById(memberId: string, username: string) {
  discordMemberCache.delete(username.toLowerCase())
  discordMemberDetails.delete(memberId)
}

// =====================================================
// HARMONY USER CACHE (for Discord autocomplete)
// =====================================================
interface CachedHarmonyUser {
  id: string
  username: string
  displayName: string
  avatarUrl: string | null
}
const harmonyUserCache = new Map<string, CachedHarmonyUser>()
let harmonyUserCacheTimer: NodeJS.Timeout | null = null
let discordStartupDone = false

const HARMONY_USER_CACHE_REFRESH_MS = 5 * 60 * 1000

/**
 * Fetch Harmony server members for `/mention` autocomplete on Discord.
 * Runs once at startup, then every 5 minutes — not on every gateway reconnect.
 */
async function refreshHarmonyUserCache(options: { verbose?: boolean } = {}) {
  const verbose = options.verbose ?? false
  const prevSize = harmonyUserCache.size

  if (!config.harmony.serverId) {
    console.error('❌ harmony.serverId not configured in bridge-config.yml!')
    return
  }

  const url = `${config.harmony.apiUrl}/api/v1/servers/${config.harmony.serverId}/members?limit=1000`
  if (verbose) {
    console.log('🔄 Refreshing Harmony user cache...')
    console.log(`📡 Fetching from: ${url}`)
  }

  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bot ${config.harmony.token}`
      }
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('❌ Failed to fetch Harmony users:', errorText)
      return
    }

    const members = await response.json() as any[]

    harmonyUserCache.clear()

    for (const member of members) {
      if (member.user) {
        harmonyUserCache.set(member.user.id, {
          id: member.user.id,
          username: member.user.username || 'unknown',
          displayName: member.user.display_name || member.user.username || 'Unknown',
          avatarUrl: member.user.avatar || null
        })
      }
    }

    if (verbose) {
      console.log(`✅ Harmony user cache: ${harmonyUserCache.size} users`)
      const firstUsers = Array.from(harmonyUserCache.values()).slice(0, 3)
      firstUsers.forEach(u => console.log(`   👤 ${u.displayName} (@${u.username})`))
    } else if (harmonyUserCache.size !== prevSize) {
      console.log(`🔄 Harmony user cache: ${prevSize} → ${harmonyUserCache.size} users`)
    }
  } catch (error) {
    console.error('❌ Error fetching Harmony users:', error)
  }
}

/**
 * Get Harmony users matching a query (for autocomplete)
 */
function searchHarmonyUsers(query: string): CachedHarmonyUser[] {
  const lowerQuery = query.toLowerCase()
  const results: CachedHarmonyUser[] = []
  
  for (const user of harmonyUserCache.values()) {
    if (
      user.username.toLowerCase().includes(lowerQuery) ||
      user.displayName.toLowerCase().includes(lowerQuery)
    ) {
      results.push(user)
      if (results.length >= 25) break // Discord autocomplete limit
    }
  }
  
  return results
}

// Track ready states for bridge data registration
let discordReady = false
let harmonyReady = false
let harmonyStartupDone = false

/**
 * Register bridge data with the Harmony gateway
 * Called when both Discord and Harmony are ready
 */
function registerBridgeDataWithGateway() {
  if (!discordReady || !harmonyReady) {
    console.log(`⏳ Bridge data registration waiting: Discord=${discordReady}, Harmony=${harmonyReady}`)
    return
  }
  
  // Build channel data with members for each mapping
  const channels = config.channelMappings.map(mapping => ({
    harmonyChannelId: mapping.harmony,
    discordChannelId: mapping.discord,
    members: Array.from(discordMemberDetails.values()).map(m => ({
      id: m.id,
      username: m.username,
      displayName: m.displayName,
      avatarUrl: m.avatarUrl,
      source: 'discord' as const
    }))
  }))
  
  console.log('╔════════════════════════════════════════╗')
  console.log('║   🌉 Registering Bridge Data          ║')
  console.log('╠════════════════════════════════════════╣')
  console.log(`║   Channels: ${channels.length}`)
  console.log(`║   Discord Members: ${discordMemberDetails.size}`)
  channels.forEach(ch => {
    console.log(`║   📍 ${ch.harmonyChannelId.substring(0, 8)}... <-> Discord ${ch.discordChannelId}`)
  })
  console.log('╚════════════════════════════════════════╝')
  
  harmonyClient.registerBridgeData(channels)
}

// Get or create webhook for channel (for puppeting)
async function getOrCreateWebhook(channelId: string): Promise<Webhook | null> {
  try {
    // Return cached webhook
    if (webhookCache.has(channelId)) {
      return webhookCache.get(channelId)!
    }
    
    const channel = await discordClient.channels.fetch(channelId) as TextChannel
    if (!channel || !channel.isTextBased()) {
      return null
    }
    
    // Find existing Harmony Bridge webhook
    const webhooks = await channel.fetchWebhooks()
    let webhook = webhooks.find(wh => wh.name === 'Harmony Bridge')
    
    // Create if doesn't exist
    if (!webhook) {
      console.log(`🔨 Creating webhook for channel ${channelId}`)
      webhook = await channel.createWebhook({
        name: 'Harmony Bridge',
        avatar: 'https://raw.githubusercontent.com/your-repo/harmony/main/public/icon.png' // Optional: your Harmony icon
      })
    }
    
    webhookCache.set(channelId, webhook)
    return webhook
  } catch (error) {
    console.error(`❌ Failed to get/create webhook for ${channelId}:`, error)
    return null
  }
}

// (Future use: Generate unique username to avoid collisions with Discord users)
// async function generateUniqueUsername(baseUsername: string, guildId: string): Promise<string> {
//   // TODO: Implement proper collision detection with caching
//   // For now, always add -harmony suffix to avoid any potential collisions
//   // This is what Matrix-Discord bridge does too
//   return `${baseUsername} [H]`
// }

// Initialize Discord client
const discordClient = new DiscordClient({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers  // Required for member cache
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
})

// Initialize Harmony client
const harmonyClient = new HarmonyClient(
  config.harmony.token,
  config.harmony.gatewayUrl,
  config.harmony.apiUrl
)

const permissionSyncStore = new PermissionSyncStore('./data/permission-sync.yml')
const permissionSync = new PermissionSync(harmonyClient, discordClient, mapper, permissionSyncStore)

// =====================================================
// DISCORD -> HARMONY
// =====================================================

discordClient.on('messageCreate', async (msg: DiscordMessage) => {
  // Ignore bot messages
  if (msg.author.bot) return
  
  // Check if channel is mapped
  const harmonyChannelId = mapper.getHarmonyChannel(msg.channelId)
  if (!harmonyChannelId) return
  
  if (!mapper.shouldBridgeFromDiscord(msg.channelId)) return
  
  try {
    // Translate message content using MessageParts format. Attachment storage
    // policy (link/mirror) is applied server-side by the bot-gateway.
    const contentParts = translator.discordToHarmonyParts(msg)

    // Extract Discord user metadata for puppeting
    const metadata = translator.extractDiscordUserMetadata(msg)

    // Store Discord message ID in metadata for reaction mapping
    metadata.discord_message_id = msg.id

    // Reply threading: if this Discord message is a reply, look up the
    // Harmony parent via our mapping and forward as a real Harmony reply.
    // Falls back to no reply if the parent isn't in our mapping window
    // (e.g. replied to a very old message that's already evicted).
    let replyTo: string | null = null
    const discordParentId = msg.reference?.messageId
    if (discordParentId) {
      const mapped = discordToHarmonyMessages.get(discordParentId)
      if (mapped) {
        replyTo = mapped
      } else {
        console.log(`⚠️ Discord reply parent ${discordParentId} not in mapping; sending as plain message`)
      }
    }

    // Send to Harmony with MessageParts array (and reply linkage if any)
    const result = await harmonyClient.sendMessage(
      harmonyChannelId,
      contentParts,
      metadata,
      replyTo,
    )
    
    // Store message ID mapping for reactions / edits / deletes.
    // BUGS.md H36: the gateway returns the message object at top level
    // (`{ id, channel_id, author, ... }` from `BotRestAPI.formatMessage`),
    // not nested under `.message.id`. The old check meant the mapping was
    // never written, so Discord→Harmony reaction/edit/delete bridging
    // silently failed with "No message mapping found".
    const harmonyMessageId = result?.id ?? result?.message?.id
    if (harmonyMessageId) {
      discordToHarmonyMessages.set(msg.id, harmonyMessageId)
      harmonyToDiscordMessages.set(harmonyMessageId, msg.id)
      console.log(`📌 Stored message mapping: Discord ${msg.id} <-> Harmony ${harmonyMessageId}`)
    } else {
      console.warn(`⚠️ Bridged message returned no id; reaction/edit/delete sync will be skipped for Discord ${msg.id}`)
    }
    
    console.log(`✅ Discord -> Harmony: ${msg.author.username} in #${msg.channel}`)
  } catch (error) {
    console.error('❌ Failed to bridge Discord -> Harmony:', error)
  }
})

// Handle Discord reactions
discordClient.on('messageReactionAdd', async (reaction, user) => {
  // Ignore bot reactions
  if (user.bot) return
  
  // Fetch partial reaction
  if (reaction.partial) {
    try {
      await reaction.fetch()
    } catch (error) {
      console.error('❌ Failed to fetch reaction:', error)
      return
    }
  }
  
  // Check if channel is mapped
  const harmonyChannelId = mapper.getHarmonyChannel(reaction.message.channelId)
  if (!harmonyChannelId) return
  
  if (!mapper.shouldBridgeFromDiscord(reaction.message.channelId)) return
  
  // Check if syncReactions is enabled in config
  if (!config.settings.syncReactions) {
    console.log('⏭️  Reaction syncing disabled in config')
    return
  }
  
  try {
    // Get the Harmony message ID from our mapping
    const harmonyMessageId = discordToHarmonyMessages.get(reaction.message.id)
    if (!harmonyMessageId) {
      console.log(`⚠️  No message mapping found for Discord message ${reaction.message.id}`)
      return
    }
    
    // Get bot ID for emoji creation
    const botId = (harmonyClient as any).botId
    if (!botId) {
      console.error('❌ Bot ID not available')
      return
    }
    
    // Get emoji (Unicode or custom)
    let emojiIdentifier: string | null = null
    
    if (reaction.emoji.id) {
      // Custom Discord emoji - find or create it in Harmony (same as ActivityPub does)
      const emojiName = reaction.emoji.name || 'unknown'
      const isAnimated = reaction.emoji.animated || false
      console.log(`🎭 Discord custom emoji: ${emojiName} (ID: ${reaction.emoji.id}, animated: ${isAnimated})`)
      
      // Find or create the emoji in Harmony
      emojiIdentifier = await harmonyClient.findOrCreateDiscordEmoji(
        emojiName,
        reaction.emoji.id,
        isAnimated,
        botId
      )
      
      if (!emojiIdentifier) {
        console.error(`❌ Could not create/find Discord emoji: ${emojiName}`)
        return
      }
    } else {
      // Unicode emoji
      emojiIdentifier = reaction.emoji.name || ''
      console.log(`🎭 Discord Unicode emoji: ${emojiIdentifier}`)
    }
    
    if (!emojiIdentifier) {
      console.error('❌ Could not determine emoji identifier')
      return
    }
    
    // Prepare Discord user metadata for attribution
    const reactionMetadata = {
      discord_user: {
        id: user.id,
        username: user.username,
        discriminator: user.discriminator,
        display_name: user.globalName || user.username,
        avatar_url: user.displayAvatarURL({ size: 128 })
      },
      bridge_source: 'discord'
    }
    
    // Add reaction to Harmony message with Discord user metadata
    await harmonyClient.addReaction(harmonyChannelId, harmonyMessageId, emojiIdentifier, reactionMetadata)
    console.log(`✅ Discord -> Harmony reaction: ${emojiIdentifier} on message ${harmonyMessageId}`)
  } catch (error: any) {
    console.error('❌ Failed to bridge reaction Discord -> Harmony:', error.message)
  }
})

discordClient.on('messageReactionRemove', async (reaction, user) => {
  // Ignore bot reactions
  if (user.bot) return
  
  // Fetch partial reaction
  if (reaction.partial) {
    try {
      await reaction.fetch()
    } catch (error) {
      console.error('❌ Failed to fetch reaction:', error)
      return
    }
  }
  
  // Check if channel is mapped
  const harmonyChannelId = mapper.getHarmonyChannel(reaction.message.channelId)
  if (!harmonyChannelId) return
  
  if (!mapper.shouldBridgeFromDiscord(reaction.message.channelId)) return
  
  // Check if syncReactions is enabled in config
  if (!config.settings.syncReactions) {
    console.log('⏭️  Reaction syncing disabled in config')
    return
  }
  
  try {
    // Get the Harmony message ID from our mapping
    const harmonyMessageId = discordToHarmonyMessages.get(reaction.message.id)
    if (!harmonyMessageId) {
      console.log(`⚠️  No message mapping found for Discord message ${reaction.message.id}`)
      return
    }
    
    // Get bot ID for emoji lookup
    const botId = (harmonyClient as any).botId
    if (!botId) {
      console.error('❌ Bot ID not available')
      return
    }
    
    // Get emoji (Unicode or custom)
    let emojiIdentifier: string | null = null
    
    if (reaction.emoji.id) {
      // Custom Discord emoji - need to look it up in Harmony (same as add)
      const emojiName = reaction.emoji.name || 'unknown'
      const isAnimated = reaction.emoji.animated || false
      console.log(`🎭 Discord custom emoji: ${emojiName} (ID: ${reaction.emoji.id})`)
      
      // Find the emoji in Harmony (should already exist from when it was added)
      emojiIdentifier = await harmonyClient.findOrCreateDiscordEmoji(
        emojiName,
        reaction.emoji.id,
        isAnimated,
        botId
      )
      
      if (!emojiIdentifier) {
        console.error(`❌ Could not find Discord emoji: ${emojiName}`)
        return
      }
    } else {
      // Unicode emoji
      emojiIdentifier = reaction.emoji.name || ''
      console.log(`🎭 Discord Unicode emoji: ${emojiIdentifier}`)
    }
    
    if (!emojiIdentifier) {
      console.error('❌ Could not determine emoji identifier')
      return
    }
    
    // Remove reaction from Harmony message
    await harmonyClient.removeReaction(harmonyChannelId, harmonyMessageId, emojiIdentifier)
    console.log(`✅ Discord -> Harmony reaction removed: ${emojiIdentifier} from message ${harmonyMessageId}`)
  } catch (error: any) {
    console.error('❌ Failed to bridge reaction removal Discord -> Harmony:', error.message)
  }
})

// Handle Discord message edits
if (config.settings.syncEdits) {
  discordClient.on('messageUpdate', async (oldMsg, newMsg) => {
    if (!newMsg.author || newMsg.author.bot) return
    
    const harmonyChannelId = mapper.getHarmonyChannel(newMsg.channelId)
    if (!harmonyChannelId) return
    
    try {
      // Get Harmony message ID from mapping
      const harmonyMessageId = discordToHarmonyMessages.get(newMsg.id)
      if (!harmonyMessageId) {
        console.log(`⚠️  No message mapping found for Discord message ${newMsg.id}`)
        return
      }
      
      // Translate the new content (attachment policy applied server-side)
      const contentParts = translator.discordToHarmonyParts(newMsg)

      await harmonyClient.editMessage(harmonyMessageId, contentParts)
      console.log(`✅ Discord -> Harmony edit: Message ${harmonyMessageId}`)
    } catch (error) {
      console.error('❌ Failed to bridge edit Discord -> Harmony:', error)
    }
  })
}

// Handle Discord message deletes
if (config.settings.syncDeletes) {
  discordClient.on('messageDelete', async (msg) => {
    if (msg.author?.bot) return
    
    const harmonyChannelId = mapper.getHarmonyChannel(msg.channelId)
    if (!harmonyChannelId) return
    
    try {
      // Get Harmony message ID from mapping
      const harmonyMessageId = discordToHarmonyMessages.get(msg.id)
      if (!harmonyMessageId) {
        console.log(`⚠️  No message mapping found for Discord message ${msg.id}`)
        return
      }
      
      // Delete the message in Harmony
      await harmonyClient.deleteMessage(harmonyMessageId)
      console.log(`✅ Discord -> Harmony delete: Message ${harmonyMessageId}`)
      
      // Clean up mapping
      discordToHarmonyMessages.delete(msg.id)
      harmonyToDiscordMessages.delete(harmonyMessageId)
    } catch (error) {
      console.error('❌ Failed to bridge delete Discord -> Harmony:', error)
    }
  })
}

// =====================================================
// HARMONY -> DISCORD
// =====================================================

harmonyClient.on('ready', async (data: any) => {
  console.log(`✅ Harmony bot connected: ${data.bot.username} (${data.bot.id})`);

  (harmonyClient as any).botId = data.bot.id;

  // Harmony gateway reconnects re-emit READY — only restore mappings once.
  if (!harmonyStartupDone) {
    harmonyStartupDone = true

    for (const mapping of config.channelMappings) {
      console.log(`📡 Subscribing to Harmony channel: ${mapping.name || mapping.harmony}`);

      try {
        console.log(`📥 Loading recent messages from ${mapping.name || mapping.harmony}...`);
        const recentMessages = await harmonyClient.loadRecentMessages(mapping.harmony, 100);

        let restoredCount = 0;
        for (const msg of recentMessages) {
          if (msg.metadata?.discord_message_id && msg.id) {
            const discordMsgId = msg.metadata.discord_message_id;
            discordToHarmonyMessages.set(discordMsgId, msg.id);
            harmonyToDiscordMessages.set(msg.id, discordMsgId);
            restoredCount++;
          }
        }

        if (restoredCount > 0) {
          console.log(`✅ Restored ${restoredCount} message mappings from ${mapping.name || mapping.harmony}`);
        }
      } catch (error) {
        console.error(`❌ Failed to load recent messages from ${mapping.name || mapping.harmony}:`, error);
      }
    }
  } else {
    console.log('↳ Harmony gateway reconnected (skipping message mapping restore)')
  }

  harmonyReady = true
  registerBridgeDataWithGateway()
});

harmonyClient.on('messageCreate', async (msg: any) => {
  console.log(`📨 Received Harmony message:`, {
    author: msg.author?.username,
    authorId: msg.author?.id,
    avatar: msg.author?.avatar,
    isBot: msg.author?.bot,
    bridge_source: msg.metadata?.bridge_source,
    discord_message_id: msg.metadata?.discord_message_id,
    channelId: msg.channel_id,
    content: msg.content,
    content_raw: msg.content_raw
  });
  
  // If this message came from Discord and has the Discord message ID in metadata, store the mapping
  if (msg.metadata?.discord_message_id && msg.id) {
    const discordMsgId = msg.metadata.discord_message_id
    discordToHarmonyMessages.set(discordMsgId, msg.id)
    harmonyToDiscordMessages.set(msg.id, discordMsgId)
    console.log(`📌 Restored message mapping from metadata: Discord ${discordMsgId} <-> Harmony ${msg.id}`)
  }
  
  // Don't bridge messages that came from Discord (prevent loops!)
  if (msg.metadata?.bridge_source === 'discord') {
    console.log('⏭️  Skipping message from Discord (preventing loop)')
    return
  }
  
  // Don't bridge messages from this bot (avoid loops)
  const botId = (harmonyClient as any).botId
  if (msg.author?.id === botId) {
    console.log('⏭️  Skipping own message')
    return
  }
  
  // Don't bridge other bot messages (except Discord users)
  if (msg.author?.bot && !msg.author?.discord_user) {
    console.log('⏭️  Skipping bot message')
    return
  }
  
  // Check if channel is mapped
  const discordChannelId = mapper.getDiscordChannel(msg.channel_id)
  if (!discordChannelId) {
    console.log('⏭️  Channel not mapped')
    return
  }
  
  console.log(`📍 Mapped to Discord channel: ${discordChannelId}`);
  
  if (!mapper.shouldBridgeFromHarmony(msg.channel_id)) {
    console.log('⏭️  Bridging disabled for this channel')
    return
  }
  
  try {
    console.log(`🔨 Fetching Discord channel...`);
    // Get Discord channel to find guild ID
    const discordChannel = await discordClient.channels.fetch(discordChannelId) as TextChannel
    if (!discordChannel || !discordChannel.guild) {
      console.error('❌ Discord channel not found or not in a guild')
      return
    }
    
    console.log(`✅ Got Discord channel in guild: ${discordChannel.guild.name}`);
    
    // Get webhook for puppeting
    console.log(`🔨 Getting webhook...`);
    const webhook = await getOrCreateWebhook(discordChannelId)
    
    if (!webhook) {
      console.error('❌ Could not get webhook, message not sent')
      return
    }
    
    console.log(`✅ Got webhook: ${webhook.name}`);
    
    // Generate unique username (simple suffix)
    const baseUsername = msg.author?.display_name || msg.author?.username || 'Harmony User'
    const uniqueUsername = `${baseUsername} [H]` // Simple suffix for Harmony users
    console.log(`✅ Username: ${uniqueUsername}`);
    
    // Avatar URL is now fully-qualified by the bot gateway
    // Discord won't be able to fetch localhost URLs, so skip avatar in local dev
    const avatarURL = msg.author?.avatar?.startsWith('http://localhost') ? undefined : msg.author?.avatar
    
    // Convert Harmony MessageParts to Discord format (with member cache for mention lookups)
    const contentText = translator.harmonyToDiscord(msg, discordMemberCache)
    if (!contentText || contentText.trim() === '') {
      console.error('❌ Message content is empty after translation, cannot send to Discord')
      return
    }
    
    console.log(`🎨 Puppeting as ${uniqueUsername} with avatar: ${avatarURL || 'default'}`)
    console.log(`📝 Message content: "${contentText}"`)

    // Reply threading: Harmony message has reply_to → look up the Discord
    // counterpart and post a Discord-flavored quote header so users see the
    // context. Webhooks can't post real "Replying to X" UI blocks via
    // discord.js, so we use the standard `> @user message snippet` form
    // (https://discord.com/developers/docs/resources/message#message-object
    //  - webhooks don't support `message_reference`).
    let finalContent = contentText
    if (msg.reply_to) {
      const parentDiscordId = harmonyToDiscordMessages.get(msg.reply_to)
      try {
        // Best-effort: fetch the original Discord message for a snippet.
        if (parentDiscordId) {
          const parentMsg = await discordChannel.messages.fetch(parentDiscordId).catch(() => null)
          if (parentMsg) {
            const snippet = (parentMsg.content || '[no text]')
              .replace(/\n/g, ' ')
              .slice(0, 80)
            const replyAuthor = parentMsg.author?.username
              ? `**@${parentMsg.author.username}**`
              : 'message'
            finalContent = `> ${replyAuthor}: ${snippet}${parentMsg.content && parentMsg.content.length > 80 ? '...' : ''}\n${contentText}`
          } else {
            finalContent = `> *replying to an earlier message*\n${contentText}`
          }
        } else {
          finalContent = `> *replying to an earlier message*\n${contentText}`
        }
      } catch {
        // Ignore - fall back to unprefixed content.
      }
    }

    const webhookResult = await webhook.send({
      content: finalContent,
      username: uniqueUsername,
      avatarURL: avatarURL,
      allowedMentions: { parse: [] }, // Prevent mention abuse
    })
    
    // Store message ID mapping for reactions
    if (webhookResult?.id && msg.id) {
      harmonyToDiscordMessages.set(msg.id, webhookResult.id)
      discordToHarmonyMessages.set(webhookResult.id, msg.id)
      console.log(`📌 Stored message mapping: Harmony ${msg.id} <-> Discord ${webhookResult.id}`)
    }
    
    console.log(`✅ Webhook sent! Message ID: ${webhookResult.id}`)
    console.log(`✅ Harmony -> Discord (puppeted): ${uniqueUsername} in #${discordChannelId}`)
  } catch (error) {
    console.error('❌ Failed to bridge Harmony -> Discord:', error)
  }
})

// Handle Harmony message updates
harmonyClient.on('messageUpdate', async (msg: any) => {
  console.log(`📝 Harmony message updated:`, { 
    id: msg.id, 
    channel_id: msg.channel_id,
    content: msg.content?.substring?.(0, 50) || JSON.stringify(msg.content_raw)?.substring(0, 50),
    metadata: msg.metadata,
    mappingExists: harmonyToDiscordMessages.has(msg.id),
    totalMappings: harmonyToDiscordMessages.size
  });
  
  // Don't bridge messages that came from Discord (prevent loops!)
  if (msg.metadata?.bridge_source === 'discord') {
    console.log('⏭️  Skipping message from Discord (preventing loop)')
    return
  }
  
  // Skip "[deleted]" edits - the MESSAGE_DELETE event will handle actual deletion
  const contentText = msg.content || ''
  const contentRaw = msg.content_raw || []
  const isDeleted = contentText === '[deleted]' || 
    (Array.isArray(contentRaw) && contentRaw.length === 1 && contentRaw[0]?.text === '[deleted]')
  
  if (isDeleted) {
    console.log('⏭️  Skipping [deleted] content - waiting for MESSAGE_DELETE event')
    return
  }
  
  // Get Discord message ID from mapping
  const discordMessageId = harmonyToDiscordMessages.get(msg.id)
  if (!discordMessageId) {
    console.log(`⚠️  No message mapping found for Harmony message ${msg.id}`)
    console.log(`   Current mappings:`, Array.from(harmonyToDiscordMessages.keys()).slice(0, 5))
    return
  }
  
  console.log(`✅ Found mapping: Harmony ${msg.id} -> Discord ${discordMessageId}`)
  
  // Get Discord channel from mapping
  const discordChannelId = mapper.getDiscordChannel(msg.channel_id)
  if (!discordChannelId) {
    console.log('⏭️  Channel not mapped')
    return
  }
  
  if (!mapper.shouldBridgeFromHarmony(msg.channel_id)) {
    console.log('⏭️  Bridging disabled for this channel')
    return
  }
  
  try {
    // Get the webhook message to edit it
    const discordChannel = await discordClient.channels.fetch(discordChannelId) as TextChannel
    if (!discordChannel) {
      console.error('❌ Discord channel not found')
      return
    }
    
    const webhook = await getOrCreateWebhook(discordChannelId)
    if (!webhook) {
      console.error('❌ Could not get webhook')
      return
    }
    
    // Convert content (with member cache for mention lookups)
    const contentText = translator.harmonyToDiscord(msg, discordMemberCache)
    
    // Edit the webhook message
    await webhook.editMessage(discordMessageId, {
      content: contentText
    })
    
    console.log(`✅ Harmony -> Discord edit: Message ${discordMessageId}`)
  } catch (error) {
    console.error('❌ Failed to bridge edit Harmony -> Discord:', error)
  }
})

// Handle Harmony message deletes
harmonyClient.on('messageDelete', async (msg: any) => {
  console.log(`🗑️ Harmony message deleted:`, { 
    id: msg.id, 
    channel_id: msg.channel_id,
    metadata: msg.metadata,
    mappingExists: harmonyToDiscordMessages.has(msg.id),
    totalMappings: harmonyToDiscordMessages.size
  });
  
  // Don't bridge messages that came from Discord (prevent loops!)
  if (msg.metadata?.bridge_source === 'discord') {
    console.log('⏭️  Skipping message from Discord (preventing loop)')
    return
  }
  
  // Get Discord message ID from mapping
  const discordMessageId = harmonyToDiscordMessages.get(msg.id)
  if (!discordMessageId) {
    console.log(`⚠️  No message mapping found for Harmony message ${msg.id}`)
    console.log(`   Current mappings:`, Array.from(harmonyToDiscordMessages.keys()).slice(0, 5))
    return
  }
  
  console.log(`✅ Found mapping: Harmony ${msg.id} -> Discord ${discordMessageId}`)
  
  // Get Discord channel from mapping
  const discordChannelId = mapper.getDiscordChannel(msg.channel_id)
  if (!discordChannelId) {
    console.log('⏭️  Channel not mapped')
    return
  }
  
  if (!mapper.shouldBridgeFromHarmony(msg.channel_id)) {
    console.log('⏭️  Bridging disabled for this channel')
    return
  }
  
  try {
    // Get the webhook to delete the message
    const discordChannel = await discordClient.channels.fetch(discordChannelId) as TextChannel
    if (!discordChannel) {
      console.error('❌ Discord channel not found')
      return
    }
    
    const webhook = await getOrCreateWebhook(discordChannelId)
    if (!webhook) {
      console.error('❌ Could not get webhook')
      return
    }
    
    // Delete the webhook message
    console.log(`🗑️ Attempting to delete Discord message ${discordMessageId} via webhook...`)
    await webhook.deleteMessage(discordMessageId)
    
    console.log(`✅ Harmony -> Discord delete SUCCESS: Message ${discordMessageId} deleted from Discord`)
    
    // Clean up mapping
    harmonyToDiscordMessages.delete(msg.id)
    discordToHarmonyMessages.delete(discordMessageId)
  } catch (error) {
    console.error('❌ Failed to bridge delete Harmony -> Discord:', error)
  }
})

// =====================================================
// Harmony → Discord reaction bridging
// =====================================================
// Only **unicode** emojis are bridged automatically; Harmony custom emojis
// don't have a stable Discord counterpart unless that exact emoji was
// previously created on the Discord server. We attempt a best-effort name
// match for custom emojis (search guild emojis by name) and silently no-op
// if there's no match - cross-platform custom-emoji parity is a deliberate
// follow-up, not in scope here.
async function resolveDiscordEmojiForReaction(
  channel: TextChannel,
  emojiName: string,
): Promise<string | null> {
  // Unicode emoji: the name itself IS the identifier Discord wants.
  // Rough check - if it's a single non-ASCII grapheme, treat as unicode.
  if (!/^[a-zA-Z0-9_+\-~]+$/.test(emojiName)) {
    return emojiName
  }
  // Otherwise try to find a custom emoji on the guild with the same name.
  const guildEmoji = channel.guild.emojis.cache.find(e => e.name === emojiName)
  if (guildEmoji) return guildEmoji.identifier
  return null
}

// On-demand attachment URL refresh (instance bridge_attachment_mode = 'refresh').
// The gateway forwards a request when a user views a bridged message whose Discord
// CDN URL has expired; we re-sign via Discord and silently patch the message.
const recentlyRefreshedMessages = new Set<string>()
harmonyClient.on('refreshAttachments', async (data: any) => {
  const messageId = data?.messageId
  const content = data?.content
  if (!messageId || !Array.isArray(content)) return
  if (recentlyRefreshedMessages.has(messageId)) return
  recentlyRefreshedMessages.add(messageId)
  setTimeout(() => recentlyRefreshedMessages.delete(messageId), 15_000)

  try {
    const newContent = await refreshDiscordAttachmentParts(content, config.discord.token)
    if (!newContent) return
    await harmonyClient.silentUpdateMessageContent(messageId, newContent)
    console.log(`🔄 Refreshed expired attachment URLs for message ${messageId}`)
  } catch (error: any) {
    console.error(`⚠️ Attachment refresh failed for ${messageId}: ${error?.message || error}`)
  }
})

harmonyClient.on('reactionAdd', async (data: any) => {
  if (data.metadata?.bridge_source === 'discord') return // loop prevention

  const discordChannelId = mapper.getDiscordChannel(data.channel_id)
  if (!discordChannelId) return
  if (!mapper.shouldBridgeFromHarmony(data.channel_id)) return

  const discordMessageId = harmonyToDiscordMessages.get(data.message_id)
  if (!discordMessageId) {
    console.log(`⏭️  Harmony reaction: no Discord message mapping for ${data.message_id}`)
    return
  }

  try {
    const discordChannel = await discordClient.channels.fetch(discordChannelId) as TextChannel
    if (!discordChannel) return

    const emojiInput: string = data.emoji?.name || data.emoji || ''
    if (!emojiInput) return

    const resolved = await resolveDiscordEmojiForReaction(discordChannel, emojiInput)
    if (!resolved) {
      console.log(`⏭️  Harmony reaction: no Discord emoji match for "${emojiInput}"`)
      return
    }

    const discordMessage = await discordChannel.messages.fetch(discordMessageId).catch(() => null)
    if (!discordMessage) {
      console.log(`⏭️  Harmony reaction: Discord message ${discordMessageId} not found`)
      return
    }

    await discordMessage.react(resolved)
    console.log(`✅ Harmony -> Discord reaction: ${emojiInput} on ${discordMessageId}`)
  } catch (err: any) {
    console.error('❌ Failed to bridge reaction Harmony -> Discord:', err.message)
  }
})

harmonyClient.on('reactionRemove', async (data: any) => {
  if (data.metadata?.bridge_source === 'discord') return

  const discordChannelId = mapper.getDiscordChannel(data.channel_id)
  if (!discordChannelId) return
  if (!mapper.shouldBridgeFromHarmony(data.channel_id)) return

  const discordMessageId = harmonyToDiscordMessages.get(data.message_id)
  if (!discordMessageId) return

  try {
    const discordChannel = await discordClient.channels.fetch(discordChannelId) as TextChannel
    if (!discordChannel) return

    const emojiInput: string = data.emoji?.name || data.emoji || ''
    if (!emojiInput) return

    const resolved = await resolveDiscordEmojiForReaction(discordChannel, emojiInput)
    if (!resolved) return

    const discordMessage = await discordChannel.messages.fetch(discordMessageId).catch(() => null)
    if (!discordMessage) return

    // Remove only the bot's own reaction (we can't reach into other users).
    const reaction = discordMessage.reactions.cache.find(r => r.emoji.identifier === resolved)
    if (reaction) {
      await reaction.users.remove(discordClient.user!.id)
      console.log(`✅ Harmony -> Discord reaction removed: ${emojiInput} on ${discordMessageId}`)
    }
  } catch (err: any) {
    console.error('❌ Failed to bridge reaction removal Harmony -> Discord:', err.message)
  }
})

// =====================================================
// STARTUP
// =====================================================

console.log('╔════════════════════════════════════════╗')
console.log('║   🌉 Discord-Harmony Bridge           ║')
console.log('╠════════════════════════════════════════╣')
console.log(`║   Mappings: ${config.channelMappings.length} channels            ║`)
console.log('╚════════════════════════════════════════╝')

// Start Discord client
discordClient.login(config.discord.token).catch(error => {
  console.error('❌ Failed to login to Discord:', error)
  process.exit(1)
})

discordClient.on(Events.ClientReady, async () => {
  console.log(`✅ Discord bot connected: ${discordClient.user?.tag}`)

  // Discord.js can emit ClientReady again after gateway reconnects. Heavy
  // startup (member fetch, slash registration, cache timers) must run once.
  if (!discordStartupDone) {
    discordStartupDone = true

    if (config.discord.guildId) {
      try {
        const guild = await discordClient.guilds.fetch(config.discord.guildId)
        console.log(`📥 Fetching members for guild: ${guild.name}`)

        const members = await guild.members.fetch()
        members.forEach(member => {
          if (!member.user.bot) {
            cacheMember(member)
          }
        })

        console.log(`✅ Cached ${discordMemberCache.size} Discord members for mention lookups`)

        await registerSlashCommands(config.discord.guildId)

        if (config.settings.syncPermissions) {
          permissionSync.attach()
          try {
            await permissionSync.initialSync(guild)
          } catch (err) {
            console.error('❌ Permission sync initial reconcile failed:', err)
          }
        }
      } catch (error) {
        console.error('❌ Failed to fetch guild members:', error)
      }
    }

    await refreshHarmonyUserCache({ verbose: true })

    if (!harmonyUserCacheTimer) {
      harmonyUserCacheTimer = setInterval(
        () => { void refreshHarmonyUserCache({ verbose: false }) },
        HARMONY_USER_CACHE_REFRESH_MS,
      )
    }
  } else {
    console.log('↳ Discord gateway reconnected (skipping startup cache refresh)')
  }

  discordReady = true
  registerBridgeDataWithGateway()
})

// Keep member cache updated and re-register with gateway
discordClient.on('guildMemberAdd', (member) => {
  if (!member.user.bot) {
    cacheMember(member)
    console.log(`👋 Added member to cache: ${member.user.username}`)
    // Re-register bridge data with updated members
    registerBridgeDataWithGateway()
  }
})

discordClient.on('guildMemberRemove', (member) => {
  uncacheMemberById(member.id, member.user.username)
  console.log(`👋 Removed member from cache: ${member.user.username}`)
  // Re-register bridge data with updated members
  registerBridgeDataWithGateway()
})

discordClient.on('guildMemberUpdate', (oldMember, newMember) => {
  // Update cache if username or display name changed
  if (oldMember.user.username !== newMember.user.username || 
      oldMember.displayName !== newMember.displayName) {
    // Remove old entry
    uncacheMemberById(oldMember.id, oldMember.user.username)
    // Add new entry if not a bot
    if (!newMember.user.bot) {
      cacheMember(newMember)
    }
    // Re-register bridge data with updated members
    registerBridgeDataWithGateway()
  }
})

// =====================================================
// SLASH COMMANDS
// =====================================================

/**
 * Register slash commands with Discord
 */
async function registerSlashCommands(guildId: string) {
  // Helper to add user options to a command
  const addUserOptions = (builder: SlashCommandBuilder) => {
    return builder
      .addStringOption(option =>
        option
          .setName('user')
          .setDescription('Harmony user to mention')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption(option =>
        option
          .setName('message')
          .setDescription('Your message')
          .setRequired(false)
      )
      .addStringOption(option =>
        option
          .setName('user2')
          .setDescription('Additional user to mention')
          .setRequired(false)
          .setAutocomplete(true)
      )
      .addStringOption(option =>
        option
          .setName('user3')
          .setDescription('Additional user to mention')
          .setRequired(false)
          .setAutocomplete(true)
      )
      .addStringOption(option =>
        option
          .setName('user4')
          .setDescription('Additional user to mention')
          .setRequired(false)
          .setAutocomplete(true)
      )
      .addStringOption(option =>
        option
          .setName('user5')
          .setDescription('Additional user to mention')
          .setRequired(false)
          .setAutocomplete(true)
      )
  }
  
  // /bridge ... subcommands for admins to manage mappings without YAML edits.
  // Discord renders these as a single command with picker UX. Execution is
  // gated to members with Administrator inside the handler; visibility uses the
  // same permission so it doesn't clutter normal members' command palette.
  const bridgeCommand = new SlashCommandBuilder()
    .setName('bridge')
    .setDescription('Manage the Harmony bridge for this server')
    .setDefaultMemberPermissions('8') // PermissionFlagsBits.Administrator
    .addSubcommand(sub =>
      sub
        .setName('status')
        .setDescription('Show current bridge configuration')
    )
    .addSubcommand(sub =>
      sub
        .setName('link')
        .setDescription('Bridge this Discord channel to a Harmony channel')
        .addStringOption(opt =>
          opt
            .setName('harmony_channel_id')
            .setDescription('Harmony channel UUID')
            .setRequired(true)
        )
        .addBooleanOption(opt =>
          opt
            .setName('bidirectional')
            .setDescription('Mirror Harmony messages back to Discord too (default: yes)')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('unlink')
        .setDescription('Stop bridging this Discord channel')
    )
    .addSubcommand(sub =>
      sub
        .setName('clone-server')
        .setDescription('Mirror every Discord channel into Harmony (additive - never overwrites)')
        .addBooleanOption(opt =>
          opt
            .setName('dry_run')
            .setDescription('Show what would be created without making changes')
            .setRequired(false)
        )
        .addBooleanOption(opt =>
          opt
            .setName('include_voice')
            .setDescription('Also mirror voice channels (default: yes)')
            .setRequired(false)
        )
        .addBooleanOption(opt =>
          opt
            .setName('clone_roles')
            .setDescription('Also recreate Discord roles on Harmony (default: config setting)')
            .setRequired(false)
        )
    )

  const commands = [
    addUserOptions(
      new SlashCommandBuilder()
        .setName('mention')
        .setDescription('Mention Harmony user(s) with a message')
    ),
    addUserOptions(
      new SlashCommandBuilder()
        .setName('m')
        .setDescription('Quick mention Harmony user(s)')
    ),
    bridgeCommand,
  ]

  try {
    const rest = new REST({ version: '10' }).setToken(config.discord.token)

    console.log('🔧 Registering slash commands...')

    await rest.put(
      Routes.applicationGuildCommands(discordClient.user!.id, guildId),
      { body: commands.map(cmd => cmd.toJSON()) }
    )

    console.log('✅ Slash commands registered: /mention, /m, /bridge')
  } catch (error) {
    console.error('❌ Failed to register slash commands:', error)
  }
}

// Handle slash command interactions
discordClient.on('interactionCreate', async (interaction) => {
  // Handle autocomplete for user fields
  if (interaction.isAutocomplete()) {
    const autocomplete = interaction as AutocompleteInteraction
    const focusedOption = autocomplete.options.getFocused(true)
    
    // Handle user, user2, user3, user4, user5 autocomplete
    if (focusedOption.name.startsWith('user')) {
      const query = focusedOption.value
      console.log(`🔍 Autocomplete: "${query}", cache: ${harmonyUserCache.size}`)
      
      const matches = searchHarmonyUsers(query)
      
      await autocomplete.respond(
        matches.map(user => ({
          name: `${user.displayName} (@${user.username})`,
          value: user.id
        }))
      )
    }
    return
  }
  
  // Handle slash command execution
  if (interaction.isChatInputCommand()) {
    const command = interaction as ChatInputCommandInteraction
    
    if (command.commandName === 'mention' || command.commandName === 'm') {
      // Get all user IDs from the options
      const userIds = [
        command.options.getString('user', true),
        command.options.getString('user2', false),
        command.options.getString('user3', false),
        command.options.getString('user4', false),
        command.options.getString('user5', false)
      ].filter(Boolean) as string[]
      
      const message = command.options.getString('message', false) || ''
      
      console.log(`🔔 Slash command: users=${userIds.length}, message="${message}"`)
      
      // Get the Discord channel mapping
      const harmonyChannelId = mapper.getHarmonyChannel(command.channelId)
      if (!harmonyChannelId) {
        await command.reply({ 
          content: '❌ This channel is not bridged to Harmony.', 
          flags: MessageFlags.Ephemeral 
        })
        return
      }
      
      // Build content parts: mentions first, then message
      const contentParts: any[] = []
      const mentionedUsers: CachedHarmonyUser[] = []
      
      // Add all user mentions
      for (const userId of userIds) {
        const harmonyUser = harmonyUserCache.get(userId)
        if (harmonyUser) {
          contentParts.push({
            type: 'mention',
            userId: harmonyUser.id,
            username: harmonyUser.username,
            domain: null,
            isLocal: true,
            displayName: harmonyUser.displayName
          })
          mentionedUsers.push(harmonyUser)
          console.log(`🔔 Adding mention: @${harmonyUser.username}`)
        }
      }
      
      // Add space between mentions and message if both exist
      if (mentionedUsers.length > 0 && message) {
        contentParts.push({ type: 'text', text: ' ' })
      }
      
      // Parse message for Discord emojis
      if (message) {
        const emojiRegex = /<(a?):(\w+):(\d+)>/g
        let lastIndex = 0
        let match
        
        while ((match = emojiRegex.exec(message)) !== null) {
          // Add text before emoji
          if (match.index > lastIndex) {
            contentParts.push({ type: 'text', text: message.substring(lastIndex, match.index) })
          }
          
          // Add emoji part
          const isAnimated = match[1] === 'a'
          const emojiName = match[2]
          const emojiId = match[3]
          const emojiUrl = `https://cdn.discordapp.com/emojis/${emojiId}.${isAnimated ? 'gif' : 'png'}`
          
          console.log(`🎨 Emoji: :${emojiName}: → ${emojiUrl}`)
          
          contentParts.push({
            type: 'emoji',
            emoji: {
              name: emojiName,
              url: emojiUrl,
              id: null,
              domain: 'discord.com',
              display_name: emojiName
            }
          })
          
          lastIndex = emojiRegex.lastIndex
        }
        
        // Add remaining text
        if (lastIndex < message.length) {
          contentParts.push({ type: 'text', text: message.substring(lastIndex) })
        } else if (lastIndex === 0) {
          // No emojis found, add whole message
          contentParts.push({ type: 'text', text: message })
        }
      }
      
      // Build Discord display text - extract domain from config baseUrl
      const harmonyDomain = new URL(config.harmony.baseUrl).hostname
      const mentionDisplay = mentionedUsers.map(u => `@${u.username}@${harmonyDomain}`).join(' ')
      const discordDisplayText = message ? `${mentionDisplay} ${message}` : mentionDisplay
      
      console.log(`📤 Sending ${contentParts.length} parts to Harmony`)
      
      // Get Discord user metadata for attribution
      const member = command.member as GuildMember
      const discordMetadata = {
        discord_user: {
          id: command.user.id,
          username: command.user.username,
          discriminator: command.user.discriminator,
          display_name: member?.displayName || command.user.username,
          avatar_url: command.user.displayAvatarURL({ size: 256 })
        },
        bridge_source: 'discord'
      }
      
      try {
        // Send directly to Harmony with proper mention parts
        const harmonyMsg = await harmonyClient.sendMessage(
          harmonyChannelId,
          contentParts,
          discordMetadata
        )
        
        console.log(`✅ Slash command sent to Harmony`)
        
        // Also send to Discord channel so other Discord users see it
        const webhook = await getOrCreateWebhook(command.channelId)
        if (webhook) {
          const webhookMsg = await webhook.send({
            content: discordDisplayText,
            username: (member?.displayName || command.user.username) + ' [H]',
            avatarURL: command.user.displayAvatarURL()
          })
          
          // Store message mapping
          if (harmonyMsg?.id && webhookMsg?.id) {
            discordToHarmonyMessages.set(webhookMsg.id, harmonyMsg.id)
            harmonyToDiscordMessages.set(harmonyMsg.id, webhookMsg.id)
          }
        }
        
        // Acknowledge the command
        const mentionList = mentionedUsers.map(u => `@${u.username}`).join(', ')
        await command.reply({ 
          content: `✅ Mentioned ${mentionList} in Harmony`, 
          flags: MessageFlags.Ephemeral 
        })
      } catch (error: any) {
        console.error('❌ Failed to send message:', error)
        await command.reply({
          content: `❌ Failed to send: ${error.message}`,
          flags: MessageFlags.Ephemeral
        })
      }
    } else if (command.commandName === 'bridge') {
      await handleBridgeCommand(command)
    }
  }
})

// =====================================================
// /bridge slash command handlers
// =====================================================
// Gate: Discord Administrator. Harmony side is enforced by bot permissions on
// the configured server (manage_channels etc.) — no cross-platform account link.

async function handleBridgeCommand(command: ChatInputCommandInteraction) {
  const guild = command.guild
  if (!guild) {
    await command.reply({ content: '❌ This command can only be used in a server.', flags: MessageFlags.Ephemeral })
    return
  }

  const member = command.member
  if (!member) {
    await command.reply({
      content: '❌ Could not verify your permissions.',
      flags: MessageFlags.Ephemeral,
    })
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

  if (!config.harmony.serverId) {
    await command.reply({
      content: '❌ `harmony.serverId` is not set in bridge-config.yml.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  // Bot `manage_channels` on the Harmony side (granted at install) is the
  // Harmony gate. Without it, clone/link calls below fail with 403.

  const sub = command.options.getSubcommand(true)

  try {
    switch (sub) {
      case 'status':
        await runBridgeStatus(command)
        break
      case 'link':
        await runBridgeLink(command)
        break
      case 'unlink':
        await runBridgeUnlink(command)
        break
      case 'clone-server':
        await runBridgeCloneServer(command)
        break
      default:
        await command.reply({ content: `❌ Unknown subcommand: ${sub}`, flags: MessageFlags.Ephemeral })
    }
  } catch (err: any) {
    console.error(`❌ /bridge ${sub} failed:`, err)
    const msg = `❌ \`/bridge ${sub}\` failed: ${err?.message || 'unknown error'}`
    if (command.deferred || command.replied) {
      await command.followUp({ content: msg, flags: MessageFlags.Ephemeral })
    } else {
      await command.reply({ content: msg, flags: MessageFlags.Ephemeral })
    }
  }
}

async function runBridgeStatus(command: ChatInputCommandInteraction) {
  const mappings = mapper.getAllMappings()
  // eslint-disable-next-line unused-imports/no-unused-vars
  const guildId = command.guildId!
  const lines: string[] = []
  lines.push(`**Bridge status** - ${mappings.length} mapping${mappings.length === 1 ? '' : 's'}`)
  lines.push(`Harmony server: \`${config.harmony.serverId || '(not set)'}\``)
  lines.push('')

  if (mappings.length === 0) {
    lines.push('_No channels are currently bridged. Use_ `/bridge clone-server` _or_ `/bridge link`.')
  } else {
    const inGuild = mappings.slice(0, 25) // cap, message length safety
    for (const m of inGuild) {
      const dir = m.bidirectional === false ? 'Discord → Harmony only' : 'bidirectional'
      lines.push(`• <#${m.discord}> ↔ \`${m.harmony.slice(0, 8)}...\` _(${dir})_`)
    }
    if (mappings.length > 25) {
      lines.push(`_...and ${mappings.length - 25} more_`)
    }
  }

  await command.reply({
    content: joinLinesWithinDiscordLimit(lines),
    flags: MessageFlags.Ephemeral,
  })
}

async function runBridgeLink(command: ChatInputCommandInteraction) {
  const harmonyChannelId = command.options.getString('harmony_channel_id', true).trim()
  const bidirectional = command.options.getBoolean('bidirectional', false) ?? true
  const discordChannelId = command.channelId

  // Reject existing mapping
  const existingHarmony = mapper.getHarmonyChannel(discordChannelId)
  if (existingHarmony) {
    await command.reply({
      content: `❌ This Discord channel is already bridged to \`${existingHarmony.slice(0, 8)}...\`. Run \`/bridge unlink\` first.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  // Sanity-check the Harmony channel exists and belongs to our server.
  try {
    const channels = await harmonyClient.getServerChannels(config.harmony.serverId)
    const target = channels.find((c: any) => c.id === harmonyChannelId)
    if (!target) {
      await command.reply({
        content: `❌ Harmony channel \`${harmonyChannelId}\` not found in the configured server.`,
        flags: MessageFlags.Ephemeral,
      })
      return
    }
  } catch (err: any) {
    await command.reply({
      content: `❌ Could not verify Harmony channel: ${err.message}`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  try {
    mapper.addMapping(discordChannelId, harmonyChannelId, bidirectional)
    await command.reply({
      content: `✅ Linked <#${discordChannelId}> ↔ Harmony \`${harmonyChannelId.slice(0, 8)}...\` (${bidirectional ? 'bidirectional' : 'Discord → Harmony only'}).`,
      flags: MessageFlags.Ephemeral,
    })
  } catch (err: any) {
    await command.reply({ content: `❌ Failed to link: ${err.message}`, flags: MessageFlags.Ephemeral })
  }
}

async function runBridgeUnlink(command: ChatInputCommandInteraction) {
  const discordChannelId = command.channelId
  const existingHarmony = mapper.getHarmonyChannel(discordChannelId)
  if (!existingHarmony) {
    await command.reply({
      content: '❌ This Discord channel isn\'t bridged.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }
  const removed = mapper.removeMapping(discordChannelId)
  await command.reply({
    content: removed
      ? `✅ Unlinked <#${discordChannelId}>.`
      : '❌ Nothing was removed.',
    flags: MessageFlags.Ephemeral,
  })
}

/**
 * Real (non-@everyone, non-managed) Discord roles worth cloning, highest first.
 * @everyone maps to Harmony's existing default role; managed roles belong to
 * bots/integrations and shouldn't be recreated.
 */
function cloneableDiscordRoles(guild: { roles: { cache: Map<string, DiscordRole> } }): DiscordRole[] {
  return Array.from(guild.roles.cache.values())
    .filter(r => r.name !== '@everyone' && !r.managed)
    .sort((a, b) => b.position - a.position)
}

/**
 * `/bridge clone-server` - mirror every (text/voice) Discord channel under
 * its respective category into Harmony, then add bridge mappings. Always
 * additive: existing mappings are preserved and matching Harmony channels
 * are reused when possible (by name). With clone_roles enabled, also recreate
 * Discord roles (additive, matched by name) with mapped permissions.
 *
 * The bot must hold `manage_channels` on the Harmony server; the gateway
 * enforces that at the API layer. On the Discord side we just need to be
 * able to read the channel list, which is implicit for the bot user.
 */
async function runBridgeCloneServer(command: ChatInputCommandInteraction) {
  const dryRun = command.options.getBoolean('dry_run', false) ?? false
  const includeVoice = command.options.getBoolean('include_voice', false) ?? true
  // clone_roles option overrides the config default when explicitly provided.
  const cloneRoles =
    command.options.getBoolean('clone_roles', false) ?? (config.settings.cloneRoles ?? false)

  // Discord can take >3s; defer immediately so we don't blow the interaction.
  await command.deferReply({ flags: MessageFlags.Ephemeral })

  const guild = command.guild!
  await guild.channels.fetch() // refresh cache

  // Build the work plan ----------------------------------------------------
  type PlannedChannel = {
    discordId: string
    discordName: string
    harmonyType: 0 | 1
    discordCategoryId: string | null
    discordCategoryName: string | null
  }

  const planned: PlannedChannel[] = []
  const planCategories = new Map<string, string>() // discordCategoryId -> name

  for (const ch of guild.channels.cache.values()) {
    if (ch.type === ChannelType.GuildCategory) {
      planCategories.set(ch.id, ch.name)
      continue
    }
    if (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildVoice) continue
    if (ch.type === ChannelType.GuildVoice && !includeVoice) continue

    const parent = ch.parentId ? guild.channels.cache.get(ch.parentId) : null
    planned.push({
      discordId: ch.id,
      discordName: ch.name,
      harmonyType: ch.type === ChannelType.GuildVoice ? 1 : 0,
      discordCategoryId: ch.parentId ?? null,
      discordCategoryName: parent?.name ?? null,
    })
  }

  // Filter out anything already mapped - clone-server is strictly additive.
  const alreadyMapped = new Set(mapper.getAllMappings().map(m => m.discord))
  const toCreate = planned.filter(p => !alreadyMapped.has(p.discordId))

  // Role plan (additive, matched by name) - only when clone_roles is enabled.
  let rolesToClone: DiscordRole[] = []
  let existingRoleNames = new Set<string>()
  if (cloneRoles) {
    const existingRoles = await harmonyClient.getServerRoles(config.harmony.serverId).catch(() => [])
    existingRoleNames = new Set(existingRoles.map((r: any) => r.name))
    rolesToClone = cloneableDiscordRoles(guild).filter(r => !existingRoleNames.has(r.name))
  }

  if (toCreate.length === 0 && rolesToClone.length === 0) {
    await command.editReply({
      content: cloneRoles
        ? '✅ Nothing to do - every Discord channel and role already exists on Harmony.'
        : '✅ Nothing to do - every Discord channel already has a mapping.',
    })
    return
  }

  // Fetch existing Harmony categories so we can reuse by name and avoid
  // duplicates if clone-server is run twice (additive contract).
  const harmonyCategories = await harmonyClient.getServerCategories(config.harmony.serverId).catch(() => [])
  const categoryIdByName = new Map<string, string>(
    harmonyCategories.map((c: any) => [c.name as string, c.id as string])
  )
  const harmonyChannels = await harmonyClient.getServerChannels(config.harmony.serverId).catch(() => [])
  const harmonyChannelByName = new Map<string, any>()
  for (const c of harmonyChannels) harmonyChannelByName.set(c.name, c)

  // Dry-run report
  if (dryRun) {
    const lines: string[] = [
      `**Dry run** - ${toCreate.length} channel(s) would be processed:`,
    ]
    const categoriesNeeded = new Set<string>()
    for (const p of toCreate) {
      const reuse = harmonyChannelByName.get(p.discordName)
      const action = reuse ? `reuse Harmony \`${reuse.id.slice(0, 8)}...\`` : 'create Harmony channel'
      const cat = p.discordCategoryName ? `under category **${p.discordCategoryName}**` : ''
      if (p.discordCategoryName && !categoryIdByName.has(p.discordCategoryName)) {
        categoriesNeeded.add(p.discordCategoryName)
      }
      lines.push(`• \`#${p.discordName}\` → ${action} ${cat}`.trimEnd())
    }
    if (categoriesNeeded.size > 0) {
      lines.splice(
        1,
        0,
        `_Would also create ${categoriesNeeded.size} categor${categoriesNeeded.size === 1 ? 'y' : 'ies'}: ${Array.from(categoriesNeeded).map(n => `**${n}**`).join(', ')}_`,
      )
    }
    if (cloneRoles) {
      if (rolesToClone.length > 0) {
        lines.push(`_Would also create ${rolesToClone.length} role(s): ${rolesToClone.map(r => `**${r.name}**`).join(', ')}_`)
      } else {
        lines.push('_Roles: all Discord roles already exist on Harmony (by name)._')
      }
    }
    await command.editReply({ content: joinLinesWithinDiscordLimit(lines) })
    return
  }

  // Live execution. Process serially to stay polite with the gateway DB.
  let created = 0
  let reused = 0
  let categoriesCreated = 0
  const failures: string[] = []
  const newMappings: { discord: string; harmony: string; name?: string }[] = []

  for (const p of toCreate) {
    try {
      // 1. Resolve / create Harmony category
      let harmonyCategoryId: string | null = null
      if (p.discordCategoryName) {
        const existing = categoryIdByName.get(p.discordCategoryName)
        if (existing) {
          harmonyCategoryId = existing
        } else {
          const newCat = await harmonyClient.createCategory(config.harmony.serverId, p.discordCategoryName)
          harmonyCategoryId = newCat.id
          if (newCat.id && p.discordCategoryName) {
            categoryIdByName.set(p.discordCategoryName, newCat.id)
          }
          categoriesCreated++
        }
      }

      // 2. Reuse-by-name OR create channel
      let harmonyChannelId: string
      const reuse = harmonyChannelByName.get(p.discordName)
      if (reuse) {
        harmonyChannelId = reuse.id
        reused++
      } else {
        const newCh = await harmonyClient.createChannel(config.harmony.serverId, {
          name: p.discordName,
          type: p.harmonyType,
          categoryId: harmonyCategoryId,
        })
        harmonyChannelId = newCh.id
        created++
      }

      newMappings.push({
        discord: p.discordId,
        harmony: harmonyChannelId,
        name: p.discordName,
      })
    } catch (err: any) {
      failures.push(`\`#${p.discordName}\`: ${err.message}`)
    }
  }

  // 3. Persist all mappings in one disk write
  const added = mapper.addMappingsBatch(
    newMappings.map(m => ({
      discord: m.discord,
      harmony: m.harmony,
      bidirectional: true,
      name: m.name,
    }))
  )

  // 3b. Clone roles (additive, matched by name). Discord orders roles with the
  // highest at the top; we pass position through so Harmony preserves hierarchy.
  let rolesCreated = 0
  if (cloneRoles) {
    for (const role of rolesToClone) {
      try {
        const created = await harmonyClient.createRole(config.harmony.serverId, {
          name: role.name,
          color: discordColorToHex(role.color),
          position: role.position,
          permissions: discordRoleToHarmonyPermissions(role),
          mentionable: role.mentionable,
          hoist: role.hoist,
        })
        permissionSyncStore.setMapping(role.id, created.id, role.name)
        rolesCreated++
      } catch (err: any) {
        failures.push(`role \`${role.name}\`: ${err.message}`)
      }
    }
    // Map pre-existing Harmony roles by name + sync channel permission overrides.
    try {
      await permissionSync.reconcileRoles(guild)
      await permissionSync.syncAllMappedChannelOverwrites(guild)
    } catch (err: any) {
      failures.push(`permission sync: ${err.message}`)
    }
  }

  // 4. Report back
  const summary: string[] = []
  summary.push(`✅ Clone complete for **${guild.name}**`)
  summary.push(`• Channels created: ${created}`)
  summary.push(`• Channels reused (matched by name): ${reused}`)
  summary.push(`• Categories created: ${categoriesCreated}`)
  summary.push(`• Mappings written: ${added.length}`)
  if (cloneRoles) summary.push(`• Roles created: ${rolesCreated}`)
  if (failures.length) {
    summary.push('')
    summary.push(`⚠️ ${failures.length} failure(s):`)
    summary.push(...failures.map(f => `  • ${f}`))
  }

  await command.editReply({ content: joinLinesWithinDiscordLimit(summary) })
}

// Start Harmony client
harmonyClient.connect().catch(error => {
  console.error('❌ Failed to connect to Harmony:', error)
  process.exit(1)
})

// ---------------------------------------------------------------------------
// Live YAML reload: when bridge-config.yml changes (manual edit, or our own
// `/bridge link` / clone-server writes), pick up the new mappings without a
// restart. We re-subscribe to any newly-added Harmony channels and re-register
// the bridge data with the gateway so the frontend autosuggest reflects the
// new mapping set.
//
// The mapper's own save flips a `savingSelf` flag to suppress the
// imminent fs-watch event, so our own writes don't trigger this handler
// twice and only manual edits / out-of-process edits cause a reload.
// ---------------------------------------------------------------------------
mapper.on('configReloaded', async ({ previous, current }: { previous: any[]; current: any[] }) => {
  const prevIds = new Set(previous.map((m: any) => m.harmony))
  const currIds = new Set(current.map((m: any) => m.harmony))
  const newlyAdded = current.filter((m: any) => !prevIds.has(m.harmony))
  const removed = previous.filter((m: any) => !currIds.has(m.harmony))

  for (const mapping of newlyAdded) {
    console.log(`📡 Live-reload: subscribing to new Harmony channel ${mapping.name || mapping.harmony}`)
    try {
      const recent = await harmonyClient.loadRecentMessages(mapping.harmony, 50)
      for (const m of recent) {
        if (m.metadata?.discord_message_id && m.id) {
          discordToHarmonyMessages.set(m.metadata.discord_message_id, m.id)
          harmonyToDiscordMessages.set(m.id, m.metadata.discord_message_id)
        }
      }
    } catch (err) {
      console.error(`❌ Failed to subscribe to ${mapping.harmony}:`, err)
    }
  }
  if (removed.length > 0) {
    console.log(`📤 Live-reload: ${removed.length} mapping(s) removed`)
  }
  // Re-broadcast to the gateway so the frontend autosuggest is in sync.
  registerBridgeDataWithGateway()
})
mapper.startWatching()

// Graceful shutdown
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

function shutdown() {
  console.log('📥 Shutting down bridge...')
  if (harmonyUserCacheTimer) {
    clearInterval(harmonyUserCacheTimer)
    harmonyUserCacheTimer = null
  }
  permissionSync.detach()
  mapper.stopWatching()
  discordClient.destroy()
  harmonyClient.disconnect()
  process.exit(0)
}

