import { existsSync, readFileSync, statSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import { fileURLToPath } from 'url'

/** Package root: the directory holding package.json (parent of src/ and dist/). */
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** DATA_DIR, else /data when present (container volume), else <package>/data. */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DATA_DIR?.trim()
  if (raw) return isAbsolute(raw) ? raw : resolve(raw)
  if (isDirectory('/data')) return '/data'
  return join(PACKAGE_ROOT, 'data')
}

/**
 * Legacy v1 config: ./config/bridge-config.yml relative to the working
 * directory (v1 behavior), then <package>/config/bridge-config.yml.
 */
export function findLegacyConfigPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.BRIDGE_CONFIG?.trim()
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(explicit)
  const candidates = [
    resolve('config', 'bridge-config.yml'),
    join(PACKAGE_ROOT, 'config', 'bridge-config.yml'),
  ]
  return candidates.find(p => existsSync(p)) ?? null
}
