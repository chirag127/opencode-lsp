import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { cleanup, configured, events, gone, harness, project } from './helpers.mjs'
import { LspManager } from '../dist/manager.js'
import { parseOptions } from '../dist/config.js'
import { LanguageServer } from '../dist/server.js'
import { Schema } from 'effect'

const pending = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

for (const waitAt of ['read', 'shell']) {
  test(`a session move during ${waitAt} permission prevents old-location reads and startup`, async (t) => {
    const directory = await project(t)
    const elsewhere = await project(t)
    const host = await harness(t, directory, configured(directory), async ({ action }) => {
      if (action === waitAt) host.move(elsewhere)
    })
    await assert.rejects(host.call('diagnostics', { file: 'main.ts' }), (error) => error.code === 'LOCATION')
    assert.deepEqual(await events(directory), [])
  })
}

test('refresh retains alias permissions after initial document synchronization', async (t) => {
  const directory = await project(t, { 'private/main.ts': 'export const answer = 42\n' })
  await symlink(path.join(directory, 'private'), path.join(directory, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  let allow = true
  const refusal = new Error('alias permission revoked')
  const host = await harness(t, directory, configured(directory), async ({ action, resources }) => {
    if (!allow && action === 'read' && resources.includes('alias/main.ts')) throw refusal
  })
  await host.call('diagnostics', { file: 'alias/main.ts' })
  const pid = (await host.call('status'))[0].pid
  allow = false
  await writeFile(path.join(directory, 'private/main.ts'), 'broken\n')
  await assert.rejects(host.edited(), (error) => error === refusal)
  assert.ok(gone(pid))
  assert.equal((await events(directory)).filter((event) => event.event === 'change').length, 0)
})

test('refresh refuses a retargeted alias instead of following the old canonical document', async (t) => {
  const directory = await project(t, { 'one/main.ts': 'export const answer = 1\n', 'two/main.ts': 'broken\n' })
  const alias = path.join(directory, 'alias')
  await symlink(path.join(directory, 'one'), alias, process.platform === 'win32' ? 'junction' : 'dir')
  const host = await harness(t, directory, configured(directory))
  await host.call('diagnostics', { file: 'alias/main.ts' })
  const pid = (await host.call('status'))[0].pid
  await rm(alias, { recursive: true })
  await symlink(path.join(directory, 'two'), alias, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(host.call('refresh'), (error) => error.code === 'PATH_CHANGED')
  assert.ok(gone(pid))
})

test('cancelled queued refresh settles promptly and cannot later authorize work', async (t) => {
  const directory = await project(t)
  let block = false
  const entered = pending()
  const grant = pending()
  const host = await harness(t, directory, configured(directory), async ({ action }) => {
    if (block && action === 'read') { entered.resolve(); await grant.promise }
  })
  await host.call('diagnostics', { file: 'main.ts' })
  block = true
  const active = host.call('hover', { file: 'main.ts', line: 0, character: 14 })
  await entered.promise
  const controller = new AbortController()
  let settled = false
  const refreshing = host.call('refresh', {}, host.caller({ signal: controller.signal }))
  const rejected = assert.rejects(refreshing, (error) => error.name === 'AbortError').then(() => { settled = true })
  controller.abort()
  await new Promise((resolve) => setImmediate(resolve))
  try {
    assert.equal(settled, true, 'cancellation must settle without releasing the earlier query')
  } finally {
    block = false
    grant.resolve()
    await active
    await rejected
  }
  const reads = host.permissions.filter((request) => request.action === 'read')
  assert.equal(reads.length, 2, 'cancelled refresh must not perform a later read assertion')
  assert.equal((await host.call('status'))[0].state, 'running')
})

test('concurrent failed-instance replacement retains exactly one owned process', async (t) => {
  const directory = await project(t)
  const options = parseOptions(configured(directory))
  const host = { location: { directory }, session: { get: async () => ({ location: { directory } }) }, permission: { assert: async () => {} } }
  const manager = new LspManager(host, options)
  cleanup(t, () => manager.dispose())
  const caller = { sessionID: 'ses_test', agent: 'build', messageID: 'msg_test', id: 'call_test', signal: new AbortController().signal }
  await manager.query('diagnostics', { file: 'main.ts' }, caller)
  const instance = [...manager.instances.values()][0]
  await instance.server.stop()
  const gate = pending()
  const entered = pending()
  const selected = pending()
  const select = manager.select.bind(manager)
  let selections = 0
  manager.select = async (...args) => {
    const result = await select(...args)
    if (++selections === 2) selected.resolve()
    await selected.promise
    return result
  }
  const stop = instance.server.stop.bind(instance.server)
  instance.server.stop = async (...args) => { entered.resolve(); await gate.promise; return stop(...args) }
  const queries = Promise.all([
    manager.query('hover', { file: 'main.ts', line: 0, character: 14 }, caller),
    manager.query('symbols', { file: 'main.ts' }, caller),
  ])
  await entered.promise
  await new Promise((resolve) => setImmediate(resolve))
  gate.resolve()
  try {
    await queries
    assert.equal((await events(directory)).filter((event) => event.event === 'spawn').length, 2, 'one original process plus one replacement')
  } finally {
    manager.select = select
    instance.server.stop = stop
    await manager.dispose()
    // A failing pre-fix replacement can leave an untracked fixture; only kill PIDs from this synthetic journal.
    for (const event of await events(directory)) if (event.event === 'spawn' && !gone(event.pid)) process.kill(event.pid)
  }
})

test('session cleanup attempts every instance and retains failed cleanup ownership for retry', async (t) => {
  const directory = await project(t)
  const options = parseOptions(configured(directory))
  const host = { location: { directory }, session: { get: async () => ({ location: { directory } }) }, permission: { assert: async () => {} } }
  const manager = new LspManager(host, options)
  cleanup(t, () => manager.dispose())
  const caller = { sessionID: 'ses_test', agent: 'build', messageID: 'msg_test', id: 'call_test', signal: new AbortController().signal }
  await manager.query('diagnostics', { file: 'main.ts' }, caller)
  await manager.query('diagnostics', { file: 'main.ts' }, { ...caller, agent: 'plan' })
  const [first, second] = [...manager.instances.values()]
  const original = first.server.stop.bind(first.server)
  first.server.stop = async () => { throw new Error('synthetic cleanup failure') }
  try {
    await assert.rejects(manager.removeSession('ses_test'), /cleanup/i)
    assert.ok(gone(second.server.pid), 'failure for one process must not prevent stopping the others')
    assert.equal([...manager.instances.values()].includes(first), true)
  } finally {
    first.server.stop = original
    await manager.removeSession('ses_test')
  }
  assert.ok(gone(first.server.pid))
})

test('session-deleted processing continues after one cleanup error', async (t) => {
  const directory = await project(t)
  const host = await harness(t, directory, configured(directory))
  await host.call('diagnostics', { file: 'main.ts' })
  await host.call('diagnostics', { file: 'main.ts' }, host.caller({ sessionID: 'ses_test_second' }))
  const firstPid = (await host.call('status'))[0].pid
  const secondPid = (await host.call('status', {}, host.caller({ sessionID: 'ses_test_second' })))[0].pid
  const original = LanguageServer.prototype.stop
  const received = pending()
  let attempted = 0
  LanguageServer.prototype.stop = async function (...args) {
    if (this.pid === firstPid && attempted++ === 0) { received.resolve(); throw new Error('synthetic cleanup failure') }
    return original.apply(this, args)
  }
  try {
    host.event({ type: 'session.deleted', data: { sessionID: 'ses_test' } })
    await received.promise
    const handled = pending()
    LanguageServer.prototype.stop = async function (...args) {
      const result = await original.apply(this, args)
      if (this.pid === secondPid) handled.resolve()
      return result
    }
    host.event({ type: 'session.deleted', data: { sessionID: 'ses_test_second' } })
    await Promise.race([handled.promise, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('second deletion event was not handled')), 3000)
      handled.promise.finally(() => clearTimeout(timer))
    })])
    assert.ok(gone(secondPid))
  } finally {
    LanguageServer.prototype.stop = original
    await host.close().catch((error) => {
      assert.match(String(error), /cleanup/i)
    })
  }
  assert.ok(gone(firstPid))
})

