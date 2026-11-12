import type { ImportJob } from '../v2/BridgeApi.js'

/**
 * Progress of an import job, 0..100: how far back from the start point the walk has reached,
 * against the channel's age. Same formula as the Harmony app. Null when a timestamp is missing.
 */
export function importPercent(
  job: Pick<ImportJob, 'state' | 'start_at' | 'reached_at' | 'channel_created_at'>,
): number | null {
  if (job.state === 'done') return 100
  if (!job.start_at || !job.reached_at || !job.channel_created_at) return null
  const start = Date.parse(job.start_at)
  const reached = Date.parse(job.reached_at)
  const created = Date.parse(job.channel_created_at)
  if (Number.isNaN(start) || Number.isNaN(reached) || Number.isNaN(created)) return null
  const span = start - created
  if (span <= 0) return null
  return Math.min(100, Math.max(0, Math.round((100 * (start - reached)) / span)))
}
