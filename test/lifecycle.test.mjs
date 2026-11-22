import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseOptions } from '../dist/config.js'
import { LanguageServer } from '../dist/server.js'
import { cleanup, configured, events, gone, harness, project } from './helpers.mjs'

for (const mode of ['normal', 'full', 'pull', 'named-pull', 'encoded-uri', 'numeric-1', 'numeric-2']) {
  test(`${mode}: saved-file edits synchronize versions and replace diagnostics`, async (t) => {
    const directory = await project(t)
    const host = await harness(t, directory, configured(directory, mode))
    const initial = await host.call('diagnostics', { file: 'main.ts' })
    assert.equal(initial.diagnostics.state, 'reported')
    assert.deepEqual(initial.diagnostics.items, [])
    await writeFile(path.join(directory, 'main.ts'), 'broken\n')
    const refreshed = await host.edited()
    assert.equal(refreshed.metadata.existing, true)
    const diagnostic = refreshed.metadata.lspDiagnostics[0].diagnostics
    assert.equal(diagnostic.documentVersion, 2)
    assert.equal(diagnostic.items[0].code, 1234)
    assert.equal(diagnostic.items[0].data, undefined)
    assert.equal(diagnostic.items[0].relatedInformation, undefined)
    assert.match(refreshed.content[0].text, /Saved synthetic file/u)
    await writeFile(path.join(directory, 'main.ts'), 'export const answer = 7\n')
    const fixed = await host.call('diagnostics', { file: 'main.ts' })
    assert.equal(fixed.documentVersion, 3)
    assert.deepEqual(fixed.diagnostics.items, [])
    const pid = (await host.call('status'))[0].pid
    await host.call('shutdown')
    assert.ok(gone(pid))
    const log = await events(directory)
    assert.equal(log.filter((event) => event.event === 'initialize').length, 1)
    assert.equal(log.filter((event) => event.event === 'open').length, 1)
    assert.deepEqual(log.filter((event) => event.event === 'change').map((event) => event.version), [2, 3])
    assert.ok(log.some((event) => event.event === 'close'))
    assert.ok(log.some((event) => event.event === 'shutdown'))
    assert.ok(log.some((event) => event.event === 'exit'))
    const change = log.find((event) => event.event === 'change')
    if (mode === 'full' || mode === 'numeric-1') assert.equal(change.contentChanges[0].range, undefined)
    else assert.deepEqual(change.contentChanges[0].range, { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } })
  })
}

test('a stale diagnostic version cannot be returned for an edited document', async (t) => {
  const directory = await project(t, { 'main.ts': 'broken\n' })
  const host = await harness(t, directory, configured(directory, 'stale', { diagnosticsTimeoutMs: 150 }))
  assert.equal((await host.call('diagnostics', { file: 'main.ts' })).diagnostics.items[0].code, 1234)
  await writeFile(path.join(directory, 'main.ts'), 'export const answer = 42\n')
  const result = await host.call('diagnostics', { file: 'main.ts' })
  assert.equal(result.diagnostics.state, 'pending')
  assert.equal(result.documentVersion, 2)
  assert.equal(result.diagnostics.documentVersion, null)
  assert.equal(result.diagnostics.freshness, 'unknown')
  assert.deepEqual(result.diagnostics.items, [])
})

test('a silent diagnostics publisher is pending rather than falsely clean', async (t) => {
  const directory = await project(t)
  const host = await harness(t, directory, configured(directory, 'no-diagnostics', { diagnosticsTimeoutMs: 100 }))
  const result = await host.call('diagnostics', { file: 'main.ts' })
  assert.equal(result.diagnostics.state, 'pending')
  assert.equal(result.diagnostics.version, null)
})

test('unversioned clean publications cannot attest to the edited revision', async (t) => {
  const directory = await project(t)
  const host = await harness(t, directory, configured(directory, 'delayed-unversioned'))
  await host.call('diagnostics', { file: 'main.ts' })
  await writeFile(path.join(directory, 'main.ts'), 'broken\n')
  const result = await host.call('diagnostics', { file: 'main.ts' })
  assert.equal(result.documentVersion, 2)
  assert.equal(result.diagnostics.state, 'reported')
  assert.equal(result.diagnostics.freshness, 'unknown')
  assert.equal(result.diagnostics.version, null)
  assert.equal(result.diagnostics.documentVersion, null)
})

test('numeric synchronization None rejects opening rather than sending didOpen', async (t) => {
  const directory = await project(t)
  const host = await harness(t, directory, configured(directory, 'numeric-0'))
  await assert.rejects(host.call('diagnostics', { file: 'main.ts' }), (error) => error.code === 'UNSUPPORTED_SYNC')
  assert.equal((await events(directory)).some((event) => event.event === 'open'), false)
})

for (const mode of ['worker-graceful', 'worker-crash']) {
  test(`${mode}: descendants are owned after the direct parent exits`, async (t) => {
    const directory = await project(t)
    const options = parseOptions(configured(directory, mode))
    const server = new LanguageServer(options.servers[0], directory, options)
    cleanup(t, () => server.stop(false))
    await server.start(new AbortController().signal)
    await server.request('textDocument/hover', {}, new AbortController().signal)
    const worker = (await events(directory)).find((event) => event.event === 'worker').pid
    cleanup(t, () => { if (!gone(worker)) process.kill(worker) })
    if (mode === 'worker-crash') await assert.rejects(server.request('fixture/crash', {}, new AbortController().signal))
    await server.stop(mode === 'worker-graceful')
    assert.ok(gone(worker), 'descendant must exit even if its parent has already exited')
    assert.ok(gone(server.pid))
  })
}