test('post-edit diagnostic metadata contains only JSON values, including omitted optional fields', async (t) => {
  const directory = await project(t)
  const host = await harness(t, directory, configured(directory))
  await host.call('diagnostics', { file: 'main.ts' })
  await writeFile(path.join(directory, 'main.ts'), 'broken\n')
  const result = await host.edited()
  assert.equal(Schema.is(Schema.Json)(result.metadata), true)
  assert.deepEqual(result.metadata, JSON.parse(JSON.stringify(result.metadata)), 'metadata must survive the JSON schema without undefined own fields')
})

test('diagnostic metadata omits all absent optional fields and preserves populated fields', async (t) => {
  const directory = await project(t)
  const host = await harness(t, directory, configured(directory, 'optional-diagnostics'))
  await host.call('diagnostics', { file: 'main.ts' })
  await writeFile(path.join(directory, 'main.ts'), 'broken\n')
  const result = await host.edited('write')
  assert.equal(Schema.is(Schema.Json)(result.metadata), true, 'actual Effect JSON schema must accept raw hook metadata')
  assert.deepEqual(result.metadata, JSON.parse(JSON.stringify(result.metadata)))
  const items = result.metadata.lspDiagnostics[0].diagnostics.items
  assert.deepEqual(items, [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, message: 'Minimal diagnostic' },
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, message: 'Complete diagnostic', severity: 2, code: 'E_TEST', source: 'fixture', tags: [1, 2] },
  ])
})
