import type { HarmonyClient } from './HarmonyClient.js'
import { getAttachmentMode } from './instanceSettings.js'

function isDiscordCdnUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host.endsWith('discordapp.com') || host.endsWith('discordapp.net')
  } catch {
    return false
  }
}

function isHarmonyStoredUrl(url: string): boolean {
  return /\/storage\/v1\/object\/public\/user_media\//i.test(url)
}

/** Mirror Discord attachments when instance admin has set mode=mirror. */
export async function applyInstanceAttachmentPolicy(
  parts: any[],
  harmonyClient: HarmonyClient,
  syncAttachments: boolean,
): Promise<any[]> {
  if (!syncAttachments || getAttachmentMode() !== 'mirror') return parts

  const out: any[] = []
  for (const part of parts) {
    if (part?.type !== 'file' || !part.url || isHarmonyStoredUrl(part.url) || !isDiscordCdnUrl(part.url)) {
      out.push(part)
      continue
    }
    try {
      const mirroredUrl = await harmonyClient.mirrorMedia(part.url, part.fileName)
      out.push({ ...part, url: mirroredUrl })
      console.log(`📎 Mirrored to instance storage`)
    } catch (error: any) {
      console.error(`⚠️ Mirror failed, keeping Discord URL: ${error?.message || error}`)
      out.push(part)
    }
  }
  return out
}
