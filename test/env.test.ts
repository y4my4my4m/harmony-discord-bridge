import { describe, expect, it } from 'vitest'
import { planLaunch } from '../src/env.js'

describe('planLaunch', () => {
  it('explains what to set when nothing is configured', () => {
    const plan = planLaunch({}, null)
    expect(plan.kind).toBe('error')
    if (plan.kind !== 'error') return
    expect(plan.message).toContain('HARMONY_URL')
    expect(plan.message).toContain('HARMONY_SETUP_CODE')
    expect(plan.message).toContain('DISCORD_TOKEN')
  })

  it('runs legacy v1 when only bridge-config.yml exists, without a health port by default', () => {
    expect(planLaunch({}, '/app/config/bridge-config.yml')).toEqual({
      kind: 'v1',
      configPath: '/app/config/bridge-config.yml',
      healthPort: null,
    })
    expect(planLaunch({ HEALTH_PORT: '9000' }, '/c.yml')).toMatchObject({ kind: 'v1', healthPort: 9000 })
  })

  it('runs self-hosted v2 from env, preferring it over YAML', () => {
    const plan = planLaunch({
      HARMONY_URL: 'har.mony.lol',
      HARMONY_SETUP_CODE: ' HB-AAAA-BBBB-CCCC ',
      DISCORD_TOKEN: 'tok',
    }, '/app/config/bridge-config.yml')
    expect(plan).toEqual({
      kind: 'self',
      harmonyUrl: 'https://har.mony.lol',
      setupCode: 'HB-AAAA-BBBB-CCCC',
      discordToken: 'tok',
      healthPort: 8080,
      ignoredLegacyConfig: '/app/config/bridge-config.yml',
    })
  })

  it('requires DISCORD_TOKEN in self mode', () => {
    const plan = planLaunch({ HARMONY_URL: 'https://h.example' }, null)
    expect(plan.kind).toBe('error')
    if (plan.kind === 'error') expect(plan.message).toContain('DISCORD_TOKEN')
  })

  it('runs host mode with HARMONY_URL and BRIDGE_HOST_SECRET', () => {
    expect(planLaunch({ BRIDGE_MODE: 'host', HARMONY_URL: 'http://bot-gateway:3002', BRIDGE_HOST_SECRET: 's', HARMONY_PUBLIC_URL: 'https://h.example', HEALTH_PORT: 'off' }, null))
      .toEqual({ kind: 'host', harmonyUrl: 'http://bot-gateway:3002', hostSecret: 's', publicUrl: 'https://h.example', healthPort: null })
    const missing = planLaunch({ BRIDGE_MODE: 'host', HARMONY_URL: 'https://h.example' }, null)
    expect(missing.kind).toBe('error')
    if (missing.kind === 'error') expect(missing.message).toContain('BRIDGE_HOST_SECRET')
  })

  it('rejects bad values with a specific message', () => {
    expect(planLaunch({ BRIDGE_MODE: 'cluster' }, null)).toMatchObject({ kind: 'error' })
    expect(planLaunch({ HARMONY_URL: 'ftp://x', DISCORD_TOKEN: 't' }, null)).toMatchObject({ kind: 'error' })
    expect(planLaunch({ HARMONY_URL: 'https://x', DISCORD_TOKEN: 't', HEALTH_PORT: 'abc' }, null)).toMatchObject({ kind: 'error' })
  })
})
