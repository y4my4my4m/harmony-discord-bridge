# Discord Bridge - TODO

## High Priority

### Fix Supabase Realtime (replace polling)
Currently using polling for message edits/deletes because Supabase Realtime subscriptions time out:
```
📡 Message updates subscription: TIMED_OUT
📡 Message deletes subscription: TIMED_OUT
```

**Current workaround:** Bot-gateway polls the database every 2 seconds and compares cached content vs DB content.

**Proper fix needed:**
- [ ] Debug why Realtime subscriptions fail (check Supabase config, service role permissions)

### Message mapping persistence
- Mappings live in memory (LRU, 50k); Discord ids are also stored in Harmony message metadata and restored from the last 100 messages per paired channel at startup
- [ ] Edits/reactions on messages older than that window are not bridged after a restart

---

## Medium Priority

### Improve edit/delete tracking
- [ ] Current 72h/10k message cache is arbitrary - consider making configurable
- [ ] Add metrics/logging for cache hit rate
- [ ] Handle edge case: message edited while bridge was offline

### Thread/Reply support
- [ ] Bridge Discord thread messages to Harmony replies
- [ ] Bridge Harmony replies to Discord threads or reply references

### Attachment handling notes
- Discord CDN URLs in messages expire (~24–72h); Discord has no permanent public link
- [ ] On-demand proxy (stream from Discord at view time, no storage) vs optional mirror
- [ ] Store attachment IDs + refresh URL from Discord API when loading old messages

---

## Low Priority / Nice to Have

### Performance
- [ ] Batch Discord webhook calls if multiple Harmony messages arrive quickly

### Features
- [ ] Bridge Discord embeds to Harmony (link previews)
- [ ] Bridge Harmony link previews to Discord embeds
- [ ] Support Discord stickers
- [ ] Bridge Discord slash commands other than `/m`

### Monitoring
- [ ] Expose metrics (messages bridged, errors, latency)

---

## Completed ✓

- [x] Bi-directional message bridging
- [x] User mentions (both directions)
- [x] Discord user autocomplete via `/m` slash command
- [x] Reaction bridging (Discord → Harmony with user attribution)
- [x] Reaction bridging (Harmony → Discord; bot-gateway now emits MESSAGE_REACTION_ADD/REMOVE)
- [x] Custom emoji bridging
- [x] Media/attachment bridging
- [x] Webhook puppeting (Harmony users appear with their name/avatar in Discord)
- [x] Discord users in Harmony autosuggest
- [x] Message edits (Harmony → Discord via polling, checks newest 100 messages)
- [x] Message deletes (Harmony → Discord via polling, detects soft-delete flag)
- [x] Message edits (Discord → Harmony)
- [x] Message deletes (Discord → Harmony)
- [x] `/health` endpoint; status heartbeat with problem codes to Harmony (v2)
- [x] Bounded retry honoring Retry-After for Harmony and Discord REST
- [x] Long Harmony messages split across several Discord messages

