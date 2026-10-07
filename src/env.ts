import { normalizeHarmonyUrl } from './v2/endpoints.js'

export const README_URL = 'https://github.com/y4my4my4m/harmony-discord-bridge#readme'
export const DEFAULT_HEALTH_PORT = 8080

export type LaunchPlan =
  | { kind: 'v1'; configPath: string; healthPort: number | null }
  | {
      kind: 'self'
      harmonyUrl: string
      setupCode: string | null
      discordToken: string
      healthPort: number | null
      /** bridge-config.yml present but ignored because HARMONY_URL is set. */
      ignoredLegacyConfig: string | null
    }
  | {
      kind: 'host'
      harmonyUrl: string
      hostSecret: string
      publicUrl: string | null
      healthPort: number | null
    }
  | { kind: 'error'; message: string }

const NOT_CONFIGURED = [
  'Harmony Discord bridge is not configured.',
  '',
  'Set these environment variables:',
  '  HARMONY_URL         your Harmony address, e.g. https://har.mony.lol',
  '  HARMONY_SETUP_CODE  the setup code from Harmony → Server Settings → Discord Bridge (first run only)',
  '  DISCORD_TOKEN       your Discord bot token',
  '',
  'Example:',
  '  docker run -d --name harmony-bridge --restart unless-stopped -v harmony-bridge:/data \\',
  '    -e HARMONY_URL=https://har.mony.lol -e HARMONY_SETUP_CODE=HB-XXXX-XXXX-XXXX -e DISCORD_TOKEN=... \\',
  '    ghcr.io/y4my4my4m/harmony-discord-bridge:latest',
  '',
  `Step-by-step guide: ${README_URL}`,
].join('\n')

function value(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key]?.trim()
  return raw ? raw : null
}

/** HEALTH_PORT: unset → fallback; "0"/"off"/"false" → disabled. */
function parseHealthPort(raw: string | null, fallback: number | null): number | null | 'invalid' {
  if (raw === null) return fallback
  if (/^(0|off|false|no|disabled?)$/i.test(raw)) return null
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'invalid'
  return port
}

/**
 * Mode selection:
 * - BRIDGE_MODE=host → host runner (HARMONY_URL, BRIDGE_HOST_SECRET);
 * - HARMONY_URL set → self-hosted v2 (HARMONY_SETUP_CODE on first run, DISCORD_TOKEN);
 * - bridge-config.yml found → legacy v1;
 * - otherwise → error with setup instructions.
 */
export function planLaunch(env: NodeJS.ProcessEnv, legacyConfigPath: string | null): LaunchPlan {
  const mode = (value(env, 'BRIDGE_MODE') ?? '').toLowerCase()
  if (mode && mode !== 'host' && mode !== 'self' && mode !== 'v1') {
    return { kind: 'error', message: `BRIDGE_MODE="${env.BRIDGE_MODE}" is not recognised. Use BRIDGE_MODE=host, or leave it unset.` }
  }

  const rawUrl = value(env, 'HARMONY_URL')
  const rawPort = value(env, 'HEALTH_PORT')

  if (mode === 'host') {
    const hostSecret = value(env, 'BRIDGE_HOST_SECRET')
    const missing = [!rawUrl && 'HARMONY_URL', !hostSecret && 'BRIDGE_HOST_SECRET'].filter(Boolean)
    if (missing.length > 0) {
      return {
        kind: 'error',
        message: `BRIDGE_MODE=host needs ${missing.join(' and ')}. BRIDGE_HOST_SECRET must match the bot-gateway's BRIDGE_HOST_SECRET.`,
      }
    }
    let harmonyUrl: string
    let publicUrl: string | null = null
    try {
      harmonyUrl = normalizeHarmonyUrl(rawUrl!)
      const rawPublic = value(env, 'HARMONY_PUBLIC_URL')
      if (rawPublic) publicUrl = normalizeHarmonyUrl(rawPublic)
    } catch (err) {
      return { kind: 'error', message: (err as Error).message }
    }
    const healthPort = parseHealthPort(rawPort, DEFAULT_HEALTH_PORT)
    if (healthPort === 'invalid') return { kind: 'error', message: `HEALTH_PORT="${rawPort}" is not a port number.` }
    return { kind: 'host', harmonyUrl, hostSecret: hostSecret!, publicUrl, healthPort }
  }

  if (rawUrl && mode !== 'v1') {
    let harmonyUrl: string
    try {
      harmonyUrl = normalizeHarmonyUrl(rawUrl)
    } catch (err) {
      return { kind: 'error', message: (err as Error).message }
    }
    const discordToken = value(env, 'DISCORD_TOKEN')
    if (!discordToken) {
      return {
        kind: 'error',
        message: 'DISCORD_TOKEN is not set. Copy your bot token from https://discord.com/developers/applications → your app → Bot → Reset Token, and set DISCORD_TOKEN.',
      }
    }
    const healthPort = parseHealthPort(rawPort, DEFAULT_HEALTH_PORT)
    if (healthPort === 'invalid') return { kind: 'error', message: `HEALTH_PORT="${rawPort}" is not a port number.` }
    return {
      kind: 'self',
      harmonyUrl,
      setupCode: value(env, 'HARMONY_SETUP_CODE'),
      discordToken,
      healthPort,
      ignoredLegacyConfig: legacyConfigPath,
    }
  }

  if (legacyConfigPath) {
    const healthPort = parseHealthPort(rawPort, null)
    if (healthPort === 'invalid') return { kind: 'error', message: `HEALTH_PORT="${rawPort}" is not a port number.` }
    return { kind: 'v1', configPath: legacyConfigPath, healthPort }
  }

  return { kind: 'error', message: NOT_CONFIGURED }
}