for (const mode of ['exit-initialize', 'invalid-initialize', 'utf8']) {
  test(`${mode}: initialization fails without a live process`, async (t) => {
    const directory = await project(t)
    const host = await harness(t, directory, configured(directory, mode))
    await assert.rejects(host.call('diagnostics', { file: 'main.ts' }))
    const log = await events(directory)
    assert.ok(gone(log.find((event) => event.event === 'spawn').pid))
    assert.equal((await host.call('status'))[0].state, 'failed')
  })
}

test('a missing configured executable rejects initialization without an unhandled spawn error', async (t) => {
  const directory = await project(t)
  const options = configured(directory)
  options.servers[0].command = [path.join(directory, 'not-a-real-language-server')]
  const host = await harness(t, directory, options)
  await assert.rejects(host.call('diagnostics', { file: 'main.ts' }), /Cannot start configured server/u)
  assert.equal((await host.call('status'))[0].state, 'failed')
})

test('a server exit rejects an in-flight request instead of waiting for its timeout', async (t) => {
  const directory = await project(t)
  const host = await harness(t, directory, configured(directory, 'exit-hover', { requestTimeoutMs: 10000 }))
  await host.call('diagnostics', { file: 'main.ts' })
  const pid = (await host.call('status'))[0].pid
  const start = performance.now()
  await assert.rejects(host.call('hover', { file: 'main.ts', line: 0, character: 14 }), /exited|closed|disposed|Pending response/u)
  assert.ok(performance.now() - start < 5000)
  await host.close()
  assert.ok(gone(pid))
})

test('an RPC error is reported without corrupting the connection', async (t) => {
  const directory = await project(t)
  const host = await harness(t, directory, configured(directory, 'error-hover'))
  await assert.rejects(host.call('hover', { file: 'main.ts', line: 0, character: 14 }), /Synthetic rejection/u)
  const result = await host.call('symbols', { file: 'main.ts' })
  assert.equal(result.symbols[0].name, 'answer')
})

test('unsupported navigation capability is explicit and sends no request', async (t) => {
  const directory = await project(t)
  const host = await harness(t, directory, configured(directory, 'no-hover'))
  await assert.rejects(host.call('hover', { file: 'main.ts', line: 0, character: 14 }), (error) => error.code === 'UNSUPPORTED')
  assert.equal((await events(directory)).some((event) => event.event === 'hover'), false)
})

test('initialization timeout kills an unresponsive server', async (t) => {
  const directory = await project(t)
  const host = await harness(t, directory, configured(directory, 'hang-initialize', { requestTimeoutMs: 300 }))
  await assert.rejects(host.call('diagnostics', { file: 'main.ts' }), (error) => error.code === 'TIMEOUT')
  const log = await events(directory)
  assert.ok(gone(log.find((event) => event.event === 'spawn').pid))
})

test('request cancellation reaches JSON-RPC and releases its process', async (t) => {
  const directory = await project(t)
  const options = parseOptions(configured(directory, 'hang-hover'))
  const server = new LanguageServer(options.servers[0], directory, options)
  cleanup(t, () => server.stop(false))
  await server.start(new AbortController().signal)
  const signal = AbortSignal.timeout(200)
  await assert.rejects(server.request('textDocument/hover', {}, signal), (error) => error.name === 'TimeoutError')
  assert.ok(gone(server.pid))
  assert.ok((await events(directory)).some((event) => event.event === 'cancel'))
})

test('an RPC timeout also clears the outstanding process and pending request', async (t) => {
  const directory = await project(t)
  const options = parseOptions(configured(directory, 'hang-hover', { requestTimeoutMs: 500 }))
  const server = new LanguageServer(options.servers[0], directory, options)
  cleanup(t, () => server.stop(false))
  await server.start(new AbortController().signal)
  await assert.rejects(server.request('textDocument/hover', {}, new AbortController().signal), (error) => error.code === 'TIMEOUT')
  assert.ok(gone(server.pid))
})

test('cooperative RPC cancellation reaches the server before transport disposal', async (t) => {
  const directory = await project(t)
  const options = parseOptions(configured(directory, 'cancel-hover'))
  const server = new LanguageServer(options.servers[0], directory, options)
  cleanup(t, () => server.stop(false))
  await server.start(new AbortController().signal)
  await assert.rejects(server.request('textDocument/hover', {}, AbortSignal.timeout(200)), (error) => error.name === 'TimeoutError')
  assert.ok((await events(directory)).some((event) => event.event === 'cancel'))
  assert.ok(gone(server.pid))
})

test('uncooperative shutdown terminates the owned server and its live child', async (t) => {
  const directory = await project(t)
  const host = await harness(t, directory, configured(directory, 'worker', { shutdownTimeoutMs: 150 }))
  await host.call('hover', { file: 'main.ts', line: 0, character: 14 })
  const pid = (await host.call('status'))[0].pid
  const worker = (await events(directory)).find((event) => event.event === 'worker').pid
  assert.equal(gone(worker), false)
  await host.close()
  assert.ok(gone(pid))
  assert.ok(gone(worker))
})

test('concurrent document requests share one initialized process with ordered versions', async (t) => {
  const directory = await project(t)
  const host = await harness(t, directory, configured(directory))
  const result = await Promise.all([
    host.call('diagnostics', { file: 'main.ts' }),
    host.call('symbols', { file: 'main.ts' }),
    host.call('hover', { file: 'main.ts', line: 0, character: 14 }),
  ])
  assert.ok(result.every((item) => item.documentVersion === 1))
  assert.equal((await events(directory)).filter((event) => event.event === 'spawn').length, 1)
  assert.equal((await events(directory)).filter((event) => event.event === 'open').length, 1)
})
