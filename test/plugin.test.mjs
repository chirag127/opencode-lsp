import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { configured, events, gone, harness, project } from './helpers.mjs'

test('loading and status do not execute configured commands', async (t) => {
  const directory = await project(t)
  const host = await harness(t, directory, configured(directory))
  assert.deepEqual([...host.tools.keys()].sort(), ['lsp_definition', 'lsp_diagnostics', 'lsp_hover', 'lsp_references', 'lsp_refresh', 'lsp_shutdown', 'lsp_status', 'lsp_symbols'])
  assert.equal((await host.call('status'))[0].state, 'idle')
  assert.equal((await host.call('status'))[0].pid, null)
  assert.deepEqual(await events(directory), [])
  assert.deepEqual(host.permissions, [])
  assert.deepEqual(await host.call('refresh'), [])
})

for (const denied of ['read', 'shell']) {
  test(`a ${denied} denial propagates unchanged before any document or process is used`, async (t) => {
    const directory = await project(t)
    const refusal = new Error(`policy refused ${denied}`)
    const host = await harness(t, directory, configured(directory), async (request) => {
      assert.equal(request.sessionID, 'ses_test')
      assert.equal(request.agent, 'build')
      assert.deepEqual(request.source, { type: 'tool', messageID: 'msg_test', id: 'call_test' })
      if (request.action === denied) throw refusal
    })
    await assert.rejects(host.call('diagnostics', { file: 'main.ts' }), (error) => error === refusal)
    assert.deepEqual(await events(directory), [])
    assert.equal((await host.call('status'))[0].pid, null)
  })
}

test('tool inputs cannot select a session or inject a command', async (t) => {
  const directory = await project(t)
  const host = await harness(t, directory, configured(directory))
  await assert.rejects(host.call('hover', { file: 'main.ts', line: 0, character: 14, sessionID: 'ses_other' }), /Unknown LSP tool argument/u)
  await assert.rejects(host.call('diagnostics', { file: 'main.ts', command: ['other'] }), /Unknown LSP tool argument/u)
  assert.deepEqual(await events(directory), [])
})

