import { realpath } from 'node:fs/promises'
import type { Plugin } from '@opencode/plugin'
import type { ToolContext } from '@opencode/plugin/promise/tool'
import type { Diagnostic, DocumentSymbol, Hover, Location, LocationLink, SymbolInformation } from 'vscode-languageserver-protocol'
import { commandResource, type Options, type ServerConfig } from './config.js'
import { abortable, checkAbort, LspError, message } from './errors.js'
import { Paths, samePath, type ResolvedFile } from './paths.js'
import { LanguageServer, type Diagnostics } from './server.js'

export type Caller = Pick<ToolContext, 'sessionID' | 'agent' | 'messageID' | 'id' | 'signal'>
export type Operation = 'diagnostics' | 'definition' | 'references' | 'hover' | 'symbols'
export interface Query {
  readonly file: string
  readonly server?: string
  readonly line?: number
  readonly character?: number
  readonly includeDeclaration?: boolean
}

interface Instance {
  readonly key: string
  readonly sessionID: string
  readonly agent: string
  readonly server: LanguageServer
  readonly paths: Paths
  readonly lifetime: AbortController
  retiring?: Promise<void>
  tail: Promise<unknown>
}

type Host = Pick<Plugin.Context, 'permission' | 'session' | 'location'>

function owner(caller: Caller, server: string): string {
  return JSON.stringify([caller.sessionID, caller.agent, server])
}

function language(config: ServerConfig, file: string): string | undefined {
  const normalized = process.platform === 'win32' ? file.toLowerCase() : file
  return Object.entries(config.extensions)
    .sort(([left], [right]) => right.length - left.length)
    .find(([suffix]) => normalized.endsWith(process.platform === 'win32' ? suffix.toLowerCase() : suffix))?.[1]
}

function serialized<T>(instance: Instance, work: () => Promise<T>): Promise<T> {
  const result = instance.tail.then(work, work)
  instance.tail = result.catch(() => {})
  return result
}

export class LspManager {
  private readonly instances = new Map<string, Instance>()
  private closed = false
  private readonly lifetime = new AbortController()

  constructor(private readonly host: Host, readonly options: Options) {}

  private async location(caller: Caller): Promise<string> {
    checkAbort(caller.signal)
    if (this.closed) throw new LspError('CLOSED', 'Language-server plugin has unloaded')
    const session = await abortable(this.host.session.get({ sessionID: caller.sessionID }), caller.signal)
    const [loaded, current] = await abortable(Promise.all([realpath(this.host.location.directory), realpath(session.location.directory)]), caller.signal)
    checkAbort(caller.signal)
    if (!samePath(loaded, current)) {
      const error = new LspError('LOCATION', 'This language-server instance does not belong to the current session location')
      await this.retireAll([...this.instances.values()].filter((instance) => instance.sessionID === caller.sessionID), error)
      throw error
    }
    return loaded
  }

  private async permit(caller: Caller, action: 'read' | 'shell', resources: readonly string[], metadata?: Record<string, unknown>): Promise<void> {
    checkAbort(caller.signal)
    await abortable(this.host.permission.assert({
      sessionID: caller.sessionID, agent: caller.agent,
      source: { type: 'tool', messageID: caller.messageID, id: caller.id },
      action, resources: [...resources], save: [...resources],
      ...(metadata ? { metadata } : {}),
    }), caller.signal)
    checkAbort(caller.signal)
    await this.location(caller)
  }

  private async authorize(instance: Instance, file: string, caller: Caller, expectedFile?: string): Promise<{ resolved: ResolvedFile; text: string }> {
    const resolved = await instance.paths.resolve(file)
    if (expectedFile && !samePath(resolved.file, expectedFile)) throw new LspError('PATH_CHANGED', 'The opened document alias changed destination; query it again explicitly')
    await this.permit(caller, 'read', resolved.resources)
    await this.permit(caller, 'shell', [commandResource(instance.server.config.command)], {
      argv: [...instance.server.config.command], cwd: instance.paths.root,
      purpose: 'Run/use the explicitly configured language server with host-user process authority',
    })
    const text = await instance.paths.read(resolved, caller.signal)
    await this.location(caller)
    return { resolved, text }
  }

