/**
 * Global configuration for happy CLI
 * 
 * Centralizes all configuration including environment variables and paths
 * Environment files should be loaded using Node's --env-file flag
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json'
import { ensurePrivateDirectorySync, hardenPrivateDirectoryFilesSync, hardenPrivateFileSync } from '@/utils/secureFiles'

const DEFAULT_RELAY_URL = 'https://veryhappy.dev'

/**
 * Client endpoints are origins, not arbitrary URL prefixes. Normalize the
 * harmless trailing slash while rejecting values that would make string-built
 * API, Socket.IO, or approval URLs target a different route (or protocol).
 */
export function normalizeHttpEndpoint(value: string, source: string): string {
  const trimmed = value.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`${source} must be an absolute http(s) origin`)
  }

  const onlyOriginPath = /^\/+$/u.test(parsed.pathname)
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username.length > 0
    || parsed.password.length > 0
    || !onlyOriginPath
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new Error(`${source} must be an http(s) origin without credentials, path, query, or fragment`)
  }

  return parsed.origin
}

export function resolveHttpEndpoint(
  environmentValue: string | undefined,
  settingsValue: string | undefined,
  environmentName: 'HAPPY_SERVER_URL' | 'HAPPY_WEBAPP_URL',
  settingsName: 'serverUrl' | 'webappUrl',
): string {
  if (environmentValue !== undefined) {
    return normalizeHttpEndpoint(environmentValue, environmentName)
  }
  if (settingsValue !== undefined) {
    return normalizeHttpEndpoint(settingsValue, `settings.${settingsName}`)
  }
  return DEFAULT_RELAY_URL
}

class Configuration {
  public readonly serverUrl: string
  public readonly webappUrl: string
  public readonly isDaemonProcess: boolean

  // Directories and paths (from persistence)
  public readonly happyHomeDir: string
  public readonly logsDir: string
  public readonly settingsFile: string
  public readonly privateKeyFile: string
  public readonly daemonStateFile: string
  public readonly daemonLockFile: string
  public readonly sessionsFile: string
  public readonly currentCliVersion: string

  public readonly isExperimentalEnabled: boolean
  public readonly disableCaffeinate: boolean

  constructor() {
    // Check if we're running as daemon based on process args
    const args = process.argv.slice(2)
    this.isDaemonProcess = args.length >= 2 && args[0] === 'daemon' && (args[1] === 'start-sync')

    // Directory configuration - Priority: HAPPY_HOME_DIR env > default home dir
    if (process.env.HAPPY_HOME_DIR) {
      // Expand ~ to home directory if present
      const expandedPath = process.env.HAPPY_HOME_DIR.replace(/^~/, homedir())
      this.happyHomeDir = expandedPath
    } else {
      this.happyHomeDir = join(homedir(), '.happy')
    }

    this.logsDir = join(this.happyHomeDir, 'logs')
    this.settingsFile = join(this.happyHomeDir, 'settings.json')
    this.privateKeyFile = join(this.happyHomeDir, 'access.key')
    this.daemonStateFile = join(this.happyHomeDir, 'daemon.state.json')
    this.daemonLockFile = join(this.happyHomeDir, 'daemon.state.json.lock')
    this.sessionsFile = join(this.happyHomeDir, 'sessions.json')

    // URL precedence (both): HAPPY_*_URL env > settings.<key> > default.
    // Settings are read sync here (avoid circular import with persistence.ts).
    // webappUrl must follow the same chain as serverUrl, otherwise `very-happy server`
    // self-host points the API at localhost but auth still opens the prod webapp.
    try {
      this.serverUrl = resolveHttpEndpoint(
        process.env.HAPPY_SERVER_URL,
        readSettingsStringSync(this.settingsFile, 'serverUrl'),
        'HAPPY_SERVER_URL',
        'serverUrl',
      )
      this.webappUrl = resolveHttpEndpoint(
        process.env.HAPPY_WEBAPP_URL,
        readSettingsStringSync(this.settingsFile, 'webappUrl'),
        'HAPPY_WEBAPP_URL',
        'webappUrl',
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid client endpoint'
      process.stderr.write(`[very-happy] Configuration error: ${message}\n`)
      process.exit(1)
    }

    this.isExperimentalEnabled = ['true', '1', 'yes'].includes(process.env.HAPPY_EXPERIMENTAL?.toLowerCase() || '');
    this.disableCaffeinate = ['true', '1', 'yes'].includes(process.env.HAPPY_DISABLE_CAFFEINATE?.toLowerCase() || '');

    this.currentCliVersion = packageJson.version

    // Visual indicator on CLI startup (only if not daemon process to avoid log clutter)
    const variant = process.env.HAPPY_VARIANT || 'stable'
    if (!this.isDaemonProcess && variant === 'dev') {
      console.log('\x1b[33m🔧 DEV MODE\x1b[0m - Data: ' + this.happyHomeDir)
    }

    // Harden existing homes too; create mode alone would preserve historical 0755.
    ensurePrivateDirectorySync(this.happyHomeDir)
    ensurePrivateDirectorySync(this.logsDir)
    for (const privateFile of [
      this.settingsFile,
      this.privateKeyFile,
      this.daemonStateFile,
      this.daemonLockFile,
      this.sessionsFile,
    ]) {
      if (existsSync(privateFile)) hardenPrivateFileSync(privateFile)
    }
    hardenPrivateDirectoryFilesSync(this.logsDir)
  }
}

function readSettingsStringSync(settingsFile: string, key: 'serverUrl' | 'webappUrl'): string | undefined {
  try {
    if (!existsSync(settingsFile)) return undefined
    const raw = JSON.parse(readFileSync(settingsFile, 'utf8'))
    const value = raw?.[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

export const configuration: Configuration = new Configuration()
