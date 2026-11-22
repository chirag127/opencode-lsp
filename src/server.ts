import { EventEmitter } from 'node:events'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  CancellationTokenSource, ErrorCodes, ResponseError,
} from 'vscode-jsonrpc/node'
import {
  createProtocolConnection, TextDocumentSyncKind,
  type Diagnostic, type InitializeParams, type InitializeResult,
  type ProtocolConnection, type PublishDiagnosticsParams, type ServerCapabilities,
  type TextDocumentContentChangeEvent, type TextDocumentSyncOptions,
} from 'vscode-languageserver-protocol/node'
import type { Options, ServerConfig } from './config.js'
import { object } from './config.js'
import { bounded, checkAbort, LspError, message, ProcessStartupError } from './errors.js'
import { spawnServer, type ServerProcess } from './process.js'

export interface Diagnostics {
  readonly state: 'reported' | 'pending'
  readonly freshness: 'current' | 'unknown'
  readonly documentVersion: number | null
  readonly version: number | null
  readonly items: readonly Diagnostic[]
}

interface Document {
  readonly file: string
  readonly requested: string
  readonly uri: string
  readonly language: string
  text: string
  version: number
  diagnostics?: Diagnostics
}

export type ServerState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed'

function endPosition(text: string): { line: number; character: number } {
  const lines = text.split(/\r\n|\r|\n/u)
  return { line: lines.length - 1, character: lines.at(-1)!.length }
}

export class LanguageServer {
  state: ServerState = 'idle'
  lastError: string | undefined
  capabilities: ServerCapabilities = {}
  readonly documents = new Map<string, Document>()
  private child: ServerProcess | undefined
  private spawning: Promise<ServerProcess> | undefined
  private failedStartup: { terminate(): Promise<void> } | undefined
  private connection: ProtocolConnection | undefined
  private exited: Promise<void> = Promise.resolve()
  private starting: Promise<void> | undefined
  private stopping: Promise<void> | undefined
  private failure: Error | undefined
  private readonly lifetime = new AbortController()
  private readonly events = new EventEmitter()

  constructor(readonly config: ServerConfig, readonly root: string, readonly options: Options) {}

  get pid(): number | undefined { return this.child?.pid }

  private syncOptions(): TextDocumentSyncOptions {
    const sync = this.capabilities.textDocumentSync
    return typeof sync === 'number' ? { openClose: sync !== TextDocumentSyncKind.None, change: sync } : sync ?? {}
  }

  async start(signal: AbortSignal): Promise<void> {
    checkAbort(signal)
    if (this.state === 'running') return
    if (this.state === 'starting' && this.starting) return this.starting
    if (this.state !== 'idle') throw this.failure ?? new LspError('SERVER_STATE', `Server is ${this.state}; start a new instance`)
    this.state = 'starting'
    this.starting = this.initialize(AbortSignal.any([signal, this.lifetime.signal]))
    return this.starting
  }