  private async select(query: Query, caller: Caller): Promise<{ config: ServerConfig; paths: Paths }> {
    const location = await this.location(caller)
    const candidates = this.options.servers.filter((config) => (!query.server || query.server === config.id) && language(config, query.file))
    if (candidates.length === 0) throw new LspError('SERVER', 'No configured server matches that file and server id')
    const matches: { config: ServerConfig; paths: Paths }[] = []
    let failure: unknown
    for (const config of candidates) {
      try {
        const paths = await Paths.create(location, config.root)
        await paths.resolve(query.file)
        matches.push({ config, paths })
      } catch (error) { failure = error }
    }
    if (matches.length === 0) throw failure
    if (matches.length > 1) throw new LspError('AMBIGUOUS', 'Several configured servers match; specify server explicitly')
    return matches[0]!
  }

  private async instance(query: Query, caller: Caller): Promise<Instance> {
    const { config, paths } = await this.select(query, caller)
    const key = owner(caller, config.id)
    for (;;) {
      checkAbort(caller.signal)
      if (this.closed) throw new LspError('CLOSED', 'Language-server plugin has unloaded')
      const existing = this.instances.get(key)
      if (existing) {
        const changedRoot = !samePath(existing.paths.root, paths.root)
        if (!changedRoot && !existing.lifetime.signal.aborted && !['failed', 'stopped', 'stopping'].includes(existing.server.state)) return existing
        await this.retire(existing, false)
        if (changedRoot) throw new LspError('PATH_CHANGED', 'Configured root changed; retry the tool to create a new instance')
        // Another waiter may have replaced the retired instance while cleanup was awaited.
        continue
      }
      if (this.instances.size >= 32) throw new LspError('SERVER_LIMIT', 'This plugin has 32 server instances; shut down unused instances first')
      const created: Instance = { key, sessionID: caller.sessionID, agent: caller.agent, paths, lifetime: new AbortController(), server: new LanguageServer(config, paths.root, this.options), tail: Promise.resolve() }
      this.instances.set(key, created)
      return created
    }
  }

  private async retire(instance: Instance, graceful = true, reason = new LspError('RETIRED', 'Language-server instance has been retired')): Promise<void> {
    instance.lifetime.abort(reason)
    if (instance.retiring) return instance.retiring
    const retiring = instance.server.stop(graceful).then(() => {
      if (this.instances.get(instance.key) === instance) this.instances.delete(instance.key)
    }).catch((error: unknown) => {
      instance.server.lastError = `Cleanup failed: ${message(error)}`
      throw error
    })
    instance.retiring = retiring
    try { await retiring } finally {
      if (instance.retiring === retiring) delete instance.retiring
    }
  }

  private async retireAll(instances: readonly Instance[], reason?: LspError): Promise<void> {
    const results = await Promise.allSettled(instances.map((instance) => this.retire(instance, true, reason)))
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Language-server cleanup failed')
  }

