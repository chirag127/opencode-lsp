export interface ServerConfig {
  readonly id: string
  readonly command: readonly [string, ...string[]]
  readonly root: string
  readonly extensions: Readonly<Record<string, string>>
  readonly initializationOptions?: unknown
  readonly settings: Readonly<Record<string, unknown>>
}

export interface Options {
  readonly servers: readonly ServerConfig[]
  readonly requestTimeoutMs: number
  readonly shutdownTimeoutMs: number
  readonly diagnosticsTimeoutMs: number
}

function invalid(reason: string): never {
  throw new Error(`Invalid LSP configuration: ${reason}`)
}

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`unknown option ${key}`)
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\u0000\r\n]/u.test(value)) invalid(`${label} must be a nonempty single-line string`)
  return value
}

function json(value: unknown, depth = 0): unknown {
  if (depth > 32) invalid('JSON options are too deeply nested')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((item) => json(item, depth + 1))
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item, depth + 1)]))
  return invalid('initializationOptions and settings must contain only JSON values')
}

function timeout(input: Record<string, unknown>, name: string, fallback: number): number {
  const value = input[name] === undefined ? fallback : input[name]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 120_000) invalid(`${name} must be an integer from 1 to 120000`)
  return value
}

export function parseOptions(input: unknown): Options {
  if (!object(input)) invalid('options must be an object')
  keys(input, ['servers', 'requestTimeoutMs', 'shutdownTimeoutMs', 'diagnosticsTimeoutMs'])
  const configured = input.servers === undefined ? [] : input.servers
  if (!Array.isArray(configured) || configured.length > 32) invalid('servers must be an array of at most 32 servers')
  const ids = new Set<string>()
  const servers = configured.map((item): ServerConfig => {
    if (!object(item)) invalid('each server must be an object')
    keys(item, ['id', 'command', 'root', 'extensions', 'initializationOptions', 'settings'])
    const id = text(item.id, 'server id')
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(id) || ids.has(id)) invalid('server ids must be unique alphanumeric names')
    ids.add(id)
    if (!Array.isArray(item.command) || item.command.length === 0 || item.command.length > 128) invalid(`${id}.command must be an explicit argv array`)
    const command = item.command.map((part: unknown, index: number) => {
      if (typeof part !== 'string' || /[\u0000\r\n]/u.test(part) || (index === 0 && !part.trim())) invalid(`${id}.command contains an invalid argument`)
      return part
    }) as [string, ...string[]]
    const root = text(item.root, `${id}.root`)
    if (!object(item.extensions) || Object.keys(item.extensions).length === 0) invalid(`${id}.extensions must map file suffixes to language ids`)
    const extensions = Object.fromEntries(Object.entries(item.extensions).map(([extension, language]) => {
      if (!/^\.[a-zA-Z0-9][a-zA-Z0-9._+-]*$/u.test(extension)) invalid(`${id}: extensions must start with a dot`)
      return [extension, text(language, `${id}.extensions.${extension}`)]
    }))
    if (item.settings !== undefined && !object(item.settings)) invalid(`${id}.settings must be an object`)
    return {
      id, command, root, extensions,
      settings: json(item.settings ?? {}) as Record<string, unknown>,
      ...(item.initializationOptions === undefined ? {} : { initializationOptions: json(item.initializationOptions) }),
    }
  })
  return {
    servers,
    requestTimeoutMs: timeout(input, 'requestTimeoutMs', 15_000),
    shutdownTimeoutMs: timeout(input, 'shutdownTimeoutMs', 2_000),
    diagnosticsTimeoutMs: timeout(input, 'diagnosticsTimeoutMs', 5_000),
  }
}

export function commandResource(command: readonly string[]): string {
  return command.map((part) => /^[\w./:\\@=+,-]+$/u.test(part) ? part : JSON.stringify(part)).join(' ')
}
