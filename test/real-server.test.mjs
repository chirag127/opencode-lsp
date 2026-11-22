import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gone, harness, project, repository } from './helpers.mjs'

test('real TypeScript server initializes, navigates symbols, diagnoses saved edits and shuts down', { timeout: 90000 }, async (t) => {
  const original = "import { doubled } from './math.js'\nexport const result: number = doubled(21)\n"
  const directory = await project(t, {
    'package.json': JSON.stringify({ private: true, type: 'module' }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true, types: [], lib: ['ES2022'] }, include: ['*.ts'] }),
    'math.ts': 'export function doubled(value: number): number {\n  return value * 2\n}\n',
    'main.ts': original,
  })
  const host = await harness(t, directory, {
    servers: [{
      id: 'typescript', root: '.', extensions: { '.ts': 'typescript' },
      command: [process.execPath, path.join(repository, 'node_modules/typescript-language-server/lib/cli.mjs'), '--stdio'],
      initializationOptions: { tsserver: { path: path.join(repository, 'node_modules/typescript/lib/tsserver.js') }, disableAutomaticTypingAcquisition: true },
    }],
    requestTimeoutMs: 20000, diagnosticsTimeoutMs: 20000, shutdownTimeoutMs: 2000,
  })
  assert.equal((await host.call('status'))[0].state, 'idle')
  const initial = await host.call('diagnostics', { file: 'main.ts' })
  assert.equal(initial.diagnostics.state, 'reported', JSON.stringify(initial))
  assert.deepEqual(initial.diagnostics.items, [])
  const running = (await host.call('status'))[0]
  assert.equal(running.state, 'running')
  assert.ok(running.pid > 0)
  assert.equal(running.capabilities.definition, true)

  const definition = await host.call('definition', { file: 'main.ts', line: 1, character: 33 })
  assert.ok(definition.locations.some((location) => location.file === 'math.ts' && location.range.start.line === 0 && location.range.start.character === 16), JSON.stringify(definition))
  const references = await host.call('references', { file: 'main.ts', line: 1, character: 33, includeDeclaration: true })
  assert.ok(references.locations.some((location) => location.file === 'main.ts' && location.range.start.line === 1), JSON.stringify(references))
  assert.ok(references.locations.some((location) => location.file === 'math.ts'), JSON.stringify(references))
  const hover = await host.call('hover', { file: 'main.ts', line: 1, character: 33 })
  assert.match(JSON.stringify(hover.hover), /doubled/u)
  assert.match(JSON.stringify(hover.hover), /number/u)
  const symbols = await host.call('symbols', { file: 'math.ts' })
  assert.ok(symbols.symbols.some((symbol) => symbol.name === 'doubled'), JSON.stringify(symbols))

  await writeFile(path.join(directory, 'main.ts'), original.replace('result: number', 'result: string'))
  const edited = await host.edited('patch')
  const after = edited.metadata.lspDiagnostics.find((result) => result.file === 'main.ts')
  assert.ok(after, JSON.stringify(edited))
  assert.equal(after.documentVersion, 2)
  assert.equal(after.diagnostics.documentVersion, null)
  assert.equal(after.diagnostics.freshness, 'unknown')
  assert.ok(after.diagnostics.items.some((diagnostic) => Number(diagnostic.code) === 2322), JSON.stringify(after))
  assert.ok(host.permissions.filter((request) => request.action === 'read' && request.resources.includes('main.ts')).length >= 5)

  await writeFile(path.join(directory, 'main.ts'), original)
  const fixed = await host.call('diagnostics', { file: 'main.ts' })
  assert.equal(fixed.documentVersion, 3)
  assert.equal(fixed.diagnostics.state, 'reported')
  assert.deepEqual(fixed.diagnostics.items, [])
  assert.equal(fixed.diagnostics.freshness, 'unknown')
  await host.call('shutdown', { server: 'typescript' })
  assert.ok(gone(running.pid))
  assert.equal((await host.call('status'))[0].state, 'idle')
  t.diagnostic(JSON.stringify({ server: 'typescript-language-server 6.1.0', compiler: 'TypeScript 6.0.3', definition: definition.locations, errorCode: 2322, fixedDiagnostics: fixed.diagnostics.items.length, serverProcessGone: gone(running.pid) }))
})
