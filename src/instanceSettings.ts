export type BridgeAttachmentMode = 'link' | 'mirror'

let cachedMode: BridgeAttachmentMode = 'link'
let cachedAt = 0
const CACHE_MS = 60_000

export function getAttachmentMode(): BridgeAttachmentMode {
  return cachedMode
}

export async function refreshInstanceBridgeSettings(apiUrl: string, botToken: string): Promise<void> {
  if (Date.now() - cachedAt < CACHE_MS) return

  try {
    const response = await fetch(`${apiUrl}/api/v1/instance/bridge-settings`, {
      headers: { Authorization: `Bot ${botToken}` },
    })
    if (!response.ok) {
      console.warn(`⚠️ Could not load instance bridge settings (${response.status})`)
      return
    }
    const data = await response.json() as { attachmentMode?: string }
    const mode = data.attachmentMode
    if (mode === 'mirror' || mode === 'link') {
      if (mode !== cachedMode) {
        console.log(`📋 Instance attachment mode: ${cachedMode} → ${mode}`)
      }
      cachedMode = mode
      cachedAt = Date.now()
    }
  } catch (error) {
    console.warn('⚠️ Failed to fetch instance bridge settings:', error)
  }
}