test('resolved files and configured roots cannot leave the active location', async (t) => {
  const directory = await project(t)
  const outside = await project(t, { 'secret.ts': 'export const secret = 7\n' })
  await symlink(outside, path.join(directory, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
  const host = await harness(t, directory, configured(directory))
  for (const file of [path.join(outside, 'secret.ts'), '../other/main.ts', 'outside/secret.ts']) {
    await assert.rejects(host.call('diagnostics', { file }), (error) => error.code === 'OUTSIDE_ROOT')
  }
  assert.equal(host.permissions.length, 0)
  assert.deepEqual(await events(directory), [])
  const options = configured(directory)
  options.servers[0].root = outside
  const badRoot = await harness(t, directory, options)
  await assert.rejects(badRoot.call('diagnostics', { file: 'main.ts' }), (error) => error.code === 'OUTSIDE_ROOT')
})

test('permissions see both an in-root alias and its canonical file', async (t) => {
  const directory = await project(t, { 'private/main.ts': 'export const answer = 42\n' })
  await symlink(path.join(directory, 'private'), path.join(directory, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  const refusal = new Error('private source denied')
  const host = await harness(t, directory, configured(directory), async (request) => {
    if (request.action === 'read' && request.resources.includes('private/main.ts')) throw refusal
  })
  await assert.rejects(host.call('diagnostics', { file: 'alias/main.ts' }), (error) => error === refusal)
  assert.deepEqual(host.permissions[0].resources.sort(), ['alias/main.ts', 'private/main.ts'])
  assert.deepEqual(await events(directory), [])
})

test('permission revocation blocks post-edit refresh and clears the existing process', async (t) => {
  const directory = await project(t)
  let allow = true
  const refusal = new Error('read permission revoked')
  const host = await harness(t, directory, configured(directory), async ({ action }) => { if (!allow && action === 'read') throw refusal })
  await host.call('diagnostics', { file: 'main.ts' })
  const pid = (await host.call('status'))[0].pid
  allow = false
  await writeFile(path.join(directory, 'main.ts'), 'broken\n')
  await assert.rejects(host.edited(), (error) => error === refusal)
  assert.ok(gone(pid))
  assert.equal((await events(directory)).filter((item) => item.event === 'change').length, 0)
})

test('session and agent isolation cannot reuse another caller’s server or diagnostics', async (t) => {
  const directory = await project(t)
  const host = await harness(t, directory, configured(directory))
  await host.call('diagnostics', { file: 'main.ts' })
  const first = (await host.call('status'))[0].pid
  const otherAgent = host.caller({ agent: 'plan' })
  const otherSession = host.caller({ sessionID: 'ses_test_other' })
  assert.equal((await host.call('status', {}, otherAgent))[0].state, 'idle')
  assert.equal((await host.call('status', {}, otherSession))[0].state, 'idle')
  await host.call('diagnostics', { file: 'main.ts' }, otherAgent)
  const second = (await host.call('status', {}, otherAgent))[0].pid
  assert.notEqual(first, second)
  await host.call('shutdown', {}, otherAgent)
  assert.ok(gone(second))
  assert.equal(gone(first), false)
  await host.close()
  assert.ok(gone(first))
})

test('moving the session out of this plugin location stops its old process', async (t) => {
  const directory = await project(t)
  const elsewhere = await project(t)
  const host = await harness(t, directory, configured(directory))
  await host.call('diagnostics', { file: 'main.ts' })
  const pid = (await host.call('status'))[0].pid
  host.move(elsewhere)
  await assert.rejects(host.call('diagnostics', { file: 'main.ts' }), (error) => error.code === 'LOCATION')
  assert.ok(gone(pid))
})

test('navigation omits external locations and propagates denial for an internal target', async (t) => {
  const directory = await project(t, { 'main.ts': 'export const answer = 42\n', 'secret.ts': 'export const secret = 42\n' })
  const host = await harness(t, directory, configured(directory, 'external-target'))
  const result = await host.call('definition', { file: 'main.ts', line: 0, character: 14 })
  assert.deepEqual(result.locations, [])
  assert.equal(result.omitted, 1)
  const refusal = new Error('secret target denied')
  const denied = await harness(t, directory, configured(directory, 'denied-target'), async (request) => {
    if (request.action === 'read' && request.resources.includes('secret.ts')) throw refusal
  })
  await assert.rejects(denied.call('definition', { file: 'main.ts', line: 0, character: 14 }), (error) => error === refusal)
})

test('a server cannot apply workspace edits through the read-only client', async (t) => {
  const directory = await project(t)
  const host = await harness(t, directory, configured(directory, 'apply-edit'))
  await host.call('hover', { file: 'main.ts', line: 0, character: 14 })
  assert.equal(await readFile(path.join(directory, 'main.ts'), 'utf8'), 'export const answer = 42\n')
  const reply = (await events(directory)).find((event) => event.event === 'edit-reply')
  assert.equal(reply.reply.applied, false)
})

test('a pending permission cannot start a server after plugin unload', async (t) => {
  const directory = await project(t)
  let granted
  let entered
  const permissionEntered = new Promise((resolve) => { entered = resolve })
  const grant = new Promise((resolve) => { granted = resolve })
  const host = await harness(t, directory, configured(directory), async () => { entered(); await grant })
  const query = host.call('diagnostics', { file: 'main.ts' })
  const rejected = assert.rejects(query, /unloaded/u)
  await permissionEntered
  await host.close()
  granted()
  await rejected
  assert.deepEqual(await events(directory), [])
})

test('a server root inside a subdirectory rejects sibling files', async (t) => {
  const directory = await project(t, { 'a/main.ts': 'export const answer = 42\n', 'b/main.ts': 'export const answer = 1\n' })
  await mkdir(path.join(directory, 'a'), { recursive: true })
  const options = configured(directory)
  options.servers[0].root = 'a'
  const host = await harness(t, directory, options)
  await assert.rejects(host.call('diagnostics', { file: 'b/main.ts' }), (error) => error.code === 'OUTSIDE_ROOT')
  assert.equal((await host.call('diagnostics', { file: 'a/main.ts' })).file, 'a/main.ts')
})
