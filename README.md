# Discord ↔ Harmony bridge

Mirrors messages (and reactions, attachments, mentions) between a Discord
server and a Harmony server.

Standalone repo — run it with Docker or Node. It only talks to Harmony's
**bot-gateway** (WebSocket + REST). Not the database, not Supabase/storage.

## Run it

```bash
cp config/bridge-config.example.yml config/bridge-config.yml
# fill in tokens + channel mappings
docker compose up -d
docker compose logs -f
```

Config hot-reloads when you edit `bridge-config.yml`.

## URLs

Three fields under `harmony:`:

- `gatewayUrl` — WebSocket
- `apiUrl` — REST **base** (no `/api/v1` suffix; the bridge appends it)
- `baseUrl` — public Harmony site URL (`@user@domain` mentions on Discord)

`db.mony.lol` / your Supabase host is storage. Bots don't connect there.

### Bridging to har.mony.lol

Bridge on the **same box** as the instance (normal for har admins):

```yaml
harmony:
  gatewayUrl: "ws://localhost:3002/gateway"
  apiUrl: "http://localhost:3002"
  baseUrl: "https://har.mony.lol"
```

Bridge on your laptop / another VPS:

```yaml
harmony:
  gatewayUrl: "wss://har.mony.lol/bot-gateway/gateway"
  apiUrl: "https://har.mony.lol/bot-gateway"
  baseUrl: "https://har.mony.lol"
```

### Your own instance

Same split. Co-located → `localhost:3002`. Remote →
`wss://your-domain/bot-gateway/...`. Nginx needs to proxy `/bot-gateway` to
port 3002 — see
[bot-gateway setup](https://github.com/y4my4my4m/harmony/blob/main/docs/BOT_GATEWAY_SETUP.md).

### Local dev

```yaml
harmony:
  gatewayUrl: "ws://localhost:3002/gateway"
  apiUrl: "http://localhost:3002"
  baseUrl: "http://localhost:5173"
```

Harmony (`npm run dev`), bot-gateway (`cd bot-gateway && npm run dev`), then
start the bridge.

## Tokens & channel IDs

**Discord:** bot token from the
[developer portal](https://discord.com/developers/applications) (enable
**Message Content Intent**). Guild + channel IDs via Developer Mode → right-click
→ Copy ID.

**Harmony:** bot token from admin → Bot Management. Server/channel UUIDs from
the URL or server settings. Bot needs read + send on the target server; manage
channels if you want `/bridge clone-server`.

Invite the Discord bot with scopes `bot` + `applications.commands`. Permissions:
view/send/read history, reactions, manage webhooks (for avatar puppeting).

Example config:

```yaml
discord:
  token: "..."
  guildId: "..."

harmony:
  token: "..."
  gatewayUrl: "ws://localhost:3002/gateway"
  apiUrl: "http://localhost:3002"
  serverId: "..."
  baseUrl: "https://har.mony.lol"

channelMappings:
  - discord: "DISCORD_CHANNEL_ID"
    harmony: "HARMONY_CHANNEL_UUID"
    bidirectional: true
    name: "general"
```

## Slash commands

`/mention` / `/m` — ping Harmony users from Discord (autocomplete).

`/bridge` — manage mappings from Discord (needs Manage Server; mutating stuff
needs server owner). Subcommands: `status`, `link`, `unlink`, `clone-server`.

`clone-server` copies Discord channels (and optionally roles) into Harmony.
Additive only — safe to re-run. Doesn't copy member role assignments (no account
link between platforms).

## Settings

```yaml
settings:
  syncAttachments: true
  syncReactions: true
  syncEdits: false
  syncDeletes: false
  mentionTranslation: true
  cloneRoles: false
  syncPermissions: false
```

`syncPermissions: true` mirrors Discord role/channel override changes into
Harmony live. Still doesn't sync who has which role.

## Attachments

Discord CDN links expire (~24–72h). There is no permanent unsigned Discord URL.

**Instance admins** set policy in Admin Panel → Configuration → Chat →
**Bridge attachments** (`bridge_attachment_mode`):

| Mode | What it does |
|------|----------------|
| **link** (default) | Store Discord CDN URL as-is. Breaks when it expires. |
| **mirror** | Copy into `user_media` on ingest. Permanent, but **uses your disk**. |

The policy is enforced **server-side** by the bot-gateway: the bridge always
forwards the original Discord URL, and the gateway mirrors it into `user_media`
when (and only when) the instance mode is `mirror`. Bot owners cannot override it.

Harmony-native uploads already use public `user_media` URLs (no expiry).

## When it breaks

**Can't connect** — wrong `gatewayUrl`/`apiUrl` for your setup. Try
`curl http://localhost:3002/health` or
`curl https://har.mony.lol/bot-gateway/health`.

**404 on API calls** — you probably set `apiUrl` to `.../api/v1`. Drop the suffix.

**Messages not flowing** — channel IDs, bot perms, Message Content Intent.

**Weird `@user@db.mony.lol` mentions** — `baseUrl` should be the Harmony
website, not storage.

## Hacking on it

```bash
npm ci && cp config/bridge-config.example.yml config/bridge-config.yml
npm run dev
```

Node 20+.

## License

AGPL-3.0
