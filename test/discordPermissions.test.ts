import { afterEach, describe, expect, it } from 'vitest'
import { PermissionFlagsBits } from 'discord.js'
import {
  discordBitfieldToHarmonyMask,
  setHarmonyPermissionBits,
} from '../src/utils/discordPermissions.js'

const NAMES = [
  'ADMINISTRATOR', 'VIEW_CHANNEL', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'MANAGE_EMOJIS', 'VIEW_AUDIT_LOG',
  'MANAGE_WEBHOOKS', 'MANAGE_SERVER', 'CREATE_INVITE', 'KICK_MEMBERS', 'BAN_MEMBERS', 'TIMEOUT_MEMBERS',
  'SEND_MESSAGES', 'SEND_MESSAGES_IN_THREADS', 'CREATE_PUBLIC_THREADS', 'CREATE_PRIVATE_THREADS',
  'EMBED_LINKS', 'ATTACH_FILES', 'ADD_REACTIONS', 'USE_EXTERNAL_EMOJIS', 'MENTION_EVERYONE',
  'MANAGE_MESSAGES', 'READ_MESSAGE_HISTORY', 'PIN_MESSAGES', 'CONNECT', 'SPEAK', 'STREAM',
  'MUTE_MEMBERS', 'DEAFEN_MEMBERS', 'MOVE_MEMBERS', 'USE_SOUNDBOARD', 'USE_EXTERNAL_SOUNDS',
  'CHANGE_NICKNAME', 'MANAGE_NICKNAMES',
]

const mask = (flag: bigint) => BigInt(discordBitfieldToHarmonyMask(flag))

describe('discord -> harmony permission mapping by name', () => {
  afterEach(() => setHarmonyPermissionBits(null))

  it('legacy fallback maps pin, soundboard, external sounds and skips nickname bits', () => {
    setHarmonyPermissionBits(null)
    expect(mask(PermissionFlagsBits.PinMessages)).toBe(1n << 23n)
    expect(mask(PermissionFlagsBits.UseSoundboard)).toBe(1n << 30n)
    expect(mask(PermissionFlagsBits.UseExternalSounds)).toBe(1n << 31n)
    expect(mask(PermissionFlagsBits.ChangeNickname)).toBe(0n)
    expect(mask(PermissionFlagsBits.ManageNicknames)).toBe(0n)
    expect(mask(PermissionFlagsBits.ViewChannel)).toBe(1n << 1n)
  })

  it('maps nickname permissions when the 34-name list is provided', () => {
    setHarmonyPermissionBits(NAMES)
    expect(mask(PermissionFlagsBits.ChangeNickname)).toBe(1n << 32n)
    expect(mask(PermissionFlagsBits.ManageNicknames)).toBe(1n << 33n)
    expect(mask(PermissionFlagsBits.PinMessages)).toBe(1n << 23n)
  })

  it('skips a name missing from the provided list', () => {
    setHarmonyPermissionBits(NAMES.filter(n => n !== 'PIN_MESSAGES'))
    expect(mask(PermissionFlagsBits.PinMessages)).toBe(0n)
    expect(mask(PermissionFlagsBits.SendMessages)).toBe(1n << 12n)
  })

  it('never maps administrator', () => {
    setHarmonyPermissionBits(NAMES)
    expect(mask(PermissionFlagsBits.Administrator)).toBe(0n)
  })
})
