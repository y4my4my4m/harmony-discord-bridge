export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }

export function parseLogLevel(raw: string | undefined): LogLevel {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === 'error' || value === 'warn' || value === 'info' || value === 'debug') return value
  if (value === 'warning') return 'warn'
  if (value === 'trace' || value === 'verbose') return 'debug'
  return 'info'
}

/**
 * Leveled console logger. Message contents and other user data go through
 * `debug` only; `info` and above carry ids, counts and states.
 */
export class Logger {
  constructor(
    readonly level: LogLevel = 'info',
    private readonly prefix = '',
    private readonly muted = false,
  ) {}

  child(prefix: string): Logger {
    return new Logger(this.level, this.prefix ? `${this.prefix} ${prefix}` : prefix, this.muted)
  }

  isDebug(): boolean {
    return LEVEL_ORDER[this.level] >= LEVEL_ORDER.debug
  }

  error(...args: unknown[]) { this.write('error', args) }
  warn(...args: unknown[]) { this.write('warn', args) }
  info(...args: unknown[]) { this.write('info', args) }
  debug(...args: unknown[]) { this.write('debug', args) }

  private write(level: LogLevel, args: unknown[]) {
    if (this.muted || LEVEL_ORDER[level] > LEVEL_ORDER[this.level]) return
    const line = this.prefix ? [this.prefix, ...args] : args
    if (level === 'error') console.error(...line)
    else if (level === 'warn') console.warn(...line)
    else console.log(...line)
  }
}

/** Error text without stack or request bodies. */
export function errorText(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code
    return code !== undefined && !err.message.includes(String(code))
      ? `${err.message} (${String(code)})`
      : err.message
  }
  return String(err)
}

/** Discards everything. */
export const silentLogger = new Logger('error', '', true)