  async query(operation: Operation, query: Query, caller: Caller): Promise<unknown> {
    caller = { ...caller, signal: AbortSignal.any([caller.signal, this.lifetime.signal]) }
    const instance = await this.instance(query, caller)
    caller = { ...caller, signal: AbortSignal.any([caller.signal, instance.lifetime.signal]) }
    return abortable(serialized(instance, async () => {
      checkAbort(caller.signal)
      await this.location(caller)
      let authorized: { resolved: ResolvedFile; text: string }
      try { authorized = await this.authorize(instance, query.file, caller) } catch (error) {
        await instance.server.stop(false)
        throw error
      }
      const { resolved, text } = authorized
      checkAbort(caller.signal)
      if (this.closed) throw new LspError('CLOSED', 'Language-server plugin has unloaded')
      await instance.server.start(caller.signal)
      await this.location(caller)
      const synced = await instance.server.synchronize(resolved.file, language(instance.server.config, resolved.file) ?? language(instance.server.config, query.file)!, text, caller.signal, resolved.requested)
      const common = { server: instance.server.config.id, file: instance.paths.resource(resolved.file), documentVersion: synced.version }
      if (operation === 'diagnostics') {
        const diagnostics = await instance.server.diagnostics(synced.uri, caller.signal)
        await this.location(caller)
        return { ...common, diagnostics: sanitizeDiagnostics(diagnostics) }
      }
      if (operation === 'symbols') {
        if (!instance.server.capabilities.documentSymbolProvider) throw new LspError('UNSUPPORTED', 'Server does not support document symbols')
        const symbols = await instance.server.request<DocumentSymbol[] | SymbolInformation[] | null>('textDocument/documentSymbol', { textDocument: { uri: synced.uri } }, caller.signal)
        await this.location(caller)
        const result: unknown[] = []
        let omitted = 0
        for (const symbol of (symbols ?? []).slice(0, 200)) {
          if ('location' in symbol) {
            const target = await this.target(instance, symbol.location.uri, caller)
            if (target) result.push({ name: symbol.name, kind: symbol.kind, containerName: symbol.containerName, location: { file: target, range: symbol.location.range } })
            else omitted++
          } else result.push(sanitizeSymbol(symbol))
        }
        return { ...common, symbols: result, omitted, truncated: (symbols?.length ?? 0) > 200 }
      }
      const line = query.line
      const character = query.character
      if (!Number.isSafeInteger(line) || !Number.isSafeInteger(character) || line! < 0 || character! < 0) throw new LspError('POSITION', 'A zero-based UTF-16 line and character are required')
      instance.server.validatePosition(synced.uri, line!, character!)
      const params = { textDocument: { uri: synced.uri }, position: { line, character } }
      if (operation === 'hover') {
        if (!instance.server.capabilities.hoverProvider) throw new LspError('UNSUPPORTED', 'Server does not support hover')
        const hover = await instance.server.request<Hover | null>('textDocument/hover', params, caller.signal)
        await this.location(caller)
        return { ...common, hover: hover ? { contents: hover.contents, range: hover.range } : null }
      }
      if (!(operation === 'definition' ? instance.server.capabilities.definitionProvider : instance.server.capabilities.referencesProvider)) throw new LspError('UNSUPPORTED', `Server does not support ${operation}`)
      const locations = await instance.server.request<Location | (Location | LocationLink)[] | null>(`textDocument/${operation}`, {
        ...params, ...(operation === 'references' ? { context: { includeDeclaration: query.includeDeclaration ?? true } } : {}),
      }, caller.signal)
      await this.location(caller)
      const entries = locations === null ? [] : Array.isArray(locations) ? locations : [locations]
      const result: unknown[] = []
      let omitted = 0
      for (const item of entries.slice(0, 200)) {
        const uri = 'targetUri' in item ? item.targetUri : item.uri
        const file = await this.target(instance, uri, caller)
        if (file) result.push({ file, range: 'targetUri' in item ? item.targetSelectionRange : item.range })
        else omitted++
      }
      return { ...common, locations: result, omitted, truncated: entries.length > 200 }
    }), caller.signal)
  }

