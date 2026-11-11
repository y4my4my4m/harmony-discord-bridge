import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type ChatInputCommandInteraction,
} from 'discord.js'
import { errorText } from '../log.js'

/**
 * Shows `content` with Confirm / Cancel buttons by editing the deferred reply. Only the user who
 * ran the command can press; no answer within `timeoutMs` counts as Cancel. Resolves true on Confirm.
 * A timeout cancels silently; any other failure (e.g. updating the button message) is logged
 * through `log` before cancelling.
 */
export async function confirmAction(
  command: ChatInputCommandInteraction,
  content: string,
  timeoutMs = 60_000,
  log?: { warn(msg: string): void },
): Promise<boolean> {
  const confirmId = `confirm:${command.id}`
  const cancelId = `cancel:${command.id}`
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(confirmId).setLabel('Confirm').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  )
  const message = await command.editReply({ content, components: [row] })
  let press
  try {
    press = await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: i => i.user.id === command.user.id && (i.customId === confirmId || i.customId === cancelId),
      time: timeoutMs,
    })
  } catch {
    await command.editReply({ content: 'Cancelled, nothing changed.', components: [] })
    return false
  }
  try {
    if (press.customId === confirmId) {
      await press.update({ content: '⏳ Working…', components: [] })
      return true
    }
    await press.update({ content: 'Cancelled, nothing changed.', components: [] })
    return false
  } catch (err) {
    log?.warn(`Confirm prompt failed, treating as cancel: ${errorText(err)}`)
    await command.editReply({ content: 'Cancelled, nothing changed.', components: [] })
    return false
  }
}
