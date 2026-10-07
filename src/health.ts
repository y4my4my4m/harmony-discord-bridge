import { createServer, type Server } from 'http'
import type { Logger } from './log.js'

export interface HealthReport {
  /** 200 when true, 503 otherwise. */
  ok: boolean
  body: Record<string, unknown>
}

/** A running bridge (v1, self, or host runner). */
export interface Launched {
  stop(): Promise<void>
  health(): HealthReport
}

/**
 * GET /health → JSON. Listen failures (port taken) are logged, not fatal:
 * the bridge keeps running without the endpoint.
 */
export function startHealthServer(opts: {
  port: number
  host?: string
  log: Logger
  report: () => HealthReport
  version: string
}): Promise<Server | null> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end()
      return
    }
    if (path !== '/health' && path !== '/healthz') {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not found"}')
      return
    }
    let report: HealthReport
    try {
      report = opts.report()
    } catch (err) {
      report = { ok: false, body: { error: err instanceof Error ? err.message : String(err) } }
    }
    const body = JSON.stringify({ status: report.ok ? 'ok' : 'degraded', version: opts.version, ...report.body })
    res.writeHead(report.ok ? 200 : 503, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  })

  return new Promise(resolve => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      opts.log.warn(`Health endpoint not started on port ${opts.port}: ${err.code ?? err.message}`)
      resolve(null)
    })
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => {
      opts.log.info(`Health endpoint: http://${opts.host ?? '0.0.0.0'}:${opts.port}/health`)
      resolve(server)
    })
  })
}