  private async target(instance: Instance, uri: string, caller: Caller): Promise<string | undefined> {
    let resolved: ResolvedFile
    try { resolved = await instance.paths.resolveUri(uri) } catch (error) {
      if (error instanceof LspError && error.code === 'OUTSIDE_ROOT' || (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    await this.permit(caller, 'read', resolved.resources)
    const checked = await instance.paths.resolve(resolved.requested)
    if (!samePath(checked.file, resolved.file)) throw new LspError('PATH_CHANGED', 'Navigation destination changed during permission checking')
    return instance.paths.resource(resolved.file)
  }

  async refresh(caller: Caller): Promise<unknown[]> {
    caller = { ...caller, signal: AbortSignal.any([caller.signal, this.lifetime.signal]) }
    checkAbort(caller.signal)
    const owned = [...this.instances.values()].filter((instance) => instance.sessionID === caller.sessionID && instance.agent === caller.agent && instance.server.state === 'running')
    if (!owned.length) return []
    await this.location(caller)
    const results: unknown[] = []
    for (const instance of owned) {
      const scoped = { ...caller, signal: AbortSignal.any([caller.signal, instance.lifetime.signal]) }
      await abortable(serialized(instance, async () => {
        checkAbort(scoped.signal)
        await this.location(scoped)
        const changed: string[] = []
        for (const document of [...instance.server.documents.values()]) {
          let authorized: { resolved: ResolvedFile; text: string }
          try { authorized = await this.authorize(instance, document.requested, scoped, document.file) } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              await this.location(scoped)
              await instance.server.closeDocument(document.file, scoped.signal)
              continue
            }
            // Do not keep serving previously read content after authority is revoked.
            await instance.server.stop(false)
            throw error
          }
          const synced = await instance.server.synchronize(authorized.resolved.file, document.language, authorized.text, scoped.signal, document.requested)
          if (synced.changed) changed.push(synced.uri)
        }
        for (const uri of changed.slice(0, 8)) {
          const document = instance.server.documents.get(uri)!
          const diagnostics = await instance.server.diagnostics(uri, scoped.signal)
          await this.location(scoped)
          results.push({ server: instance.server.config.id, file: instance.paths.resource(document.file), documentVersion: document.version, diagnostics: sanitizeDiagnostics(diagnostics) })
        }
        if (changed.length > 8) results.push({ server: instance.server.config.id, pendingFiles: changed.length - 8 })
      }), scoped.signal)
    }
    return results
  }

  async status(caller: Caller): Promise<unknown> {
    await this.location(caller)
    return this.options.servers.map((config) => {
      const instance = this.instances.get(owner(caller, config.id))
      const server = instance?.server
      return {
        id: config.id, root: config.root, extensions: config.extensions,
        state: server?.state ?? 'idle', pid: server?.pid ?? null,
        openDocuments: server?.documents.size ?? 0,
        error: server?.lastError ?? null,
        capabilities: {
          definition: !!server?.capabilities.definitionProvider, references: !!server?.capabilities.referencesProvider,
          hover: !!server?.capabilities.hoverProvider, symbols: !!server?.capabilities.documentSymbolProvider,
          pullDiagnostics: !!server?.capabilities.diagnosticProvider,
        },
      }
    })
  }

  async shutdown(caller: Caller, serverID?: string): Promise<void> {
    await this.location(caller)
    const owned = [...this.instances.values()].filter((instance) => instance.sessionID === caller.sessionID && instance.agent === caller.agent && (!serverID || instance.server.config.id === serverID))
    await this.retireAll(owned)
  }

  async removeSession(sessionID: string): Promise<void> {
    const owned = [...this.instances.values()].filter((instance) => instance.sessionID === sessionID)
    await this.retireAll(owned)
  }

  async dispose(): Promise<void> {
    this.closed = true
    this.lifetime.abort(new LspError('CLOSED', 'Language-server plugin has unloaded'))
    await this.retireAll([...this.instances.values()])
  }
}

function sanitizeDiagnostics(diagnostics: Diagnostics): unknown {
  return {
    ...diagnostics,
    // Related locations/data can contain unchecked source from a different file.
    items: diagnostics.items.map((item: Diagnostic) => ({
      range: item.range, message: item.message,
      ...(item.severity === undefined ? {} : { severity: item.severity }),
      ...(item.code === undefined ? {} : { code: item.code }),
      ...(item.source === undefined ? {} : { source: item.source }),
      ...(item.tags === undefined ? {} : { tags: item.tags }),
    })),
  }
}

function sanitizeSymbol(symbol: DocumentSymbol, depth = 0): unknown {
  return {
    name: symbol.name, detail: symbol.detail, kind: symbol.kind, range: symbol.range, selectionRange: symbol.selectionRange,
    ...(depth < 8 && symbol.children ? { children: symbol.children.slice(0, 200).map((child) => sanitizeSymbol(child, depth + 1)) } : {}),
  }
}