  private async initialize(signal: AbortSignal): Promise<void> {
    try {
      this.spawning = spawnServer(this.config.command, this.root, signal)
      try { this.child = await this.spawning } catch (error) {
        if (error instanceof ProcessStartupError) this.failedStartup = error.cleanupOwner
        checkAbort(signal)
        throw new LspError('SPAWN', `Cannot start configured server ${this.config.id}: ${message(error)}`)
      }
      this.exited = this.child.exited.then(({ code, signal: signalName }) => {
        if (this.state !== 'stopping' && this.state !== 'stopped') this.fail(new LspError('SERVER_EXIT', `Language server ${this.config.id} exited (${signalName ?? code})`))
      }).catch((error: unknown) => { this.fail(new LspError('PROCESS', `Language-server exit monitoring failed: ${message(error)}`)) })
      checkAbort(signal)
      // Drain stderr without returning server logs, which can include paths or source from unrelated files.
      this.child.stderr.resume()
      const connection = createProtocolConnection(this.child.stdout, this.child.stdin)
      this.connection = connection
      connection.onClose(() => {
        if (this.state === 'running' || this.state === 'starting') this.fail(new LspError('SERVER_EXIT', `Language server ${this.config.id} closed its transport`))
      })
      connection.onError(([error]) => {
        if (this.state === 'running' || this.state === 'starting') this.fail(new LspError('PROTOCOL', `Language-server transport failed: ${message(error)}`))
      })
      connection.onNotification('textDocument/publishDiagnostics', (params: PublishDiagnosticsParams) => {
        if (!object(params) || typeof params.uri !== 'string' || !Array.isArray(params.diagnostics)) return
        let document = this.documents.get(params.uri)
        if (!document) {
          try {
            const uri = new URL(params.uri)
            if (uri.protocol !== 'file:' || uri.search || uri.hash) return
            const file = fileURLToPath(uri)
            // TypeScript on Windows publishes an encoded, lower-case drive letter for the same file.
            document = [...this.documents.values()].find((opened) => path.relative(opened.file, file) === '')
          } catch { return }
        }
        if (!document || (params.version !== undefined && params.version !== document.version)) return
        document.diagnostics = {
          state: 'reported', freshness: params.version === undefined ? 'unknown' : 'current',
          documentVersion: params.version ?? null,
          version: params.version ?? null, items: params.diagnostics.slice(0, 200),
        }
        this.events.emit('diagnostics', document.uri)
      })
      connection.onRequest('workspace/configuration', (params: { items?: { section?: string }[] }) => {
        if (!Array.isArray(params?.items)) return []
        return params.items.map((item) => {
          let value: unknown = this.config.settings
          for (const part of (item.section ?? '').split('.').filter(Boolean)) {
            value = object(value) && Object.hasOwn(value, part) ? value[part] : null
          }
          return value ?? null
        })
      })
      const folders = [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }]
      connection.onRequest('workspace/workspaceFolders', () => folders)
      connection.onRequest('window/workDoneProgress/create', () => null)
      connection.onRequest('window/showMessageRequest', () => null)
      connection.onRequest('window/showDocument', () => ({ success: false }))
      connection.onRequest('workspace/applyEdit', () => ({ applied: false, failureReason: 'Use the normal permission-checked edit tools; the LSP client is read-only' }))
      connection.onRequest('client/registerCapability', () => new ResponseError(ErrorCodes.InvalidRequest, 'Dynamic registration is not supported'))
      connection.onRequest('client/unregisterCapability', () => new ResponseError(ErrorCodes.InvalidRequest, 'Dynamic registration is not supported'))
      connection.onRequest('workspace/diagnostic/refresh', () => {
        for (const document of this.documents.values()) delete document.diagnostics
        return null
      })
      connection.listen()
      const params: InitializeParams = {
        processId: process.pid,
        clientInfo: { name: 'opencode-lsp', version: '0.1.0' },
        rootUri: pathToFileURL(this.root).href,
        workspaceFolders: folders,
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          workspace: { configuration: true, workspaceFolders: true, applyEdit: false },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: true },
            publishDiagnostics: { versionSupport: true, relatedInformation: false },
            definition: { dynamicRegistration: false, linkSupport: true },
            references: { dynamicRegistration: false },
            hover: { dynamicRegistration: false, contentFormat: ['plaintext', 'markdown'] },
            documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
          },
        },
        ...(this.config.initializationOptions === undefined ? {} : { initializationOptions: this.config.initializationOptions }),
      }
      const result = await this.request<InitializeResult>('initialize', params, signal)
      if (!object(result) || !object(result.capabilities)) throw new LspError('PROTOCOL', 'Language server returned invalid initialize capabilities')
      if (result.capabilities.positionEncoding && result.capabilities.positionEncoding !== 'utf-16') throw new LspError('POSITION_ENCODING', 'This client requires UTF-16 LSP positions')
      this.capabilities = result.capabilities
      await this.notify('initialized', {}, signal)
      await this.notify('workspace/didChangeConfiguration', { settings: this.config.settings }, signal)
      checkAbort(signal)
      if (this.failure) throw this.failure
      this.state = 'running'
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(message(error)))
      await this.stop(false)
      throw error
    }
  }

  private fail(error: Error): void {
    if (this.failure || this.state === 'stopping' || this.state === 'stopped') return
    this.failure = error
    this.lastError = error.message
    this.state = 'failed'
    this.connection?.dispose()
    this.events.emit('failure', error)
    // Transport failures can occur between tool calls. Cleanup must not depend on another invocation.
    void this.stop(false).catch((cleanup) => { this.lastError = `${error.message}; cleanup failed: ${message(cleanup)}` })
  }

  async request<T>(method: string, params: unknown, signal: AbortSignal): Promise<T> {
    checkAbort(signal)
    if (this.failure) throw this.failure
    const connection = this.connection
    if (!connection || (this.state !== 'running' && this.state !== 'starting')) throw new LspError('SERVER_STATE', 'Language server is not running')
    const cancellation = new CancellationTokenSource()
    const response = connection.sendRequest<T>(method, params, cancellation.token)
    try {
      return await bounded(response, this.options.requestTimeoutMs, method, signal, () => cancellation.cancel())
    } catch (error) {
      if (signal.aborted || error instanceof LspError && error.code === 'TIMEOUT') {
        // Cancellation writes are asynchronous; leave the transport alive for a response or bounded grace.
        try {
          await bounded(response.then(() => {}, () => {}), Math.min(this.options.shutdownTimeoutMs, 1_000), 'request cancellation')
        } catch { /* An uncooperative request is terminated with its owned process below. */ }
        this.fail(error instanceof Error ? error : new Error(message(error)))
        await this.stop(false)
      }
      throw this.failure ?? error
    } finally {
      cancellation.dispose()
    }
  }

  private async notify(method: string, params: unknown, signal: AbortSignal): Promise<void> {
    checkAbort(signal)
    if (this.failure) throw this.failure
    const connection = this.connection
    if (!connection) throw new LspError('SERVER_STATE', 'Language server has no transport')
    try {
      await bounded(connection.sendNotification(method, params), this.options.requestTimeoutMs, method, signal)
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(message(error)))
      await this.stop(false)
      throw error
    }
  }

  async synchronize(file: string, language: string, text: string, signal: AbortSignal, requested = file): Promise<{ uri: string; changed: boolean; version: number }> {
    const uri = pathToFileURL(file).href
    let document = this.documents.get(uri)
    const sync = this.syncOptions()
    if (!sync.openClose) throw new LspError('UNSUPPORTED_SYNC', 'Server does not support document open/close synchronization')
    if (!document) {
      if (this.documents.size >= 64) throw new LspError('DOCUMENT_LIMIT', 'This server has 64 open documents; shut it down to release them')
      document = { file, requested, uri, language, text, version: 1 }
      this.documents.set(uri, document)
      await this.notify('textDocument/didOpen', { textDocument: { uri, languageId: language, version: 1, text } }, signal)
      return { uri, changed: true, version: 1 }
    }
    if (document.text === text) return { uri, changed: false, version: document.version }
    if (sync.change !== TextDocumentSyncKind.Full && sync.change !== TextDocumentSyncKind.Incremental) throw new LspError('UNSUPPORTED_SYNC', 'Server does not support document changes')
    const contentChanges: TextDocumentContentChangeEvent[] = sync.change === TextDocumentSyncKind.Full
      ? [{ text }]
      : [{ range: { start: { line: 0, character: 0 }, end: endPosition(document.text) }, text }]
    document.text = text
    document.version++
    delete document.diagnostics
    await this.notify('textDocument/didChange', { textDocument: { uri, version: document.version }, contentChanges }, signal)
    if (sync.save) await this.notify('textDocument/didSave', {
      textDocument: { uri }, ...(typeof sync.save === 'object' && sync.save.includeText ? { text } : {}),
    }, signal)
    return { uri, changed: true, version: document.version }
  }

  validatePosition(uri: string, line: number, character: number): void {
    const document = this.documents.get(uri)
    const lines = document?.text.split(/\r\n|\r|\n/u)
    if (!lines || line >= lines.length || character > lines[line]!.length) throw new LspError('POSITION', 'Position is outside the current document (zero-based UTF-16 line/character)')
  }

  async diagnostics(uri: string, signal: AbortSignal): Promise<Diagnostics> {
    checkAbort(signal)
    const document = this.documents.get(uri)
    if (!document) throw new LspError('DOCUMENT', 'Document is not open')
    if (this.capabilities.diagnosticProvider) {
      const identifier = this.capabilities.diagnosticProvider.identifier
      const report = await this.request<{ kind: string; items?: Diagnostic[] }>('textDocument/diagnostic', {
        textDocument: { uri }, ...(identifier === undefined ? {} : { identifier }),
      }, signal)
      if (report.kind !== 'full' || !Array.isArray(report.items)) throw new LspError('PROTOCOL', 'Expected a full document diagnostic report')
      return { state: 'reported', freshness: 'current', documentVersion: document.version, version: document.version, items: report.items.slice(0, 200) }
    }
    if (document.diagnostics) return document.diagnostics
    let onDiagnostics: (published: string) => void = () => {}
    let onFailure: (error: Error) => void = () => {}
    const published = new Promise<Diagnostics>((resolve, reject) => {
      onDiagnostics = (publishedUri) => { if (publishedUri === uri && document.diagnostics) resolve(document.diagnostics) }
      onFailure = reject
      this.events.on('diagnostics', onDiagnostics)
      this.events.on('failure', onFailure)
      if (this.failure) reject(this.failure)
      else if (document.diagnostics) resolve(document.diagnostics)
    })
    try {
      return await bounded(published, this.options.diagnosticsTimeoutMs, 'diagnostics publication', signal)
    } catch (error) {
      if (error instanceof LspError && error.code === 'TIMEOUT') return { state: 'pending', freshness: 'unknown', documentVersion: null, version: null, items: [] }
      throw error
    } finally {
      this.events.off('diagnostics', onDiagnostics)
      this.events.off('failure', onFailure)
    }
  }

  async closeDocument(file: string, signal: AbortSignal): Promise<void> {
    const uri = pathToFileURL(file).href
    if (!this.documents.delete(uri)) return
    await this.notify('textDocument/didClose', { textDocument: { uri } }, signal)
  }

  async stop(graceful = true): Promise<void> {
    if (this.stopping) return this.stopping
    if (this.state === 'idle' || this.state === 'stopped') { this.state = 'stopped'; return }
    const stopping = this.shutdown(graceful)
    this.stopping = stopping
    try { await stopping } catch (error) {
      if (this.stopping === stopping) this.stopping = undefined
      throw error
    }
  }

  private async shutdown(graceful: boolean): Promise<void> {
    const initialized = this.state === 'running'
    this.state = 'stopping'
    this.lifetime.abort(new LspError('SERVER_STOPPED', 'Language server stopped'))
    const connection = this.connection
    let released = false
    try {
      if (graceful && initialized && connection && !this.failure) {
        try {
          for (const document of this.documents.values()) await bounded(connection.sendNotification('textDocument/didClose', { textDocument: { uri: document.uri } }), this.options.shutdownTimeoutMs, 'didClose')
          await bounded(connection.sendRequest('shutdown'), this.options.shutdownTimeoutMs, 'shutdown')
          await bounded(connection.sendNotification('exit'), this.options.shutdownTimeoutMs, 'exit')
          await bounded(this.exited, this.options.shutdownTimeoutMs, 'server exit')
        } catch { /* An uncooperative server is terminated below. */ }
      }
      const child = this.child ?? this.failedStartup ?? await this.spawning?.catch((error: unknown) => error instanceof ProcessStartupError ? error.cleanupOwner : undefined)
      if (child) {
        await child.terminate()
        await bounded(this.exited, 5_000, 'process cleanup')
      }
      this.failedStartup = undefined
      released = true
    } catch (error) {
      this.failure ??= new LspError('CLEANUP', `Language-server cleanup failed: ${message(error)}`)
      this.lastError = this.failure.message
      throw error
    } finally {
      connection?.dispose()
      this.child?.stdin.destroy()
      this.child?.stdout.destroy()
      this.child?.stderr.destroy()
      this.documents.clear()
      this.state = this.failure || !released ? 'failed' : 'stopped'
      this.events.emit('failure', this.failure ?? new LspError('SERVER_STOPPED', 'Language server stopped'))
    }
  }
}
