import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  createProtocolConnection, ErrorCodes, ResponseError, TextDocumentSyncKind,
} from 'vscode-languageserver-protocol/node'

const [mode, log] = process.argv.slice(2)
const record = (event, data = {}) => appendFileSync(log, JSON.stringify({ event, ...data }) + '\n')
record('spawn', { pid: process.pid })
const connection = createProtocolConnection(process.stdin, process.stdout)
const documents = new Map()
let root
let worker
connection.onRequest('initialize', async (params) => {
  record('initialize', { params })
  root = params.rootUri
  if (mode === 'exit-initialize') process.exit(17)
  if (mode === 'hang-initialize') return new Promise(() => {})
  if (mode === 'invalid-initialize') return { nonsense: true }
  return {
    capabilities: {
      textDocumentSync: { openClose: true, change: mode === 'full' ? TextDocumentSyncKind.Full : TextDocumentSyncKind.Incremental, save: { includeText: true } },
      ...(mode.startsWith('numeric-') ? { textDocumentSync: Number(mode.slice('numeric-'.length)) } : {}),
      definitionProvider: true, referencesProvider: true, hoverProvider: mode !== 'no-hover', documentSymbolProvider: true,
      ...(mode === 'pull' ? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } : {}),
      ...(mode === 'named-pull' ? { diagnosticProvider: { identifier: 'fixture-named', interFileDependencies: false, workspaceDiagnostics: false } } : {}),
      ...(mode === 'utf8' ? { positionEncoding: 'utf-8' } : {}),
    },
  }
})
connection.onNotification('initialized', () => record('initialized'))
connection.onNotification('workspace/didChangeConfiguration', (params) => record('configuration', { params }))
const diagnostic = (text) => text.includes('broken') ? [{
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
  severity: 1, code: 1234, source: 'fixture', message: 'Synthetic broken declaration',
  relatedInformation: [{ location: { uri: 'file:///outside/secret.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }, message: 'Do not forward unchecked related locations' }],
  data: { secret: 'Do not forward opaque diagnostic data' },
}] : []
const metadataDiagnostics = (text) => text.includes('broken') ? [
  { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, message: 'Minimal diagnostic' },
  { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, message: 'Complete diagnostic', severity: 2, code: 'E_TEST', source: 'fixture', tags: [1, 2] },
] : []
const publish = async (uri, doc) => {
  if (mode === 'no-diagnostics' || mode === 'pull' || mode === 'named-pull') return
  if (mode === 'delayed-unversioned' && doc.version > 1) {
    await connection.sendNotification('textDocument/publishDiagnostics', { uri, diagnostics: [] })
    return
  }
  if (mode === 'encoded-uri') {
    uri = uri.replace(/main\.ts$/u, 'm%61in.ts').replace(/^file:\/\/\/([a-z]):/iu, (_, drive) => `file:///${drive.toLowerCase()}%3A`)
  }
  if (mode === 'stale' && doc.version > 1) {
    await connection.sendNotification('textDocument/publishDiagnostics', { uri, version: doc.version - 1, diagnostics: diagnostic('broken') })
    return
  }
  await connection.sendNotification('textDocument/publishDiagnostics', { uri, version: doc.version, diagnostics: mode === 'optional-diagnostics' ? metadataDiagnostics(doc.text) : diagnostic(doc.text) })
}
connection.onNotification('textDocument/didOpen', async ({ textDocument }) => {
  record('open', { uri: textDocument.uri, version: textDocument.version })
  documents.set(textDocument.uri, textDocument)
  await publish(textDocument.uri, textDocument)
})
connection.onNotification('textDocument/didChange', async ({ textDocument, contentChanges }) => {
  record('change', { uri: textDocument.uri, version: textDocument.version, contentChanges })
  const doc = { ...documents.get(textDocument.uri), version: textDocument.version, text: contentChanges[0].text }
  documents.set(textDocument.uri, doc)
  await publish(textDocument.uri, doc)
})
connection.onNotification('textDocument/didSave', (params) => record('save', { params }))
connection.onNotification('textDocument/didClose', ({ textDocument }) => { documents.delete(textDocument.uri); record('close', { uri: textDocument.uri }) })
connection.onRequest('textDocument/diagnostic', ({ textDocument, identifier }) => {
  if (mode === 'named-pull' && identifier !== 'fixture-named') return new ResponseError(ErrorCodes.InvalidParams, 'Missing named diagnostic provider')
  return { kind: 'full', items: diagnostic(documents.get(textDocument.uri).text) }
})
connection.onRequest('fixture/crash', () => process.exit(19))
connection.onRequest('textDocument/definition', ({ textDocument }) => [
  { uri: mode === 'external-target' ? 'file:///outside/secret.ts' : mode === 'denied-target' ? new URL('secret.ts', root + '/').href : textDocument.uri, range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } } },
])
connection.onRequest('textDocument/references', ({ textDocument, context }) => [{ uri: textDocument.uri, range: { start: { line: 0, character: context.includeDeclaration ? 13 : 20 }, end: { line: 0, character: 26 } } }])
connection.onRequest('textDocument/documentSymbol', () => [{ name: 'answer', kind: 14, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 24 } }, selectionRange: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } } }])
connection.onRequest('textDocument/hover', async (_params, token) => {
  record('hover')
  if (mode === 'exit-hover') process.exit(19)
  if (mode === 'cancel-hover') {
    return new Promise((resolve) => token.onCancellationRequested(() => {
      record('cancel')
      resolve(new ResponseError(-32800, 'Request cancelled'))
    }))
  }
  if (mode === 'hang-hover' || mode === 'hang-shutdown') {
    token.onCancellationRequested(() => record('cancel'))
    return new Promise(() => {})
  }
  if (mode === 'error-hover') return new ResponseError(ErrorCodes.InvalidParams, 'Synthetic rejection')
  if (mode === 'apply-edit') {
    const reply = await connection.sendRequest('workspace/applyEdit', { edit: { changes: { [new URL('main.ts', root + '/').href]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'BAD' }] } } })
    record('edit-reply', { reply })
  }
  if (mode.startsWith('worker') && !worker) {
    worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' && mode !== 'worker' })
    record('worker', { pid: worker.pid })
  }
  return { contents: { kind: 'plaintext', value: `(const) answer: 42 in ${fileURLToPath(root)}` } }
})
connection.onRequest('shutdown', () => {
  record('shutdown')
  if (mode === 'worker' || mode === 'hang-shutdown') return new Promise(() => {})
  return null
})
connection.onNotification('exit', () => { record('exit'); process.exit(0) })
connection.listen()
