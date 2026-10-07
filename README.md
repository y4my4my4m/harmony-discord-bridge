# Harmony ↔ Discord bridge

Connects a Discord server with a [Harmony](https://github.com/y4my4my4m/harmony)
server. Messages, replies, mentions, reactions, attachments, edits and
deletions flow both ways between the channels you pair. People on Discord show
up in Harmony with their Discord name and picture, and Harmony users show up
in Discord the same way.

The bridge is a small program that logs in as **your own Discord bot**.

## Two ways to run it

| | Hosted by your Harmony instance | Run it yourself |
|---|---|---|
| What you install | Nothing | Docker, then one command |
| Where it runs | On the Harmony instance's server | Your PC, a home server, a NAS, a Raspberry Pi, a VPS… |
| Who holds your Discord bot token | The instance operator | Only you |
| Available | Only if the instance operator turned hosting on | Always |

Both start in Harmony: open your server, then **Server Settings → Discord
Bridge**. The page walks you through creating the Discord bot and shows which
of the two options your instance offers.

- **Hosted:** paste your Discord bot token into that page. Done; of this guide
  you only need [Create the Discord bot](#1-create-the-discord-bot) and
  [Privacy](#privacy).
- **Run it yourself:** follow the steps below.

## Run it yourself

### 1. Create the Discord bot

1. Go to <https://discord.com/developers/applications> and click **New
   Application**. Give it a name (this is the name people see in Discord).
2. Open **Bot** in the left menu.
   - Click **Reset Token**, then **Copy**. This is your `DISCORD_TOKEN`.
     Keep it secret: anyone with it controls your bot.
   - Under **Privileged Gateway Intents**, switch on:
     - **Message Content Intent**: required.
     - **Server Members Intent**: needed for the Discord member list in
       Harmony (on by default in the bridge settings).
     - **Presence Intent**: only if you turn on presence sync in Harmony.
   - Click **Save Changes**.
3. Invite the bot to your Discord server. Harmony's Discord Bridge page shows
   an invite link once the bridge has started. To make the link yourself,
   replace `YOUR_APPLICATION_ID` (from **General Information**) in:

   ```
   https://discord.com/api/oauth2/authorize?client_id=YOUR_APPLICATION_ID&permissions=536988736&scope=bot%20applications.commands
   ```

   This grants View Channels, Send Messages, Embed Links, Attach Files, Read
   Message History, Add Reactions and Manage Webhooks. For `/bridge
   clone-server`, use `permissions=536988752` (adds Manage Channels).

### 2. Get a setup code from Harmony

In Harmony: **Server Settings → Discord Bridge → Run it yourself**. Copy the
setup code (it looks like `HB-XXXX-XXXX-XXXX`). A code works once and expires
after 30 minutes; you can always generate a new one.

### 3. Install Docker

- **Windows or macOS:** install [Docker Desktop](https://www.docker.com/products/docker-desktop/)
  and start it.
- **Linux, VPS, Raspberry Pi (64-bit OS):** run
  `curl -fsSL https://get.docker.com | sh` (then log out and back in, or put
  `sudo` in front of the `docker` commands below).
- **NAS (Synology, QNAP, Unraid, TrueNAS):** use its container app (e.g.
  Synology Container Manager). See [On a NAS](#on-a-nas).

### 4. Start the bridge

Open a terminal (Windows: **PowerShell**; macOS: **Terminal**) and run this
one line, with your three values filled in:

```
docker run -d --name harmony-bridge --restart unless-stopped -v harmony-bridge:/data -e HARMONY_URL=https://har.mony.lol -e HARMONY_SETUP_CODE=HB-XXXX-XXXX-XXXX -e DISCORD_TOKEN=paste-your-token-here ghcr.io/y4my4my4m/harmony-discord-bridge:latest
```

- `HARMONY_URL` is the address of your Harmony instance (what you type in
  the browser).
- The bridge keeps its Harmony credentials in the `harmony-bridge` volume, so
  the setup code is only needed this first time.
- It starts again by itself after a reboot.

Check that it runs:

```
docker logs harmony-bridge
```

Within a minute Harmony's Discord Bridge page shows the bot as connected. If
the bot is in exactly one Discord server, that server is picked
automatically; otherwise pick it there.

### 5. Pair channels

Pair a Discord channel with a Harmony channel either:

- in Harmony, on the Discord Bridge page, or
- in Discord: type `/bridge link` in the Discord channel and choose the
  Harmony channel from the list (needs the Discord **Administrator**
  permission).

New messages flow from then on.

### With docker compose

Instead of `docker run`, download [`docker-compose.yml`](docker-compose.yml),
fill in the three values and run `docker compose up -d` in its folder.

### On a NAS

Create a container from the image
`ghcr.io/y4my4my4m/harmony-discord-bridge:latest`:

- environment variables `HARMONY_URL`, `HARMONY_SETUP_CODE`, `DISCORD_TOKEN`;
- a folder or volume mounted at `/data`. A folder must be writable by user id
  1000 (`chown 1000:1000 <folder>`);
- restart policy "unless stopped" / "always".

### Updating

```
docker pull ghcr.io/y4my4my4m/harmony-discord-bridge:latest
docker rm -f harmony-bridge
```

Then run the same `docker run` line as before; `HARMONY_SETUP_CODE` can be
left out. With compose: `docker compose pull && docker compose up -d`.

### Removing

```
docker rm -f harmony-bridge
docker volume rm harmony-bridge
```

Then delete the bridge in Harmony's Discord Bridge page and, if you like, the
application in the Discord Developer Portal.

## Settings

All settings are environment variables (`-e NAME=value`).

| Variable | Needed | Meaning |
|---|---|---|
| `HARMONY_URL` | yes | Your Harmony address, e.g. `https://har.mony.lol`. On the same machine as Harmony you can point it at bot-gateway directly (`http://localhost:3002`). |
| `HARMONY_SETUP_CODE` | first start | One-time code from Server Settings → Discord Bridge. A different code later replaces the saved credentials. |
| `DISCORD_TOKEN` | yes | Your Discord bot token. |
| `DATA_DIR` | no | Where credentials are kept. Default `/data` in Docker, otherwise the `data` folder next to the program. |
| `LOG_LEVEL` | no | `error`, `warn`, `info` (default) or `debug`. Only `debug` prints message contents. |
| `HEALTH_PORT` | no | Port of the `/health` status endpoint, default `8080`. `off` disables it. |

Which channels are paired and what is synced (member list, presence,
reactions, edits, deletions) is set in Harmony's Discord Bridge page; the
bridge picks up changes within seconds.

## Discord commands

- `/mention` (or `/m`): mention Harmony users from Discord, with autocomplete.
- `/bridge status`: paired channels and any problems, in plain language.
- `/bridge link` / `/bridge unlink`: pair or unpair the current channel.
- `/bridge clone-server`: create a Harmony channel for every Discord channel
  (and optionally the roles) and pair them. Never overwrites; safe to re-run.
- `/bridge sync-order`: copy Discord's channel and category order to Harmony.

`/bridge` needs the Discord **Administrator** permission.

## Troubleshooting

Harmony's Discord Bridge page and `/bridge status` list problems with the fix.
The same codes appear in `docker logs harmony-bridge` and at
`http://localhost:8080/health` (inside the container).

| Problem | What it means | Fix |
|---|---|---|
| `discord_token_invalid` | Discord rejected the bot token. | Developer Portal → Bot → **Reset Token**, then recreate the container with the new `DISCORD_TOKEN` (hosted: paste it in Harmony). |
| `intent_missing` | A Privileged Gateway Intent is off (Message Content, Server Members or Presence). | Developer Portal → Bot → switch the named intent on, **Save**. The bridge picks it up within a few minutes. |
| `no_guild` | The bot is in no Discord server. | Invite it with the link from step 1. |
| `guild_not_selected` | The bot is in several Discord servers. | Pick one in Harmony's Discord Bridge page. |
| `bot_not_in_guild` | The bot left (or was kicked from) the chosen Discord server. | Invite it again, or pick another server. |
| `channel_not_visible` | The bot cannot see a paired Discord channel. | Give the bot **View Channel** on it (channel settings → Permissions). |
| `cannot_send` | The bot cannot post in a paired channel. | Give the bot **Send Messages** on it. |
| `cannot_manage_webhooks` | Harmony messages appear under the bot's name instead of the author's. | Give the bot **Manage Webhooks** on that channel. |
| `harmony_auth_failed` | Harmony rejected the bridge's credentials (bridge deleted, or a newer setup code was used elsewhere). | Generate a new setup code and recreate the container with it. |
| `harmony_channel_missing` | A paired Harmony channel was deleted. | Unpair it and pair another channel. |
| `harmony_channel_encrypted` | A paired Harmony channel is end-to-end encrypted; bridges cannot read it. | Pair a channel without end-to-end encryption. |
| `rate_limited` | Discord or Harmony slowed the bridge down; some messages were dropped after retries. | Usually passes by itself. |
| `discord_unreachable` | No connection to Discord. | Check the machine's internet connection. |
| `harmony_unreachable` | No connection to Harmony. | Check `HARMONY_URL` and the internet connection. |

Other messages:

- **"Harmony Discord bridge is not configured"**: `HARMONY_URL`,
  `HARMONY_SETUP_CODE` or `DISCORD_TOKEN` is missing.
- **"Harmony refused the setup code"**: the code was already used or is older
  than 30 minutes. Generate a new one.
- **"Cannot write /data/credentials.json"**: the `/data` folder is not
  writable. Use a named volume (`-v harmony-bridge:/data`) or
  `chown 1000:1000` the folder.

## Privacy

- The bridge reads every Discord channel the bot can see. **Give the bot
  access only to the channels you bridge**: deny its role View Channel
  elsewhere.
- With **hosted** bridges, the Harmony instance operator holds your bot token
  and could read any channel the bot can see. Run it yourself if that matters.
- Logs contain ids and counts, not message contents, unless `LOG_LEVEL=debug`.
- Credentials are stored in `/data/credentials.json`, readable only by the
  bridge's user.

---

## For developers

### Layout

| Path | Role |
|---|---|
| `src/index.ts` | Entry: picks the mode (self, host, legacy v1), health endpoint, signals. |
| `src/env.ts` | Environment → launch plan; the "not configured" message. |
| `src/v2/launch.ts` | Self mode (probe, redeem, run one bridge) and host mode (run many). |
| `src/v2/endpoints.ts` | `HARMONY_URL` → bot-gateway REST and WebSocket URLs. |
| `src/v2/credentials.ts` | Setup-code redeem, `credentials.json` (0600). |
| `src/v2/BridgeApi.ts` | `/bridge/v2` client: redeem, config, status, pairs, hosted. |
| `src/v2/V2Bridge.ts` | One v2 bridge: config refresh (60 s + `BRIDGE_CONFIG_UPDATE`), status heartbeat (30 s). |
| `src/v2/V2Directory.ts` | `/config` as a pair directory; settings defaults. |
| `src/v2/HostRunner.ts` | Host mode reconciliation of `/hosted`. |
| `src/v2/selfCheck.ts` | Guild/channel permission snapshot, status payload. |
| `src/problems.ts` | Problem codes, detection, plain-language text. |
| `src/runtime/BridgeRuntime.ts` | One Discord client + one Harmony connection; message, reaction, edit and delete bridging. |
| `src/runtime/discordConnection.ts` | Intent selection, Discord preflight, close-code handling. |
| `src/runtime/commands.ts` | Slash commands. |
| `src/runtime/PairDirectory.ts` | Interfaces shared by the YAML and API configurations. |
| `src/v1/runV1.ts`, `src/ChannelMapper.ts` | Legacy `bridge-config.yml`. |
| `src/HarmonyClient.ts` | bot-gateway WebSocket (IDENTIFY, events) and REST (`/api/v1`). |
| `src/MessageTranslator.ts` | Discord ↔ Harmony message parts. |
| `src/http.ts` | Bounded retry (429 `Retry-After`, 5xx on idempotent calls), backoff. |

### From source

Node 20 or newer.

```bash
npm ci
HARMONY_URL=http://localhost:3002 HARMONY_SETUP_CODE=HB-... DISCORD_TOKEN=... DATA_DIR=./data npm run dev
npm test            # vitest
npm run typecheck
npm run build && npm start
```

`.env` in the working directory is read too.

### bot-gateway contract

`/bridge/v2` on bot-gateway (`<HARMONY_URL>/bot-gateway` behind the standard
proxy):

- `POST /redeem {code}` → bridge credentials (no auth).
- `GET /config`, `POST /status`, `POST /pairs`, `DELETE /pairs/:discord_channel_id`
  with `Authorization: Bot <harmony_token>`.
- `GET /hosted` with `X-Bridge-Host-Secret` (host mode).
- Gateway event `BRIDGE_CONFIG_UPDATE` triggers an immediate `/config` fetch.

Messages use the ordinary bot API (`/api/v1`) and WebSocket gateway.

### Host mode (instance operators)

Runs every bridge whose community chose "hosted". Turn hosting on in the
Harmony admin settings, and set the same `BRIDGE_HOST_SECRET` on bot-gateway
and here:

| Variable | Meaning |
|---|---|
| `BRIDGE_MODE` | `host` |
| `HARMONY_URL` | bot-gateway, e.g. `http://bot-gateway:3002` on the Docker network, or the public address. |
| `BRIDGE_HOST_SECRET` | Shared secret for `GET /bridge/v2/hosted`. |
| `HARMONY_PUBLIC_URL` | Public Harmony address, when `HARMONY_URL` points at bot-gateway directly. |
| `DATA_DIR`, `LOG_LEVEL`, `HEALTH_PORT` | As above. |

The list is re-read every 60 s: new bridges start, removed ones stop, changed
tokens restart. One bridge failing does not affect the others. `/health` is
200 while the list loads and reports each bridge.

### Behavior notes

- Harmony → Discord posts through a channel webhook named "Harmony Bridge"
  (author name and avatar). Without Manage Webhooks it posts as the bot, as
  `**Name**: message`. The webhook's own avatar is the Harmony instance icon.
- Messages over 2000 characters are split at line breaks or spaces; code
  blocks are closed and reopened across the split.
- Edits and deletions after a restart use the Discord ids stored in the
  Harmony message metadata (`discord_message_id`, `discord_message_ids`,
  `discord_via_webhook`).
- A Harmony reaction shows as one bot reaction on Discord; it is removed when
  the last Harmony user removes theirs.
- Rate-limited requests are retried within bounds (`Retry-After`, at most 60 s
  per wait, 4 attempts); a message dropped after that is counted in the log
  and reported as `rate_limited`.

### Attachments

Discord CDN links expire (~24–72 h). The instance admin chooses the policy in
Admin Panel → Configuration → Chat → **Bridge attachments**
(`bridge_attachment_mode`), enforced by bot-gateway:

| Mode | Behavior |
|---|---|
| **link** (default) | Stores the Discord CDN URL; it breaks when it expires. |
| **refresh** | Re-signs an expired URL on demand when someone views it (no disk use). |
| **mirror** | Copies the file into Harmony storage on arrival (permanent, uses disk). |

### Legacy YAML configuration (v1)

Bridges set up before v2 use `config/bridge-config.yml` and keep working
unchanged; the bridge uses it when `HARMONY_URL` is not set. The file is
looked up at `./config/bridge-config.yml` in the working directory, then next
to the program (`BRIDGE_CONFIG` overrides the path). Copy
[`config/bridge-config.example.yml`](config/bridge-config.example.yml) to
start. Permission-sync state goes to `data/permission-sync.yml` beside the
`config` folder. The `/health` endpoint is off unless `HEALTH_PORT` is set
(the Docker image sets it).

`harmony:` takes three URLs:

- `gatewayUrl`: WebSocket, e.g. `wss://har.mony.lol/bot-gateway/gateway`, or
  `ws://localhost:3002/gateway` on the same machine.
- `apiUrl`: REST base without `/api/v1`, e.g. `https://har.mony.lol/bot-gateway`
  or `http://localhost:3002`.
- `baseUrl`: the public Harmony site (used for `@user@domain` mentions).

`bridges:` pairs several Discord servers with Harmony servers under one bot;
see the example file. Settings:

```yaml
settings:
  syncReactions: true
  syncEdits: false
  syncDeletes: false
  syncPresence: true      # needs Server Members + Presence intents
  cloneRoles: false
  syncPermissions: false  # mirror Discord role/channel overrides into Harmony
```

In Docker, mount `./config:/app/config` and `./data:/app/data` (writable by
uid 1000) and leave the v2 variables unset. Nginx/Caddy setup for bot-gateway:
[BOT_GATEWAY_SETUP.md](https://github.com/y4my4my4m/harmony/blob/master/docs/BOT_GATEWAY_SETUP.md).

## License

AGPL-3.0
